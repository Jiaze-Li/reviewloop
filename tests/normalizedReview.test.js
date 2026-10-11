import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NORMALIZED_REVIEW_STATUS,
  blockingSignatures,
  normalizeProviderReview,
  normalizeReviewFinding,
} from '../src/orchestrator/adapters/normalizedReview.js';

test('P1/P2 findings are blocking and make the review ACTIONABLE', () => {
  const review = normalizeProviderReview({
    raw: { findings: [{ severity: 'P2', file: 'a.js', title: 'Null deref' }, { severity: 'P3', title: 'nit' }] },
    reviewer: 'internal',
  });
  assert.equal(review.status, NORMALIZED_REVIEW_STATUS.ACTIONABLE);
  assert.equal(review.blocking.length, 1);
  assert.equal(review.provider, 'internal');
  assert.deepEqual(blockingSignatures(review), ['P2:a.js:null deref']);
});

test('only non-blocking findings normalize to CLEAN', () => {
  const review = normalizeProviderReview({ raw: { findings: [{ severity: 'nit', title: 'rename' }] } });
  assert.equal(review.status, NORMALIZED_REVIEW_STATUS.CLEAN);
});

test('missing findings channel, failure marker and non-object payload fail closed', () => {
  assert.equal(normalizeProviderReview({ raw: {} }).error.reason, 'NO_FINDINGS_CHANNEL');
  assert.equal(normalizeProviderReview({ raw: { findings: [], ok: false } }).error.reason, 'PROVIDER_ERROR');
  assert.equal(normalizeProviderReview({ raw: [] }).error.reason, 'MALFORMED_PAYLOAD');
});

test('structurally empty findings are dropped; an explicit id fixes the signature', () => {
  assert.equal(normalizeReviewFinding({}), null);
  assert.equal(normalizeReviewFinding({ id: 'x1', severity: 'P1', title: 'a' }).signature, 'id:x1');
});
