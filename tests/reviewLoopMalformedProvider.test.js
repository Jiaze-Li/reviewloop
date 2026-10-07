// B1 — malformed / unparseable / schema-invalid Reviewer or Supervisor output
// must fail closed (never CLEAN, never a silent empty findings list, never
// valid REWORK guidance).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { normalizeReview } from '../src/reviewloop/reviewPolicy.js';
import {
  validateReviewerPayload,
  validateSupervisorPayload,
} from '../src/reviewloop/providerWiring.js';

function harnessWithRawReview(raw) {
  return makeHarness({
    reviews: [raw], // passed straight through as reviewerFn value
  });
}

test('validateReviewerPayload rejects non-object / missing findings / bad severity', () => {
  assert.equal(validateReviewerPayload(null).malformed, true);
  assert.equal(validateReviewerPayload('nope').malformed, true);
  assert.equal(validateReviewerPayload({}).malformed, true);
  assert.equal(validateReviewerPayload({ findings: 'x' }).malformed, true);
  assert.equal(validateReviewerPayload({ findings: [{ severity: 'BOGUS', title: 't' }] }).malformed, true);
  assert.equal(validateReviewerPayload({ findings: [{ severity: 'P1' }] }).malformed, true);
  assert.deepEqual(validateReviewerPayload({ findings: [] }), { findings: [] });
});

test('normalizeReview turns a malformed marker into FAILED (never CLEAN)', () => {
  const r = normalizeReview({ raw: { malformed: true, reason: 'invalid JSON' }, reviewer: 'internal', provider: 'internal' });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.blockingFindings.length, 0);
});

test('Reviewer invalid JSON -> never PASS', async () => {
  const { controller } = harnessWithRawReview({ malformed: true, reason: 'unparseable' });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const res = await controller.review({ loopId });
  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.notEqual(res.status, 'PASS');
});

test('Reviewer missing findings channel -> never PASS', async () => {
  const { controller } = harnessWithRawReview({ notFindings: [] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const res = await controller.review({ loopId });
  assert.equal(res.status, 'HUMAN_REQUIRED');
});

test('Reviewer schema-invalid finding -> never PASS', async () => {
  // findings present but severity is not P1/P2/P3 — normalizeProviderReview
  // must not silently drop it into a CLEAN result.
  const { controller } = makeHarness({
    reviews: [{ malformed: true, reason: 'a finding has an invalid severity' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const res = await controller.review({ loopId });
  assert.equal(res.status, 'HUMAN_REQUIRED');
});

test('Supervisor invalid JSON -> fail closed / HUMAN_REQUIRED', () => {
  assert.equal(validateSupervisorPayload(null).malformed, true);
  assert.equal(validateSupervisorPayload({ guidance: 'do x' }).malformed, true); // missing recommendation
  assert.equal(validateSupervisorPayload({ recommendation: 'REWORK' }).malformed, true); // missing guidance
  assert.deepEqual(
    validateSupervisorPayload({ guidance: 'do x', recommendation: 'rework' }),
    { guidance: 'do x', recommendation: 'REWORK' },
  );
});

test('malformed Supervisor output is not treated as valid REWORK guidance, and does not stall the loop', async () => {
  const { controller, persistence, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'a', changedFiles: ['a.js'] },
      { fingerprint: 'd2', diff: 'b', changedFiles: ['a.js'] },
      { fingerprint: 'd3', diff: 'c', changedFiles: ['a.js'] },
    ],
    reviews: [
      { findings: [finding('P1', 'a.js', 'same bug')] },
      { findings: [finding('P1', 'a.js', 'same bug')] },
      { findings: [finding('P1', 'a.js', 'same bug')] },
    ],
    supervisorReplies: [{ malformed: true, reason: 'not JSON' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await controller.review({ loopId }); // round 1 REWORK
  // round 2 -> Supervisor -> malformed: a TRANSIENT failure, never valid guidance,
  // but it degrades to a plain REWORK round rather than terminating the loop.
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK');
  assert.equal(r2.supervisorGuidance ?? null, null);
  assert.ok((r2.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE'));
  const afterMalformed = await persistence.readWorkflowState(loopId);
  assert.equal(afterMalformed.reviewLoop.convergenceEpoch, 0, 'unusable Supervisor output itself creates no strategy epoch');
  assert.equal(afterMalformed.reviewLoop.supervisorInvoked, false);

  // At the old round-3 boundary ReviewLoop retries Supervisor rather than
  // handing the problem to a human merely because three reviews elapsed. The
  // harness then supplies its default valid REWORK guidance, which legitimately
  // opens the first supervised epoch.
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'REWORK');
  assert.notEqual(r3.terminal, true);
  assert.equal(calls.supervisor, 2);
  assert.equal(r3.convergenceEpoch, 1);
});
