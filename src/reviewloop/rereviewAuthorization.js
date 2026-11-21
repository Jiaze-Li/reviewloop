// Human authorization to leave a HUMAN_REQUIRED hard stop and review again.
//
// A HUMAN_REQUIRED loop is a hard stop: an ordinary review call - same content,
// changed content, repeated, or malformed - is refused read-only (controller).
// This is the one explicit way back for a stop that has no more specific human
// exit. A grant is single-use and bound to BOTH the exact stop event it answers
// and the exact submission digest, so it never unlocks later budget/rounds.
// It does not reset or clear any history, budget, fingerprint or ledger.

import { REVIEW_LOOP_STATES } from './state.js';
import {
  CALL_ALLOWANCE_KEY, MAX_ALLOWANCE_REVIEWER_CALLS, MAX_ALLOWANCE_SUPERVISOR_CALLS,
  commitGuardedUpdate, fingerprint, nextCallAllowance, parseCallCount, readLoopWorkflow,
} from './humanActionGuard.js';
import { activeBlockers, classify } from './humanRequiredReport.js';

const STATE_KEY = 'reviewLoop';
// Standard grants per loop; past it a numeric Reviewer-call budget is required.
export const STANDARD_REREVIEW_GRANTS = 3;
// Stops that have their own specific human exit or that no re-review can fix.
const NOT_REREVIEWABLE = new Set(['TASK_DEFINITION', 'STATE_UNREADABLE']);

const lastHumanRequired = (loop) => [...(loop?.history ?? [])].reverse().find((h) => h?.to === 'HUMAN_REQUIRED') ?? null;

// Dry-run of every precondition; shared by the CLI action and the report so the
// report never recommends a command that would be refused.
export function rereviewPrecondition({ loop, workflow, env = process.env }) {
  if (!loop || loop.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED) return { ok: false, why: `the task is ${loop?.state ?? 'unknown'}, not stopped for a human` };
  if (loop.budgetExhausted === true) return { ok: false, why: 'its review budget is spent; use reopen-gate instead' };
  const stop = lastHumanRequired(loop);
  if (!stop?.at) return { ok: false, why: 'the stop event has no recorded time' };
  const lastHr = stop;
  const blockers = activeBlockers({ loop, workflow, fromSupervisor: lastHr.from === 'SUPERVISING', env });
  if (blockers.unreadable) return { ok: false, why: 'the independent safety stops could not be read' };
  if (blockers.list.length > 0) return { ok: false, why: `independent stops are still in force (${blockers.list.join(', ')}); handle them first` };
  const { category } = classify({ loop, workflow, reason: String(lastHr.reason ?? '').slice(0, 200), env });
  if (NOT_REREVIEWABLE.has(category)) return { ok: false, why: `a ${category} stop cannot be released by re-review` };
  return { ok: true, stopAt: stop.at, category };
}

// The unconsumed grant (if any) that answers the CURRENT stop for exactly this submission.
export function usableGrant({ loop, submissionDigest }) {
  const stop = lastHumanRequired(loop);
  if (!stop) return null;
  const grants = Array.isArray(loop?.rereviewGrants) ? loop.rereviewGrants : [];
  return grants.find((g) => g && g.consumedAt == null && g.stopAt === stop.at && g.submission === submissionDigest) ?? null;
}

export async function authorizeRereview({
  persistence, loopId, submission, reason, allowance = null, currentLimits = null, env = process.env, now = () => new Date(),
}) {
  if (!loopId || !String(reason ?? '').trim()) throw new Error('authorize-rereview requires a loopId and a reason');
  if (!/^[0-9a-f]{64}$/.test(String(submission ?? ''))) throw new Error('authorize-rereview requires --submission <digest> exactly as shown by the report');
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing can be safely written to it`);
  const { workflow, loop } = read;
  const pre = rereviewPrecondition({ loop, workflow, env });
  if (!pre.ok) throw new Error(`authorize-rereview refused: ${pre.why}. Nothing was written`);

  const grants = Array.isArray(loop.rereviewGrants) ? loop.rereviewGrants : [];
  const extended = grants.length >= STANDARD_REREVIEW_GRANTS;
  const reviewerCalls = parseCallCount(allowance?.reviewerCalls, { name: '--max-reviewer-calls', max: MAX_ALLOWANCE_REVIEWER_CALLS });
  const supervisorCalls = parseCallCount(allowance?.supervisorCalls, { name: '--max-supervisor-calls', max: MAX_ALLOWANCE_SUPERVISOR_CALLS });
  if (extended && reviewerCalls == null) {
    throw new Error(`this loop already had ${grants.length} re-review authorizations (standard limit ${STANDARD_REREVIEW_GRANTS}); another is still possible but must state how many more Reviewer calls it may use: add --max-reviewer-calls <1-${MAX_ALLOWANCE_REVIEWER_CALLS}> (enforced as this loop's call ceiling)`);
  }
  const at = now().toISOString();
  const priorEntries = Array.isArray(workflow?.[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history.length : 0;
  const nextAllowance = (reviewerCalls != null || supervisorCalls != null)
    ? nextCallAllowance({
      workflow, currentLimits, reviewerCalls, supervisorCalls, mode: 'tighten',
      tier: extended ? 'EXTENDED' : 'STANDARD', reason, at, source: 'authorize-rereview',
    })
    : null;
  const before = fingerprint(workflow);
  const grant = {
    id: `rr-${grants.length + 1}-${at.replace(/\D/g, '').slice(0, 14)}`,
    at, stopAt: pre.stopAt, round: loop.round, submission, reason: String(reason).slice(0, 300),
    tier: extended ? 'EXTENDED' : 'STANDARD', consumedAt: null,
  };
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'authorizing a re-review',
    buildPatch: () => {
      loop.rereviewGrants = [...grants, grant];
      return { [STATE_KEY]: loop, ...(nextAllowance ? { [CALL_ALLOWANCE_KEY]: nextAllowance } : {}) };
    },
  });
  return { loopId, grantId: grant.id, stopAt: grant.stopAt, tier: grant.tier, grants: grants.length + 1 };
}
