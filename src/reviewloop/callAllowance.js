// Human recovery for a loop stopped at its Reviewer/Supervisor CALL ceiling.
//
// The global ceilings (reviewloop.settings.json) apply to every task, so
// raising them to rescue one loop loosens all of them and leaves no record of
// who allowed what. This grants more calls to exactly ONE loop, in its own
// workflow key (`reviewLoopCallAllowance`, never touched by override-budget),
// and the spend authority enforces it through the same check as the global
// ceiling. It only RAISES a ceiling; an extended confirmation only lowers one.
//
// It never touches the loop state machine: a loop stopped at HUMAN_REQUIRED
// stays there until the Worker calls reviewloop_review again, and a loop never
// becomes PASS without an independent Reviewer PASS.

import { REVIEW_LOOP_STATES } from './state.js';
import { resolveReviewLoopLimits } from './reviewSpend.js';
import { reviewGateCount } from './phaseState.js';
import {
  CALL_ALLOWANCE_KEY, MAX_ALLOWANCE_REVIEWER_CALLS, MAX_ALLOWANCE_SUPERVISOR_CALLS,
  assertUnchanged, callCeilingsFromState, fingerprint, nextCallAllowance, parseCallCount, readLoopWorkflow, usedCalls,
} from './humanActionGuard.js';

// The ceilings the spend authority enforces for this loop right now.
export function effectiveCallLimits({ workflow, env = process.env }) {
  const loop = workflow?.reviewLoop;
  const existing = workflow?.budgetOverrides ?? {
    maxUsageVolume: loop?.maxUsageVolumeOverride ?? null,
    maxCostUsd: loop?.maxCostUsdOverride ?? null,
  };
  return resolveReviewLoopLimits(env, {
    gateCount: reviewGateCount(loop?.objective),
    budgetOverrides: { ...existing, ...callCeilingsFromState(workflow) },
  });
}

export async function extendCalls({
  persistence, loopId, reviewerCalls = null, supervisorCalls = null, reason, env = process.env, now = () => new Date(),
}) {
  if (!loopId) throw new Error('extend-calls requires a loopId');
  if (!String(reason ?? '').trim()) throw new Error('extend-calls requires an explicit reason');
  const reviewerN = parseCallCount(reviewerCalls, { name: '--reviewer-calls', max: MAX_ALLOWANCE_REVIEWER_CALLS });
  const supervisorN = parseCallCount(supervisorCalls, { name: '--supervisor-calls', max: MAX_ALLOWANCE_SUPERVISOR_CALLS });
  if (reviewerN == null && supervisorN == null) {
    throw new Error('extend-calls requires --reviewer-calls <n> and/or --supervisor-calls <n>');
  }
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') {
    throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing was written. See \`reviewloop report --loop ${loopId}\``);
  }
  const { workflow, loop } = read;
  if (loop.objective?.mode === 'PR') throw new Error('ReviewLoop PR session retired; cannot extend its calls; use claude-review-bot');
  if ([REVIEW_LOOP_STATES.PASS, REVIEW_LOOP_STATES.FAILED, REVIEW_LOOP_STATES.STOPPED].includes(loop.state)) {
    throw new Error(`loop is ${loop.state}; calls can only be extended on a loop that can still continue`);
  }
  const before = fingerprint(workflow);
  const currentLimits = effectiveCallLimits({ workflow, env });
  const at = now().toISOString();
  const priorEntries = Array.isArray(workflow[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history.length : 0;
  const next = nextCallAllowance({
    workflow, currentLimits, reviewerCalls: reviewerN, supervisorCalls: supervisorN,
    mode: 'extend', tier: 'EXTEND', reason, at, source: 'extend-calls',
  });
  await assertUnchanged({ persistence, loopId, before, action: 'extending the call allowance' });
  await persistence.updateWorkflowState(loopId, { [CALL_ALLOWANCE_KEY]: next });
  return {
    loopId,
    loopState: loop.state,
    used: usedCalls(workflow),
    granted: next.history.slice(priorEntries),
    ceilings: { reviewer: next.maxReviewerCalls ?? currentLimits.maxReviewerCalls, supervisor: next.maxSupervisorCalls ?? currentLimits.maxSupervisorCalls },
  };
}
