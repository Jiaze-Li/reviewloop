// ReviewLoop Token Safety — scoped to ReviewLoop-owned model spend only.
//
// Active metered internal roles: Reviewer, Supervisor. (No Planner, no
// Executor — the Worker's own token usage is external and NOT observable by
// ReviewLoop; it is reported as "external / not observable", never as zero.)
//
// Preserved invariants:
//   UNKNOWN != ZERO
//   CallIntent -> authorize -> PhysicalCallPermit -> dispatch -> SETTLED_KNOWN | UNRESOLVED
//   NO NEW INFORMATION -> NO NEW MODEL CALL
//
// The aggregate ReviewLoop budget (call counts, usageVolume, costUsd) is
// DURABLE and keyed by loopId: it accumulates across every reviewloop_review
// round, every phase gate, Supervisor calls, and process restart/resume. Phase
// boundaries never reset the task-wide spend or Token Sentinel. A
// crash after provider settlement but before controller state save can never
// reset the budget to zero — the durable reservation ledger is cross-checked
// on load and any settled/blocking reservation without a matching spend record
// is counted conservatively (call counted, usage UNKNOWN).
//
// ReviewLoop has ONE review engine — every Reviewer / Supervisor call for a
// LOCAL task is metered here.

import { ModelSpendAuthority } from '../orchestrator/modelSpendAuthority.js';
import { accountingClassOf, usageAccountingOf, usagePresentButUnresolved, usageVolumeOf, accountingProvenanceOf, usageBreakdownOf, payloadMetaOf, effectiveContextInputTokens, contextOverheadTokens } from './usageAccounting.js';
export { accountingClassOf, usageAccountingOf, usagePresentButUnresolved, usageVolumeOf, accountingProvenanceOf, usageBreakdownOf, payloadMetaOf, effectiveContextInputTokens, contextOverheadTokens } from './usageAccounting.js';
import { ReservationLedger, ReservationStore, humanExcludedFamilies } from '../orchestrator/modelSpendReservation.js';
import { AuthorizationError, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../orchestrator/errors.js';
import {
  NewInformationLedger,
  InformationStore,
  registerTaskDiffEvidence,
  registerReviewFindingsEvidence,
  registerGateFingerprintEvidence,
  registerExternalResultEvidence,
} from '../orchestrator/newInformation.js';

export const REVIEWLOOP_ENV = Object.freeze({
  MAX_COST_USD: 'REVIEWLOOP_MAX_COST_USD',
  MAX_USAGE_VOLUME: 'REVIEWLOOP_MAX_USAGE_VOLUME',
  MAX_REVIEW_ROUNDS: 'REVIEWLOOP_MAX_REVIEW_ROUNDS',
  MAX_REVIEWER_CALLS: 'REVIEWLOOP_MAX_REVIEWER_CALLS',
  MAX_SUPERVISOR_CALLS: 'REVIEWLOOP_MAX_SUPERVISOR_CALLS',
  MAX_SINGLE_CALL_USAGE: 'REVIEWLOOP_MAX_SINGLE_CALL_USAGE',
  MAX_CONTEXT_OVERHEAD_TOKENS: 'REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS',
});

export const REVIEWLOOP_DEFAULTS = Object.freeze({
  MAX_COST_USD: 5,
  MAX_USAGE_VOLUME: 400_000,
  MAX_REVIEW_ROUNDS: 3,
  // One review round can legitimately need several physical Reviewer calls
  // when a large diff is deterministically chunked (each chunk is separately
  // metered / New-Information-gated). This is a coarse backstop; MAX_COST_USD
  // and MAX_USAGE_VOLUME are the real runaway guards. Default headroom is
  // Default convergence can spend 3 initial Reviewer rounds plus two
  // Supervisor-guided epochs of 2 rounds each = 7 logical Reviewer rounds.
  // Each may chunk into at most 12 chunks; +1 keeps the existing coarse margin.
  MAX_REVIEWER_CALLS: 7 * 13,
  // Up to two logical Supervisor escalations are automatic per gate. Each can
  // traverse the full four-candidate Supervisor pool under bounded failover.
  // MAX_COST_USD / MAX_USAGE_VOLUME remain the real runaway guards.
  MAX_SUPERVISOR_CALLS: 2 * 4,
  // ---- post-settlement single-call Token Sentinel -------------------------
  // A runaway guard for ONE physical call: the durable aggregate ceilings
  // (MAX_USAGE_VOLUME / MAX_COST_USD) only fire once the running total crosses
  // the line, so a single call that suddenly balloons (10k running total -> a
  // 150k call) has already spent the 150k before the aggregate would block the
  // NEXT call. The Sentinel is POST-settlement: it cannot un-spend the
  // anomalous call, it fully accounts it, records a BLOCKING safety event, and
  // latches the loop so every further Reviewer/Supervisor model call fails
  // closed (across a restart). See createReviewLoopSpend / settleRecord.
  MAX_SINGLE_CALL_USAGE: 40_000,
  MAX_CONTEXT_OVERHEAD_TOKENS: 30_000,
});

// Env overrides for the Token Sentinel are clamped to (0, HARD_CAP]: an
// illegal value (non-finite, <= 0, unparseable) falls back to the default and
// NEVER disables the protection, and a value above the hard cap is clamped so
// a misconfiguration cannot effectively turn the ceiling into infinity.
export const TOKEN_SENTINEL_HARD_CAPS = Object.freeze({
  MAX_SINGLE_CALL_USAGE: 250_000,
  MAX_CONTEXT_OVERHEAD_TOKENS: 200_000,
});

const SPEND_STATE_KEY = 'reviewLoopSpend';
// Durable, restart-surviving latch for the post-settlement Token Sentinel.
// One record per loop; once written with `tripped: true` every further metered
// call in the loop is refused at the authorization stage.
const TOKEN_ANOMALY_STATE_KEY = 'reviewLoopTokenAnomaly';
const METERED_ROLES = new Set(['reviewer', 'supervisor']);

// Error codes that PROVE the physical provider call never reached the provider
// (spawn failure, transport unavailable, pre-send abort / bad input). For these
// — and only these — the token spend is mechanically, provably zero. A
// mechanically-zero attempt STILL settles the reservation SETTLED_KNOWN and
// STILL writes a durable accounting record (usage 0); the business error is
// re-thrown so the caller can fail over, and a normal failover therefore never
// leaves a settled reservation without a matching spend record (no false
// "unaccounted spend" block after a restart). Unified across the agy transport
// (AGY_ENOENT / AGY_SPAWN_FAILED / AGY_BAD_INPUT) and the generic pool.
// PROVIDER_AUTH_FAILED is mechanically pre-send zero: a CLI transport rejected
// at its own auth check (`codex` / `claude` not logged in, no/invalid API key)
// or the provider API returned 401/403 at the auth boundary — no prompt was
// ever billed. The `!err.usage` guard in isMechanicallyZeroPreSend still
// excludes any (impossible-by-construction) case where a transport attached
// real usage alongside an auth error.
export const PRE_SEND_ZERO_CODES = new Set([
  'PROVIDER_UNAVAILABLE', 'PROVIDER_NOT_STARTED', 'PROVIDER_AUTH_FAILED',
  'ENOENT', 'AGY_ENOENT', 'AGY_SPAWN_FAILED', 'AGY_BAD_INPUT',
  'AGY_NETWORK_UNAVAILABLE', 'PROVIDER_QUOTA_EXHAUSTED',
]);

export function isMechanicallyZeroPreSend(err) {
  const code = err?.code ?? err?.providerFailure ?? '';
  if (!PRE_SEND_ZERO_CODES.has(code) || err?.details?.usage || err?.usage) return false;
  // A network error is mechanically zero only when the AGY transport
  // classifier explicitly proved that no provider response was established.
  // Never let an arbitrary caller manufacture AGY_NETWORK_UNAVAILABLE and gain
  // failover eligibility without that provenance.
  if (code === 'AGY_NETWORK_UNAVAILABLE') {
    return err?.preSendZeroProven === true || err?.details?.preSendZeroProven === true;
  }
  // A quota rejection is zero-consumption ONLY with the AGY classifier's
  // explicit provenance. Generic CLI PROVIDER_QUOTA_EXHAUSTED (no proof) stays
  // UNKNOWN and fails closed.
  if (code === 'PROVIDER_QUOTA_EXHAUSTED') {
    return err?.details?.preSendZeroProven === true && err?.details?.zeroProof === 'AGY_QUOTA_REJECTION';
  }
  return true;
}

function num(env, key, fallback) {
  const raw = env?.[key];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Token Sentinel threshold: positive-finite env override, clamped to a hard
// cap. An illegal value can never DISABLE the protection (it falls back to the
// default) and can never be inflated past the hard cap.
function boundedThreshold(env, key, fallback, hardCap) {
  const raw = env?.[key];
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, hardCap);
}

export function resolveReviewLoopLimits(env = process.env, { gateCount = 1 } = {}) {
  const gates = Number.isInteger(gateCount) && gateCount > 0 ? gateCount : 1;
  return {
    // Cost / aggregate usage remain TASK-WIDE across all phase gates.
    maxCostUsd: num(env, REVIEWLOOP_ENV.MAX_COST_USD, REVIEWLOOP_DEFAULTS.MAX_COST_USD),
    maxUsageVolume: num(env, REVIEWLOOP_ENV.MAX_USAGE_VOLUME, REVIEWLOOP_DEFAULTS.MAX_USAGE_VOLUME),
    // maxReviewRounds is the INITIAL convergence-epoch Reviewer budget per gate;
    // Supervisor-guided epochs add their own bounded 2-round budgets. Coarse
    // physical-call ceilings gain headroom proportional to the frozen number
    // of gates. Explicit env
    // overrides remain absolute operator limits.
    maxReviewRounds: num(env, REVIEWLOOP_ENV.MAX_REVIEW_ROUNDS, REVIEWLOOP_DEFAULTS.MAX_REVIEW_ROUNDS),
    maxReviewerCalls: num(
      env,
      REVIEWLOOP_ENV.MAX_REVIEWER_CALLS,
      REVIEWLOOP_DEFAULTS.MAX_REVIEWER_CALLS * gates,
    ),
    maxSupervisorCalls: num(
      env,
      REVIEWLOOP_ENV.MAX_SUPERVISOR_CALLS,
      REVIEWLOOP_DEFAULTS.MAX_SUPERVISOR_CALLS * gates,
    ),
    maxSingleCallUsage: boundedThreshold(
      env, REVIEWLOOP_ENV.MAX_SINGLE_CALL_USAGE,
      REVIEWLOOP_DEFAULTS.MAX_SINGLE_CALL_USAGE, TOKEN_SENTINEL_HARD_CAPS.MAX_SINGLE_CALL_USAGE,
    ),
    maxContextOverheadTokens: boundedThreshold(
      env, REVIEWLOOP_ENV.MAX_CONTEXT_OVERHEAD_TOKENS,
      REVIEWLOOP_DEFAULTS.MAX_CONTEXT_OVERHEAD_TOKENS, TOKEN_SENTINEL_HARD_CAPS.MAX_CONTEXT_OVERHEAD_TOKENS,
    ),
  };
}

// Durable append-only spend log over the existing workflow-state snapshot,
// keyed by loopId. No parallel database.
export class ReviewLoopSpendStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return [];
    const state = await this._persistence.readWorkflowState(loopId);
    const raw = state?.[SPEND_STATE_KEY];
    return Array.isArray(raw?.records) ? raw.records : [];
  }

  async append(loopId, record) {
    if (!loopId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    const existing = await this.load(loopId);
    await this._persistence.updateWorkflowState(loopId, {
      [SPEND_STATE_KEY]: { records: [...existing, record] },
    });
  }

  // Atomic durable state transition for an ANOMALOUS metered call: the spend
  // record and the Token Sentinel latch are written in ONE updateWorkflowState
  // call (one underlying snapshot write), so a crash leaves BOTH or NEITHER —
  // never "spend persisted, latch missing", which on restart would keep
  // authorizing fresh model calls. First-write-wins on the latch: an existing
  // tripped latch (the ORIGINAL anomaly) is never overwritten. Returns
  // { persisted } — false only when no durable workflow-state store backs this
  // call (a misconfiguration the caller must fail closed on).
  async appendWithAnomalyLatch(loopId, record, anomalyRecord) {
    const p = this._persistence;
    if (!loopId || !p
      || typeof p.updateWorkflowState !== 'function'
      || typeof p.readWorkflowState !== 'function') {
      return { persisted: false };
    }
    const state = await p.readWorkflowState(loopId);
    const existingRecords = Array.isArray(state?.[SPEND_STATE_KEY]?.records)
      ? state[SPEND_STATE_KEY].records
      : [];
    const existingLatch = state?.[TOKEN_ANOMALY_STATE_KEY];
    const latch = existingLatch && existingLatch.tripped === true ? existingLatch : anomalyRecord;
    await p.updateWorkflowState(loopId, {
      [SPEND_STATE_KEY]: { records: [...existingRecords, record] },
      [TOKEN_ANOMALY_STATE_KEY]: latch,
    });
    return { persisted: true };
  }
}

// Durable latch for the post-settlement Token Sentinel, over the same
// workflow-state snapshot. Read on every metered call so the block survives a
// process restart; written exactly once, when the anomaly is first detected.
export class ReviewLoopTokenAnomalyStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return null;
    const state = await this._persistence.readWorkflowState(loopId);
    const raw = state?.[TOKEN_ANOMALY_STATE_KEY];
    return raw && raw.tripped === true ? raw : null;
  }

  // Returns { persisted } — `persisted:true` ONLY when the latch is durably on
  // record (freshly written, or already present). `persisted:false` means no
  // durable store is backing this call: a bare in-memory surface (fine — the
  // whole surface is ephemeral), OR a persistence object that does not
  // implement the workflow-state interface (a misconfiguration the caller must
  // fail closed on).
  async latch(loopId, record) {
    if (!loopId || !this._persistence) return { persisted: false, backed: false };
    if (typeof this._persistence.updateWorkflowState !== 'function'
      || typeof this._persistence.readWorkflowState !== 'function') {
      return { persisted: false, backed: false };
    }
    // First write wins: never overwrite the record of the ORIGINAL anomaly.
    const existing = await this.load(loopId);
    if (existing) return { persisted: true, backed: true };
    await this._persistence.updateWorkflowState(loopId, { [TOKEN_ANOMALY_STATE_KEY]: record });
    return { persisted: true, backed: true };
  }
}

// Post-settlement Token Sentinel decision. Runs ONLY against a call whose usage
// settled reliably (`volumeResolved === true`) — an UNKNOWN / unresolved usage
// keeps the existing UNRESOLVED fail-closed path and is never guessed at here.
// Returns null (no anomaly) or the trip detail.
export function detectSingleCallTokenAnomaly({ accounting, contextOverhead, limits }) {
  if (!accounting || accounting.volumeResolved !== true) return null;
  const usageVolume = Number.isFinite(accounting.usageVolume) ? accounting.usageVolume : null;
  const overhead = Number.isFinite(contextOverhead) ? contextOverhead : null;
  const usageTrip = usageVolume != null && usageVolume > limits.maxSingleCallUsage;
  const overheadTrip = overhead != null && overhead > limits.maxContextOverheadTokens;
  if (!usageTrip && !overheadTrip) return null;
  return {
    trigger: usageTrip ? 'SINGLE_CALL_USAGE' : 'CONTEXT_OVERHEAD',
    usageVolume,
    contextOverheadTokens: overhead,
    threshold: usageTrip ? limits.maxSingleCallUsage : limits.maxContextOverheadTokens,
  };
}

function foldTotals(records) {
  return records.reduce((acc, r) => ({
    reviewerCalls: acc.reviewerCalls + (r.role === 'reviewer' ? 1 : 0),
    supervisorCalls: acc.supervisorCalls + (r.role === 'supervisor' ? 1 : 0),
    usageVolume: acc.usageVolume + (Number.isFinite(r.usageVolume) ? r.usageVolume : 0),
    // Sum of KNOWN dollar cost only. A call whose provider reported no cost
    // contributes 0 to the sum but increments unknownCostCalls — the dollar
    // figure is then a lower bound, never asserted as the true spend.
    costUsd: acc.costUsd + (r.costKnown !== false && Number.isFinite(r.costUsd) ? r.costUsd : 0),
    unknownUsageCalls: acc.unknownUsageCalls + (r.usageKnown ? 0 : 1),
    unknownCostCalls: acc.unknownCostCalls + (r.costKnown === false ? 1 : 0),
    // A call whose usage WAS reported but whose cache semantics could not be
    // mechanically confirmed for its provider family — its usageVolume is a
    // conservative additive over-count, not an exact provider figure.
    unknownSemanticsCalls: acc.unknownSemanticsCalls
      + (r.usageKnown && r.usageAccounting && r.usageAccounting.semanticsKnown === false ? 1 : 0),
  }), {
    reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0,
    unknownUsageCalls: 0, unknownCostCalls: 0, unknownSemanticsCalls: 0,
  });
}

// Aggregate provider usage breakdown + payload/overhead metadata across all
// durable spend records. A field only sums where it was actually reported;
// `*Unknown` counts the calls where it was not (UNKNOWN != 0).
function foldBreakdown(records) {
  const F = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reportedTotalTokens', 'rawFieldSumTokens'];
  const sums = Object.fromEntries(F.map((k) => [k, 0]));
  const unknown = Object.fromEntries(F.map((k) => [`${k}Unknown`, 0]));
  let promptChars = 0;
  let diffChars = 0;
  let estimatedPayloadTokens = 0;
  let contextOverheadTokens = 0;
  let contextOverheadKnownCalls = 0;
  for (const r of records) {
    const b = r.usageBreakdown ?? {};
    for (const k of F) {
      if (Number.isFinite(b[k])) sums[k] += b[k];
      else unknown[`${k}Unknown`] += 1;
    }
    const p = r.payloadMeta ?? {};
    if (Number.isFinite(p.promptChars)) promptChars += p.promptChars;
    if (Number.isFinite(p.diffChars)) diffChars += p.diffChars;
    if (Number.isFinite(p.estimatedPayloadTokens)) estimatedPayloadTokens += p.estimatedPayloadTokens;
    if (Number.isFinite(r.contextOverheadTokens)) {
      contextOverheadTokens += r.contextOverheadTokens;
      contextOverheadKnownCalls += 1;
    }
  }
  return {
    ...sums, ...unknown,
    promptChars, diffChars, estimatedPayloadTokens,
    contextOverheadTokens, contextOverheadKnownCalls,
  };
}

// Build the ReviewLoop spend surface. `persistence` (optional) makes the
// reservation + information + spend ledgers durable, keyed by loopId. Without
// it the surface is in-memory-only for the process (unit tests).
export function createReviewLoopSpend({
  loopId,
  persistence = null,
  env = process.env,
  gateCount = 1,
  onEvent,
  recordSafetyEvent,
} = {}) {
  const limits = resolveReviewLoopLimits(env, { gateCount });
  const spendStore = new ReviewLoopSpendStore(persistence);
  const anomalyStore = new ReviewLoopTokenAnomalyStore(persistence);

  // Post-settlement Token Sentinel latch. Once tripped it is cached (a latch
  // never un-trips), and it is also set in-process the moment settleRecord
  // detects the anomaly so a persistence-less (unit-test) surface still blocks
  // the next call.
  // A CLEAN result is deliberately NOT cached: the durable latch is re-read on
  // every metered call, so a latch written after this surface's first read
  // (a crash-recovered sibling, a prior round on a shared loopId) still blocks
  // — a stale "clean" cache must never outrank a durable latch.
  let anomalyLatched = null;

  // Raw read. THROWS on a durable-read failure — the caller must fail closed:
  // "cannot read the latch" is never "no anomaly".
  async function readAnomaly() {
    if (anomalyLatched) return anomalyLatched;
    let loaded;
    try {
      loaded = await anomalyStore.load(loopId);
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
        `single-call token anomaly latch could not be read: ${error?.message ?? error}`,
        { loopId },
      );
    }
    if (!loaded) {
      // Defense in depth. The atomic appendWithAnomalyLatch is the PRIMARY
      // guard, but a durable spend record written by an older build, or a torn
      // snapshot write, could still leave an anomalous spend record on disk with
      // no latch. Re-infer the latch from the durable spend log so a restart
      // stays blocked — this is a backup, never the sole protection.
      loaded = await reinferAnomalyFromSpendLog();
    }
    if (loaded) anomalyLatched = loaded;
    return anomalyLatched || null;
  }

  // Reconstruct a Token Sentinel latch from a durable spend record that itself
  // exceeds a per-call ceiling. Persists the reconstructed latch (fail closed if
  // it cannot). Returns the latch record, or null ONLY when the spend log was
  // read successfully and is clean. A durable spend-log READ failure is
  // UNKNOWN, never "clean": it fails closed (STATE_UNAVAILABLE) exactly like an
  // unreadable latch — "cannot establish clean" is not "clean".
  async function reinferAnomalyFromSpendLog() {
    let records;
    try {
      records = await spendStore.load(loopId);
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
        `token anomaly re-inference could not read the durable spend log for ${JSON.stringify(loopId)} `
          + `(${error?.message ?? error}); whether a prior single-call anomaly exists is UNKNOWN — `
          + 'further internal model spend is blocked until this can be established',
        { loopId },
      );
    }
    for (const r of records) {
      const uv = Number.isFinite(r.usageVolume) ? r.usageVolume : null;
      const co = Number.isFinite(r.contextOverheadTokens) ? r.contextOverheadTokens : null;
      // Only a record whose volume settled reliably can trip on usage.
      const volumeResolved = r.usageAccounting?.volumeResolved === true;
      const usageTrip = volumeResolved && uv != null && uv > limits.maxSingleCallUsage;
      const overheadTrip = co != null && co > limits.maxContextOverheadTokens;
      if (!usageTrip && !overheadTrip) continue;
      const record = Object.freeze({
        tripped: true,
        at: new Date().toISOString(),
        role: r.role ?? null,
        family: r.family ?? null,
        provider: r.provider ?? null,
        resolvedModel: r.model ?? null,
        usageVolume: uv,
        contextOverheadTokens: co,
        trigger: usageTrip ? 'SINGLE_CALL_USAGE' : 'CONTEXT_OVERHEAD',
        threshold: usageTrip ? limits.maxSingleCallUsage : limits.maxContextOverheadTokens,
        thresholds: {
          maxSingleCallUsage: limits.maxSingleCallUsage,
          maxContextOverheadTokens: limits.maxContextOverheadTokens,
        },
        reason: `restart re-inference: a durable spend record for ${JSON.stringify(loopId)} shows a `
          + `single ${r.role ?? 'metered'} call `
          + `${usageTrip ? `usageVolume ${uv}` : `transport context overhead ${co} tokens`} over the `
          + 'Token Sentinel ceiling, but no durable anomaly latch was found',
        actionTaken: 'anomaly latch reconstructed from the durable spend log; all further ReviewLoop '
          + 'Reviewer/Supervisor model spend for this loop is blocked until a human clears it',
        reinferredFromSpendLog: true,
      });
      let res;
      try {
        res = await anomalyStore.latch(loopId, record);
      } catch (error) {
        // Could not persist the reconstructed latch. The in-process latch still
        // blocks THIS process; make the loss of durability loud.
        if (persistence) {
          throw new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
            `restart re-inference found a token anomaly in the durable spend log for ${JSON.stringify(loopId)} `
              + `but could not persist the reconstructed latch (${error?.message ?? error}); this process is blocked`,
            { loopId, anomaly: record },
          );
        }
        return record;
      }
      if (persistence && res?.persisted !== true) {
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
          `restart re-inference found a token anomaly in the durable spend log for ${JSON.stringify(loopId)} `
            + 'but the configured persistence cannot durably store the reconstructed latch; this process is blocked',
          { loopId, anomaly: record },
        );
      }
      return record;
    }
    return null;
  }

  // Best-effort variant for telemetry / diagnostics: never throws.
  async function loadAnomaly() {
    try { return await readAnomaly(); } catch { return null; }
  }

  // Session-local records for calls made in THIS process; prior durable
  // records are loaded lazily and cached on first budget check.
  const sessionRecords = [];
  let priorRecords = null;

  const reservationLedger = new ReservationLedger({
    store: persistence ? new ReservationStore(persistence) : null,
    onEvent,
    recordSafetyEvent,
  });
  const informationLedger = new NewInformationLedger({
    store: persistence ? new InformationStore(persistence) : null,
  });

  // Promote any DISPATCHING reservation left behind by a crash to UNRESOLVED
  // so the very first authorize() this session blocks on it.
  let reconciled = false;
  async function ensureReconciled() {
    if (reconciled) return;
    reconciled = true;
    try { await reservationLedger.reconcileOnResume(loopId); } catch { /* best effort */ }
  }

  // Cross-check the durable reservation ledger against the durable spend log.
  // A physical metered call ALWAYS reserves+dispatches+settles durably in the
  // reservation ledger; its usage/cost numbers live ONLY in the spend log,
  // written durably-before-return. So:
  //
  //   settled/blocking metered reservations  >  spend-log records
  //     => at least one physical call whose real usage AND cost were lost to a
  //        crash between settlement and the spend-log append.
  //
  // UNKNOWN != ZERO: we do NOT substitute 0 and keep spending. `unaccounted`
  // is a fail-closed condition — every subsequent metered call is refused
  // until a human acknowledges it (REVIEWLOOP_ACK_UNACCOUNTED_SPEND). The
  // reconstructed records are kept only so telemetry can show WHY.
  let cachedUnaccounted = 0;
  async function loadPriorRecords() {
    if (priorRecords) return priorRecords;
    await ensureReconciled();
    const logged = await spendStore.load(loopId);
    let reservations = [];
    try { reservations = await reservationLedger.list(loopId); } catch { reservations = []; }
    const meteredReservations = reservations.filter((r) => METERED_ROLES.has(r.role ?? r.intent?.role));
    const reconciledRecords = [...logged];
    // An UNRESOLVED / DISPATCHING reservation is already a blocking condition
    // that ModelSpendAuthority.authorize() enforces (hasUnresolved). Here we
    // only look for SETTLED_KNOWN calls whose durable accounting record was
    // lost to a crash between settlement and the spend-log append.
    //
    // Every metered attempt — success, known-usage failure, OR mechanically-
    // zero pre-send failure — now writes a spend-log record tagged with its
    // reservationId, so a NORMAL failover never shows up here. An orphan is a
    // SETTLED_KNOWN reservation with no spend-log record carrying its id.
    const settled = meteredReservations.filter((r) => r.status === 'SETTLED_KNOWN');
    const loggedIds = new Set(logged.map((rec) => rec.reservationId).filter(Boolean));
    const idTrackingActive = logged.length === 0 || loggedIds.size > 0;

    let orphans;
    if (idTrackingActive) {
      orphans = settled.filter((r) => !loggedIds.has(r.reservationId));
    } else {
      // Legacy spend log written before reservationId tagging — fall back to a
      // count comparison.
      const gap = settled.length - logged.length;
      orphans = gap > 0 ? settled.slice(0, gap) : [];
    }
    cachedUnaccounted = orphans.length;
    for (const r of orphans) {
      reconciledRecords.push({
        role: r.role ?? r.intent?.role ?? 'reviewer',
        model: null,
        usageKnown: false,
        usageVolume: 0,
        costUsd: 0,
        reservationId: r.reservationId ?? null,
        reconstructedFromReservation: true,
        at: r.settledAt ?? new Date().toISOString(),
      });
    }
    priorRecords = reconciledRecords;
    return priorRecords;
  }

  function unaccountedAcknowledged() {
    const ack = env?.REVIEWLOOP_ACK_UNACCOUNTED_SPEND;
    return ack === '1' || ack === 'true' || ack === loopId;
  }

  async function hasUnaccountedSpend() {
    await loadPriorRecords();
    return cachedUnaccounted > 0 && !unaccountedAcknowledged();
  }

  async function currentTotals() {
    const prior = await loadPriorRecords();
    return {
      ...foldTotals([...prior, ...sessionRecords]),
      unaccountedSpendCalls: cachedUnaccounted,
    };
  }

  // Build the immutable Token Sentinel latch record for a detected anomaly.
  function buildAnomalyRecord({ hit, role, family, provider, resolvedModel }) {
    const reason = hit.trigger === 'SINGLE_CALL_USAGE'
      ? `single physical ${role} call usageVolume ${hit.usageVolume} exceeds `
        + `REVIEWLOOP_MAX_SINGLE_CALL_USAGE (${limits.maxSingleCallUsage})`
      : `single physical ${role} call transport context overhead ${hit.contextOverheadTokens} `
        + `tokens exceeds REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS (${limits.maxContextOverheadTokens})`;
    const actionTaken = 'anomalous call fully accounted; anomaly latched durably in the same atomic '
      + 'state transition as its spend record; all further ReviewLoop Reviewer/Supervisor model spend '
      + 'for this loop is blocked (no auto-failover, provider health/quota untouched) until a human clears it';
    return Object.freeze({
      tripped: true,
      at: new Date().toISOString(),
      role,
      family: family ?? null,
      provider: provider ?? null,
      resolvedModel: resolvedModel ?? null,
      usageVolume: hit.usageVolume,
      contextOverheadTokens: hit.contextOverheadTokens,
      trigger: hit.trigger,
      threshold: hit.threshold,
      thresholds: {
        maxSingleCallUsage: limits.maxSingleCallUsage,
        maxContextOverheadTokens: limits.maxContextOverheadTokens,
      },
      reason,
      actionTaken,
    });
  }

  // Emit the BLOCKING safety event + onEvent for a tripped anomaly, then throw
  // the fail-closed AuthorizationError (STATE_UNAVAILABLE when the durable latch
  // could not be persisted, otherwise BLOCKED). Never returns.
  function emitAndThrowAnomaly({ record, latchPersisted, latchError }) {
    recordSafetyEvent?.({
      code: 'MODEL_SPEND_TOKEN_ANOMALY',
      severity: 'BLOCKING',
      role: record.role,
      family: record.family,
      provider: record.provider,
      resolvedModel: record.resolvedModel,
      usageVolume: record.usageVolume,
      contextOverheadTokens: record.contextOverheadTokens,
      trigger: record.trigger,
      threshold: record.threshold,
      thresholds: record.thresholds,
      durablyLatched: latchPersisted,
      reason: record.reason,
      actionTaken: record.actionTaken,
    });
    onEvent?.({ type: 'MODEL_SPEND_TOKEN_ANOMALY', loopId, durablyLatched: latchPersisted, ...record });
    if (!latchPersisted) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
        `single-call token anomaly detected (${record.reason}) but the durable latch could not be `
          + `persisted (${latchError ? (latchError.message ?? latchError) : 'the configured persistence does not implement durable workflow state'}); `
          + 'this process is blocked; a restart is NOT guaranteed to stay blocked by this latch alone',
        { loopId, anomaly: record },
      );
    }
    throw new AuthorizationError(
      AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED,
      `${record.reason}; the call was fully accounted but further internal model spend for `
        + `${JSON.stringify(loopId)} is blocked until a human clears the token anomaly`,
      { loopId, anomaly: record },
    );
  }

  // Aggregate deterministic ceiling policy. Runs inside authorize(), before a
  // permit is minted. Denies against the DURABLE aggregate (loaded and stashed
  // by meteredCall() immediately before authorize()), never a process-local
  // counter, and never estimates. meteredCall() is the only caller and issues
  // one authorize() at a time, so this closure var is never raced.
  let pendingTotals = { reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0 };
  const policy = (intent) => {
    const totals = pendingTotals;
    if (intent.role === 'reviewer' && totals.reviewerCalls >= limits.maxReviewerCalls) {
      return { allow: false, reason: `ReviewLoop reviewer call ceiling (${limits.maxReviewerCalls}) reached` };
    }
    if (intent.role === 'supervisor' && totals.supervisorCalls >= limits.maxSupervisorCalls) {
      return { allow: false, reason: `ReviewLoop supervisor call ceiling (${limits.maxSupervisorCalls}) reached` };
    }
    // usageVolume is the HARD runaway guard — it is provider-reported token
    // volume and UNKNOWN volume already counts as a physical call elsewhere.
    if (totals.usageVolume >= limits.maxUsageVolume) {
      return { allow: false, reason: `ReviewLoop usage-volume ceiling (${limits.maxUsageVolume}) reached` };
    }
    // Cost ceiling semantics (UNKNOWN != $0): `totals.costUsd` is the sum of
    // KNOWN dollar cost only. It fires when the known sum alone reaches the
    // ceiling. When some calls had no provider-reported cost the known sum is a
    // lower bound — so also deny once the KNOWN sum passes a conservative
    // fraction of the ceiling while unknown-cost calls exist, rather than
    // letting unpriced calls run indefinitely under a $0 assumption.
    if (totals.costUsd >= limits.maxCostUsd) {
      return { allow: false, reason: `ReviewLoop cost ceiling ($${limits.maxCostUsd}) reached` };
    }
    if ((totals.unknownCostCalls ?? 0) > 0 && totals.costUsd >= limits.maxCostUsd * 0.5) {
      return {
        allow: false,
        reason: `ReviewLoop cost ceiling: known spend $${totals.costUsd.toFixed(2)} plus `
          + `${totals.unknownCostCalls} call(s) of unknown cost — refusing to keep spending against an unpriced ceiling`,
      };
    }
    return { allow: true };
  };

  const authority = new ModelSpendAuthority({
    policy, onEvent, reservationLedger, recordSafetyEvent, informationLedger,
  });

  async function registerEvidence({ kind, ...args }) {
    const wf = { workflowId: loopId, ...args };
    // A composite (diff chunk + gate fingerprint) logical review state. Shares
    // the CHANGED_TASK_DIFF taxonomy — it IS a "the reviewable state changed"
    // event — but its fingerprint folds in the gate outcome so a diff that is
    // byte-identical but was gated differently is a distinct logical state.
    if (kind === 'reviewstate') return registerTaskDiffEvidence(informationLedger, wf);
    if (kind === 'diff') return registerTaskDiffEvidence(informationLedger, wf);
    if (kind === 'findings') return registerReviewFindingsEvidence(informationLedger, wf);
    if (kind === 'gate') return registerGateFingerprintEvidence(informationLedger, wf);
    if (kind === 'external') return registerExternalResultEvidence(informationLedger, wf);
    throw new Error(`unknown evidence kind ${kind}`);
  }

  // metered call: resolve durable aggregate -> authorize -> dispatch -> settle
  // -> durably append the spend record BEFORE returning. `call()` returns
  // { value, usage?, costUsd?, model? }. UNRESOLVED usage throws from dispatch.
  async function meteredCall({
    role, family = 'agy:gpt-oss', provider = 'agy', model = null,
    operationId, attempt = 1, evidenceIds = [], call,
    // Durable physical-call-audit identity. Never used for authorization or
    // routing — purely so the crash/resume audit trail (physicalCalls in
    // controller.js) can be reconstructed from THIS durable spend record
    // alone, without depending on the in-memory array a resumed process never
    // repopulates for an already-checkpointed chunk. `null` for a Supervisor
    // call (it has no chunk).
    auditContext = null,
  }) {
    // Fail closed: a single earlier physical call in this loop consumed an
    // anomalous amount of tokens. It was fully accounted, but the loop is
    // latched — no more automatic model spend. Refused at the authorization
    // stage, before any permit/reservation, and it survives a process restart
    // because the latch is read from durable workflow state.
    const anomaly = await readAnomaly();
    if (anomaly) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED,
        `ReviewLoop ${JSON.stringify(loopId)} latched a single-call token anomaly `
          + `(${anomaly.reason}); further internal model spend is blocked until a human clears it`,
        { loopId, anomaly },
      );
    }
    // Fail closed: a prior physical metered call whose real usage AND cost were
    // lost to a crash cannot be reconstructed. UNKNOWN != ZERO — refuse all
    // further ReviewLoop spend until a human acknowledges it.
    if (await hasUnaccountedSpend()) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
        `ReviewLoop ${loopId} has ${cachedUnaccounted} settled metered call(s) whose usage/cost `
          + 'could not be recovered after a crash; further model spend is blocked until a human '
          + 'clears it (REVIEWLOOP_ACK_UNACCOUNTED_SPEND)',
        { loopId, unaccountedSpendCalls: cachedUnaccounted },
      );
    }
    pendingTotals = await currentTotals();
    const intent = {
      role, family, provider,
      operationId: operationId ?? loopId,
      attempt,
      workflowId: loopId,
      evidenceIds,
    };
    const permit = await authority.authorize(intent);
    const reservationId = typeof authority.reservationIdFor === 'function'
      ? authority.reservationIdFor(permit)
      : null;

    // Durably settle ONE metered attempt's accounting record. When that attempt
    // is a post-settlement single-call Token Sentinel anomaly, the spend record
    // AND the durable anomaly latch are written in ONE atomic workflow-state
    // transition (appendWithAnomalyLatch) — never two writes with a crash window
    // between them — and then this throws the fail-closed AuthorizationError
    // (fully accounted, then blocked). A non-anomalous attempt just appends.
    // Durable-before-return either way: the aggregate must reflect this attempt
    // even if the controller crashes before it saves loop state.
    const settleRecord = async ({
      record: rec, role: aRole, family: aFamily, provider: aProvider, resolvedModel,
      accounting, contextOverhead,
    }) => {
      const full = { ...rec, role, reservationId, at: new Date().toISOString() };
      const hit = detectSingleCallTokenAnomaly({ accounting, contextOverhead, limits });
      if (!hit) {
        await spendStore.append(loopId, full);
        sessionRecords.push(full);
        return;
      }
      const anomalyRecord = buildAnomalyRecord({
        hit, role: aRole, family: aFamily, provider: aProvider, resolvedModel,
      });
      // In-process latch first: a bare in-memory surface has no durable state
      // and this is its whole contract; a durable surface still wants it set
      // before any await so a re-entrant read cannot race a clean result.
      anomalyLatched = anomalyRecord;
      const durableSurface = Boolean(persistence);
      let latchPersisted = true;
      let latchError = null;
      try {
        const res = await spendStore.appendWithAnomalyLatch(loopId, full, anomalyRecord);
        if (durableSurface && res?.persisted !== true) latchPersisted = false;
      } catch (error) {
        // The atomic write failed — neither the spend record nor the latch is on
        // disk. The in-process record + latch still hold for THIS process (and a
        // restart fails closed via the settled-reservation / unaccounted-spend
        // path). Do NOT swallow: surface the loss of durability loudly.
        latchPersisted = false;
        latchError = error;
      }
      sessionRecords.push(full);
      emitAndThrowAnomaly({ record: anomalyRecord, latchPersisted, latchError });
    };

    let result;
    try {
      result = await authority.dispatch(permit, intent, async () => {
        let out;
        try {
          out = await call();
        } catch (err) {
          if (isMechanicallyZeroPreSend(err)) {
            // Attach mechanically-zero usage so the reservation settles KNOWN
            // and the business error is re-thrown normally for failover. Also
            // attach an EXPLICIT pre-send provenance flag: this is a spawn /
            // transport abort before any bytes were sent (isMechanicallyZeroPreSend
            // already required a PRE_SEND_ZERO_CODES code AND the absence of any
            // provider-supplied usage). ModelSpendAuthority.dispatch() persists
            // this as settlementReason PROVEN_PRE_SEND_ZERO — the ONLY durable
            // basis for a later attempt to reuse the same New Information claim.
            // A plain provider `{0,0}` usage NEVER earns this flag.
            err.details = {
              ...(err.details ?? {}),
              usage: { input_tokens: 0, output_tokens: 0 },
              preSendZeroProven: true,
            };
          } else if (usagePresentButUnresolved({
            usage: err?.details?.usage ?? err?.usage ?? null, family, provider,
          })) {
            // The provider threw WITH a usage object, but it is missing a field
            // this family's confirmed accounting needs. UNKNOWN != ZERO: strip
            // the partial usage so ModelSpendAuthority settles the reservation
            // UNRESOLVED (fail closed) rather than recording a false precise
            // spend. The business error itself still propagates.
            if (err?.details) delete err.details.usage;
            delete err.usage;
          }
          throw err;
        }
        // A post-dispatch usage object that is present but insufficient for a
        // mechanically-known volume for this family MUST NOT settle as precise
        // known spend. Throw WITHOUT usage so dispatch() settles the
        // reservation UNRESOLVED — the existing MODEL_SPEND_USAGE_UNRESOLVED /
        // fail-closed path then blocks further internal model spend until a
        // human clears it.
        if (usagePresentButUnresolved({ usage: out?.usage ?? null, family, provider })) {
          const e = new Error(
            `ReviewLoop ${loopId}: post-dispatch usage for ${provider}/${family} is present but `
              + 'missing a field required for mechanically-known token accounting; UNKNOWN != ZERO',
          );
          e.code = 'PROVIDER_USAGE_INCOMPLETE';
          throw e;
        }
        return {
          value: out?.value ?? out,
          usage: out?.usage ?? null,
          model: out?.model ?? model ?? null,
          // Pass the provider cost through UNCHANGED (undefined when unknown) —
          // UNKNOWN != $0. The record layer marks costKnown accordingly.
          costUsd: out?.costUsd,
          // Mechanical payload-size metadata (lengths only, never prompt text).
          meta: out?.meta ?? null,
        };
      });
    } catch (err) {
      // dispatch threw. A spend/authorization denial (SPEND_DENIED,
      // MODEL_SPEND_USAGE_UNRESOLVED, ...) means there is NO reliably-settled
      // physical attempt to account for — re-throw untouched. Any other error
      // that made it past dispatch's settlement means the reservation is
      // SETTLED_KNOWN (a provider/business failure with known usage, or a
      // mechanically-zero pre-send failure): write its durable accounting
      // record NOW so a normal failover never looks like unaccounted spend on
      // the next load.
      if (!isAuthorizationFailure(err)) {
        const usage = err?.details?.usage ?? err?.usage
          ?? (isMechanicallyZeroPreSend(err) ? { input_tokens: 0, output_tokens: 0 } : null);
        // A mechanically-zero pre-send failure genuinely cost $0; any other
        // failure's cost is only known if the error carried it.
        const failCost = err?.details?.costUsd;
        const costKnown = Number.isFinite(failCost) || isMechanicallyZeroPreSend(err)
          // isMechanicallyZeroPreSend() turns false once the zero usage was attached
          // above; the explicit provenance flag keeps the proof.
          || err?.details?.preSendZeroProven === true;
        const failMeta = payloadMetaOf(err?.details?.meta ?? null);
        const failBreakdown = usageBreakdownOf(usage);
        const failAccounting = usageAccountingOf({ usage, family, provider });
        const failOverhead = contextOverheadTokens(failBreakdown, failMeta, { family, provider });
        // Durably settle this attempt's accounting AND, if it is a single-call
        // token anomaly, the durable latch in ONE atomic workflow-state write —
        // never two writes with a crash window between them. A trip throws
        // MODEL_SPEND_TOKEN_ANOMALY_BLOCKED in place of the provider error so the
        // controller stops (no failover); the tokens were still spent.
        await settleRecord({
          record: {
            model: model ?? null,
            family,
            provider,
            usageKnown: usage != null,
            usageVolume: failAccounting.usageVolume,
            usageBreakdown: failBreakdown,
            usageAccounting: accountingProvenanceOf(failAccounting),
            payloadMeta: failMeta,
            contextOverheadTokens: failOverhead,
            costUsd: Number.isFinite(failCost) ? failCost : 0,
            costKnown,
            businessOutcome: 'FAILURE',
            failureCode: err?.code ?? err?.providerFailure ?? null,
            // Persist the narrow transient-auth provenance so a process restart
            // cannot reset the same-family OAuth retry budget. Generic
            // PROVIDER_AUTH_FAILED failures remain distinguishable.
            transientAuth: err?.transientAuth === true,
            transientNetwork: err?.transientNetwork === true,
            // Mechanical zero-consumption provenance (e.g. AGY_QUOTA_REJECTION), if any.
            zeroProof: err?.details?.zeroProof ?? null,
            // Durable physical-call-audit identity (see auditContext above).
            operationId: operationId ?? null,
            attempt,
            rawUsage: usage ?? null,
            round: auditContext?.round ?? null,
            chunkIndex: auditContext?.chunkIndex ?? null,
            chunkTotal: auditContext?.chunkTotal ?? null,
            quotaPools: auditContext?.quotaPools ?? null,
          },
          role, family, provider, resolvedModel: model ?? null,
          accounting: failAccounting, contextOverhead: failOverhead,
        });
      }
      throw err;
    }

    const okBreakdown = usageBreakdownOf(result?.usage);
    const okMeta = payloadMetaOf(result?.meta);
    const okAccounting = usageAccountingOf({ usage: result?.usage, family, provider });
    const okOverhead = contextOverheadTokens(okBreakdown, okMeta, { family, provider });
    // Durable-before-return: this attempt's accounting record AND — when this
    // ONE call blew past the per-call ceiling — the durable Token Sentinel latch
    // are written in ONE atomic workflow-state transition. A crash can leave
    // BOTH or NEITHER, never "spend persisted, latch missing" (which on restart
    // would keep authorizing new model calls). On a trip settleRecord throws
    // (fully accounted, then fail closed) rather than returning the result.
    await settleRecord({
      record: {
        // requestedFamily -> resolvedModel: the concrete model actually used
        // (recovered from the provider envelope when config asked for a family).
        model: result?.model ?? model ?? null,
        requestedFamily: family,
        family,
        provider,
        usageKnown: result?.usage != null,
        usageVolume: okAccounting.usageVolume,
        usageAccounting: accountingProvenanceOf(okAccounting),
        usageBreakdown: okBreakdown,
        payloadMeta: okMeta,
        contextOverheadTokens: okOverhead,
        costUsd: Number.isFinite(result?.costUsd) ? result.costUsd : 0,
        costKnown: Number.isFinite(result?.costUsd),
        businessOutcome: 'SUCCESS',
        // Durable physical-call-audit identity (see auditContext above).
        operationId: operationId ?? null,
        attempt,
        rawUsage: result?.usage ?? null,
        round: auditContext?.round ?? null,
        chunkIndex: auditContext?.chunkIndex ?? null,
        chunkTotal: auditContext?.chunkTotal ?? null,
        quotaPools: auditContext?.quotaPools ?? null,
      },
      role, family, provider, resolvedModel: result?.model ?? model ?? null,
      accounting: okAccounting, contextOverhead: okOverhead,
    });
    return result?.value ?? result;
  }

  // Durable + current-process physical attempts for one logical role/operation.
  // Used by controller retry/resume logic so attempt numbers and bounded
  // transient-auth retry budgets survive a process restart. This is a
  // read-only projection of the existing spend log — no parallel state store.
  async function attemptRecords({ role, operationId } = {}) {
    const prior = await loadPriorRecords();
    return [...prior, ...sessionRecords].filter((r) => (
      (role == null || r.role === role)
      && (operationId == null || r.operationId === operationId)
    ));
  }

  async function telemetry() {
    const t = await currentTotals();
    const prior = await loadPriorRecords();
    const breakdown = foldBreakdown([...prior, ...sessionRecords]);
    const anomaly = await loadAnomaly();
    return {
      usageBreakdown: breakdown,
      // Post-settlement single-call Token Sentinel latch (null = clean).
      tokenAnomaly: anomaly,
      tokenAnomalyBlocked: Boolean(anomaly),
      reviewerCalls: t.reviewerCalls,
      supervisorCalls: t.supervisorCalls,
      usageVolume: t.usageVolume,
      // costUsd is the sum of KNOWN dollar cost; a lower bound when
      // costKnown === false.
      costUsd: t.costUsd,
      costKnown: (t.unknownCostCalls ?? 0) === 0,
      unknownCostCalls: t.unknownCostCalls ?? 0,
      unknownUsageCalls: t.unknownUsageCalls,
      // usage reported but provider cache semantics unconfirmed -> that call's
      // usageVolume is a conservative additive over-count.
      unknownSemanticsCalls: t.unknownSemanticsCalls ?? 0,
      unaccountedSpendCalls: t.unaccountedSpendCalls ?? 0,
      spendBlocked: (t.unaccountedSpendCalls ?? 0) > 0 && !unaccountedAcknowledged(),
      limits,
      workerUsage: 'external / not observable by ReviewLoop',
    };
  }

  // Families a human excluded during unresolved-spend recovery (durable,
  // loop-wide). Read fresh from the ledger on every call so an acknowledgement
  // written between two reviewloop_review calls takes effect immediately.
  async function excludedFamilies() {
    await ensureReconciled();
    return humanExcludedFamilies(await reservationLedger.list(loopId));
  }

  return {
    limits,
    authority,
    reservationLedger,
    excludedFamilies,
    informationLedger,
    registerEvidence,
    meteredCall,
    attemptRecords,
    currentTotals,
    hasUnaccountedSpend,
    loadTokenAnomaly: loadAnomaly,
    telemetry,
  };
}

// ---- crash/resume durable physical-call audit reconstruction --------------
//
// The controller's in-memory `physicalCalls` array (runReviewerOverEvidence /
// runSupervisor in controller.js) only sees attempts made in THIS process. A
// chunk already served from the durable per-chunk checkpoint was reviewed by
// an EARLIER — possibly crashed — process, so that array has nothing for it.
// Every physical attempt (success, retryable failure, or mechanically-zero
// pre-send failure) durably settles its full accounting record BEFORE
// meteredCall() returns (see settleRecord above), now tagged with the same
// role/round/chunkIndex/chunkTotal/attempt/quotaPools identity the in-memory
// audit trail uses. A genuine authorization-before-dispatch denial NEVER
// reaches settleRecord (meteredCall re-throws it first), so it correctly
// never appears here either — no physical call is fabricated for a call that
// never dispatched. Reusing this existing durable spend log means the audit
// trail survives a crash with no new database.
function physicalCallAuditEntryFromSpendRecord(r) {
  return {
    role: r.role ?? null,
    family: r.family ?? null,
    provider: r.provider ?? null,
    quotaPools: r.quotaPools ?? null,
    resolvedModel: r.model ?? null,
    attempt: r.attempt ?? null,
    round: r.round ?? null,
    chunkIndex: r.chunkIndex ?? null,
    chunkTotal: r.chunkTotal ?? null,
    outcome: r.businessOutcome ?? null,
    code: r.failureCode ?? null,
    // Mirrors the in-memory audit convention (controller.js onAttempt / the
    // invoke().then() success push): `usage` is the raw provider envelope for
    // a SETTLED SUCCESS only. A FAILURE attempt's `rawUsage` may still carry a
    // synthetic mechanically-zero usage object for accounting purposes (see
    // isMechanicallyZeroPreSend) — that is a spend-accounting detail, not a
    // provider-reported usage figure, so it is never surfaced here.
    usage: r.businessOutcome === 'SUCCESS' ? (r.rawUsage ?? null) : null,
  };
}

// Reconstruct every physical attempt durably recorded for one `role` within
// one `round` (optionally narrowed to one `chunkIndex`), in attempt order.
// Never throws on a normal empty result; the caller decides what "nothing
// found" means (a fresh round that made no calls yet vs. a durable-read
// failure it should fail closed on).
export async function reconstructPhysicalCalls({
  persistence, loopId, role, round, chunkIndex = undefined,
} = {}) {
  const store = new ReviewLoopSpendStore(persistence);
  const records = await store.load(loopId);
  return records
    .filter((r) => r.role === role && r.round === round
      && (chunkIndex === undefined || r.chunkIndex === chunkIndex))
    .sort((a, b) => {
      const ci = (a.chunkIndex ?? -1) - (b.chunkIndex ?? -1);
      return ci !== 0 ? ci : (a.attempt ?? 0) - (b.attempt ?? 0);
    })
    .map(physicalCallAuditEntryFromSpendRecord);
}
