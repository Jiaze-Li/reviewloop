// Token-Safety authorization boundary.
//
//   CallIntent -> ModelSpendAuthority.authorize() -> PhysicalCallPermit
//              -> ModelSpendAuthority.dispatch(permit, intent, fn)  [default-deny]
//              -> provider dispatch
//
// authorize()/dispatch() also drive Persistent Model Spend Reservation (see
// modelSpendReservation.js): authorize() durably persists a RESERVED
// reservation before a permit ever exists; dispatch() durably persists the
// DISPATCHING boundary before the physical provider call, then settles the
// reservation SETTLED_KNOWN or UNRESOLVED once the call completes. An
// UNRESOLVED reservation blocks every further internal model spend attempt
// in that workflow (see authorize()'s MODEL_SPEND_USAGE_UNRESOLVED gate).
//
// This module establishes the invariant "every real internal provider
// invocation must hold a valid, single-use PhysicalCallPermit before
// dispatch". It carries NO token-budget policy yet: the default injected
// policy is allow-all (budget authorization is a later task; see Card 3 for
// per-physical-call budget rechecks). It DOES enforce one built-in
// invariant ahead of the injected `policy` callback — provider eligibility
// for the requested role, decided by an explicit `providerCapabilities`
// source (default: the PRODUCTION Provider Capability Policy in
// providerCapabilities.js) — so an Executor CallIntent for a family not
// declared executorEligible (e.g. codex:default, claude:opus while the
// automatic Executor chain is Sonnet-only) is denied before any `policy`
// or permit exists, REGARDLESS of what rolePolicy routed it here. This is
// not a bypassable flag: there is no "skip eligibility" switch, only which
// capability source answers "is this family eligible" — production code
// always uses the production source; only test fixtures that need to
// exercise the generic multi-provider failover mechanism inject an
// explicit TEST-ONLY permissive source. Even so it still enforces:
//
//   * permit issuance   — a permit is minted only by authorize(); an ordinary
//                          caller cannot synthesize one (the token is held in
//                          the authority's private map, never on the object in
//                          an enumerable / forgeable way).
//   * intent binding    — a permit authorizes exactly the { role, family,
//                          provider, operationId, attempt } it was issued for.
//   * single use        — one permit authorizes exactly one physical dispatch.
//   * default deny      — dispatch() runs the provided dispatch fn ONLY after a
//                          valid, unconsumed, intent-matched permit is proven.
//
// Failover to another provider must obtain a FRESH permit: the runtime issues
// one permit per physical attempt, never one per logical role invocation.

import { randomUUID } from 'node:crypto';
import {
  AuthorizationError, AUTHORIZATION_ERROR_CODES, isCancellation,
} from './errors.js';
import { isExecutorEligible as productionIsExecutorEligible } from './providerCapabilities.js';
import {
  ReservationLedger, RESERVATION_STATUS, SETTLEMENT_REASON, humanExcludedFamilies,
} from './modelSpendReservation.js';
import { NewInformationLedger } from './newInformation.js';

// The strongest invocation identifiers mechanically available at the role
// runtime boundary. Missing semantic IDs are bound as null rather than
// invented — a permit issued with operationId:null still only matches another
// intent whose operationId is null.
//
// `workflowId` is an explicit minimal extension (not inferred from
// `operationId`'s "${workflowId}:${taskId}" convention) so Persistent Model
// Spend Reservation can key deterministically on the workflow a physical
// call belongs to, regardless of how `operationId` happens to be formatted
// by a given caller.
//
// `evidenceRef` (§ Global New Information Policy, Phase 2 item 9) is a
// COMPACT deterministic digest of the CallIntent's `evidenceIds` — never the
// raw ids array (arrays don't compare by value) and never the underlying
// Gate output / diff / review transcript. It binds a permit to the exact
// evidence set that justified it: a permit minted for evidence set A cannot
// be replayed against an intent claiming evidence set B. Intents that never
// carry `evidenceIds` (the overwhelming majority of existing callers/tests
// that do not wire a NewInformationLedger) normalize to `evidenceRef: null`
// on both sides and are unaffected.
export const CALL_INTENT_KEYS = Object.freeze(['role', 'family', 'provider', 'operationId', 'attempt', 'workflowId', 'evidenceRef']);

// Whether an earlier physical attempt is DURABLY, MECHANICALLY proven to have
// never reached the provider. This is the ONLY basis on which a later attempt
// may reuse the New Information claim that authorized attempt 1.
//
//   UNKNOWN != ZERO   ZERO USAGE != PRE-SEND
//
// A zero token count is NOT accepted as proof: a post-send
// PROVIDER_PROTOCOL_ERROR can settle SETTLED_KNOWN with usage {0,0} yet still
// have hit the provider. Proof requires one of these durable, unambiguous
// states:
//   - RESERVED / CANCELLED_PRE_DISPATCH — the ordering invariant proves the
//     physical call was impossible: markDispatching persists the durable
//     DISPATCHING boundary before dispatchFn is ever invoked, so a reservation
//     that never reached DISPATCHING never sent a byte.
//   - SETTLED_KNOWN with settlementReason === PROVEN_PRE_SEND_ZERO — dispatch()
//     saw an explicit orchestrator-set pre-send provenance flag on the
//     failure (spawn/transport abort before any bytes were sent).
// Anything else — DISPATCHING, UNRESOLVED, SETTLED_KNOWN success, ordinary
// provider failure (with or without usage {0,0}), or missing/ambiguous
// provenance — is treated as "may have reached the provider".
function isProvenPreSendZero(reservation) {
  if (reservation.status === RESERVATION_STATUS.RESERVED
    || reservation.status === RESERVATION_STATUS.CANCELLED_PRE_DISPATCH) return true;
  return reservation.status === RESERVATION_STATUS.SETTLED_KNOWN
    && (reservation.settlementReason === SETTLEMENT_REASON.PROVEN_PRE_SEND_ZERO
      || reservation.settlementReason === SETTLEMENT_REASON.PROVEN_QUOTA_REJECTED_ZERO);
}

function computeEvidenceRef(evidenceIds) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return null;
  const cleaned = evidenceIds.filter((id) => id !== null && id !== undefined).map(String);
  if (cleaned.length === 0) return null;
  return [...cleaned].sort().join(',');
}

export function normalizeCallIntent(intent = {}) {
  const out = {};
  for (const key of CALL_INTENT_KEYS) {
    if (key === 'evidenceRef') continue;
    const value = intent[key];
    out[key] = value === undefined ? null : value;
  }
  out.evidenceRef = computeEvidenceRef(intent.evidenceIds);
  if (!out.role || !out.family) {
    throw new AuthorizationError(
      AUTHORIZATION_ERROR_CODES.INTENT_INCOMPLETE,
      'CallIntent must carry at least a role and a provider family',
      { intent: out },
    );
  }
  return out;
}

function intentMatches(a, b) {
  return CALL_INTENT_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

// Opaque authorization token. The secret that ties it back to the issuing
// authority (`#token`) is a true private field: it is not enumerable, not
// serialized, and cannot be read or reconstructed by a caller, so a permit
// cannot be forged or copied by an ordinary caller.
export class PhysicalCallPermit {
  #token;

  constructor(token, intent) {
    this.#token = token;
    this.intent = Object.freeze({ ...intent });
    this.issuedAt = intent.issuedAt ?? null;
    Object.freeze(this);
  }

  // Package-private: only ModelSpendAuthority calls this, passing its own
  // brand object. Any other caller gets undefined and cannot lift the token.
  _revealTokenTo(brand) {
    return brand === PhysicalCallPermit._brand ? this.#token : undefined;
  }
}
PhysicalCallPermit._brand = Symbol('PhysicalCallPermit.brand');

// Extracts whatever usage evidence a dispatch outcome carries, WITHOUT ever
// estimating a token amount (UNKNOWN USAGE != ZERO).
//
// A successful functional result proves the provider responded; it does NOT
// by itself prove the token spend was reliably accounted for. Settlement is
// therefore known ONLY when reliable usage evidence is actually present —
// on success or on failure alike:
//
//   - success: known iff the resolved value carries a `usage` field. The
//     bare existence of a return value (or a callId with no usage) is NOT
//     sufficient — it proves the call happened, not that its cost is known.
//   - failure: known ONLY when the thrown error itself carries explicit
//     usage evidence (`error.details.usage` / `error.usage`) — the shape
//     every adapter that reaches this call already uses when a post-send
//     guard (budget / duplicate-call / invalid-output) fires with real
//     provider usage in hand. Any other failure (timeout, killed process,
//     transport failure, missing usage telemetry, ...) is conservatively
//     UNRESOLVED: a business/protocol error never implies the spend was
//     zero.
//
// Neither branch estimates or synthesizes a usage value; both simply report
// whether one was actually supplied.
function extractSettlementUsage(outcome) {
  if (outcome.ok) {
    const usage = outcome.value?.usage ?? outcome.value?.value?.usage ?? null;
    return { known: usage !== null && usage !== undefined, usage, callId: usage?.callId ?? outcome.value?.callId ?? null };
  }
  const usage = outcome.error?.details?.usage ?? outcome.error?.usage ?? null;
  return { known: usage !== null && usage !== undefined, usage, callId: usage?.callId ?? null };
}

// Content-free, bounded failure metadata persisted on an UNRESOLVED reservation
// so an unknown-usage failure can later be classified or audited (the original
// stderr is otherwise lost). Never prompt/reply text: stderr/envelope are the
// CLI's operational diagnostics, already bounded at the transport.
function safeFailureDiagnostics(error) {
  if (!error || typeof error !== 'object') return null;
  const out = {
    code: error.code ?? null,
    exitCode: Number.isFinite(error.exitCode) ? error.exitCode : null,
    durationMs: Number.isFinite(error.durationMs) ? error.durationMs : null,
    stdoutWasEmpty: typeof error.stdoutWasEmpty === 'boolean' ? error.stdoutWasEmpty : null,
    usageEvidenceState: typeof error.usageEvidenceState === 'string' ? error.usageEvidenceState : null,
    stderrExcerpt: typeof error.stderr === 'string' ? error.stderr.slice(0, 1000) : null,
    envelope: error.envelope && typeof error.envelope === 'object' ? error.envelope : null,
  };
  return Object.values(out).every((v) => v === null) ? null : out;
}

export class ModelSpendAuthority {
  // `policy(intent) -> { allow: boolean, reason?: string }`. The default is a
  // deterministic allow-all: budget authorization is a later task. Swapping in
  // a real policy does not change any of the permit mechanics below.
  //
  // `providerCapabilities` — an explicit { isExecutorEligible(family) ->
  // boolean } source for the built-in eligibility invariant below. Defaults
  // to the PRODUCTION Provider Capability Policy
  // (providerCapabilities.js — Sonnet-only Executor). This is deliberately
  // NOT a bypass flag: there is no "skip eligibility" option, only "which
  // capability source decides eligibility". Production code must never
  // override it; only test fixtures that explicitly need to exercise the
  // generic multi-provider failover mechanism inject a TEST-ONLY permissive
  // source here — production `rolePolicy` choices never do.
  //
  // `reservationLedger` — the Persistent Model Spend Reservation lifecycle
  // (see modelSpendReservation.js). Defaults to an in-memory-only ledger
  // (no filesystem I/O; fine for unit tests). Production callers inject one
  // backed by a `ReservationStore(persistence)` so a reservation survives
  // the same restart/resume path as the rest of the workflow.
  //
  // `recordSafetyEvent` — optional `(event) => void` forwarded to the ledger
  // so an UNRESOLVED reservation's BLOCKING safety event reaches the
  // workflow's user-visible terminal result (see safetyEvents.js /
  // workflowState.js#recordSafetyEvent) without this Authority needing to
  // know how a workflow's terminal state is assembled.
  //
  // `informationLedger` — Global New Information Policy (§ Phase 1-6,
  // newInformation.js). OPTIONAL, exactly like `policy` and
  // `reservationLedger` are optional collaborators with safe defaults: when
  // no ledger is wired, authorize() performs NO evidence check at all —
  // identical to this Authority's behavior before this feature existed. When
  // a ledger IS wired, enforcement is MANDATORY for every authorize() call,
  // regardless of what the raw CallIntent does or does not carry — there is
  // no per-CallIntent opt-out (no `evidenceIds` property, an `undefined` /
  // `null` / empty one, or one whose ids are all unregistered/ineligible/
  // already-consumed, all resolve to "zero eligible evidence" and are
  // denied identically). This is NOT a bypass flag (there is no
  // `skipNewInformationCheck` toggle anywhere in this module): it is simply
  // "which collaborator objects this Authority instance was constructed
  // with", the same pattern already used for
  // `policy`/`providerCapabilities`/`reservationLedger`. Production wiring
  // (reviewSpend.js) always constructs this Authority
  // WITH an informationLedger, so production enforcement is unconditional; a
  // caller that constructs its own ModelSpendAuthority without one gets the
  // pre-existing, unaffected behavior — the intended compatibility boundary
  // for a codebase-wide test suite that predates this policy and exercises
  // permit/reservation/provider mechanics directly.
  constructor({
    policy = () => ({ allow: true }), onEvent, providerCapabilities, reservationLedger, recordSafetyEvent,
    informationLedger = null,
  } = {}) {
    this._policy = policy;
    this._onEvent = onEvent;
    this._isExecutorEligible = providerCapabilities?.isExecutorEligible ?? productionIsExecutorEligible;
    this._issued = new Map(); // token -> { intent, consumed, consumedAt, reservationId }
    this._reservationLedger = reservationLedger
      ?? new ReservationLedger({ onEvent, recordSafetyEvent });
    this._informationLedger = informationLedger;
    this._recordSafetyEvent = recordSafetyEvent;
  }

  get reservationLedger() {
    return this._reservationLedger;
  }

  // The durable reservationId minted for a permit this authority issued (so a
  // caller can attach its own durable accounting record to the same physical
  // attempt). Returns null for an unknown / forged permit.
  reservationIdFor(permit) {
    const token = permit instanceof PhysicalCallPermit
      ? permit._revealTokenTo(PhysicalCallPermit._brand)
      : undefined;
    return (typeof token === 'string' && this._issued.get(token)?.reservationId) || null;
  }

  get informationLedger() {
    return this._informationLedger;
  }

  // CallIntent -> PhysicalCallPermit. Throws AuthorizationError (SPEND_DENIED /
  // INTENT_INCOMPLETE / MODEL_SPEND_USAGE_UNRESOLVED / RESERVATION_PERSIST_FAILED)
  // before any permit exists if the intent is rejected.
  //
  // Ordering is safety-critical: the reservation is created and durably
  // PERSISTED (RESERVED) BEFORE this returns a permit. A caller can never
  // reach dispatch() without a durably persisted reservation already on
  // record, and a persistence failure here means zero physical provider
  // calls (fail closed) — no permit is ever minted.
  async authorize(rawIntent) {
    const intent = normalizeCallIntent(rawIntent);
    // Persistent Model Spend Reservation safety gate — checked before every
    // other decision, for EVERY internal role (not only Executor): a prior
    // physical call in this workflow whose usage could not be reliably
    // settled blocks all further internal model spend until a human clears
    // it. This is an orchestrator safety decision, never provider failure.
    if (await this._reservationLedger.hasUnresolved(intent.workflowId)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
        `workflow ${JSON.stringify(intent.workflowId)} has an unresolved model spend reservation; `
          + 'further internal model spend is blocked until a human clears it',
        { intent },
      );
    }
    // A family a human explicitly excluded while recovering unresolved spend
    // must never be dispatched again in this workflow (backstop to routing).
    let excluded;
    try {
      excluded = humanExcludedFamilies(await this._reservationLedger.list(intent.workflowId));
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
        `model spend reservation state could not be read for exclusion check: ${error?.message ?? error}`,
        { intent },
      );
    }
    if (excluded.has(intent.family)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.FAMILY_EXCLUDED_BY_HUMAN,
        `provider family ${JSON.stringify(intent.family)} was explicitly excluded by a human recovery; choose another candidate`,
        { intent },
      );
    }
    // Provider eligibility is a built-in Authority invariant, not a
    // caller-overridable policy choice: it is checked BEFORE the injected
    // policy callback, so no custom policy can accidentally re-open a
    // provider that providerCapabilities.js does not declare eligible for
    // this role. Today this only constrains role === 'executor' (Executor
    // automatic chain is Sonnet-only); other roles are unaffected even when
    // routed to codex/agy families.
    if (intent.role === 'executor' && !this._isExecutorEligible(intent.family)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
        `provider family "${intent.family}" is not executorEligible; the automatic Executor chain does not include it`,
        { intent },
      );
    }
    let decision;
    try {
      decision = this._policy(intent);
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
        `spend policy threw for ${intent.role}/${intent.family}: ${error?.message ?? error}`,
        { intent },
      );
    }
    if (!decision || decision.allow !== true) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
        decision?.reason || `spend denied for ${intent.role}/${intent.family}`,
        { intent },
      );
    }
    // § Global New Information Policy (Phase 1-6) — NECESSARY, NOT
    // SUFFICIENT: this runs only when an informationLedger is wired (see the
    // constructor doc above); it never bypasses any check above or below it,
    // and nothing above/below it ever bypasses this. Deterministic, zero
    // model calls: `findEligibleUnconsumed` only ever consults durably
    // registered evidence records and this workflow's consumption ledger.
    //
    // Ordering: evidence is durably CONSUMED here, before the reservation is
    // even created — so a caller can never reach a permit / dispatch for a
    // CallIntent whose evidence was not already durably claimed. A read or
    // write failure against the information ledger fails closed (zero
    // physical provider calls), exactly like every other Reservation
    // fail-closed path in this module.
    //
    // § Global New Information Policy (Wiring Cards 1-3): production wires
    // ONE shared informationLedger onto the ONE ModelSpendAuthority used by
    // every role (Planner, Supervisor, Executor, Reviewer, PR-closeout
    // repair) — see reviewSpend.js and the removed orchestrator. As
    // of Wiring Card 3 every production internal physical model call site
    // supplies `evidenceIds`; production enforcement is therefore effectively
    // unconditional for every real workflow.
    //
    // The enforcement gate is keyed SOLELY on whether this Authority instance
    // was constructed with an informationLedger — never on anything about the
    // raw CallIntent. This is deliberate: a per-CallIntent "evidence-aware"
    // escape (gating enforcement on whether the caller happened to supply an
    // `evidenceIds` property) would let a production call site silently
    // bypass the global policy merely by forgetting to thread evidence
    // through. The Authority boundary must establish "no eligible new
    // information -> no permit" itself, not rely on every call site to opt in
    // correctly. A missing / undefined / null / empty `evidenceIds`, or one
    // whose ids are all unregistered/ineligible/already-consumed, is treated
    // identically: zero candidates, so `findEligibleUnconsumed` finds nothing
    // and this denies. This keeps a caller that constructs its own
    // ModelSpendAuthority directly WITHOUT an informationLedger (the
    // overwhelming majority of this codebase's low-level unit tests that
    // exercise permit/reservation/provider mechanics) behaving exactly as it
    // did before this feature existed — that absence of an informationLedger
    // is the ONLY compatibility boundary, not a per-call property. Every
    // production ModelSpendAuthority (reviewSpend.js)
    // is constructed WITH an informationLedger, so production enforcement is
    // unconditional. Grep for `evidenceIds:` at invoke() call sites in
    // src/orchestrator/{reviewloop/*}.js to
    // verify the production inventory has not silently grown or shrunk — see
    // also tests/newInformationProductionWiring.test.js.
    let humanRetryGrant = null;
    if (this._informationLedger) {
      const rawEvidenceIds = rawIntent?.evidenceIds;
      const candidateEvidenceIds = Array.isArray(rawEvidenceIds)
        ? rawEvidenceIds.filter((id) => id !== null && id !== undefined)
        : [];
      let eligible;
      try {
        eligible = await this._informationLedger.findEligibleUnconsumed({
          workflowId: intent.workflowId, role: intent.role, operationId: intent.operationId, evidenceIds: candidateEvidenceIds,
        });
      } catch (error) {
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
          `new information state could not be read: ${error?.message ?? error}`,
          { intent },
        );
      }
      // Retry / failover of an operation that ALREADY legitimately consumed one
      // of these evidenceIds on an earlier physical attempt: the single logical
      // state that authorized attempt 1 covers attempts 2..N of the SAME
      // (role, operationId). This never CREATES eligibility — a first attempt
      // (attempt <= 1) with no fresh evidence is still denied below, and the
      // retry count is bounded by the caller (controller.js
      // providerAttemptBudget(role) == that role's candidate count). It exists
      // so "one diff+gate logical state authorizes exactly one dispatch
      // SEQUENCE", not "each evidenceId is a separate dispatch token".
      if (!eligible && Number(intent.attempt) > 1) {
        // Bounded failover may reuse the ONE New Information claim that
        // authorized attempt 1 of this operation — but ONLY when there is at
        // least one earlier physical attempt of this SAME (role, operationId)
        // on record AND every one of them is DURABLY, MECHANICALLY proven to
        // have never reached the provider (CANCELLED_PRE_DISPATCH, or
        // SETTLED_KNOWN with settlementReason PROVEN_PRE_SEND_ZERO — see
        // isProvenPreSendZero). A zero token count is NOT proof: a post-send
        // PROVIDER_PROTOCOL_ERROR can report usage {0,0} yet still have spent.
        // Missing / ambiguous provenance, a still-open DISPATCHING / UNRESOLVED
        // record, an ordinary provider failure, or a success all mean "no new
        // information -> no further physical call", exactly as for attempt 1.
        let priorReservations = [];
        try {
          priorReservations = await this._reservationLedger.list(intent.workflowId);
        } catch (error) {
          throw new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
            `model spend reservation state could not be read for failover-reuse: ${error?.message ?? error}`,
            { intent },
          );
        }
        const earlierAttempts = priorReservations.filter((r) => (
          (r.taskId ?? null) === (intent.operationId ?? null)
          && (r.role ?? null) === (intent.role ?? null)
          && Number(r.physicalAttempt) < Number(intent.attempt)
        ));
        const allProvenPreSendZero = earlierAttempts.length > 0
          && earlierAttempts.every(isProvenPreSendZero);

        let priorClaim = null;
        try {
          priorClaim = await this._informationLedger.findConsumedBy({
            workflowId: intent.workflowId, role: intent.role, operationId: intent.operationId, evidenceIds: candidateEvidenceIds,
          });
        } catch (error) {
          throw new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
            `new information state could not be read: ${error?.message ?? error}`,
            { intent },
          );
        }

        if (allProvenPreSendZero && priorClaim) {
          eligible = { evidenceId: priorClaim.evidenceId, type: null, _failoverReuse: true };
        } else if (priorClaim) {
          // Human acknowledgement is a distinct, explicit one-shot recovery
          // authority. It does NOT claim the unknown call was zero and does NOT
          // manufacture "new information". Every earlier attempt that may have
          // reached the provider must itself be an acknowledged UNRESOLVED
          // reservation; any success or ordinary known-usage failure still
          // blocks reuse of the same evidence.
          const nonPreSend = earlierAttempts.filter((r) => !isProvenPreSendZero(r));
          const allUnknownAccepted = nonPreSend.length > 0 && nonPreSend.every((r) => (
            r.status === RESERVATION_STATUS.UNRESOLVED
            && r?.humanAcknowledgement?.accepted === true
            && r?.humanAcknowledgement?.accountingRecorded === true
          ));
          if (allUnknownAccepted) {
            try {
              humanRetryGrant = await this._reservationLedger.findHumanRetryGrant({
                workflowId: intent.workflowId,
                role: intent.role,
                operationId: intent.operationId,
                evidenceIds: candidateEvidenceIds,
              });
            } catch (error) {
              throw new AuthorizationError(
                AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
                `human spend acknowledgement state could not be read: ${error?.message ?? error}`,
                { intent },
              );
            }
            if (humanRetryGrant
              && String(humanRetryGrant.humanAcknowledgement?.evidenceId ?? '') === String(priorClaim.evidenceId)) {
              eligible = {
                evidenceId: priorClaim.evidenceId,
                type: null,
                _humanRetryReuse: true,
              };
            }
          }
        }
      }
      if (!eligible) {
        // § Phase 6 — a Global New Information denial is a BLOCKING,
        // user-visible safety event, exactly like an UNRESOLVED reservation.
        // Mechanical context only (role/operation/candidate evidence types) —
        // never a prompt, diff, or Gate output body.
        this._recordSafetyEvent?.({
          code: 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED',
          severity: 'BLOCKING',
          role: intent.role,
          taskId: intent.operationId,
          reason: `no fresh, unconsumed, eligible New Information evidence justifies this ${intent.role} call`,
          actionTaken: 'physical model call denied — retry/failover/timeout/provider failure are never new information',
        });
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
          `no fresh, unconsumed, eligible New Information evidence justifies a ${intent.role} call `
            + `for operation ${JSON.stringify(intent.operationId)}; retry / failover / timeout / provider `
            + 'failure are never new information',
          { intent, candidateEvidenceIds },
        );
      }
      try {
        // A failover-reuse claim is already durably consumed — re-consuming is
        // an idempotent no-op, but skip it to keep the intent explicit.
        if (!eligible._failoverReuse && !eligible._humanRetryReuse) {
          await this._informationLedger.consume({
            workflowId: intent.workflowId, role: intent.role, operationId: intent.operationId, evidenceId: eligible.evidenceId,
          });
        }
      } catch (error) {
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
          `new information consumption could not be durably persisted: ${error?.message ?? error}`,
          { intent },
        );
      }
    }
    const reservationId = randomUUID();
    try {
      if (humanRetryGrant) {
        await this._reservationLedger.reserveWithHumanRetryGrant({
          workflowId: intent.workflowId,
          sourceReservationId: humanRetryGrant.reservationId,
          evidenceId: humanRetryGrant.humanAcknowledgement.evidenceId,
          intent,
          physicalAttempt: intent.attempt,
          reservationId,
        });
      } else {
        await this._reservationLedger.reserve({
          workflowId: intent.workflowId, intent, physicalAttempt: intent.attempt, reservationId,
        });
      }
    } catch (error) {
      // Fail closed: reservation persistence failed, so no permit is ever
      // minted and the physical call count for this attempt is zero.
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
        `model spend reservation could not be durably persisted: ${error?.message ?? error}`,
        { intent },
      );
    }
    const token = randomUUID();
    this._issued.set(token, {
      intent, consumed: false, consumedAt: null, reservationId,
    });
    this._onEvent?.({ type: 'PERMIT_ISSUED', ...intent });
    return new PhysicalCallPermit(token, intent);
  }

  // Default-deny protected dispatch. Runs `dispatchFn` (the real provider
  // call) ONLY when `permit` is a permit this authority issued, is not yet
  // consumed, and is bound to this exact CallIntent. The permit is consumed
  // BEFORE the dispatch fn runs, so a throwing / failing provider call can
  // never be retried on the same permit — the failover attempt must
  // authorize() again.
  //
  // The reservation's durable DISPATCHING boundary is persisted BEFORE
  // dispatchFn is ever invoked (a persistence failure here means dispatchFn
  // is never called — fail closed). After dispatchFn settles (success or
  // throw), the reservation is settled: SETTLED_KNOWN when reliable usage
  // evidence exists (the original business success/failure is returned/
  // thrown normally), UNRESOLVED otherwise (never estimated, never treated
  // as zero — see extractSettlementUsage above). An UNRESOLVED outcome is
  // itself an immediate Token Safety blocking condition: this method NEVER
  // returns/throws the original business outcome once usage is unresolved —
  // it throws AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED
  // instead, so a caller cannot mistake "the call functionally succeeded"
  // for "it is safe to keep advancing the workflow".
  async dispatch(permit, rawIntent, dispatchFn) {
    const intent = normalizeCallIntent(rawIntent);
    const token = permit instanceof PhysicalCallPermit
      ? permit._revealTokenTo(PhysicalCallPermit._brand)
      : undefined;
    if (typeof token !== 'string') {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_MISSING,
        'provider dispatch attempted without a PhysicalCallPermit',
        { intent },
      );
    }
    const record = this._issued.get(token);
    if (!record) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_UNKNOWN,
        'PhysicalCallPermit was not issued by this authority',
        { intent },
      );
    }
    if (record.consumed) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_CONSUMED,
        'PhysicalCallPermit already consumed; one permit authorizes exactly one dispatch',
        { intent },
      );
    }
    if (!intentMatches(record.intent, intent)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_INTENT_MISMATCH,
        'PhysicalCallPermit does not authorize this CallIntent',
        { intent, permitIntent: record.intent },
      );
    }
    try {
      await this._reservationLedger.markDispatching({ workflowId: intent.workflowId, reservationId: record.reservationId });
    } catch (error) {
      // Fail closed: the durable "dispatch may begin" boundary could not be
      // persisted, so dispatchFn (the physical provider call) never runs.
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
        `model spend reservation dispatch boundary could not be durably persisted: ${error?.message ?? error}`,
        { intent },
      );
    }
    record.consumed = true;
    record.consumedAt = Date.now();
    this._onEvent?.({ type: 'PERMIT_CONSUMED', ...intent });

    // The physical call itself is isolated from settlement bookkeeping below:
    // `outcome` captures success/failure WITHOUT yet deciding anything about
    // the reservation, so a settlement-persistence failure is never
    // misclassified as "the provider call failed" (and vice versa).
    let outcome;
    try {
      outcome = { ok: true, value: await dispatchFn() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const settlement = extractSettlementUsage(outcome);
    // Durable pre-send provenance: set ONLY by an upstream orchestrator layer
    // (reviewSpend.js) on a failure it mechanically classified as a spawn /
    // transport abort before any bytes were sent — never inferred here from a
    // zero token count. This is what lets a later attempt reuse the same New
    // Information claim (see isProvenPreSendZero / the failover-reuse gate).
    const preSendZeroProven = !outcome.ok && outcome.error?.details?.preSendZeroProven === true;

    if (settlement.known) {
      try {
        await this._reservationLedger.settleKnown({
          workflowId: intent.workflowId,
          reservationId: record.reservationId,
          usageCallId: settlement.callId,
          usageReference: settlement.usage,
          reason: outcome.ok
            ? 'PROVIDER_CALL_SUCCEEDED'
            : (preSendZeroProven
              ? (outcome.error?.details?.zeroProof === 'AGY_QUOTA_REJECTION'
                ? SETTLEMENT_REASON.PROVEN_QUOTA_REJECTED_ZERO
                : SETTLEMENT_REASON.PROVEN_PRE_SEND_ZERO)
              : 'PROVIDER_CALL_FAILED_WITH_KNOWN_USAGE'),
        });
      } catch (persistError) {
        // Settlement persistence failure (§ Failure 2). The provider
        // physically ran and its usage WAS known, but the durable
        // SETTLED_KNOWN write itself failed — the ledger's own cache is
        // guaranteed to still read as DISPATCHING (see
        // ReservationLedger.settleKnown), which already blocks further
        // spend for this workflow. This is an orchestrator persistence
        // failure, never provider failure: it must never be classified as
        // a provider outcome, never trigger failover, and never mark the
        // provider unhealthy — it is thrown as an AuthorizationError,
        // exactly like every other Reservation fail-closed path, so the
        // generic failover mechanism (which only ever failsover on
        // provider/AdapterError outcomes) does not see it as one.
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.MODEL_SPEND_SETTLEMENT_PERSIST_FAILED,
          `model spend settlement could not be durably persisted: ${persistError?.message ?? persistError}`,
          { intent, providerOutcome: outcome.ok ? 'SUCCESS' : 'FAILURE' },
        );
      }
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }

    // Usage was not reliably known — UNRESOLVED regardless of whether the
    // provider call itself succeeded or failed (§ Failure 1). A successful
    // functional result never implies the token spend was accounted for.
    //
    // § Phase 0B: the durable UNRESOLVED write itself must fail closed. If
    // `markUnresolved` cannot durably persist the candidate (its own
    // durable-before-cache discipline guarantees the cache is left
    // completely untouched — still DISPATCHING, itself already blocking),
    // this must surface as a DEDICATED AuthorizationError, never as the raw
    // persistence error: an unclassified error here would otherwise reach
    // productionRoleRuntime.invoke()'s generic failure path, get
    // misclassified as provider unavailable/timeout, mutate provider health,
    // and potentially trigger failover to another provider — exactly the
    // ambiguity this task closes.
    try {
      await this._reservationLedger.markUnresolved({
        workflowId: intent.workflowId,
        reservationId: record.reservationId,
        reason: outcome.ok
          ? 'PROVIDER_CALL_SUCCEEDED_NO_RELIABLE_USAGE'
          : (outcome.error?.code ?? outcome.error?.message ?? 'USAGE_UNKNOWN_AFTER_DISPATCH'),
        diagnostics: outcome.ok ? null : safeFailureDiagnostics(outcome.error),
      });
    } catch (persistError) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_UNRESOLVED_PERSIST_FAILED,
        `model spend UNRESOLVED state could not be durably persisted: ${persistError?.message ?? persistError}; `
          + 'the reservation remains at its prior (already-blocking) durable status',
        { intent, providerOutcome: outcome.ok ? 'SUCCESS' : 'FAILURE' },
      );
    }
    // A cancellation (AbortSignal, AGY_ABORTED, a killed child process, ...)
    // is a pre-existing, orthogonal invariant (see errors.js#isCancellation):
    // it is never a provider/spend failure and must reach the caller as
    // EXACTLY the original cancellation error, unrecognisable-as-anything-
    // else, so the runtime's own cancellation short-circuit (zero failover,
    // zero classification, zero health/quota mutation) still fires. The
    // reservation is still latched UNRESOLVED above — a cancellation gives no
    // more proof of zero spend than any other unknown-usage outcome — but the
    // error object propagated here is deliberately NOT wrapped, unlike every
    // other unresolved-usage case below.
    if (!outcome.ok && isCancellation(outcome.error)) {
      throw outcome.error;
    }
    // An UNRESOLVED reservation is not merely a guard against the NEXT
    // physical call — it is an immediate Token Safety blocking outcome for
    // THIS invocation too. The reservation is already durably persisted as
    // UNRESOLVED (above) and its own BLOCKING safety event already recorded
    // (ReservationLedger.markUnresolved -> recordSafetyEvent) before this
    // throws, so the workflow-visible halt is never racing ahead of the
    // durable/user-visible record of why. dispatch() must NEVER let a
    // provider/business outcome (success OR failure) escape as an ordinary
    // result once usage is unresolved: the caller only ever sees a single
    // deterministic AuthorizationError, exactly like every other Reservation
    // fail-closed path — no failover, no provider-health mutation, no new
    // physical call. The original functional outcome is preserved only as
    // non-authoritative diagnostic metadata (`details.businessOutcome`),
    // never as a signal that the invocation was safe to treat as complete.
    throw new AuthorizationError(
      AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
      `${intent.role} physical call for ${JSON.stringify(intent.family)} `
        + `${outcome.ok ? 'completed' : 'may have completed'} but its usage could not be reliably settled; `
        + 'further automatic workflow progression is blocked until a human clears the unresolved model spend reservation',
      {
        intent,
        businessOutcome: outcome.ok ? 'SUCCESS' : 'FAILURE',
        ...(outcome.ok ? {} : { originalErrorMessage: outcome.error?.message ?? String(outcome.error), originalErrorCode: outcome.error?.code ?? null }),
      },
    );
  }

  // Test / diagnostics only.
  stats() {
    let issued = 0;
    let consumed = 0;
    for (const record of this._issued.values()) {
      issued += 1;
      if (record.consumed) consumed += 1;
    }
    return { issued, consumed, outstanding: issued - consumed };
  }
}
