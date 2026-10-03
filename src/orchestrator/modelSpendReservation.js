// Persistent Model Spend Reservation.
//
//   CallIntent -> ModelSpendAuthority.authorize()
//              -> create + PERSIST reservation (RESERVED)
//              -> PhysicalCallPermit
//              -> ModelSpendAuthority.dispatch()
//              -> PERSIST dispatch-may-begin (DISPATCHING)
//              -> physical provider invocation
//              -> settle: SETTLED_KNOWN | UNRESOLVED
//
// Safety principle: once a provider MAY have been physically called, the
// spend must either be reliably accounted for, or treated as unresolved and
// block further automatic internal model spend in that workflow.
//
//   UNKNOWN USAGE != ZERO. Unknown usage is never estimated.
//
// This module owns the reservation data model and its lifecycle
// (ReservationLedger) plus the persistence adapter over the EXISTING
// workflow-scoped snapshot (Persistence.readWorkflowState /
// updateWorkflowState — see persistence.js and PERSISTENCE.md). It does not
// duplicate that storage: a reservation survives the identical
// restart/resume path as the rest of the workflow, under the
// `modelSpendReservations` key of workflow.json. A workflow persisted before
// this feature existed simply has no such key — that reads back as an empty
// ledger, never as corruption.

import { randomUUID } from 'node:crypto';

export const RESERVATION_STATUS = Object.freeze({
  // Durably persisted. Physical dispatch is still forbidden.
  RESERVED: 'RESERVED',
  // Durably persisted "dispatch may begin" boundary. Once here, a crash may
  // make it impossible to know whether provider spend occurred — an
  // abandoned DISPATCHING reservation is unsafe and reconciles to UNRESOLVED.
  DISPATCHING: 'DISPATCHING',
  // Reliable usage/accounting evidence exists for this physical call,
  // independent of business/provider outcome.
  SETTLED_KNOWN: 'SETTLED_KNOWN',
  // Physical dispatch may have occurred but reliable usage settlement cannot
  // be proven. Blocks further internal model spend in the same workflow.
  UNRESOLVED: 'UNRESOLVED',
  // A RESERVED reservation that PROVABLY never crossed the durable
  // DISPATCHING boundary. Safe to close without treating it as unknown
  // provider spend.
  CANCELLED_PRE_DISPATCH: 'CANCELLED_PRE_DISPATCH',
});

const WORKFLOW_STATE_KEY = 'modelSpendReservations';

// The ONLY settlement reason that durably proves a SETTLED_KNOWN reservation
// never reached the provider. It is written solely by
// ModelSpendAuthority.dispatch() when the dispatch outcome carries an explicit
// orchestrator-set pre-send provenance flag (details.preSendZeroProven) —
// NEVER inferred from a zero token count. `SETTLED_KNOWN` + all-zero usage on
// its own proves nothing about pre-send (a post-send PROVIDER_PROTOCOL_ERROR
// can report usage {0,0} yet still have hit the provider).
export const SETTLEMENT_REASON = Object.freeze({
  PROVEN_PRE_SEND_ZERO: 'PROVEN_PRE_SEND_ZERO',
});

// A reservation in one of these statuses must block further internal model
// spend in its workflow. DISPATCHING is included even though it has not yet
// been rewritten to UNRESOLVED by reconcileOnResume(): it is itself proof
// that a physical dispatch may have occurred, so safety must not depend
// solely on reconciliation succeeding (§ Failure 2 / Failure 3).
const BLOCKING_RESERVATION_STATUSES = new Set([
  RESERVATION_STATUS.DISPATCHING,
  RESERVATION_STATUS.UNRESOLVED,
]);

export function isBlockingReservationStatus(status) {
  return BLOCKING_RESERVATION_STATUSES.has(status);
}

function isHumanAcknowledgedUnresolved(record) {
  return record?.status === RESERVATION_STATUS.UNRESOLVED
    && record?.humanAcknowledgement?.accepted === true
    && record?.humanAcknowledgement?.accountingRecorded === true;
}

export function newReservationRecord({
  reservationId, workflowId, intent, physicalAttempt, createdAt,
}) {
  return {
    reservationId,
    workflowId: workflowId ?? null,
    taskId: intent?.operationId ?? null,
    role: intent?.role ?? null,
    family: intent?.family ?? null,
    provider: intent?.provider ?? null,
    physicalAttempt: physicalAttempt ?? intent?.attempt ?? null,
    status: RESERVATION_STATUS.RESERVED,
    createdAt,
    dispatchStartedAt: null,
    settledAt: null,
    settlementReason: null,
    usageCallId: null,
    usageReference: null,
  };
}

// Persistence adapter over the existing workflow-scoped snapshot. Every
// mutation is a read-modify-write against the SAME durable workflow.json the
// rest of the orchestrator already uses (Persistence.updateWorkflowState),
// so no parallel standalone database is introduced.
export class ReservationStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(workflowId) {
    // A test double / minimal persistence stand-in that does not implement
    // the workflow-state interface (see Persistence in persistence.js) is
    // treated exactly like "no persistence configured" — in-memory only —
    // never as a runtime failure. A REAL Persistence instance always
    // implements this interface, so this only ever degrades a deliberately
    // partial test fixture, never masks a genuine persistence error.
    if (!workflowId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return {};
    const state = await this._persistence.readWorkflowState(workflowId);
    const reservations = state?.[WORKFLOW_STATE_KEY];
    return reservations && typeof reservations === 'object' ? { ...reservations } : {};
  }

  async save(workflowId, reservations) {
    if (!workflowId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    await this._persistence.updateWorkflowState(workflowId, { [WORKFLOW_STATE_KEY]: reservations });
  }
}

// The reservation lifecycle. One ledger typically backs one ModelSpendAuthority
// (production wiring), but the ledger itself is authority-agnostic: it keys
// everything by workflowId, never by which ModelSpendAuthority instance
// called it, so "has this workflow got unresolved spend" is answered
// correctly regardless of how many authority instances exist for that
// workflow (e.g. the PR-closeout repair fallback path's own authority).
//
// Without a `store` (the default), the ledger is in-memory only for the
// lifetime of the process — every mutation still goes through the exact same
// ordering/awaiting contract, so unit tests exercise the real state machine
// without needing a filesystem.
export class ReservationLedger {
  constructor({ store = null, onEvent, recordSafetyEvent } = {}) {
    this._store = store;
    this._onEvent = onEvent;
    this._recordSafetyEvent = recordSafetyEvent;
    this._cache = new Map(); // workflowId -> Map(reservationId -> record)
  }

  async _loadWorkflow(workflowId) {
    const key = workflowId ?? null;
    if (this._cache.has(key)) return this._cache.get(key);
    const persisted = this._store ? await this._store.load(key) : {};
    const map = new Map(Object.entries(persisted ?? {}));
    this._cache.set(key, map);
    return map;
  }

  async _persistWorkflow(workflowId) {
    const key = workflowId ?? null;
    const map = this._cache.get(key) ?? new Map();
    if (this._store) {
      await this._store.save(key, Object.fromEntries(map.entries()));
    }
  }

  // Persists an explicit candidate map WITHOUT touching the in-memory cache.
  // Used by settleKnown() so the cache can never report a status ahead of
  // what is durably persisted (§ Failure 2 / Option A): the candidate is
  // written to durable storage first, and only committed to `this._cache`
  // by the caller after this resolves successfully.
  async _persistCandidate(workflowId, candidateMap) {
    if (!this._store) return;
    await this._store.save(workflowId ?? null, Object.fromEntries(candidateMap.entries()));
  }

  // RESERVED — durably persisted BEFORE this resolves. Throws (fail closed)
  // if persistence fails; the caller must not proceed to mint a permit or
  // dispatch when this rejects.
  async reserve({ workflowId, intent, physicalAttempt, reservationId = randomUUID() }) {
    const map = await this._loadWorkflow(workflowId);
    const record = newReservationRecord({
      reservationId, workflowId, intent, physicalAttempt, createdAt: new Date().toISOString(),
    });
    map.set(reservationId, record);
    await this._persistWorkflow(workflowId);
    this._onEvent?.({ type: 'RESERVATION_RESERVED', reservationId, workflowId: workflowId ?? null, role: intent?.role, family: intent?.family });
    return record;
  }

  // Durable "dispatch may begin" boundary — MUST be awaited and completed
  // before the physical provider adapter is ever invoked.
  async markDispatching({ workflowId, reservationId }) {
    const map = await this._loadWorkflow(workflowId);
    const record = map.get(reservationId);
    if (!record) throw new Error(`ReservationLedger.markDispatching: unknown reservation ${reservationId}`);

    const dispatchStartedAt = new Date().toISOString();
    const candidateMap = new Map(map);
    const candidate = {
      ...record,
      status: RESERVATION_STATUS.DISPATCHING,
      dispatchStartedAt,
    };

    // A human-authorized retry grant is consumed at the durable DISPATCHING
    // boundary, not when the RESERVED permit is merely allocated. That keeps a
    // crash-before-dispatch retry recoverable while still guaranteeing that one
    // acknowledged unknown-spend event can authorize at most one real provider
    // dispatch.
    if (record.humanRetrySourceReservationId) {
      const source = map.get(record.humanRetrySourceReservationId);
      const ack = source?.humanAcknowledgement;
      const grant = ack?.retryGrant;
      if (!isHumanAcknowledgedUnresolved(source)
        || grant?.reservedForReservationId !== reservationId
        || grant?.consumedAt) {
        throw new Error(
          `ReservationLedger.markDispatching: invalid human retry grant for reservation ${reservationId}`,
        );
      }
      candidateMap.set(source.reservationId, {
        ...source,
        humanAcknowledgement: {
          ...ack,
          retryGrant: {
            ...grant,
            consumedAt: dispatchStartedAt,
            consumedByReservationId: reservationId,
          },
        },
      });
    }

    candidateMap.set(reservationId, candidate);
    await this._persistCandidate(workflowId, candidateMap);
    for (const [id, value] of candidateMap.entries()) map.set(id, value);
    this._onEvent?.({ type: 'RESERVATION_DISPATCHING', reservationId, workflowId: workflowId ?? null });
    return candidate;
  }

  // Idempotent: settling an already-SETTLED_KNOWN reservation again is a
  // no-op (never re-applied / double-counted) and never downgrades it.
  //
  // Cache-cannot-outrun-durable-state (§ Failure 2 / Option A): the candidate
  // SETTLED_KNOWN record is durably persisted FIRST, on a candidate map that
  // never touches `this._cache`. Only after that persistence resolves does
  // the cache get mutated to match. If persistence throws, this rejects
  // and the cache is left completely untouched — still whatever it was
  // before this call (DISPATCHING, in production usage), which is a
  // spend-blocking state. Callers must not catch this and proceed.
  async settleKnown({
    workflowId, reservationId, usageCallId = null, usageReference = null, reason = null,
  }) {
    const map = await this._loadWorkflow(workflowId);
    const record = map.get(reservationId);
    if (!record) throw new Error(`ReservationLedger.settleKnown: unknown reservation ${reservationId}`);
    if (record.status === RESERVATION_STATUS.SETTLED_KNOWN) return record;
    const candidate = {
      ...record,
      status: RESERVATION_STATUS.SETTLED_KNOWN,
      settledAt: new Date().toISOString(),
      settlementReason: reason,
      usageCallId,
      usageReference,
    };
    const candidateMap = new Map(map);
    candidateMap.set(reservationId, candidate);
    await this._persistCandidate(workflowId, candidateMap);
    // Only reached once durable persistence has succeeded.
    map.set(reservationId, candidate);
    this._onEvent?.({ type: 'RESERVATION_SETTLED_KNOWN', reservationId, workflowId: workflowId ?? null });
    return candidate;
  }

  // A physical call may have occurred but reliable usage cannot be proven.
  // Never downgrades an already-settled reservation. Fires the BLOCKING
  // safety event so the reason reaches the terminal workflow result.
  //
  // Durable-before-cache (same principle as settleKnown, § Phase 0B): the
  // candidate UNRESOLVED record is durably persisted FIRST, on a candidate
  // map that never touches `this._cache`. Only after that persistence
  // resolves does the cache get mutated to match. If persistence throws,
  // this rejects and the cache is left completely untouched — still
  // whatever it was before this call (DISPATCHING in production usage),
  // which is itself already a spend-blocking status. Callers must not catch
  // this and proceed; ModelSpendAuthority.dispatch() classifies a rejection
  // here as its own dedicated AuthorizationError
  // (MODEL_SPEND_UNRESOLVED_PERSIST_FAILED) rather than letting the raw
  // persistence error escape unclassified (where it could otherwise be
  // mistaken for a provider failure and trigger failover / health mutation).
  async markUnresolved({ workflowId, reservationId, reason = null }) {
    const map = await this._loadWorkflow(workflowId);
    const record = map.get(reservationId);
    if (!record) throw new Error(`ReservationLedger.markUnresolved: unknown reservation ${reservationId}`);
    if (record.status === RESERVATION_STATUS.SETTLED_KNOWN) return record;
    const candidate = {
      ...record,
      status: RESERVATION_STATUS.UNRESOLVED,
      settledAt: new Date().toISOString(),
      settlementReason: reason,
    };
    const candidateMap = new Map(map);
    candidateMap.set(reservationId, candidate);
    await this._persistCandidate(workflowId, candidateMap);
    // Only reached once durable persistence has succeeded.
    map.set(reservationId, candidate);
    this._onEvent?.({ type: 'RESERVATION_UNRESOLVED', reservationId, workflowId: workflowId ?? null, reason });
    this._recordSafetyEvent?.({
      code: 'MODEL_SPEND_USAGE_UNRESOLVED',
      severity: 'BLOCKING',
      role: record.role,
      taskId: record.taskId,
      attempt: record.physicalAttempt,
      reason: reason ?? 'Physical model call may have dispatched but usage could not be reliably settled',
      actionTaken: 'Further internal model spend blocked for this workflow',
    });
    return candidate;
  }

  // A RESERVED reservation that provably never crossed the durable
  // DISPATCHING boundary. Only safe pre-dispatch; a no-op on anything else.
  async cancelPreDispatch({ workflowId, reservationId, reason = null }) {
    const map = await this._loadWorkflow(workflowId);
    const record = map.get(reservationId);
    if (!record || record.status !== RESERVATION_STATUS.RESERVED) return record ?? null;
    const settledAt = new Date().toISOString();
    const candidateMap = new Map(map);
    const candidate = {
      ...record,
      status: RESERVATION_STATUS.CANCELLED_PRE_DISPATCH,
      settledAt,
      settlementReason: reason,
    };
    candidateMap.set(reservationId, candidate);

    // Release an allocated human retry grant when the retry reservation never
    // crossed DISPATCHING. This is safe: CANCELLED_PRE_DISPATCH is mechanical
    // proof that the provider was never reached.
    if (record.humanRetrySourceReservationId) {
      const source = map.get(record.humanRetrySourceReservationId);
      const ack = source?.humanAcknowledgement;
      const grant = ack?.retryGrant;
      if (isHumanAcknowledgedUnresolved(source)
        && grant?.reservedForReservationId === reservationId
        && !grant?.consumedAt) {
        candidateMap.set(source.reservationId, {
          ...source,
          humanAcknowledgement: {
            ...ack,
            retryGrant: {
              ...grant,
              reservedForReservationId: null,
              reservedAt: null,
            },
          },
        });
      }
    }

    await this._persistCandidate(workflowId, candidateMap);
    for (const [id, value] of candidateMap.entries()) map.set(id, value);
    return candidate;
  }

  // Blocking predicate (§ Failure 2): DISPATCHING is itself unsafe, not only
  // UNRESOLVED. A reservation that has crossed the durable dispatch boundary
  // is evidence a physical call MAY have run — it must block new spend
  // whether or not reconcileOnResume() has yet rewritten it to UNRESOLVED.
  // The name is kept for compatibility with existing callers/tests; it now
  // answers "is there an unsafe spend reservation", not literally "is there
  // a record whose status field equals UNRESOLVED".
  async hasUnresolved(workflowId) {
    const map = await this._loadWorkflow(workflowId);
    for (const record of map.values()) {
      if (!isBlockingReservationStatus(record.status)) continue;
      // A human acknowledgement does NOT rewrite history: the reservation
      // stays UNRESOLVED. It only says the operator accepts the irrecoverable
      // unknown spend and authorizes one bounded retry. DISPATCHING is never
      // acknowledgeable and always remains blocking.
      if (isHumanAcknowledgedUnresolved(record)) continue;
      return true;
    }
    return false;
  }

  async list(workflowId) {
    const map = await this._loadWorkflow(workflowId);
    return Array.from(map.values());
  }

  async findHumanRetryGrant({ workflowId, role, operationId, evidenceIds = [] } = {}) {
    const map = await this._loadWorkflow(workflowId);
    const ids = new Set((evidenceIds ?? []).map(String));
    const matches = [];
    for (const record of map.values()) {
      if (!isHumanAcknowledgedUnresolved(record)) continue;
      if ((record.role ?? null) !== (role ?? null) || (record.taskId ?? null) !== (operationId ?? null)) continue;
      const ack = record.humanAcknowledgement;
      const grant = ack?.retryGrant;
      if (!grant || grant.consumedAt || grant.reservedForReservationId) continue;
      if (!ids.has(String(ack.evidenceId ?? ''))) continue;
      matches.push(record);
    }
    if (matches.length > 1) {
      throw new Error(
        `ReservationLedger.findHumanRetryGrant: multiple active grants for ${role}/${operationId}`,
      );
    }
    return matches[0] ?? null;
  }

  async reserveWithHumanRetryGrant({
    workflowId, sourceReservationId, evidenceId, intent, physicalAttempt,
    reservationId = randomUUID(),
  }) {
    const map = await this._loadWorkflow(workflowId);
    const source = map.get(sourceReservationId);
    const ack = source?.humanAcknowledgement;
    const grant = ack?.retryGrant;
    if (!isHumanAcknowledgedUnresolved(source)
      || (source.role ?? null) !== (intent?.role ?? null)
      || (source.taskId ?? null) !== (intent?.operationId ?? null)
      || String(ack?.evidenceId ?? '') !== String(evidenceId ?? '')
      || !grant
      || grant.consumedAt
      || grant.reservedForReservationId) {
      throw new Error(
        `ReservationLedger.reserveWithHumanRetryGrant: grant unavailable for ${sourceReservationId}`,
      );
    }

    const createdAt = new Date().toISOString();
    const record = {
      ...newReservationRecord({
        reservationId, workflowId, intent, physicalAttempt, createdAt,
      }),
      humanRetrySourceReservationId: sourceReservationId,
      humanRetryEvidenceId: String(evidenceId),
    };
    const candidateMap = new Map(map);
    candidateMap.set(sourceReservationId, {
      ...source,
      humanAcknowledgement: {
        ...ack,
        retryGrant: {
          ...grant,
          reservedForReservationId: reservationId,
          reservedAt: createdAt,
        },
      },
    });
    candidateMap.set(reservationId, record);
    await this._persistCandidate(workflowId, candidateMap);
    for (const [id, value] of candidateMap.entries()) map.set(id, value);
    this._onEvent?.({
      type: 'HUMAN_SPEND_RETRY_RESERVED',
      workflowId: workflowId ?? null,
      sourceReservationId,
      reservationId,
      role: intent?.role,
    });
    this._onEvent?.({ type: 'RESERVATION_RESERVED', reservationId, workflowId: workflowId ?? null, role: intent?.role, family: intent?.family });
    return record;
  }

  // Resume reconciliation (§10):
  //   - RESERVED, never DISPATCHING  -> CANCELLED_PRE_DISPATCH (safe: the
  //     ordering invariant proves physical dispatch was impossible).
  //   - DISPATCHING, never settled   -> UNRESOLVED (conservative: the process
  //     may have physically dispatched before crashing).
  //   - UNRESOLVED / SETTLED_KNOWN   -> unchanged; a restart never clears an
  //     unresolved condition, and a settled call is never re-flagged.
  async reconcileOnResume(workflowId) {
    const map = await this._loadWorkflow(workflowId);
    let changed = false;
    for (const record of map.values()) {
      if (record.status === RESERVATION_STATUS.DISPATCHING) {
        record.status = RESERVATION_STATUS.UNRESOLVED;
        record.settledAt = new Date().toISOString();
        record.settlementReason = 'RESUME_RECONCILE_DISPATCHING_UNSETTLED';
        changed = true;
        this._recordSafetyEvent?.({
          code: 'MODEL_SPEND_USAGE_UNRESOLVED',
          severity: 'BLOCKING',
          role: record.role,
          taskId: record.taskId,
          attempt: record.physicalAttempt,
          reason: 'Resume found a reservation that crossed the dispatch boundary with no durable settlement',
          actionTaken: 'Further internal model spend blocked for this workflow',
        });
      } else if (record.status === RESERVATION_STATUS.RESERVED) {
        record.status = RESERVATION_STATUS.CANCELLED_PRE_DISPATCH;
        record.settledAt = new Date().toISOString();
        record.settlementReason = 'RESUME_RECONCILE_NEVER_DISPATCHED';
        if (record.humanRetrySourceReservationId) {
          const source = map.get(record.humanRetrySourceReservationId);
          const ack = source?.humanAcknowledgement;
          const grant = ack?.retryGrant;
          if (isHumanAcknowledgedUnresolved(source)
            && grant?.reservedForReservationId === record.reservationId
            && !grant?.consumedAt) {
            source.humanAcknowledgement = {
              ...ack,
              retryGrant: {
                ...grant,
                reservedForReservationId: null,
                reservedAt: null,
              },
            };
          }
        }
        changed = true;
      }
    }
    if (changed) await this._persistWorkflow(workflowId);
    return Array.from(map.values());
  }
}
