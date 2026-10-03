// B6 — production Reviewer/Supervisor pool is real: RoleRouter -> capability ->
// quota -> health -> selected family, and the CallIntent binds the actually-
// selected family. Only reviewer + supervisor roles. Failover re-authorizes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaPoolRegistry, ProviderHealthRegistry, RouteAuditLog } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool, createAgyZeroTokenHealthRevalidator } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('reviewer routes to the first eligible family; supervisor to its first', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  // agy:opus is first for reviewer and is wired via reviewloop-minimal.
  assert.equal(pool.route('reviewer').family, 'agy:opus');
  // agy:gemini-supervisor is first for supervisor, likewise wired.
  assert.equal(pool.route('supervisor').family, 'agy:gemini-supervisor');
});

test('reviewer: Opus + Gemini head down + shared Claude&GPT pool in cooldown -> no eligible Reviewer', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordCooldown('agy-claude-gpt'); // the shared agy:opus + agy:sonnet + agy:gpt-oss pool
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini-reviewer', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), quotaRegistry: quota, providerHealth: health });
  // gemini-reviewer down; codex + claude runtime not probed -> UNAVAILABLE;
  // agy:opus, agy:sonnet AND agy:gpt-oss all skipped (shared exhausted pool) -> null.
  assert.equal(pool.route('reviewer'), null);
  // the agy-gemini pool is SEPARATE and healthy: the Supervisor head still routes.
  assert.equal(pool.route('supervisor').family, 'agy:gemini-supervisor');
});

test('supervisor first candidate unavailable -> next eligible selected', () => {
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini-supervisor', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });
  const sel = pool.route('supervisor');
  // agy:gemini-supervisor removed, codex/claude runtime not probed -> agy:sonnet.
  assert.equal(sel.family, 'agy:sonnet');
});

test('the pool never offers a planner or executor role', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  assert.equal(pool.route('planner'), null);
  assert.equal(pool.route('executor'), null);
});

test('a bare pool touches no disk for its routing-decision audit (in-memory default)', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  pool.route('reviewer');
  assert.equal(pool.router.routeAudit.filePath, null);
  assert.ok(pool.router.routeAudit.entries.length > 0);
});

test('createReviewLoopProviderPool forwards routeAudit / healthRevalidator / staleHealthTtlMs into the router', () => {
  const audited = [];
  let revalidatorCalls = 0;
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'x');
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    providerHealth: health,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
    healthRevalidator: () => { revalidatorCalls += 1; return null; },
    staleHealthTtlMs: -1, // any non-negative age counts as stale — deterministic without controlling the clock
  });
  const sel = pool.route('reviewer');
  assert.equal(sel.family, 'agy:gemini-reviewer');
  assert.equal(revalidatorCalls, 1);
  assert.ok(audited.some((e) => e.type === 'ROLE_ROUTE_SKIPPED' && e.candidate === 'agy:opus'));
});

const PROVISIONING_FAILED_ENTRY = { status: 'UNAVAILABLE', reasonCode: 'AGY_PROVISIONING_FAILED' };

test('createAgyZeroTokenHealthRevalidator: recovers an AGY family when re-provisioning now succeeds, for the reasonCode it can actually re-verify', () => {
  const calls = [];
  const revalidate = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: (opts) => { calls.push(opts); return { name: 'reviewloop-minimal', path: '/fake', relativePath: 'x', wrote: false }; },
  });
  const verdict = revalidate('agy:opus', 'agy', PROVISIONING_FAILED_ENTRY);
  assert.equal(verdict.available, true);
  assert.deepEqual(calls, [{ geminiDir: '/fake/gemini-dir' }]);
});

test('createAgyZeroTokenHealthRevalidator: reports unavailable (not a throw) when re-provisioning still fails, for that same reasonCode', () => {
  const revalidate = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => { throw new Error('still cannot write the agent file'); },
  });
  const verdict = revalidate('agy:gemini-reviewer', 'agy', PROVISIONING_FAILED_ENTRY);
  assert.equal(verdict.available, false);
  assert.match(verdict.reason, /still cannot write the agent file/);
});

test('createAgyZeroTokenHealthRevalidator: has no opinion (null) on a non-AGY family regardless of reasonCode', () => {
  const revalidate = createAgyZeroTokenHealthRevalidator({ agyGeminiDir: '/fake/gemini-dir', provisionMinimalAgent: () => ({}) });
  assert.equal(revalidate('codex:default', 'codex', PROVISIONING_FAILED_ENTRY), null);
});

test('createAgyZeroTokenHealthRevalidator: refuses to clear an AGY family whose startup failure was capability/effective-loading, not provisioning', () => {
  let provisionCalls = 0;
  const revalidate = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => { provisionCalls += 1; return {}; }, // would succeed if ever called
  });
  const verdict = revalidate('agy:opus', 'agy', { status: 'UNAVAILABLE', reasonCode: 'AGY_CAPABILITY_UNVERIFIED' });
  assert.equal(verdict.available, false);
  assert.equal(provisionCalls, 0, 'must never even attempt a re-probe for a failure class it cannot re-verify');
  assert.match(verdict.reason, /AGY_CAPABILITY_UNVERIFIED/);
  assert.match(verdict.reason, /restart/);
});

test('createAgyZeroTokenHealthRevalidator: refuses to clear a per-call effective-loading failure', () => {
  let provisionCalls = 0;
  const revalidate = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => { provisionCalls += 1; return {}; },
  });
  const verdict = revalidate('agy:opus', 'agy', { status: 'UNAVAILABLE', reasonCode: 'AGY_EFFECTIVE_LOADING_FAILED' });
  assert.equal(verdict.available, false);
  assert.equal(provisionCalls, 0);
});

test('createAgyZeroTokenHealthRevalidator: refuses to clear a post-dispatch provider failure (unrelated to local provisioning)', () => {
  let provisionCalls = 0;
  const revalidate = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => { provisionCalls += 1; return {}; },
  });
  const verdict = revalidate('agy:opus', 'agy', { status: 'UNAVAILABLE', reasonCode: 'PROVIDER_TIMEOUT' });
  assert.equal(verdict.available, false);
  assert.equal(provisionCalls, 0);
});

test('createAgyZeroTokenHealthRevalidator: refuses to clear an entry with no reasonCode at all (conservative default)', () => {
  const revalidate = createAgyZeroTokenHealthRevalidator({ agyGeminiDir: '/fake/gemini-dir', provisionMinimalAgent: () => ({}) });
  const verdict = revalidate('agy:opus', 'agy', { status: 'UNAVAILABLE' });
  assert.equal(verdict.available, false);
});

test('the CallIntent family matches the actually-selected family', async () => {
  const persistence = new MemoryPersistence();
  const seenIntents = [];
  const health = new ProviderHealthRegistry();
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });

  const controller = createReviewLoopController({
    persistence,
    // codex/claude runtime not probed -> agy:opus is the selected Reviewer.
    routeReviewerFn: (signals) => pool.route('reviewer', signals),
    reviewerFn: async ({ selection }) => {
      seenIntents.push(selection.family);
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(seenIntents[0], 'agy:opus');

  // the durable reservation ledger recorded the intent against the SAME family
  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.ok(reservations.length >= 1);
  assert.ok(reservations.every((res) => res.family === 'agy:opus'));
});

test('a retryable provider failure fails over and requires a fresh permit', async () => {
  const persistence = new MemoryPersistence();
  let attempt = 0;
  const familiesTried = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => {
      // hand a different family per attempt
      const family = attempt === 0 ? 'agy:gpt-oss' : 'agy:gemini-reviewer';
      return { family, provider: 'agy', model: 'm', transport: async () => ({}) };
    },
    recordProviderFailure: () => {},
    reviewerFn: async ({ selection }) => {
      familiesTried.push(selection.family);
      if (attempt++ === 0) throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' });
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(familiesTried, ['agy:gpt-oss', 'agy:gemini-reviewer']);

  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  // one reservation per physical attempt, each with its own family
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((x) => x.family).sort(), ['agy:gemini-reviewer', 'agy:gpt-oss']);
});

// ---- P2-1: the router never selects a family with no wired transport -----

test('production pool: the router never selects an AGY family with no wired transport, even when health has no blocking record at all', () => {
  const health = new ProviderHealthRegistry();
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    transportRuntime: { 'codex:default': { available: true }, 'claude:opus': { available: true } },
    providerHealth: health,
    provisionMinimalAgent: () => { throw new Error('cannot write agent file'); }, // AGY families never wired
  });
  // Simulate health "looking fine" despite the transport never having been
  // wired — proves the transport gate blocks selection independently of,
  // and regardless of, whatever provider-health state says.
  health.candidates.clear();
  health.providers.clear();
  const sel = pool.route('reviewer');
  assert.equal(sel.family, 'codex:default');
});

test('production pool: a "recovered" AGY health verdict from the real zero-token revalidator still never gets selected without a wired transport', () => {
  const revalidator = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => ({}), // this probe instance "succeeds"
  });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    transportRuntime: { 'codex:default': { available: true } },
    provisionMinimalAgent: () => { throw new Error('cannot write agent file'); }, // the POOL's own startup provisioning still failed -> agy never wired
    healthRevalidator: revalidator,
    staleHealthTtlMs: -1,
  });
  const sel = pool.route('reviewer');
  // agy:opus's recorded reasonCode is exactly AGY_PROVISIONING_FAILED (what
  // the revalidator can legitimately clear) and the revalidator DOES report
  // available:true — selection still lands on codex, because the transport
  // gate does not depend on health at all.
  assert.equal(sel.family, 'codex:default');
});

test('production pool: an AGY family whose startup failure was capability/effective-loading (not provisioning) is never revived by the revalidator', () => {
  const revalidator = createAgyZeroTokenHealthRevalidator({
    agyGeminiDir: '/fake/gemini-dir',
    provisionMinimalAgent: () => ({}), // would "succeed" — must never even be consulted for this reasonCode
  });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    transportRuntime: { 'codex:default': { available: true } },
    // minimalAgent provisions fine, but the startup capability probe says agy
    // does not load the isolated agent — reasonCode AGY_CAPABILITY_UNVERIFIED.
    customAgentSupport: { supported: false, reason: 'agy fell back to its default agent' },
    healthRevalidator: revalidator,
    staleHealthTtlMs: -1,
  });
  const sel = pool.route('reviewer');
  assert.equal(sel.family, 'codex:default');
});

// ---- P2-2: per-call audit attribution never cross-contaminates -----------

test('production pool: interleaved loops routing through the SAME shared pool/router never cross-contaminate audit attribution', () => {
  const audited = [];
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'x', { reasonCode: 'PROVIDER_TIMEOUT' });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    providerHealth: health,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
  });
  // Two "loops" interleaving calls through the one pool/router this process
  // holds for its whole lifetime — exactly the real production shape.
  pool.route('reviewer', {}, { loopId: 'loop-A', round: 1, operationId: 'op-A-1', attempt: 1 });
  pool.route('reviewer', {}, { loopId: 'loop-B', round: 1, operationId: 'op-B-1', attempt: 1 });
  pool.route('reviewer', {}, { loopId: 'loop-A', round: 2, operationId: 'op-A-2', attempt: 1 });
  pool.route('reviewer', {}, { loopId: 'loop-B', round: 2, operationId: 'op-B-2', attempt: 1 });

  const byLoop = (id) => audited.filter((e) => e.loopId === id);
  const a = byLoop('loop-A');
  const b = byLoop('loop-B');
  assert.ok(a.length > 0 && b.length > 0);
  assert.ok(a.every((e) => e.operationId.startsWith('op-A')));
  assert.ok(b.every((e) => e.operationId.startsWith('op-B')));
  assert.deepEqual([...new Set(a.map((e) => e.round))].sort(), [1, 2]);
  assert.deepEqual([...new Set(b.map((e) => e.round))].sort(), [1, 2]);
});

test('the controller feeds real loopId/round/operationId/attempt/chunk attribution into every route decision, per physical call', async () => {
  const audited = [];
  const persistence = new MemoryPersistence();
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'x', { reasonCode: 'PROVIDER_TIMEOUT' }); // force a skip so there's something to attribute
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health, routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }) });

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals, requestContext) => pool.route('reviewer', signals, requestContext),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');

  const forThisLoop = audited.filter((e) => e.loopId === loopId);
  assert.ok(forThisLoop.length > 0, 'the real controller-driven call must carry real attribution, not nulls');
  assert.ok(forThisLoop.every((e) => e.operationId), 'every decision must carry the real operationId, not a placeholder');
  assert.ok(forThisLoop.every((e) => Number.isInteger(e.attempt)));
});



test('operation-local exclusions skip a transiently exhausted family once but do not poison future reviews', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });

  const failoverSelection = pool.route('reviewer', {
    excludeFamilies: ['agy:opus'],
  });
  assert.equal(
    failoverSelection.family,
    'agy:gemini-reviewer',
    'current operation should route past the exhausted AGY family',
  );

  const freshReviewSelection = pool.route('reviewer');
  assert.equal(
    freshReviewSelection.family,
    'agy:opus',
    'a later independent review should retry the primary after the network recovers',
  );
  assert.notEqual(
    pool.router.providerHealth.get('agy:opus').status,
    'UNAVAILABLE',
    'operation-local exclusion must not mutate durable/process-wide provider health',
  );
});
