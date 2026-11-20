// Human-authorized Design-review exception (RL-HUMAN-AUTHORITY-20261120,
// Design v1.0 §5.1-5.3). CLI-only human action, same family and write guard
// as stop-loop / reopen-gate / extend-calls (PR #59); never reachable from the
// Worker MCP surface.
//
// What it does: when a NEW-style Design loop stopped at HUMAN_REQUIRED because
// the review TOOL could not finish (not because the design is defective), a
// human may accept an alternative independent review for ONE exact design
// content and allow that design to move to Code.
//
// What it never does: it never changes `workflow.reviewLoop` (state, round,
// history, findings), the spend ledger, the Token Sentinel, call ceilings or
// budgets; it never records a Design PASS; it never releases any other stop.
// It writes exactly one workflow key (`reviewLoopDesignException`).

import { createHash } from 'node:crypto';
import { designContentSha256, readReviewTarget } from './designTarget.js';
import { commitGuardedUpdate, fingerprint, readLoopWorkflow } from './humanActionGuard.js';
import { activeBlockers, classify } from './humanRequiredReport.js';
import {
  DESIGN_EXCEPTION_ALLOWS, DESIGN_EXCEPTION_ELIGIBLE_CATEGORIES, DESIGN_EXCEPTION_FORBIDS,
  DESIGN_EXCEPTION_KEY, EXTERNAL_REVIEW_SCHEMA,
} from './designExceptionState.js';

const SHA_RE = /^[0-9a-f]{64}$/;
const BLOCKING_SEVERITIES = new Set(['P1', 'P2']);
const TEXT_MAX = 500;

const clip = (v, n = TEXT_MAX) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function requireText(value, name) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`accept-design-exception requires ${name}`);
  return s;
}

function lastHumanRequired(loop) {
  return [...(loop?.history ?? [])].reverse().find((h) => h?.to === 'HUMAN_REQUIRED') ?? null;
}

/**
 * Validates the external independent review report (JSON text) against the
 * exact Plan and Design it must be bound to. Pure; throws on any problem.
 */
export function validateExternalReviewReport(reportText, { planSha256, designSha256 }) {
  let report;
  try {
    report = JSON.parse(String(reportText ?? ''));
  } catch (err) {
    throw new Error(`the external review report is not valid JSON (${clip(err?.message, 120)})`);
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('the external review report must be a JSON object');
  }
  if (report.schema !== EXTERNAL_REVIEW_SCHEMA) {
    throw new Error(`the external review report must declare "schema": "${EXTERNAL_REVIEW_SCHEMA}"`);
  }
  const reportPlan = String(report.planSha256 ?? '').trim().toLowerCase();
  const reportDesign = String(report.designSha256 ?? '').trim().toLowerCase();
  if (!SHA_RE.test(reportPlan) || reportPlan !== planSha256) {
    throw new Error(`the external review report was made for Plan ${reportPlan || '(missing)'}, not the loop's frozen Plan ${planSha256}`);
  }
  if (!SHA_RE.test(reportDesign) || reportDesign !== designSha256) {
    throw new Error(`the external review report reviewed design ${reportDesign || '(missing)'}, not the current design ${designSha256}; a changed design needs a new review`);
  }
  const reviewer = typeof report.reviewer === 'string'
    ? report.reviewer.trim()
    : (report.reviewer && typeof report.reviewer === 'object' ? JSON.stringify(report.reviewer) : '');
  if (!reviewer) throw new Error('the external review report must name the reviewer and its isolated context ("reviewer")');
  for (const key of ['rounds', 'openFindings', 'verifiedSources', 'unverifiedRisks', 'testsNotRun']) {
    if (!Array.isArray(report[key])) throw new Error(`the external review report must carry "${key}" as a list (empty if none)`);
  }
  if (report.rounds.length === 0) throw new Error('the external review report must record at least one review round');
  if (report.verdict !== 'NO_BLOCKING') {
    throw new Error(`the external review verdict is ${JSON.stringify(report.verdict ?? null)}; only "NO_BLOCKING" can be accepted. Fix the findings and get a new review first`);
  }
  const blocking = report.openFindings.filter((f) => BLOCKING_SEVERITIES.has(String(f?.severity ?? '').trim().toUpperCase()));
  if (blocking.length > 0) {
    throw new Error(`the external review still has ${blocking.length} open P1/P2 finding(s); fix them and get a new review first`);
  }
  return {
    reviewer: clip(reviewer, 200),
    verdict: 'NO_BLOCKING',
    rounds: report.rounds.length,
    openFindings: report.openFindings.length,
    verifiedSources: report.verifiedSources.length,
    unverifiedRisks: report.unverifiedRisks.map((r) => clip(typeof r === 'string' ? r : JSON.stringify(r), 200)),
    testsNotRun: report.testsNotRun.length,
  };
}

/**
 * The PR-archivable text of a decision (deterministic; no local paths, no
 * ledger content). Its trimmed SHA-256 is stored as `archiveSha256`.
 */
export function buildExceptionArchiveText(active, reportText) {
  const lines = [
    '# Human-authorized Design exception（人工授权例外，非 ReviewLoop PASS）',
    '',
    '本记录是人工裁决，不是 ReviewLoop 审查结果。原 Design 审查状态保持不变（仍未通过）。',
    '',
    `- exceptionId: ${active.id}`,
    `- grantedAt: ${active.at}`,
    `- repo: ${active.repo}`,
    `- prNumber: ${active.prNumber}`,
    `- taskId: ${active.taskId}`,
    `- designVersion: ${active.designVersion}`,
    `- originalLoop: ${active.loopId} (${active.loopAnchor.state}, round ${active.loopAnchor.round}, category ${active.loopAnchor.category})`,
    `- planSha256: ${active.planSha256}`,
    `- designSha256: ${active.designSha256}`,
    `- reviewTarget: ${active.reviewTarget}`,
    `- reportSha256: ${active.reportSha256}`,
    `- allows: ${active.allows.join(', ')}`,
    `- forbids: ${active.forbids.join(', ')}`,
    `- reason: ${active.reason}`,
    `- acceptedRisk: ${active.acceptedRisk ?? '(none)'}`,
    `- independence: ${active.independence}`,
    '',
    '## External independent review report',
    '',
    '```json',
    String(reportText).trim(),
    '```',
  ];
  return lines.join('\n');
}

/**
 * Grant (or replace) the active exception of ONE Design loop.
 */
export async function grantDesignException({
  persistence, loopId, repo, prNumber, taskId, designVersion, designSha256, reportText, reason,
  acceptRisk = null, now = () => new Date(), readTarget = readReviewTarget, env = process.env,
}) {
  if (!loopId) throw new Error('accept-design-exception requires a loopId');
  const repoSlug = requireText(repo, '--repo <owner/name>');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) throw new Error(`--repo must be "owner/name", got ${JSON.stringify(repo)}`);
  const pr = Number(String(prNumber ?? '').trim());
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr must be a PR number, got ${JSON.stringify(prNumber)}`);
  const task = requireText(taskId, '--task-id');
  const version = requireText(designVersion, '--design-version');
  const expectedSha = String(designSha256 ?? '').trim().toLowerCase();
  if (!SHA_RE.test(expectedSha)) throw new Error('--design-sha must be the 64-hex SHA-256 of the design content');
  const why = requireText(reason, 'an explicit --reason');
  if (typeof reportText !== 'string' || !reportText.trim()) throw new Error('accept-design-exception requires the external review report (--review-report <file>)');

  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing can be safely written to it`);
  const { workflow, loop } = read;
  const objective = loop.objective ?? {};
  if (objective.taskType !== 'design' || !objective.reviewTarget) {
    throw new Error('a Design exception applies only to a Design loop with a reviewTarget (the current Design review path)');
  }
  if (typeof objective.contractText !== 'string' || !objective.contractText.trim()) {
    throw new Error('the Design loop has no frozen Plan (contractText); its Plan cannot be bound');
  }
  const stoppedFromHuman = loop.state === 'STOPPED' && loop.humanStop?.priorState === 'HUMAN_REQUIRED';
  if (loop.state !== 'HUMAN_REQUIRED' && !stoppedFromHuman) {
    throw new Error(`loop is ${loop.state}; a Design exception is only possible for a loop stopped at HUMAN_REQUIRED`);
  }

  // Eligibility: only a review-TOOL stop, and no other stop still in force.
  const hr = lastHumanRequired(loop);
  const fromSupervisor = hr?.from === 'SUPERVISING';
  const { category } = classify({ loop, workflow, reason: clip(hr?.reason ?? '', 200), env });
  if (!DESIGN_EXCEPTION_ELIGIBLE_CATEGORIES.includes(category)) {
    throw new Error(`this stop is ${category}, not a review-tool failure; a Design exception is only for ${DESIGN_EXCEPTION_ELIGIBLE_CATEGORIES.join(' / ')}. Use the action \`reviewloop report --loop ${loopId}\` recommends`);
  }
  const blockers = activeBlockers({ loop, workflow, fromSupervisor, env });
  if (blockers.unreadable) throw new Error('the independent safety stops of this loop could not be read; an exception cannot be granted');
  if (blockers.list.length > 0) {
    throw new Error(`independent stops are still in force (${blockers.list.join(', ')}); an exception never releases them. Handle them first (see \`reviewloop report --loop ${loopId}\`)`);
  }

  // Bindings: frozen Plan, the CURRENT design file, the human's explicit hash, the report.
  const planSha256 = designContentSha256(objective.contractText);
  const repoRoot = objective.repository?.root;
  if (!repoRoot) throw new Error('the Design loop does not record its repository root');
  const target = await readTarget({ cwd: repoRoot, reviewTarget: objective.reviewTarget });
  if (target.sha256 !== expectedSha) {
    throw new Error(`the current design file ${target.path} hashes to ${target.sha256}, not the --design-sha you approved (${expectedSha}); approve the exact current content`);
  }
  const summary = validateExternalReviewReport(reportText, { planSha256, designSha256: expectedSha });
  const risk = acceptRisk == null ? null : String(acceptRisk).trim() || null;
  if (summary.unverifiedRisks.length > 0 && !risk) {
    throw new Error(`the external review lists ${summary.unverifiedRisks.length} unverified risk(s); accepting them is a separate human decision: add --accept-risk "<what you accept>"`);
  }

  const before = fingerprint(workflow);
  const at = now().toISOString();
  const reportSha256 = designContentSha256(reportText);
  const id = `dx-${createHash('sha256').update(`${loopId}|${at}|${expectedSha}|${reportSha256}`).digest('hex').slice(0, 12)}`;
  const active = {
    id, at, source: 'cli', repo: repoSlug, prNumber: pr, taskId: task, designVersion: version, loopId,
    planSha256, designSha256: expectedSha, reviewTarget: target.path, reportSha256,
    reportSummary: summary, reason: clip(why), acceptedRisk: risk ? clip(risk) : null,
    independence: 'attested by the human; not verified by ReviewLoop',
    allows: [...DESIGN_EXCEPTION_ALLOWS], forbids: [...DESIGN_EXCEPTION_FORBIDS],
    loopAnchor: { state: loop.state, round: loop.round ?? 0, category, stopReason: clip(hr?.reason ?? '', 200), stopAt: hr?.at ?? null },
  };
  const archiveText = buildExceptionArchiveText(active, reportText);
  active.archiveSha256 = designContentSha256(archiveText);

  const prior = workflow[DESIGN_EXCEPTION_KEY] ?? {};
  const history = Array.isArray(prior.history) ? prior.history : [];
  const superseded = prior.active ? [{ ...prior.active, status: 'superseded', endedAt: at, endedBy: id }] : [];
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'granting a Design exception',
    buildPatch: () => ({ [DESIGN_EXCEPTION_KEY]: { active, history: [...history, ...superseded] } }),
  });
  return { loopId, active, archiveText, superseded: superseded.length > 0 ? superseded[0].id : null };
}

/**
 * Revoke the active exception of ONE loop. The record moves to history.
 */
export async function revokeDesignException({ persistence, loopId, reason, now = () => new Date() }) {
  if (!loopId) throw new Error('revoking a Design exception requires a loopId');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new Error('revoking a Design exception requires an explicit --reason');
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing can be safely written to it`);
  const prior = read.workflow[DESIGN_EXCEPTION_KEY] ?? {};
  if (!prior.active) throw new Error(`loop ${loopId} has no active Design exception to revoke`);
  const before = fingerprint(read.workflow);
  const at = now().toISOString();
  const history = Array.isArray(prior.history) ? prior.history : [];
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'revoking a Design exception',
    buildPatch: () => ({
      [DESIGN_EXCEPTION_KEY]: {
        active: null,
        history: [...history, { ...prior.active, status: 'revoked', endedAt: at, revokeReason: clip(why) }],
      },
    }),
  });
  return { loopId, revoked: prior.active.id, at };
}
