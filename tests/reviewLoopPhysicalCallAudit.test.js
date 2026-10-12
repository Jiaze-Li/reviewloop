// P2 — the physicalCalls audit trail must be crash/resume durable. Every
// physical Reviewer/Supervisor attempt already settles its full accounting
// record durably BEFORE meteredCall() returns (reviewSpend.js); this
// reconstructs the durable physical-call record from existing spend logs,
// even when an earlier process has already reviewed a diff chunk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { reconstructPhysicalCalls } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function bigDiff() {
  const file = (n) => [
    `diff --git a/file${n}.js b/file${n}.js`,
    `--- a/file${n}.js`,
    `+++ b/file${n}.js`,
    '@@ -1,1 +1,20 @@',
    ...Array.from({ length: 18 }, (_, i) => `+  const v${n}_${i} = ${i} + ${n}; // padding to force this file over the chunk size limit`),
  ].join('\n');
  return [file(0), file(1)].join('\n');
}

test('chunk 0 dispatched pre-crash -> resume never re-dispatches it, and its physical-call identity remains durable', async () => {
  const persistence = new MemoryPersistence();
  let failChunk1 = true;
  const callsByChunk = {};

  function build() {
    return createReviewLoopController({
      persistence,
      env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '700', REVIEWLOOP_MAX_REVIEW_CHUNKS: '12' },
      captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['file0.js', 'file1.js'], fingerprint: 'DELTA_FP', diff: bigDiff(),
      }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
      discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
      reviewerFn: async ({ chunk }) => {
        callsByChunk[chunk.index] = (callsByChunk[chunk.index] ?? 0) + 1;
        if (chunk.index === 1 && failChunk1) {
          throw Object.assign(new Error('provider blip'), { code: 'PROVIDER_UNAVAILABLE' });
        }
        return {
          value: { findings: [] },
          usage: { input_tokens: 12, output_tokens: 3 },
          model: `model-for-chunk-${chunk.index}`,
        };
      },
    });
  }

  const { loopId } = await build().begin({ goal: 'g', cwd: '/r' });
  const r1 = await build().review({ loopId });
  assert.equal(r1.status, 'HUMAN_REQUIRED', 'chunk 1 could not be reviewed this round -> fail closed');
  assert.equal(callsByChunk[0], 1);

  // "restart": brand-new controller instance over the same durable store —
  // the in-memory physicalCalls array a fresh runReviewerOverEvidence call
  // builds starts EMPTY; chunk 0's attempt lives only in the durable spend
  // log now.
  failChunk1 = false;
  const beforeResume = { ...callsByChunk };
  const r2 = await build().review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(callsByChunk[0], beforeResume[0], 'chunk 0 was NOT re-dispatched to the provider on resume');
  assert.equal(callsByChunk[1], (beforeResume[1] ?? 0) + 1, 'only chunk 1 was (re-)dispatched on resume');
});

test('the round\'s physicalCalls (visible via the durable spend log reconstruction) include chunk 0 with full identity after a crash/resume', async () => {
  const persistence = new MemoryPersistence();
  let failChunk1 = true;

  function build() {
    return createReviewLoopController({
      persistence,
      env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '700', REVIEWLOOP_MAX_REVIEW_CHUNKS: '12' },
      captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['file0.js', 'file1.js'], fingerprint: 'DELTA_FP', diff: bigDiff(),
      }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
      discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
      reviewerFn: async ({ chunk }) => {
        if (chunk.index === 1 && failChunk1) {
          throw Object.assign(new Error('provider blip'), { code: 'PROVIDER_UNAVAILABLE' });
        }
        return {
          value: { findings: [] },
          usage: { input_tokens: 12, output_tokens: 3 },
          model: `model-for-chunk-${chunk.index}`,
        };
      },
    });
  }

  const { loopId } = await build().begin({ goal: 'g', cwd: '/r' });
  await build().review({ loopId }); // chunk 0 dispatched + settled; chunk 1 fails -> HUMAN_REQUIRED
  failChunk1 = false;
  await build().review({ loopId }); // "crash/resume": chunk 0 served from checkpoint, chunk 1 re-tried

  // Both rounds are logically the SAME round (a Gate-level HUMAN_REQUIRED from
  // a transient provider blip is not budget-exhausted / not a fresh round);
  // reconstructing directly from the durable spend log proves chunk 0's
  // physical attempt survived across the "restart" with its full identity.
  const chunk0Calls = await reconstructPhysicalCalls({
    persistence, loopId, role: 'reviewer', round: 1, chunkIndex: 0,
  });
  assert.equal(chunk0Calls.length, 1);
  const [pc] = chunk0Calls;
  assert.equal(pc.role, 'reviewer');
  assert.equal(pc.family, 'agy:gpt-oss');
  assert.equal(pc.provider, 'agy');
  assert.equal(pc.resolvedModel, 'model-for-chunk-0');
  assert.equal(pc.attempt, 1);
  assert.equal(pc.round, 1);
  assert.equal(pc.chunkIndex, 0);
  assert.equal(typeof pc.chunkTotal, 'number');
  assert.equal(pc.outcome, 'SUCCESS');
  assert.deepEqual(pc.usage, { input_tokens: 12, output_tokens: 3 });
  assert.ok('quotaPools' in pc);
});

test('a failed attempt followed by a succeeding failover attempt both survive in the durable reconstruction', async () => {
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'DELTA_FP', diff: 'diff --git a/a.js b/a.js\n+x\n',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    routeReviewerFn: ({ reworkCycles }) => (reworkCycles === 0
      ? { family: 'agy:opus', provider: 'agy', model: 'm1' }
      : { family: 'agy:sonnet', provider: 'agy', model: 'm2' }),
    reviewerFn: async ({ selection }) => {
      if (selection?.family === 'agy:opus') {
        throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      }
      return { value: { findings: [] }, usage: { input_tokens: 2, output_tokens: 1 }, model: selection?.model };
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');

  const calls = await reconstructPhysicalCalls({ persistence, loopId, role: 'reviewer', round: 1, chunkIndex: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].family, 'agy:opus');
  assert.equal(calls[0].outcome, 'FAILURE');
  assert.equal(calls[0].code, 'PROVIDER_UNAVAILABLE');
  assert.equal(calls[1].family, 'agy:sonnet');
  assert.equal(calls[1].outcome, 'SUCCESS');
  assert.deepEqual(calls[1].usage, { input_tokens: 2, output_tokens: 1 });
});

test('a genuine authorization-before-dispatch denial never fabricates a physical call', async () => {
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({
    persistence,
    env: { REVIEWLOOP_MAX_REVIEWER_CALLS: '0' }, // deny at authorize(), before any dispatch
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'DELTA_FP', diff: 'diff --git a/a.js b/a.js\n+x\n',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => {
      throw new Error('must never be called — denied before dispatch');
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  const calls = await reconstructPhysicalCalls({ persistence, loopId, role: 'reviewer', round: 1, chunkIndex: 0 });
  assert.equal(calls.length, 0, 'a pre-dispatch authorization denial must not appear as a physical call');
});
