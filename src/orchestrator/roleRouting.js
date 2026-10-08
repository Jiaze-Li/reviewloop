// Deterministic, zero-token role routing.  Policy, quota, transport health,
// effort and physical-session decisions deliberately live in separate modules.
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, statSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ReviewLoop active model roles are exactly: supervisor, reviewer.
// The Worker (the coding agent the user is talking to) is OUTSIDE role routing
// entirely — ReviewLoop never selects, spawns, budgets, or model-restricts it.
// There is no `planner` and no `executor` role: execution is Worker-owned.
// The `highContext: true` mechanism still exists (a caller must opt in with
// `signals.allowHighContext === true` for such a candidate to be chosen), but
// NO production family is marked high-context today — nothing is excluded from
// automatic routing on that basis. Every AGY family runs through the
// `reviewloop-minimal` custom agent (`inheritCustomizations: false`) discovered
// from an isolated redirected gemini dir (`--gemini_dir`), with startup +
// per-call effective-loading verification and fail-closed on any mismatch (agy
// never silently falls back to its ambient default agent). The definitive
// isolated-agent live result is the medium-effort Gemini Supervisor
// (family agy:gemini-supervisor): usageVolume 2933, effectiveLoadingVerified.
// Earlier ~150.7k / ~6.7k figures were pre-verification and are NOT a baseline.
// See docs/ARCHITECTURE.md.
//
// Fixed deterministic routing (NO risk-based selection). Automatic failover
// walks the whole list in order on any safe retryable provider/quota failure
// until the pool is exhausted; every listed candidate is mechanically reachable
// (asserted by the pool-completeness + traversal tests). Normal production
// path: Worker = Claude (external) / Reviewer = AGY Claude Opus (agy:opus, AGY
// "Claude & GPT" pool) / Supervisor = AGY Gemini (medium effort, AGY Gemini
// pool) — the two role primaries sit in DIFFERENT quota pools on purpose. The
// two Gemini heads are distinct role-specific family identities
// (agy:gemini-reviewer / agy:gemini-supervisor) with a FIXED per-role reasoning
// effort baked into the family — see modelFamilyResolver.js. They share the one
// `agy-gemini` quota pool.
export const DEFAULT_ROLE_POLICY = Object.freeze({
  // agy:gpt-oss is NOT a Supervisor candidate: its live certification passed
  // transport / accounting / isolation but its decision output violated the
  // Supervisor schema (recommendation must be exactly "REWORK" or
  // "HUMAN_REQUIRED", never a disjunction). It remains a Reviewer candidate.
  supervisor: Object.freeze([
    { family: 'agy:gemini-supervisor', effort: 'medium' },
    { family: 'codex:default', effort: 'medium' },
    { family: 'agy:sonnet', effort: 'medium' },
    { family: 'claude:opus', effort: 'medium' },
  ]),
  //
  // The Reviewer first choice (agy:opus, AGY "Claude & GPT" pool) is
  // deliberately a DIFFERENT quota pool from the Supervisor first choice
  // (agy:gemini-supervisor, AGY Gemini pool) so a quota cooldown on one role's
  // primary never silently disables the other role's primary too. agy:opus is
  // Reviewer-only — it is NOT added to the Supervisor pool.
  reviewer: Object.freeze([
    { family: 'agy:opus', effort: 'medium' },
    { family: 'agy:gemini-reviewer', effort: 'low' },
    { family: 'codex:default', effort: 'medium' },
    { family: 'agy:sonnet', effort: 'medium' },
    { family: 'agy:gpt-oss', effort: 'medium' },
    { family: 'claude:opus', effort: 'medium' },
  ]),
});

// agy:opus + agy:sonnet + agy:gpt-oss share ONE AGY "Claude & GPT" quota pool
// (`agy-claude-gpt`): a quota-exhaustion cooldown on any one takes the other
// two out of routing without a wasted probe call. agy:gemini-reviewer +
// agy:gemini-supervisor likewise share ONE SEPARATE `agy-gemini` pool: a
// Gemini quota/rate cooldown on either role head cools the other too.
export const DEFAULT_QUOTA_TOPOLOGY = Object.freeze({
  'codex:default': ['codex'],
  'claude:opus': ['claude'],
  'agy:gemini-reviewer': ['agy-gemini'],
  'agy:gemini-supervisor': ['agy-gemini'],
  'agy:opus': ['agy-claude-gpt'],
  'agy:sonnet': ['agy-claude-gpt'],
  'agy:gpt-oss': ['agy-claude-gpt'],
});

// This is a declaration of *protocol adapters*, not of installed CLIs or
// accounts.  A family is eligible for a role only when the production
// composition supplies an adapter implementing that role's wire protocol.
// Keep unsupported pairs in DEFAULT_ROLE_POLICY: policy can enable a future
// adapter without pretending it exists today.
export const PRODUCTION_ROLE_CAPABILITIES = Object.freeze({
  'codex:default': Object.freeze(['supervisor', 'reviewer']),
  // Role-scoped by design: each Gemini head carries a fixed effort for exactly
  // one role, so the router must never select the low-effort Reviewer head for
  // a Supervisor escalation (or vice versa).
  'agy:gemini-reviewer': Object.freeze(['reviewer']),
  'agy:gemini-supervisor': Object.freeze(['supervisor']),
  // AGY-hosted Claude Opus is enabled for the Reviewer role only for now; the
  // Supervisor pool is deliberately left unchanged.
  'agy:opus': Object.freeze(['reviewer']),
  'agy:sonnet': Object.freeze(['supervisor', 'reviewer']),
  // Reviewer-only: certified Supervisor transport/accounting/isolation but its
  // decision output does not conform to the Supervisor schema.
  'agy:gpt-oss': Object.freeze(['reviewer']),
  'claude:opus': Object.freeze(['supervisor', 'reviewer']),
});

export function supportsProductionRole(family, role) {
  return PRODUCTION_ROLE_CAPABILITIES[family]?.includes(role) ?? false;
}

export const POOL_STATUS = Object.freeze({ READY: 'READY', UNKNOWN: 'UNKNOWN', COOLDOWN: 'COOLDOWN' });
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function nowIso(now) { return new Date(now).toISOString(); }

export class QuotaPoolRegistry {
  constructor({ filePath = path.join(os.homedir(), '.reviewloop', 'quota-pools.json'), topology = DEFAULT_QUOTA_TOPOLOGY, now = () => Date.now(), baseBackoffMs = DEFAULT_BACKOFF_MS } = {}) {
    this.filePath = filePath; this.topology = { ...topology }; this.now = now; this.baseBackoffMs = baseBackoffMs;
    this.pools = {};
    this._loadedMtimeMs = null;
    this.refresh();
  }
  // Disk-backed registries re-read the file when another process (or a
  // restarted MCP server) changed it, so a cooldown recorded anywhere is seen
  // everywhere. An unreadable file keeps the last in-memory view rather than
  // silently clearing cooldowns.
  refresh() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const mtimeMs = statSync(this.filePath).mtimeMs;
      if (mtimeMs === this._loadedMtimeMs) return;
      this.pools = JSON.parse(readFileSync(this.filePath, 'utf8')).pools ?? {};
      this._loadedMtimeMs = mtimeMs;
    } catch { /* keep current view */ }
  }
  persist() {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: 'reviewloop.quota-pools/v1', pools: this.pools }, null, 2)}\n`);
    renameSync(tmp, this.filePath);
    try { this._loadedMtimeMs = statSync(this.filePath).mtimeMs; } catch { /* ignore */ }
  }
  poolsFor(family) { return [...(this.topology[family] ?? [])]; }
  setTopology(family, poolIds) { this.topology[family] = [...new Set(poolIds)]; }
  get(poolId) {
    this.refresh();
    const pool = this.pools[poolId] ?? { poolId, status: POOL_STATUS.UNKNOWN, reason: 'unknown', checkedAt: null, cooldownSince: null, resetAt: null, retryAfter: null, source: 'cached', failures: 0 };
    if (pool.status === POOL_STATUS.COOLDOWN && pool.resetAt && Date.parse(pool.resetAt) <= this.now()) {
      pool.status = POOL_STATUS.UNKNOWN; pool.reason = 'unknown'; pool.checkedAt = nowIso(this.now()); pool.resetAt = null; pool.retryAfter = null;
      this.pools[poolId] = pool; this.persist();
    }
    return copy(pool);
  }
  usable(family) { return this.poolsFor(family).every((poolId) => this.get(poolId).status !== POOL_STATUS.COOLDOWN); }
  recordReady(poolId, { source = 'runtime_probe' } = {}) {
    this.pools[poolId] = { ...this.get(poolId), status: POOL_STATUS.READY, reason: null, checkedAt: nowIso(this.now()), cooldownSince: null, resetAt: null, retryAfter: null, source, failures: 0 }; this.persist();
  }
  recordCooldown(poolId, { reason = 'quota_exhausted', resetAt = null, retryAfter = null, source = 'provider_error' } = {}) {
    this.refresh();
    const prior = this.get(poolId); const failures = (prior.failures ?? 0) + 1;
    const resetMillis = resetAt ? Date.parse(resetAt) : (Number.isFinite(retryAfter) ? this.now() + retryAfter : this.now() + this.baseBackoffMs * (2 ** Math.min(failures - 1, 5)));
    this.pools[poolId] = { poolId, status: POOL_STATUS.COOLDOWN, reason, checkedAt: nowIso(this.now()), cooldownSince: nowIso(this.now()), resetAt: Number.isFinite(resetMillis) ? nowIso(resetMillis) : null, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null, source: resetAt || retryAfter ? source : 'inferred_backoff', failures }; this.persist();
  }
  recordProviderFailure(family, failure = {}) {
    if (!['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMITED'].includes(failure.code)) return;
    for (const poolId of this.poolsFor(family)) this.recordCooldown(poolId, { reason: failure.code === 'PROVIDER_RATE_LIMITED' ? 'rate_limited' : 'quota_exhausted', resetAt: failure.resetAt, retryAfter: failure.retryAfter, source: 'provider_error' });
  }
  summary() { return [...new Set(Object.values(this.topology).flat())].map((poolId) => this.get(poolId)); }
}

export class ProviderHealthRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.providers = new Map();
    this.candidates = new Map();
  }
  get(target) {
    return this.candidates.get(target) ?? this.providers.get(target) ?? { provider: target, status: 'UNKNOWN', checkedAt: null, reason: null };
  }
  // `reasonCode` is a structured, enumerated classification of WHY (distinct
  // from `reason`, a free-text detail) — e.g. 'AGY_PROVISIONING_FAILED' vs
  // 'AGY_EFFECTIVE_LOADING_FAILED' vs a post-dispatch PROVIDER_TIMEOUT. A
  // stale-health revalidator MUST look at this before claiming recovery: it
  // can only legitimately re-verify the failure class it actually re-probes,
  // never every UNAVAILABLE regardless of origin.
  record(target, status, reason = null, { reasonCode = null } = {}) {
    const entry = {
      provider: target, status, reason, reasonCode, checkedAt: nowIso(this.now()),
    };
    if (typeof target === 'string' && target.includes(':')) {
      this.candidates.set(target, entry);
    } else {
      this.providers.set(target, entry);
    }
  }
  // The single source of truth for "is this candidate blocked?" — usable()
  // and the router's stale-health revalidation both go through this so they
  // can never disagree about which entry (candidate-specific vs shared
  // provider) is the one actually blocking dispatch.
  blockingEntry(target, provider = null) {
    const cand = this.candidates.get(target);
    if (cand && (cand.status === 'UNAVAILABLE' || cand.status === 'AUTH_FAILED')) return { scope: 'candidate', key: target, entry: cand };
    if (provider) {
      const prov = this.providers.get(provider);
      if (prov && (prov.status === 'UNAVAILABLE' || prov.status === 'AUTH_FAILED')) return { scope: 'provider', key: provider, entry: prov };
    }
    const direct = this.providers.get(target);
    if (direct && (direct.status === 'UNAVAILABLE' || direct.status === 'AUTH_FAILED')) return { scope: 'provider', key: target, entry: direct };
    return null;
  }
  usable(target, provider = null) { return this.blockingEntry(target, provider) === null; }
}

export class EffortPolicy {
  select({ candidate, capabilities = {}, signals = {} } = {}) {
    if (!capabilities.supportsReasoningEffort) return null;
    const supported = capabilities.supportedEfforts ?? ['medium'];
    const high = signals.reasoningFailures > 0 || signals.reworkCycles >= 2 || signals.highRisk === true;
    return high && supported.includes('high') ? 'high' : (candidate.effort ?? 'medium');
  }
}

// Every reason the router is allowed to skip a candidate for, closed over a
// fixed enum. A skip reason that is not one of these is refused outright
// (see RoleRouter#_decide) rather than silently let through as a bare
// string — an unenumerated reason is exactly the shape a future bug would
// take (a typo, a new code path that forgot to register its reason here).
export const ROUTE_SKIP_REASONS = Object.freeze({
  CAPABILITY: 'capability',
  HIGH_CONTEXT: 'high_context',
  QUOTA_COOLDOWN: 'quota_cooldown',
  PROVIDER_HEALTH: 'provider_health',
  // Per-operation exclusion supplied by the controller after a bounded
  // attempt-local transient recovery budget is exhausted. This is deliberately
  // NOT provider health: the next independent review should be free to try the
  // family again after the network path recovers.
  OPERATION_EXCLUDED: 'operation_excluded',
  // No transport function is actually wired for this family in THIS process
  // — independent of what health/quota say. Checked before health so a
  // family that was never wired is never even offered to revalidation.
  NO_TRANSPORT: 'no_transport',
});
const ROUTE_SKIP_REASON_VALUES = new Set(Object.values(ROUTE_SKIP_REASONS));

export class RouteAuditError extends Error {
  constructor(message, { code = 'ROUTE_AUDIT_FAILED' } = {}) {
    super(message);
    this.name = 'RouteAuditError';
    this.code = code;
  }
}

export class RoleRouterInvariantError extends Error {
  constructor(message, { code = 'ROUTE_INVARIANT_VIOLATED' } = {}) {
    super(message);
    this.name = 'RoleRouterInvariantError';
    this.code = code;
  }
}

// Durable record of every routing decision (selected AND skipped), keyed by
// nothing more than append order — this is an audit trail, not a queryable
// index. Two backends:
//   - `sink(entry)` — caller-supplied, e.g. an in-memory collector for tests
//     or assertions on a specific failure mode (throw to simulate a write
//     failure and exercise the router's fail-closed path).
//   - `filePath` — appended as newline-delimited JSON (survives process
//     restart; this is what makes the audit "durable" rather than a
//     same-process-only in-memory event).
// With neither configured, entries still accumulate in `.entries` (in
// process memory only) so a bare `new RoleRouter()` — as dozens of existing
// unit tests construct it — never touches disk. Production wiring is the one
// place that opts into the disk-backed form; see
// createReviewLoopMcpServer()'s routeAudit construction.
export class RouteAuditLog {
  constructor({ filePath = null, sink = null, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.sink = sink;
    this.now = now;
    this.entries = [];
  }
  record(entry) {
    const full = { at: nowIso(this.now()), ...entry };
    try {
      if (typeof this.sink === 'function') {
        this.sink(full);
      } else if (this.filePath) {
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        appendFileSync(this.filePath, `${JSON.stringify(full)}\n`);
      }
      this.entries.push(full);
      return { persisted: true, entry: full };
    } catch (err) {
      return { persisted: false, error: err?.message ?? String(err), entry: full };
    }
  }
}

// Reviewer's primary-first invariant: whenever the role's first-listed
// candidate was actually selected, the invariant holds trivially. Whenever
// something else was selected instead, the primary MUST appear among the
// skipped candidates with an enumerated reason that was itself durably
// persisted — i.e. the router can always answer "why didn't you pick the
// primary?" from the audit trail, not from best-effort reasoning after the
// fact. Exported standalone (not just exercised indirectly through route())
// so it has one direct, focused test.
export function assertRoutePrimaryFirstInvariant(rolePolicy, role, selectedFamily, skippedThisCall) {
  const primary = (rolePolicy[role] ?? [])[0]?.family;
  if (!primary || selectedFamily === primary) return;
  const primarySkip = skippedThisCall.find((s) => s.candidate === primary);
  if (!primarySkip) {
    throw new RoleRouterInvariantError(
      `primary-first invariant violated for role "${role}": ${primary} was never evaluated before selecting ${selectedFamily}`,
      { code: 'ROUTE_PRIMARY_NOT_EVALUATED' },
    );
  }
  if (!ROUTE_SKIP_REASON_VALUES.has(primarySkip.reason)) {
    throw new RoleRouterInvariantError(
      `primary-first invariant violated for role "${role}": ${primary} was skipped for a non-enumerated reason "${primarySkip.reason}"`,
      { code: 'ROUTE_PRIMARY_REASON_NOT_ENUMERATED' },
    );
  }
  if (!primarySkip.persisted) {
    throw new RoleRouterInvariantError(
      `primary-first invariant violated for role "${role}": ${primary} was skipped without a durably persisted reason`,
      { code: 'ROUTE_PRIMARY_SKIP_UNPERSISTED' },
    );
  }
}

export class RoleRouter {
  constructor({
    rolePolicy = DEFAULT_ROLE_POLICY,
    quotaRegistry = new QuotaPoolRegistry(),
    providerHealth = new ProviderHealthRegistry(),
    effortPolicy = new EffortPolicy(),
    resolveFamily = (family) => ({ requestedFamily: family, resolvedModel: null, provider: family.split(':')[0], capabilities: {} }),
    onEvent,
    // Durable routing-decision audit. In-memory-only by default (see
    // RouteAuditLog) so bare construction — as most tests do — never touches
    // disk; production wiring injects a disk-backed instance.
    routeAudit = new RouteAuditLog(),
    // Zero-token, synchronous re-probe for a candidate whose health record is
    // stale: (family, provider, entry) -> { available: boolean, reason?:
    // string } | null | undefined, where `entry` is the FULL blocking health
    // entry (status/reason/reasonCode/checkedAt) so the revalidator can
    // refuse to opine on a failure class it cannot actually re-verify
    // zero-token. null/undefined means "no opinion" (the stale record is
    // trusted as-is, i.e. current behaviour). Never call a model here — it
    // must be a cheap local check (file/process probe), never a paid one.
    healthRevalidator = null,
    // A provider_health skip older than this is eligible for revalidation.
    // AUTH_FAILED entries are never auto-revalidated (an auth break needs a
    // human, not a retry loop).
    staleHealthTtlMs = 10 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.rolePolicy = rolePolicy ?? DEFAULT_ROLE_POLICY; this.quotaRegistry = quotaRegistry; this.providerHealth = providerHealth; this.effortPolicy = effortPolicy; this.resolveFamily = resolveFamily; this.onEvent = onEvent; this.resolutions = new Map();
    this.routeAudit = routeAudit; this.healthRevalidator = healthRevalidator; this.staleHealthTtlMs = staleHealthTtlMs; this.now = now;
  }
  // Persist ONE routing decision (a skip or a selection). Fails closed:
  // - an unenumerated skip reason is refused before any attempt to persist it
  // - a persistence failure (disk error, or a test sink that throws) aborts
  //   the whole route() call rather than silently falling through to the
  //   next candidate on an unrecorded basis.
  // The legacy in-memory onEvent hook still fires with the exact same event
  // shape as before this feature existed — nothing that already listens on
  // onEvent observes a difference.
  // `requestContext` is passed in FRESH by the caller on every route() call
  // (see route() below) — never read from shared instance state. RoleRouter
  // is constructed once and reused across every loop/round for the life of
  // the process, so attribution can only be correct if it travels with the
  // call, not with the (singleton, concurrently-shared) router instance.
  _decide(rawEntry, requestContext = {}) {
    if (rawEntry.type === 'ROLE_ROUTE_SKIPPED' && !ROUTE_SKIP_REASON_VALUES.has(rawEntry.reason)) {
      throw new RouteAuditError(
        `refusing to skip ${rawEntry.candidate} for role ${rawEntry.role}: reason "${rawEntry.reason}" is not an enumerated skip reason`,
        { code: 'ROUTE_REASON_NOT_ENUMERATED' },
      );
    }
    const result = this.routeAudit.record({
      ...rawEntry,
      loopId: requestContext.loopId ?? null,
      round: requestContext.round ?? null,
      operationId: requestContext.operationId ?? null,
      attempt: requestContext.attempt ?? null,
      chunkIndex: requestContext.chunkIndex ?? null,
      chunkTotal: requestContext.chunkTotal ?? null,
    });
    this.onEvent?.(rawEntry);
    if (!result.persisted) {
      const label = rawEntry.type === 'ROLE_ROUTE_SKIPPED' ? `skip ${rawEntry.candidate}` : `select ${rawEntry.requestedFamily}`;
      throw new RouteAuditError(
        `refusing to ${label} for role ${rawEntry.role}: routing-decision audit failed to persist (${result.error ?? 'unknown error'})`,
        { code: 'ROUTE_AUDIT_UNPERSISTED' },
      );
    }
    return result;
  }
  // Given a provider_health block on `candidate`, decide whether to trust it
  // as-is or spend a zero-token re-probe to see if it has since cleared.
  // Returns the (possibly updated) block, or null if revalidation recovered
  // the candidate. The revalidator sees the ORIGINAL entry (including
  // reasonCode) so it can refuse to claim recovery for a failure class it
  // cannot actually re-verify (e.g. a provisioning-only probe must not
  // clear an effective-loading failure, or a post-dispatch provider error).
  _resolveHealthBlock(block, candidate, provider) {
    if (!block || block.entry.status !== 'UNAVAILABLE' || typeof this.healthRevalidator !== 'function') {
      return block ? { ...block, revalidated: false, staleMs: null } : null;
    }
    const staleMs = block.entry.checkedAt ? (this.now() - Date.parse(block.entry.checkedAt)) : Infinity;
    if (!(staleMs > this.staleHealthTtlMs)) return { ...block, revalidated: false, staleMs };
    let verdict = null;
    try {
      verdict = this.healthRevalidator(candidate.family, provider, block.entry);
    } catch (err) {
      verdict = { available: false, reason: `revalidator_threw: ${err?.message ?? String(err)}` };
    }
    if (!verdict) return { ...block, revalidated: false, staleMs };
    if (verdict.available === true) {
      this.providerHealth.record(block.key, 'READY', verdict.reason ?? 'zero-token stale-health revalidation confirmed availability');
      return null; // recovered — no longer blocking
    }
    // Still down: refresh checkedAt so the same call isn't re-revalidated on
    // every single route() invocation until the TTL elapses again. Preserve
    // the original reasonCode — the underlying failure class hasn't changed.
    this.providerHealth.record(block.key, block.entry.status, verdict.reason ?? block.entry.reason, { reasonCode: block.entry.reasonCode ?? null });
    const refreshed = this.providerHealth.blockingEntry(candidate.family, provider);
    return { ...(refreshed ?? block), revalidated: true, staleMs };
  }
  // `requestContext` (loopId/round/operationId/attempt/chunkIndex/
  // chunkTotal) is OPTIONAL, per-call attribution for the durable audit —
  // never stored on `this`. Production wiring supplies it from
  // meteredWithFailover, which already has every one of these fields in
  // scope for the physical call it is about to make.
  route(role, signals = {}, requestContext = {}) {
    const candidates = this.rolePolicy[role] ?? [];
    const skippedThisCall = [];
    for (const candidate of candidates) {
      const resolved = this.resolveFamily(candidate.family) ?? {}; const provider = resolved.provider ?? candidate.family.split(':')[0];
      if (resolved.resolvedModel && this.resolutions.has(candidate.family) && this.resolutions.get(candidate.family) !== resolved.resolvedModel) this.onEvent?.({ type: 'MODEL_RESOLVED_CHANGED', requestedFamily: candidate.family, previousResolvedModel: this.resolutions.get(candidate.family), resolvedModel: resolved.resolvedModel });
      if (resolved.resolvedModel) this.resolutions.set(candidate.family, resolved.resolvedModel);
      const recordSkip = (reason, extra = {}) => {
        const raw = { type: 'ROLE_ROUTE_SKIPPED', role, candidate: candidate.family, reason, ...extra };
        const result = this._decide(raw, requestContext);
        skippedThisCall.push({ candidate: candidate.family, reason, persisted: result.persisted });
      };
      // `roles` is an explicit adapter declaration. An empty declaration is
      // unsupported too; do not turn a missing adapter into a token-bearing
      // probe.  Resolvers that predate capability metadata remain compatible.
      if (Array.isArray(resolved.capabilities?.roles) && !resolved.capabilities.roles.includes(role)) { recordSkip(ROUTE_SKIP_REASONS.CAPABILITY); continue; }
      // A high-context family is excluded from automatic selection unless a
      // caller explicitly opts in. Purely deterministic — never a token probe.
      if (candidate.highContext && signals.allowHighContext !== true) { recordSkip(ROUTE_SKIP_REASONS.HIGH_CONTEXT); continue; }
      const excludedFamilies = Array.isArray(signals.excludeFamilies) ? signals.excludeFamilies : [];
      if (excludedFamilies.includes(candidate.family)) {
        recordSkip(ROUTE_SKIP_REASONS.OPERATION_EXCLUDED);
        continue;
      }
      if (!this.quotaRegistry.usable(candidate.family)) { recordSkip(ROUTE_SKIP_REASONS.QUOTA_COOLDOWN, { pools: this.quotaRegistry.poolsFor(candidate.family) }); continue; }
      // No transport wired for this family in THIS process at all (e.g. AGY
      // isolation never came up at startup) — never selectable regardless of
      // what health/quota say, and checked BEFORE health so a family that
      // could never be dispatched is never even offered to revalidation.
      // `undefined` (a resolver that predates this field) never blocks —
      // strictly opt-in, so every pre-existing resolveFamily stays exactly
      // as permissive as before.
      if (resolved.transportAvailable === false) { recordSkip(ROUTE_SKIP_REASONS.NO_TRANSPORT); continue; }
      const healthBlock = this._resolveHealthBlock(this.providerHealth.blockingEntry(candidate.family, provider), candidate, provider);
      if (healthBlock) {
        recordSkip(ROUTE_SKIP_REASONS.PROVIDER_HEALTH, {
          healthScope: healthBlock.scope, healthStatus: healthBlock.entry.status, healthReason: healthBlock.entry.reason,
          healthReasonCode: healthBlock.entry.reasonCode ?? null,
          revalidated: healthBlock.revalidated, staleMs: Number.isFinite(healthBlock.staleMs) ? healthBlock.staleMs : null,
        });
        continue;
      }
      const effort = this.effortPolicy.select({ candidate, capabilities: resolved.capabilities, signals });
      const selected = { role, requestedFamily: candidate.family, resolvedModel: resolved.resolvedModel ?? null, provider, quotaPools: this.quotaRegistry.poolsFor(candidate.family), effort, degraded: Boolean(candidate.degraded) };
      this._decide({ type: 'ROLE_ROUTE_SELECTED', ...selected }, requestContext);
      assertRoutePrimaryFirstInvariant(this.rolePolicy, role, selected.requestedFamily, skippedThisCall);
      return selected;
    }
    this.routeAudit.record({
      type: 'ROLE_ROUTE_POOL_EXHAUSTED',
      role,
      loopId: requestContext.loopId ?? null,
      round: requestContext.round ?? null,
      operationId: requestContext.operationId ?? null,
      attempt: requestContext.attempt ?? null,
    });
    return null;
  }
  recordFailure(selection, failure) {
    this.quotaRegistry.recordProviderFailure(selection.requestedFamily, failure);
    if (['PROVIDER_AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_PROTOCOL_ERROR', 'PROVIDER_TIMEOUT', 'EXECUTOR_TIMEOUT'].includes(failure.code)) {
      // Record failure on the specific candidate family so other models under the same provider remain eligible.
      // reasonCode = the failure code itself: a post-dispatch provider error
      // is its own, already-enumerated failure class — a provisioning-only
      // zero-token revalidator must never claim it can clear this.
      this.providerHealth.record(
        selection.requestedFamily,
        failure.code === 'PROVIDER_AUTH_FAILED' ? 'AUTH_FAILED' : 'UNAVAILABLE',
        failure.code,
        { reasonCode: failure.code },
      );
    }
    this.onEvent?.({ type: 'ROLE_PROVIDER_FAILED', role: selection.role, family: selection.requestedFamily, reason: failure.code });
  }
}
