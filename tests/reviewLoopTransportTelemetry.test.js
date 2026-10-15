// Stage 2 — the durable spend telemetry keeps the provider's raw usage
// breakdown plus mechanical payload metadata, so transport context tax
// ("diff 20k chars, yet input 120k tokens") is diagnosable after the fact.
// Only lengths + machine metadata are stored — never prompt text.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewLoopSpend,
  usageBreakdownOf,
  payloadMetaOf,
  contextOverheadTokens,
} from '../src/reviewloop/reviewSpend.js';
import { createReviewLoopProviderPool, narrowReviewTransportCwd, buildReviewerInvoke } from '../src/reviewloop/providerWiring.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('usageBreakdownOf keeps every field null when unreported (UNKNOWN != 0)', () => {
  assert.deepEqual(usageBreakdownOf(null), {
    inputTokens: null, outputTokens: null, thinkingTokens: null,
    cacheReadTokens: null, cacheCreationTokens: null,
    reportedTotalTokens: null, rawFieldSumTokens: null,
  });
  const b = usageBreakdownOf({ input_tokens: 120000, output_tokens: 1778, cache_read_input_tokens: 10 });
  assert.equal(b.inputTokens, 120000);
  assert.equal(b.outputTokens, 1778);
  assert.equal(b.cacheReadTokens, 10);
  assert.equal(b.thinkingTokens, null);
  // no provider-reported total in this envelope -> reportedTotalTokens stays
  // null; rawFieldSumTokens is a diagnostic arithmetic sum, never a provider figure
  assert.equal(b.reportedTotalTokens, null);
  assert.equal(b.rawFieldSumTokens, 121788);
});

test('contextOverheadTokens surfaces the transport tax; null when either side unknown', () => {
  const b = usageBreakdownOf({ input_tokens: 121052, output_tokens: 1778 });
  const p = payloadMetaOf({ promptChars: 20000, diffChars: 18000 });
  assert.equal(p.estimatedPayloadTokens, 5000);
  assert.equal(contextOverheadTokens(b, p), 116052);
  assert.equal(contextOverheadTokens(usageBreakdownOf(null), p), null);
  assert.equal(contextOverheadTokens(b, null), null);
});

test('the durable spend record carries the breakdown + payloadMeta + resolved model', async () => {
  const persistence = new MemoryPersistence();
  // This case deliberately exercises a high transport-tax envelope; the
  // single-call Token Sentinel is covered separately, so lift its ceilings here.
  const spend = createReviewLoopSpend({
    loopId: 'L',
    persistence,
    env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '250000', REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS: '200000' },
  });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });
  await spend.meteredCall({
    role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy-claude-gpt', operationId: 'op', attempt: 1,
    evidenceIds: [ev.evidenceId],
    call: async () => ({
      value: { findings: [] },
      usage: { input_tokens: 121052, output_tokens: 1778 },
      model: 'gpt-oss-120b-medium',
      meta: { promptChars: 20000, diffChars: 18000, reviewPayloadChars: 20000 },
    }),
  });
  const state = await persistence.readWorkflowState('L');
  const rec = state.reviewLoopSpend.records.at(-1);
  assert.equal(rec.model, 'gpt-oss-120b-medium');
  assert.equal(rec.family, 'agy:gpt-oss');
  assert.equal(rec.provider, 'agy-claude-gpt');
  assert.equal(rec.usageBreakdown.inputTokens, 121052);
  assert.equal(rec.payloadMeta.diffChars, 18000);
  assert.equal(rec.payloadMeta.estimatedPayloadTokens, 5000);
  assert.equal(rec.contextOverheadTokens, 116052);
  // never persist prompt text
  assert.equal(JSON.stringify(rec).includes('prompt'), true); // only the *Chars keys
  assert.ok(!('promptText' in rec.payloadMeta));

  const t = await spend.telemetry();
  assert.equal(t.usageBreakdown.inputTokens, 121052);
  assert.equal(t.usageBreakdown.thinkingTokensUnknown, 1);
  assert.equal(t.usageBreakdown.contextOverheadTokens, 116052);
  assert.equal(t.usageBreakdown.diffChars, 18000);
});

test('the narrow agy transport runs from an isolated empty scratch cwd', async () => {
  const seen = [];
  const pool = createReviewLoopProviderPool({
    callAgy: async (opts) => { seen.push(opts); return { text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const sel = pool.route('reviewer');
  await sel.transport('REVIEW PROMPT');
  assert.equal(seen[0].cwd, narrowReviewTransportCwd());
  assert.notEqual(seen[0].cwd, process.cwd());
  assert.equal(seen[0].disableSlashCommands, true);
  assert.equal(seen[0].conversationId, undefined, 'no conversation continuation');
});

test('reviewer payloadMeta records prompt component breakdown and sha256 without prompt text', async () => {
  const reviewerInvoke = buildReviewerInvoke();
  let capturedMeta = null;
  const res = await reviewerInvoke({
    objective: {
      goal: 'Short goal statement.',
      contractText: 'Frozen specification text.',
      constraints: ['Constraint 1'],
    },
    diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n',
    changedFiles: ['a.txt'],
    gate: { verdict: 'PASS' },
    transport: async () => ({
      text: '{"findings":[]}',
      usage: { input_tokens: 100, output_tokens: 10 },
      model: 'test-model',
    }),
  });
  capturedMeta = res.meta;
  assert.ok(capturedMeta.promptComponentStats);
  assert.ok(Number.isFinite(capturedMeta.promptComponentStats.goalChars));
  assert.ok(Number.isFinite(capturedMeta.promptComponentStats.contractChars));
  assert.equal(typeof capturedMeta.promptComponentStats.contractSha256, 'string');
  assert.equal(capturedMeta.promptComponentStats.contractSha256.length, 64);
  assert.ok(Number.isFinite(capturedMeta.promptComponentStats.diffChars));
  assert.ok(Number.isFinite(capturedMeta.promptComponentStats.changedFilesChars));
  assert.equal(capturedMeta.promptComponentStats.changedFilesCount, 1);
  // Ensure no sensitive prompt text is persisted in metadata
  assert.ok(!('promptText' in capturedMeta));
  assert.ok(!('contractText' in capturedMeta.promptComponentStats));
});

