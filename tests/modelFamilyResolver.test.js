// Stage 1 — dynamic model-FAMILY resolution. Configuration binds a stable
// family identity; runtime resolves the concrete model; telemetry persists it.
//
// Required regressions (per the release card):
//   1. no concrete Gemini version pin in the default config
//   2. no concrete GPT-OSS version pin in the default config
//   3. an explicit env override CAN pin a concrete model
//   4. a different runtime catalog -> a different concrete model, no policy edit
//   5. telemetry / reservation persists the ACTUAL resolved model
//   6. a model-resolution change still emits the existing diagnostics event
//   7. the two role-specific Gemini heads resolve to their FIXED effort variant
//      (agy:gemini-reviewer -> -low, agy:gemini-supervisor -> -medium)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelFamily,
  MODEL_FAMILY_REGISTRY,
  RESOLUTION_SOURCE,
  defaultConfigHasConcreteVersionPin,
  pickCatalogModel,
  parseAgyModelCatalog,
} from '../src/orchestrator/modelFamilyResolver.js';
import { DEFAULT_ROLE_POLICY, QuotaPoolRegistry, RoleRouter } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('1+2: the default config carries no concrete Gemini or GPT-OSS version pin', () => {
  assert.equal(defaultConfigHasConcreteVersionPin({}), false);
  for (const family of ['agy:gemini-reviewer', 'agy:gemini-supervisor', 'agy:gpt-oss', 'agy:opus']) {
    const r = resolveModelFamily(family, { env: {}, agyCatalog: null });
    assert.equal(r.resolvedModel, null, family);
    assert.equal(r.resolvedFrom, RESOLUTION_SOURCE.PROVIDER_DEFAULT, family);
    assert.equal(r.concreteVersionPinned, false, family);
  }
  // `claude:opus` is not provider-default semantics: bind the stable `opus`
  // alias so the family remains Opus while the provider advances releases.
  const opus = resolveModelFamily('claude:opus', { env: {}, agyCatalog: null });
  assert.equal(opus.resolvedModel, 'opus');
  assert.equal(opus.resolvedFrom, RESOLUTION_SOURCE.STABLE_PROVIDER_ALIAS);
  assert.equal(opus.concreteVersionPinned, false);

  const families = Object.values(DEFAULT_ROLE_POLICY).flat().map((c) => c.family);
  for (const f of families) assert.match(f, /^[a-z-]+:[a-z-]+$/, f);
});

test('3: an explicit env override pins a concrete model for tests/benchmark/repro', () => {
  const r = resolveModelFamily('agy:gpt-oss', { env: { AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium' }, agyCatalog: null });
  assert.equal(r.resolvedModel, 'gpt-oss-120b-medium');
  assert.equal(r.resolvedFrom, RESOLUTION_SOURCE.ENV_OVERRIDE);
  assert.equal(r.pinnedByEnv, true);
  assert.equal(r.concreteVersionPinned, true);
  assert.equal(r.envKey, 'AGY_REVIEWER_MODEL');

  const r2 = resolveModelFamily('agy:gemini-supervisor', {
    env: { REVIEWLOOP_GEMINI_SUPERVISOR_MODEL: 'gemini-3.1-pro-low' },
    agyCatalog: ['gemini-9.9-flash-high'],
  });
  assert.equal(r2.resolvedModel, 'gemini-3.1-pro-low');
  assert.equal(r2.envKey, 'REVIEWLOOP_GEMINI_SUPERVISOR_MODEL');
});

test('4: a different runtime catalog yields a different concrete model with no policy edit', () => {
  const policyBefore = JSON.stringify(DEFAULT_ROLE_POLICY);
  const a = resolveModelFamily('agy:gemini-supervisor', { env: {}, agyCatalog: ['gemini-3.7-flash-medium', 'gemini-3.8-flash-medium'] });
  const b = resolveModelFamily('agy:gemini-supervisor', { env: {}, agyCatalog: ['gemini-3.7-flash-medium', 'gemini-4.2-flash-medium'] });
  assert.equal(a.resolvedModel, 'gemini-3.8-flash-medium');
  assert.equal(b.resolvedModel, 'gemini-4.2-flash-medium');
  assert.equal(a.resolvedFrom, RESOLUTION_SOURCE.RUNTIME_CATALOG);
  assert.equal(JSON.stringify(DEFAULT_ROLE_POLICY), policyBefore, 'policy untouched by resolution');
});

test('catalog parsing + effort preference', () => {
  const ids = parseAgyModelCatalog('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n');
  assert.deepEqual(ids, ['gemini-3.8-flash-high', 'gpt-oss-120b-medium']);
  assert.equal(
    pickCatalogModel(['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.9-flash-low'], MODEL_FAMILY_REGISTRY['agy:gemini-supervisor']),
    'gemini-3.8-flash-medium',
    'supervisor head prefers its default effort (medium) over a newer non-medium entry',
  );
  assert.equal(
    pickCatalogModel(['gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.9-flash-medium'], MODEL_FAMILY_REGISTRY['agy:gemini-reviewer']),
    'gemini-3.8-flash-low',
    'reviewer head prefers its default effort (low) over a newer non-low entry',
  );
  assert.equal(
    pickCatalogModel(['gemini-3.8-flash-low', 'gemini-3.9-flash-high'], MODEL_FAMILY_REGISTRY['agy:gemini-supervisor']),
    'gemini-3.9-flash-high',
    'no -medium variant -> falls back to the newest entry regardless of suffix',
  );
});

test('7: the two Gemini role heads resolve to their FIXED effort variant, newest version', () => {
  assert.equal(MODEL_FAMILY_REGISTRY['agy:gemini-reviewer'].defaultEffort, 'low');
  assert.equal(MODEL_FAMILY_REGISTRY['agy:gemini-supervisor'].defaultEffort, 'medium');
  assert.equal(MODEL_FAMILY_REGISTRY['agy:gemini-reviewer'].provider, 'agy-gemini');
  assert.equal(MODEL_FAMILY_REGISTRY['agy:gemini-supervisor'].provider, 'agy-gemini');

  const catalog = ['gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'];
  const reviewer = resolveModelFamily('agy:gemini-reviewer', { env: {}, agyCatalog: catalog });
  const supervisor = resolveModelFamily('agy:gemini-supervisor', { env: {}, agyCatalog: catalog });
  assert.equal(reviewer.resolvedModel, 'gemini-3.8-flash-low');
  assert.equal(supervisor.resolvedModel, 'gemini-3.8-flash-medium');
  assert.equal(reviewer.resolvedFrom, RESOLUTION_SOURCE.RUNTIME_CATALOG);
  assert.equal(supervisor.resolvedFrom, RESOLUTION_SOURCE.RUNTIME_CATALOG);

  // env override still wins over the catalog effort preference.
  const pinned = resolveModelFamily('agy:gemini-reviewer', {
    env: { REVIEWLOOP_GEMINI_REVIEWER_MODEL: 'gemini-3.8-flash-high' },
    agyCatalog: catalog,
  });
  assert.equal(pinned.resolvedModel, 'gemini-3.8-flash-high');
  assert.equal(pinned.resolvedFrom, RESOLUTION_SOURCE.ENV_OVERRIDE);

  // Sonnet / GPT-OSS effort untouched.
  assert.equal(MODEL_FAMILY_REGISTRY['agy:sonnet'].defaultEffort, null);
  assert.equal(MODEL_FAMILY_REGISTRY['agy:gpt-oss'].defaultEffort, 'medium');
});

test('agy:opus is the Reviewer head, shares the agy-claude-gpt pool, and resolves Opus dynamically from the catalog (never pinned)', () => {
  const reg = MODEL_FAMILY_REGISTRY['agy:opus'];
  assert.equal(reg.provider, 'agy-claude-gpt');
  assert.equal(reg.catalogPrefix, 'claude-opus-');
  assert.equal(reg.defaultEffort, null);
  assert.equal(reg.stableAlias, null);

  // No catalog -> provider default, nothing pinned.
  const dflt = resolveModelFamily('agy:opus', { env: {}, agyCatalog: null });
  assert.equal(dflt.resolvedModel, null);
  assert.equal(dflt.resolvedFrom, RESOLUTION_SOURCE.PROVIDER_DEFAULT);
  assert.equal(dflt.concreteVersionPinned, false);

  // Catalog present -> newest Opus entry, resolved from the runtime catalog,
  // and it advances with the catalog without any source edit.
  const a = resolveModelFamily('agy:opus', { env: {}, agyCatalog: ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'] });
  assert.equal(a.resolvedModel, 'claude-opus-4-6');
  assert.equal(a.resolvedFrom, RESOLUTION_SOURCE.RUNTIME_CATALOG);
  assert.equal(a.concreteVersionPinned, false);
  const b = resolveModelFamily('agy:opus', { env: {}, agyCatalog: ['claude-opus-4-6', 'claude-opus-5-0'] });
  assert.equal(b.resolvedModel, 'claude-opus-5-0');

  // Env override still pins for tests / benchmark / repro.
  const pinned = resolveModelFamily('agy:opus', { env: { REVIEWLOOP_AGY_OPUS_MODEL: 'claude-opus-4-6' }, agyCatalog: ['claude-opus-5-0'] });
  assert.equal(pinned.resolvedModel, 'claude-opus-4-6');
  assert.equal(pinned.resolvedFrom, RESOLUTION_SOURCE.ENV_OVERRIDE);
});

test('5: the durable reservation + spend record persist the ACTUAL resolved model', async () => {
  const persistence = new MemoryPersistence();
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({ text: '{"findings":[]}', model: 'gemini-3.8-flash-medium', usage: { input_tokens: 3, output_tokens: 1 } }),
    agyCatalog: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'claude-opus-4-6', 'gpt-oss-999b-medium'],
  });
  // agy:gemini-supervisor is first for supervisor and wired via reviewloop-minimal;
  // its model resolves to the newest -medium entry from the probed catalog.
  assert.equal(pool.route('supervisor').family, 'agy:gemini-supervisor');
  assert.equal(pool.route('supervisor').model, 'gemini-3.8-flash-medium');
  // agy:opus is first for reviewer and resolves the newest Opus from the catalog.
  assert.equal(pool.route('reviewer').family, 'agy:opus');
  assert.equal(pool.route('reviewer').model, 'claude-opus-4-6');

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals) => pool.route('reviewer', signals),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 5, output_tokens: 2 }, model: 'gpt-oss-999b-medium' }),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  const state = await persistence.readWorkflowState(loopId);
  const spend = state.reviewLoopSpend?.records ?? [];
  assert.ok(spend.some((rec) => rec.model === 'gpt-oss-999b-medium'), 'spend record carries the actual resolved model');
});

test('6: a resolution change still emits the MODEL_RESOLVED_CHANGED diagnostics event', () => {
  const events = [];
  let catalog = ['gemini-3.7-flash-medium'];
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    // Scope to the Supervisor Gemini head so the test observes its
    // resolution-change diagnostics directly.
    rolePolicy: { supervisor: [{ family: 'agy:gemini-supervisor', effort: 'medium' }] },
    resolveFamily: (family) => resolveModelFamily(family, { env: {}, agyCatalog: catalog }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(router.route('supervisor').resolvedModel, 'gemini-3.7-flash-medium');
  catalog = ['gemini-3.7-flash-medium', 'gemini-4.0-flash-medium'];
  router.route('supervisor');
  assert.ok(events.some((e) => e.type === 'MODEL_RESOLVED_CHANGED'
    && e.previousResolvedModel === 'gemini-3.7-flash-medium'
    && e.resolvedModel === 'gemini-4.0-flash-medium'));
});
