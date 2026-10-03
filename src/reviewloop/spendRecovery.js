// Human recovery for genuinely UNRESOLVED model spend.
//
// This is the explicit escape hatch for a fail-closed reservation whose usage
// cannot be reconstructed. It never rewrites UNRESOLVED into SETTLED_KNOWN and
// never invents zero usage. Instead it durably:
//   1. records the operator acknowledgement on the original reservation,
//   2. appends one UNKNOWN-cost/UNKNOWN-usage spend record for that physical call,
//   3. grants exactly one retry for the same role + operation + evidence.
//
// The retry grant is consumed later at the durable DISPATCHING boundary by
// ReservationLedger, so crash-before-dispatch remains safely recoverable.

import { randomUUID } from 'node:crypto';
import { RESERVATION_STATUS } from '../orchestrator/modelSpendReservation.js';

const METERED_ROLES = new Set(['reviewer', 'supervisor']);

function objectValues(value) {
  return value && typeof value === 'object' ? Object.values(value) : [];
}

export async function acknowledgeUnresolvedSpend({
  persistence,
  loopId,
  reservationId,
  reason,
  now = () => new Date().toISOString(),
} = {}) {
  if (!persistence || typeof persistence.readWorkflowState !== 'function'
    || typeof persistence.updateWorkflowState !== 'function') {
    throw new Error('acknowledgeUnresolvedSpend requires durable workflow persistence');
  }
  if (typeof loopId !== 'string' || !loopId.trim()) {
    throw new Error('acknowledgeUnresolvedSpend requires --loop');
  }
  if (typeof reservationId !== 'string' || !reservationId.trim()) {
    throw new Error('acknowledgeUnresolvedSpend requires --reservation');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('acknowledgeUnresolvedSpend requires a non-empty --reason');
  }

  const state = await persistence.readWorkflowState(loopId);
  if (!state?.reviewLoop) throw new Error(`unknown ReviewLoop session: ${loopId}`);
  if (state.reviewLoop.budgetExhausted === true) {
    throw new Error('this loop exhausted its convergence budget; spend acknowledgement cannot reopen it');
  }

  const reservations = state.modelSpendReservations && typeof state.modelSpendReservations === 'object'
    ? { ...state.modelSpendReservations }
    : {};
  const reservation = reservations[reservationId];
  if (!reservation) throw new Error(`unknown reservation ${reservationId} in loop ${loopId}`);
  if (reservation.status !== RESERVATION_STATUS.UNRESOLVED) {
    throw new Error(
      `reservation ${reservationId} is ${reservation.status ?? 'UNKNOWN'}, not UNRESOLVED`,
    );
  }
  if (!METERED_ROLES.has(reservation.role)) {
    throw new Error(`reservation ${reservationId} role ${reservation.role} is not human-recoverable`);
  }

  const existingAck = reservation.humanAcknowledgement;
  const spendState = state.reviewLoopSpend && typeof state.reviewLoopSpend === 'object'
    ? state.reviewLoopSpend
    : { records: [] };
  const spendRecords = Array.isArray(spendState.records) ? [...spendState.records] : [];
  const existingSpend = spendRecords.find((r) => r?.reservationId === reservationId);

  if (existingAck?.accepted === true) {
    if (!existingSpend || existingSpend.usageKnown !== false || existingSpend.costKnown !== false) {
      throw new Error(
        `reservation ${reservationId} has an acknowledgement but its UNKNOWN spend accounting record is missing/inconsistent`,
      );
    }
    return {
      loopId,
      reservationId,
      alreadyAcknowledged: true,
      acknowledgementId: existingAck.acknowledgementId ?? null,
      role: reservation.role,
      operationId: reservation.taskId ?? null,
      evidenceId: existingAck.evidenceId ?? null,
      retryAvailable: !existingAck.retryGrant?.consumedAt,
    };
  }

  if (existingSpend) {
    throw new Error(
      `reservation ${reservationId} already has a spend record; refusing to duplicate or reinterpret it`,
    );
  }

  const consumptions = objectValues(state.modelSpendInformation?.consumptions).filter((c) => (
    (c?.role ?? null) === (reservation.role ?? null)
    && (c?.operationId ?? null) === (reservation.taskId ?? null)
  ));
  if (consumptions.length !== 1 || !consumptions[0]?.evidenceId) {
    throw new Error(
      `cannot bind a one-shot retry safely: expected exactly one consumed evidence item for ${reservation.role}/${reservation.taskId}, found ${consumptions.length}`,
    );
  }
  const evidenceId = String(consumptions[0].evidenceId);
  if (!state.modelSpendInformation?.events?.[evidenceId]) {
    throw new Error(`consumed evidence ${evidenceId} is missing from the durable evidence ledger`);
  }

  const acknowledgedAt = now();
  const acknowledgementId = randomUUID();
  const acknowledgement = {
    acknowledgementId,
    accepted: true,
    acknowledgedAt,
    reason: reason.trim(),
    evidenceId,
    accountingRecorded: true,
    retryGrant: {
      maxDispatches: 1,
      reservedForReservationId: null,
      reservedAt: null,
      consumedAt: null,
      consumedByReservationId: null,
    },
  };

  reservations[reservationId] = {
    ...reservation,
    // Preserve the historical fact: status stays UNRESOLVED forever.
    humanAcknowledgement: acknowledgement,
  };

  spendRecords.push({
    role: reservation.role,
    model: null,
    family: reservation.family ?? null,
    provider: reservation.provider ?? null,
    usageKnown: false,
    usageVolume: 0,
    usageAccounting: {
      method: 'human_acknowledged_unknown',
      semanticsKnown: false,
      volumeResolved: false,
      accountingClass: 'unknown',
      reportedTotalTokens: null,
    },
    usageBreakdown: {
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      reportedTotalTokens: null,
      rawFieldSumTokens: null,
    },
    payloadMeta: null,
    contextOverheadTokens: null,
    costUsd: 0,
    costKnown: false,
    businessOutcome: 'FAILURE',
    failureCode: reservation.settlementReason ?? 'UNRESOLVED',
    operationId: reservation.taskId ?? null,
    attempt: reservation.physicalAttempt ?? null,
    rawUsage: null,
    round: null,
    chunkIndex: null,
    chunkTotal: null,
    quotaPools: null,
    reservationId,
    humanAcknowledgedUnresolved: true,
    humanAcknowledgementId: acknowledgementId,
    humanAcknowledgedAt: acknowledgedAt,
    at: reservation.settledAt ?? acknowledgedAt,
  });

  // One workflow-state update keeps acknowledgement + UNKNOWN accounting
  // together. A crash leaves both or neither.
  await persistence.updateWorkflowState(loopId, {
    modelSpendReservations: reservations,
    reviewLoopSpend: { ...spendState, records: spendRecords },
  });

  return {
    loopId,
    reservationId,
    alreadyAcknowledged: false,
    acknowledgementId,
    role: reservation.role,
    operationId: reservation.taskId ?? null,
    evidenceId,
    retryAvailable: true,
  };
}
