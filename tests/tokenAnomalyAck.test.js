// Human acknowledgement of a tripped Token Sentinel latch (Design d1 §4.3).
// Zero provider calls; every metered call is a fake function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import {
  acknowledgeTokenAnomaly,
  ackIdForRecord,
  MAX_TOKEN_ANOMALY_ACKS,
} from '../src/reviewloop/tokenAnomalyAck.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

let seq = 0;
async function meter(spend, usage, { onCall = null } = {}) {
  const op = `op-${++seq}`;
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: op, diffHash: `${op}::G` });
  return spend.meteredCall({
    role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: op, attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { if (onCall) onCall(); return { value: { findings: [] }, usage, model: 'm' }; },
  });
}
const BIG = { input_tokens: 40001, output_tokens: 0 };
const SMALL = { input_tokens: 10, output_tokens: 5 };

async function trippedLoop({ state = 'HUMAN_REQUIRED', extra = {} } = {}) {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('L', {
    reviewLoop: { loopId: 'L', state, round: 2, objective: { mode: 'LOCAL', taskType: 'code' }, ...extra },
  });
  const spend = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await meter(spend, SMALL);
  await assert.rejects(() => meter(spend, BIG), (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED');
  const wf = await persistence.readWorkflowState('L');
  return { persistence, latchAt: wf.reviewLoopTokenAnomaly.at };
}
const ack = (persistence, latchAt, over = {}) =>
  acknowledgeTokenAnomaly({ persistence, loopId: 'L', latchAt, reason: 'reviewed the report', ...over });

test('acknowledge unblocks the same loop; a restart does not re-latch the acknowledged record (AC05)', async () => {
  const { persistence, latchAt } = await trippedLoop();
  const before = await persistence.readWorkflowState('L');
  const res = await ack(persistence, latchAt);
  assert.equal(res.acknowledgements, 1);
  const after = await persistence.readWorkflowState('L');

  // I1: nothing but the latch flag and the audit list changes.
  for (const k of ['reviewLoop', 'reviewLoopSpend', 'modelSpendReservations']) {
    assert.deepEqual(after[k], before[k], `${k} untouched`);
  }
  assert.equal(after.reviewLoopTokenAnomaly.tripped, false);
  assert.equal(after.reviewLoopTokenAnomaly.usageVolume, before.reviewLoopTokenAnomaly.usageVolume);
  assert.equal(after.reviewLoopTokenAnomaly.at, before.reviewLoopTokenAnomaly.at);
  assert.equal(after.reviewLoopTokenAnomalyAcks.length, 1);
  assert.equal(after.reviewLoop.state, 'HUMAN_REQUIRED', 'no PASS/READY, no state change');

  // "restart": fresh spend objects; the old anomalous record must not re-latch.
  for (let i = 0; i < 2; i += 1) {
    const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
    let dispatched = false;
    await meter(s, SMALL, { onCall: () => { dispatched = true; } });
    assert.equal(dispatched, true);
    assert.equal((await s.telemetry()).tokenAnomalyBlocked, false);
  }
});

test('a NEW over-threshold call after acknowledgement latches again (I3)', async () => {
  const { persistence, latchAt } = await trippedLoop();
  await ack(persistence, latchAt);
  await new Promise((r) => setTimeout(r, 15)); // latch ids are ISO timestamps
  const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await assert.rejects(() => meter(s, BIG), (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED');
  const wf = await persistence.readWorkflowState('L');
  assert.equal(wf.reviewLoopTokenAnomaly.tripped, true);
  assert.notEqual(wf.reviewLoopTokenAnomaly.at, latchAt, 'a new latch event, not the old one');
  // and the second event needs its own acknowledgement bound to its own timestamp
  await assert.rejects(() => ack(persistence, latchAt), /does not match the current latch event/);
  await ack(persistence, wf.reviewLoopTokenAnomaly.at);
  assert.equal((await persistence.readWorkflowState('L')).reviewLoopTokenAnomalyAcks.length, 2);
});

test('refusals leave the workflow byte-identical (AC07)', async () => {
  const { persistence, latchAt } = await trippedLoop();
  const snapshot = JSON.stringify(await persistence.readWorkflowState('L'));
  const cases = [
    [{ latchAt: 'wrong' }, /does not match/],
    [{ latchAt: '' }, /requires --latch/],
    [{ reason: '   ' }, /explicit reason/],
    [{ loopId: 'nope' }, /unknown loopId/],
  ];
  for (const [over, re] of cases) {
    await assert.rejects(() => ack(persistence, latchAt, over), re);
    assert.equal(JSON.stringify(await persistence.readWorkflowState('L')), snapshot);
  }
});

test('second acknowledgement of the same event is refused — no double acknowledgement', async () => {
  const { persistence, latchAt } = await trippedLoop();
  await ack(persistence, latchAt);
  await assert.rejects(() => ack(persistence, latchAt), /no tripped Token Sentinel latch/);
  assert.equal((await persistence.readWorkflowState('L')).reviewLoopTokenAnomalyAcks.length, 1);
});

test('terminal / convergence-exhausted loops cannot be acknowledged', async () => {
  for (const [state, extra] of [['PASS', {}], ['FAILED', {}], ['STOPPED', {}], ['HUMAN_REQUIRED', { budgetExhausted: true }]]) {
    const { persistence, latchAt } = await trippedLoop({ state, extra });
    await assert.rejects(() => ack(persistence, latchAt), /can only be acknowledged on a loop that can still continue/);
  }
});

test('retired PR loop is refused', async () => {
  const { persistence, latchAt } = await trippedLoop();
  await persistence.updateWorkflowState('L', { reviewLoop: { loopId: 'L', state: 'HUMAN_REQUIRED', objective: { mode: 'PR' } } });
  await assert.rejects(() => ack(persistence, latchAt), /PR session retired/);
});

test(`at most ${MAX_TOKEN_ANOMALY_ACKS} acknowledgements per loop`, async () => {
  const { persistence, latchAt } = await trippedLoop();
  let at = latchAt;
  for (let i = 0; i < MAX_TOKEN_ANOMALY_ACKS; i += 1) {
    await ack(persistence, at);
    await new Promise((r) => setTimeout(r, 15));
    const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
    await assert.rejects(() => meter(s, BIG));
    at = (await persistence.readWorkflowState('L')).reviewLoopTokenAnomaly.at;
  }
  await assert.rejects(() => ack(persistence, at), /product decision/);
});

test('acknowledgement does not clear OTHER stops: unaccounted spend still blocks (I6, AC06)', async () => {
  const { persistence, latchAt } = await trippedLoop();
  // A settled metered reservation with no spend record = unaccounted spend.
  const wf = await persistence.readWorkflowState('L');
  await persistence.updateWorkflowState('L', {
    modelSpendReservations: {
      ...wf.modelSpendReservations,
      'orphan-1': { reservationId: 'orphan-1', status: 'SETTLED_KNOWN', role: 'reviewer', intent: { role: 'reviewer' } },
    },
  });
  await ack(persistence, latchAt);
  const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  let dispatched = false;
  await assert.rejects(
    () => meter(s, SMALL, { onCall: () => { dispatched = true; } }),
    (e) => e.code !== 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
});

test('persistence failure on the single write leaves the latch tripped (no partial ack)', async () => {
  const { persistence, latchAt } = await trippedLoop();
  const original = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async () => { throw new Error('disk full'); };
  await assert.rejects(() => ack(persistence, latchAt), /disk full/);
  persistence.updateWorkflowState = original;
  const wf = await persistence.readWorkflowState('L');
  assert.equal(wf.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(wf.reviewLoopTokenAnomalyAcks, undefined);
});

test('legacy spend records without reservationId are acknowledged by ordinal', async () => {
  const persistence = new MemoryPersistence();
  const rec = {
    role: 'reviewer', family: 'f', provider: 'p', model: 'm', usageKnown: true, usageVolume: 60000,
    usageAccounting: { volumeResolved: true, semanticsKnown: true }, contextOverheadTokens: 0,
    costUsd: 0, costKnown: false, businessOutcome: 'SUCCESS', at: new Date().toISOString(),
  };
  assert.equal(ackIdForRecord(rec, 0), 'ordinal:0');
  await persistence.updateWorkflowState('L', {
    reviewLoop: { loopId: 'L', state: 'HUMAN_REQUIRED', objective: { mode: 'LOCAL' } },
    reviewLoopSpend: { records: [rec] },
    reviewLoopTokenAnomaly: { tripped: true, at: 'T0', trigger: 'SINGLE_CALL_USAGE', threshold: 40000, usageVolume: 60000 },
  });
  await ack(persistence, 'T0');
  const wf = await persistence.readWorkflowState('L');
  assert.deepEqual(wf.reviewLoopTokenAnomalyAcks[0].acknowledgedSpendIds, ['ordinal:0']);
  const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await meter(s, SMALL); // would re-latch from the 60k legacy record if ordinal ack were ignored
  assert.equal((await s.telemetry()).tokenAnomalyBlocked, false);
});

test('an unreadable acknowledgement list fails closed (never "no acknowledgements")', async () => {
  const { persistence, latchAt } = await trippedLoop();
  await ack(persistence, latchAt);
  const original = persistence.readWorkflowState.bind(persistence);
  let reads = 0;
  persistence.readWorkflowState = async (id) => {
    const s = await original(id);
    reads += 1;
    if (s && reads > 0 && new Error().stack.includes('loadAcks')) throw new Error('read boom');
    return s;
  };
  const s = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await assert.rejects(() => meter(s, SMALL), (e) => /STATE_UNAVAILABLE|could not read the human acknowledgements/i.test(`${e.code} ${e.message}`));
});
