import { agyObjectCarriesUsageEvidence, agyStderrCarriesUsageEvidence } from './agyUsageEvidence.js';

// Classifier for AGY quota/credit exhaustion rejections.
//
// A quota rejection is zero-consumption only with sufficient evidence that
// the provider denied admission before generation. Accept either:
//  A) empty stdout, absent usage, explicit quota wording; OR
//  B) structured ERROR stdout with zero model turns, no response/session,
//     a complete all-zero usage envelope, and explicit quota wording.
// A bare RESOURCE_EXHAUSTED or zero token counters by themselves are NOT proof.
// All other errors remain UNRESOLVED; UNKNOWN != ZERO.
// Duration is deliberately never consulted.

export const AGY_QUOTA_ZERO_PROOF = 'AGY_QUOTA_REJECTION';

const QUOTA_WORDING = [
  /\b(?:quota|credits?)\b[^\n]{0,40}\b(?:exceeded|exhausted|depleted|used up|reached|insufficient)\b/i,
  /\b(?:exceeded|exhausted|depleted|out of|ran out of|reached)\b[^\n]{0,40}\b(?:quota|credits?|usage limit)\b/i,
  /\busage limit\b[^\n]{0,30}\b(?:reached|exceeded|hit)\b/i,
  /\binsufficient[_ ]?(?:quota|credits?)\b/i,
  /\bresource[_ ]exhausted\b[^\n]{0,200}\b(?:quota|credits?|usage limit)\b/i,
  /\b(?:quota|credits?|usage limit)\b[^\n]{0,200}\bresource[_ ]exhausted\b/i,
];

// Wording that indicates the failure happened after the provider started
// working, which would make a "zero consumption" claim unsafe.
const MID_STREAM_WORDING = /\b(?:stream|partial|mid-?(?:response|stream)|connection reset|broken pipe|unexpected eof|deadline exceeded|timed? ?out)\b/i;

function envelopeText(envelope) {
  if (!envelope || typeof envelope !== 'object') return '';
  return [
    envelope.status, envelope.state, envelope.error_code, envelope.errorCode, envelope.code,
    envelope.error_type, envelope.errorType, envelope.type, envelope.reason,
  ].filter((v) => v !== undefined && v !== null).map(String).join(' ');
}

const MAX_RETRY_AFTER_MS = 7 * 86_400_000;

// Units must end at a word boundary so "60ms" / "500 milliseconds" are never
// misread as minutes. Millisecond hints are honoured explicitly.
function parseDurationMs(text) {
  const m = /(?:resets?|retry|try again)\s*(?:in|after)?\s*[:=]?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+)/i.exec(text);
  if (!m) return null;
  const perUnit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let total = 0;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)) {
    const u = part[2].toLowerCase();
    const key = u.startsWith('ms') || u.startsWith('milli') ? 'ms' : u[0];
    total += Number(part[1]) * perUnit[key];
  }
  // Cap absurd hints: a cooldown is never allowed to exceed a week.
  return total > 0 ? Math.min(Math.round(total), MAX_RETRY_AFTER_MS) : null;
}

/**
 * @param {object} err  an AgyExitError-shaped error
 * @returns {{ proven: boolean, reason: string, retryAfterMs: number|null }}
 */
function isExplicitZeroTurnQuotaError(err) {
  const envelope = err?.envelope;
  return err?.stdoutWasEmpty === false
    && err?.usageEvidenceState === 'present'
    && envelope?.status === 'ERROR'
    && envelope?.responseWasEmpty === true
    && envelope?.numTurns === 0
    && envelope?.hasConversationId === false
    && envelope?.explicitZeroUsage === true;
}

export function classifyAgyQuotaRejection(err) {
  const none = (reason) => ({ proven: false, reason, retryAfterMs: null });
  if (!err || typeof err !== 'object' || err.code !== 'AGY_NONZERO_EXIT') return none('not a non-zero AGY exit');
  const structuredZero = isExplicitZeroTurnQuotaError(err);
  if (err.stdoutWasEmpty !== true && !structuredZero) return none('stdout contains unproven model activity');

  const envelope = err.envelope && typeof err.envelope === 'object' ? err.envelope : {};
  const state = err.usageEvidenceState;
  // Fallback only for errors that predate the authoritative pre-truncation
  // state (synthetic/test errors, older transports).
  const usageAbsent = state === 'absent'
    || (state == null && !agyObjectCarriesUsageEvidence(envelope) && !agyStderrCarriesUsageEvidence(err.stderr));
  if (!usageAbsent && !structuredZero) return none('usage cannot be proven zero');

  const diagnostic = `${String(err.stderr ?? '')}\n${envelopeText(envelope)}${structuredZero && envelope.quotaError === true ? '\nquota exhausted' : ''}`;
  if (!QUOTA_WORDING.some((re) => re.test(diagnostic))) return none('no canonical quota wording');
  if (MID_STREAM_WORDING.test(diagnostic)) return none('diagnostic suggests a mid-stream failure');
  return { proven: true, reason: structuredZero ? 'canonical quota rejection with zero-turn ERROR envelope' : 'canonical quota rejection with empty stdout and absent usage evidence', retryAfterMs: parseDurationMs(diagnostic) };
}
