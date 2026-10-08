import { agyObjectCarriesUsageEvidence, agyStderrCarriesUsageEvidence } from './agyUsageEvidence.js';

// Classifier for AGY quota/credit exhaustion rejections.
//
// A quota rejection is the provider refusing to ADMIT a request, so it is
// zero-consumption — but only when we can tell it apart from a mid-stream
// failure. A non-zero exit, a short duration, or a bare "RESOURCE_EXHAUSTED"
// (which gRPC also uses for oversized messages) is NOT proof. We require ALL of:
//   - AGY_NONZERO_EXIT with EMPTY stdout (no response bytes were produced),
//   - usage evidence explicitly ABSENT (never 'present' / 'unknown'),
//   - explicit quota/credit wording in stderr or the structured envelope.
// Anything else stays UNKNOWN and keeps failing closed (UNRESOLVED reservation).
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

function parseDurationMs(text) {
  const m = /(?:resets?|retry|try again)\s*(?:in|after)?\s*[:=]?\s*(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i.exec(text);
  if (!m) return null;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((v) => (v ? Number(v) : 0));
  const total = (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
  return total > 0 ? total : null;
}

/**
 * @param {object} err  an AgyExitError-shaped error
 * @returns {{ proven: boolean, reason: string, retryAfterMs: number|null }}
 */
export function classifyAgyQuotaRejection(err) {
  const none = (reason) => ({ proven: false, reason, retryAfterMs: null });
  if (!err || typeof err !== 'object' || err.code !== 'AGY_NONZERO_EXIT') return none('not a non-zero AGY exit');
  if (err.stdoutWasEmpty !== true) return none('stdout was not empty');

  const envelope = err.envelope && typeof err.envelope === 'object' ? err.envelope : {};
  const state = err.usageEvidenceState;
  // Fallback only for errors that predate the authoritative pre-truncation
  // state (synthetic/test errors, older transports).
  const usageAbsent = state === 'absent'
    || (state == null && !agyObjectCarriesUsageEvidence(envelope) && !agyStderrCarriesUsageEvidence(err.stderr));
  if (!usageAbsent) return none('usage evidence is not explicitly absent');

  const diagnostic = `${String(err.stderr ?? '')}\n${envelopeText(envelope)}`;
  if (!QUOTA_WORDING.some((re) => re.test(diagnostic))) return none('no canonical quota wording');
  if (MID_STREAM_WORDING.test(diagnostic)) return none('diagnostic suggests a mid-stream failure');
  return { proven: true, reason: 'canonical quota rejection with empty stdout and absent usage evidence', retryAfterMs: parseDurationMs(diagnostic) };
}
