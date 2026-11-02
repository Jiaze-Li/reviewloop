import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_SNAPSHOT_LIMITS, ArtifactEvidenceError,
  parseArtifactSnapshotRef, captureArtifactSnapshots, artifactSnapshotsStillMatch,
} from '../src/reviewloop/artifactEvidence.js';
import {
  evidencePromptLines, evidenceBundleFingerprint,
  validateEvidenceSubmissions, EvidenceValidationError,
} from '../src/reviewloop/contractEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const ref = (name) => 'reviewloop-artifact:' + name;
const requirement = (type = 'artifact') => ({
  id: 'proof', type, gate: 'final', required: true, covers: ['AC1'],
  description: 'Provide bounded evidence of the actual behavior',
});
const submitted = (artifactRef = ref('proof.txt')) => ({
  requirementId: 'proof',
  summary: 'Executed the test with 4 passing checks and exit code zero.',
  artifactRef,
});
const bundle = (artifactRef = ref('proof.txt')) => ({
  requirements: [requirement()],
  submissions: [{ ...submitted(artifactRef), type: 'artifact' }],
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-artifact-test-'));
  const loopId = 'rl-artifact-unit-test';
  const artifactsDir = path.join(root, loopId, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  return {
    root, loopId, artifactsDir,
    file: (name) => path.join(artifactsDir, name),
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

test('only explicit flat text basenames activate safe artifact capture', async () => {
  for (const value of [
    ref('../secret.txt'), ref('/etc/passwd'), ref('subdir/proof.txt'),
    ref('a..b.txt'), ref('.private.txt'), ref('report.pdf'), ref('x.png'),
    ref('proof.txt/..'), ref('c:\\private.txt'),
  ]) {
    assert.throws(() => parseArtifactSnapshotRef(value), ArtifactEvidenceError, value);
  }
  assert.equal(parseArtifactSnapshotRef('old/logs/report.txt'), null,
    'legacy references are human-only, never auto-read');
  assert.equal(parseArtifactSnapshotRef(ref('proof.txt')), 'proof.txt');

  assert.throws(() => validateEvidenceSubmissions({
    objective: { evidenceRequirements: [requirement('runtime')] },
    reviewScope: { type: 'task', id: 'task' },
    submissions: [submitted()],
  }), EvidenceValidationError, 'snapshot refs are only for artifact-type obligations');
});

test('captures exact bounded UTF-8 data and binds its SHA to the fingerprint', async () => {
  const t = await fixture();
  try {
    const text = 'tests: 4 passed, 0 failed; UTF-8 雪\n';
    await writeFile(t.file('proof.txt'), text);
    const plain = bundle();
    const before = evidenceBundleFingerprint(plain);
    const captured = await captureArtifactSnapshots({ bundle: plain, runtimeRoot: t.root, loopId: t.loopId });
    const proof = captured.artifactSnapshots[0];
    assert.equal(proof.text, text);
    assert.equal(proof.bytes, Buffer.byteLength(text));
    assert.equal(proof.sha256, createHash('sha256').update(text).digest('hex'));
    assert.notEqual(evidenceBundleFingerprint(captured), before);
    const rendered = evidencePromptLines(captured).join('\n');
    assert.match(rendered, /CONTROLLER-CAPTURED LOCAL ARTIFACT SNAPSHOTS/);
    assert.match(rendered, /UNTRUSTED worker-authored data/);
    assert.match(rendered, /4 passed, 0 failed/);
    assert.match(rendered, new RegExp(proof.sha256));
    assert.equal(await artifactSnapshotsStillMatch({ bundle: captured, runtimeRoot: t.root, loopId: t.loopId }), true);

    await writeFile(t.file('proof.txt'), text.replace('4 passed', '3 passed'));
    const changed = await captureArtifactSnapshots({ bundle: plain, runtimeRoot: t.root, loopId: t.loopId });
    assert.notEqual(evidenceBundleFingerprint(changed), evidenceBundleFingerprint(captured));
    assert.equal(await artifactSnapshotsStillMatch({ bundle: captured, runtimeRoot: t.root, loopId: t.loopId }), false);
    // The original bundle remains an immutable detached snapshot, not a
    // lazily opened file handle or a pointer the model can dereference.
    assert.equal(captured.artifactSnapshots[0].text, text);
  } finally {
    await t.cleanup();
  }
});

test('path escapes, symlinks, hardlinks, devices, binary and oversized files fail closed', async () => {
  const t = await fixture();
  try {
    await symlink(path.join(t.root, 'missing-secret.txt'), t.file('proof.txt'));
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /non-linked text file/,
    );
    await rm(t.file('proof.txt'));
    const other = path.join(t.root, 'other.txt');
    await writeFile(other, 'separate hard-linked content');
    await link(other, t.file('proof.txt'));
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /non-linked text file/,
    );
    await rm(t.file('proof.txt'));
    await writeFile(t.file('proof.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /valid UTF-8/,
    );
    await writeFile(t.file('proof.txt'), 'A'.repeat(ARTIFACT_SNAPSHOT_LIMITS.fileBytes + 1));
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /byte ceiling/,
    );
    await writeFile(t.file('proof.txt'), 'valid\n\x1b[31m malicious terminal escape');
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /terminal controls/,
    );
    await rm(t.file('proof.txt'));
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId }),
      /not found/,
    );
    const hidden = path.join(t.root, 'cannot-be-read.txt');
    await writeFile(hidden, 'private data');
    assert.equal(await readFile(hidden, 'utf8'), 'private data');
    await assert.rejects(
      () => captureArtifactSnapshots({ bundle: bundle(ref('cannot-be-read.txt')), runtimeRoot: t.root, loopId: t.loopId }),
      /not found/,
      'Controller must never read arbitrary sibling paths');
  } finally {
    await t.cleanup();
  }
});

test('all artifact bytes count towards existing Reviewer evidence prompt cap', async () => {
  const t = await fixture();
  try {
    const content = 'C'.repeat(ARTIFACT_SNAPSHOT_LIMITS.fileBytes);
    await writeFile(t.file('proof.txt'), content);
    const captured = await captureArtifactSnapshots({ bundle: bundle(), runtimeRoot: t.root, loopId: t.loopId });
    assert.equal(captured.artifactSnapshots[0].bytes, ARTIFACT_SNAPSHOT_LIMITS.fileBytes);
    const over = {
      ...captured,
      requirements: [{ ...requirement(), description: 'R'.repeat(ARTIFACT_SNAPSHOT_LIMITS.totalBytes + 200) }],
    };
    assert.throws(() => evidencePromptLines(over), /combined evidence prompt exceeds/);
  } finally {
    await t.cleanup();
  }
});

function fakeController(root, { onReview, reviews } = {}) {
  const persistence = new MemoryPersistence();
  const calls = [];
  const controller = createReviewLoopController({
    persistence, runtimeRoot: root, env: {},
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'same-code', diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
      changedFiles: ['a.js'], currentHead: 'HEAD',
      baselineHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      preExistingTouched: [],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo done'] }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, fingerprint: 'stable-gate', results: [],
      failureIdentities: [],
    }),
    reviewerFn: async ({ evidence }) => {
      calls.push(evidence);
      await onReview?.(evidence);
      return {
        value: reviews?.[Math.min(calls.length - 1, reviews.length - 1)] ?? { findings: [] },
        usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model',
      };
    },
    supervisorFn: async () => ({
      value: { guidance: 'Review new proof', recommendation: 'REWORK' },
      usage: { input_tokens: 8, output_tokens: 4 },
    }),
  });
  return { controller, persistence, calls };
}

test('Controller re-reviews changed artifact bytes even when code/Gate/summary stay identical', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-artifact-controller-'));
  try {
    const w = fakeController(root, {
      reviews: [
        { findings: [{ severity: 'P2', file: 'a.js', line: 1, title: 'Cannot verify implementation' }] },
        { findings: [] },
      ],
    });
    const { loopId } = await w.controller.begin({
      goal: 'Validate the actual behavior', cwd: '/r', evidenceRequirements: [requirement()],
    });
    const dir = path.join(root, loopId, 'artifacts');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'proof.txt');
    await writeFile(file, 'test result: 2 failed out of 4\n');

    const first = await w.controller.review({ loopId, evidence: [submitted()] });
    assert.equal(first.status, 'REWORK');
    assert.equal(w.calls.length, 1);
    assert.match(evidencePromptLines(w.calls[0]).join('\n'), /2 failed/);

    await writeFile(file, 'test result: 4 passed and 0 failed\n');
    const second = await w.controller.review({ loopId });
    assert.equal(second.status, 'PASS');
    assert.equal(w.calls.length, 2, 'new artifact digest is genuinely new reviewer input');
    assert.notEqual(w.calls[0].artifactSnapshots[0].sha256, w.calls[1].artifactSnapshots[0].sha256);
    assert.equal(JSON.stringify(second).includes('test result: 4 passed'), false,
      'Worker response must not echo raw proof bytes');
    const workflow = await w.persistence.readWorkflowState(loopId);
    assert.equal(JSON.stringify(workflow.reviewLoop.evidenceRecords).includes('test result: 4 passed'), false,
      'do not persist artifact raw content into workflow.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Controller never PASSes if artifact changes during independent review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-artifact-race-'));
  try {
    let file;
    const w = fakeController(root, {
      onReview: async () => { await writeFile(file, 'artifact changed while reviewer ran\n'); },
      reviews: [{ findings: [] }],
    });
    const { loopId } = await w.controller.begin({
      goal: 'Review content bound to exact proof bytes', cwd: '/r',
      evidenceRequirements: [requirement()],
    });
    const dir = path.join(root, loopId, 'artifacts');
    await mkdir(dir, { recursive: true });
    file = path.join(dir, 'proof.txt');
    await writeFile(file, 'original proof data\n');
    const result = await w.controller.review({ loopId, evidence: [submitted()] });
    assert.equal(result.status, 'REWORK');
    assert.match(result.reason, /artifact evidence changed/);
    assert.equal(w.calls.length, 1);
    const state = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
    assert.notEqual(state.state, 'PASS');
    assert.equal(state.chunkReviewCheckpoint, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
