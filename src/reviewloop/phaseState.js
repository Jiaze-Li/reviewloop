// Pure phase / convergence-state helpers for the ReviewLoop controller.
//
// Everything here is a deterministic function of the persisted loop state and
// the frozen objective - no I/O, no provider calls, no controller closure - so
// it can be read and tested on its own. Behaviour is unchanged from when these
// lived in controller.js.

import { createHash } from 'node:crypto';
import { REVIEW_MODES } from './objective.js';
import { REVIEW_LOOP_STATES } from './state.js';
import { reviewFingerprint } from './reviewPolicy.js';

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

export function logicalEvidenceFingerprint(loopState, proofFingerprint = '') {
  const reconsider = loopState?.pendingReviewerReconsideration?.fingerprint;
  if (!reconsider) return proofFingerprint;
  return sha256Hex(`${proofFingerprint || 'none'}::supervisor-reconsideration::${reconsider}`);
}

export function normalizeSupervisorStrategyText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function migrateConvergenceState(loopState) {
  const gateRound = Number.isInteger(loopState.gateRound)
    ? loopState.gateRound
    : (Number.isInteger(loopState.round) ? loopState.round : 0);
  const legacySupervisorUsed = loopState.supervisorInvoked === true;

  if (!Number.isInteger(loopState.supervisorEscalationCount)) {
    loopState.supervisorEscalationCount = legacySupervisorUsed ? 1 : 0;
  }
  if (!Number.isInteger(loopState.convergenceEpoch)) {
    loopState.convergenceEpoch = loopState.supervisorEscalationCount > 0 ? 1 : 0;
  }
  if (!Number.isInteger(loopState.epochReviewRound)) {
    // Before epoch convergence existed, a valid Supervisor could only have
    // been invoked when the same blocker survived round 1 and round 2.
    // Preserve that prior escalation as epoch 1 without charging its old
    // pre-guidance Reviewer rounds against the new epoch.
    loopState.epochReviewRound = legacySupervisorUsed
      ? Math.max(0, gateRound - 2)
      : gateRound;
  }
  if (!('pendingReviewerReconsideration' in loopState)) {
    loopState.pendingReviewerReconsideration = null;
  }
  if (!('lastSupervisorRecommendation' in loopState)) {
    loopState.lastSupervisorRecommendation = loopState.lastSupervisorGuidance ? 'REWORK' : null;
  }
  return loopState;
}

export function phasesOf(objective) {
  return Array.isArray(objective?.phases) ? objective.phases : [];
}

export function currentReviewScope(loopState, objective = loopState?.objective) {
  const phases = phasesOf(objective);
  if (!phases.length) {
    // Empty fingerprint preserves pre-phase no-new-information/checkpoint
    // identities for ordinary tasks across an upgrade.
    return { type: 'task', id: 'task', title: 'Full task', fingerprint: '' };
  }

  const rawIndex = Number.isInteger(loopState?.currentPhaseIndex) ? loopState.currentPhaseIndex : 0;
  const index = Math.max(0, Math.min(rawIndex, phases.length));
  if (index < phases.length) {
    const phase = phases[index];
    const preserveInvariants = phases
      .slice(0, index)
      .flatMap((p) => p.carryForwardInvariants ?? []);
    const scope = {
      type: 'phase',
      id: phase.id,
      title: phase.title,
      objective: phase.objective,
      exitCriteria: phase.exitCriteria ?? [],
      carryForwardInvariants: phase.carryForwardInvariants ?? [],
      preserveInvariants,
      verificationCommands: phase.verificationCommands ?? [],
      ...(Object.prototype.hasOwnProperty.call(phase, 'verificationEvidence')
        ? { verificationEvidence: phase.verificationEvidence ?? [] }
        : {}),
      phaseIndex: index,
      phaseCount: phases.length,
    };
    return { ...scope, fingerprint: sha256Hex(JSON.stringify(scope)) };
  }

  const scope = {
    type: 'final',
    id: 'final',
    title: 'Final whole-task gate',
    completedPhaseSummaries: phases.map((p) => ({
      id: p.id,
      title: p.title,
      objective: p.objective,
      exitCriteria: p.exitCriteria ?? [],
      carryForwardInvariants: p.carryForwardInvariants ?? [],
      verificationCommands: p.verificationCommands ?? [],
      ...(Object.prototype.hasOwnProperty.call(p, 'verificationEvidence')
        ? { verificationEvidence: p.verificationEvidence ?? [] }
        : {}),
    })),
    phaseCount: phases.length,
    // Phase-local verification may certify an intermediate implementation
    // that a later phase intentionally replaces. The final Gate therefore runs
    // the frozen whole-task/global verification plan only. Lasting semantics
    // belong in carry-forward invariants or global verification.
    verificationCommands: [],
  };
  return { ...scope, fingerprint: sha256Hex(JSON.stringify(scope)) };
}

export function scopeBoundFingerprint(parts, reviewScope) {
  const base = parts.map((v) => String(v ?? '')).join('::');
  return sha256Hex(reviewScope?.fingerprint ? `${base}::${reviewScope.fingerprint}` : base);
}

export function phaseCompletionEvidenceHash(entry) {
  return sha256Hex(JSON.stringify({
    id: entry.id,
    title: entry.title,
    phaseIndex: entry.phaseIndex,
    completedAt: entry.completedAt,
    round: entry.round,
    head: entry.head ?? null,
    reviewScopeFingerprint: entry.reviewScopeFingerprint,
    gateFingerprint: entry.gateFingerprint,
    reviewFingerprint: entry.reviewFingerprint,
    previousProof: entry.previousProof,
    auditTargetFingerprint: entry.auditTargetFingerprint ?? null,
    // Only folded in when present so loops completed before phase-scoped
    // diffs existed keep a valid proof chain.
    ...(entry.phaseBaseline
      ? { phaseBaseline: { head: entry.phaseBaseline.head, baselineRef: entry.phaseBaseline.baselineRef } }
      : {}),
    ...(Array.isArray(entry.reviewedFiles) ? { reviewedFiles: entry.reviewedFiles } : {}),
  }));
}

// LOCAL phase gates review only what changed since the previous phase passed.
// The boundary is the snapshot recorded (and hash-chained) at that PHASE_PASS;
// anything else falls back to the original begin baseline (cumulative diff).
export function baselineFromPhaseEntry(entry) {
  const b = entry?.phaseBaseline;
  if (!b?.head || !b?.baselineRef) return null;
  return {
    head: b.head,
    baselineRef: b.baselineRef,
    capturedAt: entry.completedAt,
    dirtyFiles: [],
    untrackedHashes: {},
    evidenceComplete: true,
    incompleteReasons: [],
  };
}

export function phaseScopedBaseline(loopState, objective, reviewScope) {
  if (objective?.mode !== REVIEW_MODES.LOCAL || reviewScope?.type !== 'phase') return null;
  const prev = (loopState?.completedPhases ?? [])[reviewScope.phaseIndex - 1];
  if (!prev || prev.phaseIndex !== reviewScope.phaseIndex - 1) return null;
  return baselineFromPhaseEntry(prev);
}

export function phaseCompletionRoot(objective) {
  return `objective:${objective?.fingerprint ?? 'missing'}`;
}

export function assertPhaseProgressionValid(loopState, objective = loopState?.objective) {
  const phases = phasesOf(objective);
  const completed = Array.isArray(loopState?.completedPhases) ? loopState.completedPhases : [];

  if (!phases.length) {
    // Legacy/no-phase loops may predate these fields entirely.
    if (completed.length) throw new Error('ReviewLoop phase progression invalid: no phase plan but completed phases are present');
    return true;
  }

  const index = loopState?.currentPhaseIndex;
  if (!Number.isInteger(index) || index < 0 || index > phases.length) {
    throw new Error(`ReviewLoop phase progression invalid: currentPhaseIndex ${JSON.stringify(index)} is outside 0..${phases.length}`);
  }
  if (completed.length !== index) {
    throw new Error(
      `ReviewLoop phase progression invalid: completedPhases length ${completed.length} does not match currentPhaseIndex ${index}`,
    );
  }
  let previousProof = phaseCompletionRoot(objective);
  for (let i = 0; i < completed.length; i += 1) {
    const entry = completed[i];
    const phase = phases[i];
    if (entry?.id !== phase?.id) {
      throw new Error(
        `ReviewLoop phase progression invalid: completed phase ${i} is ${JSON.stringify(entry?.id)}; expected ${JSON.stringify(phase?.id)}`,
      );
    }

    const expectedScope = currentReviewScope({ currentPhaseIndex: i }, objective);
    const structurallyValid = entry?.title === phase.title
      && entry?.phaseIndex === i
      && Number.isInteger(entry?.round) && entry.round > 0
      && typeof entry?.completedAt === 'string' && Boolean(entry.completedAt)
      && entry?.reviewScopeFingerprint === expectedScope.fingerprint
      && typeof entry?.gateFingerprint === 'string' && Boolean(entry.gateFingerprint)
      && typeof entry?.reviewFingerprint === 'string' && Boolean(entry.reviewFingerprint)
      && entry?.previousProof === previousProof
      && (entry.phaseBaseline == null
        || (typeof entry.phaseBaseline.head === 'string' && Boolean(entry.phaseBaseline.head)
          && typeof entry.phaseBaseline.baselineRef === 'string' && Boolean(entry.phaseBaseline.baselineRef)))
      && (entry.reviewedFiles == null
        || (Array.isArray(entry.reviewedFiles) && entry.reviewedFiles.every((f) => typeof f === 'string')))
      && typeof entry?.proof === 'string' && entry.proof === phaseCompletionEvidenceHash(entry);
    if (!structurallyValid) {
      throw new Error(
        `ReviewLoop phase progression invalid: completed phase ${JSON.stringify(phase.id)} has no valid PHASE_PASS completion evidence`,
      );
    }

    previousProof = entry.proof;
  }
  if (loopState?.state === REVIEW_LOOP_STATES.PASS && index !== phases.length) {
    throw new Error('ReviewLoop phase progression invalid: terminal PASS recorded before every frozen phase completed');
  }
  return true;
}

export function reviewGateCount(objective) {
  const n = phasesOf(objective).length;
  return n ? n + 1 : 1; // one gate per phase + one final whole-task gate
}

export function mergeScopedGateCommands(commands, reviewScope) {
  const base = Array.isArray(commands) ? commands : [];
  const scoped = (reviewScope?.type === 'phase' || reviewScope?.type === 'final')
    && Array.isArray(reviewScope.verificationCommands)
    ? reviewScope.verificationCommands
    : [];
  return [...new Set([...base, ...scoped].map(String).filter(Boolean))];
}
