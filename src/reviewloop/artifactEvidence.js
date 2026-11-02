// Optional, bounded, read-only local artifact snapshots for independent Reviewer
// context. Only explicit reviewloop-artifact:<basename> refs are opened. All
// other artifactRef strings retain the old human-only meaning.
//
// Artifact bytes are WORKER-SUPPLIED / UNTRUSTED (not proof of an actual test
// run). The Controller can attest to exactly which UTF-8 bytes were read and
// reviewed; it cannot attest who authored them. No Reviewer filesystem tools
// and no arbitrary user/repository path reads are permitted.

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_REF_PREFIX = 'reviewloop-artifact:';
export const ARTIFACT_SNAPSHOT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024,
  totalBytes: 16 * 1024,
  files: 8,
});

export class ArtifactEvidenceError extends Error {
  constructor(message) {
    super('artifact snapshot: ' + message);
    this.name = 'ArtifactEvidenceError';
    this.code = 'INVALID_EVIDENCE';
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(?:txt|md|json|log|csv)$/i;
const LOOP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseArtifactSnapshotRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(ARTIFACT_REF_PREFIX)) return null;
  const name = ref.slice(ARTIFACT_REF_PREFIX.length);
  if (!SAFE_BASENAME.test(name) || name.includes('..')) {
    throw new ArtifactEvidenceError('ref requires one safe text basename (no directories or traversal)');
  }
  return name;
}

function validDirectory(entry) {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

async function safeDirectory(dir) {
  let stat;
  try {
    stat = await lstat(dir);
  } catch {
    throw new ArtifactEvidenceError('the loop artifact directory is unavailable');
  }
  if (!validDirectory(stat)) {
    throw new ArtifactEvidenceError('a snapshot directory is not a real directory');
  }
}

async function readSafeSnapshot({ runtimeRoot, loopId, name }) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot || !LOOP_ID.test(loopId)) {
    throw new ArtifactEvidenceError('invalid runtime root or loop identity');
  }

  // A symlinked runtime ROOT is an explicit user configuration and is safe
  // after canonicalization. The per-loop and artifacts subdirectories must
  // still be real directories: Worker-created symlink hops are never followed.
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(runtimeRoot);
  } catch {
    throw new ArtifactEvidenceError('the configured runtime root is unavailable');
  }
  await safeDirectory(canonicalRoot);
  const loopDir = path.join(canonicalRoot, loopId);
  const artifactsDir = path.join(loopDir, 'artifacts');
  await safeDirectory(loopDir);
  await safeDirectory(artifactsDir);
  const file = path.join(artifactsDir, name);

  let before;
  try {
    before = await lstat(file);
  } catch {
    throw new ArtifactEvidenceError('referenced artifact not found');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ArtifactEvidenceError('artifact must be a regular, non-linked text file');
  }
  if (before.size <= 0 || before.size > ARTIFACT_SNAPSHOT_LIMITS.fileBytes) {
    throw new ArtifactEvidenceError('artifact is empty or exceeds per-file byte ceiling');
  }

  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW ?? 0)
    | (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(file, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) {
      throw new ArtifactEvidenceError('artifact changed during secure open');
    }
    const buf = Buffer.alloc(ARTIFACT_SNAPSHOT_LIMITS.fileBytes + 1);
    let got = 0;
    while (got < buf.length) {
      // eslint-disable-next-line no-await-in-loop
      const part = await handle.read(buf, got, buf.length - got, got);
      if (!part.bytesRead) break;
      got += part.bytesRead;
    }
    const after = await handle.stat();
    if (got === 0 || got > ARTIFACT_SNAPSHOT_LIMITS.fileBytes
      || got !== opened.size || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new ArtifactEvidenceError('artifact changed during capture or exceeds byte ceiling');
    }
    const bytes = buf.subarray(0, got);
    let text;
    try {
      // Preserve UTF-8 BOM as U+FEFF so the decoded string re-encodes to
      // the exact original bytes; otherwise byte-length and SHA binding diverge.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ArtifactEvidenceError('artifact must contain valid UTF-8 text');
    }
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new ArtifactEvidenceError('artifact must be nonempty UTF-8 text without terminal controls');
    }
    return { sha256: sha256(bytes), bytes: got, text };
  } catch (err) {
    if (err instanceof ArtifactEvidenceError) throw err;
    throw new ArtifactEvidenceError('artifact could not be opened or captured safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Output is a detached byte snapshot for one model request, never a path for
// the isolated Reviewer to dereference. The hashes become part of the logical
// review fingerprint, including crash/resume chunk identity.
export async function captureArtifactSnapshots({ bundle, runtimeRoot, loopId } = {}) {
  const submissions = bundle?.submissions ?? [];
  const snapshots = [];
  let total = 0;
  for (const proof of submissions) {
    const name = parseArtifactSnapshotRef(proof.artifactRef);
    if (!name) continue;
    if (proof.type !== 'artifact') {
      throw new ArtifactEvidenceError('snapshot refs require a frozen artifact-type evidence requirement');
    }
    if (snapshots.length >= ARTIFACT_SNAPSHOT_LIMITS.files) {
      throw new ArtifactEvidenceError('too many artifact snapshot files');
    }
    // eslint-disable-next-line no-await-in-loop
    const item = await readSafeSnapshot({ runtimeRoot, loopId, name });
    total += item.bytes;
    if (total > ARTIFACT_SNAPSHOT_LIMITS.totalBytes) {
      throw new ArtifactEvidenceError('combined artifact snapshot bytes exceed ceiling');
    }
    snapshots.push({
      requirementId: proof.requirementId,
      artifactRef: proof.artifactRef,
      ...item,
    });
  }
  return { ...bundle, ...(snapshots.length ? { artifactSnapshots: snapshots } : {}) };
}

// A file may be replaced while model calls are in-flight. Never let a stale
// snapshot authorize PASS if any included artifact changed or disappeared.
export async function artifactSnapshotsStillMatch({ bundle, runtimeRoot, loopId } = {}) {
  const old = bundle?.artifactSnapshots ?? [];
  if (!old.length) return true;
  try {
    const fresh = await captureArtifactSnapshots({
      bundle: { submissions: bundle.submissions },
      runtimeRoot, loopId,
    });
    const next = fresh.artifactSnapshots ?? [];
    return old.length === next.length
      && old.every((item, i) => item.requirementId === next[i].requirementId
        && item.artifactRef === next[i].artifactRef
        && item.bytes === next[i].bytes
        && item.sha256 === next[i].sha256);
  } catch {
    return false;
  }
}
