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

const STATE_KEY = 'reviewLoop';
const TOKEN_ANOMALY_KEY = 'reviewLoopTokenAnomaly';
export const MAX_HUMAN_REOPENS = 3;

export async function reopenExhaustedGate({ persistence, loopId, reason, now = () => new Date() }) {
  if (!loopId || !String(reason ?? '').trim()) throw new Error('reopen-gate requires a loopId and a reason');
  const workflow = await persistence.readWorkflowState(loopId);
  const loop = workflow?.[STATE_KEY];
  if (!loop) throw new Error(`unknown loopId ${loopId}`);
  if (loop.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED || loop.budgetExhausted !== true) {
    throw new Error(`loop is ${loop.state}${loop.budgetExhausted ? '' : ' (budget not exhausted)'}; only a HUMAN_REQUIRED loop with a spent convergence budget can be reopened`);
  }
  if (workflow?.[TOKEN_ANOMALY_KEY]?.tripped) {
    throw new Error('the Token Sentinel tripped for this loop; that safety stop needs its own review and cannot be reopened here');
  }
  const reopens = loop.humanReopens ?? [];
  if (reopens.length >= MAX_HUMAN_REOPENS) {
    throw new Error(`this loop was already reopened ${MAX_HUMAN_REOPENS} times; the task needs a human decision, not another attempt`);
  }

  const at = now().toISOString();
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
    humanReopens: [...reopens, { at, reason: String(reason), round: loop.round, phaseIndex: loop.currentPhaseIndex ?? null }],
  });
  await persistence.updateWorkflowState(loopId, { [STATE_KEY]: loop });
  return { loopId, reopens: loop.humanReopens.length, phaseIndex: loop.currentPhaseIndex ?? null };
}
