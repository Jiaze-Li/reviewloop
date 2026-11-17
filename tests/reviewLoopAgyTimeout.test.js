import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  REVIEW_CALL_TIMEOUT_ENV,
  DEFAULT_REVIEW_CALL_TIMEOUT_MS,
  MAX_REVIEW_CALL_TIMEOUT_MS,
  createReviewLoopProviderPool,
  resolveReviewCallTimeoutMs,
} from '../src/reviewloop/providerWiring.js';
import { ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';

function hangingCliSpawn() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('resolveReviewCallTimeoutMs: 240s default, env override, hard cap', () => {
  assert.equal(resolveReviewCallTimeoutMs({}), DEFAULT_REVIEW_CALL_TIMEOUT_MS);
  assert.equal(DEFAULT_REVIEW_CALL_TIMEOUT_MS, 240_000);

  assert.equal(
    resolveReviewCallTimeoutMs({ [REVIEW_CALL_TIMEOUT_ENV]: '180000' }),
    180_000,
  );

  assert.equal(
    resolveReviewCallTimeoutMs({ [REVIEW_CALL_TIMEOUT_ENV]: '999999999' }),
    MAX_REVIEW_CALL_TIMEOUT_MS,
  );

  assert.equal(
    resolveReviewCallTimeoutMs({ [REVIEW_CALL_TIMEOUT_ENV]: 'nonsense' }),
    DEFAULT_REVIEW_CALL_TIMEOUT_MS,
  );
});

test('ReviewLoop AGY transport passes the unified review timeout to callAgy', async () => {
  let captured = null;
  const pool = createReviewLoopProviderPool({
    env: { [REVIEW_CALL_TIMEOUT_ENV]: '210000' },
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

test('Codex and Claude CLI transports enforce the same unified REVIEW_CALL_TIMEOUT_MS', async () => {
  const spawn = hangingCliSpawn();
  const providerHealth = new ProviderHealthRegistry();
  for (const f of ['agy:opus', 'agy:gemini-reviewer', 'agy:sonnet', 'agy:gpt-oss']) {
    providerHealth.record(f, 'UNAVAILABLE', 'test skip');
  }
  const pool = createReviewLoopProviderPool({
    env: { [REVIEW_CALL_TIMEOUT_ENV]: '25' },
    spawn,
    providerHealth,
    transportRuntime: {
      'codex:default': { available: true, reason: 'ok' },
      'claude:opus': { available: true, reason: 'ok' },
    },
  });

  const codexSel = pool.route('reviewer');
  assert.equal(codexSel.family, 'codex:default');
  await assert.rejects(() => codexSel.transport('REVIEW'), /exceeded 25ms/);

  providerHealth.record('codex:default', 'UNAVAILABLE', 'test skip');
  const claudeSel = pool.route('reviewer');
  assert.equal(claudeSel.family, 'claude:opus');
  await assert.rejects(() => claudeSel.transport('REVIEW'), /exceeded 25ms/);
});
