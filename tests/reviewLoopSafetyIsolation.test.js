// Phase 1 — one long-lived controller (one MCP process, many loopIds):
//   * a safety event raised while reviewing loop A must not appear in loop B's
//     result (per-invocation / per-loop isolation);
//   * telemetry on NO_PROGRESS / WAITING preserves cumulative durable spend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  MemoryPersistence, makeHarness, finding,
} from './helpers/reviewLoopHarness.js';

test('a safety event from loop A does not leak into loop B on the same controller', async () => {
  const persistence = new MemoryPersistence();
  let d = 0;
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      d += 1;
      return { baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: `fp${d}`, diff: `d${d}` };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: `g${d}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });

  const a = await controller.begin({ goal: 'a', cwd: '/a' });
  // Seed loop A with a crash-abandoned DISPATCHING reservation -> reconcile on
  // resume raises a BLOCKING safety event and blocks the review.
  await persistence.updateWorkflowState(a.loopId, {
    modelSpendReservations: {
      r1: { reservationId: 'r1', workflowId: a.loopId, role: 'reviewer', status: 'DISPATCHING', taskId: 't', physicalAttempt: 1, createdAt: 't0', dispatchStartedAt: 't0' },
    },
  });
  const rA = await controller.review({ loopId: a.loopId });
  assert.equal(rA.status, 'HUMAN_REQUIRED');
  assert.ok(rA.safetyEvents.some((e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED'), 'loop A surfaces its own safety event');

  const b = await controller.begin({ goal: 'b', cwd: '/b' });
  const rB = await controller.review({ loopId: b.loopId });
  assert.equal(rB.status, 'PASS');
  assert.deepEqual(rB.safetyEvents, [], 'loop B result carries none of loop A\'s safety events');
});

test('NO_PROGRESS after a spending round still reports cumulative durable spend', async () => {
  const { controller } = makeHarness({
    deltas: [{ fingerprint: 'SAME', diff: 'x', changedFiles: ['a.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'G' }],
    reviews: [{ findings: [finding('P3')] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'PASS');
  assert.equal(r1.telemetry.reviewerCalls, 1);

  // Identical delta + gate on the next call -> NO_PROGRESS, zero new calls, but
  // the telemetry must still show the earlier round's durable spend.
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS'); // already terminal -> terminalResult
  assert.equal(r2.telemetry.reviewerCalls, 1, 'cumulative spend is not reset to zero on a terminal / no-progress re-call');
  assert.equal(r2.telemetry.workerUsage, 'external / not observable by ReviewLoop');
});
