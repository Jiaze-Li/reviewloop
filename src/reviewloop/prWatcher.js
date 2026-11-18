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

function isPidAlive(pid) {
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
  nowFn = () => new Date().toISOString(),
}) {
  const loopState = await store.load(loopId);
  const prTask = await store.loadPrTask(loopId);

  if (!loopState || !prTask) {
    return { done: true, reason: 'LOOP_OR_PR_TASK_MISSING' };
  }
  if (loopState.state !== REVIEW_LOOP_STATES.WAITING_FOR_REVIEW) {
    return { done: true, status: loopState.state, reason: 'NOT_WAITING' };
  }

  const snapshot = await fetchPrSnapshotFn({
    repoFullName: prTask.repoFullName,
    prNumber: prTask.prNumber,
  });

  const evaluated = evaluatePrStatus({
    prState: snapshot.prState,
    prTask,
    comments: snapshot.comments,
  });

  const nowIso = nowFn();
  prTask.latestBotSession = evaluated.session;
  prTask.watcher = {
    ...(prTask.watcher ?? {}),
    lastPollAt: nowIso,
  };
  prTask.updatedAt = nowIso;

  if (evaluated.verdict === 'WAITING_FOR_REVIEW') {
    await store.savePrTask(loopId, prTask);
    return { done: false, status: REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, reason: evaluated.reason };
  }

  const targetState = evaluated.verdict === 'PASS'
    ? REVIEW_LOOP_STATES.PASS
    : evaluated.verdict === 'REWORK'
      ? REVIEW_LOOP_STATES.REWORK
      : evaluated.verdict === 'STOPPED'
        ? REVIEW_LOOP_STATES.STOPPED
        : REVIEW_LOOP_STATES.HUMAN_REQUIRED;

  recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'prWatcher received bot update');
  recordTransition(loopState, targetState, evaluated.reason);
  if (targetState === REVIEW_LOOP_STATES.STOPPED || targetState === REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
    prTask.stopReason = evaluated.reason;
  }
  prTask.watcher.pid = null;
  prTask.watcher.stoppedAt = nowIso;

  let wakeResult = null;
  if (targetState !== REVIEW_LOOP_STATES.STOPPED && typeof wakeFn === 'function') {
    wakeResult = await wakeFn({ loopId, prTask });
    prTask.watcher.wakeStatus = wakeResult.wakeStatus;
    prTask.watcher.wakeReason = wakeResult.reason ?? null;
    prTask.watcher.manualResumeCommand = wakeResult.manualResumeCommand ?? `reviewloop pr resume --loop ${loopId}`;
  }

  await store.save(loopId, loopState);
  await store.savePrTask(loopId, prTask);

  return {
    done: true,
    status: targetState,
    reason: evaluated.reason,
    wakeResult,
  };
}

export async function runPrWatcher({
  loopId,
  runtimeRoot = REVIEWLOOP_RUNTIME_ROOT,
  persistence: injectedPersistence = null,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  wakeFn = executeWake,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
  pid = process.pid,
} = {}) {
  const persistence = injectedPersistence ?? new Persistence(runtimeRoot);
  const store = new ReviewLoopStore(persistence);
  const lease = injectedPersistence
    ? { ok: true, release: async () => {} }
    : await acquireLoopFileLease({ runtimeRoot, loopId, reason: 'pr-watcher' });

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
    const stepLease = injectedPersistence
      ? { ok: true, release: async () => {} }
      : await acquireLoopFileLease({ runtimeRoot, loopId, reason: 'pr-watcher-poll' });
    let outcome;
    if (stepLease.ok) {
      try {
        outcome = await pollPrOnce({
          loopId,
          store,
          fetchPrSnapshotFn,
          wakeFn,
          nowFn: () => new Date(clock()).toISOString(),
        });
      } finally {
        await stepLease.release();
      }
      if (outcome?.done) {
        return { exited: true, ...outcome };
      }
    }

    const elapsed = clock() - startedAt;
    if (elapsed >= maxWaitMs) {
      const endLease = injectedPersistence
        ? { ok: true, release: async () => {} }
        : await acquireLoopFileLease({ runtimeRoot, loopId, reason: 'pr-watcher-timeout' });
      if (endLease.ok) {
        try {
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
        } finally {
          await endLease.release();
        }
      }
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
