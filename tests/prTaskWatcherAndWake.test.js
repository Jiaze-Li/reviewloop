import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWakePlan, executeWake } from '../src/reviewloop/prWakeAdapter.js';
import { runPrWatcher, DEFAULT_BACKOFF_MS } from '../src/reviewloop/prWatcher.js';
import { formatPrStatusEntry, buildPrResumeText, stopPrTask, bindPrAgent, triggerPrReviewCli } from '../src/reviewloop/prCli.js';
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
    verifyWatcherPidFn: async (pid) => pid === 12345,
    killFn: (pid) => { killedPid = pid; },
  });
  assert.equal(killedPid, 12345);
  assert.equal(stopped.watcherStopped, 12345);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal((await store.loadPrTask(loopState.loopId)).watcher.pid, null);

  // Unverified/reused PID is NOT killed
  const setupUnverified = setupPrLoop({ watcher: { pid: 54321 } });
  await store.save('rl-unverified', { ...setupUnverified.loopState, loopId: 'rl-unverified' });
  await store.savePrTask('rl-unverified', { ...setupUnverified.prTask, loopId: 'rl-unverified' });
  let unverifiedKilled = false;
  const stoppedUnverified = await stopPrTask({
    persistence,
    loopId: 'rl-unverified',
    verifyWatcherPidFn: async () => false,
    killFn: () => { unverifiedKilled = true; },
  });
  assert.equal(unverifiedKilled, false);
  assert.equal(stoppedUnverified.watcherStopped, null);

  // Concurrent stop during slow fetchPrSnapshotFn is NOT overwritten by pollPrOnce
  const { pollPrOnce } = await import('../src/reviewloop/prWatcher.js');
  const pRace = new MemoryPersistence();
  const sRace = new ReviewLoopStore(pRace);
  const raceSetup = setupPrLoop({ watcher: { pid: 11111 } });
  await sRace.save(raceSetup.loopState.loopId, raceSetup.loopState);
  await sRace.savePrTask(raceSetup.loopState.loopId, raceSetup.prTask);

  const raceOutcome = await pollPrOnce({
    loopId: raceSetup.loopState.loopId,
    store: sRace,
    fetchPrSnapshotFn: async () => {
      await stopPrTask({
        persistence: pRace,
        loopId: raceSetup.loopState.loopId,
        reason: 'user stopped mid-fetch',
        verifyWatcherPidFn: async () => false,
      });
      return {
        prState: { state: 'OPEN', headRefOid: HEAD_A },
        comments: [{
          id: 'c1',
          author: { login: 'claude-review-bot[bot]' },
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${HEAD_A}"} -->`,
        }],
      };
    },
  });
  assert.equal(raceOutcome.reason, 'STATE_CHANGED_DURING_POLL');
  assert.equal((await sRace.load(raceSetup.loopState.loopId)).state, 'STOPPED');

  // Concurrent boundHeadSha advance during slow fetchPrSnapshotFn does NOT trigger spurious HEAD_DRIFT
  const pPushRace = new MemoryPersistence();
  const sPushRace = new ReviewLoopStore(pPushRace);
  const pushRaceSetup = setupPrLoop({ watcher: { pid: 22222 } });
  await sPushRace.save(pushRaceSetup.loopState.loopId, pushRaceSetup.loopState);
  await sPushRace.savePrTask(pushRaceSetup.loopState.loopId, pushRaceSetup.prTask);
  const pushRaceOutcome = await pollPrOnce({
    loopId: pushRaceSetup.loopState.loopId,
    store: sPushRace,
    fetchPrSnapshotFn: async () => {
      const updated = await sPushRace.loadPrTask(pushRaceSetup.loopState.loopId);
      updated.boundHeadSha = 'b'.repeat(40);
      await sPushRace.savePrTask(pushRaceSetup.loopState.loopId, updated);
      return {
        prState: { state: 'OPEN', headRefOid: HEAD_A },
        comments: [],
      };
    },
  });
  assert.equal(pushRaceOutcome.done, false);
  assert.equal(pushRaceOutcome.reason, 'BOUND_HEAD_CHANGED_DURING_POLL');
  assert.equal((await sPushRace.load(pushRaceSetup.loopState.loopId)).state, 'WAITING_FOR_REVIEW');

  // Retired mode=PR rejected
  assert.throws(
    () => buildPrResumeText({ loopState: { loopId: 'old', objective: { mode: 'PR' } }, prTask }),
    /retired mode="PR"/,
  );
});

test('AC-04/AC-05: bindPrAgent, triggerPrReviewCli, and watcher transient error backoff', async () => {
  const persistence = new MemoryPersistence();
  const store = new ReviewLoopStore(persistence);
  const { loopState, prTask } = setupPrLoop();
  await store.save(loopState.loopId, loopState);
  await store.savePrTask(loopState.loopId, prTask);

  const bound = await bindPrAgent({
    persistence,
    loopId: loopState.loopId,
    agentType: 'claude',
    agentSessionId: 'sess-bound-1',
  });
  assert.equal(bound.agentType, 'claude');
  assert.equal(bound.agentSessionId, 'sess-bound-1');
  assert.equal((await store.loadPrTask(loopState.loopId)).watcher.agentSessionId, 'sess-bound-1');

  await assert.rejects(
    () => bindPrAgent({ persistence, loopId: loopState.loopId, agentType: 'unknown' }),
    /unsupported agentType/,
  );

  const trigRes = await triggerPrReviewCli({
    persistence,
    loopId: loopState.loopId,
    fetchPrSnapshotFn: async () => ({
      prState: { state: 'OPEN', headRefOid: HEAD_A },
      comments: [],
    }),
    postCommentFn: async () => ({ commentId: 'c-trig-1', commentUrl: 'https://github.com/x/y/pull/51#issuecomment-1' }),
  });
  assert.equal(trigRes.posted, true);
  assert.equal(trigRes.postedCount, 1);

  // Watcher survives transient network error and recovers on next poll
  let calls = 0;
  let now = 0;
  const watchRes = await runPrWatcher({
    loopId: loopState.loopId,
    persistence,
    backoffMs: [100],
    maxWaitMs: 5000,
    fetchPrSnapshotFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('gh network timeout');
      return {
        prState: { state: 'OPEN', headRefOid: HEAD_A },
        comments: [{
          id: 'c-ready',
          author: { login: 'jiaze-claude-review-bot[bot]' },
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${HEAD_A}","auditCompleted":true} -->`,
        }],
      };
    },
    wakeFn: async () => ({ woken: false, wakeStatus: 'MANUAL_REQUIRED', reason: 'DONE' }),
    sleepFn: async (ms) => { now += ms; },
    clock: () => now,
    pid: 77777,
  });
  assert.equal(watchRes.status, 'PASS');
  assert.equal(calls, 2);
  assert.equal((await store.loadPrTask(loopState.loopId)).watcher.consecutiveErrors, 1);

  // stopPrTask remains idempotent on already-STOPPED / HUMAN_REQUIRED / PASS loops,
  // while bindPrAgent and triggerPrReviewCli reject with their own operation errors.
  const humanSetup = setupPrLoop({ state: REVIEW_LOOP_STATES.HUMAN_REQUIRED, watcher: { pid: 65432 } });
  await store.save('rl-human-stop', { ...humanSetup.loopState, loopId: 'rl-human-stop' });
  await store.savePrTask('rl-human-stop', { ...humanSetup.prTask, loopId: 'rl-human-stop' });
  let killedHumanPid = null;
  const stoppedHuman = await stopPrTask({
    persistence,
    loopId: 'rl-human-stop',
    verifyWatcherPidFn: async (pid) => pid === 65432,
    killFn: (pid) => { killedHumanPid = pid; },
  });
  assert.equal(killedHumanPid, 65432);
  assert.equal(stoppedHuman.state, 'HUMAN_REQUIRED');
  assert.equal((await store.loadPrTask('rl-human-stop')).watcher.pid, null);
  await assert.rejects(
    () => bindPrAgent({ persistence, loopId: 'rl-human-stop', agentType: 'claude', agentSessionId: 's1' }),
    /cannot bind agent when loop state is HUMAN_REQUIRED/,
  );
  await assert.rejects(
    () => triggerPrReviewCli({ persistence, loopId: 'rl-human-stop' }),
    /cannot trigger review when loop state is HUMAN_REQUIRED/,
  );

  const stoppedSetup = setupPrLoop({ state: REVIEW_LOOP_STATES.STOPPED, watcher: { pid: 65433 } });
  await store.save('rl-already-stopped', { ...stoppedSetup.loopState, loopId: 'rl-already-stopped' });
  await store.savePrTask('rl-already-stopped', { ...stoppedSetup.prTask, loopId: 'rl-already-stopped' });
  const stoppedAgain = await stopPrTask({
    persistence,
    loopId: 'rl-already-stopped',
    verifyWatcherPidFn: async () => false,
  });
  assert.equal(stoppedAgain.state, 'STOPPED');
});
