// Conservative, read-only A/B assessment of TWO real durable ReviewLoop
// workflows. Aggregates only physical spend records, never speculative saved
// tokens; refuses a savings claim when the frozen task, submitted state, model
// route, completeness or known spend cannot be verified as comparable.
//
// A single valid pair is an observation, NOT a confidence interval or evidence
// that the independent Reviewer has unchanged defect-detection performance.

import { buildTokenProfile } from './tokenProfile.js';

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function modelFamilies(profile) {
  return [...new Set(profile.rounds.flatMap((round) => round.calls.map((call) => (
    call.role + ':' + (call.family ?? '?') + ':' + (call.model ?? '?')
  ))))].sort();
}

function delta(before, after) {
  return {
    before,
    after,
    change: after - before,
    changePercent: before > 0 ? (100 * (after - before)) / before : null,
  };
}

export function evaluatePairedTokenProfiles({ beforeWorkflow, afterWorkflow } = {}) {
  const beforeLoop = beforeWorkflow?.reviewLoop;
  const afterLoop = afterWorkflow?.reviewLoop;
  if (!beforeLoop || !afterLoop) throw new Error('two ReviewLoop workflow snapshots are required');

  const before = buildTokenProfile({
    loopId: beforeLoop.loopId ?? 'before',
    workflow: beforeWorkflow,
  });
  const after = buildTokenProfile({
    loopId: afterLoop.loopId ?? 'after',
    workflow: afterWorkflow,
  });

  const reasons = [];
  const warnings = [];
  const a = beforeLoop.objective;
  const b = afterLoop.objective;
  if (!a?.fingerprint || a.fingerprint !== b?.fingerprint) {
    reasons.push('frozen objective fingerprint is absent or different');
  }
  if (a?.mode !== 'LOCAL' || b?.mode !== 'LOCAL') {
    reasons.push('paired experiments must use the LOCAL ReviewLoop mode');
  }
  if (!beforeLoop.lastReviewedFingerprint
    || beforeLoop.lastReviewedFingerprint !== afterLoop.lastReviewedFingerprint) {
    reasons.push('last reviewed code/Gate/evidence fingerprint is absent or different');
  }
  if (beforeLoop.state !== 'PASS' || afterLoop.state !== 'PASS') {
    reasons.push('both complete runs must reach terminal PASS');
  }
  if (!before.ledgerAvailable || !after.ledgerAvailable) {
    reasons.push('one or both durable physical spend ledgers are unavailable');
  }
  if (before.summary.physicalCalls === 0 || after.summary.physicalCalls === 0) {
    reasons.push('one or both experiments lack recorded physical Reviewer/Supervisor calls');
  }
  if (before.summary.unknownUsageCalls || after.summary.unknownUsageCalls
    || before.summary.missingVolumeRecords || after.summary.missingVolumeRecords) {
    reasons.push('unresolved or missing provider usage prevents an exact measured-volume comparison');
  }
  const beforeModels = modelFamilies(before);
  const afterModels = modelFamilies(after);
  if (JSON.stringify(beforeModels) !== JSON.stringify(afterModels)
    || beforeModels.some((x) => x.includes(':?'))) {
    reasons.push('model/provider family sets differ or contain unknown identities');
  }
  if (before.summary.unknownSemanticsCalls || after.summary.unknownSemanticsCalls) {
    warnings.push('provider cache/usage semantics are unconfirmed for some calls: ledger volumes may be conservative overcounts');
  }
  if (before.summary.unknownCostCalls || after.summary.unknownCostCalls) {
    warnings.push('USD costs are incomplete: compare usageVolume only, not claimed dollar savings');
  }
  warnings.push('A single pair does not prove causal savings or unchanged defect detection. Repeat with multiple pinned tasks and regression or seeded-defect checks.');

  const comparable = reasons.length === 0;
  const knownCost = before.summary.unknownCostCalls === 0 && after.summary.unknownCostCalls === 0;
  return {
    version: 1,
    status: comparable ? 'MATCHED_PAIR_OBSERVATION' : 'NOT_COMPARABLE',
    comparable,
    reasons,
    warnings,
    inputs: {
      beforeLoopId: before.loopId,
      afterLoopId: after.loopId,
      beforeState: beforeLoop.state,
      afterState: afterLoop.state,
      frozenObjectiveMatched: Boolean(a?.fingerprint && a.fingerprint === b?.fingerprint),
      reviewedStateMatched: Boolean(beforeLoop.lastReviewedFingerprint
        && beforeLoop.lastReviewedFingerprint === afterLoop.lastReviewedFingerprint),
      modelFamiliesBefore: beforeModels,
      modelFamiliesAfter: afterModels,
    },
    // Do not surface "savings" figures when safety/comparability inputs fail.
    usageVolume: comparable && positive(before.summary.ledgerUsageVolume)
      && positive(after.summary.ledgerUsageVolume)
      ? delta(before.summary.ledgerUsageVolume, after.summary.ledgerUsageVolume)
      : null,
    knownCostUsd: comparable && knownCost
      ? delta(before.summary.knownCostUsd, after.summary.knownCostUsd)
      : null,
    physicalCalls: comparable
      ? delta(before.summary.physicalCalls, after.summary.physicalCalls)
      : null,
    rawCounts: {
      before: {
        physicalCalls: before.summary.physicalCalls,
        unknownUsage: before.summary.unknownUsageCalls,
        unknownCost: before.summary.unknownCostCalls,
      },
      after: {
        physicalCalls: after.summary.physicalCalls,
        unknownUsage: after.summary.unknownUsageCalls,
        unknownCost: after.summary.unknownCostCalls,
      },
    },
  };
}

export function formatPairedTokenEvaluation(result) {
  const out = [
    'ReviewLoop paired physical-spend evaluation (read-only; no model calls)',
    'Before: ' + result.inputs.beforeLoopId + ' (' + result.inputs.beforeState + ')',
    'After:  ' + result.inputs.afterLoopId + ' (' + result.inputs.afterState + ')',
    'Result: ' + result.status,
  ];
  if (!result.comparable) {
    out.push('NO VALID TOKEN-SAVINGS CLAIM');
    for (const r of result.reasons) out.push('  - ' + r);
  } else {
    const s = result.usageVolume;
    out.push('Recorded usageVolume: ' + s.before + ' -> ' + s.after
      + ' (change ' + s.change + '; ' + (s.changePercent?.toFixed(2) ?? '?') + '%)');
    out.push('Physical calls: ' + result.physicalCalls.before + ' -> '
      + result.physicalCalls.after);
    if (result.knownCostUsd) {
      out.push('Known USD cost: $' + result.knownCostUsd.before.toFixed(4)
        + ' -> $' + result.knownCostUsd.after.toFixed(4));
    } else out.push('Known USD cost: INCOMPLETE (no dollar-savings claim)');
  }
  for (const warning of result.warnings) out.push('Note: ' + warning);
  return out.join('\n');
}
