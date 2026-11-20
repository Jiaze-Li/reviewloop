// Design d3: no dead ends. A human always has a real, audited exit: stop the
// task, grant more calls to ONE task, confirm again past the standard count
// with an enforced budget. Zero provider calls; fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { extendCalls, effectiveCallLimits } from '../src/reviewloop/callAllowance.js';
import { stopLoop } from '../src/reviewloop/loopStop.js';
import { overrideLoopBudget } from '../src/reviewloop/budgetOverride.js';
import { withInProcessLoopLock } from '../src/reviewloop/loopLease.js';
import { makeHarness, finding, MemoryPersistence } from './helpers/reviewLoopHarness.js';

const ENV2 = { REVIEWLOOP_MAX_REVIEWER_CALLS: '2' };
let seq = 0;
async function meter(spend, usage = { input_tokens: 10, output_tokens: 5 }) {
  const op = `op-${++seq}`;
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: op, diffHash: `${op}::G` });
  return spend.meteredCall({
    role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: op, attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage, model: 'm' }),
  });
}
const loopRecord = (id, extra = {}) => ({
  loopId: id, state: 'HUMAN_REQUIRED', round: 3, objective: { mode: 'LOCAL', taskType: 'code' },
  history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'model spend blocked: SPEND_DENIED (ReviewLoop reviewer call ceiling (2) reached)', at: '2026-11-20T00:00:00.000Z' }],
  ...extra,
});

// ---- extend-calls: task-level, audited, enforced, isolated --------------------

test('extend-calls raises the ceiling for ONE loop; another loop and the global settings are untouched (AC14, I9)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A') });
  await persistence.updateWorkflowState('B', { reviewLoop: loopRecord('B') });
  const envBefore = JSON.stringify(ENV2);
  for (const id of ['A', 'B']) {
    const s = createReviewLoopSpend({ loopId: id, persistence, env: ENV2 });
    await meter(s); await meter(s);
    await assert.rejects(() => meter(s), /reviewer call ceiling \(2\)/);
  }
  const res = await extendCalls({ persistence, loopId: 'A', reviewerCalls: 2, reason: 'one more attempt after the fix', env: ENV2 });
  assert.equal(res.granted[0].previousCeiling, 2);
  assert.equal(res.granted[0].newCeiling, 4);
  assert.equal(res.loopState, 'HUMAN_REQUIRED', 'extend-calls never moves the loop state');

  const a = createReviewLoopSpend({ loopId: 'A', persistence, env: ENV2 });
  await meter(a); await meter(a);
  await assert.rejects(() => meter(a), /reviewer call ceiling \(4\)/, 'the grant is a number, enforced');
  const b = createReviewLoopSpend({ loopId: 'B', persistence, env: ENV2 });
  await assert.rejects(() => meter(b), /reviewer call ceiling \(2\)/, 'loop B keeps the global ceiling');
  assert.equal(JSON.stringify(ENV2), envBefore, 'global settings untouched');
  const wf = await persistence.readWorkflowState('A');
  assert.equal(wf.reviewLoopCallAllowance.history[0].reason, 'one more attempt after the fix');
  assert.equal(wf.reviewLoopCallAllowance.history[0].tier, 'EXTEND');
  assert.equal(wf.reviewLoop.state, 'HUMAN_REQUIRED');
});

test('extend-calls refuses bad input and grants that would not raise the ceiling; refusals write nothing', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A') });
  const s = createReviewLoopSpend({ loopId: 'A', persistence, env: ENV2 });
  await meter(s); await meter(s);
  const frozen = JSON.stringify(await persistence.readWorkflowState('A'));
  const call = (over) => extendCalls({ persistence, loopId: 'A', reviewerCalls: 2, reason: 'r', env: ENV2, ...over });
  await assert.rejects(() => call({ reviewerCalls: 0 }), /between 1 and 50/);
  await assert.rejects(() => call({ reviewerCalls: 51 }), /between 1 and 50/);
  await assert.rejects(() => call({ reviewerCalls: 'many' }), /between 1 and 50/);
  await assert.rejects(() => call({ supervisorCalls: 21 }), /between 1 and 20/);
  await assert.rejects(() => call({ reviewerCalls: null }), /--reviewer-calls/);
  await assert.rejects(() => call({ reason: ' ' }), /explicit reason/);
  await assert.rejects(() => call({ loopId: 'nope' }), /unknown loopId/);
  assert.equal(JSON.stringify(await persistence.readWorkflowState('A')), frozen);

  // used 2 + 0 would not exceed; a loop with a higher ceiling cannot be "extended" downward.
  await assert.rejects(() => call({ env: { REVIEWLOOP_MAX_REVIEWER_CALLS: '10' }, reviewerCalls: 3 }), /does not exceed the current reviewer ceiling \(10\)/);
  assert.equal(JSON.stringify(await persistence.readWorkflowState('A')), frozen);

  for (const state of ['PASS', 'FAILED', 'STOPPED']) {
    await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A', { state }) });
    await assert.rejects(() => call(), new RegExp(`loop is ${state}`));
  }
  await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A', { objective: { mode: 'PR' } }) });
  await assert.rejects(() => call(), /PR session retired/);
});

test('a write failure or a concurrent change leaves the workflow untouched', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A') });
  const s = createReviewLoopSpend({ loopId: 'A', persistence, env: ENV2 });
  await meter(s); await meter(s);
  const frozen = JSON.stringify(await persistence.readWorkflowState('A'));

  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async () => { throw new Error('disk full'); };
  await assert.rejects(() => extendCalls({ persistence, loopId: 'A', reviewerCalls: 2, reason: 'r', env: ENV2 }), /disk full/);
  persistence.updateWorkflowState = realUpdate;
  assert.equal(JSON.stringify(await persistence.readWorkflowState('A')), frozen);

  // Another writer moves the loop between our read and the pre-write re-read.
  const realRead = persistence.readWorkflowState.bind(persistence);
  let reads = 0;
  persistence.readWorkflowState = async (id) => {
    const wf = await realRead(id);
    reads += 1;
    if (reads === 2 && wf) wf.reviewLoop.updatedAt = 'moved';
    return wf;
  };
  await assert.rejects(() => extendCalls({ persistence, loopId: 'A', reviewerCalls: 2, reason: 'r', env: ENV2 }), /concurrent modification/);
  persistence.readWorkflowState = realRead;
  assert.equal(JSON.stringify(await persistence.readWorkflowState('A')), frozen);
});

test('override-budget cannot overwrite the task-level call allowance (own key)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('A', {
    reviewLoop: loopRecord('A', {
      history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'model spend blocked: SPEND_DENIED (ReviewLoop usage-volume ceiling reached)', at: '2026-11-20T00:00:00.000Z' }],
    }),
    reviewLoopSpend: { records: [{ role: 'reviewer', usageVolume: 403000, usageKnown: true, costUsd: 0.1, costKnown: true }] },
  });
  await extendCalls({ persistence, loopId: 'A', reviewerCalls: 3, reason: 'more calls', env: ENV2 });
  const before = (await persistence.readWorkflowState('A')).reviewLoopCallAllowance;
  assert.ok(before.maxReviewerCalls >= 4);
  await overrideLoopBudget({ persistence, loopId: 'A', maxUsage: '900000', reason: 'raise the usage ceiling', env: ENV2 });
  const wf = await persistence.readWorkflowState('A');
  assert.deepEqual(wf.reviewLoopCallAllowance, before, 'the call allowance key is byte-identical after override-budget');
  assert.equal(wf.budgetOverrides.maxUsageVolume, 900000, 'override-budget still did its own job');
  assert.equal(effectiveCallLimits({ workflow: wf, env: ENV2 }).maxReviewerCalls, before.maxReviewerCalls);
});

// ---- stop-loop ---------------------------------------------------------------

const blocker = (t) => ({ findings: [finding('P2', 'a.js', t)] });

async function supervisorHumanLoop() {
  const same = blocker('contract conflict');
  const h = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: 'one' }, { fingerprint: 'd2', diff: 'two' }],
    reviews: [same, same],
    supervisorReplies: [{ guidance: 'The frozen requirements conflict and require a product decision.', recommendation: 'HUMAN_REQUIRED' }],
  });
  const { loopId } = await h.controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal((await h.controller.review({ loopId })).status, 'REWORK');
  const result = await h.controller.review({ loopId });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  return { ...h, loopId, result };
}

test('stop-loop ends a HUMAN_REQUIRED loop: STOPPED, nothing erased, no model call afterwards, never PASS (AC15)', async () => {
  const w = await supervisorHumanLoop();
  const before = await w.persistence.readWorkflowState(w.loopId);
  const callsBefore = { ...w.calls };
  const res = await stopLoop({ persistence: w.persistence, loopId: w.loopId, reason: 'the product decision is to drop this feature' });
  assert.equal(res.alreadyStopped, false);
  assert.equal(res.priorState, 'HUMAN_REQUIRED');
  const after = await w.persistence.readWorkflowState(w.loopId);
  assert.equal(after.reviewLoop.state, 'STOPPED');
  assert.equal(after.reviewLoop.humanStop.reason, 'the product decision is to drop this feature');
  assert.equal(after.reviewLoop.humanStop.priorState, 'HUMAN_REQUIRED');
  assert.match(after.reviewLoop.history.at(-1).reason, /^human stop:/);
  assert.match(after.reviewLoop.history.at(-2).reason, /bookkeeping hop, no review/);
  // I1: everything but the loop record is byte-identical; the loop keeps its history and objective.
  for (const k of Object.keys(before).filter((x) => x !== 'reviewLoop')) assert.deepEqual(after[k], before[k], `${k} untouched`);
  assert.deepEqual(after.reviewLoop.objective, before.reviewLoop.objective);
  assert.deepEqual(after.reviewLoop.history.slice(0, before.reviewLoop.history.length), before.reviewLoop.history);

  const next = await w.controller.review({ loopId: w.loopId });
  assert.equal(next.terminal, true);
  assert.equal(next.status, 'STOPPED');
  assert.notEqual(next.status, 'PASS');
  assert.match(next.reason, /ended by a human/);
  assert.deepEqual(w.calls, callsBefore, 'no reviewer, supervisor, gate or delta work after the stop');
});

test('stop-loop from a non-HUMAN_REQUIRED loop; stopping twice is a no-op; PASS and FAILED are refused (AC15)', async () => {
  const h = makeHarness({ reviews: [blocker('x'), { findings: [] }] });
  const { loopId } = await h.controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal((await h.controller.review({ loopId })).status, 'REWORK');
  const res = await stopLoop({ persistence: h.persistence, loopId, reason: 'abandoned' });
  assert.equal(res.priorState, 'REWORK');
  const reviewerCalls = h.calls.reviewer;
  assert.equal((await h.controller.review({ loopId })).status, 'STOPPED');
  assert.equal(h.calls.reviewer, reviewerCalls);

  const frozen = JSON.stringify(await h.persistence.readWorkflowState(loopId));
  const again = await stopLoop({ persistence: h.persistence, loopId, reason: 'again' });
  assert.equal(again.alreadyStopped, true);
  assert.equal(JSON.stringify(await h.persistence.readWorkflowState(loopId)), frozen, 'the second stop writes nothing');

  const done = makeHarness({ reviews: [{ findings: [] }] });
  const d = await done.controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal((await done.controller.review({ loopId: d.loopId })).status, 'PASS');
  await assert.rejects(() => stopLoop({ persistence: done.persistence, loopId: d.loopId, reason: 'x' }), /already PASS/);
  await done.persistence.updateWorkflowState(d.loopId, { reviewLoop: { ...(await done.persistence.readWorkflowState(d.loopId)).reviewLoop, state: 'FAILED' } });
  await assert.rejects(() => stopLoop({ persistence: done.persistence, loopId: d.loopId, reason: 'x' }), /already FAILED/);
  await assert.rejects(() => stopLoop({ persistence: done.persistence, loopId: d.loopId, reason: ' ' }), /explicit reason/);
  await assert.rejects(() => stopLoop({ persistence: done.persistence, loopId: 'nope', reason: 'x' }), /unknown loopId/);
});

test('stop-loop: a failing write or a concurrent change leaves the loop exactly as it was', async () => {
  const w = await supervisorHumanLoop();
  const frozen = JSON.stringify(await w.persistence.readWorkflowState(w.loopId));
  const realUpdate = w.persistence.updateWorkflowState.bind(w.persistence);
  w.persistence.updateWorkflowState = async () => { throw new Error('disk full'); };
  await assert.rejects(() => stopLoop({ persistence: w.persistence, loopId: w.loopId, reason: 'r' }), /disk full/);
  w.persistence.updateWorkflowState = realUpdate;
  assert.equal(JSON.stringify(await w.persistence.readWorkflowState(w.loopId)), frozen);

  const realRead = w.persistence.readWorkflowState.bind(w.persistence);
  let reads = 0;
  w.persistence.readWorkflowState = async (id) => {
    const wf = await realRead(id);
    reads += 1;
    if (reads === 2 && wf) wf.reviewLoop.updatedAt = 'moved';
    return wf;
  };
  await assert.rejects(() => stopLoop({ persistence: w.persistence, loopId: w.loopId, reason: 'r' }), /concurrent modification/);
  w.persistence.readWorkflowState = realRead;
  assert.equal(JSON.stringify(await w.persistence.readWorkflowState(w.loopId)), frozen);
});

test('an unreadable state record: stop-loop and extend-calls refuse with a pointer to the report, not a raw parse error', async () => {
  const persistence = new MemoryPersistence();
  persistence.readWorkflowState = async () => { throw new SyntaxError('Unexpected token } in JSON at position 17'); };
  await assert.rejects(() => stopLoop({ persistence, loopId: 'L', reason: 'r' }), /cannot be read \(SyntaxError\).*reviewloop report --loop L/s);
  await assert.rejects(() => extendCalls({ persistence, loopId: 'L', reviewerCalls: 2, reason: 'r' }), /cannot be read \(SyntaxError\).*reviewloop report --loop L/s);
});

test('two real concurrent recovery exits (extend-calls and stop-loop) against one persistence: exactly one wins (F003)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('A', { reviewLoop: loopRecord('A') });
  const s = createReviewLoopSpend({ loopId: 'A', persistence, env: ENV2 });
  await meter(s); await meter(s);
  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async (id, patch) => {
    await new Promise((r) => setTimeout(r, 20));
    return realUpdate(id, patch);
  };

  const results = await Promise.allSettled([
    extendCalls({ persistence, loopId: 'A', reviewerCalls: 2, reason: 'grant more calls', env: ENV2 }),
    stopLoop({ persistence, loopId: 'A', reason: 'stop instead' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const err = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(err.length, 1);
  assert.match(err[0].reason.message, /concurrent modification/);
  const wf = await persistence.readWorkflowState('A');
  assert.equal(wf.reviewLoop.state, 'HUMAN_REQUIRED', 'losing stop-loop wrote nothing');
  assert.ok(wf.reviewLoopCallAllowance.maxReviewerCalls > 2, 'winning extend-calls persisted');
});

test('override-budget uses commitGuardedUpdate: racing override-budget and extend-calls lets only one win (F005)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('OV', { reviewLoop: loopRecord('OV') });
  const s = createReviewLoopSpend({ loopId: 'OV', persistence, env: ENV2 });
  await meter(s); await meter(s);
  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async (id, patch) => {
    await new Promise((r) => setTimeout(r, 20));
    return realUpdate(id, patch);
  };

  const results = await Promise.allSettled([
    overrideLoopBudget({ persistence, loopId: 'OV', maxUsage: 900000, reason: 'raise usage', env: ENV2 }),
    extendCalls({ persistence, loopId: 'OV', reviewerCalls: 2, reason: 'raise calls', env: ENV2 }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const err = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(err.length, 1);
  assert.match(err[0].reason.message, /concurrent modification/);
});

test('human action shares the controller in-process loop lock and refuses if a running review mutates any field (F004)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('LC', { reviewLoop: loopRecord('LC') });
  const s = createReviewLoopSpend({ loopId: 'LC', persistence, env: ENV2 });
  await meter(s); await meter(s);

  // Simulate a live controller holding `withInProcessLoopLock('LC', ...)` and mutating
  // a field outside the old summary counts (budgetOverrides) before releasing.
  let releaseReview;
  const reviewEntered = new Promise((resolve) => {
    withInProcessLoopLock('LC', async () => {
      resolve();
      await new Promise((r) => { releaseReview = r; });
      await persistence.updateWorkflowState('LC', { budgetOverrides: { maxUsageVolume: 999999 } });
    });
  });
  await reviewEntered;

  const actionPromise = extendCalls({ persistence, loopId: 'LC', reviewerCalls: 2, reason: 'r', env: ENV2 });
  // Give extendCalls a tick to finish its initial read and block on withInProcessLoopLock.
  await new Promise((r) => setTimeout(r, 15));
  releaseReview();

  await assert.rejects(() => actionPromise, /concurrent modification/);
  const wf = await persistence.readWorkflowState('LC');
  assert.equal(wf.reviewLoopCallAllowance, undefined, 'refused human action wrote nothing');
});
