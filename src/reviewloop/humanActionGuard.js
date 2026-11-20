// Shared building blocks for the explicit HUMAN recovery actions
// (acknowledge-token-anomaly, reopen-gate, extend-calls, stop-loop).
//
// Leaf module on purpose (no imports): the actions, the spend authority and the
// report builder all depend on it, so it must not depend on any of them.
//
//   * assertUnchanged   - re-read right before the single write and refuse if
//                         anything the decision was based on has moved.
//   * call allowance    - the TASK-LEVEL call ceiling a human grants or
//                         tightens for exactly one loop. It lives in its own
//                         workflow key, separate from `budgetOverrides` (which
//                         override-budget replaces wholesale), and is enforced
//                         by the same spend-authority check as the global
//                         ceilings. Free text is audit only, never a limit.

export const CALL_ALLOWANCE_KEY = 'reviewLoopCallAllowance';
export const SPEND_STATE_KEY = 'reviewLoopSpend';
export const TOKEN_ACK_STANDARD_LIMIT = 3;
export const MAX_ALLOWANCE_REVIEWER_CALLS = 50;
export const MAX_ALLOWANCE_SUPERVISOR_CALLS = 20;

const positiveInt = (v) => Number.isInteger(v) && v > 0;

// The per-loop ceilings a human has set, or {} when none. Only valid positive
// integers are honoured, so a damaged value can never raise a ceiling.
export function callCeilingsFromState(workflow) {
  const a = workflow?.[CALL_ALLOWANCE_KEY];
  const out = {};
  if (positiveInt(a?.maxReviewerCalls)) out.maxReviewerCalls = a.maxReviewerCalls;
  if (positiveInt(a?.maxSupervisorCalls)) out.maxSupervisorCalls = a.maxSupervisorCalls;
  return out;
}

export function usedCalls(workflow) {
  const records = Array.isArray(workflow?.[SPEND_STATE_KEY]?.records) ? workflow[SPEND_STATE_KEY].records : [];
  return {
    reviewer: records.filter((r) => r?.role === 'reviewer').length,
    supervisor: records.filter((r) => r?.role === 'supervisor').length,
  };
}

// Parse a human-supplied call count. Absent -> null. Present but invalid -> throws.
export function parseCallCount(value, { name, max }) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max} (got ${JSON.stringify(value)})`);
  }
  return n;
}

// Key facts a human decision is based on. Callers compare before/after.
export function fingerprint(workflow) {
  const loop = workflow?.reviewLoop;
  return {
    updatedAt: loop?.updatedAt ?? null,
    state: loop?.state ?? null,
    latchAt: workflow?.reviewLoopTokenAnomaly?.at ?? null,
    latchTripped: workflow?.reviewLoopTokenAnomaly?.tripped === true,
    acks: Array.isArray(workflow?.reviewLoopTokenAnomalyAcks) ? workflow.reviewLoopTokenAnomalyAcks.length : 0,
    records: Array.isArray(workflow?.[SPEND_STATE_KEY]?.records) ? workflow[SPEND_STATE_KEY].records.length : 0,
    allowanceEntries: Array.isArray(workflow?.[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history.length : 0,
    reopens: Array.isArray(loop?.humanReopens) ? loop.humanReopens.length : 0,
  };
}

export async function assertUnchanged({ persistence, loopId, before, action }) {
  const fresh = fingerprint(await persistence.readWorkflowState(loopId));
  const changed = Object.keys(before).filter((k) => before[k] !== fresh[k]);
  if (changed.length) {
    throw new Error(`concurrent modification detected in loop ${loopId} while ${action}; nothing was written, re-read the report and retry`);
  }
}

const persistenceLoopLocks = new WeakMap();

async function withLoopLock(persistence, loopId, fn) {
  let byLoop = persistenceLoopLocks.get(persistence);
  if (!byLoop) {
    byLoop = new Map();
    persistenceLoopLocks.set(persistence, byLoop);
  }
  const prev = byLoop.get(loopId) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => mine, () => mine);
  byLoop.set(loopId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (byLoop.get(loopId) === tail) byLoop.delete(loopId);
  }
}

// Serialize the pre-write re-read + single write per (persistence, loopId) so
// two in-process actors cannot both pass assertUnchanged before either writes.
export async function commitGuardedUpdate({ persistence, loopId, before, action, buildPatch }) {
  return withLoopLock(persistence, loopId, async () => {
    await assertUnchanged({ persistence, loopId, before, action });
    const patch = typeof buildPatch === 'function' ? await buildPatch() : buildPatch;
    await persistence.updateWorkflowState(loopId, patch);
  });
}

// Build the next `reviewLoopCallAllowance` value. `mode`:
//   'tighten' - the extended confirmation: ceiling = min(current, used + N),
//               so it can only keep or lower the effective ceiling;
//   'extend'  - extend-calls: ceiling = used + N, which must EXCEED the
//               current effective ceiling (otherwise it grants nothing).
// `currentLimits` is the effective {maxReviewerCalls,maxSupervisorCalls} the
// spend authority enforces right now (env + gates + any earlier allowance).
export function nextCallAllowance({
  workflow, currentLimits, reviewerCalls = null, supervisorCalls = null, mode, tier, reason, at, source,
}) {
  if (!currentLimits || !positiveInt(currentLimits.maxReviewerCalls) || !positiveInt(currentLimits.maxSupervisorCalls)) {
    throw new Error('the current effective call ceilings are required to set a task-level call allowance');
  }
  if (reviewerCalls == null && supervisorCalls == null) {
    throw new Error('a call allowance needs a reviewer-call count or a supervisor-call count');
  }
  const used = usedCalls(workflow);
  const prior = workflow?.[CALL_ALLOWANCE_KEY] ?? {};
  const history = Array.isArray(prior.history) ? prior.history : [];
  const next = { ...callCeilingsFromState(workflow) };
  const entries = [];
  for (const [role, n, usedNow, current, key] of [
    ['reviewer', reviewerCalls, used.reviewer, currentLimits.maxReviewerCalls, 'maxReviewerCalls'],
    ['supervisor', supervisorCalls, used.supervisor, currentLimits.maxSupervisorCalls, 'maxSupervisorCalls'],
  ]) {
    if (n == null) continue;
    const requested = usedNow + n;
    let ceiling;
    if (mode === 'extend') {
      if (requested <= current) {
        throw new Error(`extend-calls: ${role} calls used ${usedNow} + ${n} = ${requested} does not exceed the current ${role} ceiling (${current}); ask for more, or the loop can already make ${current - usedNow} more ${role} call(s)`);
      }
      ceiling = requested;
    } else {
      ceiling = Math.min(current, requested);
    }
    // A tighten that would not lower the ceiling is audited but not stored, so it
    // never pins the loop below a later, deliberate global raise.
    if (mode === 'extend' || ceiling < current) next[key] = ceiling;
    entries.push({
      at, source, tier, role, reason: String(reason).trim(), usedAtGrant: usedNow, granted: n,
      previousCeiling: current, newCeiling: ceiling,
    });
  }
  return { ...prior, ...next, history: [...history, ...entries] };
}

// Read a loop's workflow without ever throwing a raw parse error at a human.
//   MISSING    - no workflow for this id (ENOENT): an unknown task id.
//   UNREADABLE - the record exists but cannot be parsed, or has no loop in it:
//                nothing can be safely written back to it.
//   OK         - { workflow, loop }.
export async function readLoopWorkflow(persistence, loopId) {
  let workflow;
  try {
    workflow = await persistence.readWorkflowState(loopId);
  } catch (err) {
    return {
      status: 'UNREADABLE',
      errorClass: err?.name ?? 'Error',
      errorMessage: String(err?.message ?? err).slice(0, 160),
    };
  }
  if (workflow == null) return { status: 'MISSING' };
  if (typeof workflow !== 'object' || !workflow.reviewLoop || typeof workflow.reviewLoop !== 'object') {
    return { status: 'UNREADABLE', errorClass: 'NoLoopRecord', errorMessage: 'the workflow record has no readable ReviewLoop state' };
  }
  return { status: 'OK', workflow, loop: workflow.reviewLoop };
}
