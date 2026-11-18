import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWakePlan, executeWake } from '../src/reviewloop/prWakeAdapter.js';
import { runPrWatcher, DEFAULT_BACKOFF_MS } from '../src/reviewloop/prWatcher.js';
import { formatPrStatusEntry, buildPrResumeText, stopPrTask } from '../src/reviewloop/prCli.js';
import { createReviewObjective, TASK_TYPES } from '../src/reviewloop/objective.js';
import { initialLoopState, initialPrTaskState, ReviewLoopStore, REVIEW_LOOP_STATES } from '../src/reviewloop/state.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function setupPrLoop(overrides = {}) {
  const objective = createReviewObjective({
    loopId: 'rl-watch-1',
    goal: 'Fix PR #51',
    taskType: TASK_TYPES.PR,
    prContext: {
      repoFullName: 'Jiaze-Li/reviewloop',
      repoRoot: '/repo',
      prNumber: 51,
      baseBranch: 'main',
      headBranch: 'feat/pr-task',
      boundHeadSha: HEAD_A,
      originContractText: '# Frozen Contract',
      permissions: { edit: true, commit: true, push: true, comment: true, autoWake: true },
      ...(overrides.prContext ?? {}),
    },
    createdAt: '2026-11-18T00:00:00.000Z',
  });
  const loopState = initialLoopState(objective);
  loopState.state = overrides.state ?? REVIEW_LOOP_STATES.WAITING_FOR_REVIEW;
  const prTask = initialPrTaskState(objective);
  if (overrides.watcher) prTask.watcher = overrides.watcher;
  return { loopState, prTask };
}

test('INV-3: prWatcher.js and prWakeAdapter.js have zero LLM/provider imports', async () => {
  const watcherSrc = await readFile(path.resolve('src/reviewloop/prWatcher.js'), 'utf8');
  const wakeSrc = await readFile(path.resolve('src/reviewloop/prWakeAdapter.js'), 'utf8');
  for (const src of [watcherSrc, wakeSrc]) {
    assert.doesNotMatch(src, /providerWiring|callAgy|reviewerRunner|roleRouting/);
  }
});

test('buildWakePlan and executeWake support claude/codex and explicitly degrade agy or unauthorized', async () => {
  const { prTask } = setupPrLoop();

  const claudePlan = buildWakePlan({
    loopId: 'rl-watch-1',
    prTask,
    agentType: 'claude',
    agentSessionId: 'sess-claude-1',
    autoWakeAuthorized: true,
  });
  assert.equal(claudePlan.wakeStatus, 'READY_TO_WAKE');
  assert.equal(claudePlan.command, 'claude');
  assert.deepEqual(claudePlan.args.slice(0, 3), ['--resume', 'sess-claude-1', '-p']);

  const codexPlan = buildWakePlan({
    loopId: 'rl-watch-1',
    prTask,
    agentType: 'codex',
    agentSessionId: 'sess-codex-1',
    autoWakeAuthorized: true,
  });
  assert.equal(codexPlan.wakeStatus, 'READY_TO_WAKE');
  assert.equal(codexPlan.command, 'codex');
  assert.deepEqual(codexPlan.args.slice(0, 3), ['exec', 'resume', 'sess-codex-1']);

  const agyPlan = buildWakePlan({
    loopId: 'rl-watch-1',
    prTask,
    agentType: 'agy',
    agentSessionId: 'sess-agy-1',
    autoWakeAuthorized: true,
  });
  assert.equal(agyPlan.wakeStatus, 'MANUAL_REQUIRED');
  assert.equal(agyPlan.autoWake, 'UNAVAILABLE');
  assert.equal(agyPlan.reason, 'AGY_AUTO_WAKE_UNSUPPORTED');
  assert.equal(agyPlan.manualResumeCommand, 'reviewloop pr resume --loop rl-watch-1');

  const unauthPlan = buildWakePlan({
    loopId: 'rl-watch-1',
    prTask,
    agentType: 'claude',
    agentSessionId: 'sess-claude-1',
    autoWakeAuthorized: false,
  });
  assert.equal(unauthPlan.wakeStatus, 'MANUAL_REQUIRED');
  assert.equal(unauthPlan.reason, 'AUTO_WAKE_NOT_AUTHORIZED');

  let spawnedCmd = null;
  const woken = await executeWake({
    loopId: 'rl-watch-1',
    prTask,
    agentType: 'claude',
    agentSessionId: 'sess-claude-1',
    autoWakeAuthorized: true,
    spawnFn: (cmd) => {
      spawnedCmd = cmd;
      return { pid: 4242, unref: () => {} };
    },
  });
  assert.equal(woken.woken, true);
  assert.equal(woken.wakeStatus, 'WOKEN');
  assert.equal(spawnedCmd, 'claude');
});

test('runPrWatcher polls with backoff, transitions on REWORK, and preserves state on maxWait timeout', async () => {
  const persistence = new MemoryPersistence();
  const store = new ReviewLoopStore(persistence);
  const { loopState, prTask } = setupPrLoop({
    watcher: { agentType: 'claude', agentSessionId: 'sess-1' },
  });
  await store.save(loopState.loopId, loopState);
  await store.savePrTask(loopState.loopId, prTask);

  let nowMs = 1_000_000;
  const delays = [];
  let pollCount = 0;
  let wakeCalls = 0;

  const res = await runPrWatcher({
    loopId: loopState.loopId,
    persistence,
    fetchPrSnapshotFn: async () => {
      pollCount += 1;
      const status = pollCount < 3 ? 'AUDIT_PENDING' : 'REWORK';
      return {
        prState: { state: 'OPEN', headRefOid: HEAD_A },
        comments: [{
          id: 'c1',
          author: { login: 'claude-review-bot[bot]' },
          body: `<!-- jiaze-review-session:v1 {"status":"${status}","lastReviewedHead":"${HEAD_A}","findings":[{"id":"F001","severity":"P1","status":"OPEN","title":"Bug"}]} -->`,
        }],
      };
    },
    wakeFn: async () => {
      wakeCalls += 1;
      return { woken: true, wakeStatus: 'WOKEN', manualResumeCommand: `reviewloop pr resume --loop ${loopState.loopId}` };
    },
    sleepFn: async (ms) => {
      delays.push(ms);
      nowMs += ms;
    },
    clock: () => nowMs,
    pid: 99999,
  });

  assert.equal(res.status, 'REWORK');
  assert.deepEqual(delays, [DEFAULT_BACKOFF_MS[0], DEFAULT_BACKOFF_MS[1]]);
  assert.equal(wakeCalls, 1);

  const reloadedLoop = await store.load(loopState.loopId);
  const reloadedPr = await store.loadPrTask(loopState.loopId);
  assert.equal(reloadedLoop.state, 'REWORK');
  assert.equal(reloadedPr.watcher.pid, null);
  assert.equal(reloadedPr.watcher.wakeStatus, 'WOKEN');

  // Timeout preserves WAITING_FOR_REVIEW and sets MANUAL_REQUIRED
  const persistence2 = new MemoryPersistence();
  const store2 = new ReviewLoopStore(persistence2);
  const setup2 = setupPrLoop();
  await store2.save(setup2.loopState.loopId, setup2.loopState);
  await store2.savePrTask(setup2.loopState.loopId, setup2.prTask);

  let t2 = 0;
  const timeoutRes = await runPrWatcher({
    loopId: setup2.loopState.loopId,
    persistence: persistence2,
    backoffMs: [1000],
    maxWaitMs: 500,
    fetchPrSnapshotFn: async () => ({
      prState: { state: 'OPEN', headRefOid: HEAD_A },
      comments: [],
    }),
    sleepFn: async (ms) => { t2 += ms; },
    clock: () => t2,
    pid: 88888,
  });
  assert.equal(timeoutRes.reason, 'MAX_WAIT_REACHED');
  assert.equal((await store2.load(setup2.loopState.loopId)).state, 'WAITING_FOR_REVIEW');
  assert.equal((await store2.loadPrTask(setup2.loopState.loopId)).watcher.wakeStatus, 'MANUAL_REQUIRED');
});

test('prCli formats status, builds resume text, stops watcher/loop, and rejects retired mode=PR', async () => {
  const persistence = new MemoryPersistence();
  const store = new ReviewLoopStore(persistence);
  const { loopState, prTask } = setupPrLoop({ watcher: { pid: 12345 } });
  await store.save(loopState.loopId, loopState);
  await store.savePrTask(loopState.loopId, prTask);

  const entry = formatPrStatusEntry({ loopState, prTask });
  assert.equal(entry.prNumber, 51);
  assert.equal(entry.postedReviewTriggers, 0);
  assert.equal(entry.watcherPid, 12345);

  const resumeText = buildPrResumeText({ loopState, prTask });
  assert.match(resumeText, /PR #51/);
  assert.match(resumeText, /ORIGIN FROZEN CONTRACT/);

  let killedPid = null;
  const stopped = await stopPrTask({
    persistence,
    loopId: loopState.loopId,
    reason: 'manual stop',
    killFn: (pid) => { killedPid = pid; },
  });
  assert.equal(killedPid, 12345);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal((await store.loadPrTask(loopState.loopId)).watcher.pid, null);

  // Retired mode=PR rejected
  assert.throws(
    () => buildPrResumeText({ loopState: { loopId: 'old', objective: { mode: 'PR' } }, prTask }),
    /retired mode="PR"/,
  );
});
