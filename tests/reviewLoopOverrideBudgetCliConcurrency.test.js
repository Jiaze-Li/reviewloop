// Real-process CLI regression: a running Reviewer/Worker holds the same durable
// per-loop lease that override-budget must acquire. Unlike unit tests of the
// lease helper alone, this spawns the actual CLI with a filesystem workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLoopFileLease } from '../src/reviewloop/loopLease.js';

const cli = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
const runCli = (root, args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: root },
});
const args = (id, maxUsage = '480000') => [
  'override-budget', '--loop', id, '--max-usage', maxUsage,
  '--reason', 'Human-authorized extension for unfinished final review',
];

function workflow(loopId) {
  return {
    reviewLoop: {
      loopId, round: 8, gateRound: 8,
      updatedAt: '2026-11-02T10:00:00.000Z',
      state: 'HUMAN_REQUIRED', budgetExhausted: false,
      objective: { goal: 'Verify frozen contract', phases: [] },
      history: [{
        from: 'REVIEWING', to: 'HUMAN_REQUIRED',
        reason: 'model spend blocked: SPEND_DENIED (ReviewLoop usage-volume ceiling reached)',
      }],
      chunkReviewCheckpoint: {
        key: 'checkpoint-kept', deltaGateKey: 'review-state-kept',
        chunks: { 0: { status: 'CLEAN' } }, round: 8,
      },
    },
    reviewLoopSpend: {
      records: [{ role: 'reviewer', usageVolume: 403000, usageKnown: true,
        costUsd: 1.25, costKnown: true }],
    },
    reviewLoopTokenAnomaly: { tripped: false },
    unrelatedMetadata: { keep: 'untouched' },
  };
}

test('override-budget CLI refuses real concurrent owner, then extends only after release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-override-cli-'));
  const loopId = 'rl-20261102100101-cli-race';
  try {
    const dir = path.join(root, loopId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'workflow.json');
    const initial = JSON.stringify(workflow(loopId), null, 2);
    await writeFile(file, initial);

    // Simulates the cross-process Reviewer/Worker's real lease, not a mock.
    const workerLease = await acquireLoopFileLease({ runtimeRoot: root, loopId });
    assert.equal(workerLease.ok, true);
    try {
      const blocked = runCli(root, args(loopId));
      assert.notEqual(blocked.status, 0,
        'the CLI itself must fail when another process holds the loop lease');
      assert.match(blocked.stderr, /cannot override budget while the loop is active/i);
      assert.equal(await readFile(file, 'utf8'), initial,
        'CLI may not modify even one byte while Worker owns the lease');
    } finally {
      await workerLease.release();
    }

    const allowed = runCli(root, args(loopId));
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /restored from HUMAN_REQUIRED to REWORK/);

    const next = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(next.reviewLoop.state, 'REWORK');
    assert.equal(next.reviewLoop.maxUsageVolumeOverride, 480000);
    assert.equal(next.reviewLoop.budgetOverrides.length, 1);
    assert.equal(next.reviewLoop.budgetOverrides[0].requestedBy, 'human');
    assert.equal(next.reviewLoop.budgetExhausted, false);
    assert.deepEqual(next.reviewLoop.chunkReviewCheckpoint,
      workflow(loopId).reviewLoop.chunkReviewCheckpoint,
      'authorizing more budget must preserve already-reviewed chunks');
    assert.deepEqual(next.reviewLoopSpend, workflow(loopId).reviewLoopSpend,
      'neither denied nor successful CLI call may reset physical spend');
    assert.deepEqual(next.unrelatedMetadata, { keep: 'untouched' });

    const repeated = runCli(root, args(loopId));
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /must exceed current effective limit/i);
    const repeatedState = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(repeatedState.reviewLoop.budgetOverrides.length, 1,
      'rejected same-cap extension may not append a new authorization event');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI cannot escape a convergence terminal state by extending a physical token limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-override-cli-convergence-'));
  const loopId = 'rl-20261102100102-convergence';
  try {
    const dir = path.join(root, loopId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'workflow.json');
    const state = workflow(loopId);
    state.reviewLoop.budgetExhausted = true;
    state.reviewLoop.history[0].reason = 'review did not converge: round ceiling reached';
    await writeFile(file, JSON.stringify(state, null, 2));

    const result = runCli(root, args(loopId));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /state: retained as HUMAN_REQUIRED/);
    assert.doesNotMatch(result.stdout, /Next: tell the Worker to call reviewloop_review/);
    const updated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(updated.reviewLoop.budgetExhausted, true);
    assert.equal(updated.reviewLoop.state, 'HUMAN_REQUIRED');
    assert.equal(updated.reviewLoop.maxUsageVolumeOverride, 480000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
