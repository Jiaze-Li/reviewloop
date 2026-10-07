import test from 'node:test';
import assert from 'node:assert/strict';

import { makeHarness, finding } from './helpers/reviewLoopHarness.js';

function blocker(title, file = 'a.js') {
  return { findings: [finding('P2', file, title)] };
}

test('epoch exhaustion escalates to Supervisor instead of HUMAN_REQUIRED', async () => {
  const { controller, calls, persistence } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'one' },
      { fingerprint: 'd2', diff: 'two' },
      { fingerprint: 'd3', diff: 'three' },
    ],
    reviews: [blocker('A'), blocker('B'), blocker('C')],
    supervisorReplies: [{ guidance: 'change the invariant, not another local patch', recommendation: 'REWORK' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const third = await controller.review({ loopId });

  assert.equal(third.status, 'REWORK');
  assert.equal(calls.supervisor, 1);
  assert.equal(third.convergenceEpoch, 1);
  assert.equal(third.epochReviewRound, 0);
  assert.equal(third.supervisorEscalationCount, 1);

  const raw = await persistence.readWorkflowState(loopId);
  assert.equal(raw.reviewLoop.budgetExhausted, false);
});

test('default automatic path is bounded across two Supervisor-guided epochs', async () => {
  const { controller, calls } = makeHarness({
    deltas: Array.from({ length: 7 }, (_, i) => ({
      fingerprint: `d${i + 1}`,
      diff: `change ${i + 1}`,
    })),
    reviews: [
      blocker('A'), blocker('B'), blocker('C'),
      blocker('D'), blocker('E'),
      blocker('F'), blocker('G'),
    ],
    supervisorReplies: [
      { guidance: 'strategy one', recommendation: 'REWORK' },
      { guidance: 'strategy two', recommendation: 'REWORK' },
    ],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push((await controller.review({ loopId })).status);
  }

  assert.deepEqual(statuses, [
    'REWORK', 'REWORK', 'REWORK',
    'REWORK', 'REWORK',
    'REWORK', 'HUMAN_REQUIRED',
  ]);
  assert.equal(calls.reviewer, 7);
  assert.equal(calls.supervisor, 2);
});

test('same blocker on two changed review states triggers an early Supervisor escalation', async () => {
  const same = blocker('same invariant is still broken');
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'first repair' },
      { fingerprint: 'd2', diff: 'second repair' },
    ],
    reviews: [same, same],
    supervisorReplies: [{ guidance: 'repair the shared invariant', recommendation: 'REWORK' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const second = await controller.review({ loopId });
  assert.equal(second.status, 'REWORK');
  assert.equal(calls.supervisor, 1);
  assert.equal(second.convergenceEpoch, 1);
});

test('REVIEWER_RECONSIDER permits one same-code independent re-review as new information', async () => {
  const same = blocker('reviewer assumption is wrong');
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'initial code' },
      { fingerprint: 'd2', diff: 'changed code' },
      { fingerprint: 'd2', diff: 'changed code' },
    ],
    reviews: [same, same, { findings: [] }],
    supervisorReplies: [{
      guidance: 'The blocker requires an invariant outside the frozen contract. Reconsider against the actual contract.',
      recommendation: 'REVIEWER_RECONSIDER',
    }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const escalated = await controller.review({ loopId });
  assert.equal(escalated.status, 'REWORK');
  assert.match(escalated.nextAction, /re-call reviewloop_review/i);
  assert.equal(calls.supervisor, 1);

  const reconsidered = await controller.review({ loopId });
  assert.equal(reconsidered.status, 'PASS');
  assert.equal(calls.reviewer, 3);
});

test('Supervisor HUMAN_REQUIRED remains immediately terminal', async () => {
  const same = blocker('contract conflict');
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'one' },
      { fingerprint: 'd2', diff: 'two' },
    ],
    reviews: [same, same],
    supervisorReplies: [{
      guidance: 'The frozen requirements conflict and require a product decision.',
      recommendation: 'HUMAN_REQUIRED',
    }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const result = await controller.review({ loopId });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.terminal, true);
  assert.equal(result.budgetExhausted, true);
  assert.equal(calls.supervisor, 1);
});
