// Human recovery for a tripped Token Sentinel latch.
//
// The latch is a post-settlement safety stop (reviewSpend.js). Clearing it is a
// human decision, so this module is reachable only from the CLI, under the loop
// lease, bound to the exact latch event the human has seen in the report.
//
// What it does, in ONE workflow-state write:
//   1. marks the latch `tripped:false` (every original field is kept),
//   2. appends an audit entry that lists the spend records that existed at that
//      moment, so a restart's spend-log re-inference does not re-latch them.
// What it never does: touch the spend ledger, the frozen contract, baseline,
// phases, evidence, budget overrides, the unaccounted-spend flag or the loop
// state machine. A later over-threshold call latches again as usual.

import { REVIEW_LOOP_STATES } from './state.js';
import {
  CALL_ALLOWANCE_KEY, TOKEN_ACK_STANDARD_LIMIT, MAX_ALLOWANCE_REVIEWER_CALLS, MAX_ALLOWANCE_SUPERVISOR_CALLS,
  commitGuardedUpdate, fingerprint, nextCallAllowance, parseCallCount,
} from './humanActionGuard.js';

export const TOKEN_ANOMALY_KEY = 'reviewLoopTokenAnomaly';
export const TOKEN_ANOMALY_ACKS_KEY = 'reviewLoopTokenAnomalyAcks';
export const SPEND_KEY = 'reviewLoopSpend';
const STATE_KEY = 'reviewLoop';
export { TOKEN_ACK_STANDARD_LIMIT };

// Stable identity of a durable spend record: the reservation id when present,
// otherwise its position (the log is append-only, so the position is stable).
export function ackIdForRecord(record, index) {
  const id = record?.reservationId;
  return typeof id === 'string' && id ? id : `ordinal:${index}`;
}

export function acknowledgedIds(acks) {
  const ids = new Set();
  for (const a of Array.isArray(acks) ? acks : []) {
    for (const id of Array.isArray(a?.acknowledgedSpendIds) ? a.acknowledgedSpendIds : []) ids.add(id);
  }
  return ids;
}

// `allowance` ({reviewerCalls, supervisorCalls}) and `currentLimits` (the
// effective call ceilings the spend authority enforces now) are needed from the
// 4th acknowledgement on: a human may always confirm again, but past the
// standard count the confirmation must state a NUMERIC budget of further calls,
// which is enforced as this loop's call ceiling (it can only tighten).
export async function acknowledgeTokenAnomaly({
  persistence, loopId, latchAt, reason, allowance = null, currentLimits = null, now = () => new Date(),
}) {
  if (!loopId) throw new Error('acknowledge-token-anomaly requires a loopId');
  if (!String(latchAt ?? '').trim()) throw new Error('acknowledge-token-anomaly requires --latch <latch timestamp from the report>');
  if (!String(reason ?? '').trim()) throw new Error('acknowledge-token-anomaly requires an explicit reason');

  const workflow = await persistence.readWorkflowState(loopId);
  const before = fingerprint(workflow);
  const loop = workflow?.[STATE_KEY];
  if (!loop) throw new Error(`unknown loopId ${loopId}`);
  if (loop.objective?.mode === 'PR') {
    throw new Error('ReviewLoop PR session retired; cannot acknowledge a token anomaly; use claude-review-bot');
  }
  if ([REVIEW_LOOP_STATES.PASS, REVIEW_LOOP_STATES.FAILED, REVIEW_LOOP_STATES.STOPPED].includes(loop.state)
    || loop.budgetExhausted === true) {
    throw new Error(`loop is ${loop.state}${loop.budgetExhausted ? ' (convergence budget spent)' : ''}; a token anomaly can only be acknowledged on a loop that can still continue`);
  }
  const latch = workflow?.[TOKEN_ANOMALY_KEY];
  if (!latch || latch.tripped !== true) {
    throw new Error('no tripped Token Sentinel latch on this loop (already acknowledged, or never tripped)');
  }
  if (String(latch.at) !== String(latchAt).trim()) {
    throw new Error(`--latch does not match the current latch event (${latch.at}); re-read the report and confirm the event you mean`);
  }
  const acks = Array.isArray(workflow?.[TOKEN_ANOMALY_ACKS_KEY]) ? workflow[TOKEN_ANOMALY_ACKS_KEY] : [];
  const extended = acks.length >= TOKEN_ACK_STANDARD_LIMIT;
  const reviewerCalls = parseCallCount(allowance?.reviewerCalls, { name: '--max-reviewer-calls', max: MAX_ALLOWANCE_REVIEWER_CALLS });
  const supervisorCalls = parseCallCount(allowance?.supervisorCalls, { name: '--max-supervisor-calls', max: MAX_ALLOWANCE_SUPERVISOR_CALLS });
  if (extended && reviewerCalls == null) {
    throw new Error(`this loop already had ${acks.length} token anomalies acknowledged (standard limit ${TOKEN_ACK_STANDARD_LIMIT}); a further confirmation is still possible but must state how many more Reviewer calls this attempt may use: add --max-reviewer-calls <1-${MAX_ALLOWANCE_REVIEWER_CALLS}> (enforced as this loop's call ceiling)`);
  }

  const records = Array.isArray(workflow?.[SPEND_KEY]?.records) ? workflow[SPEND_KEY].records : [];
  const at = now().toISOString();
  const priorAllowanceEntries = Array.isArray(workflow?.[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history.length : 0;
  const applyAllowance = reviewerCalls != null || supervisorCalls != null;
  const nextAllowance = applyAllowance
    ? nextCallAllowance({
      workflow, currentLimits, reviewerCalls, supervisorCalls, mode: 'tighten',
      tier: extended ? 'EXTENDED' : 'STANDARD', reason, at, source: 'acknowledge-token-anomaly',
    })
    : null;
  const entry = {
    tier: extended ? 'EXTENDED' : 'STANDARD',
    ...(nextAllowance ? { allowance: nextAllowance.history.slice(priorAllowanceEntries) } : {}),
    at,
    latchAt: latch.at,
    reason: String(reason).trim(),
    trigger: latch.trigger ?? null,
    threshold: latch.threshold ?? null,
    usageVolume: latch.usageVolume ?? null,
    contextOverheadTokens: latch.contextOverheadTokens ?? null,
    spendRecordCount: records.length,
    acknowledgedSpendIds: records.map(ackIdForRecord),
  };
  // Defence in depth on top of the CLI's loop lease (bin/reviewloop.js takes it
  // before calling this): serialize re-read + single write and refuse if
  // anything this decision was based on has moved, so a stale snapshot is never written.
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'acknowledging the token anomaly',
    buildPatch: () => ({
      [TOKEN_ANOMALY_KEY]: { ...latch, tripped: false, clearedAt: at, clearedReason: entry.reason },
      [TOKEN_ANOMALY_ACKS_KEY]: [...acks, entry],
      ...(nextAllowance ? { [CALL_ALLOWANCE_KEY]: nextAllowance } : {}),
    }),
  });
  return { loopId, tier: entry.tier, allowance: entry.allowance ?? null, acknowledgements: acks.length + 1, latchAt: latch.at, trigger: entry.trigger, loopState: loop.state, acknowledgedRecords: records.length };
}
