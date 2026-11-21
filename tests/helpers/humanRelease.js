// Test stand-in for the human step that releases a HUMAN_REQUIRED hard stop: the
// Worker's call is refused read-only (it carries the submission digest), then the
// user authorizes a re-review of exactly that submission.
import assert from 'node:assert/strict';
import { authorizeRereview } from '../../src/reviewloop/rereviewAuthorization.js';

export async function releaseHardStop({ controller, persistence, loopId, reason = 'test: the user authorizes this re-review' }) {
  const refused = await controller.review({ loopId });
  assert.equal(refused.status, 'HUMAN_REQUIRED');
  assert.equal(refused.hardStop, true, `expected a read-only hard-stop refusal, got ${JSON.stringify({ s: refused.status, r: refused.reason })}`);
  await authorizeRereview({ persistence, loopId, submission: refused.submissionDigest, reason });
  return refused;
}
