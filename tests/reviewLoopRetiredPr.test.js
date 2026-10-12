import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { isResumable, needsReopen, unfinishedLoopsFor, buildResumePrompt } from '../src/reviewloop/resumeGuide.js';
import { reopenExhaustedGate } from '../src/reviewloop/gateReopen.js';
import { acknowledgeUnresolvedSpend } from '../src/reviewloop/spendRecovery.js';

test('retired PR loops are excluded from fresh Worker resume and reopen discovery', () => {
  const pr = { loopId: 'old-pr', state: 'REWORK', objective: { mode: 'PR', repository: { root: '/r' } } };
  const exhausted = { ...pr, state: 'HUMAN_REQUIRED', budgetExhausted: true };
  assert.equal(isResumable(pr), false);
  assert.equal(needsReopen(exhausted), false);
  assert.deepEqual(unfinishedLoopsFor([pr, exhausted], '/r'), []);
  assert.throws(() => buildResumePrompt(pr), /PR session retired/);
});

test('manual gate reopening and model-spend acknowledgement cannot modify retired PR state', async () => {
  const persistence = new MemoryPersistence();
  const saved = { reviewLoop: {
    loopId: 'old-pr', state: 'HUMAN_REQUIRED', budgetExhausted: true,
    objective: { mode: 'PR', repository: { root: '/r' } },
  } };
  await persistence.writeWorkflowState('old-pr', saved);
  await assert.rejects(
    () => reopenExhaustedGate({ persistence, loopId: 'old-pr', reason: 'retry' }),
    /PR session retired/,
  );
  await assert.rejects(
    () => acknowledgeUnresolvedSpend({ persistence, loopId: 'old-pr', reservationId: 'r1', reason: 'retry' }),
    /PR session retired/,
  );
  assert.deepEqual(await persistence.readWorkflowState('old-pr'), saved);
});
