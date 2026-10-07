// ReviewLoop durable state + deterministic state machine.
//
// One loopId == one review session. State is persisted through the existing
// Persistence workflow-state snapshot (persistence.js), keyed by loopId, under
// the `reviewLoop` key of the loop's state file. No parallel database.
//
// No fresh ReviewLoop session ever exposes PLANNING / FAST / FULL / EXECUTOR /
// DELIVERY / WORKFLOW_DONE — those were V2 SuperGPT workflow states.

export const REVIEW_LOOP_STATES = Object.freeze({
  READY_FOR_WORK: 'READY_FOR_WORK',
  REVIEWING: 'REVIEWING',
  WAITING_FOR_REVIEW: 'WAITING_FOR_REVIEW',
  REWORK: 'REWORK',
  SUPERVISING: 'SUPERVISING',
  PASS: 'PASS',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
});

export const TERMINAL_STATES = Object.freeze([
  REVIEW_LOOP_STATES.PASS,
  REVIEW_LOOP_STATES.HUMAN_REQUIRED,
  REVIEW_LOOP_STATES.FAILED,
  REVIEW_LOOP_STATES.STOPPED,
]);

// Allowed transitions. WAITING_FOR_REVIEW is a normal durable state, never an
// error — it re-enters REVIEWING when the external result arrives.
const TRANSITIONS = Object.freeze({
  READY_FOR_WORK: ['REVIEWING', 'STOPPED', 'FAILED'],
  // REVIEWING -> READY_FOR_WORK is the non-terminal PHASE_PASS transition:
  // the current phase gate is certified and the same loop continues with the
  // next phase (or the final whole-task gate).
  REVIEWING: ['READY_FOR_WORK', 'PASS', 'REWORK', 'SUPERVISING', 'WAITING_FOR_REVIEW', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  WAITING_FOR_REVIEW: ['REVIEWING', 'WAITING_FOR_REVIEW', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  REWORK: ['REVIEWING', 'STOPPED', 'FAILED'],
  SUPERVISING: ['REWORK', 'REVIEWING', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  PASS: [],
  // A HUMAN_REQUIRED from a TRANSIENT/infra failure (a chunk-review crash, a
  // provider blip, GitHub unreachable) is resumed by re-calling
  // reviewloop_review with the durable checkpoint. A HUMAN_REQUIRED from the
  // convergence policy is truly terminal only after the Reviewer epochs plus
  // Supervisor escalations are exhausted; budgetExhausted then latches and the
  // controller refuses to re-enter.
  HUMAN_REQUIRED: ['REVIEWING'],
  FAILED: [],
  STOPPED: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

const STATE_KEY = 'reviewLoop';

export function initialLoopState(objective) {
  return {
    loopId: objective.loopId,
    state: REVIEW_LOOP_STATES.READY_FOR_WORK,
    objective,
    // Global monotonically-increasing Reviewer round number. It is used for
    // audit / operation identity and never resets between phases.
    round: 0,
    // Convergence is scoped to the CURRENT gate. This resets after PHASE_PASS
    // so each phase gate (and the final gate) gets its own maxReviewRounds.
    gateRound: 0,
    gateRepairCount: 0, // phase/gate-local deterministic Gate FAIL cycles
    // A non-empty objective.phases plan starts at phase 0. After the last
    // phase passes, currentPhaseIndex === phases.length means "final gate".
    currentPhaseIndex: Array.isArray(objective.phases) && objective.phases.length ? 0 : null,
    completedPhases: [],
    // Durable non-command evidence bound to an exact review scope + code
    // fingerprint. Old/stale runtime evidence cannot satisfy a later diff.
    evidenceRecords: [],
    // Compact handoff state produced after PHASE_PASS. It lets a Worker safely
    // compact/refresh its own context without creating a new ReviewLoop.
    resumePacket: null,
    reviewerCalls: 0,
    supervisorCalls: 0,
    // deterministic no-new-information tracking
    lastReviewedFingerprint: null,
    lastReviewedPrHead: null,
    lastGateFingerprint: null,
    // convergence tracking
    // gateRound is the total Reviewer rounds in this gate; epochReviewRound is
    // the local counter for the current repair strategy. Supervisor guidance
    // advances convergenceEpoch without resetting task-wide round/spend/audit.
    convergenceEpoch: 0,
    epochReviewRound: 0,
    supervisorEscalationCount: 0,
    // Gate-local convergence history. Entries retain their epoch for diagnosis.
    findingSignatureHistory: [], // [{ round, gateRound, epoch, epochReviewRound, signatures: [] }]
    // Kept for backward-compatible telemetry/state inspection. It means at
    // least one Supervisor was used in this gate; it is NOT an "only once" lock.
    supervisorInvoked: false,
    // REVIEWER_RECONSIDER is durable New Information that authorizes exactly
    // one Reviewer reconsideration even when code/gate evidence is unchanged.
    pendingReviewerReconsideration: null,
    lastSupervisorRecommendation: null,
    // Set true only when the full automatic convergence strategy is exhausted
    // or the Supervisor explicitly recommends human involvement.
    budgetExhausted: false,
    // Durable per-round audit trail. One entry per PR review round,
    // recoverable and tamper-evident. See controller.js `appendAuditRecord`.
    audit: [],
    lastReview: null, // compact normalized review
    lastSupervisorGuidance: null,
    history: [],
    createdAt: objective.createdAt,
    updatedAt: objective.createdAt,
  };
}

export function recordTransition(loopState, to, reason) {
  const from = loopState.state;
  if (from === to) {
    loopState.updatedAt = new Date().toISOString();
    return loopState;
  }
  if (!canTransition(from, to)) {
    throw new Error(`ReviewLoop: illegal transition ${from} -> ${to} (${reason ?? 'no reason'})`);
  }
  loopState.state = to;
  loopState.updatedAt = new Date().toISOString();
  loopState.history = [
    ...(loopState.history ?? []),
    { from, to, reason: reason ?? null, round: loopState.round, at: loopState.updatedAt },
  ];
  return loopState;
}

// Persistence adapter over the existing workflow-state snapshot.
export class ReviewLoopStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') {
      return null;
    }
    const state = await this._persistence.readWorkflowState(loopId);
    return state?.[STATE_KEY] ?? null;
  }

  async save(loopId, loopState) {
    if (!loopId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    await this._persistence.updateWorkflowState(loopId, { [STATE_KEY]: loopState });
  }
}

// A persisted loop state that still carries a V2 SuperGPT workflow schema must
// NOT be silently reinterpreted under ReviewLoop semantics — fail closed.
export function assertNotLegacyWorkflow(raw) {
  if (!raw || typeof raw !== 'object') return;
  const legacyMarkers = ['workflowStatus', 'stage', 'taskIndex', 'pathSelectionReason', 'executorModel'];
  const hit = legacyMarkers.filter((k) => k in raw);
  if (hit.length >= 2 && !('state' in raw && 'loopId' in raw)) {
    throw new Error(
      `ReviewLoop: refusing to resume a legacy SuperGPT V2 workflow snapshot (${hit.join(', ')}); start a fresh reviewloop_begin`,
    );
  }
}
