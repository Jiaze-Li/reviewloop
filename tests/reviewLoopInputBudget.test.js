// P2 (RL-REVIEW-RELIABILITY): pre-dispatch input budget + dense receipts.
// Pure/unit level; no model, no network. The only process spawned is the local
// argv probe, and only through an injected fake here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UNVERIFIED_INPUT_LIMIT, InputBudgetError, assertPromptWithinBudget, estimateInputTokens, measurePrompt,
  probeArgvEnvelope, resolveInputBudget, utf8Bytes,
} from '../src/reviewloop/inputBudget.js';
import {
  RECEIPT_INTERVAL_BYTES, newReceiptSession, unwrapReceipts, verifyReceipts, wrapWithReceipts,
} from '../src/reviewloop/receipts.js';

const lines = (n, w = 60) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(w)}`).join('\n');

// ---- receipts ---------------------------------------------------------------------

test('wrap/unwrap restores every block byte-for-byte (empty, no trailing newline, trailing newline, multibyte)', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', lines(300), `${lines(300)}\n`, '中文设计\n'.repeat(900), 'x\r\ny\r\n'.repeat(2000), '\n\n\n']) {
    const session = newReceiptSession('salt');
    const wrapped = wrapWithReceipts(text, session);
    assert.equal(unwrapReceipts(wrapped, session.blocks[0]), text, JSON.stringify(text.slice(0, 20)));
    assert.ok(session.expected.length >= 1, 'every block ends with a receipt');
  }
});

test('receipts are dense: the gap between two receipts never exceeds one interval plus one line', () => {
  const session = newReceiptSession('salt');
  const text = lines(2000, 100);
  const wrapped = wrapWithReceipts(text, session);
  const parts = wrapped.split(/⟦RL:\d+:[0-9a-f]{8}⟧\n/);
  const longestLine = Math.max(...text.split('\n').map((l) => utf8Bytes(`${l}\n`)));
  for (const p of parts) assert.ok(utf8Bytes(p) < RECEIPT_INTERVAL_BYTES + longestLine, `gap ${utf8Bytes(p)}`);
  assert.ok(session.expected.length >= Math.floor(utf8Bytes(text) / (RECEIPT_INTERVAL_BYTES + longestLine)));
});

test('receipt values depend on the per-call salt; the numbering is global across blocks', () => {
  const a = newReceiptSession('salt-a');
  const b = newReceiptSession('salt-b');
  wrapWithReceipts('one\n', a); wrapWithReceipts('two\n', a);
  wrapWithReceipts('one\n', b); wrapWithReceipts('two\n', b);
  assert.equal(a.expected.length, 2);
  assert.match(a.expected[1], /^⟦RL:2:/);
  assert.notEqual(a.expected[0], b.expected[0]);
  assert.notEqual(newReceiptSession().salt, newReceiptSession().salt);
});

test('verifyReceipts: complete is OK; tail loss, middle loss, reorder, wrong value, extra and missing field are all refused', () => {
  const session = newReceiptSession('salt');
  wrapWithReceipts(lines(400, 100), session);
  const exp = session.expected;
  assert.ok(exp.length >= 5);
  assert.equal(verifyReceipts([...exp], exp).ok, true);
  assert.deepEqual(
    [verifyReceipts(exp.slice(0, -1), exp), verifyReceipts([...exp.slice(0, 2), ...exp.slice(3)], exp),
      verifyReceipts([exp[1], exp[0], ...exp.slice(2)], exp), verifyReceipts([...exp.slice(0, -1), '⟦RL:9:00000000⟧'], exp),
      verifyReceipts([...exp, '⟦RL:99:00000000⟧'], exp), verifyReceipts(undefined, exp)].map((r) => r.class),
    ['MISSING', 'ORDER_OR_VALUE', 'ORDER_OR_VALUE', 'ORDER_OR_VALUE', 'EXTRA', 'MISSING_FIELD'],
  );
  assert.equal(verifyReceipts(exp.slice(0, -1), exp).firstMissingIndex, exp.length - 1);
});

test('the bound is stated honestly: a loss containing NO receipt line is NOT detected, and is shorter than one interval + one line', () => {
  const session = newReceiptSession('salt');
  const text = lines(600, 100);
  const wrapped = wrapWithReceipts(text, session);
  // Remove a stretch of lines that lies strictly between two receipt lines.
  const arr = wrapped.split('\n');
  const receiptIdx = arr.map((l, i) => (/^⟦RL:/.test(l) ? i : -1)).filter((i) => i >= 0);
  const from = receiptIdx[0] + 1;
  const to = receiptIdx[1]; // exclusive
  const removed = arr.slice(from + 1, to - 1);
  assert.ok(removed.length > 0);
  const remaining = [...arr.slice(0, from + 1), ...arr.slice(to - 1)];
  const echoed = remaining.filter((l) => /^⟦RL:/.test(l));
  assert.equal(verifyReceipts(echoed, session.expected).ok, true, 'a receipt-free loss is not detectable (documented limit)');
  const lostBytes = utf8Bytes(`${removed.join('\n')}\n`);
  assert.ok(lostBytes < RECEIPT_INTERVAL_BYTES + utf8Bytes(`${arr[from]}\n`), 'and it is strictly bounded by the interval');
  // Whereas a loss spanning a receipt line IS detected.
  const spanning = [...arr.slice(0, from), ...arr.slice(to + 2)];
  assert.equal(verifyReceipts(spanning.filter((l) => /^⟦RL:/.test(l)), session.expected).ok, false);
});

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
