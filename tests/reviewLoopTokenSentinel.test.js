// Post-settlement single-call Token Sentinel + the agy:gpt-oss Supervisor-pool
// removal. ZERO real provider calls — every metered call is a fake function and
// every route is a real deterministic RoleRouter decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewLoopSpend,
  resolveReviewLoopLimits,
  detectSingleCallTokenAnomaly,
  contextOverheadTokens,
  REVIEWLOOP_DEFAULTS,
} from '../src/reviewloop/reviewSpend.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  supportsProductionRole,
} from '../src/orchestrator/roleRouting.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { resolveModelFamily } from '../src/orchestrator/modelFamilyResolver.js';
import { MODEL_FAMILY_REGISTRY } from '../src/orchestrator/modelFamilyResolver.js';
import { MemoryPersistence, finding } from './helpers/reviewLoopHarness.js';

// ---- A. Supervisor pool: agy:gpt-oss removed ---------------------------

test('Supervisor production pool is EXACTLY the 4 certified candidates', () => {
  assert.deepEqual(
    DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family),
    ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus'],
  );
  const eligible = DEFAULT_ROLE_POLICY.supervisor
    .filter((c) => (PRODUCTION_ROLE_CAPABILITIES[c.family] ?? []).includes('supervisor'))
    .map((c) => c.family);
  assert.equal(eligible.length, 4);
});

test('agy:gpt-oss is not Supervisor-eligible and never routes as Supervisor', () => {
  assert.equal(supportsProductionRole('agy:gpt-oss', 'supervisor'), false);
  assert.equal(PRODUCTION_ROLE_CAPABILITIES['agy:gpt-oss'].includes('supervisor'), false);

  const resolver = (family) => ({
    requestedFamily: family,
    resolvedModel: resolveModelFamily(family, { env: {}, agyCatalog: null }).resolvedModel,
    provider: MODEL_FAMILY_REGISTRY[family]?.provider ?? family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: false, supportedEfforts: ['medium'] },
  });
  const health = new ProviderHealthRegistry();
  for (const f of ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus']) health.record(f, 'UNAVAILABLE');
  assert.equal(new RoleRouter({ providerHealth: health, resolveFamily: resolver }).route('supervisor'), null);
});

test('agy:gpt-oss is still a Reviewer candidate', () => {
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family).includes('agy:gpt-oss'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'reviewer'), true);
});

test('MAX_SUPERVISOR_CALLS covers two bounded traversals of the 4-candidate pool', () => {
  assert.equal(REVIEWLOOP_DEFAULTS.MAX_SUPERVISOR_CALLS, 8);
  assert.equal(resolveReviewLoopLimits({}).maxSupervisorCalls, 8);
});

// ---- B. Token Sentinel unit behaviour ---------------------------------

const persistenceOf = () => new MemoryPersistence();

async function meterOnce(spend, {
  usage, meta = null, family = 'agy:gpt-oss', provider = 'agy', role = 'reviewer',
  op = `op-${Math.random().toString(36).slice(2)}`, throwErr = null, onCall = null,
} = {}) {
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: op, diffHash: `${op}::G` });
  return spend.meteredCall({
    role, family, provider, operationId: op, attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      if (onCall) onCall();
      if (throwErr) throw throwErr;
      return { value: { findings: [] }, usage, model: 'm', meta };
    },
  });
}

test('single-call usage 39999 -> no anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await meterOnce(spend, { usage: { input_tokens: 39999, output_tokens: 0 } });
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined);
  assert.equal((await spend.telemetry()).tokenAnomalyBlocked, false);
});

test('single-call usage 40001 -> BLOCKING anomaly, call still accounted', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' && e.authorizationFailure === true,
  );
  const state = await persistence.readWorkflowState('L');
  // (9) the anomalous call is fully, durably accounted — never treated as 0
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 40001);
  assert.equal(state.reviewLoopSpend.records.at(-1).usageKnown, true);
  // durable latch
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(state.reviewLoopTokenAnomaly.trigger, 'SINGLE_CALL_USAGE');
  assert.equal(state.reviewLoopTokenAnomaly.usageVolume, 40001);
  assert.equal(state.reviewLoopTokenAnomaly.threshold, 40000);
  const t = await spend.telemetry();
  assert.equal(t.tokenAnomalyBlocked, true);
  assert.equal(t.usageVolume, 40001);
});

test('context overhead 29999 -> no anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  // input 30000, est payload tokens round(4/4)=1 -> overhead 29999; volume 30000
  await meterOnce(spend, { usage: { input_tokens: 30000, output_tokens: 0 }, meta: { promptChars: 4 } });
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined);
});

test('context overhead 30001 -> BLOCKING anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    // input 30002, est 1 -> overhead 30001 (> 30000); volume 30002 (< 40000)
    () => meterOnce(spend, { usage: { input_tokens: 30002, output_tokens: 0 }, meta: { promptChars: 4 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly.trigger, 'CONTEXT_OVERHEAD');
  assert.equal(state.reviewLoopTokenAnomaly.contextOverheadTokens, 30001);
  assert.equal(state.reviewLoopTokenAnomaly.threshold, 30000);
});

test('after an anomaly the next physical call is refused at the authorization stage (0 dispatch)', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(() => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }));
  const recordsAfterAnomaly = (await persistence.readWorkflowState('L')).reviewLoopSpend.records.length;

  let dispatched = false;
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false, 'the provider call must never run');
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopSpend.records.length, recordsAfterAnomaly, 'no new spend record');
  // no new reservation was minted for the refused call
  assert.equal(Object.keys(state.modelSpendReservations ?? {}).length, 1);
});

test('a fresh process (restart/resume) stays blocked by the durable anomaly latch', async () => {
  const persistence = persistenceOf();
  const s1 = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(() => meterOnce(s1, { usage: { input_tokens: 40001, output_tokens: 0 } }));

  const s2 = createReviewLoopSpend({ loopId: 'L', persistence });
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(s2, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
  assert.equal((await s2.telemetry()).tokenAnomalyBlocked, true);
});

test('a clean read is never cached — a latch written after the first read still blocks', async () => {
  const persistence = persistenceOf();
  const a = createReviewLoopSpend({ loopId: 'L', persistence });
  const b = createReviewLoopSpend({ loopId: 'L', persistence });
  // b observes clean state first...
  assert.equal(await b.loadTokenAnomaly(), null);
  // ...then a trips + durably latches the anomaly
  await assert.rejects(() => meterOnce(a, { usage: { input_tokens: 40001, output_tokens: 0 } }));
  // b's next metered call re-reads the durable latch and is blocked
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(b, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
});

test('unknown / unresolved usage keeps the existing UNRESOLVED path, NOT the Token Sentinel', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: null }),
    (e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED',
  );
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined, 'never latched as a token anomaly');
  assert.equal(Object.values(state.modelSpendReservations)[0].status, 'UNRESOLVED');
});

test('detectSingleCallTokenAnomaly ignores calls whose volume did not resolve', () => {
  const limits = resolveReviewLoopLimits({});
  assert.equal(
    detectSingleCallTokenAnomaly({
      accounting: { volumeResolved: false, usageVolume: 999999 }, contextOverhead: 999999, limits,
    }),
    null,
  );
});

// ---- env overrides -----------------------------------------------------

test('env override raises the ceilings', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '100000' },
  });
  await meterOnce(spend, { usage: { input_tokens: 50000, output_tokens: 0 } }); // 50k < 100k -> fine
  assert.equal((await persistence.readWorkflowState('L')).reviewLoopTokenAnomaly, undefined);
});

test('env override lowers the ceiling and still trips', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '20000' },
  });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 25000, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
});

test('an illegal threshold NEVER disables the sentinel (falls back to default)', () => {
  for (const bad of ['0', '-1', '-999', 'abc', '', 'NaN', 'Infinity', 'null']) {
    const l = resolveReviewLoopLimits({
      REVIEWLOOP_MAX_SINGLE_CALL_USAGE: bad, REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS: bad,
    });
    assert.equal(l.maxSingleCallUsage, 40000, `bad=${JSON.stringify(bad)}`);
    assert.equal(l.maxContextOverheadTokens, 30000, `bad=${JSON.stringify(bad)}`);
  }
});

test('a huge env value is clamped to the hard cap (cannot be inflated to infinity)', async () => {
  const l = resolveReviewLoopLimits({ REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '999999999' });
  assert.equal(l.maxSingleCallUsage, 250000);
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '999999999' },
  });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 300000, output_tokens: 0 } }), // > 250k cap
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
});

test('a latch READ failure fails closed — never read as "no anomaly"', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'op::G' });
  // only the anomaly-latch read is broken
  const realRead = persistence.readWorkflowState.bind(persistence);
  let armed = false;
  persistence.readWorkflowState = async (id) => {
    if (armed) throw new Error('disk gone');
    return realRead(id);
  };
  armed = true;
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: 'op', attempt: 1,
      evidenceIds: [ev.evidenceId], call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
});

test('restart re-inference: a durable spend-log READ failure fails closed (UNKNOWN != clean)', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'op::G' });
  // The latch read succeeds and reports clean/no-latch; the FOLLOWING durable
  // spend-log read (the re-inference backup) then fails transiently.
  const realRead = persistence.readWorkflowState.bind(persistence);
  let calls = 0;
  persistence.readWorkflowState = async (id) => {
    calls += 1;
    if (calls === 1) return realRead(id); // anomalyStore.load -> null (clean)
    throw new Error('spend log read failed');
  };
  let dispatched = false;
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: 'op', attempt: 1,
      evidenceIds: [ev.evidenceId],
      call: async () => { dispatched = true; return { value: {}, usage: { input_tokens: 1, output_tokens: 1 } }; },
    }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE' && e.authorizationFailure === true,
  );
  assert.equal(dispatched, false, 'no physical provider dispatch');
  const state = await realRead('L');
  assert.equal(state?.reviewLoopSpend, undefined, 'no new spend record');
  assert.equal(state?.modelSpendReservations, undefined, 'no permit / reservation minted');
});

test('an atomic spend+latch write failure is surfaced (not swallowed) and the call is still accounted in-process', async () => {
  const persistence = persistenceOf();
  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async (id, patch) => {
    // the anomalous settlement writes spend record + latch in ONE call
    if (patch && 'reviewLoopTokenAnomaly' in patch) throw new Error('atomic write failed');
    return realUpdate(id, patch);
  };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
  // Atomic transition: the durable write failed, so NEITHER the spend record nor
  // the latch landed — never "spend persisted, latch missing".
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopSpend, undefined);
  assert.equal(state.reviewLoopTokenAnomaly, undefined);
  // The anomalous call's real usage is still fully accounted in-process (never 0)
  // and this process stays blocked.
  const t = await spend.telemetry();
  assert.equal(t.usageVolume, 40001);
  assert.equal(t.tokenAnomalyBlocked, true);
});

test('anomalous settlement writes the spend record + anomaly latch in ONE atomic state transition', async () => {
  const persistence = persistenceOf();
  const writes = [];
  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async (id, patch) => {
    writes.push(Object.keys(patch ?? {}));
    return realUpdate(id, patch);
  };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  // exactly one write carries BOTH keys; there is no write that carries the
  // spend record without the latch (the historical crash window).
  const bothKeys = writes.filter((k) => k.includes('reviewLoopSpend') && k.includes('reviewLoopTokenAnomaly'));
  const spendOnly = writes.filter((k) => k.includes('reviewLoopSpend') && !k.includes('reviewLoopTokenAnomaly'));
  assert.equal(bothKeys.length, 1);
  assert.equal(spendOnly.length, 0);
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 40001);
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
});

test('restart re-infers the latch from a durable anomalous spend record when the latch write was lost', async () => {
  const persistence = persistenceOf();
  // Simulate the historical crash window: the spend record for a 60k call is on
  // disk, but the anomaly latch write never happened.
  await persistence.updateWorkflowState('L', {
    reviewLoopSpend: {
      records: [{
        role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', model: 'm',
        usageKnown: true, usageVolume: 60000,
        usageAccounting: { volumeResolved: true, semanticsKnown: true },
        contextOverheadTokens: 0, costUsd: 0, costKnown: false,
        businessOutcome: 'SUCCESS', reservationId: 'res-1', at: new Date().toISOString(),
      }],
    },
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', status: 'SETTLED_KNOWN', role: 'reviewer', intent: { role: 'reviewer' },
      },
    },
  });
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false, 'the next provider call must never run');
  // the latch is now durably reconstructed
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(state.reviewLoopTokenAnomaly.reinferredFromSpendLog, true);
  assert.equal(state.reviewLoopTokenAnomaly.usageVolume, 60000);
});

// ---- B. context overhead is provider/accounting-aware -----------------

test('Anthropic cached context counts toward context overhead (input=2 + cache >30k, total <40k) -> CONTEXT_OVERHEAD trip', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, {
      family: 'claude:opus', provider: 'claude',
      // uncached input 2, output 5, cache_creation 31000 -> usageVolume 31007 (<40000)
      // effective context input = 2 + 31000 = 31002; est payload ~1 -> overhead 31001 (>30000)
      usage: {
        input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 31000,
      },
      meta: { promptChars: 4 },
    }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly.trigger, 'CONTEXT_OVERHEAD');
  assert.equal(state.reviewLoopTokenAnomaly.contextOverheadTokens, 31001);
  // usageVolume accounting semantics unchanged (input + output + cache_creation)
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 31007);
});

test('context overhead is provider-aware: Anthropic adds cache_*, OpenAI/Codex does not', () => {
  const breakdown = { inputTokens: 2, cacheCreationTokens: 31000, cacheReadTokens: 0 };
  const payload = { estimatedPayloadTokens: 1 };
  // Anthropic: cache_creation is separate input -> effective 31002, overhead 31001
  assert.equal(
    contextOverheadTokens(breakdown, payload, { family: 'claude:opus', provider: 'claude' }),
    31001,
  );
  // OpenAI/Codex: cache_read ⊂ input, never added -> effective 2, overhead 1
  assert.equal(
    contextOverheadTokens(
      { inputTokens: 2, cacheReadTokens: 31000 }, payload,
      { family: 'codex:default', provider: 'codex' },
    ),
    1,
  );
  // input UNKNOWN stays null (never 0)
  assert.equal(contextOverheadTokens({ inputTokens: null }, payload, { family: 'claude:opus' }), null);
});

test('a persistence that cannot store durable workflow state -> anomaly fails closed (STATE_UNAVAILABLE)', async () => {
  const brokenPersistence = { note: 'no readWorkflowState / updateWorkflowState' };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence: brokenPersistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
});

test('a bare in-memory surface (no persistence) still blocks the next call in-process', async () => {
  const spend = createReviewLoopSpend({ loopId: 'L' });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
});

// ---- C. controller: no failover / no health mutation on anomaly -------

function anomalyController({ persistence, reviewerUsage }) {
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const resolver = (family) => ({
    requestedFamily: family,
    resolvedModel: `${family}-rt`,
    provider: family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: false, supportedEfforts: ['medium'] },
  });
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const tried = [];
  const providerFailures = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals) => {
      const s = router.route('reviewer', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => { providerFailures.push([sel.family, f.code]); router.recordFailure({ role: 'reviewer', requestedFamily: sel.family, provider: sel.provider }, f); },
    reviewerFn: async ({ selection }) => {
      tried.push(selection.family);
      return { value: { findings: [finding('P3')] }, usage: reviewerUsage, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  return { controller, tried, providerFailures, health, quota };
}

test('controller: a single-call token anomaly is a safety stop — no failover, no health/quota mutation', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried, providerFailures, health, quota } = anomalyController({
    persistence, reviewerUsage: { input_tokens: 200000, output_tokens: 0 },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });

  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /token anomaly|MODEL_SPEND_TOKEN_ANOMALY/i);
  // (12) no auto-failover to the next Reviewer candidate
  assert.deepEqual(tried, ['agy:opus']);
  // (13) provider health / quota untouched
  assert.deepEqual(providerFailures, []);
  assert.equal(health.get('agy:opus').status, 'UNKNOWN');
  assert.equal(quota.usable('agy:opus'), true);
  // BLOCKING safety event surfaced
  assert.equal(r.safetyEvents.some((e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY' && e.severity === 'BLOCKING'), true);
  // durable latch + full accounting of the anomalous call
  const state = await persistence.readWorkflowState(loopId);
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 200000);
});
