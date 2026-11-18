// PR Task orchestration engine (`taskType: 'pr'`).
//
// Zero-LLM state evaluation, trusted claude-review-bot session parsing,
// two-phase idempotent `@gemini review` trigger ledger (max 3 per task),
// per-action permission guards, and 2-round shared-boundary escalation.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_TRUSTED_BOT_LOGINS } from './objective.js';
import { isTerminal, REVIEW_LOOP_STATES } from './state.js';

const execFileAsync = promisify(execFile);

export const MAX_REVIEW_TRIGGERS = 3;
export const PENDING_TRIGGER_TTL_MS = 2 * 60 * 1000;
export const BOT_SESSION_MARKER = '<!-- jiaze-review-session:v1 -->';
export const TRIGGER_MARKER_PREFIX = '<!-- reviewloop-trigger:';

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

const WAITING_BOT_STATUSES = new Set([
  BOT_SESSION_STATUSES.AUDIT_PENDING,
  BOT_SESSION_STATUSES.PARTIAL,
  BOT_SESSION_STATUSES.REVIEW_IN_PROGRESS,
]);

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function triggerMarker(idempotencyKey) {
  return `${TRIGGER_MARKER_PREFIX}${idempotencyKey} -->`;
}

export function buildReviewTriggerBody(idempotencyKey) {
  return `@gemini review\n${triggerMarker(idempotencyKey)}`;
}

export function buildDismissComment({ findingId, reason, evidence }) {
  const id = String(findingId ?? '').trim();
  const r = String(reason ?? '').trim();
  const ev = String(evidence ?? '').trim();
  if (!id) throw new Error('buildDismissComment: findingId is required');
  if (!r) throw new Error('buildDismissComment: reason is required');
  if (!ev) throw new Error('buildDismissComment: evidence is required');
  return `@gemini dismiss ${id}\nReason: ${r}\nEvidence: ${ev}`;
}

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
  const findings = rawFindings.map((f) => ({
    id: String(f.id ?? '').trim(),
    severity: String(f.severity ?? 'P2').trim().toUpperCase(),
    status: String(f.status ?? 'OPEN').trim().toUpperCase(),
    title: String(f.title ?? '').trim(),
    ...(f.downgradedFrom ? { downgradedFrom: String(f.downgradedFrom).trim() } : {}),
    ...(f.sharedBoundaryKey ? { sharedBoundaryKey: String(f.sharedBoundaryKey).trim() } : {}),
  })).filter((f) => f.id);

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

export function evaluatePrStatus({ prState, prTask, comments = [] }) {
  const liveHeadSha = String(prState?.headRefOid ?? '').trim().toLowerCase();
  const boundHeadSha = String(prTask?.boundHeadSha ?? '').trim().toLowerCase();
  const prStatus = String(prState?.state ?? '').trim().toUpperCase();
  const session = parseTrustedBotSession({
    comments,
    trustedBotLogins: prTask?.trustedBotLogins,
  });

  if (prStatus && prStatus !== 'OPEN') {
    return {
      verdict: 'STOPPED',
      reason: 'PR_CLOSED',
      prStatus,
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  if (!liveHeadSha || !boundHeadSha || liveHeadSha !== boundHeadSha) {
    return {
      verdict: 'HUMAN_REQUIRED',
      reason: 'HEAD_DRIFT',
      headDrift: true,
      prStatus: prStatus || 'OPEN',
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  if (session.sessionStatus === BOT_SESSION_STATUSES.HUMAN_REQUIRED) {
    return {
      verdict: 'HUMAN_REQUIRED',
      reason: 'BOT_HUMAN_REQUIRED',
      prStatus: 'OPEN',
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  if (!session.found || !session.parseable || WAITING_BOT_STATUSES.has(session.sessionStatus)) {
    return {
      verdict: 'WAITING_FOR_REVIEW',
      reason: !session.found
        ? 'SESSION_MISSING'
        : (!session.parseable ? 'SESSION_UNPARSEABLE' : `BOT_${session.sessionStatus}`),
      prStatus: 'OPEN',
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  if (session.sessionStatus === BOT_SESSION_STATUSES.READY) {
    if (session.lastReviewedHead !== liveHeadSha || session.staleFor === liveHeadSha) {
      return {
        verdict: 'WAITING_FOR_REVIEW',
        reason: 'STALE_BOT_READY',
        prStatus: 'OPEN',
        liveHeadSha,
        boundHeadSha,
        session,
      };
    }
    if ((session.openFindings?.length ?? 0) > 0) {
      return {
        verdict: 'HUMAN_REQUIRED',
        reason: 'INCONSISTENT_BOT_READY',
        prStatus: 'OPEN',
        liveHeadSha,
        boundHeadSha,
        session,
      };
    }
    if (session.hasAuthoritativeState && session.auditCompleted !== true) {
      return {
        verdict: 'HUMAN_REQUIRED',
        reason: 'INCOMPLETE_BOT_AUDIT',
        prStatus: 'OPEN',
        liveHeadSha,
        boundHeadSha,
        session,
      };
    }
    return {
      verdict: 'PASS',
      reason: 'BOT_READY_ON_LIVE_HEAD',
      prStatus: 'OPEN',
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  if (session.sessionStatus === BOT_SESSION_STATUSES.REWORK) {
    if (session.lastReviewedHead !== liveHeadSha || session.staleFor === liveHeadSha) {
      return {
        verdict: 'WAITING_FOR_REVIEW',
        reason: 'STALE_BOT_REWORK',
        prStatus: 'OPEN',
        liveHeadSha,
        boundHeadSha,
        session,
      };
    }
    return {
      verdict: 'REWORK',
      reason: 'BOT_REWORK',
      prStatus: 'OPEN',
      liveHeadSha,
      boundHeadSha,
      session,
    };
  }

  return {
    verdict: 'WAITING_FOR_REVIEW',
    reason: `BOT_${session.sessionStatus}`,
    prStatus: 'OPEN',
    liveHeadSha,
    boundHeadSha,
    session,
  };
}

export function assertPrActionAuthorized({ action, prTask, prState }) {
  const validActions = new Set(['edit', 'commit', 'push', 'comment', 'autoWake']);
  if (!validActions.has(action)) {
    throw new Error(`ReviewLoop PR: unknown action "${action}"`);
  }
  if (!prTask?.permissions?.[action]) {
    throw new Error(`ReviewLoop PR: action "${action}" is not authorized`);
  }
  const prStatus = String(prState?.state ?? 'OPEN').trim().toUpperCase();
  if (prStatus !== 'OPEN') {
    throw new Error(`ReviewLoop PR: cannot "${action}" when PR state is ${prStatus}`);
  }
  const liveHead = String(prState?.headRefOid ?? '').trim().toLowerCase();
  const boundHead = String(prTask?.boundHeadSha ?? '').trim().toLowerCase();
  if (!liveHead || liveHead !== boundHead) {
    throw new Error(`ReviewLoop PR: HEAD drift detected (live=${liveHead || 'missing'}, bound=${boundHead || 'missing'})`);
  }
  return true;
}

export function canTriggerGeminiReview({ prTask, prState, session }) {
  const triggers = Array.isArray(prTask?.reviewTriggers) ? prTask.reviewTriggers : [];
  const postedCount = triggers.filter((t) => t.status === 'POSTED').length;
  const activeCount = triggers.filter((t) => t.status === 'POSTED' || t.status === 'PENDING').length;
  if (activeCount >= MAX_REVIEW_TRIGGERS) {
    return { allowed: false, reason: 'TRIGGER_LIMIT_REACHED', postedCount, activeCount };
  }
  if (prTask?.permissions?.comment !== true) {
    return { allowed: false, reason: 'PERMISSION_DENIED_COMMENT', postedCount, activeCount };
  }
  const prStatus = String(prState?.state ?? '').trim().toUpperCase();
  if (prStatus !== 'OPEN') {
    return { allowed: false, reason: 'PR_NOT_OPEN', postedCount, activeCount };
  }
  const liveHeadSha = String(prState?.headRefOid ?? '').trim().toLowerCase();
  const boundHeadSha = String(prTask?.boundHeadSha ?? '').trim().toLowerCase();
  if (!liveHeadSha || liveHeadSha !== boundHeadSha) {
    return { allowed: false, reason: 'HEAD_DRIFT', postedCount, activeCount };
  }
  if (triggers.some((t) => t.headSha === boundHeadSha && (t.status === 'POSTED' || t.status === 'PENDING'))) {
    return { allowed: false, reason: 'ALREADY_TRIGGERED_FOR_HEAD', postedCount, activeCount };
  }
  if (session?.found) {
    if (WAITING_BOT_STATUSES.has(session.sessionStatus)) {
      return { allowed: false, reason: `BOT_${session.sessionStatus}`, postedCount, activeCount };
    }
    if (session.sessionStatus === BOT_SESSION_STATUSES.READY && session.lastReviewedHead === liveHeadSha) {
      return { allowed: false, reason: 'ALREADY_READY_ON_HEAD', postedCount, activeCount };
    }
    if (session.sessionStatus === BOT_SESSION_STATUSES.REWORK && session.lastReviewedHead === liveHeadSha) {
      return { allowed: false, reason: 'UNCHANGED_REWORK_HEAD', postedCount, activeCount };
    }
  }
  return { allowed: true, reason: 'OK', postedCount, activeCount };
}

export async function triggerGeminiReview({
  loopId,
  prTask,
  prState,
  comments = [],
  store,
  postCommentFn,
  fetchPrSnapshotFn = null,
  withLeaseFn = async (fn) => fn(),
  pendingTtlMs = PENDING_TRIGGER_TTL_MS,
  nowFn = () => new Date().toISOString(),
}) {
  const phaseA = await withLeaseFn(async () => {
    const freshLoopState = typeof store.load === 'function' ? await store.load(loopId) : null;
    const freshTask = (await store.loadPrTask(loopId)) ?? prTask;
    const triggers = Array.isArray(freshTask.reviewTriggers) ? [...freshTask.reviewTriggers] : [];
    freshTask.reviewTriggers = triggers;
    if (freshLoopState && (isTerminal(freshLoopState.state) || freshLoopState.state === REVIEW_LOOP_STATES.HUMAN_REQUIRED)) {
      return {
        done: true,
        result: {
          posted: false,
          reason: `LOOP_${freshLoopState.state}`,
          postedCount: triggers.filter((t) => t.status === 'POSTED').length,
        },
      };
    }
    const nowIso = nowFn();
    const nowMs = Date.parse(nowIso) || Date.now();
    let expiredAny = false;

    // Crash recovery: reconcile any PENDING trigger against existing PR comments first,
    // and expire orphaned PENDING records that never reached GitHub past pendingTtlMs.
    for (const pending of triggers.filter((t) => t.status === 'PENDING')) {
      const marker = triggerMarker(pending.idempotencyKey);
      const existing = (Array.isArray(comments) ? comments : []).find((c) => String(c?.body ?? '').includes(marker));
      if (existing) {
        pending.status = 'POSTED';
        pending.commentId = existing.id ?? pending.commentId ?? null;
        pending.commentUrl = existing.url ?? pending.commentUrl ?? null;
        pending.postedAt = existing.createdAt ?? nowIso;
        freshTask.updatedAt = nowIso;
        await store.savePrTask(loopId, freshTask);
        if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
        return {
          done: true,
          result: {
            posted: true,
            recovered: true,
            trigger: pending,
            postedCount: triggers.filter((t) => t.status === 'POSTED').length,
          },
        };
      }
      const createdMs = Date.parse(pending.createdAt ?? '');
      if (Number.isFinite(createdMs) && (nowMs - createdMs) >= pendingTtlMs) {
        pending.status = 'FAILED';
        pending.error = 'PENDING_EXPIRED_WITHOUT_COMMENT';
        expiredAny = true;
      }
    }
    if (expiredAny) {
      freshTask.updatedAt = nowIso;
      await store.savePrTask(loopId, freshTask);
      if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
    }

    const session = parseTrustedBotSession({ comments, trustedBotLogins: freshTask.trustedBotLogins });
    const gate = canTriggerGeminiReview({ prTask: freshTask, prState, session });
    if (!gate.allowed) {
      return {
        done: true,
        result: { posted: false, reason: gate.reason, postedCount: gate.postedCount },
      };
    }

    const headSha = String(freshTask.boundHeadSha).trim().toLowerCase();
    const attemptIndex = triggers.filter((t) => t.headSha === headSha).length;
    const idempotencyKey = `rl-${sha256Hex(`${loopId}:${headSha}:${attemptIndex}`).slice(0, 16)}`;
    const now = nowFn();

    const record = {
      idempotencyKey,
      headSha,
      status: 'PENDING',
      commentId: null,
      commentUrl: null,
      createdAt: now,
      postedAt: null,
      error: null,
    };
    triggers.push(record);
    freshTask.updatedAt = now;
    await store.savePrTask(loopId, freshTask);
    if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
    return {
      done: false,
      idempotencyKey,
      repoFullName: freshTask.repoFullName,
      prNumber: freshTask.prNumber,
    };
  });

  if (phaseA.done) {
    return phaseA.result;
  }

  let postResult = null;
  let postError = null;
  let postDefinitelyNotSent = false;
  try {
    postResult = await postCommentFn({
      repoFullName: phaseA.repoFullName,
      prNumber: phaseA.prNumber,
      body: buildReviewTriggerBody(phaseA.idempotencyKey),
    });
  } catch (err) {
    postError = String(err?.message ?? err);
    postDefinitelyNotSent = err?.definitelyNotSent === true;
  }

  let reconciledComment = null;
  let reconcileConfirmedMissing = false;
  if (postError != null && typeof fetchPrSnapshotFn === 'function') {
    try {
      const freshSnapshot = await fetchPrSnapshotFn({
        repoFullName: phaseA.repoFullName,
        prNumber: phaseA.prNumber,
      });
      const marker = triggerMarker(phaseA.idempotencyKey);
      reconciledComment = (freshSnapshot?.comments ?? []).find((c) => String(c?.body ?? '').includes(marker)) ?? null;
      if (!reconciledComment) reconcileConfirmedMissing = true;
    } catch {
      // Reconcile snapshot failed; keep PENDING to avoid duplicate comment.
    }
  }

  return withLeaseFn(async () => {
    const freshTask = (await store.loadPrTask(loopId)) ?? prTask;
    const triggers = Array.isArray(freshTask.reviewTriggers) ? [...freshTask.reviewTriggers] : [];
    freshTask.reviewTriggers = triggers;
    const target = triggers.find((t) => t.idempotencyKey === phaseA.idempotencyKey);

    if (postError == null) {
      const postedAt = nowFn();
      if (target) {
        target.status = 'POSTED';
        target.commentId = postResult?.commentId ?? postResult?.id ?? null;
        target.commentUrl = postResult?.commentUrl ?? postResult?.url ?? null;
        target.postedAt = postedAt;
      }
      freshTask.updatedAt = postedAt;
      await store.savePrTask(loopId, freshTask);
      if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
      return {
        posted: true,
        recovered: false,
        trigger: target ?? null,
        postedCount: triggers.filter((t) => t.status === 'POSTED').length,
      };
    }

    if (reconciledComment) {
      const postedAt = reconciledComment.createdAt ?? nowFn();
      if (target) {
        target.status = 'POSTED';
        target.commentId = reconciledComment.id ?? target.commentId ?? null;
        target.commentUrl = reconciledComment.url ?? target.commentUrl ?? null;
        target.postedAt = postedAt;
        target.error = null;
      }
      freshTask.updatedAt = postedAt;
      await store.savePrTask(loopId, freshTask);
      if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
      return {
        posted: true,
        recovered: true,
        trigger: target ?? null,
        postedCount: triggers.filter((t) => t.status === 'POSTED').length,
      };
    }

    if (reconcileConfirmedMissing || postDefinitelyNotSent) {
      if (target) {
        target.status = 'FAILED';
        target.error = postError;
      }
      freshTask.updatedAt = nowFn();
      await store.savePrTask(loopId, freshTask);
      if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
      return {
        posted: false,
        reason: 'POST_FAILED',
        error: postError,
        trigger: target ?? null,
        postedCount: triggers.filter((t) => t.status === 'POSTED').length,
      };
    }

    if (target) {
      target.error = postError;
      target.postUncertain = true;
    }
    freshTask.updatedAt = nowFn();
    await store.savePrTask(loopId, freshTask);
    if (prTask && prTask !== freshTask) prTask.reviewTriggers = freshTask.reviewTriggers;
    return {
      posted: false,
      reason: 'POST_UNCERTAIN',
      error: postError,
      trigger: target ?? null,
      postedCount: triggers.filter((t) => t.status === 'POSTED').length,
    };
  });
}

export async function pushPrHead({
  loopId,
  store,
  execFn = execFileAsync,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  withLeaseFn = async (fn) => fn(),
  nowFn = () => new Date().toISOString(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  postPushRetries = 2,
  postPushRetryDelayMs = 1000,
}) {
  return withLeaseFn(async () => {
    const freshLoopState = typeof store.load === 'function' ? await store.load(loopId) : null;
    if (freshLoopState && (isTerminal(freshLoopState.state) || freshLoopState.state === REVIEW_LOOP_STATES.HUMAN_REQUIRED)) {
      throw new Error(`ReviewLoop PR: cannot push when loop state is ${freshLoopState.state}`);
    }

    const freshTask = await store.loadPrTask(loopId);
    if (!freshTask) {
      throw new Error(`ReviewLoop PR: prTask missing for loopId "${loopId}"`);
    }
    if (freshTask.permissions?.push !== true) {
      throw new Error('ReviewLoop PR: action "push" is not authorized');
    }

    const oldSha = String(freshTask.boundHeadSha ?? '').trim().toLowerCase();
    const repoRoot = freshTask.repoRoot;
    const headBranch = freshTask.headBranch;
    if (!oldSha || !repoRoot || !headBranch) {
      throw new Error('ReviewLoop PR: prTask missing boundHeadSha, repoRoot, or headBranch');
    }

    const preSnapshot = await fetchPrSnapshotFn({
      repoFullName: freshTask.repoFullName,
      prNumber: freshTask.prNumber,
    });
    const preStatus = String(preSnapshot?.prState?.state ?? '').trim().toUpperCase();
    if (preStatus !== 'OPEN') {
      throw new Error(`ReviewLoop PR: cannot push when PR state is ${preStatus || 'UNKNOWN'}`);
    }
    if (preSnapshot?.prState?.headRefName && preSnapshot.prState.headRefName !== headBranch) {
      throw new Error(`ReviewLoop PR: PR head branch mismatch (live=${preSnapshot.prState.headRefName}, expected=${headBranch})`);
    }
    const preRemoteSha = String(preSnapshot?.prState?.headRefOid ?? '').trim().toLowerCase();
    if (!preRemoteSha || preRemoteSha !== oldSha) {
      throw new Error(`ReviewLoop PR: HEAD drift detected before push (remote=${preRemoteSha || 'missing'}, bound=${oldSha})`);
    }

    const { stdout: branchOut } = await execFn('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    const currentBranch = String(branchOut ?? '').trim();
    if (currentBranch !== headBranch) {
      throw new Error(`ReviewLoop PR: local branch "${currentBranch}" does not match PR headBranch "${headBranch}"`);
    }

    const { stdout: localHeadOut } = await execFn('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const localHead = String(localHeadOut ?? '').trim().toLowerCase();
    if (!localHead || localHead === oldSha) {
      throw new Error('ReviewLoop PR: local HEAD has no new commit to push');
    }

    try {
      await execFn('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', oldSha, localHead], { encoding: 'utf8' });
    } catch {
      throw new Error(`ReviewLoop PR: local HEAD (${localHead}) is not a fast-forward descendant of boundHeadSha (${oldSha}); history rewrite/rebase is rejected`);
    }

    await execFn('git', ['-C', repoRoot, 'push', 'origin', `HEAD:${headBranch}`], { encoding: 'utf8' });

    let remoteVerified = false;
    let postRemoteSha = '';
    for (let attempt = 0; attempt <= postPushRetries; attempt += 1) {
      try {
        const postSnapshot = await fetchPrSnapshotFn({
          repoFullName: freshTask.repoFullName,
          prNumber: freshTask.prNumber,
        });
        postRemoteSha = String(postSnapshot?.prState?.headRefOid ?? '').trim().toLowerCase();
        if (postRemoteSha === localHead) {
          remoteVerified = true;
          break;
        }
        if (postRemoteSha && postRemoteSha !== oldSha) {
          throw new Error(`ReviewLoop PR: remote HEAD after push (${postRemoteSha}) does not match pushed commit (${localHead})`);
        }
      } catch (err) {
        if (String(err?.message ?? '').includes('does not match pushed commit')) {
          throw err;
        }
      }
      if (attempt < postPushRetries && postPushRetryDelayMs > 0) {
        await sleepFn(postPushRetryDelayMs);
      }
    }

    const checkTask = await store.loadPrTask(loopId);
    const checkBound = String(checkTask?.boundHeadSha ?? '').trim().toLowerCase();
    if (checkBound !== oldSha) {
      throw new Error(`ReviewLoop PR: boundHeadSha changed concurrently (${checkBound} !== ${oldSha})`);
    }

    const pushedAt = nowFn();
    checkTask.boundHeadSha = localHead;
    checkTask.headHistory = [
      ...(Array.isArray(checkTask.headHistory) ? checkTask.headHistory : []),
      { fromSha: oldSha, toSha: localHead, pushedAt, actor: 'worker', remoteVerified },
    ];
    checkTask.updatedAt = pushedAt;
    await store.savePrTask(loopId, checkTask);
    return {
      pushed: true,
      oldHeadSha: oldSha,
      newHeadSha: localHead,
      headBranch,
      remoteVerified,
    };
  });
}

export function recordPrFixRound({ prTask, boundaryKey = null, introducedNewBlocker = false }) {
  const streak = prTask.sharedBoundaryStreak ?? { count: 0, boundaryKey: null, roundHistory: [] };
  const normalizedKey = boundaryKey ? String(boundaryKey).trim() : null;

  if (!introducedNewBlocker || !normalizedKey) {
    prTask.sharedBoundaryStreak = {
      count: 0,
      boundaryKey: null,
      roundHistory: [...(streak.roundHistory ?? []), { boundaryKey: normalizedKey, introducedNewBlocker: false }],
    };
    return { escalateHumanRequired: false, count: 0 };
  }

  const nextCount = streak.boundaryKey === normalizedKey ? (streak.count ?? 0) + 1 : 1;
  prTask.sharedBoundaryStreak = {
    count: nextCount,
    boundaryKey: normalizedKey,
    roundHistory: [...(streak.roundHistory ?? []), { boundaryKey: normalizedKey, introducedNewBlocker: true }],
  };

  if (nextCount >= 2) {
    return {
      escalateHumanRequired: true,
      reason: 'SHARED_BOUNDARY_REGRESSION',
      boundaryKey: normalizedKey,
      count: nextCount,
      requiresReadOnlyRootCauseAudit: true,
    };
  }

  return { escalateHumanRequired: false, count: nextCount, boundaryKey: normalizedKey };
}

export async function fetchPrSnapshotViaGh({ repoFullName, prNumber, execFn = execFileAsync }) {
  const { stdout } = await execFn('gh', [
    'pr', 'view', String(prNumber),
    '--repo', repoFullName,
    '--json', 'state,headRefOid,baseRefName,headRefName,comments',
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return {
    prState: {
      state: parsed.state,
      headRefOid: parsed.headRefOid,
      baseRefName: parsed.baseRefName,
      headRefName: parsed.headRefName,
    },
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
  };
}

export async function postPrCommentViaGh({ repoFullName, prNumber, body, execFn = execFileAsync }) {
  const { stdout } = await execFn('gh', [
    'pr', 'comment', String(prNumber),
    '--repo', repoFullName,
    '--body', body,
  ], { encoding: 'utf8' });
  const url = String(stdout ?? '').trim() || null;
  const idMatch = url?.match(/issuecomment-(\d+)/);
  return {
    commentId: idMatch ? idMatch[1] : null,
    commentUrl: url,
  };
}
