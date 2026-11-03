// Read-only, content-free audit of one model-spend operation or reservation.
//
// This inspection deliberately DOES NOT call reconcileOnResume(), because
// that routine mutates DISPATCHING -> UNRESOLVED. Never take an active loop
// lease, acknowledge UNKNOWN usage, retry models, or edit workflow.json here.
// Provider/native request IDs are reported only when already present; a local
// operationId/reservationId is never mislabelled as a provider request ID.

const METERED_ROLES = new Set(['reviewer', 'supervisor']);
const CONTEXT_FIELDS = [
  'inputTokens', 'outputTokens', 'thinkingTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'reportedTotalTokens',
];

function scalar(value) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}
const safe = (value) => typeof value === 'string' && value.length <= 256 ? value : null;

function diagnosticOf(r) {
  const d = r?.failureDiagnostics ?? {};
  return {
    code: safe(d.code),
    exitCode: scalar(d.exitCode),
    durationMs: scalar(d.durationMs),
    usageEvidenceState: safe(d.usageEvidenceState),
    stdoutWasEmpty: typeof d.stdoutWasEmpty === 'boolean' ? d.stdoutWasEmpty : null,
  };
}
function usageOf(r) {
  const breakdown = {};
  for (const name of CONTEXT_FIELDS) breakdown[name] = scalar(r?.usageBreakdown?.[name]);
  return {
    usageKnown: r?.usageKnown === true,
    usageVolume: r?.usageKnown === true ? scalar(r?.usageVolume) : null,
    usageBreakdown: breakdown,
    costKnown: r?.costKnown === true,
    costUsd: r?.costKnown === true ? scalar(r?.costUsd) : null,
    accountingResolved: r?.usageAccounting?.volumeResolved === true,
    businessOutcome: safe(r?.businessOutcome),
    failureCode: safe(r?.failureCode),
  };
}

export async function inspectSpend({ persistence, loopId, reservationId = null, operationId = null } = {}) {
  if (!persistence || typeof persistence.readWorkflowState !== 'function') {
    throw new Error('inspect-spend requires readable workflow persistence');
  }
  if (typeof loopId !== 'string' || !/^rl-[A-Za-z0-9-]+$/.test(loopId)) {
    throw new Error('inspect-spend requires a valid --loop ID');
  }
  if (Boolean(reservationId) === Boolean(operationId)) {
    throw new Error('inspect-spend requires exactly one --reservation or --operation');
  }
  const state = await persistence.readWorkflowState(loopId);
  if (!state?.reviewLoop) throw new Error(`unknown ReviewLoop session: ${loopId}`);
  const reservations = Object.values(state.modelSpendReservations ?? {})
    .filter((r) => METERED_ROLES.has(r?.role)
      && (reservationId ? r?.reservationId === reservationId : r?.taskId === operationId));
  const allSpends = Array.isArray(state.reviewLoopSpend?.records)
    ? state.reviewLoopSpend.records : [];

  const items = reservations.map((r) => {
    const spends = allSpends.filter((s) => s.reservationId === r.reservationId
      || (!s.reservationId && s.operationId === r.taskId && s.attempt === r.physicalAttempt));
    const flags = [];
    if (r.status === 'DISPATCHING') flags.push('MAY_HAVE_DISPATCHED');
    if (r.status === 'UNRESOLVED') flags.push('UNRESOLVED_UNKNOWN_USAGE');
    if (r.status === 'SETTLED_KNOWN' && spends.length === 0) flags.push('SETTLED_WITHOUT_SPEND_RECORD');
    if (spends.length > 1) flags.push('DUPLICATE_SPEND_RECORDS');
    if (spends.some(s => s.usageKnown === false)) flags.push('UNKNOWN_USAGE_IN_SPEND_LOG');
    return {
      reservationId: safe(r.reservationId),
      operationId: safe(r.taskId),
      role: safe(r.role),
      family: safe(r.family),
      provider: safe(r.provider),
      physicalAttempt: scalar(r.physicalAttempt),
      status: safe(r.status),
      createdAt: safe(r.createdAt),
      dispatchStartedAt: safe(r.dispatchStartedAt),
      settledAt: safe(r.settledAt),
      settlementReason: safe(r.settlementReason),
      usageCallId: safe(r.usageCallId),
      hasUsageReference: r.usageReference != null,
      diagnostic: diagnosticOf(r),
      humanAcknowledged: r.humanAcknowledgement?.accepted === true,
      spendRecords: spends.map(usageOf),
      flags,
    };
  });

  return {
    loopId,
    loopState: safe(state.reviewLoop.state),
    round: scalar(state.reviewLoop.round),
    query: reservationId ? { reservationId } : { operationId },
    // Report absent evidence honestly; no synthetic provider call or usage.
    reservationCount: items.length,
    reservations: items,
    readOnly: true,
    note: 'IDs are local unless confirmed provider-native; UNKNOWN usage/cost are not zero. No reconciliation or model calls were performed.',
  };
}

export function formatSpendInspection(result) {
  const lines = [
    `ReviewLoop spend inspection: ${result.loopId}`,
    `Loop state: ${result.loopState ?? 'UNKNOWN'}; reservations: ${result.reservationCount}`,
  ];
  for (const r of result.reservations) {
    lines.push(
      `  ${r.reservationId}: ${r.status}; role=${r.role} family=${r.family ?? '?'} attempt=${r.physicalAttempt ?? '?'}`,
      `    operation=${r.operationId}; dispatchAt=${r.dispatchStartedAt ?? 'UNKNOWN'}; reason=${r.settlementReason ?? 'UNKNOWN'}`,
      `    recorded spend entries=${r.spendRecords.length}; provider usage call ID=${r.usageCallId ?? 'NOT_RECORDED'}`,
      `    warnings=${r.flags.join(', ') || 'none'}`,
    );
  }
  lines.push(result.note);
  return lines.join('\n');
}
