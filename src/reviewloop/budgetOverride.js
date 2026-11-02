// Human recovery / authorization for per-loop budget override.
//
// When a task legitimate in scope / multi-phase complexity exhausts the default
// usage-volume ceiling (400,000 tokens) or cost ceiling, this explicit human override
// expands ONLY the target loop's budget ceiling without touching the global environment
// or resetting the physical spend ledger, call counts, Token Sentinel, or baseline.

import { REVIEW_LOOP_STATES, recordTransition } from './state.js';
import { resolveReviewLoopLimits } from './reviewSpend.js';
import { reviewGateCount } from './phaseState.js';

const STATE_KEY = 'reviewLoop';
const SPEND_KEY = 'reviewLoopSpend';
const ANOMALY_KEY = 'reviewLoopTokenAnomaly';

export async function overrideLoopBudget({
  persistence,
  loopId,
  maxUsage = null,
  maxCost = null,
  reason,
  env = process.env,
  now = () => new Date(),
}) {
  if (!loopId) throw new Error('override-budget requires a loopId');
  if (!String(reason ?? '').trim()) throw new Error('override-budget requires an explicit reason');
  if (maxUsage == null && maxCost == null) {
    throw new Error('override-budget requires --max-usage or --max-cost (or both)');
  }

  const parsedUsage = maxUsage != null ? Number(maxUsage) : null;
  if (parsedUsage != null && (!Number.isFinite(parsedUsage) || parsedUsage <= 0 || !Number.isInteger(parsedUsage))) {
    throw new Error(`override-budget: maxUsage must be a positive integer, got "${maxUsage}"`);
  }

  const parsedCost = maxCost != null ? Number(maxCost) : null;
  if (parsedCost != null && (!Number.isFinite(parsedCost) || parsedCost <= 0)) {
    throw new Error(`override-budget: maxCost must be a positive number, got "${maxCost}"`);
  }

  const workflow = await persistence.readWorkflowState(loopId);
  const loop = workflow?.[STATE_KEY];
  if (!loop) throw new Error(`unknown loopId ${loopId}`);
  if (loop.objective?.mode === 'PR') {
    throw new Error('ReviewLoop PR session retired; cannot override budget; use claude-review-bot');
  }

  if (workflow?.[ANOMALY_KEY]?.tripped) {
    throw new Error('the Token Sentinel tripped for this loop; that safety stop needs its own review and cannot be overridden by budget expansion');
  }

  // Calculate accumulated usage from durable spend records
  const spendRecords = Array.isArray(workflow?.[SPEND_KEY]?.records) ? workflow[SPEND_KEY].records : [];
  const currentUsageVolume = spendRecords.reduce(
    (acc, r) => acc + (Number.isFinite(r.usageVolume) ? r.usageVolume : 0),
    0,
  );
  const currentCostUsd = spendRecords.reduce(
    (acc, r) => acc + (Number.isFinite(r.costUsd) ? r.costUsd : 0),
    0,
  );

  const at = now().toISOString();
  const gateCount = reviewGateCount(loop.objective);

  const existingOverridesObj = workflow.budgetOverrides ?? {
    maxUsageVolume: loop.maxUsageVolumeOverride ?? null,
    maxCostUsd: loop.maxCostUsdOverride ?? null,
  };

  const effectiveLimits = resolveReviewLoopLimits(env, {
    gateCount,
    budgetOverrides: existingOverridesObj,
  });

  const previousUsageLimit = effectiveLimits.maxUsageVolume;
  const previousCostLimit = effectiveLimits.maxCostUsd;
  const currentReviewerCalls = spendRecords.filter((r) => r.role === 'reviewer').length;
  const currentSupervisorCalls = spendRecords.filter((r) => r.role === 'supervisor').length;

  // Monotonic ceiling expansion: new limits must strictly exceed the previous effective limit
  // AND must exceed currently accumulated spend.
  if (parsedUsage != null) {
    if (parsedUsage <= previousUsageLimit) {
      throw new Error(
        `override-budget: new maxUsageVolume (${parsedUsage}) must exceed current effective limit (${previousUsageLimit} tokens)`,
      );
    }
    if (parsedUsage <= currentUsageVolume) {
      throw new Error(
        `override-budget: new maxUsageVolume (${parsedUsage}) must exceed currently accumulated spend (${currentUsageVolume} tokens)`,
      );
    }
  }

  if (parsedCost != null) {
    if (parsedCost <= previousCostLimit) {
      throw new Error(
        `override-budget: new maxCostUsd ($${parsedCost}) must exceed current effective limit ($${previousCostLimit})`,
      );
    }
    if (parsedCost <= currentCostUsd) {
      throw new Error(
        `override-budget: new maxCostUsd ($${parsedCost}) must exceed currently accumulated cost ($${currentCostUsd})`,
      );
    }
  }

  const record = {
    at,
    requestedBy: 'human',
    previousUsageLimit,
    newUsageLimit: parsedUsage ?? previousUsageLimit,
    previousCostLimit,
    newCostLimit: parsedCost ?? previousCostLimit,
    reason: String(reason).trim(),
    round: loop.round,
    phaseIndex: loop.currentPhaseIndex ?? null,
  };

  const existingOverrides = Array.isArray(loop.budgetOverrides) ? loop.budgetOverrides : [];
  loop.budgetOverrides = [...existingOverrides, record];
  if (parsedUsage != null) loop.maxUsageVolumeOverride = parsedUsage;
  if (parsedCost != null) loop.maxCostUsdOverride = parsedCost;

  // If the loop was halted in HUMAN_REQUIRED due to spend denial, restore it to REWORK
  // so the Worker can continue with the new authorized ceiling.
  //
  // Safety Invariants:
  // 1. Convergence Isolation: If the loop halted due to convergence review-round exhaustion
  //    (loop.budgetExhausted === true or reason indicates convergence failure), override-budget
  //    MUST NOT restore it. Reopening a convergence-exhausted gate is strictly governed by
  //    reopenExhaustedGate (reopen-gate).
  // 2. Non-ceiling stops: Refuse to restore unaccounted spend (MODEL_SPEND_USAGE_UNRESOLVED),
  //    token anomaly (MODEL_SPEND_TOKEN_ANOMALY_BLOCKED), call ceilings, etc.
  // 3. Exhausted limit clearance: The new ceiling must actually clear the limit that was
  //    exhausted (e.g. raising only --max-cost cannot restore a usage-exhausted loop).
  let stateRestored = false;
  if (loop.state === REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
    const lastTransition = [...(loop.history ?? [])]
      .reverse()
      .find((t) => t.to === REVIEW_LOOP_STATES.HUMAN_REQUIRED);
    const denialReason = String(lastTransition?.reason ?? loop.reason ?? '');

    // Refuse to restore non-ceiling stops (unaccounted spend, token anomaly, etc.)
    const isUnaccountedSpend = denialReason.includes('MODEL_SPEND_USAGE_UNRESOLVED')
      || denialReason.includes('unaccounted')
      || denialReason.includes('REVIEWLOOP_ACK_UNACCOUNTED_SPEND');
    const isTokenAnomaly = denialReason.includes('MODEL_SPEND_TOKEN_ANOMALY_BLOCKED')
      || denialReason.includes('token anomaly');
    const isNoNewInfo = denialReason.includes('NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED');

    const isNonCeilingStop = isUnaccountedSpend || isTokenAnomaly || isNoNewInfo;

    // Check non-volume / non-cost ceiling causes (call ceilings or round/convergence limits)
    const reviewerCallsExhausted = currentReviewerCalls >= effectiveLimits.maxReviewerCalls
      || /reviewer\s+call\s+ceiling/i.test(denialReason);
    const supervisorCallsExhausted = currentSupervisorCalls >= effectiveLimits.maxSupervisorCalls
      || /supervisor\s+call\s+ceiling/i.test(denialReason);
    const isCallCeilingDenial = reviewerCallsExhausted || supervisorCallsExhausted;

    // Convergence exhaustion is exclusively managed by reopenExhaustedGate (reopen-gate).
    // The durable state flag budgetExhausted === true strictly denotes that automatic convergence
    // is spent and takes precedence over any error message. If budgetExhausted === true (or if the
    // reason indicates convergence failure), override-budget NEVER restores state to REWORK.
    const isConvergenceExhausted = loop.budgetExhausted === true
      || /convergence|review did not converge/i.test(denialReason);

    // Explicit SPEND_DENIED stop code or volume/cost ceiling from spend authority
    const isSpendCeilingReason = /(?:^|[^a-z0-9_])SPEND_DENIED(?:[^a-z0-9_]|$)/i.test(denialReason)
      || /(?:usage-volume|cost|usage)\s*ceiling/i.test(denialReason);

    // A real volume/cost ceiling denial must have SPEND_DENIED or specific volume/cost ceiling,
    // and must NOT be convergence exhaustion, call ceiling, or non-ceiling stop.
    const isSpendCeilingDenial = !isNonCeilingStop
      && !isCallCeilingDenial
      && !isConvergenceExhausted
      && isSpendCeilingReason;

    if (isSpendCeilingDenial) {
      // Check which volume/cost limits were actually exhausted against effective limits
      const usageExhausted = currentUsageVolume >= previousUsageLimit
        || /usage-volume\s*ceiling|usage.*ceiling/i.test(denialReason);
      const costExhausted = currentCostUsd >= previousCostLimit
        || /cost\s*ceiling/i.test(denialReason);

      const usageCleared = parsedUsage != null && parsedUsage > currentUsageVolume;
      const costCleared = parsedCost != null && parsedCost > currentCostUsd;

      // The new ceiling must actually clear the limit that was exhausted.
      const wasVolumeOrCostExhausted = usageExhausted || costExhausted;

      const canRestore = wasVolumeOrCostExhausted
        && (!usageExhausted || usageCleared)
        && (!costExhausted || costCleared);

      if (canRestore) {
        recordTransition(loop, REVIEW_LOOP_STATES.REVIEWING, `human budget override: ${reason}`);
        recordTransition(loop, REVIEW_LOOP_STATES.REWORK, `human budget override: ${reason}`);
        loop.budgetExhausted = false;
        stateRestored = true;
      }
    }
  }

  await persistence.updateWorkflowState(loopId, {
    [STATE_KEY]: loop,
    budgetOverrides: {
      maxUsageVolume: loop.maxUsageVolumeOverride ?? null,
      maxCostUsd: loop.maxCostUsdOverride ?? null,
      history: loop.budgetOverrides,
    },
  });

  return {
    loopId,
    previousUsageLimit,
    newUsageLimit: loop.maxUsageVolumeOverride ?? previousUsageLimit,
    previousCostLimit,
    newCostLimit: loop.maxCostUsdOverride ?? previousCostLimit,
    previousLimit: previousUsageLimit,
    newLimit: loop.maxUsageVolumeOverride ?? previousUsageLimit,
    currentUsage: currentUsageVolume,
    currentCost: currentCostUsd,
    overridesCount: loop.budgetOverrides.length,
    stateRestored,
    loopState: loop.state,
  };
}
