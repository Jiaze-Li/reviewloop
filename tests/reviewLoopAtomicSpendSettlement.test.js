import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

async function call({ persistence, loopId, operation = 'review-one', usage = { input_tokens: 120, output_tokens: 8 },
  costUsd = 0.25, failed = false } = {}) {
  const spend = createReviewLoopSpend({
    loopId, persistence,
    env: { REVIEWLOOP_MAX_USAGE_VOLUME: '9999999', REVIEWLOOP_MAX_COST_USD: '999' },
  });
  const e = await spend.registerEvidence({ kind: 'reviewstate', taskId: operation, diffHash: operation });
  return spend.meteredCall({
    role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy',
    model: 'provider-model', operationId: operation, attempt: 1,
    evidenceIds: [e.evidenceId],
    auditContext: { round: 9, chunkIndex: 1, chunkTotal: 4 },
    call: async () => {
      if (failed) {
        const err = new Error('Provider protocol error with known usage');
        err.code = 'PROVIDER_PROTOCOL_ERROR';
        err.details = { usage, costUsd };
        throw err;
      }
      return { value: { findings: [] }, usage, costUsd, model: 'actual-model' };
    },
  });
}

test('known successful physical call persists reservation + exact spend in ONE state snapshot', async () => {
  const p = new MemoryPersistence();
  const snapshots = [];
  const orig = p.writeWorkflowState.bind(p);
  p.writeWorkflowState = async (id, state) => {
    snapshots.push(structuredClone(state));
    return orig(id, state);
  };
  const loopId = 'rl-p0-atomic-success';
  const result = await call({ persistence: p, loopId });
  assert.deepEqual(result, { findings: [] });

  const s = await p.readWorkflowState(loopId);
  const reservations = Object.values(s.modelSpendReservations);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'SETTLED_KNOWN');
  assert.equal(s.reviewLoopSpend.records.length, 1);
  const rec = s.reviewLoopSpend.records[0];
  assert.equal(rec.reservationId, reservations[0].reservationId);
  assert.equal(rec.usageVolume, 128);
  assert.equal(rec.model, 'actual-model');
  assert.equal(rec.round, 9);
  assert.equal(rec.chunkIndex, 1);
  assert.equal(rec.costUsd, 0.25);
  // This is the key invariant: the FIRST snapshot with SETTLED_KNOWN has
  // its spend record already. No durable half-commit is ever observable.
  for (const snapshot of snapshots) {
    const statuses = Object.values(snapshot.modelSpendReservations ?? {}).map(r => r.status);
    if (statuses.includes('SETTLED_KNOWN')) {
      assert.equal(snapshot.reviewLoopSpend?.records?.length, 1,
        'the reservation status and its accounting must be committed together');
    }
  }
  const restarted = createReviewLoopSpend({ loopId, persistence: p });
  assert.equal((await restarted.currentTotals()).unaccountedSpendCalls, 0);
  assert.equal((await restarted.currentTotals()).usageVolume, 128);
});

test('known-use provider failure still commits its physical spend exactly once', async () => {
  const p = new MemoryPersistence(), loopId = 'rl-p0-atomic-failure';
  await assert.rejects(() => call({ persistence: p, loopId, failed: true }), /Provider protocol error/);
  const s = await p.readWorkflowState(loopId);
  const r = Object.values(s.modelSpendReservations)[0];
  assert.equal(r.status, 'SETTLED_KNOWN');
  assert.equal(s.reviewLoopSpend.records.length, 1);
  assert.equal(s.reviewLoopSpend.records[0].businessOutcome, 'FAILURE');
  assert.equal(s.reviewLoopSpend.records[0].costUsd, 0.25);
  assert.equal((await createReviewLoopSpend({ loopId, persistence: p }).currentTotals()).usageVolume, 128);
});

test('settlement storage rejection cannot leak a settled reservation or authorize another call', async () => {
  const p = new MemoryPersistence(), loopId = 'rl-p0-atomic-fault';
  const original = p.writeWorkflowState.bind(p);
  let rejected = false;
  p.writeWorkflowState = async (id, state) => {
    if (!rejected && state?.reviewLoopSpend?.records?.length) {
      rejected = true;
      throw new Error('injected atomic commit failure');
    }
    return original(id, state);
  };
  await assert.rejects(
    () => call({ persistence: p, loopId }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_SETTLEMENT_PERSIST_FAILED,
  );
  const stored = await p.readWorkflowState(loopId);
  const reservation = Object.values(stored.modelSpendReservations)[0];
  assert.equal(reservation.status, 'DISPATCHING');
  assert.equal(stored.reviewLoopSpend?.records?.length ?? 0, 0);
  // Restart must treat the ambiguous dispatched call as unknown, not retry.
  const spend = createReviewLoopSpend({ loopId, persistence: p });
  const totals = await spend.currentTotals();
  assert.equal(totals.unaccountedSpendCalls, 0,
    'DISPATCHING is a direct blocker, not a settled-orphan category');
  await assert.rejects(() => call({ persistence: p, loopId, operation: 'unrelated-new-work' }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED);
  const final = await p.readWorkflowState(loopId);
  assert.equal(Object.values(final.modelSpendReservations)[0].status, 'UNRESOLVED');
});

test('Token Sentinel anomaly is persisted in same snapshot as known spend and reservation', async () => {
  const p = new MemoryPersistence(), loopId = 'rl-p0-atomic-sentinel';
  const snapshots = [];
  const orig = p.writeWorkflowState.bind(p);
  p.writeWorkflowState = async (id, state) => {
    snapshots.push(structuredClone(state));
    return orig(id, state);
  };
  await assert.rejects(
    () => call({ persistence: p, loopId, usage: { input_tokens: 40010, output_tokens: 1 } }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED,
  );
  const s = await p.readWorkflowState(loopId);
  assert.equal(Object.values(s.modelSpendReservations)[0].status, 'SETTLED_KNOWN');
  assert.equal(s.reviewLoopSpend.records[0].usageVolume, 40011);
  assert.equal(s.reviewLoopTokenAnomaly.tripped, true);
  for (const snapshot of snapshots) {
    if (Object.values(snapshot.modelSpendReservations ?? {}).some(r => r.status === 'SETTLED_KNOWN')) {
      assert.equal(snapshot.reviewLoopSpend.records.length, 1);
      assert.equal(snapshot.reviewLoopTokenAnomaly.tripped, true);
    }
  }
  await assert.rejects(() => call({ persistence: p, loopId, operation: 'later' }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED);
});

test('post-dispatch UNKNOWN usage retains UNRESOLVED, never manufactures a known spend', async () => {
  const p = new MemoryPersistence(), loopId = 'rl-p0-atomic-unknown';
  await assert.rejects(() => call({ persistence: p, loopId, usage: null }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED);
  const s = await p.readWorkflowState(loopId);
  assert.equal(Object.values(s.modelSpendReservations)[0].status, 'UNRESOLVED');
  assert.equal(s.reviewLoopSpend?.records?.length ?? 0, 0);
});
