import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { reopenExhaustedGate, MAX_HUMAN_REOPENS } from '../src/reviewloop/gateReopen.js';

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

test('reopen refuses loops that are not exhausted, tripped, or reopened too often', async () => {
  const fresh = makeHarness();
  const { loopId } = await fresh.controller.begin({ goal: 'g', cwd: '/r' });
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId, reason: 'x' }), /only a HUMAN_REQUIRED loop/);
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId, reason: ' ' }), /requires a loopId and a reason/);
  await assert.rejects(reopenExhaustedGate({ persistence: fresh.persistence, loopId: 'nope', reason: 'x' }), /unknown loopId/);

  const w = await exhaustedLoop();
  await w.persistence.updateWorkflowState(w.loopId, { reviewLoopTokenAnomaly: { tripped: true } });
  await assert.rejects(reopenExhaustedGate({ persistence: w.persistence, loopId: w.loopId, reason: 'x' }), /Token Sentinel/);
  await w.persistence.updateWorkflowState(w.loopId, { reviewLoopTokenAnomaly: { tripped: false } });

  const raw = await w.persistence.readWorkflowState(w.loopId);
  raw.reviewLoop.humanReopens = Array.from({ length: MAX_HUMAN_REOPENS }, () => ({ at: 't', reason: 'r' }));
  await w.persistence.writeWorkflowState(w.loopId, raw);
  await assert.rejects(reopenExhaustedGate({ persistence: w.persistence, loopId: w.loopId, reason: 'x' }), /already reopened/);
});
