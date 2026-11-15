// Issue #40, point 2: a Worker that edits a different repository/worktree than
// the one the loop is bound to must be told WHICH repository is bound, at
// begin and again when review sees no change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { readCurrentBranch } from '../src/reviewloop/gitEvidence.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function ctl({ readBranchFn, noChange = false } = {}) {
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, preExistingTouched: [],
      noWorkerChangeYet: noChange, changedFiles: noChange ? [] : ['a.js'], fingerprint: 'F1', diff: noChange ? '' : 'diff',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['echo ok'], manifestFingerprint: 'fp' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
    ...(readBranchFn ? { readBranchFn } : {}),
  });
}

function gitRepo(branch = 'work-branch') {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rl-bound-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(path.join(cwd, 'f.txt'), 'x');
  g('add', '.');
  g('commit', '-qm', 'init');
  g('checkout', '-q', '-b', branch);
  return { cwd, g };
}

test('begin echoes the bound repository root and branch', async () => {
  const c = ctl({ readBranchFn: async () => 'feature-x' });
  const b = await c.begin({ goal: 'g', cwd: '/some/repo' });
  assert.equal(b.repositoryRoot, '/some/repo');
  assert.equal(b.branch, 'feature-x');
});

test('begin still works when the branch cannot be read (null, never an error)', async () => {
  const c1 = ctl({ readBranchFn: async () => null });
  assert.equal((await c1.begin({ goal: 'g', cwd: '/r' })).branch, null);
  const c2 = ctl({ readBranchFn: async () => { throw new Error('boom'); } });
  const b = await c2.begin({ goal: 'g', cwd: '/r' });
  assert.equal(b.branch, null);
  assert.equal(b.repositoryRoot, '/r');
});

test('NO_PROGRESS after begin names the bound repository and branch and says other worktrees are not seen', async () => {
  const c = ctl({ readBranchFn: async () => 'feature-x', noChange: true });
  const b = await c.begin({ goal: 'g', cwd: '/some/repo' });
  const r = await c.review({ loopId: b.loopId });
  assert.equal(r.status, 'NO_PROGRESS');
  assert.match(r.reason, /no Worker change has been made since reviewloop_begin/);
  assert.match(r.reason, /bound to \/some\/repo \(branch feature-x\)/);
  assert.match(r.reason, /any other repository or git worktree are not seen/);
});

test('NO_PROGRESS still reads well when the branch is unknown', async () => {
  const c = ctl({ readBranchFn: async () => null, noChange: true });
  const b = await c.begin({ goal: 'g', cwd: '/some/repo' });
  const r = await c.review({ loopId: b.loopId });
  assert.match(r.reason, /bound to \/some\/repo \(branch unknown\)/);
});

test('readCurrentBranch: real branch, detached HEAD, and a directory that is not a repository', async () => {
  const { cwd, g } = gitRepo('feature/y');
  assert.equal(await readCurrentBranch({ cwd }), 'feature/y');
  g('checkout', '-q', '--detach');
  assert.equal(await readCurrentBranch({ cwd }), '(detached HEAD)');
  const plain = mkdtempSync(path.join(os.tmpdir(), 'rl-plain-'));
  assert.equal(await readCurrentBranch({ cwd: plain }), null);
  assert.equal(await readCurrentBranch({ cwd: '/definitely/not/a/dir' }), null);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test('a worktree is a different binding: begin in worktree A, work in worktree B => the message names A', async () => {
  const { cwd, g } = gitRepo('main-work');
  const wtB = path.join(os.tmpdir(), `rl-wtB-${Date.now()}`);
  g('worktree', 'add', '-q', '-b', 'other-work', wtB);
  const real = createReviewLoopController({
    persistence: new MemoryPersistence(),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['echo ok'], manifestFingerprint: 'fp' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  const b = await real.begin({ goal: 'g', cwd });
  assert.equal(b.repositoryRoot, cwd);
  assert.equal(b.branch, 'main-work');
  writeFileSync(path.join(wtB, 'edited-elsewhere.txt'), 'change in the OTHER worktree');
  const r = await real.review({ loopId: b.loopId });
  assert.equal(r.status, 'NO_PROGRESS');
  assert.ok(r.reason.includes(`bound to ${cwd} (branch main-work)`), r.reason);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(wtB, { recursive: true, force: true });
});
