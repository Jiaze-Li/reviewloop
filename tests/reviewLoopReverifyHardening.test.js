// Independent re-verification — remaining P1/P2 items:
//   #5  a chunk checkpoint resume must not add a fresh review round
//   #6  a provider/spend failure returning HUMAN_REQUIRED must latch the
//       durable loop state to HUMAN_REQUIRED (returned status == persisted)
//   #2  the cross-process BUSY path is strictly read-only — it must not
//       reconcile / rewrite an in-flight RESERVED / DISPATCHING reservation

import { releaseHardStop } from './helpers/humanRelease.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { acquireLoopFileLease } from '../src/reviewloop/loopLease.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function bigDiff() {
  const file = (n) => [
    `diff --git a/file${n}.js b/file${n}.js`, `--- a/file${n}.js`, `+++ b/file${n}.js`, '@@ -1,1 +1,20 @@',
    ...Array.from({ length: 18 }, (_, i) => `+  const v${n}_${i} = ${i} + ${n}; // padding to force this file over the chunk size limit`),
  ].join('\n');
  return [file(0), file(1), file(2)].join('\n');
}

test('#5 a chunk checkpoint resume does NOT consume another review round', async () => {
  const persistence = new MemoryPersistence();
  let failChunk2 = true;
  const build = () => createReviewLoopController({
    persistence,
    env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '700', REVIEWLOOP_MAX_REVIEW_CHUNKS: '12' },
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['file0.js', 'file1.js', 'file2.js'], fingerprint: 'DELTA_FP', diff: bigDiff(),
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async ({ chunk }) => {
      if (chunk.index === 2 && failChunk2) throw Object.assign(new Error('blip'), { code: 'PROVIDER_UNAVAILABLE' });
      return { value: { findings: [] }, usage: { input_tokens: 2, output_tokens: 1 } };
    },
  });

  const { loopId } = await build().begin({ goal: 'g', cwd: '/r' });
  await build().review({ loopId }); // crashes mid-round (chunk 2)
  const afterCrash = (await persistence.readWorkflowState(loopId)).reviewLoop.round;

  // Two more human-authorized resumes while chunk 2 still fails — the round must not move.
  await releaseHardStop({ controller: build(), persistence, loopId });
  await build().review({ loopId });
  await releaseHardStop({ controller: build(), persistence, loopId });
  await build().review({ loopId });
  const afterResumes = (await persistence.readWorkflowState(loopId)).reviewLoop.round;
  assert.equal(afterResumes, afterCrash, 'repeated resume of the same chunk checkpoint keeps the round fixed');

  // Now let chunk 2 succeed: the SAME round completes, still round 1.
  failChunk2 = false;
  await releaseHardStop({ controller: build(), persistence, loopId });
  const done = await build().review({ loopId });
  assert.equal(done.status, 'PASS');
  assert.equal(done.round, 1, 'the completed review is still round 1');
});

test('#6 a spend/provider failure that returns HUMAN_REQUIRED latches the durable state to HUMAN_REQUIRED', async () => {
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'FP', diff: 'diff a',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => { throw Object.assign(new Error('hard provider failure'), { code: 'PROVIDER_INTERNAL_ERROR' }); },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });

  assert.equal(r.status, 'HUMAN_REQUIRED');
  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'HUMAN_REQUIRED', 'persisted state matches the returned status');
});

test('#2 the cross-process BUSY path leaves an in-flight reservation byte-for-byte unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-busy-ro-'));
  try {
    const persistence = new Persistence(root);
    const controller = createReviewLoopController({
      persistence, runtimeRoot: root,
      captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({ baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FP', diff: 'd' }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
      discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
      reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

    // Simulate an in-flight peer: it holds the lease and has an open
    // DISPATCHING reservation in the shared workflow state.
    const foreign = await acquireLoopFileLease({ runtimeRoot: root, loopId });
    assert.equal(foreign.ok, true);
    await persistence.updateWorkflowState(loopId, {
      modelSpendReservations: {
        R1: {
          reservationId: 'R1', workflowId: loopId, taskId: `${loopId}:round-1:chunk-0`, role: 'reviewer',
          family: 'agy:gpt-oss', provider: 'agy', physicalAttempt: 1, status: 'DISPATCHING',
          createdAt: 't0', dispatchStartedAt: 't1', settledAt: null, settlementReason: null,
          usageCallId: null, usageReference: null,
        },
      },
    });
    const before = JSON.stringify((await persistence.readWorkflowState(loopId)).modelSpendReservations);

    const busy = await controller.review({ loopId });
    assert.equal(busy.status, 'WAITING_FOR_REVIEW');

    const after = JSON.stringify((await persistence.readWorkflowState(loopId)).modelSpendReservations);
    assert.equal(after, before, 'the BUSY query did not reconcile / rewrite the in-flight reservation');

    await foreign.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
