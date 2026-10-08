// Reviewer quota exhaustion: proven zero-consumption rejections auto-fail over
// and cool the shared quota pool (surviving restarts); unknown usage still
// fails closed; human recovery can exclude a known-bad family/pool so the
// recovered retry never re-calls it. No real provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgyExitError } from '../src/agy/agyClient.js';
import { classifyAgyQuotaRejection } from '../src/agy/agyQuotaClassifier.js';
import { QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { acknowledgeUnresolvedSpend, resolveRoutingExclusions } from '../src/reviewloop/spendRecovery.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const QUOTA_STDERR = 'RESOURCE_EXHAUSTED (code 429): You have exhausted your quota for this model. Quota resets in 4h 3m.';
const quotaExit = (over = {}) => new AgyExitError(1, over.stderr ?? QUOTA_STDERR, { stdout: over.stdout ?? '', durationMs: over.durationMs ?? 3000 });
const unknownExit = () => new AgyExitError(1, '', { stdout: '', durationMs: 4000 });

const RUNTIME_DOWN = {
  'codex:default': { available: false, reason: 'test' },
  'claude:opus': { available: false, reason: 'test' },
};

function makeWorld({ agyBehavior, quotaRegistry = new QuotaPoolRegistry({ filePath: null }), persistence = new MemoryPersistence() }) {
  const agyCalls = [];
  const callAgy = async (opts) => {
    // Family is recoverable from the model the pool bound; use call order + model.
    agyCalls.push(opts.model ?? '(default)');
    return agyBehavior(agyCalls.length, opts);
  };
  const pool = createReviewLoopProviderPool({
    callAgy,
    quotaRegistry,
    provisionMinimalAgent: () => ({ name: 'reviewloop-minimal', path: '/tmp/reviewloop-minimal.md' }),
    agyGeminiDir: '/tmp/reviewloop-test-gemini',
    customAgentSupport: null,
    transportRuntime: RUNTIME_DOWN,
  });
  const families = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: pool.route.bind(null, 'reviewer'),
    recordProviderFailure: pool.recordFailure,
    sleepFn: async () => {},
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      const res = await selection.transport('review this');
      return { value: { findings: [] }, usage: res.usage ?? { input_tokens: 10, output_tokens: 5 }, model: selection.model ?? 'm' };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  return { controller, persistence, pool, quotaRegistry, families, agyCalls };
}

const okReply = { text: '{"findings":[]}', json: {}, usage: { input_tokens: 10, output_tokens: 5 }, model: 'm' };

// ---- classifier ------------------------------------------------------------

test('classifier: a canonical quota rejection with empty stdout + absent usage is proven', () => {
  const v = classifyAgyQuotaRejection(quotaExit());
  assert.equal(v.proven, true);
  assert.equal(v.retryAfterMs, (4 * 3600 + 3 * 60) * 1000);
});

test('classifier: non-zero exit, short duration, bare RESOURCE_EXHAUSTED, usage, stdout or mid-stream are NOT proof', () => {
  assert.equal(classifyAgyQuotaRejection(unknownExit()).proven, false, 'non-zero exit + short duration alone');
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: 'RESOURCE_EXHAUSTED: message larger than max' })).proven, false, 'gRPC size limit is not quota');
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: `${QUOTA_STDERR}\ninput_tokens: 5` })).proven, false, 'usage evidence');
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stdout: '{"result":"partial"}' })).proven, false, 'stdout produced');
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: `stream interrupted: ${QUOTA_STDERR}` })).proven, false, 'mid-stream wording');
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: '429 rate limit, retry later' })).proven, false, 'plain rate limit is not quota');
  assert.equal(classifyAgyQuotaRejection(Object.assign(new Error('x'), { code: 'AGY_TIMEOUT' })).proven, false);
});

test('classifier: millisecond hints are not misread as minutes', () => {
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: 'quota exhausted, retry after 60ms' })).retryAfterMs, 60);
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: 'quota exhausted, retry after 500 milliseconds' })).retryAfterMs, 500);
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: 'quota exhausted, retry after 90s' })).retryAfterMs, 90_000);
  assert.equal(classifyAgyQuotaRejection(quotaExit({ stderr: 'quota exhausted, resets in 2h 30m' })).retryAfterMs, 9_000_000);
});

// ---- automatic failover on proven zero-consumption quota rejection ---------

test('proven quota rejection: settles zero, cools the shared pool, auto-switches to Gemini', async () => {
  const w = makeWorld({
    agyBehavior: async (n) => { if (n === 1) throw quotaExit(); return okReply; },
  });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  const r = await w.controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(w.families, ['agy:opus', 'agy:gemini-reviewer']);

  const state = await w.persistence.readWorkflowState(loopId);
  const resv = Object.values(state.modelSpendReservations).sort((a, b) => a.physicalAttempt - b.physicalAttempt);
  assert.equal(resv[0].status, 'SETTLED_KNOWN');
  assert.equal(resv[0].settlementReason, 'PROVEN_QUOTA_REJECTED_ZERO');
  const rec = state.reviewLoopSpend.records.find((x) => x.failureCode === 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(rec.zeroProof, 'AGY_QUOTA_REJECTION');
  assert.equal(rec.usageKnown, true);

  const pool = w.quotaRegistry.get('agy-claude-gpt');
  assert.equal(pool.status, 'COOLDOWN');
  assert.equal(pool.source, 'provider_error');
  assert.ok(Date.parse(pool.resetAt) - Date.now() > 4 * 3600 * 1000 - 60_000, 'parsed reset hint is honoured');
});

test('quota pool is shared: opus cooldown removes sonnet and gpt-oss from Reviewer routing', async () => {
  const w = makeWorld({ agyBehavior: async () => { throw quotaExit(); } });
  w.quotaRegistry.recordProviderFailure('agy:opus', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  const picked = w.pool.route('reviewer');
  assert.equal(picked.family, 'agy:gemini-reviewer');
  const exclude = ['agy:gemini-reviewer', 'codex:default', 'claude:opus'];
  assert.equal(w.pool.route('reviewer', { excludeFamilies: exclude }), null, 'sonnet + gpt-oss share the cooled pool');
});

test('cooldown survives an MCP restart and is visible across registries sharing the file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rl-quota-'));
  try {
    const file = path.join(dir, 'quota-pools.json');
    const a = new QuotaPoolRegistry({ filePath: file });
    a.recordProviderFailure('agy:opus', { code: 'PROVIDER_QUOTA_EXHAUSTED', retryAfter: 3_600_000 });
    const restarted = new QuotaPoolRegistry({ filePath: file });
    assert.equal(restarted.usable('agy:opus'), false);
    assert.equal(restarted.usable('agy:sonnet'), false);
    assert.equal(restarted.usable('agy:gemini-reviewer'), true);
    // A later cooldown written by another process is picked up without restart.
    const b = new QuotaPoolRegistry({ filePath: file });
    b.recordProviderFailure('agy:gemini-reviewer', { code: 'PROVIDER_QUOTA_EXHAUSTED', retryAfter: 60_000 });
    assert.equal(restarted.usable('agy:gemini-reviewer'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent registries on one file merge cooldowns instead of dropping one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rl-quota-'));
  try {
    const file = path.join(dir, 'quota-pools.json');
    const a = new QuotaPoolRegistry({ filePath: file });
    const b = new QuotaPoolRegistry({ filePath: file });
    a.recordProviderFailure('agy:opus', { code: 'PROVIDER_QUOTA_EXHAUSTED', retryAfter: 3_600_000 });
    // b holds a stale (empty) snapshot taken before a's write.
    b.pools = {}; b._loadedMtimeMs = Date.now() + 1e9;
    b.recordProviderFailure('agy:gemini-reviewer', { code: 'PROVIDER_QUOTA_EXHAUSTED', retryAfter: 3_600_000 });
    const fresh = new QuotaPoolRegistry({ filePath: file });
    assert.equal(fresh.usable('agy:opus'), false, 'a\'s cooldown survived b\'s write');
    assert.equal(fresh.usable('agy:gemini-reviewer'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- unknown usage stays fail-closed --------------------------------------

test('unknown-usage AGY exit does NOT auto-switch: UNRESOLVED, one call, diagnostics preserved', async () => {
  const w = makeWorld({ agyBehavior: async () => { throw unknownExit(); } });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  const r = await w.controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.deepEqual(w.families, ['agy:opus']);
  const state = await w.persistence.readWorkflowState(loopId);
  const [resv] = Object.values(state.modelSpendReservations);
  assert.equal(resv.status, 'UNRESOLVED');
  assert.equal(resv.failureDiagnostics.code, 'AGY_NONZERO_EXIT');
  assert.equal(resv.failureDiagnostics.stdoutWasEmpty, true);
  assert.equal(w.quotaRegistry.get('agy-claude-gpt').status, 'UNKNOWN', 'no cooldown inferred from unknown usage');
});

test('quota wording WITH usage evidence is unknown spend: no auto-switch', async () => {
  const w = makeWorld({ agyBehavior: async () => { throw quotaExit({ stderr: `${QUOTA_STDERR}\n{"usage":{"input_tokens":9}}` }); } });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  await w.controller.review({ loopId });
  assert.deepEqual(w.families, ['agy:opus']);
  const state = await w.persistence.readWorkflowState(loopId);
  assert.equal(Object.values(state.modelSpendReservations)[0].status, 'UNRESOLVED');
});

test('a CLI-transport PROVIDER_QUOTA_EXHAUSTED without AGY zero-proof is not treated as zero spend', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'cli-quota', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });
  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', family: 'codex:default', provider: 'codex', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { throw Object.assign(new Error('quota'), { code: 'PROVIDER_QUOTA_EXHAUSTED' }); },
  }));
  const state = await persistence.readWorkflowState('cli-quota');
  assert.equal(Object.values(state.modelSpendReservations)[0].status, 'UNRESOLVED');
});

// ---- human recovery: exclusions -------------------------------------------

test('resolveRoutingExclusions expands a pool to every sharing family and rejects unknown names', () => {
  const r = resolveRoutingExclusions({ pools: 'agy-claude-gpt', families: ['codex:default'] });
  assert.deepEqual(r.families, ['agy:gpt-oss', 'agy:opus', 'agy:sonnet', 'codex:default']);
  assert.throws(() => resolveRoutingExclusions({ families: 'agy:typo' }), /unknown family/);
  assert.throws(() => resolveRoutingExclusions({ pools: 'nope' }), /unknown quota pool/);
});

// Drives the historical shape: two consecutive UNRESOLVED opus calls, the first
// already acknowledged with its retry grant consumed, then recovery with an
// explicit pool exclusion switches to Gemini.
test('double UNRESOLVED + consumed first grant: ack with pool exclusion safely resumes on Gemini, across restart', async () => {
  const persistence = new MemoryPersistence();
  const behavior = async (_n, opts) => {
    if (String(opts.model ?? '').toLowerCase().includes('gemini') || w2Active) return okReply;
    throw unknownExit();
  };
  let w2Active = false;
  const w = makeWorld({ agyBehavior: behavior, persistence });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });

  await w.controller.review({ loopId });                       // opus attempt 1 -> UNRESOLVED
  let state = await persistence.readWorkflowState(loopId);
  const first = Object.values(state.modelSpendReservations)[0];
  await acknowledgeUnresolvedSpend({ persistence, loopId, reservationId: first.reservationId, reason: 'first ack, no exclusion' });

  await w.controller.review({ loopId });                       // opus again via one-shot grant -> UNRESOLVED #2
  assert.deepEqual(w.families, ['agy:opus', 'agy:opus']);
  state = await persistence.readWorkflowState(loopId);
  const all = Object.values(state.modelSpendReservations).sort((a, b) => a.physicalAttempt - b.physicalAttempt);
  assert.equal(all.length, 2);
  assert.ok(all[0].humanAcknowledgement.retryGrant.consumedAt, 'first grant consumed');
  assert.equal(all[1].status, 'UNRESOLVED');
  assert.equal(all[1].humanAcknowledgement, undefined);

  // Unacknowledged: further review is refused with zero provider calls.
  const callsBefore = w.agyCalls.length;
  await w.controller.review({ loopId });
  assert.equal(w.agyCalls.length, callsBefore, 'still blocked until acknowledged');

  await acknowledgeUnresolvedSpend({
    persistence, loopId, reservationId: all[1].reservationId, reason: 'opus quota exhausted', excludePools: ['agy-claude-gpt'],
  });

  // Restart: brand-new controller/pool/registry over the same durable state.
  w2Active = true;
  const w2 = makeWorld({ agyBehavior: async () => okReply, persistence });
  const r = await w2.controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(w2.families, ['agy:gemini-reviewer'], 'never re-calls the excluded pool');

  state = await persistence.readWorkflowState(loopId);
  const final = Object.values(state.modelSpendReservations).sort((a, b) => a.physicalAttempt - b.physicalAttempt);
  assert.equal(final.length, 3);
  assert.equal(final[0].status, 'UNRESOLVED');
  assert.equal(final[1].status, 'UNRESOLVED', 'history is never rewritten');
  assert.equal(final[2].family, 'agy:gemini-reviewer');
  assert.equal(final[2].humanRetrySourceReservationId, final[1].reservationId);
  assert.deepEqual(final[1].humanAcknowledgement.routingExclusions.families, ['agy:gpt-oss', 'agy:opus', 'agy:sonnet']);
  assert.equal(state.reviewLoopSpend.records.filter((x) => x.humanAcknowledgedUnresolved).length, 2);
  assert.equal(state.reviewLoopSpend.records.filter((x) => x.humanAcknowledgedUnresolved && x.usageKnown === false).length, 2, 'unknown-usage fact preserved');
});

test('the recovery grant is one-shot: if Gemini also ends UNRESOLVED, a new acknowledgement is required', async () => {
  const persistence = new MemoryPersistence();
  const w = makeWorld({ agyBehavior: async () => { throw unknownExit(); }, persistence });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  await w.controller.review({ loopId });
  let state = await persistence.readWorkflowState(loopId);
  const [first] = Object.values(state.modelSpendReservations);
  await acknowledgeUnresolvedSpend({ persistence, loopId, reservationId: first.reservationId, reason: 'r', excludePools: ['agy-claude-gpt'] });

  await w.controller.review({ loopId });
  assert.deepEqual(w.families, ['agy:opus', 'agy:gemini-reviewer']);
  const calls = w.agyCalls.length;
  await w.controller.review({ loopId });
  await w.controller.review({ loopId });
  assert.equal(w.agyCalls.length, calls, 'no further dispatch without a fresh acknowledgement');
  state = await persistence.readWorkflowState(loopId);
  assert.equal(Object.values(state.modelSpendReservations).filter((x) => x.status === 'UNRESOLVED').length, 2);
});

test('exclusions can be appended to an already-acknowledged reservation without reissuing the grant', async () => {
  const persistence = new MemoryPersistence();
  const w = makeWorld({ agyBehavior: async () => { throw unknownExit(); }, persistence });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  await w.controller.review({ loopId });
  const [first] = Object.values((await persistence.readWorkflowState(loopId)).modelSpendReservations);
  await acknowledgeUnresolvedSpend({ persistence, loopId, reservationId: first.reservationId, reason: 'r' });
  const res = await acknowledgeUnresolvedSpend({
    persistence, loopId, reservationId: first.reservationId, reason: 'add exclusion', excludeFamilies: ['agy:opus'],
  });
  assert.equal(res.alreadyAcknowledged, true);
  const state = await persistence.readWorkflowState(loopId);
  const src = state.modelSpendReservations[first.reservationId];
  assert.equal(src.humanAcknowledgement.retryGrant.consumedAt, null);
  assert.equal(src.humanAcknowledgement.routingExclusionAmendments.length, 1);
  assert.equal(state.reviewLoopSpend.records.length, 1, 'no duplicate accounting');
  const w2 = makeWorld({ agyBehavior: async () => okReply, persistence });
  await w2.controller.review({ loopId });
  assert.ok(w2.families.length >= 1);
  assert.ok(!w2.families.includes('agy:opus'));
});

test('authorization backstop: an excluded family can never be dispatched even if routed', async () => {
  const persistence = new MemoryPersistence();
  const w = makeWorld({ agyBehavior: async () => { throw unknownExit(); }, persistence });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  await w.controller.review({ loopId });
  const [first] = Object.values((await persistence.readWorkflowState(loopId)).modelSpendReservations);
  await acknowledgeUnresolvedSpend({ persistence, loopId, reservationId: first.reservationId, reason: 'r', excludeFamilies: ['agy:opus'] });
  const evidenceId = (await persistence.readWorkflowState(loopId)).modelSpendReservations[first.reservationId].humanAcknowledgement.evidenceId;
  const spend = createReviewLoopSpend({ loopId, persistence });
  let dispatched = 0;
  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', family: 'agy:opus', provider: 'agy-claude-gpt', operationId: first.taskId, attempt: 2,
    evidenceIds: [evidenceId],
    call: async () => { dispatched += 1; return { value: {}, usage: { input_tokens: 1, output_tokens: 1 } }; },
  }), (err) => err.code === 'FAMILY_EXCLUDED_BY_HUMAN');
  assert.equal(dispatched, 0);
});
