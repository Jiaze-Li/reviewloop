// Zero-LLM background Watcher for PR Task (`taskType: 'pr'`).
//
// Polls GitHub via `gh` CLI with backoff (15s -> 30s -> 60s) while the loop
// is in WAITING_FOR_REVIEW. Never loads or calls any LLM/model provider.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Persistence } from '../orchestrator/persistence.js';
import { REVIEWLOOP_RUNTIME_ROOT } from './runtimeDir.js';
import { acquireLoopFileLease } from './loopLease.js';
import { REVIEW_LOOP_STATES, ReviewLoopStore, recordTransition } from './state.js';
import { evaluatePrStatus, fetchPrSnapshotViaGh } from './prTaskEngine.js';
import { executeWake } from './prWakeAdapter.js';

export const DEFAULT_BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000]);
export const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_LEASE_RETRY_MS = Object.freeze([100, 150, 200, 250, 300, 350, 400, 500]);

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pollPrOnce({
  loopId,
  store,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  wakeFn = executeWake,
  withLeaseFn = async (fn) => fn(),
  nowFn = () => new Date().toISOString(),
}) {
  const initialTarget = await withLeaseFn(async () => {
    const loopState = await store.load(loopId);
    const prTask = await store.loadPrTask(loopId);
    if (!loopState || !prTask) {
      return { done: true, reason: 'LOOP_OR_PR_TASK_MISSING' };
    }
    if (loopState.state !== REVIEW_LOOP_STATES.WAITING_FOR_REVIEW) {
      return { done: true, status: loopState.state, reason: 'NOT_WAITING' };
    }
    return {
      done: false,
      repoFullName: prTask.repoFullName,
      prNumber: prTask.prNumber,
    };
  });

  if (initialTarget.done) {
    return initialTarget;
  }

  // Network fetch runs outside the lease so concurrent `pr stop` is never blocked
  // and we re-read state under the lease before committing any transition.
  const snapshot = await fetchPrSnapshotFn({
    repoFullName: initialTarget.repoFullName,
    prNumber: initialTarget.prNumber,
  });

  return withLeaseFn(async () => {
    const freshLoopState = await store.load(loopId);
    const freshPrTask = await store.loadPrTask(loopId);

    if (!freshLoopState || !freshPrTask) {
      return { done: true, reason: 'LOOP_OR_PR_TASK_MISSING' };
    }
    if (freshLoopState.state !== REVIEW_LOOP_STATES.WAITING_FOR_REVIEW) {
      return { done: true, status: freshLoopState.state, reason: 'STATE_CHANGED_DURING_POLL' };
    }

    const evaluated = evaluatePrStatus({
      prState: snapshot.prState,
      prTask: freshPrTask,
      comments: snapshot.comments,
    });

    const nowIso = nowFn();
    freshPrTask.latestBotSession = evaluated.session;
    freshPrTask.watcher = {
      ...(freshPrTask.watcher ?? {}),
      lastPollAt: nowIso,
    };
    freshPrTask.updatedAt = nowIso;

    if (evaluated.verdict === 'WAITING_FOR_REVIEW') {
      await store.savePrTask(loopId, freshPrTask);
      return { done: false, status: REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, reason: evaluated.reason };
    }

    const targetState = evaluated.verdict === 'PASS'
      ? REVIEW_LOOP_STATES.PASS
      : evaluated.verdict === 'REWORK'
        ? REVIEW_LOOP_STATES.REWORK
        : evaluated.verdict === 'STOPPED'
          ? REVIEW_LOOP_STATES.STOPPED
          : REVIEW_LOOP_STATES.HUMAN_REQUIRED;

    recordTransition(freshLoopState, REVIEW_LOOP_STATES.REVIEWING, 'prWatcher received bot update');
    recordTransition(freshLoopState, targetState, evaluated.reason);
    if (targetState === REVIEW_LOOP_STATES.STOPPED || targetState === REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
      freshPrTask.stopReason = evaluated.reason;
    }
    freshPrTask.watcher.pid = null;
    freshPrTask.watcher.stoppedAt = nowIso;

    let wakeResult = null;
    if (targetState !== REVIEW_LOOP_STATES.STOPPED && typeof wakeFn === 'function') {
      wakeResult = await wakeFn({ loopId, prTask: freshPrTask });
      freshPrTask.watcher.wakeStatus = wakeResult.wakeStatus;
      freshPrTask.watcher.wakeReason = wakeResult.reason ?? null;
      freshPrTask.watcher.manualResumeCommand = wakeResult.manualResumeCommand ?? `reviewloop pr resume --loop ${loopId}`;
    }

    await store.save(loopId, freshLoopState);
    await store.savePrTask(loopId, freshPrTask);

    return {
      done: true,
      status: targetState,
      reason: evaluated.reason,
      wakeResult,
    };
  });
}

async function acquireLeaseWithRetry({
  runtimeRoot,
  loopId,
  reason,
  retryDelaysMs = DEFAULT_LEASE_RETRY_MS,
  sleepFn,
}) {
  let lease = await acquireLoopFileLease({ runtimeRoot, loopId, reason });
  for (const delay of retryDelaysMs) {
    if (lease.ok) return lease;
    await sleepFn(delay);
    lease = await acquireLoopFileLease({ runtimeRoot, loopId, reason });
  }
  return lease;
}

export async function runPrWatcher({
  loopId,
  runtimeRoot = REVIEWLOOP_RUNTIME_ROOT,
  persistence: injectedPersistence = null,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  leaseRetryDelaysMs = DEFAULT_LEASE_RETRY_MS,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  wakeFn = executeWake,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
  pid = process.pid,
} = {}) {
  const persistence = injectedPersistence ?? new Persistence(runtimeRoot);
  const store = new ReviewLoopStore(persistence);
  const withLeaseFn = async (fn) => {
    if (injectedPersistence) return fn();
    const l = await acquireLeaseWithRetry({
      runtimeRoot,
      loopId,
      reason: 'pr-watcher-step',
      retryDelaysMs: leaseRetryDelaysMs,
      sleepFn,
    });
    if (!l.ok) throw new Error('LEASE_HELD');
    try {
      return await fn();
    } finally {
      await l.release();
    }
  };

  const lease = injectedPersistence
    ? { ok: true, release: async () => {} }
    : await acquireLeaseWithRetry({
      runtimeRoot,
      loopId,
      reason: 'pr-watcher',
      retryDelaysMs: leaseRetryDelaysMs,
      sleepFn,
    });

  if (!lease.ok) {
    return { exited: true, reason: 'LEASE_HELD' };
  }

  try {
    const initialPrTask = await store.loadPrTask(loopId);
    if (!initialPrTask) return { exited: true, reason: 'PR_TASK_MISSING' };
    if (initialPrTask.watcher?.pid && initialPrTask.watcher.pid !== pid && isPidAlive(initialPrTask.watcher.pid)) {
      return { exited: true, reason: 'WATCHER_ALREADY_ACTIVE', pid: initialPrTask.watcher.pid };
    }
    initialPrTask.watcher = {
      ...(initialPrTask.watcher ?? {}),
      pid,
      startedAt: new Date(clock()).toISOString(),
      stoppedAt: null,
    };
    await store.savePrTask(loopId, initialPrTask);
  } finally {
    await lease.release();
  }

  const startedAt = clock();
  let attempt = 0;

  while (true) {
    let outcome;
    try {
      outcome = await pollPrOnce({
        loopId,
        store,
        fetchPrSnapshotFn,
        wakeFn,
        withLeaseFn,
        nowFn: () => new Date(clock()).toISOString(),
      });
    } catch (err) {
      if (String(err?.message) !== 'LEASE_HELD') {
        try {
          await withLeaseFn(async () => {
            const prTask = await store.loadPrTask(loopId);
            if (prTask) {
              prTask.watcher = {
                ...(prTask.watcher ?? {}),
                consecutiveErrors: (prTask.watcher?.consecutiveErrors ?? 0) + 1,
                lastError: String(err?.message ?? err),
                lastErrorAt: new Date(clock()).toISOString(),
              };
              await store.savePrTask(loopId, prTask);
            }
          });
        } catch { /* best effort error recording */ }
      }
    }
    if (outcome?.done) {
      return { exited: true, ...outcome };
    }

    const elapsed = clock() - startedAt;
    if (elapsed >= maxWaitMs) {
      try {
        await withLeaseFn(async () => {
          const prTask = await store.loadPrTask(loopId);
          if (prTask) {
            prTask.watcher = {
              ...(prTask.watcher ?? {}),
              pid: null,
              stoppedAt: new Date(clock()).toISOString(),
              wakeStatus: 'MANUAL_REQUIRED',
              wakeReason: 'WATCHER_MAX_WAIT_REACHED',
              manualResumeCommand: `reviewloop pr resume --loop ${loopId}`,
            };
            await store.savePrTask(loopId, prTask);
          }
        });
      } catch { /* best effort on timeout */ }
      return { exited: true, status: REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, reason: 'MAX_WAIT_REACHED' };
    }

    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 60_000;
    attempt += 1;
    await sleepFn(delay);
  }
}

export function spawnPrWatcherProcess({
  loopId,
  runtimeRoot = REVIEWLOOP_RUNTIME_ROOT,
  env = process.env,
  spawnFn = spawn,
} = {}) {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawnFn(process.execPath, [scriptPath, '--loop', loopId], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      REVIEWLOOP_RUNTIME_DIR: runtimeRoot,
    },
  });
  if (typeof child?.unref === 'function') child.unref();
  return { pid: child?.pid ?? null };
}

function parseCliArgs(argv) {
  const idx = argv.indexOf('--loop');
  const eq = argv.find((a) => a.startsWith('--loop='));
  const loopId = eq ? eq.slice('--loop='.length) : (idx >= 0 ? argv[idx + 1] : null);
  return { loopId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { loopId } = parseCliArgs(process.argv.slice(2));
  if (!loopId) {
    console.error('usage: node prWatcher.js --loop <loopId>');
    process.exit(1);
  }
  runPrWatcher({ loopId }).then(
    () => process.exit(0),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
