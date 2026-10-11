// Phase-scoped diffs: a LOCAL phase gate reviews only what changed since the
// previous PHASE_PASS; the final gate (and any untrusted boundary) stays
// cumulative from the begin baseline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const phases = ['p1', 'p2', 'p3'].map((id) => ({
  id, title: id, objective: `do ${id}`, exitCriteria: [`${id} done`],
}));

// Scripted world: records which baseline every delta collection used.
function scriptedWorld({ boundaries, emptyDeltaFor = new Set() }) {
  const persistence = new MemoryPersistence();
  const seen = [];
  let captures = 0;
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => {
      captures += 1;
      // begin captures twice (baseline, then re-capture after the baseline
      // Gate); every later capture is a phase boundary.
      const b = captures <= 2 ? { head: 'H0', baselineRef: 'ORIG' } : (boundaries[captures - 3] ?? boundaries[boundaries.length - 1]);
      return { dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true, ...b };
    },
    collectWorkerDeltaFn: async ({ baseline }) => {
      seen.push(baseline.baselineRef ?? baseline.head);
      const n = seen.length;
      return {
        baselineHead: baseline.head, currentHead: 'CUR', evidenceComplete: true,
        noWorkerChangeYet: emptyDeltaFor.has(n), fingerprint: `d${n}`, diff: `diff${n}`, changedFiles: ['a.js'],
      };
    },
    runGateFn: async () => ({ pass: true, verdict: 'PASS', fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo t'] }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
    supervisorFn: async () => ({ value: { guidance: 'x', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  return { controller, persistence, seen };
}

test('phase gates review since the previous PHASE_PASS; final gate is cumulative', async () => {
  const w = scriptedWorld({ boundaries: [{ head: 'H1', baselineRef: 'B1' }, { head: 'H2', baselineRef: 'B2' }] });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r', phases });

  const r1 = await w.controller.review({ loopId });
  assert.equal(r1.status, 'PHASE_PASS');
  assert.equal(r1.nextDiffScope, 'phase-delta');
  const r2 = await w.controller.review({ loopId });
  assert.equal(r2.status, 'PHASE_PASS');
  assert.equal(r2.nextDiffScope, 'phase-delta');
  const r3 = await w.controller.review({ loopId });
  assert.equal(r3.status, 'PHASE_PASS');
  assert.equal(r3.nextDiffScope, 'cumulative', 'next gate is the final one');
  // 3 phase gates + final = 4 delta collections: ORIG, B1, B2, then final from ORIG.
  assert.equal((await w.controller.review({ loopId })).status, 'PASS');
  assert.deepEqual(w.seen, ['ORIG', 'B1', 'B2', 'ORIG']);
});

test('untracked files at the boundary fall back to the cumulative diff', async () => {
  const w = scriptedWorld({ boundaries: [{ head: 'H1', baselineRef: 'B1', untrackedHashes: { 'new.js': 'abc' } }] });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r', phases });
  const r1 = await w.controller.review({ loopId });
  assert.equal(r1.status, 'PHASE_PASS');
  assert.equal(r1.nextDiffScope, 'cumulative');
  await w.controller.review({ loopId });
  assert.deepEqual(w.seen, ['ORIG', 'ORIG']);
});

test('an empty phase delta falls back to the cumulative diff instead of NO_PROGRESS', async () => {
  // Second collection (phase 2, against B1) is empty; the retry uses ORIG.
  const w = scriptedWorld({ boundaries: [{ head: 'H1', baselineRef: 'B1' }], emptyDeltaFor: new Set([2]) });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r', phases });
  assert.equal((await w.controller.review({ loopId })).status, 'PHASE_PASS');
  const r2 = await w.controller.review({ loopId });
  assert.equal(r2.status, 'PHASE_PASS');
  assert.deepEqual(w.seen, ['ORIG', 'B1', 'ORIG']);
});

test('a tampered phase boundary breaks the PHASE_PASS proof chain', async () => {
  const w = scriptedWorld({ boundaries: [{ head: 'H1', baselineRef: 'B1' }] });
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r', phases });
  await w.controller.review({ loopId });
  const raw = await w.persistence.readWorkflowState(loopId);
  raw.reviewLoop.completedPhases[0].phaseBaseline.baselineRef = 'SKIP-EVERYTHING';
  await w.persistence.writeWorkflowState(loopId, raw);
  await assert.rejects(w.controller.review({ loopId }), /no valid PHASE_PASS completion evidence/);
});

test('end to end on a real git repo: phase 2 reviewer never sees phase 1 code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-phase-diff-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await writeFile(path.join(dir, 'README.md'), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const diffs = [];
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      reviewerFn: async ({ diff, diffScope }) => {
        diffs.push({ diff, diffScope });
        return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
      },
    });
    const { loopId } = await controller.begin({
      goal: 'g', cwd: dir, phases: phases.slice(0, 2), verificationCommands: ['node -e 0'],
    });

    await writeFile(path.join(dir, 'one.js'), 'export const one = 1;\n');
    git('add', '-A');
    assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');

    await writeFile(path.join(dir, 'two.js'), 'export const two = 2;\n');
    git('add', '-A');
    assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');

    assert.match(diffs[0].diff, /one\.js/);
    assert.match(diffs[1].diff, /two\.js/);
    assert.doesNotMatch(diffs[1].diff, /one\.js/, 'phase 2 must not re-review phase 1');
    assert.equal(diffs[1].diffScope, 'phase-delta');

    assert.equal((await controller.review({ loopId })).status, 'PASS');
    assert.match(diffs[2].diff, /one\.js/);
    assert.match(diffs[2].diff, /two\.js/);
    assert.equal(diffs[2].diffScope, 'cumulative');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
