// Deterministic diff chunking for ReviewLoop.
//
// Invariant: a ReviewLoop PASS means every review-relevant changed line was
// covered by an independent Reviewer call. The Reviewer input is therefore
// never silently truncated. Either the whole diff fits one bounded call, or it
// is split deterministically into chunks that are EACH reviewed, and PASS
// requires every chunk to have been reviewed successfully.

import { createHash } from 'node:crypto';

export const DEFAULT_MAX_REVIEW_DIFF_CHARS = 45_000;
export const DEFAULT_MAX_REVIEW_CHUNKS = 12;

function sha256(v) { return createHash('sha256').update(String(v)).digest('hex'); }

function num(env, key, fallback) {
  const n = Number(env?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Split on `diff --git` file boundaries, then (if a single file is still too
// big) on `@@` hunk boundaries, then on raw lines. Fully deterministic.
function splitUnits(diff) {
  const fileParts = diff.split(/(?=^diff --git )/m).filter((s) => s.length);
  if (fileParts.length > 1 || /^diff --git /m.test(diff)) return fileParts;
  return [diff];
}

function splitOversizedUnit(unit, limit) {
  if (unit.length <= limit) return [unit];
  const hunks = unit.split(/(?=^@@ )/m).filter((s) => s.length);
  const out = [];
  for (const h of hunks) {
    if (h.length <= limit) { out.push(h); continue; }
    // line split as a last resort
    const lines = h.split('\n');
    let buf = '';
    for (const ln of lines) {
      if (buf.length + ln.length + 1 > limit && buf) { out.push(buf); buf = ''; }
      buf += (buf ? '\n' : '') + ln;
    }
    if (buf) out.push(buf);
  }
  return out;
}

// The effective per-call character limit and chunk ceiling (env-tunable).
export function reviewDiffBudget(env = process.env) {
  return {
    limit: num(env, 'REVIEWLOOP_MAX_REVIEW_DIFF_CHARS', DEFAULT_MAX_REVIEW_DIFF_CHARS),
    maxChunks: num(env, 'REVIEWLOOP_MAX_REVIEW_CHUNKS', DEFAULT_MAX_REVIEW_CHUNKS),
  };
}

// Returns { chunks: [{ index, total, text, hash }], oversized: bool, reason? }.
export function chunkDiffForReview(diff, { env = process.env } = {}) {
  const text = String(diff ?? '');
  const limit = num(env, 'REVIEWLOOP_MAX_REVIEW_DIFF_CHARS', DEFAULT_MAX_REVIEW_DIFF_CHARS);
  const maxChunks = num(env, 'REVIEWLOOP_MAX_REVIEW_CHUNKS', DEFAULT_MAX_REVIEW_CHUNKS);

  if (text.length <= limit) {
    return {
      chunks: [{ index: 0, total: 1, text, hash: sha256(text) }],
      oversized: false,
    };
  }

  const units = [];
  for (const u of splitUnits(text)) units.push(...splitOversizedUnit(u, limit));

  // greedy pack units into <= limit chunks
  const packed = [];
  let buf = '';
  for (const u of units) {
    if (buf && buf.length + u.length > limit) { packed.push(buf); buf = ''; }
    buf += u;
  }
  if (buf) packed.push(buf);

  if (packed.length > maxChunks || packed.some((c) => c.length > limit && !/\n/.test(c))) {
    return {
      chunks: [],
      oversized: true,
      reason: `changed evidence is ${text.length} chars; would need ${packed.length} review chunks (max ${maxChunks})`,
    };
  }

  return {
    chunks: packed.map((c, i) => ({ index: i, total: packed.length, text: c, hash: sha256(c) })),
    oversized: false,
  };
}
