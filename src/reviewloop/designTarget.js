// Design review target: one complete, repository-relative design file whose
// FULL current content the independent Reviewer must see on every round.
//
// Scope (deliberately small): path validation, a safe bounded read, a content
// digest, and a "whole file is inside ONE Reviewer request" check. Everything
// else (Gate, routing, budgets, checkpoints, resume) is the existing engine.
//
// The digest is a content-consistency check, NOT a proof of Design PASS or of
// user authorization.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chunkDiffForReview } from './diffChunker.js';

export const DESIGN_TARGET_MAX_BYTES = 64 * 1024;
const PATH_MAX_CHARS = 512;

export class DesignTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DesignTargetError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new DesignTargetError(code, message); };

const sha256Hex = (v) => createHash('sha256').update(v).digest('hex');

// Content identity: SHA-256 over the UTF-8 bytes of the trimmed text. This is
// the same normalization the frozen `contractText` receives, so the Design
// PASS digest and a later Code `contractText` compare on equal terms.
export function designContentSha256(text) {
  return sha256Hex(Buffer.from(String(text ?? '').trim(), 'utf8'));
}

// Returns a normalized POSIX-style repository-relative path, or throws.
export function normalizeReviewTargetPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('DESIGN_TARGET_PATH_INVALID', 'reviewTarget must be a non-empty repository-relative file path');
  }
  const raw = value.trim();
  if (raw.length > PATH_MAX_CHARS) fail('DESIGN_TARGET_PATH_INVALID', `reviewTarget exceeds ${PATH_MAX_CHARS} characters`);
  if (raw.includes('\0') || raw.includes('\\')) {
    fail('DESIGN_TARGET_PATH_INVALID', 'reviewTarget must use "/" separators and contain no NUL');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    fail('DESIGN_TARGET_PATH_INVALID', 'reviewTarget must be relative to the repository root, not absolute');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) {
    fail('DESIGN_TARGET_PATH_INVALID', 'reviewTarget must name one file inside the repository (no "..", no directory)');
  }
  if (normalized.split('/').some((seg) => seg === '.git')) {
    fail('DESIGN_TARGET_PATH_INVALID', 'reviewTarget must not point into .git');
  }
  return normalized;
}

// Walk every path component with lstat. A symlink anywhere on the way is
// refused (never followed). Returns { stat } of the final component or
// { missing: true } when the final component does not exist.
async function lstatNoSymlinks(root, rel) {
  const segments = rel.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let st;
    try {
      // eslint-disable-next-line no-await-in-loop
      st = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { missing: true };
      fail('DESIGN_TARGET_UNREADABLE', `cannot stat reviewTarget ${rel}: ${err?.message ?? err}`);
    }
    if (st.isSymbolicLink()) {
      fail('DESIGN_TARGET_SYMLINK', `reviewTarget ${rel} resolves through a symbolic link; refusing to follow it`);
    }
    if (i < segments.length - 1 && !st.isDirectory()) {
      fail('DESIGN_TARGET_PATH_INVALID', `reviewTarget ${rel}: a parent component is not a directory`);
    }
    if (i === segments.length - 1) return { stat: st };
  }
  return { missing: true };
}

// begin-time guard: a new Design loop requires a NEW target. A tracked file
// only shows its modified hunks in the Reviewer diff, and a pre-existing
// untracked file is unattributable to the Worker, so neither can guarantee
// that the Reviewer sees the whole file.
export async function assertReviewTargetAbsent({ cwd, reviewTarget }) {
  const rel = normalizeReviewTargetPath(reviewTarget);
  const found = await lstatNoSymlinks(cwd, rel);
  if (!found.missing) {
    fail(
      'DESIGN_TARGET_EXISTS',
      `reviewTarget ${rel} already exists. A new Design loop needs a NEW target file: call reviewloop_begin first, `
      + 'THEN create the design file (or choose a different path).',
    );
  }
  return rel;
}

// Safe, bounded, strict-UTF-8 read of the CURRENT target file.
export async function readReviewTarget({ cwd, reviewTarget, maxBytes = DESIGN_TARGET_MAX_BYTES }) {
  const rel = normalizeReviewTargetPath(reviewTarget);
  const found = await lstatNoSymlinks(cwd, rel);
  if (found.missing) {
    fail('DESIGN_TARGET_MISSING', `reviewTarget ${rel} does not exist; write the complete design file, then call reviewloop_review`);
  }
  if (!found.stat.isFile()) {
    fail('DESIGN_TARGET_NOT_FILE', `reviewTarget ${rel} is not a regular file`);
  }
  if (found.stat.size > maxBytes) {
    fail('DESIGN_TARGET_TOO_LARGE', `reviewTarget ${rel} is ${found.stat.size} bytes; the limit is ${maxBytes} bytes. Shorten it without dropping acceptance criteria; ReviewLoop never truncates a design`);
  }
  const abs = path.join(cwd, rel);
  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (err) {
    fail('DESIGN_TARGET_UNREADABLE', `cannot read reviewTarget ${rel}: ${err?.message ?? err}`);
  }
  if (buf.length > maxBytes) {
    fail('DESIGN_TARGET_TOO_LARGE', `reviewTarget ${rel} is ${buf.length} bytes; the limit is ${maxBytes} bytes`);
  }
  let text;
  try {
    // ignoreBOM keeps a leading BOM in the text, matching how the Reviewer
    // diff evidence renders the same bytes (Buffer#toString('utf8')).
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    fail('DESIGN_TARGET_NOT_UTF8', `reviewTarget ${rel} is not valid UTF-8`);
  }
  return {
    path: rel,
    text,
    bytes: buf.length,
    sha256: designContentSha256(text),
  };
}

// The whole current design file must sit inside ONE Reviewer request, or no
// single Reviewer call has seen the whole document. We look for the file's
// content inside a single chunk of the exact diff that will be dispatched.
// Both evidence shapes are recognised: the untracked block that gitEvidence
// renders for a new file, and (if the Worker committed) a `diff --git` unit.
export function assertTargetWithinOneChunk({ diff, target, env = process.env }) {
  const { chunks, oversized, reason } = chunkDiffForReview(diff, { env });
  if (oversized) {
    fail('DESIGN_TARGET_NOT_REVIEWABLE', `the changed evidence cannot be reviewed whole: ${reason ?? 'oversized'}`);
  }
  const untrackedBlock = `--- Worker untracked file ${target.path} (${target.bytes} bytes) ---\n${target.text}`;
  if (chunks.some((c) => c.text.includes(untrackedBlock))) return true;

  const header = `diff --git a/${target.path} b/${target.path}`;
  const full = String(diff ?? '');
  const start = full.indexOf(header);
  if (start >= 0) {
    const next = full.indexOf('\ndiff --git ', start + header.length);
    const unit = next >= 0 ? full.slice(start, next + 1) : full.slice(start);
    if (chunks.some((c) => c.text.includes(unit))) return true;
  }
  fail(
    'DESIGN_TARGET_SPLIT',
    `the full text of ${target.path} is not inside a single Reviewer request (the review diff is split into ${chunks.length} chunk(s) of at most `
    + `${reviewDiffLimit(env)} characters, or the file is missing from the evidence). Shorten the design file or keep other changes out of this loop so it fits one request. PASS is not possible until a single request contains the whole file.`,
  );
  return false;
}

function reviewDiffLimit(env) {
  const n = Number(env?.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

// Safe, bounded, strict-UTF-8 read of an arbitrary repository file for the
// two-stage Reviewer context proxy. Same symlink/regular-file guards as the
// design target; the caller owns the allow-list (tracked files only).
export async function readRepoFile({ cwd, rel, maxBytes }) {
  const found = await lstatNoSymlinks(cwd, rel);
  if (found.missing) fail('DESIGN_TARGET_MISSING', `${rel} does not exist`);
  if (!found.stat.isFile()) fail('DESIGN_TARGET_NOT_FILE', `${rel} is not a regular file`);
  if (found.stat.size > maxBytes) fail('DESIGN_TARGET_TOO_LARGE', `${rel} exceeds ${maxBytes} bytes`);
  let buf;
  try { buf = await fsp.readFile(path.join(cwd, rel)); } catch (err) {
    fail('DESIGN_TARGET_UNREADABLE', `cannot read ${rel}: ${err?.message ?? err}`);
  }
  if (buf.length > maxBytes) fail('DESIGN_TARGET_TOO_LARGE', `${rel} exceeds ${maxBytes} bytes`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { fail('DESIGN_TARGET_NOT_UTF8', `${rel} is not valid UTF-8`); }
  return { path: rel, text, bytes: buf.length };
}
