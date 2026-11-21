// Structured, trustworthy "why did this loop stop at HUMAN_REQUIRED".
//
// Leaf module: pure functions, no I/O, no imports from the controller or the
// report. The only privileged inputs are (1) a `cause` record the ENGINE wrote
// into the same history entry as the transition, and (2) for stops recorded
// before causes existed, a CLOSED set of engine-written reason prefixes that is
// corroborated by durable loop state. Model output, labels and free-text
// patterns never participate: a model reply that happens to say "Supervisor" or
// "unresolved" cannot change the category (Plan R03 / AC-04).

import { DESIGN_SOURCE_LIMIT_REASON } from './designExceptionState.js';

export const STOP_KINDS = Object.freeze({
  REVIEW_TOOL_FAILED: 'REVIEW_TOOL_FAILED',
  SPEND_BLOCKED: 'SPEND_BLOCKED',
  DESIGN_SOURCE_LIMIT: 'DESIGN_SOURCE_LIMIT',
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  INPUT_INCOMPLETE: 'INPUT_INCOMPLETE',
  HOLD_RESTORED: 'HOLD_RESTORED',
});

// Kinds whose human-facing category is "the review TOOL failed" (not a design
// or code defect). Only these are eligible for a Design exception.
export const TOOL_FAILURE_KINDS = Object.freeze([
  STOP_KINDS.REVIEW_TOOL_FAILED,
  STOP_KINDS.INPUT_TOO_LARGE,
  STOP_KINDS.INPUT_INCOMPLETE,
]);

export const STOP_SOURCES = Object.freeze({
  ENGINE: 'ENGINE',
  LEGACY_TEMPLATE: 'LEGACY_TEMPLATE',
  AMBIGUOUS: 'AMBIGUOUS',
  UNKNOWN: 'UNKNOWN',
});

const KNOWN_KINDS = new Set(Object.values(STOP_KINDS));
const DETAIL_MAX = 200;

// Exact engine-written beginnings of the stored transition reason, taken from
// the producers that existed before structured causes: `failClosed` stores the
// Design stage label followed by " unusable (" (the model's text can only
// appear after that), the spend path stores "model spend blocked:", and the
// Design source-limit stop stores one exact constant. Anything else is UNKNOWN.
const LEGACY_TOOL_FAILURE_PREFIXES = Object.freeze([
  'Supervisor adjudication unusable (',
  'Supervisor fact adjudication unusable (',
  'Reviewer file request unusable (',
]);
const LEGACY_SPEND_PREFIX = 'model spend blocked:';

export function buildStopCause({ kind, code = null, detail = null, restoredFrom = null }) {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown stop cause kind: ${kind}`);
  const cause = { v: 1, kind, source: STOP_SOURCES.ENGINE, resume: 'HUMAN_AUTHORIZATION' };
  if (code != null) cause.code = String(code).slice(0, 64);
  // Display only; never used to classify. Callers pass fixed engine text.
  if (detail != null) cause.detail = String(detail).slice(0, DETAIL_MAX);
  if (restoredFrom != null) cause.restoredFrom = String(restoredFrom);
  return cause;
}

function lastHumanRequiredIndex(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to === 'HUMAN_REQUIRED') return i;
  }
  return -1;
}

function validCause(c) {
  return c && typeof c === 'object' && c.v === 1 && KNOWN_KINDS.has(c.kind) && c.source === STOP_SOURCES.ENGINE;
}

// Resolve the cause of one history entry (an index into `history`).
function resolveEntry(history, index, { blockers, loop, depth = 0 }) {
  const entry = history[index];
  if (validCause(entry?.cause)) {
    if (entry.cause.kind === STOP_KINDS.HOLD_RESTORED) {
      // The restore entry is only a marker: the category is the ORIGINAL stop's.
      if (depth > 0) return { kind: null, source: STOP_SOURCES.UNKNOWN };
      const origIdx = history.findIndex((h, i) => i < index && h?.to === 'HUMAN_REQUIRED' && h?.at === entry.cause.restoredFrom);
      if (origIdx < 0) return { kind: null, source: STOP_SOURCES.UNKNOWN, restored: true };
      const orig = resolveEntry(history, origIdx, { blockers, loop, depth: depth + 1 });
      return { ...orig, restored: true };
    }
    return { kind: entry.cause.kind, source: STOP_SOURCES.ENGINE, code: entry.cause.code ?? null };
  }
  return resolveLegacy(entry, { blockers, loop });
}

function resolveLegacy(entry, { blockers, loop }) {
  const reason = typeof entry?.reason === 'string' ? entry.reason : '';
  // Exact constant first (no state corroboration needed: it is a whole-string match).
  if (reason === DESIGN_SOURCE_LIMIT_REASON) {
    return { kind: STOP_KINDS.DESIGN_SOURCE_LIMIT, source: STOP_SOURCES.LEGACY_TEMPLATE };
  }
  const isTool = LEGACY_TOOL_FAILURE_PREFIXES.some((p) => reason.startsWith(p));
  if (isTool) {
    // Durable-state corroboration, all required: tool failure shape (stopped from
    // REVIEWING, never from SUPERVISING), no independent active blocker, and no
    // Supervisor recommendation of HUMAN_REQUIRED on record.
    const supervisorSaidHuman = String(loop?.lastSupervisorRecommendation ?? '').toUpperCase() === 'HUMAN_REQUIRED';
    const corroborated = entry.from === 'REVIEWING'
      && blockers && blockers.unreadable !== true && Array.isArray(blockers.list) && blockers.list.length === 0
      && !supervisorSaidHuman;
    if (corroborated) return { kind: STOP_KINDS.REVIEW_TOOL_FAILED, source: STOP_SOURCES.LEGACY_TEMPLATE };
    return { kind: null, source: STOP_SOURCES.UNKNOWN };
  }
  if (reason.startsWith(LEGACY_SPEND_PREFIX)) {
    return { kind: STOP_KINDS.SPEND_BLOCKED, source: STOP_SOURCES.LEGACY_TEMPLATE };
  }
  return { kind: null, source: STOP_SOURCES.UNKNOWN };
}

// An old record shaped like "HUMAN_REQUIRED -> REVIEWING with no outcome" is
// indistinguishable from a real interruption (the Gate stage of a call that
// crashed), so it is never inferred either way: AMBIGUOUS.
function isAmbiguousHold(loop) {
  const history = Array.isArray(loop?.history) ? loop.history : [];
  if (loop?.state !== 'REVIEWING' || history.length === 0) return false;
  const last = history[history.length - 1];
  if (!(last?.from === 'HUMAN_REQUIRED' && last?.to === 'REVIEWING')) return false;
  // A review record after that transition means the call did conclude.
  return !hasReviewOutcomeAfter(loop, last);
}

function hasReviewOutcomeAfter(loop, transition) {
  const reviewAt = Date.parse(loop?.lastReview?.at ?? loop?.lastReview?.completedAt ?? '');
  const at = Date.parse(transition?.at ?? '');
  return Number.isFinite(reviewAt) && Number.isFinite(at) && reviewAt >= at;
}

// Single consumer entry. `blockers` is the result of the report's
// `activeBlockers(...)` (injected so this module stays a leaf).
export function resolveStopCause({ loop, blockers = null }) {
  const history = Array.isArray(loop?.history) ? loop.history : [];
  if (isAmbiguousHold(loop)) return { kind: null, source: STOP_SOURCES.AMBIGUOUS };
  const idx = lastHumanRequiredIndex(history);
  if (idx < 0) return { kind: null, source: STOP_SOURCES.UNKNOWN };
  return resolveEntry(history, idx, { blockers, loop });
}

// Category of a trusted cause, for the human report and Design exception.
export function isTrustedToolFailure(resolved) {
  return Boolean(resolved)
    && (resolved.source === STOP_SOURCES.ENGINE || resolved.source === STOP_SOURCES.LEGACY_TEMPLATE)
    && TOOL_FAILURE_KINDS.includes(resolved.kind);
}
