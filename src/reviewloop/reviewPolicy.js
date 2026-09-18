// ReviewLoop review normalization + deterministic convergence policy.
//
// Severity policy:  P1 = blocking, P2 = blocking, P3/OTHER = non-blocking.
// Default completion rule: no P1 and no P2  ->  PASS.
//
// Convergence (§13), default max fresh review rounds = 3:
//   Round 1: Gate -> Reviewer.  P1/P2 -> direct REWORK (Supervisor calls = 0).
//   Round 2: same blocking finding survives a genuine changed diff
//            -> Supervisor exactly once -> guidance -> REWORK.
//   Round 3: P1/P2 still present -> HUMAN_REQUIRED.
//   Any round with P1 = 0 and P2 = 0 -> PASS.
//   Waiting/polling never consumes a round.

import { createHash } from 'node:crypto';
import {
  normalizeProviderReview,
  blockingSignatures as blockingSigs,
} from '../orchestrator/adapters/normalizedPrReview.js';

function sha256(v) {
  return createHash('sha256').update(String(v)).digest('hex');
}

export const REVIEW_VERDICTS = Object.freeze({
  PASS: 'PASS',
  REWORK: 'REWORK',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  WAITING_FOR_REVIEW: 'WAITING_FOR_REVIEW',
});

// Compact normalized review the Core stores and (partly) returns to the Worker.
// Raw findings text and full diff stay in local persistence, never echoed
// wholesale into Worker context.
export function normalizeReview({
  raw, reviewer, provider, head, requireExplicitHead = false,
} = {}) {
  // B1 — a malformed / unparseable / schema-invalid provider payload is
  // surfaced (never silently reduced to an empty findings list) and fails
  // closed here.
  if (raw && typeof raw === 'object' && raw.malformed === true) {
    return {
      status: 'FAILED',
      reviewer: reviewer ?? null,
      provider: provider ?? null,
      reviewedFingerprint: null,
      reviewedHead: null,
      blockingFindings: [],
      nonBlockingFindings: [],
      nonBlockingOmitted: 0,
      findingSignatures: [],
      error: { reason: 'MALFORMED_REVIEWER_OUTPUT', message: String(raw.reason ?? 'reviewer output is malformed') },
    };
  }
  // B4 — in PR mode the reviewed HEAD must be explicit in the payload, never
  // substituted from the current HEAD.
  const explicitHead = typeof (raw?.head_sha ?? raw?.headSha ?? raw?.reviewedHead ?? raw?.commit_id) === 'string'
    ? String(raw.head_sha ?? raw.headSha ?? raw.reviewedHead ?? raw.commit_id).trim()
    : null;
  if (requireExplicitHead && !explicitHead) {
    return {
      status: 'FAILED',
      reviewer: reviewer ?? null,
      provider: provider ?? null,
      reviewedFingerprint: null,
      reviewedHead: null,
      blockingFindings: [],
      nonBlockingFindings: [],
      nonBlockingOmitted: 0,
      findingSignatures: [],
      error: { reason: 'MISSING_REVIEWED_HEAD', message: 'PR review payload does not state which HEAD it reviewed' },
    };
  }
  const normalized = normalizeProviderReview({
    raw, reviewer, provider, currentPrHead: requireExplicitHead ? explicitHead : head,
  });
  const blocking = (normalized.blocking ?? []).map((f) => ({
    severity: f.severity,
    file: f.file ?? null,
    line: f.line ?? null,
    title: (f.title ?? f.message ?? '').slice(0, 200),
    signature: f.signature,
    // Durable GitHub review-thread identity for this finding (PR mode only;
    // null for internal LOCAL findings). Preserved through normalization so the
    // controller can resolve the thread once the finding is independently
    // cleared on a newer HEAD.
    threadIdentity: (f.threadNodeId || f.reviewId || f.commentId) ? {
      threadNodeId: f.threadNodeId ?? null,
      reviewId: f.reviewId ?? null,
      commentId: f.commentId ?? null,
      reviewedHead: f.reviewedHead ?? f.head_sha ?? null,
      reviewerLogin: f.reviewerLogin ?? null,
      identityReliable: Boolean(f.identityReliable),
    } : null,
  }));
  const nonBlocking = (normalized.findings ?? [])
    .filter((f) => !blocking.some((b) => b.signature === f.signature))
    .map((f) => ({ severity: f.severity, file: f.file ?? null, title: (f.title ?? f.message ?? '').slice(0, 160) }));
  const signatures = blockingSigs(normalized);
  return {
    status: normalized.status, // CLEAN | ACTIONABLE | FAILED
    reviewer: normalized.reviewer ?? reviewer ?? null,
    provider: normalized.provider ?? provider ?? null,
    reviewedFingerprint: null, // filled by the controller
    reviewedHead: requireExplicitHead ? explicitHead : (normalized.head_sha ?? head ?? null),
    // The trusted review submission id that produced this result (PR mode);
    // recorded as the independent verification id when a prior thread resolves.
    reviewId: normalized.review_id ?? raw?.review_id ?? raw?.reviewId ?? null,
    blockingFindings: blocking,
    nonBlockingFindings: nonBlocking.slice(0, 8),
    nonBlockingOmitted: Math.max(0, nonBlocking.length - 8),
    findingSignatures: signatures,
    error: normalized.error ?? null,
  };
}

// Deterministic decision given a fresh normalized review and the loop state.
// Returns { verdict, reason, invokeSupervisor: boolean }.
export function decideConvergence({ loopState, review }) {
  const objective = loopState.objective;
  const maxRounds = objective?.maxReviewRounds ?? 3;
  // Convergence budget is per review gate. `loopState.round` remains the
  // task-global audit round, while gateRound resets after PHASE_PASS.
  const round = loopState.gateRound ?? loopState.round; // already incremented for this fresh review

  if (review.status === 'FAILED') {
    return {
      verdict: REVIEW_VERDICTS.HUMAN_REQUIRED,
      reason: `reviewer returned FAILED: ${review.error?.message ?? review.error?.reason ?? 'unknown'}`,
      invokeSupervisor: false,
    };
  }

  const blockingCount = review.blockingFindings.length;
  if (blockingCount === 0) {
    return { verdict: REVIEW_VERDICTS.PASS, reason: 'no P1/P2 findings', invokeSupervisor: false };
  }

  // Blocking findings present. Is this the SAME blocking set as the previous
  // round despite a genuine changed diff?
  const prev = (loopState.findingSignatureHistory ?? []).slice(-1)[0];
  const sameAsPrev = prev
    && prev.signatures.length > 0
    && JSON.stringify([...prev.signatures].sort()) === JSON.stringify([...review.findingSignatures].sort());

  if (round >= maxRounds) {
    return {
      verdict: REVIEW_VERDICTS.HUMAN_REQUIRED,
      reason: `still ${blockingCount} blocking finding(s) after ${round} review round(s) in this gate`,
      invokeSupervisor: false,
    };
  }

  if (sameAsPrev && !loopState.supervisorInvoked) {
    return {
      verdict: REVIEW_VERDICTS.REWORK,
      reason: 'same blocking finding persists after a genuine changed implementation',
      invokeSupervisor: true,
    };
  }

  return {
    verdict: REVIEW_VERDICTS.REWORK,
    reason: `${blockingCount} blocking finding(s) to fix`,
    invokeSupervisor: false,
  };
}

// Compact payload returned to the Worker on REWORK — never a raw evidence blob.
export function compactReworkPayload({ loopState, review, gate, supervisorGuidance = null }) {
  const phases = loopState.objective?.phases ?? [];
  const phaseIndex = loopState.currentPhaseIndex;
  const currentPhase = Number.isInteger(phaseIndex) && phaseIndex < phases.length
    ? phases[phaseIndex]?.id ?? null
    : (Number.isInteger(phaseIndex) && phaseIndex === phases.length ? 'final' : null);
  return {
    status: 'REWORK',
    loopId: loopState.loopId,
    round: loopState.round,
    gateRound: loopState.gateRound ?? loopState.round,
    currentPhase,
    maxRounds: loopState.objective?.maxReviewRounds ?? 3,
    gateRepairCount: loopState.gateRepairCount ?? 0,
    blockingFindings: review.blockingFindings,
    nonBlockingCount: review.nonBlockingFindings.length + (review.nonBlockingOmitted ?? 0),
    gate: gate ? { verdict: gate.verdict, failures: gate.failureIdentities?.slice(0, 10) ?? [] } : null,
    supervisorGuidance,
    nextAction: 'Fix the blocking findings for the current review gate in this same session, then call reviewloop_review again.',
  };
}

export function reviewFingerprint({ deltaFingerprint, gateFingerprint, reviewScopeFingerprint = '' }) {
  return sha256(`${deltaFingerprint ?? ''}::${gateFingerprint ?? ''}::${reviewScopeFingerprint ?? ''}`);
}
