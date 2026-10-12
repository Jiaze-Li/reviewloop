// Phase 1 — the ACTIVE ReviewLoop evidence path (src/reviewloop/gitEvidence.js)
// must:
//   * lstat an untracked path before reading it; never follow a symlink or read
//     a special file; fail the evidence closed instead;
//   * treat any non-zero git exit that feeds baseline / diff / HEAD / untracked
//     attribution as fail-closed, never as an empty diff / empty set / fallback
//     HEAD.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  captureBaseline,
  collectWorkerDelta,
} from '../src/reviewloop/gitEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-git-hard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

test('active path: Worker untracked symlink to an external secret is rejected before readFile; target bytes never enter evidence', async () => {
  const dir = initRepo();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-secret-'));
  try {
    const secretFile = path.join(secretDir, 'external-secret.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_TOKEN_ABC123');

    const baseline = await captureBaseline({ cwd: dir });

    // Worker produces an untracked symlink pointing outside the repo.
    fs.symlinkSync(secretFile, path.join(dir, 'leak'));

    let readCalls = 0;
    const delta = await collectWorkerDelta({
      cwd: dir,
      baseline,
      readFile: async (p) => { readCalls += 1; return fs.promises.readFile(p); },
    });

    assert.equal(delta.evidenceComplete, false, 'symlink fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /symlink/i.test(r)));
    assert.doesNotMatch(delta.diff, /TOP_SECRET_TOKEN/, 'target bytes never entered the diff');
    assert.equal(delta.changedFiles.includes('leak'), false, 'the symlink is not attributed as Worker output');
    assert.equal(readCalls, 0, 'readFile was never called on the symlink target');

    // And the controller fails closed rather than reviewing.
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => baseline,
      reviewerFn: async () => { throw new Error('reviewer must not be called'); },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test('active path: a pre-existing untracked symlink makes the baseline evidence incomplete', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'pre-existing-link'));
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(baseline.evidenceComplete, false);
    assert.ok(baseline.incompleteReasons.some((r) => /symlink/i.test(r)));
    assert.equal('pre-existing-link' in baseline.untrackedHashes, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a pre-existing untracked file modified but still untracked cannot be attributed to the Worker', async () => {
  const dir = initRepo();
  try {
    // Pre-existing untracked file present at baseline — only a digest is kept.
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'PRE_EXISTING_SECRET line 1\nline 2\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('scratch.txt' in baseline.untrackedHashes, true);

    // Worker edits it but never `git add`s it — stays untracked, so it never
    // reaches the trackedChanged / modifiedStagedBaseline guard.
    fs.appendFileSync(path.join(dir, 'scratch.txt'), 'worker added line\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /modified after baseline/i.test(r)));
    assert.ok((delta.modifiedUntrackedBaseline ?? []).includes('scratch.txt'));
    assert.equal(delta.untrackedChanged.includes('scratch.txt'), false, 'never attributed as Worker output');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing content never emitted as Worker evidence');
    assert.doesNotMatch(delta.diff, /worker added line/, 'the file is not rendered as a whole-new-file block');

    // The controller fails closed rather than reviewing.
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => baseline,
      reviewerFn: async () => { throw new Error('reviewer must not be called'); },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    assert.equal((await controller.review({ loopId })).status, 'HUMAN_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a renamed pre-existing untracked file is not attributed as brand-new Worker output', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'old-name.txt'), 'PRE_EXISTING_SECRET\nkeep me\n');
    const baseline = await captureBaseline({ cwd: dir });

    // Worker renames it (bytes unchanged) -> destination absent from the
    // baseline untracked set, source now gone.
    fs.renameSync(path.join(dir, 'old-name.txt'), path.join(dir, 'new-name.txt'));

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /byte-identical to a file that was untracked at baseline/i.test(r)));
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('new-name.txt'));
    assert.equal(delta.untrackedChanged.includes('new-name.txt'), false, 'the rename target is never emitted whole');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing content never leaks as Worker evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a pre-existing untracked file that the Worker modifies then git-ignores is not reported deleted', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'scratch.log'), 'PRE_EXISTING_SECRET\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('scratch.log' in baseline.untrackedHashes, true);

    // Worker edits it AND adds it to .gitignore -> `git ls-files --others
    // --exclude-standard` no longer lists it, but the file is still on disk.
    fs.appendFileSync(path.join(dir, 'scratch.log'), 'worker line\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'scratch.log\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails closed rather than PASSing without reviewing it');
    assert.ok(delta.incompleteReasons.some((r) => /git-ignored after baseline/i.test(r)));
    assert.equal(delta.untrackedDeleted.includes('scratch.log'), false, 'a still-present file is not reported deleted');
    assert.ok((delta.modifiedUntrackedBaseline ?? []).includes('scratch.log'));
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-existing untracked file that the Worker genuinely deletes is still reported deleted', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'temp\n');
    const baseline = await captureBaseline({ cwd: dir });
    fs.rmSync(path.join(dir, 'gone.txt'));
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, true);
    assert.ok(delta.untrackedDeleted.includes('gone.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('active path: an untracked special file (FIFO) fails the evidence closed', async () => {
  const responses = {
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/pipe\0' },
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')];
      if (!r) { child.emit('error', new Error(`unscripted git ${args.join(' ')}`)); return; }
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  let readCalls = 0;
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: {}, evidenceComplete: true },
    spawn,
    lstat: async () => ({
      isSymbolicLink: () => false,
      isFile: () => false,
      isFIFO: () => true,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => false,
      size: 0,
    }),
    readFile: async () => { readCalls += 1; return Buffer.from(''); },
  });
  assert.equal(delta.evidenceComplete, false);
  assert.ok(delta.incompleteReasons.some((r) => /FIFO/i.test(r)));
  assert.equal(readCalls, 0);
});

test('fail closed: a baseline-untracked file gone from the listing but not confirmed absent (EACCES) is not a deletion', async () => {
  const responses = {
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: '' }, // now hidden (ignored)
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')] ?? { code: 128 };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: { 'scratch.log': 'digest-abc' }, evidenceComplete: true },
    spawn,
    lstat: async () => { throw eacces; },
    readFile: async () => Buffer.from(''),
  });
  assert.equal(delta.evidenceComplete, false, 'unreadable != deleted');
  assert.equal(delta.untrackedDeleted.includes('scratch.log'), false);
  assert.ok(delta.incompleteReasons.some((r) => /could not be confirmed absent/i.test(r)));
});

test('fail closed: a rename+edit of a pre-existing untracked file is not split into a clean delete+create', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'notes-old.txt'), 'PRE_EXISTING_SECRET\nline\n');
    const baseline = await captureBaseline({ cwd: dir });
    // rename + append one line -> digest differs, old path gone, new path new.
    fs.renameSync(path.join(dir, 'notes-old.txt'), path.join(dir, 'notes-new.txt'));
    fs.appendFileSync(path.join(dir, 'notes-new.txt'), 'worker line\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /rename\+edit cannot be distinguished/i.test(r)));
    assert.equal(delta.untrackedDeleted.includes('notes-old.txt'), false, 'not reported as a clean deletion');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a baseline-untracked file renamed+edited AND staged under the new name does not leak its pre-existing bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'draft-old.txt'), 'PRE_EXISTING_SECRET\nkeep\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('draft-old.txt' in baseline.untrackedHashes, true);

    // rename + edit + stage the new name. `git diff <baseRef>` renders the
    // destination as a wholly-new file (baseRef has no blob for it) and the
    // untracked listing no longer shows either path.
    fs.renameSync(path.join(dir, 'draft-old.txt'), path.join(dir, 'draft-new.txt'));
    fs.appendFileSync(path.join(dir, 'draft-new.txt'), 'worker line\n');
    git('add', 'draft-new.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /rename\+edit cannot be distinguished/i.test(r)));
    assert.equal(delta.trackedChanged.includes('draft-new.txt'), false, 'not emitted as a tracked change');
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('draft-new.txt'));
    assert.equal(delta.untrackedDeleted.includes('draft-old.txt'), false, 'not a clean deletion');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing bytes never reach the Reviewer');
    assert.doesNotMatch(delta.diff, /worker line/, 'not rendered as a whole-new-file block');

    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => baseline,
      reviewerFn: async () => { throw new Error('reviewer must not be called'); },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    assert.equal((await controller.review({ loopId })).status, 'HUMAN_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a staged copy of a baseline-untracked file (source left in place) does not leak its bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'PRE_EXISTING_SECRET\ntoken=abc\n');
    const baseline = await captureBaseline({ cwd: dir });

    // Worker copies it to a staged new path WITHOUT deleting the original, so
    // nothing vanishes from the untracked listing.
    fs.copyFileSync(path.join(dir, 'secret.txt'), path.join(dir, 'copy.txt'));
    git('add', 'copy.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /byte-identical to a file that was untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('copy.txt'), false);
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('copy.txt'));
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: an EDITED copy of a baseline-untracked file (source left in place) does not leak its bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    const secret = Array.from({ length: 12 }, (_, i) => `SECRET_CONFIG_LINE_${i} = value-${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'config.secret'), secret);
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('config.secret' in baseline.untrackedHashes, true, 'baseline digested the untracked file');

    // Copy, then edit (append) — digest now differs — and stage. Source stays.
    fs.writeFileSync(path.join(dir, 'config.js'), `// generated\n${secret}\nexport default {};\n`);
    git('add', 'config.js');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /cannot be cleared: one or more files were untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('config.js'), false);
    assert.doesNotMatch(delta.diff, /SECRET_CONFIG_LINE_5/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: an edited copy of a LARGE SINGLE-LINE baseline-untracked file (no newlines) does not leak', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // One long line — minified JSON shape, well over the window size, no \n.
    const blob = `{${Array.from({ length: 60 }, (_, i) => `"key_${i}":"secret-value-${i}-xxxxxxxx"`).join(',')}}`;
    assert.equal(blob.includes('\n'), false);
    fs.writeFileSync(path.join(dir, 'creds.min.json'), blob);
    const baseline = await captureBaseline({ cwd: dir });

    // Copy it into a new tracked file, change ONE byte in the middle, stage it.
    const edited = `${blob.slice(0, 400)}X${blob.slice(401)}`;
    fs.writeFileSync(path.join(dir, 'bundled-config.json'), edited);
    git('add', 'bundled-config.json');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'a one-line file is compared like any other');
    assert.ok(delta.incompleteReasons.some((r) => /cannot be cleared: one or more files were untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('bundled-config.json'), false);
    assert.doesNotMatch(delta.diff, /secret-value-40/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a new file copying a NON-ALIGNED window-length slice of a baseline-untracked file is caught', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // Distinct characters so any 96-char slice is unambiguous.
    const secret = Array.from({ length: 500 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    fs.writeFileSync(path.join(dir, 'vault.txt'), secret);
    const baseline = await captureBaseline({ cwd: dir });

    // Copy EXACTLY 96 chars starting at baseline offset 1 (not a stride boundary)
    // into an otherwise-unrelated new file.
    const lifted = secret.slice(1, 97);
    assert.equal(lifted.length, 96);
    fs.writeFileSync(path.join(dir, 'helper.js'), `const noise = "aaaaaaaaaa";\n// ${lifted}\nmodule.exports = {};\n`);
    git('add', 'helper.js');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false, 'a 96-char non-aligned copy is still detected');
    assert.ok(delta.incompleteReasons.some((r) => /cannot be cleared: one or more files were untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('helper.js'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a baseline-untracked BINARY file copied to a new text file (NUL bytes stripped) does not leak', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // A "binary" blob: a long readable secret string with NUL bytes interleaved.
    const secretRun = Array.from({ length: 30 }, (_, i) => `EMBEDDED_SECRET_TOKEN_${i}_abcdef`).join('|');
    const withNuls = Buffer.from(secretRun.split('').join('\0'), 'latin1');
    fs.writeFileSync(path.join(dir, 'blob.bin'), withNuls);
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(baseline.evidenceComplete, true, 'a binary untracked file is still retained for comparison');

    // Worker copies the blob into a new text file with the NUL bytes removed —
    // digest differs, source stays on disk and stays "binary".
    fs.writeFileSync(path.join(dir, 'extracted.txt'), secretRun);
    git('add', 'extracted.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false, 'the de-NUL-ed copy is caught');
    assert.ok(delta.incompleteReasons.some((r) => /cannot be cleared: one or more files were untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('extracted.txt'), false);
    assert.doesNotMatch(delta.diff, /EMBEDDED_SECRET_TOKEN_15/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conservative: ANY baseline-untracked file makes a brand-new Worker file unattributable (fail closed)', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // Even an unrelated pre-existing untracked file — an arbitrary lossless
    // transform of its content into a brand-new file cannot be ruled out, so
    // ReviewLoop fails closed rather than guessing attribution.
    fs.writeFileSync(path.join(dir, 'old.env'), 'DATABASE_URL=postgres://localhost/app\nAPI_KEY=zzzzzzzzzzzzzzzzzzzz\n');
    const baseline = await captureBaseline({ cwd: dir });
    fs.writeFileSync(path.join(dir, 'config.example'), 'DATABASE_URL=postgres://example/db\n');
    git('add', 'config.example');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /cannot be cleared: one or more files were untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('config.example'), false);
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('config.example'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely new tracked file from a CLEAN baseline is normal Worker output', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(Object.keys(baseline.untrackedHashes).length, 0, 'no untracked files at baseline');
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    git('add', 'feature.js');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, true);
    assert.ok(delta.trackedChanged.includes('feature.js'));
    assert.match(delta.diff, /export const x = 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: the Worker delta changes a git submodule (dirty submodule worktree)', async () => {
  const parent = initRepo();
  const sub = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: parent });
    fs.writeFileSync(path.join(sub, 'lib.txt'), 'v1\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'sub v1'], { cwd: sub });
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendor');
    git('commit', '-qm', 'add submodule');

    const baseline = await captureBaseline({ cwd: parent });
    // Worker edits a file INSIDE the submodule; the parent gitlink is untouched.
    fs.writeFileSync(path.join(parent, 'vendor', 'lib.txt'), 'v1\nworker edit\n');

    const delta = await collectWorkerDelta({ cwd: parent, baseline });
    assert.equal(delta.evidenceComplete, false, 'a dirty submodule fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /submodule|gitlink/i.test(r)));
    assert.doesNotMatch(delta.diff, /worker edit/, 'submodule contents never reach the Reviewer');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test('fail closed: a brand-new untracked file above the read cap is not OOM-read and is not emitted', async () => {
  const dir = initRepo();
  try {
    const baseline = await captureBaseline({ cwd: dir });
    // 9 MiB > MAX_UNTRACKED_BYTES (8 MiB).
    fs.writeFileSync(path.join(dir, 'huge.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61));
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /above the .*cap|too large/i.test(r)));
    assert.equal(delta.untrackedChanged.includes('huge.txt'), false);
    assert.doesNotMatch(delta.diff, /aaaaaaaa/, 'the oversized file is never emitted into evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scriptedSpawn(responses) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')] ?? { code: 128, stdout: '', stderr: 'unscripted' };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
}

test('fail closed: git diff non-zero exit -> evidenceComplete=false, no empty-diff spoof', async () => {
  const spawn = scriptedSpawn({
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 128, stderr: 'fatal: bad revision' },
    'diff -z --name-only base000': { code: 0, stdout: '' },
    'diff -z --name-only --diff-filter=A base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: '' },
  });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: {}, evidenceComplete: true },
    spawn,
  });
  assert.equal(delta.evidenceComplete, false);
  assert.ok(delta.incompleteReasons.some((r) => /git diff base000.*exited 128/.test(r)));
  assert.equal(delta.noWorkerChangeYet, false, 'a diff failure never reads as "no change"');
});

test('fail closed: git ls-files non-zero exit -> evidenceComplete=false and no phantom untracked deletions', async () => {
  const spawn = scriptedSpawn({
    'rev-parse HEAD': { code: 0, stdout: 'base000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff -z --name-only base000': { code: 0, stdout: '' },
    'diff -z --name-only --diff-filter=A base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 129, stderr: 'error' },
  });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: { 'user.txt': 'abc' }, evidenceComplete: true },
    spawn,
  });
  assert.equal(delta.evidenceComplete, false);
  assert.deepEqual(delta.untrackedDeleted, [], 'a failed listing must not claim every baseline untracked file was deleted');
});

test('fail closed: captureBaseline throws when git rev-parse HEAD fails', async () => {
  const spawn = scriptedSpawn({
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    'rev-parse HEAD': { code: 128, stderr: 'fatal: not a valid ref' },
  });
  await assert.rejects(captureBaseline({ cwd: '/repo', spawn }), /rev-parse HEAD.*exited 128/);
});

test('fail closed: captureBaseline throws when git stash create fails', async () => {
  const spawn = scriptedSpawn({
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    'rev-parse HEAD': { code: 0, stdout: 'head000\n' },
    'stash create reviewloop-baseline': { code: 1, stderr: 'fatal: could not write stash' },
  });
  await assert.rejects(captureBaseline({ cwd: '/repo', spawn }), /stash create/);
});

test('NUL-delimited: a Worker file whose name contains a newline is attributed as one path, not split', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    const baseline = await captureBaseline({ cwd: dir });
    const weird = 'weird\nname.txt';
    fs.writeFileSync(path.join(dir, weird), 'worker body\n');
    git('add', '-A');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.deepEqual(delta.trackedChanged, [weird], 'the newline in the path did not slice it into two entries');
    assert.equal(delta.evidenceComplete, true, 'a legal newline in a filename is not a fail-closed condition');
    assert.match(delta.diff, /worker body/, 'the change is still rendered for the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a tracked binary file the Worker changed (rendered only as "Binary files ... differ") is not reviewable as text', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    const asset = path.join(dir, 'asset.bin');
    fs.writeFileSync(asset, Buffer.from([0, 1, 2, 3, 0, 255, 10, 0]));
    git('add', '-A');
    git('commit', '-qm', 'add binary asset');

    const baseline = await captureBaseline({ cwd: dir });
    fs.writeFileSync(asset, Buffer.from([9, 9, 9, 0, 1, 2, 3, 0, 255, 10, 0, 7]));

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false, 'a changed tracked binary blob fails the evidence closed');
    assert.ok(
      delta.incompleteReasons.some((r) => /binary file/i.test(r)),
      JSON.stringify(delta.incompleteReasons),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// P1 (PR #4 review thread PRRT_kwDOUDdrZs6gSMmn): O_NOFOLLOW on the final path
// component only protects that ONE component. If an INTERMEDIATE directory is
// replaced by a symlink after git listed a path through it but before
// fingerprintUntracked opens it, the by-name lstat() and the open() below both
// transparently follow the new parent symlink — lstat/open only refuse to
// follow a symlink at the exact path they are given, and neither is told
// anything about the parent chain. Reproduced deterministically: `git
// ls-files` is scripted to report `sub/leak.txt` (as it would have while
// `sub` was still a real directory at listing time), while `sub` is ALREADY a
// symlink to an external secret directory by the time collectWorkerDelta
// resolves and reads it — exactly the window between listing and read.
test('fail closed: an intermediate directory swapped for a symlink is rejected, even though the final component is a real file', async () => {
  const dir = initRepo();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-secret-parent-'));
  try {
    fs.writeFileSync(path.join(secretDir, 'leak.txt'), 'TOP_SECRET_VIA_PARENT_SWAP');

    // `sub` is a symlink to the external secret directory for the ENTIRE test
    // — standing in for "the swap already happened by the time we read it".
    fs.symlinkSync(secretDir, path.join(dir, 'sub'));

    // The baseline capture must not itself choke on `sub` — script its
    // untracked listing to see no untracked files yet, isolating the
    // vulnerability to collectWorkerDelta's own listing below.
    const emptyLsFilesSpawn = (cmd, args) => {
      const key = args.join(' ');
      if (key.startsWith('ls-files')) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      }
      return nodeSpawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const baseline = await captureBaseline({ cwd: dir, spawn: emptyLsFilesSpawn });

    // Script ONLY the untracked listing `collectWorkerDelta` uses for the
    // CURRENT tree, reporting the path git would have produced had `sub` still
    // been a real directory at listing time. Every other git command runs for
    // real against `dir`, which has no other untracked/tracked changes.
    const scriptedSpawn = (cmd, args) => {
      const key = args.join(' ');
      if (key.startsWith('ls-files')) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('sub/leak.txt\0'));
          child.emit('close', 0);
        });
        return child;
      }
      return nodeSpawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    };

    const delta = await collectWorkerDelta({ cwd: dir, baseline, spawn: scriptedSpawn });

    assert.equal(delta.evidenceComplete, false, 'an intermediate symlinked directory fails the evidence closed');
    assert.ok(
      delta.incompleteReasons.some((r) => /symlink|resolve/i.test(r)),
      JSON.stringify(delta.incompleteReasons),
    );
    assert.doesNotMatch(delta.diff, /TOP_SECRET_VIA_PARENT_SWAP/, 'the secret directory\'s bytes never entered the diff');
    assert.equal(delta.changedFiles.includes('sub/leak.txt'), false, 'the swapped path is never attributed as Worker output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

// P1 follow-up (PR #4 review thread on 465b266/dfe5bdd): the previous
// intermediate-directory fix compared `realpath(abs)` BEFORE the open against
// `realpath(abs)` AFTER the read. That is two separate syscalls with a real
// window in between — a concurrent process can swap the parent directory for
// a symlink strictly AFTER the "before" check runs (so it still reports the
// real, expected location) and strictly BEFORE the "after" check runs (having
// already restored the original directory), leaking the swapped-in target's
// bytes into evidence while both pathname checks report success. Two more
// checks around the same open cannot close a check-then-use race — closing it
// requires the check and the open to be one kernel call.
//
// This test reproduces exactly that window deterministically (via call-count
// driven fakes, standing in for the real interleaving) against:
//   (a) a faithful reconstruction of the OLD before/after-realpath algorithm,
//       proving it reports the attacker's bytes as safe, and
//   (b) the CURRENT fingerprintUntracked (via collectWorkerDelta), with the
//       atomic whole-path guard forced unavailable, proving it refuses to
//       open the path at all — there is no read for the race to land in.
test('P1 regression: parent directory swapped strictly between the pre-open check and the open, restored strictly before any post-read check', async () => {
  const dir = initRepo();
  const abs = path.join(dir, 'sub', 'leak.txt');
  const ATTACKER_BYTES = Buffer.from('TOP_SECRET_VIA_TRUE_RACE_WINDOW');
  const LEGIT_BYTES = Buffer.from('legit-worker-output');

  // Shared attack-simulation state: swapped=true models the window during
  // which `sub` is a symlink to the attacker's directory.
  function makeFakes() {
    const state = { swapped: false, opens: 0, realpathAbsCalls: 0 };
    const fakeLstat = async () => ({ isSymbolicLink: () => false, isFile: () => true });
    const fakeRealpath = async (p) => {
      if (p === dir) return dir; // repo root: fixed, never raced here
      if (p === abs) {
        state.realpathAbsCalls += 1;
        if (state.realpathAbsCalls === 1) {
          // "Before" check: sub is still the real directory at this instant.
          state.swapped = true; // attacker swaps it the moment this check returns
          return abs;
        }
        // Any later realpath(abs) call ("after" check): attacker has already
        // restored the real directory before this check runs.
        state.swapped = false;
        return abs;
      }
      throw Object.assign(new Error(`unexpected realpath(${p})`), { code: 'ENOENT' });
    };
    const fakeOpen = async () => {
      state.opens += 1;
      // Models the real syscall outcome of an O_NOFOLLOW-only open through an
      // intermediate symlink: it transparently follows the swapped parent.
      const bytes = state.swapped ? ATTACKER_BYTES : LEGIT_BYTES;
      const stat = { isSymbolicLink: () => false, isFile: () => true, ino: 1, size: bytes.length };
      return {
        stat: async () => stat,
        readFile: async () => Buffer.from(bytes),
        close: async () => {},
      };
    };
    return { state, fakeLstat, fakeRealpath, fakeOpen };
  }

  // (a) Faithful reconstruction of the OLD algorithm (before this fix):
  //     lstat -> realpath(cwd) + realpath(abs) BEFORE -> open(O_NOFOLLOW) ->
  //     read -> realpath(abs) AFTER, trusted if it matches "before".
  async function oldFingerprintUntracked({
    cwdArg, filePath, lstat, open, realpath,
  }) {
    const p = path.join(cwdArg, filePath);
    const info = await lstat(p);
    if (info.isSymbolicLink() || !info.isFile()) return { safe: false, reason: 'not a regular file' };
    const realCwd = await realpath(cwdArg);
    const realBefore = await realpath(p);
    const expected = path.join(realCwd, filePath);
    if (realBefore !== expected) return { safe: false, reason: 'parent swap detected before open' };
    const fh = await open(p, 0 /* O_RDONLY | O_NOFOLLOW, final component only */);
    const st = await fh.stat();
    const buf = await fh.readFile();
    const st2 = await fh.stat();
    if (st2.ino !== st.ino || st2.size !== buf.length) return { safe: false, reason: 'changed during read' };
    const realAfter = await realpath(p);
    if (realAfter !== realBefore) return { safe: false, reason: 'parent swap detected after read' };
    return { safe: true, bytes: buf };
  }

  const oldRun = makeFakes();
  const oldResult = await oldFingerprintUntracked({
    cwdArg: dir, filePath: 'sub/leak.txt', lstat: oldRun.fakeLstat, open: oldRun.fakeOpen, realpath: oldRun.fakeRealpath,
  });
  assert.equal(oldResult.safe, true, 'the OLD before/after-realpath algorithm is fooled by this exact race');
  assert.deepEqual(oldResult.bytes, ATTACKER_BYTES, 'the OLD algorithm hands back the attacker\'s bytes as "safe"');

  // (b) The CURRENT implementation, exercised through the public API, with
  // the atomic whole-path guard forced unavailable (the conservative,
  // non-Darwin-shaped case) so the only defence in play is the fail-closed
  // "refuse any parent component" policy this fix adds.
  try {
    const emptyLsFilesSpawn = (cmd, args) => {
      if (args.join(' ').startsWith('ls-files')) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      }
      return nodeSpawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const baseline = await captureBaseline({ cwd: dir, spawn: emptyLsFilesSpawn });

    const scriptedSpawn = (cmd, args) => {
      if (args.join(' ').startsWith('ls-files')) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('sub/leak.txt\0'));
          child.emit('close', 0);
        });
        return child;
      }
      return nodeSpawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    };

    const newRun = makeFakes();
    const delta = await collectWorkerDelta({
      cwd: dir,
      baseline,
      spawn: scriptedSpawn,
      lstat: newRun.fakeLstat,
      open: newRun.fakeOpen,
      realpath: newRun.fakeRealpath,
      atomicGuardFlag: null, // force "no atomic whole-path guard available"
    });

    assert.equal(delta.evidenceComplete, false, 'a parent-component path with no atomic guard fails the evidence closed');
    assert.ok(
      delta.incompleteReasons.some((r) => /parent director/i.test(r) && /atomic/i.test(r)),
      JSON.stringify(delta.incompleteReasons),
    );
    assert.equal(newRun.state.opens, 0, 'the current implementation never opens the path at all — there is no window for the race to land in');
    assert.doesNotMatch(delta.diff ?? '', /TOP_SECRET_VIA_TRUE_RACE_WINDOW/, 'the attacker bytes never entered evidence');
    assert.equal(delta.changedFiles.includes('sub/leak.txt'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git is run in the C locale so the binary-delta check cannot be skipped by a translated message', async () => {
  const dir = initRepo();
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = 'zh_CN.UTF-8';
  const seenLocales = [];
  const spawn = (cmd, args, opts) => {
    seenLocales.push(opts?.env?.LC_ALL);
    return nodeSpawn(cmd, args, opts);
  };
  try {
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'add blob'], { cwd: dir });
    const baseline = await captureBaseline({ cwd: dir, spawn });
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 9, 0]));
    const delta = await collectWorkerDelta({ cwd: dir, baseline, spawn });
    assert.equal(delta.evidenceComplete, false, 'a changed binary blob must fail the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /binary file/.test(r)));
    assert.ok(seenLocales.length > 0);
    assert.ok(seenLocales.every((l) => l === 'C'), `every git call must run with LC_ALL=C, saw ${[...new Set(seenLocales)]}`);
  } finally {
    if (previous === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
