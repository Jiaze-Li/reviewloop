import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reduceFinalDiff } from '../src/reviewloop/finalDiffReducer.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const section = (f, body = '+x\n') => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n${body}`;

test('omits single-phase files, keeps cross-phase and post-boundary files', () => {
  const diff = ['one.js', 'shared.js', 'late.js', 'two.js'].map((f) => section(f)).join('');
  const r = reduceFinalDiff({
    diff,
    changedFiles: ['late.js', 'one.js', 'shared.js', 'two.js'],
    completedPhases: [{ reviewedFiles: ['one.js', 'shared.js', 'late.js'] }, { reviewedFiles: ['shared.js', 'two.js'] }],
    postBoundaryFiles: ['late.js'],
  });
  assert.deepEqual(r.omittedFiles, ['one.js', 'two.js']);
  assert.match(r.diff, /diff --git a\/shared\.js/);
  assert.match(r.diff, /diff --git a\/late\.js/);
  assert.doesNotMatch(r.diff, /diff --git a\/one\.js/);
  assert.match(r.diff, /^# NOTE: omitted/);
});

test('files no phase recorded are always reviewed', () => {
  const diff = section('orphan.js') + section('one.js');
  const r = reduceFinalDiff({
    diff, changedFiles: ['one.js', 'orphan.js'],
    completedPhases: [{ reviewedFiles: ['one.js'] }], postBoundaryFiles: [],
  });
  assert.deepEqual(r.omittedFiles, ['one.js']);
  assert.match(r.diff, /orphan\.js/);
});

test('fails closed (null) when the split cannot be trusted', () => {
  const base = { completedPhases: [{ reviewedFiles: ['a.js', 'b.js'] }], postBoundaryFiles: [] };
  // a phase without a record
  assert.equal(reduceFinalDiff({ ...base, diff: section('a.js') + section('b.js'), changedFiles: ['a.js', 'b.js'], completedPhases: [{}] }), null);
  // a changed file with no unit
  assert.equal(reduceFinalDiff({ ...base, diff: section('a.js'), changedFiles: ['a.js', 'b.js'] }), null);
  // a fake header inside content creates a duplicate unit for a changed file
  assert.equal(reduceFinalDiff({
    ...base,
    diff: '--- Worker untracked file a.js (40 bytes) ---\ndiff --git a/b.js b/b.js\n' + section('b.js'),
    changedFiles: ['a.js', 'b.js'],
  }), null);
  // an unattributable header (e.g. quoted path)
  assert.equal(reduceFinalDiff({ ...base, diff: 'diff --git "a/\\303.js" "b/\\303.js"\n+x\n', changedFiles: ['é.js'] }), null);
  // nothing to omit
  assert.equal(reduceFinalDiff({ ...base, diff: section('a.js'), changedFiles: ['a.js'], completedPhases: [{ reviewedFiles: [] }] }), null);
});

test('a path that is a suffix of another changed path is attributed correctly', () => {
  const r = reduceFinalDiff({
    diff: section('bar.js') + section('foo/bar.js'),
    changedFiles: ['bar.js', 'foo/bar.js'],
    completedPhases: [{ reviewedFiles: ['bar.js'] }, { reviewedFiles: ['bar.js', 'foo/bar.js'] }],
    postBoundaryFiles: [],
  });
  assert.deepEqual(r.omittedFiles, ['foo/bar.js']);
  assert.match(r.diff, /diff --git a\/bar\.js b\/bar\.js/);
  assert.doesNotMatch(r.diff, /diff --git a\/foo\/bar\.js/);
});

test('a path that itself contains " b/" is attributed correctly', () => {
  const r = reduceFinalDiff({
    diff: section('y.js') + section('x b/y.js'),
    changedFiles: ['y.js', 'x b/y.js'],
    completedPhases: [{ reviewedFiles: ['y.js'] }, { reviewedFiles: ['y.js', 'x b/y.js'] }],
    postBoundaryFiles: [],
  });
  assert.deepEqual(r.omittedFiles, ['x b/y.js']);
});

test('a rename header is still attributed to its new path', () => {
  const diff = 'diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js\n'
    + section('keep.js');
  const r = reduceFinalDiff({
    diff, changedFiles: ['keep.js', 'new.js'],
    completedPhases: [{ reviewedFiles: ['keep.js'] }, { reviewedFiles: ['keep.js', 'new.js'] }],
    postBoundaryFiles: [],
  });
  assert.deepEqual(r.omittedFiles, ['new.js']);
});

test('untracked blocks are attributed by their header', () => {
  const diff = section('t.js') + '--- Worker untracked file new.js (10 bytes) ---\nconst a = 1;\n';
  const r = reduceFinalDiff({
    diff, changedFiles: ['new.js', 't.js'],
    completedPhases: [{ reviewedFiles: ['new.js'] }, { reviewedFiles: ['t.js'] }, { reviewedFiles: ['t.js'] }],
    postBoundaryFiles: [],
  });
  assert.deepEqual(r.omittedFiles, ['new.js']);
  assert.match(r.diff, /t\.js/);
});

test('end to end: an oversized final diff is reviewed through the cross-phase subset instead of stopping', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-final-reduce-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    await writeFile(path.join(dir, 'README.md'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    const seen = [];
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      env: { ...process.env, REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '3000', REVIEWLOOP_MAX_REVIEW_CHUNKS: '1' },
      reviewerFn: async ({ diff, diffScope }) => {
        seen.push({ diff, diffScope });
        return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
      },
    });
    const phases = ['p1', 'p2'].map((id) => ({ id, objective: id, exitCriteria: ['ok'] }));
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir, phases, verificationCommands: ['node -e 0'] });

    const big = (n) => `${'// filler line to make this file large\n'.repeat(60)}export const v = ${n};\n`;
    await writeFile(path.join(dir, 'only1.js'), big(1));
    await writeFile(path.join(dir, 'shared.js'), 'export const s = 1;\n');
    git('add', '-A');
    assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');
    await writeFile(path.join(dir, 'only2.js'), big(2));
    await writeFile(path.join(dir, 'shared.js'), 'export const s = 2;\n');
    git('add', '-A');
    assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');

    assert.equal((await controller.review({ loopId })).status, 'PASS');
    const final = seen[seen.length - 1];
    assert.equal(final.diffScope, 'final-cross-phase');
    assert.match(final.diff, /shared\.js/);
    assert.doesNotMatch(final.diff, /diff --git a\/only1\.js/);
    assert.match(final.diff, /NOTE: omitted[^\n]*only1\.js[^\n]*only2\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
