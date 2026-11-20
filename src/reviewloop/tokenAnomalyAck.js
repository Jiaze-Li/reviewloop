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

export const TOKEN_ANOMALY_KEY = 'reviewLoopTokenAnomaly';
export const TOKEN_ANOMALY_ACKS_KEY = 'reviewLoopTokenAnomalyAcks';
export const SPEND_KEY = 'reviewLoopSpend';
const STATE_KEY = 'reviewLoop';
export const MAX_TOKEN_ANOMALY_ACKS = 3;

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

export async function acknowledgeTokenAnomaly({ persistence, loopId, latchAt, reason, now = () => new Date() }) {
  if (!loopId) throw new Error('acknowledge-token-anomaly requires a loopId');
  if (!String(latchAt ?? '').trim()) throw new Error('acknowledge-token-anomaly requires --latch <latch timestamp from the report>');
  if (!String(reason ?? '').trim()) throw new Error('acknowledge-token-anomaly requires an explicit reason');

  const workflow = await persistence.readWorkflowState(loopId);
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
  if (acks.length >= MAX_TOKEN_ANOMALY_ACKS) {
    throw new Error(`this loop already had ${MAX_TOKEN_ANOMALY_ACKS} token anomalies acknowledged; the task needs a product decision, not another unlock`);
  }

  const records = Array.isArray(workflow?.[SPEND_KEY]?.records) ? workflow[SPEND_KEY].records : [];
  const at = now().toISOString();
  const entry = {
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
  // before calling this): re-read right before the write and refuse if anything
  // this decision was based on has moved, so a stale snapshot is never written.
  const fresh = await persistence.readWorkflowState(loopId);
  const freshAcks = Array.isArray(fresh?.[TOKEN_ANOMALY_ACKS_KEY]) ? fresh[TOKEN_ANOMALY_ACKS_KEY] : [];
  const freshRecords = Array.isArray(fresh?.[SPEND_KEY]?.records) ? fresh[SPEND_KEY].records : [];
  if (fresh?.[TOKEN_ANOMALY_KEY]?.tripped !== true
    || String(fresh[TOKEN_ANOMALY_KEY].at) !== String(latch.at)
    || freshAcks.length !== acks.length
    || freshRecords.length !== records.length
    || fresh?.[STATE_KEY]?.updatedAt !== loop.updatedAt) {
    throw new Error(`concurrent modification detected in loop ${loopId} while acknowledging the token anomaly; nothing was written, re-read the report and retry`);
  }
  await persistence.updateWorkflowState(loopId, {
    [TOKEN_ANOMALY_KEY]: { ...latch, tripped: false, clearedAt: at, clearedReason: entry.reason },
    [TOKEN_ANOMALY_ACKS_KEY]: [...acks, entry],
  });
  return { loopId, acknowledgements: acks.length + 1, latchAt: latch.at, trigger: entry.trigger, loopState: loop.state, acknowledgedRecords: records.length };
}
