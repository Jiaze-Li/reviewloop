// P1 regression — stale loop-lease reclaim must be ownership-preserving: when
// several processes simultaneously see the SAME reclaimable lock, at most ONE
// acquires the lease. The old `unlink(path)` reclaim let a late contender
// delete the winner's freshly-created replacement lock and then acquire its
// own, so two reviews ran concurrently (duplicate paid dispatch, racing state).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTENDER = fileURLToPath(new URL('./fixtures/leaseContender.mjs', import.meta.url));

function runContender(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONTENDER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ error: `bad output: ${out} / ${err}` }); }
    });
  });
}

test('N processes racing to reclaim ONE stale lock -> at most one wins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-race-'));
  const barrier = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-barrier-'));
  const loopId = 'RACELOOP';
  try {
    // Pre-plant a stale lock: dead pid on THIS host -> reclaimable.
    const dir = path.join(root, loopId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'stale', pid: 999_999_999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(),
    }));

    const N = 6;
    const runs = Array.from({ length: N }, (_, i) => runContender({
      LEASE_ROOT: root, LEASE_LOOP: loopId, LEASE_BARRIER: barrier, LEASE_ID: `c${i}`, LEASE_N: String(N),
    }));

    // Wait for every contender to reach the barrier, then release them together.
    const deadline = Date.now() + 12_000;
    while (fs.readdirSync(barrier).filter((f) => f.startsWith('ready-')).length < N) {
      if (Date.now() > deadline) throw new Error('contenders did not all reach the barrier');
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(path.join(barrier, 'go'), '1');

    const results = await Promise.all(runs);
    const winners = results.filter((r) => r.ok === true);
    assert.ok(results.every((r) => r.error === undefined), JSON.stringify(results));
    assert.ok(winners.length <= 1, `at most one winner, got ${winners.length}: ${JSON.stringify(results)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(barrier, { recursive: true, force: true });
  }
});

test('renew() is a CAS on the inode: it never overwrites a successor lease', async () => {
  const { acquireLoopFileLease } = await import('../src/reviewloop/loopLease.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-renew-cas-'));
  const loopId = 'CASLOOP';
  const lockPath = path.join(root, loopId, 'reviewloop.lock');
  try {
    const a = await acquireLoopFileLease({ runtimeRoot: root, loopId, ttlMs: 60_000 });
    assert.equal(a.ok, true);
    assert.equal(await a.renew(), true, 'owner can renew its own live lock');

    // Simulate a remote contender that reclaimed the path and published its own
    // lock (a different inode, a different token).
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      token: 'successor', pid: 4242, host: 'other-host',
      acquiredAt: new Date().toISOString(), renewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    assert.equal(await a.renew(), false, 'the displaced owner no longer renews');
    const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(after.token, 'successor', 'the successor lease is left intact');
    assert.equal(after.pid, 4242);

    await a.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'successor',
      'release() also refuses to delete a lock it no longer owns');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-host: after the lease is reclaimed mid-review, the displaced owner does NOT dispatch or persist', async () => {
  const { createReviewLoopController } = await import('../src/reviewloop/controller.js');
  const { Persistence } = await import('../src/orchestrator/persistence.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-loss-'));
  try {
    const persistence = new Persistence(root);
    let reviewerCalls = 0;
    let loopIdRef = null;
    const controller = createReviewLoopController({
      persistence,
      runtimeRoot: root,
      captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
      collectWorkerDeltaFn: async () => {
        // Simulate: our lease looked expired and a remote contender (host "B")
        // reclaimed it and published its own lock at the same path.
        const lockPath = path.join(root, loopIdRef, 'reviewloop.lock');
        fs.writeFileSync(lockPath, JSON.stringify({
          token: 'contender-B', pid: 5150, host: 'host-B',
          acquiredAt: new Date().toISOString(), renewedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        return { baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'diff --git a/a.js b/a.js\n+worker change\n' };
      },
      discoverVerificationCommandsFn: () => ({ source: 'none', commands: [], manifestFingerprint: 'mf' }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
      reviewerFn: async () => { reviewerCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: root });
    loopIdRef = loopId;
    const before = JSON.stringify(await controller._store.load(loopId));

    const r = await controller.review({ loopId });

    assert.equal(reviewerCalls, 0, 'no paid Reviewer dispatch after the lease was lost');
    assert.equal(r.status, 'WAITING_FOR_REVIEW');
    assert.match(r.reason, /lease .*(reclaimed|lost)/i);
    const after = JSON.stringify(await controller._store.load(loopId));
    assert.equal(after, before, 'no durable ReviewLoop state was written after the lease was lost');
    // The successor's lock is intact — the displaced owner never touched it.
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, loopId, 'reviewloop.lock'), 'utf8')).token, 'contender-B');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
