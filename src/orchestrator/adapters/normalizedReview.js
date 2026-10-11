// Normalized Reviewer output — provider-boundary parser.
//
// The internal Reviewer emits a raw payload; this module converts it, AT THE
// PROVIDER BOUNDARY, into one normalized structure the deterministic
// convergence policy (reviewPolicy.js) consumes:
//
//   {
//     reviewer,            // reviewer identity string
//     provider,            // provider the payload came from
//     head_sha,            // the HEAD the review states it examined, or null
//     review_id,           // provider review id, or null
//     status,              // 'CLEAN' | 'ACTIONABLE' | 'FAILED'
//     findings: [ {
//       severity,          // 'P1' | 'P2' | 'OTHER'
//       file, line,        // location, or null
//       title,             // short finding headline
//       description,       // full finding body
//       signature,         // stable identity across repair rounds
//     } ],
//     blocking,            // findings with severity P1 / P2 (subset of findings)
//     error,               // { reason, message } when status === 'FAILED', else null
//   }
//
// Only P1 / P2 block. Everything else (P3, nit, suggestion, info, style, ...)
// normalizes to OTHER and never blocks. The policy never inspects a raw
// provider payload again — it only reads this structure.

export const NORMALIZED_REVIEW_STATUS = Object.freeze({
  CLEAN: 'CLEAN',
  ACTIONABLE: 'ACTIONABLE',
  FAILED: 'FAILED',
});

export const NORMALIZED_FINDING_SEVERITIES = Object.freeze(['P1', 'P2', 'OTHER']);
export const BLOCKING_SEVERITIES = Object.freeze(['P1', 'P2']);

// Reasons a provider result normalizes to FAILED (drives reviewer failover in
// the loop; never a repair round).
export const NORMALIZED_REVIEW_FAILURE_REASONS = Object.freeze({
  MALFORMED: 'MALFORMED_PAYLOAD',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NO_FINDINGS_CHANNEL: 'NO_FINDINGS_CHANNEL',
});

function collapse(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Map an arbitrary provider severity token onto the normalized ladder.
// Exact P1 / P2 (any case) plus a small, well-known synonym set are blocking;
// everything else — P3, nit, suggestion, info, style, minor, low, "" — is
// OTHER and does not block.
export function normalizeFindingSeverity(raw) {
  const text = collapse(raw);
  if (text === 'p1' || text === 'blocker' || text === 'critical') return 'P1';
  if (text === 'p2' || text === 'major') return 'P2';
  return 'OTHER';
}

export function isBlockingSeverity(severity) {
  return BLOCKING_SEVERITIES.includes(String(severity ?? '').trim().toUpperCase());
}

// A stable identity for "the same finding" so a finding that survives a repair
// round is recognised on the next review. Prefer a provider-supplied stable id;
// otherwise derive from severity + file + normalized title/description.
export function normalizedFindingSignature(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const explicit = typeof finding.id === 'string' ? finding.id.trim()
    : (typeof finding.signature === 'string' && finding.signature.startsWith('id:')
      ? finding.signature.slice(3)
      : '');
  if (explicit) return `id:${explicit}`;
  const severity = normalizeFindingSeverity(finding.severity);
  const file = collapse(finding.file ?? finding.path);
  const body = collapse(
    finding.title ?? finding.message ?? finding.summary ?? finding.description ?? finding.body,
  );
  if (!body && !file) return null;
  return `${severity}:${file}:${body}`;
}

function toInt(value) {
  return Number.isInteger(value) ? value
    : (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Math.trunc(Number(value)) : null);
}

// Normalize one raw finding. Returns null for structurally empty entries so a
// provider that pads its list with blanks does not create phantom findings.
export function normalizeReviewFinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const severity = normalizeFindingSeverity(raw.severity ?? raw.level ?? raw.priority);
  const title = String(raw.title ?? raw.message ?? raw.summary ?? raw.headline ?? '').trim();
  const description = String(
    raw.description ?? raw.body ?? raw.detail ?? raw.details ?? raw.message ?? raw.summary ?? title ?? '',
  ).trim();
  const file = typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim()
    : (typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null);
  if (!title && !description && !file) return null;
  const normalized = {
    severity,
    file,
    line: toInt(raw.line ?? raw.lineNumber ?? raw.start_line),
    title: title || description,
    description: description || title,
  };
  normalized.signature = normalizedFindingSignature({ id: raw.id, ...normalized });
  return normalized;
}

function failed({ reviewer, provider, headSha, reviewId, reason, message }) {
  return {
    reviewer: reviewer ?? null,
    provider,
    head_sha: headSha ?? null,
    review_id: reviewId ?? null,
    status: NORMALIZED_REVIEW_STATUS.FAILED,
    findings: [],
    blocking: [],
    error: { reason, message },
  };
}

function looksLikeFailure(raw) {
  if (raw.ok === false || raw.success === false) return raw.failure ?? raw.error ?? 'reviewer reported failure';
  const status = collapse(raw.status ?? raw.state);
  if (status === 'failed' || status === 'error' || status === 'errored') {
    return raw.error ?? raw.failure ?? raw.message ?? `reviewer status ${status}`;
  }
  if (raw.error) return raw.error;
  return null;
}

// Convert a raw Reviewer payload into the normalized structure. This is the
// provider boundary: everything downstream consumes only the return value.
//
// - malformed / non-object payload            -> FAILED (MALFORMED_PAYLOAD)
// - explicit provider failure marker          -> FAILED (PROVIDER_ERROR)
// - no recognisable findings channel at all   -> FAILED (NO_FINDINGS_CHANNEL)
// - findings list present, some P1/P2         -> ACTIONABLE
// - findings list present, none blocking      -> CLEAN
export function normalizeProviderReview({
  raw,
  reviewer,
  provider = 'internal',
  currentHead,
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return failed({
      reviewer: reviewer ?? null,
      provider,
      headSha: currentHead ?? null,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.MALFORMED,
      message: 'review payload is missing or not an object',
    });
  }

  const headSha = String(
    raw.head_sha ?? raw.headSha ?? raw.reviewedHead ?? raw.commitId ?? currentHead ?? '',
  ).trim() || null;
  const resolvedReviewer = (reviewer != null && String(reviewer).trim())
    ? String(reviewer).trim()
    : (String(raw.reviewer ?? raw.reviewerId ?? '').trim() || null);

  const rawFindings = raw.findings ?? raw.issues ?? raw.results;
  const reviewId = raw.review_id ?? raw.reviewId ?? raw.id ?? null;

  const failureMarker = looksLikeFailure(raw);
  if (failureMarker) {
    return failed({
      reviewer: resolvedReviewer,
      provider,
      headSha,
      reviewId,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.PROVIDER_ERROR,
      message: typeof failureMarker === 'string' ? failureMarker : JSON.stringify(failureMarker),
    });
  }

  if (!Array.isArray(rawFindings)) {
    return failed({
      reviewer: resolvedReviewer,
      provider,
      headSha,
      reviewId,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.NO_FINDINGS_CHANNEL,
      message: 'review payload exposes no findings array',
    });
  }

  const findings = rawFindings.map(normalizeReviewFinding).filter(Boolean);
  const blocking = findings.filter((f) => isBlockingSeverity(f.severity));

  return {
    reviewer: resolvedReviewer,
    provider,
    head_sha: headSha,
    review_id: reviewId,
    status: blocking.length > 0
      ? NORMALIZED_REVIEW_STATUS.ACTIONABLE
      : NORMALIZED_REVIEW_STATUS.CLEAN,
    findings,
    blocking,
    error: null,
  };
}

// Unique, sorted blocking-finding signatures — the policy compares these across
// repair rounds to detect non-convergence.
export function blockingSignatures(normalizedReview) {
  const blocking = Array.isArray(normalizedReview?.blocking) ? normalizedReview.blocking : [];
  return [...new Set(blocking.map((f) => f.signature).filter(Boolean))].sort();
}
