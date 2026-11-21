// P2 (RL-REVIEW-RELIABILITY): pre-dispatch input budget.
// Pure/unit level; no model, no network. The only process spawned is the local
// argv probe, and only through an injected fake here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UNVERIFIED_INPUT_LIMIT, InputBudgetError, assertPromptWithinBudget, estimateInputTokens, measurePrompt,
  probeArgvEnvelope, resolveInputBudget, utf8Bytes,
} from '../src/reviewloop/inputBudget.js';
// ---- budget -------------------------------------------------------------------------

test('resolveInputBudget takes the strictest bound; the token bound uses 80% of the sentinel and 3 bytes/token', () => {
  const local = { value: 500_000, source: 'MEASURED_LOCAL' };
  const b = resolveInputBudget({ maxSingleCallUsage: 40_000, localEnvelope: local });
  assert.equal(b.limitBytes, Math.floor(0.8 * 40_000) * 3);
  assert.equal(b.source, 'TOKEN_BUDGET');
  const t = resolveInputBudget({ maxSingleCallUsage: 400_000, localEnvelope: local });
  assert.equal(t.limitBytes, 500_000);
  assert.equal(t.source, 'TRANSPORT_MEASURED_LOCAL');
  const strictChain = resolveInputBudget({
    maxSingleCallUsage: 400_000, localEnvelope: local,
    candidateLimits: [{ family: 'agy:opus', value: 300_000, source: 'MEASURED_LOCAL' }, { family: 'codex:default', value: 90_000, source: 'DEFAULT_UNVERIFIED' }],
  });
  assert.equal(strictChain.limitBytes, 90_000, 'the tightest candidate on the failover chain wins');
  assert.match(strictChain.source, /DEFAULT_UNVERIFIED:codex:default/);
  const noProbe = resolveInputBudget({ maxSingleCallUsage: null });
  assert.equal(noProbe.limitBytes, DEFAULT_UNVERIFIED_INPUT_LIMIT, 'no measurement => the conservative, labelled-unverified default');
  assert.equal(noProbe.source, 'TRANSPORT_DEFAULT_UNVERIFIED');
});

test('the token estimate is conservative for CJK text (3 bytes/char => 1 token/char, never less than the 4-chars estimate)', () => {
  const cjk = '设计'.repeat(1000);
  assert.equal(estimateInputTokens(utf8Bytes(cjk)), 2000);
  assert.ok(estimateInputTokens(utf8Bytes(cjk)) > Math.round(cjk.length / 4));
});

test('assertPromptWithinBudget never trims and reports component sizes and the overflowing side', () => {
  const prompt = 'I'.repeat(100) + 'P'.repeat(1000) + 'D'.repeat(2000) + 'F'.repeat(500);
  const comps = { plan: 1000, design: 2000, files: 500 };
  assert.equal(assertPromptWithinBudget(prompt, comps, { limitBytes: 4000, source: 'T' }).bytes, 3600);
  let caught;
  try { assertPromptWithinBudget(prompt, comps, { limitBytes: 3000, source: 'T' }); } catch (e) { caught = e; }
  assert.ok(caught instanceof InputBudgetError);
  assert.equal(caught.code, 'INPUT_TOO_LARGE');
  assert.deepEqual(caught.detail.components, { plan: 1000, design: 2000, files: 500, instructions: 100 });
  assert.equal(caught.detail.overflowCause, 'FIXED_MATERIAL');
  try { assertPromptWithinBudget(prompt, { plan: 100, design: 100, files: 3000 }, { limitBytes: 3000, source: 'T' }); } catch (e) { caught = e; }
  assert.equal(caught.detail.overflowCause, 'EVIDENCE');
  assert.equal(measurePrompt('x'.repeat(30), {}).estimatedTokens, 10);
});

test('argv probe: halves the largest accepted size; a failing probe falls back to the labelled default', () => {
  const maxAccepted = 600_000;
  const fake = (_exe, args) => ({ status: args[2].length <= maxAccepted ? 0 : null, error: args[2].length <= maxAccepted ? undefined : Object.assign(new Error('E2BIG'), { code: 'E2BIG' }) });
  const ok = probeArgvEnvelope({ spawnFn: fake, force: true });
  assert.equal(ok.source, 'MEASURED_LOCAL');
  assert.ok(ok.value <= maxAccepted / 2 && ok.value > (maxAccepted - 40_000) / 2, String(ok.value));
  const bad = probeArgvEnvelope({ spawnFn: () => ({ status: 1, error: new Error('boom') }), force: true });
  assert.deepEqual([bad.source, bad.value], ['DEFAULT_UNVERIFIED', DEFAULT_UNVERIFIED_INPUT_LIMIT]);
  probeArgvEnvelope({ force: true });
});
