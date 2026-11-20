// Human recovery for a gate whose automatic convergence budget is spent.
//
// A loop that reaches HUMAN_REQUIRED with budgetExhausted is terminal for the
// Worker: it must report and stop. That is right for a task a human should
// look at, but it also strands hours of finished work behind one stuck gate.
// This is the explicit human override: it reopens ONLY the current gate with a
// fresh convergence budget. Everything task-wide is preserved - objective,
// baseline, completed phases and their proof chain, model spend and call
// ceilings, the Token Sentinel latch, the no-new-information ledger.

import { REVIEW_LOOP_STATES, recordTransition } from './state.js';
import {
  CALL_ALLOWANCE_KEY, MAX_ALLOWANCE_REVIEWER_CALLS, MAX_ALLOWANCE_SUPERVISOR_CALLS,
  commitGuardedUpdate, fingerprint, nextCallAllowance, parseCallCount,
} from './humanActionGuard.js';

const STATE_KEY = 'reviewLoop';
const TOKEN_ANOMALY_KEY = 'reviewLoopTokenAnomaly';
// Standard reopen count. Past it a reopen is still possible, but must state a
// numeric Reviewer-call budget that is enforced as this loop's call ceiling.
export const STANDARD_HUMAN_REOPENS = 3;

export async function reopenExhaustedGate({
  persistence, loopId, reason, allowance = null, currentLimits = null, now = () => new Date(),
}) {
  if (!loopId || !String(reason ?? '').trim()) throw new Error('reopen-gate requires a loopId and a reason');
  const workflow = await persistence.readWorkflowState(loopId);
  const before = fingerprint(workflow);
  const loop = workflow?.[STATE_KEY];
  if (!loop) throw new Error(`unknown loopId ${loopId}`);
  if (loop.objective?.mode === 'PR') throw new Error('ReviewLoop PR session retired; cannot reopen it; use claude-review-bot');
  if (loop.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED || loop.budgetExhausted !== true) {
    throw new Error(`loop is ${loop.state}${loop.budgetExhausted ? '' : ' (budget not exhausted)'}; only a HUMAN_REQUIRED loop with a spent convergence budget can be reopened`);
  }
  if (workflow?.[TOKEN_ANOMALY_KEY]?.tripped) {
    throw new Error('the Token Sentinel tripped for this loop; that safety stop cannot be reopened here; a human confirms it with `reviewloop acknowledge-token-anomaly` (see `reviewloop report --loop <id>`)');
  }
  const reopens = loop.humanReopens ?? [];
  const extended = reopens.length >= STANDARD_HUMAN_REOPENS;
  const reviewerCalls = parseCallCount(allowance?.reviewerCalls, { name: '--max-reviewer-calls', max: MAX_ALLOWANCE_REVIEWER_CALLS });
  const supervisorCalls = parseCallCount(allowance?.supervisorCalls, { name: '--max-supervisor-calls', max: MAX_ALLOWANCE_SUPERVISOR_CALLS });
  if (extended && reviewerCalls == null) {
    throw new Error(`this loop was already reopened ${reopens.length} times (standard limit ${STANDARD_HUMAN_REOPENS}); another attempt is still possible but must state how many more Reviewer calls it may use: add --max-reviewer-calls <1-${MAX_ALLOWANCE_REVIEWER_CALLS}> (enforced as this loop's call ceiling)`);
  }

  const at = now().toISOString();
  const priorAllowanceEntries = Array.isArray(workflow?.[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history.length : 0;
  const nextAllowance = (reviewerCalls != null || supervisorCalls != null)
    ? nextCallAllowance({
      workflow, currentLimits, reviewerCalls, supervisorCalls, mode: 'tighten',
      tier: extended ? 'EXTENDED' : 'STANDARD', reason, at, source: 'reopen-gate',
    })
    : null;
  // Re-read + single write serialized per loop: refuse if what this decision was based on moved.
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'reopening the gate',
    buildPatch: () => {
      // HUMAN_REQUIRED -> REVIEWING -> REWORK is the only legal path back.
      recordTransition(loop, REVIEW_LOOP_STATES.REVIEWING, `human reopen: ${reason}`);
      recordTransition(loop, REVIEW_LOOP_STATES.REWORK, `human reopen: ${reason}`);
      Object.assign(loop, {
        budgetExhausted: false,
        gateRound: 0,
        gateRepairCount: 0,
        convergenceEpoch: 0,
        epochReviewRound: 0,
        supervisorEscalationCount: 0,
        supervisorInvoked: false,
        findingSignatureHistory: [],
        pendingReviewerReconsideration: null,
        lastSupervisorGuidance: null,
        lastSupervisorRecommendation: null,
        chunkReviewCheckpoint: null,
        humanReopens: [...reopens, {
          at, reason: String(reason), round: loop.round, phaseIndex: loop.currentPhaseIndex ?? null,
          tier: extended ? 'EXTENDED' : 'STANDARD',
          ...(nextAllowance ? { allowance: nextAllowance.history.slice(priorAllowanceEntries) } : {}),
        }],
      });
      return {
        [STATE_KEY]: loop,
        ...(nextAllowance ? { [CALL_ALLOWANCE_KEY]: nextAllowance } : {}),
      };
    },
  });
  return {
    loopId, reopens: loop.humanReopens.length, phaseIndex: loop.currentPhaseIndex ?? null,
    tier: extended ? 'EXTENDED' : 'STANDARD', allowance: nextAllowance ? nextAllowance.history.slice(priorAllowanceEntries) : null,
  };
}
