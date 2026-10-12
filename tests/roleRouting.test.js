import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  RoleRouter,
  ProviderHealthRegistry,
  RouteAuditLog,
  RouteAuditError,
  RoleRouterInvariantError,
  ROUTE_SKIP_REASONS,
  assertRoutePrimaryFirstInvariant,
  supportsProductionRole,
} from '../src/orchestrator/roleRouting.js';

const resolver = (family) => ({
  requestedFamily: family,
  resolvedModel: `${family}-runtime`,
  provider: family.split(':')[0],
  capabilities: { supportsReasoningEffort: true, supportedEfforts: ['medium', 'high'], roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

const REVIEWER_ORDER = ['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus'];
const SUPERVISOR_ORDER = ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus'];

test('active roles are exactly supervisor + reviewer — no planner, no executor', () => {
  assert.deepEqual(Object.keys(DEFAULT_ROLE_POLICY).sort(), ['reviewer', 'supervisor']);
  assert.equal('planner' in DEFAULT_ROLE_POLICY, false);
  assert.equal('executor' in DEFAULT_ROLE_POLICY, false);
  // Final fixed deterministic routing.
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), REVIEWER_ORDER);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), SUPERVISOR_ORDER);
  // The Reviewer Gemini head carries the fixed low effort; the Supervisor head medium.
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.find((c) => c.family === 'agy:gemini-reviewer').effort, 'low');
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.find((c) => c.family === 'agy:gemini-supervisor').effort, 'medium');
  // No family is high-context any more (all AGY families run reviewloop-minimal).
  for (const role of ['reviewer', 'supervisor']) {
    for (const c of DEFAULT_ROLE_POLICY[role]) assert.notEqual(c.highContext, true);
  }
  // GPT-OSS is a deliberate low-cost Reviewer fallback (not degraded). It is
  // NOT a Supervisor candidate: its live certification passed transport /
  // accounting / isolation but its decision output violated the Supervisor
  // schema, so it was removed from the Supervisor production pool.
  assert.notEqual(DEFAULT_ROLE_POLICY.reviewer.find((c) => c.family === 'agy:gpt-oss').degraded, true);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.some((c) => c.family === 'agy:gpt-oss'), false);
  // Neither Gemini head appears in the other role's pool.
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.some((c) => c.family === 'agy:gemini-supervisor'), false);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.some((c) => c.family === 'agy:gemini-reviewer'), false);
});

test('production capabilities are role-scoped as declared', () => {
  const ROLE_SCOPED = {
    'agy:gpt-oss': ['reviewer'],
    'agy:opus': ['reviewer'],
    'agy:gemini-reviewer': ['reviewer'],
    'agy:gemini-supervisor': ['supervisor'],
  };
  for (const [family, roles] of Object.entries(PRODUCTION_ROLE_CAPABILITIES)) {
    const expected = ROLE_SCOPED[family] ?? ['reviewer', 'supervisor'];
    assert.deepEqual([...roles].sort(), [...expected].sort(), family);
  }
  assert.equal(supportsProductionRole('codex:default', 'reviewer'), true);
  assert.equal(supportsProductionRole('claude:opus', 'supervisor'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'reviewer'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'supervisor'), false);
  assert.equal(supportsProductionRole('agy:gemini-reviewer', 'supervisor'), false);
  assert.equal(supportsProductionRole('agy:gemini-supervisor', 'reviewer'), false);
  assert.equal(supportsProductionRole('agy:opus', 'reviewer'), true);
  assert.equal(supportsProductionRole('agy:opus', 'supervisor'), false);
  assert.equal(supportsProductionRole('codex:default', 'executor'), false);
  assert.equal(supportsProductionRole('codex:default', 'planner'), false);
});

test('fixed routing: every candidate is reachable when each earlier one fails', () => {
  const rHealth = new ProviderHealthRegistry();
  const r = () => new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: rHealth, resolveFamily: resolver }).route('reviewer')?.requestedFamily ?? null;
  for (const expected of REVIEWER_ORDER) {
    assert.equal(r(), expected);
    rHealth.record(expected, 'UNAVAILABLE');
  }
  assert.equal(r(), null);

  const sHealth = new ProviderHealthRegistry();
  const s = () => new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: sHealth, resolveFamily: resolver }).route('supervisor')?.requestedFamily ?? null;
  for (const expected of SUPERVISOR_ORDER) {
    assert.equal(s(), expected);
    sHealth.record(expected, 'UNAVAILABLE');
  }
  assert.equal(s(), null); // pool exhausted — agy:gpt-oss is NOT a Supervisor candidate
});

test('agy:gpt-oss is never routed as Supervisor even when every other family is down', () => {
  const sHealth = new ProviderHealthRegistry();
  for (const f of SUPERVISOR_ORDER) sHealth.record(f, 'UNAVAILABLE');
  const sel = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: sHealth, resolveFamily: resolver }).route('supervisor');
  assert.equal(sel, null);
  // but it IS still a Reviewer candidate
  const rHealth = new ProviderHealthRegistry();
  rHealth.record('agy:opus', 'UNAVAILABLE');
  rHealth.record('agy:gemini-reviewer', 'UNAVAILABLE');
  rHealth.record('codex:default', 'UNAVAILABLE');
  rHealth.record('agy:sonnet', 'UNAVAILABLE');
  assert.equal(
    new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: rHealth, resolveFamily: resolver }).route('reviewer').requestedFamily,
    'agy:gpt-oss',
  );
});

test('the two Gemini heads share one agy-gemini quota pool; agy:opus + agy:sonnet + agy:gpt-oss share another', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('agy:opus'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:sonnet'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gpt-oss'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gemini-reviewer'), ['agy-gemini']);
  assert.deepEqual(quota.poolsFor('agy:gemini-supervisor'), ['agy-gemini']);

  // A Gemini quota-exhaustion cooldown on either role head takes BOTH out of
  // routing — one shared pool, one shared cooldown — but never the Claude&GPT
  // pool that the Reviewer primary (agy:opus) sits in.
  quota.recordProviderFailure('agy:gemini-reviewer', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(quota.usable('agy:gemini-reviewer'), false);
  assert.equal(quota.usable('agy:gemini-supervisor'), false);
  assert.equal(quota.usable('agy:opus'), true);
  assert.equal(quota.usable('agy:sonnet'), true);

  // conversely, a Claude&GPT cooldown (here triggered on agy:opus) does not
  // touch the Gemini pool, but DOES take the sibling agy:sonnet + agy:gpt-oss
  // out of routing.
  const quota2 = new QuotaPoolRegistry({ filePath: null });
  quota2.recordProviderFailure('agy:opus', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(quota2.usable('agy:opus'), false);
  assert.equal(quota2.usable('agy:sonnet'), false);
  assert.equal(quota2.usable('agy:gpt-oss'), false);
  assert.equal(quota2.usable('agy:gemini-reviewer'), true);
  assert.equal(quota2.usable('agy:gemini-supervisor'), true);
});

test('reset expiry becomes UNKNOWN', () => {
  let now = 1000;
  const quota = new QuotaPoolRegistry({ filePath: null, now: () => now });
  quota.recordCooldown('codex', { resetAt: new Date(1100).toISOString() });
  now = 1200;
  assert.equal(quota.get('codex').status, 'UNKNOWN');
});

test('provider health failure removes a family without touching policy', () => {
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), providerHealth: health, resolveFamily: resolver });
  assert.equal(router.route('reviewer').requestedFamily, 'agy:opus');
  health.record('agy:opus', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gemini-reviewer');
  health.record('agy:gemini-reviewer', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'codex:default');
});

test('quota topology no longer references claude:sonnet', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('claude:sonnet'), []);
});

// ---- durable routing-decision audit --------------------------------------

test('a bare RoleRouter (no routeAudit configured) never touches disk but still records every decision in-memory', () => {
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), resolveFamily: resolver });
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:opus');
  assert.equal(router.routeAudit.filePath, null);
  assert.ok(router.routeAudit.entries.some((e) => e.type === 'ROLE_ROUTE_SELECTED' && e.requestedFamily === 'agy:opus'));
});

test('every pre-dispatch skip is durably persisted with an enumerated reason before the router moves to the next candidate', () => {
  const audited = [];
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE');
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
  });
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  const skip = audited.find((e) => e.type === 'ROLE_ROUTE_SKIPPED' && e.candidate === 'agy:opus');
  assert.ok(skip, 'the skip of the primary candidate must be in the durable audit');
  assert.equal(skip.reason, ROUTE_SKIP_REASONS.PROVIDER_HEALTH);
  assert.ok(Object.values(ROUTE_SKIP_REASONS).includes(skip.reason));
  const select = audited.find((e) => e.type === 'ROLE_ROUTE_SELECTED');
  assert.equal(select.requestedFamily, 'agy:gemini-reviewer');
});

test('a routing-decision audit that fails to persist makes the router fail closed instead of silently skipping', () => {
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'PROVIDER_UNAVAILABLE');
  let calls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    routeAudit: new RouteAuditLog({
      sink: () => { calls += 1; throw new Error('disk full'); },
    }),
  });
  assert.throws(() => router.route('reviewer'), (err) => {
    assert.ok(err instanceof RouteAuditError);
    assert.equal(err.code, 'ROUTE_AUDIT_UNPERSISTED');
    return true;
  });
  // It must fail closed on the FIRST unpersisted decision — never fall
  // through to agy:gemini-reviewer on an unrecorded basis.
  assert.equal(calls, 1);
});

test('an unenumerated skip reason is refused before any attempt to persist it', () => {
  const audited = [];
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), resolveFamily: resolver, routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }) });
  assert.throws(() => router._decide({ type: 'ROLE_ROUTE_SKIPPED', role: 'reviewer', candidate: 'agy:opus', reason: 'made_up_reason' }), (err) => {
    assert.ok(err instanceof RouteAuditError);
    assert.equal(err.code, 'ROUTE_REASON_NOT_ENUMERATED');
    return true;
  });
  assert.equal(audited.length, 0, 'a reason that is not in the enum must never reach the audit sink');
});

// ---- primary-first invariant ----------------------------------------------

test('primary-first invariant: whenever agy:opus is READY, the Reviewer first real dispatch selects it', () => {
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), resolveFamily: resolver });
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:opus');
});

test('assertRoutePrimaryFirstInvariant is a no-op when the primary itself was selected', () => {
  assert.doesNotThrow(() => assertRoutePrimaryFirstInvariant(DEFAULT_ROLE_POLICY, 'reviewer', 'agy:opus', []));
});

test('assertRoutePrimaryFirstInvariant throws when the primary was bypassed without ever being evaluated', () => {
  assert.throws(
    () => assertRoutePrimaryFirstInvariant(DEFAULT_ROLE_POLICY, 'reviewer', 'codex:default', []),
    (err) => { assert.ok(err instanceof RoleRouterInvariantError); assert.equal(err.code, 'ROUTE_PRIMARY_NOT_EVALUATED'); return true; },
  );
});

test('assertRoutePrimaryFirstInvariant throws when the primary was skipped for a non-enumerated reason', () => {
  assert.throws(
    () => assertRoutePrimaryFirstInvariant(DEFAULT_ROLE_POLICY, 'reviewer', 'codex:default', [
      { candidate: 'agy:opus', reason: 'vibes', persisted: true },
    ]),
    (err) => { assert.ok(err instanceof RoleRouterInvariantError); assert.equal(err.code, 'ROUTE_PRIMARY_REASON_NOT_ENUMERATED'); return true; },
  );
});

test('assertRoutePrimaryFirstInvariant passes when the primary was skipped for a persisted, enumerated reason', () => {
  assert.doesNotThrow(() => assertRoutePrimaryFirstInvariant(DEFAULT_ROLE_POLICY, 'reviewer', 'codex:default', [
    { candidate: 'agy:opus', reason: ROUTE_SKIP_REASONS.PROVIDER_HEALTH, persisted: true },
    { candidate: 'agy:gemini-reviewer', reason: ROUTE_SKIP_REASONS.PROVIDER_HEALTH, persisted: true },
  ]));
});

// ---- zero-token stale-health revalidation ---------------------------------

test('a stale provider_health skip is revalidated with a zero-token probe and recovers the primary', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'startup isolation probe failed');
  let revalidatorCalls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    healthRevalidator: (family) => {
      revalidatorCalls += 1;
      return family === 'agy:opus' ? { available: true, reason: 'zero-token re-probe ok' } : null;
    },
  });
  now = 2000; // past the TTL
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:opus');
  assert.equal(revalidatorCalls, 1);
  assert.equal(health.get('agy:opus').status, 'READY');
});

test('a stale provider_health skip that revalidation confirms is still down stays skipped, durably, and is not re-probed immediately again', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'startup isolation probe failed');
  const audited = [];
  let revalidatorCalls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
    healthRevalidator: () => { revalidatorCalls += 1; return { available: false, reason: 'still broken' }; },
  });
  now = 2000;
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  assert.equal(revalidatorCalls, 1);
  const skip = audited.find((e) => e.type === 'ROLE_ROUTE_SKIPPED' && e.candidate === 'agy:opus');
  assert.equal(skip.revalidated, true);
  assert.equal(skip.healthReason, 'still broken');
  // Immediately calling again must not re-probe: checkedAt was refreshed, so
  // this call is no longer stale relative to `now`.
  router.route('reviewer');
  assert.equal(revalidatorCalls, 1);
});

test('a fresh (non-stale) provider_health skip is never revalidated even when a revalidator is configured', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'just failed');
  let revalidatorCalls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    healthRevalidator: () => { revalidatorCalls += 1; return { available: true }; },
  });
  now = 500; // well under the TTL
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  assert.equal(revalidatorCalls, 0);
});

test('AUTH_FAILED health entries are never auto-revalidated regardless of staleness', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'AUTH_FAILED', 'PROVIDER_AUTH_FAILED');
  let revalidatorCalls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    healthRevalidator: () => { revalidatorCalls += 1; return { available: true }; },
  });
  now = 999999;
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  assert.equal(revalidatorCalls, 0, 'an auth failure must never be auto-cleared by the stale-health path');
});

test('a revalidator that throws is treated as still unavailable — never silently trusted', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'startup isolation probe failed');
  const audited = [];
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
    healthRevalidator: () => { throw new Error('probe process crashed'); },
  });
  now = 2000;
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  const skip = audited.find((e) => e.type === 'ROLE_ROUTE_SKIPPED' && e.candidate === 'agy:opus');
  assert.match(skip.healthReason, /revalidator_threw/);
});

test('the revalidator sees the full blocking entry (including reasonCode), not just family/provider', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'timed out', { reasonCode: 'PROVIDER_TIMEOUT' });
  let seenEntry = null;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    now: () => now,
    staleHealthTtlMs: 1000,
    healthRevalidator: (family, provider, entry) => { seenEntry = entry; return null; },
  });
  now = 2000;
  router.route('reviewer');
  assert.equal(seenEntry.reasonCode, 'PROVIDER_TIMEOUT');
  assert.equal(seenEntry.status, 'UNAVAILABLE');
});

// ---- transport-availability gate ------------------------------------------

test('a family the resolver reports has no wired transport is never selected, regardless of health', () => {
  const health = new ProviderHealthRegistry(); // pristine — health alone would allow agy:opus
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: (family) => ({
      ...resolver(family),
      transportAvailable: family !== 'agy:opus', // only agy:opus lacks a transport
    }),
  });
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
});

test('a resolver that never declares transportAvailable stays exactly as permissive as before this feature (backward compatible)', () => {
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), resolveFamily: resolver }); // resolver never sets transportAvailable
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:opus');
});

test('the transport gate is checked before health — a family with no transport is never even offered to the revalidator', () => {
  let now = 0;
  const health = new ProviderHealthRegistry({ now: () => now });
  health.record('agy:opus', 'UNAVAILABLE', 'x', { reasonCode: 'AGY_PROVISIONING_FAILED' });
  let revalidatorCalls = 0;
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: (family) => ({ ...resolver(family), transportAvailable: family !== 'agy:opus' }),
    now: () => now,
    staleHealthTtlMs: 1000,
    healthRevalidator: () => { revalidatorCalls += 1; return { available: true }; },
  });
  now = 2000;
  const sel = router.route('reviewer');
  assert.equal(sel.requestedFamily, 'agy:gemini-reviewer');
  assert.equal(revalidatorCalls, 0, 'a family with no transport must never be re-probed — there is nothing recovery could make dispatchable');
});

// ---- per-call audit attribution (no shared mutable router state) ---------

test('interleaved route() calls with different requestContext never cross-contaminate audit attribution', () => {
  const audited = [];
  const health = new ProviderHealthRegistry();
  health.record('agy:opus', 'UNAVAILABLE', 'x', { reasonCode: 'PROVIDER_TIMEOUT' });
  const router = new RoleRouter({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: health,
    resolveFamily: resolver,
    routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }),
  });
  // Simulates two concurrent loops interleaving their calls through the SAME
  // (singleton, process-lifetime) router instance.
  router.route('reviewer', {}, { loopId: 'loop-A', round: 1, operationId: 'op-A-1', attempt: 1 });
  router.route('reviewer', {}, { loopId: 'loop-B', round: 7, operationId: 'op-B-1', attempt: 1 });
  router.route('reviewer', {}, { loopId: 'loop-A', round: 2, operationId: 'op-A-2', attempt: 1 });
  router.route('reviewer', {}, { loopId: 'loop-B', round: 8, operationId: 'op-B-2', attempt: 1 });

  const a = audited.filter((e) => e.loopId === 'loop-A');
  const b = audited.filter((e) => e.loopId === 'loop-B');
  assert.ok(a.length > 0 && b.length > 0);
  assert.ok(a.every((e) => e.operationId.startsWith('op-A')), 'loop A entries must never carry loop B operationIds');
  assert.ok(b.every((e) => e.operationId.startsWith('op-B')), 'loop B entries must never carry loop A operationIds');
  const aRounds = [...new Set(a.map((e) => e.round))].sort();
  const bRounds = [...new Set(b.map((e) => e.round))].sort();
  assert.deepEqual(aRounds, [1, 2]);
  assert.deepEqual(bRounds, [7, 8]);
});

test('route() with no requestContext attributes null attribution rather than reusing a prior call\'s context', () => {
  const audited = [];
  const router = new RoleRouter({ quotaRegistry: new QuotaPoolRegistry({ filePath: null }), resolveFamily: resolver, routeAudit: new RouteAuditLog({ sink: (e) => audited.push(e) }) });
  router.route('reviewer', {}, { loopId: 'loop-A', round: 3 });
  router.route('reviewer'); // no requestContext this time
  const last = audited[audited.length - 1];
  assert.equal(last.loopId, null);
  assert.equal(last.round, null);
});
