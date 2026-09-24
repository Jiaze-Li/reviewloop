import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGY_REVIEW_TIMEOUT_ENV,
  DEFAULT_AGY_REVIEW_TIMEOUT_MS,
  MAX_AGY_REVIEW_TIMEOUT_MS,
  createReviewLoopProviderPool,
  resolveAgyReviewTimeoutMs,
} from '../src/reviewloop/providerWiring.js';

test('resolveAgyReviewTimeoutMs: 240s default, env override, hard cap', () => {
  assert.equal(resolveAgyReviewTimeoutMs({}), DEFAULT_AGY_REVIEW_TIMEOUT_MS);
  assert.equal(DEFAULT_AGY_REVIEW_TIMEOUT_MS, 240_000);

  assert.equal(
    resolveAgyReviewTimeoutMs({ [AGY_REVIEW_TIMEOUT_ENV]: '180000' }),
    180_000,
  );

  assert.equal(
    resolveAgyReviewTimeoutMs({ [AGY_REVIEW_TIMEOUT_ENV]: '999999999' }),
    MAX_AGY_REVIEW_TIMEOUT_MS,
  );

  assert.equal(
    resolveAgyReviewTimeoutMs({ [AGY_REVIEW_TIMEOUT_ENV]: 'nonsense' }),
    DEFAULT_AGY_REVIEW_TIMEOUT_MS,
  );
});

test('ReviewLoop AGY transport passes the resolved review timeout to callAgy', async () => {
  let captured = null;
  const pool = createReviewLoopProviderPool({
    env: { [AGY_REVIEW_TIMEOUT_ENV]: '210000' },
    callAgy: async (options) => {
      captured = options;
      return {
        model: 'claude-opus-4-6-thinking',
        exitCode: 0,
        text: '{"findings":[]}',
        json: null,
        stdout: '',
        durationMs: 1,
        conversationId: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });

  const selected = pool.route('reviewer');
  assert.equal(selected.family, 'agy:opus');

  const out = await selected.transport('REVIEW');
  assert.equal(out.text, '{"findings":[]}');
  assert.equal(captured.timeoutMs, 210_000);
});
