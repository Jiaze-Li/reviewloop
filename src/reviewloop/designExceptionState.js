// Human-authorized Design-review exception: shared constants and the PURE
// validity check (RL-HUMAN-AUTHORITY-20261120, Design v1.0 §5.3-5.4).
//
// Leaf module on purpose (no imports): the report builder, the archive
// verifier and the human action all depend on it.
//
// An exception is a GOVERNANCE record, never a review result. It lives in its
// own workflow key next to the original Design loop; the loop itself
// (`workflow.reviewLoop`) stays exactly as the review left it, so a
// HUMAN_REQUIRED loop is never turned into PASS.

export const DESIGN_EXCEPTION_KEY = 'reviewLoopDesignException';
export const EXTERNAL_REVIEW_SCHEMA = 'reviewloop-external-design-review/v1';

// The exact stop reason the two-stage Design review emits when critical code
// facts cannot be verified because of repository/read boundaries (a tool
// limit, not a design defect). Shared so the report classifies it exactly.
export const DESIGN_SOURCE_LIMIT_REASON = 'critical code facts could not be independently verified within repository/read boundaries';

// HUMAN_REQUIRED categories caused by the review TOOL, for which a human may
// authorize an alternative independent review. Everything else is refused.
export const DESIGN_EXCEPTION_ELIGIBLE_CATEGORIES = Object.freeze(['DESIGN_SOURCE_LIMIT', 'REVIEW_FAILED']);

export const DESIGN_EXCEPTION_ALLOWS = Object.freeze(['DESIGN_ARCHIVE_CLEANUP', 'CODE_BEGIN']);
export const DESIGN_EXCEPTION_FORBIDS = Object.freeze([
  'REVIEWLOOP_DESIGN_PASS', 'CODE_REVIEW_WAIVER', 'READY_FOR_REVIEW', 'MERGE', 'DEPLOY',
  'FORCE_PUSH', 'PERMISSION_CHANGE', 'BUDGET_OR_SENTINEL_RELEASE',
]);

const SHA_RE = /^[0-9a-f]{64}$/;
const REQUIRED_STRING_FIELDS = ['id', 'at', 'repo', 'taskId', 'designVersion', 'loopId', 'reviewTarget', 'reason'];
const REQUIRED_SHA_FIELDS = ['planSha256', 'designSha256', 'reportSha256', 'archiveSha256'];

function hasActiveShape(a) {
  if (!a || typeof a !== 'object') return false;
  for (const k of REQUIRED_STRING_FIELDS) if (typeof a[k] !== 'string' || !a[k].trim()) return false;
  for (const k of REQUIRED_SHA_FIELDS) if (typeof a[k] !== 'string' || !SHA_RE.test(a[k])) return false;
  if (!Number.isInteger(a.prNumber) || a.prNumber < 1) return false;
  if (!a.loopAnchor || typeof a.loopAnchor !== 'object') return false;
  if (!Number.isInteger(a.loopAnchor.round)) return false;
  return true;
}

/**
 * Is the active exception of this workflow usable right now?
 *   VALID   - { valid: true, active }
 *   NONE    - no active exception
 *   INVALID - an active exception exists but no longer applies (reason says why)
 *
 * Valid only while the loop is still the HUMAN_REQUIRED stop it was granted
 * on (same round), or a human later STOPPED that same stop. A loop that went
 * back to review, or reached PASS, voids the exception.
 */
export function evaluateDesignException(workflow) {
  const record = workflow?.[DESIGN_EXCEPTION_KEY];
  const active = record?.active ?? null;
  if (!active) return { valid: false, status: 'NONE', reason: 'no active human Design exception', active: null };
  if (!hasActiveShape(active)) {
    return { valid: false, status: 'INVALID', reason: 'the active exception record is incomplete or damaged', active };
  }
  const loop = workflow?.reviewLoop;
  if (!loop || typeof loop !== 'object') {
    return { valid: false, status: 'INVALID', reason: 'the original Design loop record is missing', active };
  }
  if (loop.loopId && loop.loopId !== active.loopId) {
    return { valid: false, status: 'INVALID', reason: `exception belongs to loop ${active.loopId}, not ${loop.loopId}`, active };
  }
  const round = loop.round ?? null;
  if (loop.state === 'HUMAN_REQUIRED') {
    if (round !== active.loopAnchor.round) {
      return { valid: false, status: 'INVALID', reason: `the loop moved from round ${active.loopAnchor.round} to ${round} after the exception was granted`, active };
    }
    return { valid: true, status: 'VALID', reason: 'loop is still the HUMAN_REQUIRED stop the exception was granted on', active };
  }
  if (loop.state === 'STOPPED') {
    const stop = loop.humanStop;
    if (stop?.priorState === 'HUMAN_REQUIRED' && (stop.round ?? round) === active.loopAnchor.round) {
      return { valid: true, status: 'VALID', reason: 'loop was ended by a human from the same HUMAN_REQUIRED stop', active };
    }
    return { valid: false, status: 'INVALID', reason: 'the loop was stopped from a different state or round', active };
  }
  return { valid: false, status: 'INVALID', reason: `the loop is ${loop.state}; an exception only applies to the HUMAN_REQUIRED stop it was granted on`, active };
}
