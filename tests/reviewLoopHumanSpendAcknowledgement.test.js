import test from 'node:test';
import assert from 'node:assert/strict';

import { acknowledgeUnresolvedSpend } from '../src/reviewloop/spendRecovery.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function seedUnresolved({
  loopId = 'L-human-ack',
  reservationId = 'R-unresolved',
  evidenceId = 'E-reviewstate',
  operationId = 'L-human-ack:round-1:chunk-0',
  budgetExhausted = false,
} = {}) {
  const reservation = {
    reservationId,
    workflowId: loopId,
    taskId: operationId,
    role: 'reviewer',
    family: 'agy:opus',
    provider: 'agy-claude-gpt',
    physicalAttempt: 1,
    status: 'UNRESOLVED',
    createdAt: '2026-10-01T00:00:00.000Z',
    dispatchStartedAt: '2026-10-01T00:00:01.000Z',
    settledAt: '2026-10-01T00:00:02.000Z',
    settlementReason: 'AGY_NONZERO_EXIT',
    usageCallId: null,
    usageReference: null,
  };
  return {
    reviewLoop: {
      loopId,
      state: 'HUMAN_REQUIRED',
      budgetExhausted,
      round: 1,
      reviewerCalls: 0,
      supervisorCalls: 0,
    },
    modelSpendReservations: { [reservationId]: reservation },
    modelSpendInformation: {
      events: {
        [evidenceId]: {
          evidenceId,
          type: 'CHANGED_TASK_DIFF',
          workflowId: loopId,
          subject: operationId,
          fingerprint: 'D::G',
          source: 'worker',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      },
      consumptions: {
        ['reviewer::' + operationId + '::' + evidenceId]: {
          evidenceId,
          role: 'reviewer',
          operationId,
          consumedAt: '2026-10-01T00:00:00.500Z',
        },
      },
    },
    reviewLoopSpend: { records: [] },
  };
}

test('human acknowledgement preserves UNRESOLVED and records UNKNOWN spend plus one retry grant', async () => {
  const persistence = new MemoryPersistence();
  const state = seedUnresolved();
  await persistence.writeWorkflowState('L-human-ack', state);

  const result = await acknowledgeUnresolvedSpend({
    persistence,
    loopId: 'L-human-ack',
    reservationId: 'R-unresolved',
    reason: 'Human accepts unrecoverable usage and authorizes one retry',
    now: () => '2026-10-02T00:00:00.000Z',
  });

  assert.equal(result.retryAvailable, true);
  const next = await persistence.readWorkflowState('L-human-ack');
  const source = next.modelSpendReservations['R-unresolved'];
  assert.equal(source.status, 'UNRESOLVED', 'history must never be rewritten to SETTLED_KNOWN');
  assert.equal(source.humanAcknowledgement.accepted, true);
  assert.equal(source.humanAcknowledgement.accountingRecorded, true);
  assert.equal(source.humanAcknowledgement.evidenceId, 'E-reviewstate');
  assert.equal(source.humanAcknowledgement.retryGrant.consumedAt, null);

  const records = next.reviewLoopSpend.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].reservationId, 'R-unresolved');
  assert.equal(records[0].usageKnown, false);
  assert.equal(records[0].costKnown, false);
  assert.equal(records[0].usageVolume, 0, 'zero is only the numeric lower bound, not known usage');
  assert.equal(records[0].humanAcknowledgedUnresolved, true);

  const spend = createReviewLoopSpend({ loopId: 'L-human-ack', persistence });
  const telemetry = await spend.telemetry();
  assert.equal(telemetry.reviewerCalls, 1);
  assert.equal(telemetry.unknownUsageCalls, 1);
  assert.equal(telemetry.unknownCostCalls, 1);
});

test('acknowledgement authorizes exactly one same-operation/evidence retry without pretending the old call was zero', async () => {
  const persistence = new MemoryPersistence();
  await persistence.writeWorkflowState('L-human-ack', seedUnresolved());
  await acknowledgeUnresolvedSpend({
    persistence,
    loopId: 'L-human-ack',
    reservationId: 'R-unresolved',
    reason: 'accept unknown spend',
  });

  const spend = createReviewLoopSpend({ loopId: 'L-human-ack', persistence });
  const out = await spend.meteredCall({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'L-human-ack:round-1:chunk-0',
    attempt: 2,
    evidenceIds: ['E-reviewstate'],
    call: async () => ({
      value: { findings: [] },
      usage: { input_tokens: 4, output_tokens: 2 },
      model: 'codex-test',
    }),
  });
  assert.deepEqual(out, { findings: [] });

  const after = await persistence.readWorkflowState('L-human-ack');
  const source = after.modelSpendReservations['R-unresolved'];
  assert.ok(source.humanAcknowledgement.retryGrant.consumedAt);
  const retryId = source.humanAcknowledgement.retryGrant.consumedByReservationId;
  assert.ok(retryId);
  assert.equal(after.modelSpendReservations[retryId].status, 'SETTLED_KNOWN');
  assert.equal(after.modelSpendReservations[retryId].humanRetrySourceReservationId, 'R-unresolved');

  let dispatched = 0;
  let denied = null;
  await spend.meteredCall({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'L-human-ack:round-1:chunk-0',
    attempt: 3,
    evidenceIds: ['E-reviewstate'],
    call: async () => {
      dispatched += 1;
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  }).catch((e) => { denied = e; });
  assert.ok(denied);
  assert.equal(dispatched, 0, 'the human grant is one-shot');
  assert.equal(denied.code, 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED');
});

test('unacknowledged UNRESOLVED reservation still blocks every new model call', async () => {
  const persistence = new MemoryPersistence();
  await persistence.writeWorkflowState('L-human-ack', seedUnresolved());
  const spend = createReviewLoopSpend({ loopId: 'L-human-ack', persistence });

  let dispatched = 0;
  let denied = null;
  await spend.meteredCall({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'L-human-ack:round-1:chunk-0',
    attempt: 2,
    evidenceIds: ['E-reviewstate'],
    call: async () => {
      dispatched += 1;
      return { value: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  }).catch((e) => { denied = e; });
  assert.equal(dispatched, 0);
  assert.equal(denied?.code, 'MODEL_SPEND_USAGE_UNRESOLVED');
});

test('acknowledge-spend is idempotent and refuses to reopen a convergence-budget-exhausted loop', async () => {
  const persistence = new MemoryPersistence();
  await persistence.writeWorkflowState('L-human-ack', seedUnresolved());
  const first = await acknowledgeUnresolvedSpend({
    persistence, loopId: 'L-human-ack', reservationId: 'R-unresolved', reason: 'accept unknown',
  });
  const second = await acknowledgeUnresolvedSpend({
    persistence, loopId: 'L-human-ack', reservationId: 'R-unresolved', reason: 'different text is ignored',
  });
  assert.equal(second.alreadyAcknowledged, true);
  assert.equal(second.acknowledgementId, first.acknowledgementId);
  const state = await persistence.readWorkflowState('L-human-ack');
  assert.equal(state.reviewLoopSpend.records.length, 1);

  const blocked = new MemoryPersistence();
  await blocked.writeWorkflowState('L-human-ack', seedUnresolved({ budgetExhausted: true }));
  await assert.rejects(
    () => acknowledgeUnresolvedSpend({
      persistence: blocked, loopId: 'L-human-ack', reservationId: 'R-unresolved', reason: 'try reopen',
    }),
    /exhausted its convergence budget/,
  );
});

test('crash-before-dispatch reservation cancellation releases the one-shot grant for a safe retry', async () => {
  const persistence = new MemoryPersistence();
  await persistence.writeWorkflowState('L-human-ack', seedUnresolved());
  await acknowledgeUnresolvedSpend({
    persistence, loopId: 'L-human-ack', reservationId: 'R-unresolved', reason: 'accept unknown',
  });

  const spend1 = createReviewLoopSpend({ loopId: 'L-human-ack', persistence });
  const authority = spend1.authority;
  const permit = await authority.authorize({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'L-human-ack:round-1:chunk-0',
    attempt: 2,
    workflowId: 'L-human-ack',
    evidenceIds: ['E-reviewstate'],
  });
  const retryReservationId = authority.reservationIdFor(permit);
  assert.ok(retryReservationId);

  // Simulate process crash after permit issuance but before dispatch().
  const spend2 = createReviewLoopSpend({ loopId: 'L-human-ack', persistence });
  await spend2.reservationLedger.reconcileOnResume('L-human-ack');
  const reconciled = await persistence.readWorkflowState('L-human-ack');
  assert.equal(reconciled.modelSpendReservations[retryReservationId].status, 'CANCELLED_PRE_DISPATCH');
  assert.equal(
    reconciled.modelSpendReservations['R-unresolved'].humanAcknowledgement.retryGrant.reservedForReservationId,
    null,
  );

  // The same acknowledged unknown spend may now allocate its still-unused
  // physical retry again because the prior retry was mechanically never sent.
  const permit2 = await spend2.authority.authorize({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'L-human-ack:round-1:chunk-0',
    attempt: 3,
    workflowId: 'L-human-ack',
    evidenceIds: ['E-reviewstate'],
  });
  assert.ok(spend2.authority.reservationIdFor(permit2));
});
