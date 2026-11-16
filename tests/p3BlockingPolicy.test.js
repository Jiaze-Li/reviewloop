import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewObjective } from '../src/reviewloop/objective.js';
import { reviewerInstructionsText } from '../src/reviewloop/providerWiring.js';

const base = { loopId: 'rl-p3', goal: 'g' };

test('code objective blocks P1, P2 and P3 by default', () => {
  assert.deepEqual(createReviewObjective({ ...base }).blockingSeverities, ['P1', 'P2', 'P3']);
});

test('design objective keeps P3 non-blocking by default', () => {
  assert.deepEqual(createReviewObjective({ ...base, taskType: 'design' }).blockingSeverities, ['P1', 'P2']);
});

test('an explicit blockingSeverities list wins over the task-type default', () => {
  assert.deepEqual(createReviewObjective({ ...base, blockingSeverities: ['p1', 'P2'] }).blockingSeverities, ['P1', 'P2']);
});

test('Reviewer instructions state the same blocking rule as the objective', () => {
  const blocking = reviewerInstructionsText(createReviewObjective({ ...base }));
  assert.match(blocking, /P1, P2 and P3 ALL block/);
  assert.match(blocking, /concrete trigger and wrong result/);
  const legacy = reviewerInstructionsText(createReviewObjective({ ...base, taskType: 'design' }));
  assert.match(legacy, /P1\/P2 block the CURRENT review scope\. P3 does not\./);
});
