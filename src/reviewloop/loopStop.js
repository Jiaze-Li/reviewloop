// Human end of a task: the "terminate" path every HUMAN_REQUIRED report offers.
//
// Moves one loop to STOPPED (a state the machine already has and every reader
// already treats as finished), keeps every record, and writes ONE durable
// entry saying who ended it and why. From then on the controller returns the
// finished result without running a Gate or calling a model, and STOPPED is
// never read as PASS. It does not touch the spend ledger, the Token Sentinel
// latch or its acknowledgements, budget overrides, the call allowance,
// evidence, the frozen contract, baseline or phases.

import { REVIEW_LOOP_STATES, recordTransition } from './state.js';
import { assertUnchanged, fingerprint, readLoopWorkflow } from './humanActionGuard.js';

export async function stopLoop({ persistence, loopId, reason, now = () => new Date() }) {
  if (!loopId) throw new Error('stop-loop requires a loopId');
  if (!String(reason ?? '').trim()) throw new Error('stop-loop requires an explicit reason');
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}`);
  if (read.status === 'UNREADABLE') {
    throw new Error(`the state record of ${loopId} cannot be read (${read.errorClass}); nothing can be safely written to it. Run \`reviewloop report --loop ${loopId}\` for the steps that keep the evidence`);
  }
  const { workflow, loop } = read;
  if (loop.objective?.mode === 'PR') throw new Error('ReviewLoop PR session retired; cannot stop it here; use claude-review-bot');
  if (loop.state === REVIEW_LOOP_STATES.STOPPED) {
    return { loopId, alreadyStopped: true, stoppedAt: loop.humanStop?.at ?? null, priorState: loop.humanStop?.priorState ?? null };
  }
  if ([REVIEW_LOOP_STATES.PASS, REVIEW_LOOP_STATES.FAILED].includes(loop.state)) {
    throw new Error(`loop is already ${loop.state}; a finished loop is kept as it is`);
  }
  const before = fingerprint(workflow);
  await assertUnchanged({ persistence, loopId, before, action: 'stopping the loop' });
  const at = now().toISOString();
  const priorState = loop.state;
  const text = String(reason).trim();
  // HUMAN_REQUIRED only leads back to REVIEWING, so a stop from there passes
  // through it; the hop is bookkeeping, not a review (humanStop is authoritative).
  if (priorState === REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
    recordTransition(loop, REVIEW_LOOP_STATES.REVIEWING, `human stop (bookkeeping hop, no review): ${text}`);
  }
  recordTransition(loop, REVIEW_LOOP_STATES.STOPPED, `human stop: ${text}`);
  loop.humanStop = { at, reason: text, priorState, round: loop.round ?? 0, budgetExhausted: loop.budgetExhausted === true };
  await persistence.updateWorkflowState(loopId, { reviewLoop: loop });
  return { loopId, alreadyStopped: false, priorState, stoppedAt: at, round: loop.round ?? 0 };
}
