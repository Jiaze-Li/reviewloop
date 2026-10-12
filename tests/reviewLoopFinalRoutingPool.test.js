// Final Reviewer / Supervisor provider pool: structural completeness + full
// deterministic failover traversal. ZERO real model/provider calls — every
// route is a real RoleRouter decision and every transport is a fake function.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROLE_POLICY,
  DEFAULT_QUOTA_TOPOLOGY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { MODEL_FAMILY_REGISTRY, resolveModelFamily } from '../src/orchestrator/modelFamilyResolver.js';
import { getProviderCapabilities } from '../src/orchestrator/providerCapabilities.js';
import { accountingClassOf } from '../src/reviewloop/reviewSpend.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MINIMAL_AGY_AGENT_NAME } from '../src/reviewloop/adapters/minimalAgyAgent.js';
import { MemoryPersistence, finding } from './helpers/reviewLoopHarness.js';

const REVIEWER_ORDER = ['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus'];
const SUPERVISOR_ORDER = ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus'];

const resolver = (family) => ({
  requestedFamily: family,
  resolvedModel: resolveModelFamily(family, { env: {}, agyCatalog: null }).resolvedModel,
  provider: MODEL_FAMILY_REGISTRY[family]?.provider ?? family.split(':')[0],
  capabilities: {
    roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [],
    supportsReasoningEffort: false,
    supportedEfforts: ['medium'],
  },
});

// ---- 1. fixed order -----------------------------------------------------

test('final fixed routing order (no risk-based selection)', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), REVIEWER_ORDER);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), SUPERVISOR_ORDER);
});

// ---- 2. pool-completeness invariant -----------------------------------

test('every DEFAULT_ROLE_POLICY candidate is fully wired (no phantom fallback)', () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({ text: '{"findings":[]}' }),
    transportRuntime: {
      'codex:default': { available: true, reason: 'ok' },
      'claude:opus': { available: true, reason: 'ok' },
    },
  });
  for (const role of ['reviewer', 'supervisor']) {
    for (const cand of DEFAULT_ROLE_POLICY[role]) {
      const f = cand.family;
      assert.ok(MODEL_FAMILY_REGISTRY[f], `${f}: in MODEL_FAMILY_REGISTRY`);
      assert.ok(
        (PRODUCTION_ROLE_CAPABILITIES[f] ?? []).includes(role),
        `${f}: PRODUCTION_ROLE_CAPABILITIES declares ${role}`,
      );
      assert.ok(
        (DEFAULT_QUOTA_TOPOLOGY[f] ?? []).length > 0,
        `${f}: has a quota topology`,
      );
      assert.ok(getProviderCapabilities(f), `${f}: has a provider-capability record`);
      assert.equal(accountingClassOf({ family: f }) !== 'unknown', true, `${f}: accounting class known`);
      assert.equal(typeof pool.transports[f], 'function', `${f}: has a wired transport`);
      assert.ok(pool.runtimeStatus[f], `${f}: reports a runtime status`);
      assert.equal(pool.runtimeStatus[f].runtimeAvailable, true, `${f}: runtime available`);
    }
  }
});

test('every AGY policy family runs through the reviewloop-minimal agent', async () => {
  const seen = [];
  const pool = createReviewLoopProviderPool({
    callAgy: async (opts) => { seen.push(opts); return { text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const agyFamilies = [...new Set([...REVIEWER_ORDER, ...SUPERVISOR_ORDER])].filter((f) => f.startsWith('agy:'));
  assert.deepEqual(agyFamilies.sort(), ['agy:gemini-reviewer', 'agy:gemini-supervisor', 'agy:gpt-oss', 'agy:opus', 'agy:sonnet']);
  for (const f of agyFamilies) {
    await pool.transports[f]('P');
  }
  assert.equal(seen.length, agyFamilies.length);
  for (const opts of seen) {
    assert.equal(opts.agent, MINIMAL_AGY_AGENT_NAME);
    assert.equal(opts.disableSlashCommands, true);
  }
});

// ---- 3. route()-level full traversal ---------------------------------

test('route(): Reviewer traverses all candidates', () => {
  const health = new ProviderHealthRegistry();
  const pick = () => new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: health, resolveFamily: resolver }).route('reviewer')?.requestedFamily ?? null;
  for (const expected of REVIEWER_ORDER) {
    assert.equal(pick(), expected);
    health.record(expected, 'UNAVAILABLE');
  }
  assert.equal(pick(), null); // pool exhausted, no phantom
});

test('route(): Supervisor traverses all candidates; agy:gpt-oss is never one of them', () => {
  const health = new ProviderHealthRegistry();
  const pick = () => new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: health, resolveFamily: resolver }).route('supervisor');
  for (let i = 0; i < SUPERVISOR_ORDER.length; i += 1) {
    const sel = pick();
    assert.equal(sel.requestedFamily, SUPERVISOR_ORDER[i]);
    assert.notEqual(sel.requestedFamily, 'agy:gpt-oss');
    health.record(SUPERVISOR_ORDER[i], 'UNAVAILABLE');
  }
  assert.equal(pick(), null);
});

// ---- 4. execution-level failover through meteredWithFailover ---------

function reviewerController({ persistence, failures, quota = new QuotaPoolRegistry({ filePath: null }) }) {
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const tried = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals) => {
      const s = router.route('reviewer', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => router.recordFailure(
      { role: 'reviewer', requestedFamily: sel.family, provider: sel.provider }, f,
    ),
    reviewerFn: async ({ selection }) => {
      tried.push(selection.family);
      const code = failures[selection.family];
      // A mechanically pre-send-zero failure — the only kind that safely
      // auto-continues to the next provider (see reviewSpend PRE_SEND_ZERO_CODES;
      // unknown post-dispatch spend is a deterministic fail-closed terminal, not
      // a failover).
      if (code) throw Object.assign(new Error(code), { code });
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  return { controller, tried, quota };
}

test('failover: Opus + Gemini + Codex + Sonnet unavailable -> GPT-OSS delivers the review, no user interaction', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried } = reviewerController({
    persistence,
    failures: {
      'agy:opus': 'PROVIDER_UNAVAILABLE',
      'agy:gemini-reviewer': 'PROVIDER_UNAVAILABLE',
      'codex:default': 'PROVIDER_UNAVAILABLE',
      'agy:sonnet': 'PROVIDER_UNAVAILABLE',
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(tried, ['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss']);
});

test('failover: sixth Reviewer candidate is reachable after 5 safe failures', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried } = reviewerController({
    persistence,
    failures: {
      'agy:opus': 'PROVIDER_UNAVAILABLE',
      'agy:gemini-reviewer': 'PROVIDER_UNAVAILABLE',
      'codex:default': 'PROVIDER_UNAVAILABLE',
      'agy:sonnet': 'PROVIDER_UNAVAILABLE',
      'agy:gpt-oss': 'PROVIDER_UNAVAILABLE',
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(tried, ['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus']);
});

test('failover: shared AGY quota cooldown skips the sibling family without a physical call', async () => {
  const persistence = new MemoryPersistence();
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordProviderFailure('agy:sonnet', { code: 'PROVIDER_QUOTA_EXHAUSTED' }); // cools agy-claude-gpt
  const { controller, tried } = reviewerController({
    persistence, quota,
    failures: { 'agy:gemini-reviewer': 'PROVIDER_UNAVAILABLE', 'codex:default': 'PROVIDER_UNAVAILABLE' },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  // agy:opus, agy:sonnet AND agy:gpt-oss all share the exhausted agy-claude-gpt
  // pool -> none physically tried; routing jumps to the agy-gemini head, then
  // codex, then straight to claude:opus. The agy-gemini pool is separate, so
  // agy:gemini-reviewer is still physically attempted.
  assert.deepEqual(tried, ['agy:gemini-reviewer', 'codex:default', 'claude:opus']);
});

test('safety stop (NOT a failover): unknown post-dispatch spend fails closed, never burns the next provider', async () => {
  const persistence = new MemoryPersistence();
  // PROVIDER_PROTOCOL_ERROR after dispatch with no settleable usage -> the
  // reservation cannot settle -> UNKNOWN != ZERO -> deterministic fail-closed
  // terminal. Automatic failover must NOT continue to agy:sonnet. The
  // pre-send-zero PROVIDER_UNAVAILABLE on the Gemini head DOES safely advance.
  const { controller, tried } = reviewerController({
    persistence,
    failures: { 'agy:opus': 'PROVIDER_UNAVAILABLE', 'agy:gemini-reviewer': 'PROVIDER_UNAVAILABLE', 'codex:default': 'PROVIDER_PROTOCOL_ERROR', 'agy:sonnet': undefined },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /usage could not be reliably settled|unresolved model spend/i);
  assert.deepEqual(tried, ['agy:opus', 'agy:gemini-reviewer', 'codex:default']); // later providers never reached
  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  // the Gemini pre-send-zero failure rolled its reservation back; the codex
  // post-dispatch protocol error is the UNRESOLVED fail-closed terminal.
  const codexRes = reservations.filter((r) => r.family === 'codex:default');
  assert.equal(codexRes.length, 1);
  assert.equal(codexRes[0].status, 'UNRESOLVED');
  assert.equal(reservations.some((r) => r.family === 'agy:sonnet'), false);
});

test('failover: Supervisor fourth candidate (claude:opus) reachable after 3 safe failures', async () => {
  const persistence = new MemoryPersistence();
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const supervisorTried = [];
  let deltaN = 0;
  const failures = {
    'agy:gemini-supervisor': 'PROVIDER_UNAVAILABLE',
    'codex:default': 'PROVIDER_UNAVAILABLE',
    'agy:sonnet': 'PROVIDER_UNAVAILABLE',
  };
  const controller = createReviewLoopController({
    persistence,
    routeSupervisorFn: (signals) => {
      const s = router.route('supervisor', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => router.recordFailure(
      { role: 'supervisor', requestedFamily: sel.family, provider: sel.provider }, f,
    ),
    reviewerFn: async () => ({ value: { findings: [finding('P1')] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
    supervisorFn: async ({ selection }) => {
      supervisorTried.push(selection.family);
      const code = failures[selection.family];
      if (code) throw Object.assign(new Error(code), { code });
      return { value: { guidance: 'do x', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 }, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      deltaN += 1;
      return { fingerprint: `d${deltaN}`, diff: `x${deltaN}`, changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await controller.review({ loopId }); // round 1: P1 -> REWORK, no supervisor
  await controller.review({ loopId }); // round 2: same P1 after changed diff -> supervisor
  assert.deepEqual(supervisorTried, SUPERVISOR_ORDER);
});
