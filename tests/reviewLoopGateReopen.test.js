import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { reopenExhaustedGate, STANDARD_HUMAN_REOPENS } from '../src/reviewloop/gateReopen.js';
import { effectiveCallLimits } from '../src/reviewloop/callAllowance.js';

const phases = ['p1', 'p2'].map((id) => ({ id, objective: id, exitCriteria: ['ok'] }));
const blocker = (t) => ({ findings: [finding('P2', 'a.js', t)] });

async function exhaustedLoop(extraReviews = []) {
  const w = makeHarness({
    deltas: Array.from({ length: 20 }, (_, i) => ({ fingerprint: `d${i}`, diff: `change ${i}` })),
    reviews: [...'ABCDEFG'].map(blocker).concat(extraReviews),
    supervisorReplies: [
      { guidance: 'strategy one', recommendation: 'REWORK' },
      { guidance: 'strategy two', recommendation: 'REWORK' },
    ],
  });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r', phases });
  let last;
  for (let i = 0; i < 7; i += 1) last = await w.controller.review({ loopId }); // eslint-disable-line no-await-in-loop
  assert.equal(last.status, 'HUMAN_REQUIRED');
  assert.equal(last.budgetExhausted, true);
  return { ...w, loopId };
}

test('a human can reopen an exhausted gate; completed work and spend are preserved', async () => {
  const w = await exhaustedLoop([{ findings: [] }]);
  const before = (await w.persistence.readWorkflowState(w.loopId)).reviewLoop;
  const stuck = await w.controller.review({ loopId: w.loopId });
  assert.equal(stuck.terminal, true, 'the Worker is stopped until a human acts');

  const res = await reopenExhaustedGate({ persistence: w.persistence, loopId: w.loopId, reason: 'contract clarified' });
  assert.equal(res.reopens, 1);
  const after = (await w.persistence.readWorkflowState(w.loopId)).reviewLoop;
  assert.equal(after.state, 'REWORK');
  assert.equal(after.budgetExhausted, false);
  assert.equal(after.gateRound, 0);
  assert.equal(after.convergenceEpoch, 0);
  assert.equal(after.supervisorEscalationCount, 0);
  assert.equal(after.round, before.round, 'task-wide round is untouched');
  assert.equal(after.reviewerCalls, before.reviewerCalls, 'spend counters are untouched');
  assert.equal(after.humanReopens[0].reason, 'contract clarified');

  const next = await w.controller.review({ loopId: w.loopId });
  assert.equal(next.status, 'PHASE_PASS');
});

test('reopen refuses loops that are not exhausted or tripped', async () => {
  const fresh = makeHarness();
  const { loopId } = await fresh.controller.begin({ goal: 'g', cwd: '/r' });
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId, reason: 'x' }), /only a HUMAN_REQUIRED loop/);
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId, reason: ' ' }), /requires a loopId and a reason/);
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId: 'nope', reason: 'x' }), /unknown loopId/);

  const w = await exhaustedLoop();
  await w.persistence.updateWorkflowState(w.loopId, { reviewLoopTokenAnomaly: { tripped: true } });
  await assert.rejects(reopenExhaustedGate({ persistence: w.persistence, loopId: w.loopId, reason: 'x' }), /Token Sentinel/);
  await w.persistence.updateWorkflowState(w.loopId, { reviewLoopTokenAnomaly: { tripped: false } });

});

test('past the standard reopen count a human can still reopen, but only with an enforced call budget (AC14)', async () => {
  const w = await exhaustedLoop();
  const raw = await w.persistence.readWorkflowState(w.loopId);
  raw.reviewLoop.humanReopens = Array.from({ length: STANDARD_HUMAN_REOPENS }, () => ({ at: 't', reason: 'r' }));
  await w.persistence.writeWorkflowState(w.loopId, raw);
  const frozen = JSON.stringify(await w.persistence.readWorkflowState(w.loopId));
  await assert.rejects(reopenExhaustedGate({ persistence: w.persistence, loopId: w.loopId, reason: 'x' }), /--max-reviewer-calls/);
  assert.equal(JSON.stringify(await w.persistence.readWorkflowState(w.loopId)), frozen, 'refusal writes nothing');

  const currentLimits = effectiveCallLimits({ workflow: await w.persistence.readWorkflowState(w.loopId), env: {} });
  const res = await reopenExhaustedGate({
    persistence: w.persistence, loopId: w.loopId, reason: 'a new attempt after the scope was cut',
    allowance: { reviewerCalls: 2 }, currentLimits,
  });
  assert.equal(res.tier, 'EXTENDED');
  const after = await w.persistence.readWorkflowState(w.loopId);
  const used = after.reviewLoopSpend.records.filter((r) => r.role === 'reviewer').length;
  assert.equal(after.reviewLoopCallAllowance.maxReviewerCalls, used + 2);
  assert.equal(after.reviewLoop.humanReopens.at(-1).tier, 'EXTENDED');
  assert.equal(after.reviewLoop.state, 'REWORK');
});
