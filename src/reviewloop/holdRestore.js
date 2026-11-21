// Human recovery for an ambiguous old record: a loop that was HUMAN_REQUIRED and
// was then moved to REVIEWING by an ordinary review call that produced NO
// outcome (before the hard-stop gate existed). That shape is identical to a real
// interruption in the Gate stage, so the engine never infers which it was.
//
// `restore-hold` is the explicit human decision: it APPENDS one transition
// REVIEWING -> HUMAN_REQUIRED (cause HOLD_RESTORED) and changes no existing
// history entry. Returning to the hard stop is always the safe direction, and it
// is refused whenever any evidence shows the REVIEWING state made progress.

import { REVIEW_LOOP_STATES, recordTransition } from './state.js';
import { commitGuardedUpdate, fingerprint, readLoopWorkflow } from './humanActionGuard.js';
import { buildStopCause, STOP_KINDS, STOP_SOURCES, resolveStopCause } from './stopCause.js';

const STATE_KEY = 'reviewLoop';
const TS_KEYS = ['at', 'reservedAt', 'createdAt', 'dispatchedAt', 'settledAt', 'updatedAt'];

function ms(v) {
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? t : null;
}

// Anything that could be the footprint of a real review attempt after `since`.
// Unparseable timestamps are treated as "after": refuse rather than guess.
function laterThan(entry, since) {
  const times = TS_KEYS.map((k) => ms(entry?.[k])).filter((t) => t != null);
  if (times.length === 0) return true;
  return Math.max(...times) >= since;
}

export function holdRestoreFindings({ workflow, loop }) {
  const blocking = [];
  const history = Array.isArray(loop?.history) ? loop.history : [];
  const last = history[history.length - 1];
  const resolved = resolveStopCause({ loop });
  if (resolved.source !== STOP_SOURCES.AMBIGUOUS || !last) {
    return { eligible: false, blocking: ['the record is not an ambiguous "stopped, then re-entered review without an outcome" shape'], last: null };
  }
  const since = ms(last.at);
  if (since == null) blocking.push('the transition has no readable time, so later activity cannot be ruled out');
  if (loop.designTwoStage?.inFlight) blocking.push('a Design review call is recorded as in flight');
  if (last.round !== loop.round) blocking.push('the round counter moved after the transition');
  if (loop.lastReview != null && (since == null || laterThan(loop.lastReview, since))) blocking.push('a review record exists at or after the transition');
  const reservations = workflow?.modelSpendReservations && typeof workflow.modelSpendReservations === 'object'
    ? Object.values(workflow.modelSpendReservations) : [];
  if (since != null && reservations.some((rv) => laterThan(rv, since))) blocking.push('a model spend reservation was made after the transition');
  const records = Array.isArray(workflow?.reviewLoopSpend?.records) ? workflow.reviewLoopSpend.records : [];
  if (since != null && records.some((rec) => laterThan(rec, since))) blocking.push('a model spend record exists after the transition');
  // The stop being restored must itself be a stop this tool can name.
  const prior = history.slice(0, -1);
  if (!prior.some((h) => h?.to === 'HUMAN_REQUIRED')) blocking.push('there is no earlier HUMAN_REQUIRED stop to restore');
  return { eligible: blocking.length === 0, blocking, last };
}

export async function restoreHold({ persistence, loopId, reason, now = () => new Date() }) {
  if (!loopId || !String(reason ?? '').trim()) throw new Error('restore-hold requires a loopId and a reason');
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing can be safely written to it`);
  const { workflow, loop } = read;
  const found = holdRestoreFindings({ workflow, loop });
  if (!found.eligible) {
    throw new Error(`restore-hold refused: ${found.blocking.join('; ')}. Nothing was written`);
  }
  const history = loop.history;
  const originalIdx = (() => {
    for (let i = history.length - 2; i >= 0; i -= 1) if (history[i]?.to === 'HUMAN_REQUIRED') return i;
    return -1;
  })();
  const original = history[originalIdx];
  const before = fingerprint(workflow);
  const at = now().toISOString();
  await commitGuardedUpdate({
    persistence,
    loopId,
    before,
    action: 'restoring the hard stop',
    buildPatch: () => {
      recordTransition(
        loop,
        REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        'hard stop restored by the user (the earlier stop was re-entered without any review outcome)',
        buildStopCause({ kind: STOP_KINDS.HOLD_RESTORED, code: 'HOLD_RESTORED', restoredFrom: original.at }),
      );
      loop.humanRestores = [...(Array.isArray(loop.humanRestores) ? loop.humanRestores : []), {
        at, reason: String(reason).slice(0, 300), restoredFrom: original.at,
      }];
      return { [STATE_KEY]: loop };
    },
  });
  return { loopId, restoredFrom: original.at, at };
}
