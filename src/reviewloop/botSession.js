// Read-only parsing of the claude-review-bot session status comment
// (`<!-- jiaze-review-session:v1 -->`). Pure functions: no network, no disk.
// Used by inspectPrBotStatus (prContract.js) for the final handoff check.
// ReviewLoop does not poll PRs or keep a local copy of PR review state.

import { DEFAULT_TRUSTED_BOT_LOGINS } from './objective.js';

export const BOT_SESSION_MARKER = '<!-- jiaze-review-session:v1 -->';

export const BOT_SESSION_STATUSES = Object.freeze({
  READY: 'READY',
  REWORK: 'REWORK',
  AUDIT_PENDING: 'AUDIT_PENDING',
  PARTIAL: 'PARTIAL',
  REVIEW_IN_PROGRESS: 'REVIEW_IN_PROGRESS',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  MISSING: 'MISSING',
  UNKNOWN: 'UNKNOWN',
});

const CLOSED_FINDING_STATUSES = new Set([
  'FIXED',
  'DISMISSED',
  'WAIVED',
  'DEFERRED',
  'RESOLVED',
  'DOWNGRADED_NON_BLOCKING',
]);
const BLOCKING_SEVERITIES = new Set(['P0', 'P1', 'P2']);

export function isBlockingPrFinding(finding) {
  const status = String(finding?.status ?? 'OPEN').trim().toUpperCase();
  if (CLOSED_FINDING_STATUSES.has(status)) return false;
  const severity = String(finding?.severity ?? 'P2').trim().toUpperCase();
  if (BLOCKING_SEVERITIES.has(severity)) return true;
  if (severity === 'P3') return !finding?.downgradedFrom;
  return true;
}

function parseBase64StatePayload(body) {
  const match = body.match(/<!--\s*jiaze-review-state:([A-Za-z0-9_-]+)\s*-->/);
  if (!match) return { present: false, valid: false, payload: null };
  try {
    const json = Buffer.from(match[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: true, valid: false, payload: null };
    }
    if (parsed.version != null && parsed.version !== 1) {
      return { present: true, valid: false, payload: null };
    }
    return { present: true, valid: true, payload: parsed };
  } catch {
    return { present: true, valid: false, payload: null };
  }
}

function parseJsonSessionPayload(body) {
  const match = body.match(/<!--\s*jiaze-review-session:v1\s*(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseMarkdownSessionFields(body) {
  const statusMatch = body.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:status|sessionStatus)(?:\*\*)?\s*:\s*`?([A-Z_]+)`?/i);
  const headMatch = body.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:lastReviewedHead|reviewedHead|head)(?:\*\*)?\s*:\s*`?([0-9a-f]{7,40})`?/i);

  const findings = [];
  const findingRegex = /(?:^|\n)\s*(?:[-*]\s*)?(?:\[(P[1-3])\]\s*)?(F\d{2,4})\b(?:\s*\((P[1-3])\))?(?:\s*\[([A-Z_]+)\])?\s*[:\-]?\s*([^\n]*)/g;
  let m;
  while ((m = findingRegex.exec(body)) !== null) {
    const severity = (m[1] || m[3] || 'P2').toUpperCase();
    const id = m[2];
    const status = (m[4] || 'OPEN').toUpperCase();
    const title = (m[5] || '').trim();
    findings.push({ id, severity, status, title });
  }

  return {
    sessionStatus: statusMatch ? statusMatch[1].toUpperCase() : null,
    lastReviewedHead: headMatch ? headMatch[1].toLowerCase() : null,
    findings,
  };
}

export function parseTrustedBotSession({
  comments = [],
  trustedBotLogins = DEFAULT_TRUSTED_BOT_LOGINS,
} = {}) {
  const allowedLogins = new Set(
    (trustedBotLogins?.length ? trustedBotLogins : DEFAULT_TRUSTED_BOT_LOGINS)
      .map((l) => String(l ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  const trusted = (Array.isArray(comments) ? comments : [])
    .filter((c) => {
      const login = String(c?.author?.login ?? c?.authorLogin ?? '').trim().toLowerCase();
      const body = String(c?.body ?? '');
      return allowedLogins.has(login) && body.includes('jiaze-review-session:v1');
    })
    .sort((a, b) => {
      const ta = Date.parse(a?.updatedAt ?? a?.createdAt ?? 0) || 0;
      const tb = Date.parse(b?.updatedAt ?? b?.createdAt ?? 0) || 0;
      return ta - tb;
    });

  if (!trusted.length) {
    return {
      found: false,
      parseable: false,
      hasAuthoritativeState: false,
      commentId: null,
      authorLogin: null,
      sessionStatus: BOT_SESSION_STATUSES.MISSING,
      lastReviewedHead: null,
      auditCompleted: null,
      staleFor: null,
      findings: [],
      openFindings: [],
      updatedAt: null,
    };
  }

  const latest = trusted[trusted.length - 1];
  const latestTs = Date.parse(latest?.updatedAt ?? latest?.createdAt ?? 0) || 0;
  const sameTsComments = trusted.filter((c) => (Date.parse(c?.updatedAt ?? c?.createdAt ?? 0) || 0) === latestTs);
  if (sameTsComments.length > 1) {
    const distinctIds = new Set(sameTsComments.map((c) => {
      const b = String(c?.body ?? '');
      const st = parseBase64StatePayload(b);
      return `${st.payload?.sessionId ?? ''}:${st.payload?.status ?? ''}:${st.payload?.lastReviewedHead ?? ''}`;
    }));
    if (distinctIds.size > 1) {
      return {
        found: true,
        parseable: false,
        hasAuthoritativeState: false,
        conflictDetected: true,
        commentId: latest.id ?? null,
        authorLogin: latest.author?.login ?? latest.authorLogin ?? null,
        sessionStatus: BOT_SESSION_STATUSES.UNKNOWN,
        lastReviewedHead: null,
        auditCompleted: null,
        staleFor: null,
        findings: [],
        openFindings: [],
        updatedAt: latest.updatedAt ?? latest.createdAt ?? null,
      };
    }
  }

  const body = String(latest.body ?? '');
  const statePayload = parseBase64StatePayload(body);
  if (statePayload.present && !statePayload.valid) {
    return {
      found: true,
      parseable: false,
      hasAuthoritativeState: true,
      commentId: latest.id ?? null,
      authorLogin: latest.author?.login ?? latest.authorLogin ?? null,
      sessionStatus: BOT_SESSION_STATUSES.UNKNOWN,
      lastReviewedHead: null,
      auditCompleted: null,
      staleFor: null,
      findings: [],
      openFindings: [],
      updatedAt: latest.updatedAt ?? latest.createdAt ?? null,
    };
  }

  const jsonPayload = statePayload.valid ? statePayload.payload : parseJsonSessionPayload(body);
  const mdPayload = statePayload.valid ? { sessionStatus: null, lastReviewedHead: null, findings: [] } : parseMarkdownSessionFields(body);

  const rawStatus = String(jsonPayload?.status ?? jsonPayload?.sessionStatus ?? mdPayload.sessionStatus ?? '')
    .trim()
    .toUpperCase();
  const sessionStatus = Object.values(BOT_SESSION_STATUSES).includes(rawStatus)
    ? rawStatus
    : BOT_SESSION_STATUSES.UNKNOWN;

  const rawHead = jsonPayload?.lastReviewedHead ?? jsonPayload?.head ?? mdPayload.lastReviewedHead ?? null;
  const lastReviewedHead = rawHead ? String(rawHead).trim().toLowerCase() : null;
  const auditCompleted = typeof jsonPayload?.auditCompleted === 'boolean' ? jsonPayload.auditCompleted : null;
  const staleFor = jsonPayload?.staleFor ? String(jsonPayload.staleFor).trim().toLowerCase() : null;

  const rawFindings = Array.isArray(jsonPayload?.findings) ? jsonPayload.findings : mdPayload.findings;
  const findings = rawFindings
    .filter((f) => f && typeof f === 'object' && !Array.isArray(f))
    .map((f) => ({
      id: String(f.id ?? '').trim(),
      severity: String(f.severity ?? 'P2').trim().toUpperCase(),
      status: String(f.status ?? 'OPEN').trim().toUpperCase(),
      title: String(f.title ?? '').trim(),
      ...(f.downgradedFrom ? { downgradedFrom: String(f.downgradedFrom).trim() } : {}),
      ...(f.sharedBoundaryKey ? { sharedBoundaryKey: String(f.sharedBoundaryKey).trim() } : {}),
    }))
    .filter((f) => f.id);

  const openFindings = findings.filter(isBlockingPrFinding);
  const parseable = sessionStatus !== BOT_SESSION_STATUSES.UNKNOWN;

  return {
    found: true,
    parseable,
    hasAuthoritativeState: statePayload.valid,
    commentId: latest.id ?? null,
    authorLogin: latest.author?.login ?? latest.authorLogin ?? null,
    sessionStatus,
    lastReviewedHead,
    auditCompleted,
    staleFor,
    findings,
    openFindings,
    updatedAt: latest.updatedAt ?? latest.createdAt ?? null,
  };
}
