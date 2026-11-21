#!/usr/bin/env node
// Zero-paid A/B/C comparison of Design-review input routes (PR #71, Design v1.5 §7).
//
//   A  today's full-prompt route (Controller assembles Plan + Design + sources)
//   B  Reviewer uses restricted read tools in ONE session (candidate, not built)
//   C  Controller reads on the model's structured request, one stateless call per
//      step (candidate, not built)
//
// B and C are deterministic MOCKS of a candidate protocol. Nothing here calls a
// model, touches production review paths, or says anything about provider
// semantic quality or real cost: those stay NOT_VERIFIED. Byte/step counts are
// measured on the fixture; token counts reuse the production estimator.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DESIGN_LIMITS } from '../src/reviewloop/designTwoStage.js';
import { assertPromptWithinBudget, estimateInputTokens, InputBudgetError, utf8Bytes } from '../src/reviewloop/inputBudget.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const TIGHT_BUDGET_BYTES = 58 * 1024;
export const CANDIDATE_LIMITS = Object.freeze({
  maxSteps: 8,
  maxSearch: 8,
  maxRead: 12,
  maxSegmentBytes: DESIGN_LIMITS.maxFileBytes,
  maxSegmentLines: DESIGN_LIMITS.maxExcerptLines,
  maxSourceBytes: DESIGN_LIMITS.maxTotalFileBytes,
});
const INSTRUCTIONS_BYTES = 3000;
const MANIFEST_BYTES = 1000;
const CALL_OVERHEAD_BYTES = 300;

// ---------------------------------------------------------------- fixtures
const lineOf = (tag, i) => `${tag} line ${String(i).padStart(5, '0')} ${'x'.repeat(40)}\n`;
const textOfBytes = (tag, bytes) => { let s = ''; for (let i = 0; s.length < bytes; i += 1) s += lineOf(tag, i); return s.slice(0, bytes - 1) + '\n'; };

// ~220k characters in total (Plan 40k + Design 64k + directory 12k + sources 96k + instructions).
export function makeLargeFixture({ planBytes = 40_000, designBytes = 64_000, directoryBytes = 12_000, sourceFiles = 4, sourceTotalBytes = CANDIDATE_LIMITS.maxSourceBytes } = {}) {
  const perFile = Math.floor(sourceTotalBytes / sourceFiles);
  return {
    plan: textOfBytes('PLAN', planBytes),
    design: textOfBytes('DESIGN', designBytes),
    directory: textOfBytes('DIR', directoryBytes),
    sources: Array.from({ length: sourceFiles }, (_, i) => ({ path: `src/m${i}.js`, text: textOfBytes(`SRC${i}`, perFile) })),
  };
}

// Whole-line segments: <= segment bytes and <= 400 lines. Never truncates.
export function segmentText(resource, text, ref = resource) {
  const out = [];
  let cur = []; let bytes = 0; let start = 1; let n = 0;
  const flush = () => {
    if (!cur.length) return;
    const body = cur.join('');
    out.push({ id: `${ref}#L${start}-L${n}`, resource, text: body, bytes: utf8Bytes(body), sha256: sha(body) });
    cur = []; bytes = 0; start = n + 1;
  };
  for (const line of text.split(/(?<=\n)/)) {
    const b = utf8Bytes(line);
    if (cur.length && (bytes + b > CANDIDATE_LIMITS.maxSegmentBytes || cur.length >= CANDIDATE_LIMITS.maxSegmentLines)) flush();
    cur.push(line); bytes += b; n += 1;
  }
  flush();
  return out;
}

// ------------------------------------------------- shared candidate broker
// One ACL used by BOTH candidate routes (B executes it as a sandbox, C as a
// Controller-side reader), so isolation is tested once for both.
export function createBroker({ stage, manifest, resources }) {
  const audit = [];
  const seen = new Map();
  let searches = 0; let reads = 0; let sourceBytes = 0;
  const reject = (op, reason) => { audit.push({ op, ok: false, reason }); return { ok: false, reason }; };
  const allowed = (resource) => (stage === 1
    ? resource === 'plan' || resource === 'repo'
    : ['plan', 'design', 'repo', 'allowlistedReview'].includes(resource));
  return {
    audit,
    counts: () => ({ searches, reads, sourceBytes }),
    search({ scope, query }) {
      if (!allowed(scope)) return reject('SEARCH', 'RESOURCE_FORBIDDEN');
      if (searches >= CANDIDATE_LIMITS.maxSearch) return reject('SEARCH', 'SEARCH_BUDGET');
      searches += 1;
      const files = scope === 'repo' ? resources.repo : {};
      const hits = Object.entries(files).filter(([p]) => resources.tracked.has(p))
        .flatMap(([p, t]) => t.split('\n').flatMap((l, i) => (l.includes(query) ? [{ path: p, line: i + 1 }] : []))).slice(0, 20);
      audit.push({ op: 'SEARCH', ok: true, scope });
      return { ok: true, hits };
    },
    read({ resource, ref, start = 1, end, expectSha, expectHead }) {
      if (!allowed(resource)) return reject('READ', 'RESOURCE_FORBIDDEN');
      if (resource === 'allowlistedReview' && !manifest.allowlistedEvidence.some((e) => e.id === ref && e.sha256 === sha(resources.reviews[ref] ?? ''))) {
        return reject('READ', 'NOT_ALLOWLISTED_OR_SHA_MISMATCH');
      }
      if (resource === 'plan' && expectSha && expectSha !== manifest.plan.sha256) return reject('READ', 'VERSION_DRIFT');
      if (resource === 'design' && expectSha && expectSha !== manifest.design.sha256) return reject('READ', 'VERSION_DRIFT');
      if (resource === 'repo') {
        if (expectHead && expectHead !== manifest.source.commitSha) return reject('READ', 'HEAD_DRIFT');
        if (!resources.tracked.has(ref)) return reject('READ', 'NOT_TRACKED');
      }
      const key = `${resource}|${ref}|${start}|${end}`;
      if (seen.has(key)) { audit.push({ op: 'READ', ok: true, cached: true }); return seen.get(key); }
      if (reads >= CANDIDATE_LIMITS.maxRead) return reject('READ', 'READ_BUDGET');
      const full = resource === 'repo' ? resources.repo[ref] : resource === 'allowlistedReview' ? resources.reviews[ref] : resources[resource];
      const lines = full.split(/(?<=\n)/).slice(start - 1, end);
      const text = lines.join('');
      if (lines.length > CANDIDATE_LIMITS.maxSegmentLines || utf8Bytes(text) > CANDIDATE_LIMITS.maxSegmentBytes) return reject('READ', 'SEGMENT_TOO_LARGE');
      if (resource === 'repo' && sourceBytes + utf8Bytes(text) > CANDIDATE_LIMITS.maxSourceBytes) return reject('READ', 'SOURCE_TOTAL_CAP');
      reads += 1;
      if (resource === 'repo') sourceBytes += utf8Bytes(text);
      const result = { ok: true, text, sha256: sha(text), segmentId: `${resource}:${ref}#L${start}-L${end}`, sourceHead: manifest.source.commitSha };
      seen.set(key, result);
      audit.push({ op: 'READ', ok: true });
      return result;
    },
  };
}

// ----------------------------------------- checkpoint / paid-step ordering
// `state` is plain JSON: a restart is `createSession(JSON.parse(JSON.stringify(state)))`.
export function createSession(state = { findings: {}, covered: [], steps: {}, spent: 0, noProgress: {} }) {
  return {
    state,
    addFinding(id, severity) { state.findings[id] ??= { severity, open: true }; },
    // A model summary may only ADD or CLOSE-with-evidence; omitting a finding never removes it.
    applySummary({ closed = [] }) {
      for (const c of closed) if (c.evidence?.length && state.findings[c.id]) state.findings[c.id].open = false;
    },
    cover(segmentId) { if (!state.covered.includes(segmentId)) state.covered.push(segmentId); },
    async runStep(stepId, { action, reason, newEvidence = true }, dispatch) {
      const prev = state.steps[stepId];
      if (prev?.status === 'SETTLED') return { reused: true, result: prev.result };
      if (prev?.status === 'DISPATCHED') return { stop: 'UNKNOWN_SPEND', reason: 'dispatched step has no settlement; never re-sent, never assumed free' };
      if (Object.keys(state.steps).length >= CANDIDATE_LIMITS.maxSteps) return { stop: 'STEP_BUDGET' };
      const key = `${action}|${reason}`;
      state.noProgress[key] = newEvidence ? 0 : (state.noProgress[key] ?? 0) + 1;
      if (state.noProgress[key] >= 2) return { stop: 'NO_PROGRESS' };
      state.steps[stepId] = { status: 'DISPATCHED' };          // persisted BEFORE the paid call
      state.spent += 1;
      const result = await dispatch();
      state.steps[stepId] = { status: 'SETTLED', result };
      return { result };
    },
    final({ requiredSegments, visibleTogether = [], relatedGroups = [], unverifiedCritical = 0, drift = false, error = false }) {
      const reasons = [];
      if (error) reasons.push('SOURCE_IDENTITY_UNREADABLE');
      if (drift) reasons.push('VERSION_OR_HEAD_DRIFT');
      const open = Object.entries(state.findings).filter(([, f]) => f.open && ['P1', 'P2'].includes(f.severity)).map(([id]) => id);
      if (open.length) reasons.push(`OPEN_BLOCKING_FINDINGS:${open.join(',')}`);
      const missing = requiredSegments.filter((s) => !state.covered.includes(s));
      if (missing.length) reasons.push(`UNCOVERED_SEGMENTS:${missing.length}`);
      for (const g of relatedGroups) if (!g.every((s) => visibleTogether.includes(s))) reasons.push('RELATED_SEGMENTS_NOT_CO_VISIBLE');
      if (unverifiedCritical) reasons.push(`UNVERIFIED_CRITICAL:${unverifiedCritical}`);
      return { verdict: reasons.length ? 'REWORK' : 'PASS', reasons };
    },
  };
}

// --------------------------------------------------------- route simulators
const metrics = (prompts, extra = {}) => {
  const sizes = prompts.map(utf8Bytes);
  const total = sizes.reduce((a, b) => a + b, 0);
  return { calls: sizes.length, peakPromptBytes: Math.max(0, ...sizes), totalSentBytes: total, estimatedTokens: estimateInputTokens(total), ...extra };
};
const filler = (n) => 'i'.repeat(Math.max(0, n));

export function simulateA(fx, limitBytes) {
  const src = fx.sources.map((s) => s.text).join('');
  const prompts = [
    filler(INSTRUCTIONS_BYTES) + fx.plan + fx.directory,
    filler(INSTRUCTIONS_BYTES) + fx.plan + src,
    filler(INSTRUCTIONS_BYTES) + fx.plan + fx.design + src + filler(1500) + fx.directory,
  ];
  const budget = { limitBytes, source: 'BENCHMARK' };
  for (const p of prompts) {
    try { assertPromptWithinBudget(p, {}, budget); } catch (e) {
      if (!(e instanceof InputBudgetError)) throw e;
      // Pre-dispatch refusal: zero calls, zero bytes sent, nothing truncated.
      return { route: 'A', admitted: false, stop: e.code, attemptedPeakBytes: Math.max(...prompts.map(utf8Bytes)), calls: 0, peakPromptBytes: 0, totalSentBytes: 0, estimatedTokens: 0, searches: 0, reads: 0, checkpointBytes: 0, unverifiedCriticalClaims: segmentText('plan', fx.plan).length + segmentText('design', fx.design).length };
    }
  }
  return { route: 'A', admitted: true, searches: 0, reads: 0, checkpointBytes: 0, unverifiedCriticalClaims: 0, ...metrics(prompts) };
}

const checkpointBytes = (segments, findings = 0) => 600 + 120 * segments + 200 * findings;

// C: stateless call per step; each prompt = instructions + manifest + checkpoint + the segments just read.
export function simulateC(fx, limitBytes, { relatedGroupSize = 2 } = {}) {
  const segs = [...segmentText('plan', fx.plan), ...segmentText('design', fx.design),
    ...fx.sources.flatMap((s) => segmentText('repo', s.text, s.path))];
  const searches = fx.sources.length;
  const budgeted = segs.slice(0, CANDIDATE_LIMITS.maxRead);
  const overBudgetReads = segs.length - budgeted.length;
  const prompts = [filler(INSTRUCTIONS_BYTES + MANIFEST_BYTES)];          // call 1: manifest only -> first SEARCH/READ request
  let pack = []; let packBytes = 0; let read = 0;
  const emit = () => {
    if (!pack.length) return;
    prompts.push(filler(INSTRUCTIONS_BYTES + MANIFEST_BYTES + checkpointBytes(read)) + pack.map((s) => s.text).join(''));
    pack = []; packBytes = 0;
  };
  for (const s of budgeted) {
    const room = limitBytes - (INSTRUCTIONS_BYTES + MANIFEST_BYTES + checkpointBytes(read + 1) + CALL_OVERHEAD_BYTES);
    if (pack.length && packBytes + s.bytes > room) emit();
    pack.push(s); packBytes += s.bytes; read += 1;
  }
  emit();
  // Final ASSESS/FINAL call must show the related group's ORIGINAL text together.
  const group = budgeted.slice(0, relatedGroupSize);
  const finalPrompt = filler(INSTRUCTIONS_BYTES + MANIFEST_BYTES + checkpointBytes(read)) + group.map((s) => s.text).join('');
  prompts.push(finalPrompt);
  const coRoom = utf8Bytes(finalPrompt) <= limitBytes;
  const peak = Math.max(...prompts.map(utf8Bytes));
  const fits = peak <= limitBytes;
  return {
    route: 'C', admitted: fits && overBudgetReads === 0 && coRoom,
    stop: !fits ? 'INPUT_TOO_LARGE' : overBudgetReads ? 'READ_BUDGET_COVERAGE_GAP' : !coRoom ? 'RELATED_SEGMENTS_NOT_CO_VISIBLE' : undefined,
    searches, reads: budgeted.length, checkpointBytes: checkpointBytes(read), unverifiedCriticalClaims: overBudgetReads,
    ...metrics(prompts),
  };
}

// B: one tool session; turn i re-sends the whole accumulated context (no cache assumed).
export function simulateB(fx, limitBytes, { sessionContextLimitBytes = 400_000 } = {}) {
  const segs = [...segmentText('plan', fx.plan), ...segmentText('design', fx.design),
    ...fx.sources.flatMap((s) => segmentText('repo', s.text, s.path))];
  const reads = Math.min(segs.length, CANDIDATE_LIMITS.maxRead);
  let ctx = INSTRUCTIONS_BYTES + MANIFEST_BYTES;
  const prompts = [filler(ctx)];
  for (const s of segs.slice(0, reads)) { ctx += s.bytes + CALL_OVERHEAD_BYTES; prompts.push(filler(ctx)); }
  const peak = ctx;
  return {
    route: 'B', admitted: peak <= sessionContextLimitBytes && segs.length <= CANDIDATE_LIMITS.maxRead,
    requiresAdapterChange: true,             // current CLI transports are stateless, no tools (cliReviewTransports.js)
    exceedsSameBudget: peak > limitBytes,    // would need checkpointed resets to stay within the 58 KiB per-call bound
    searches: fx.sources.length, reads, checkpointBytes: 0, unverifiedCriticalClaims: segs.length - reads,
    ...metrics(prompts),
  };
}

export function compareRoutes(fx = makeLargeFixture(), limitBytes = TIGHT_BUDGET_BYTES) {
  return { limitBytes, A: simulateA(fx, limitBytes), B: simulateB(fx, limitBytes), C: simulateC(fx, limitBytes) };
}

export const NOT_VERIFIED = Object.freeze([
  'provider semantic review quality for B and C',
  'real provider cost and token usage (estimates only: ceil(bytes/3))',
  'B: provider tool support and session continuation (current CLI transports are stateless, no tools)',
  'cross-call information loss with real models and model switching',
  'crash recovery on the production ledger (mock checkpoint only)',
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fx = makeLargeFixture();
  const chars = fx.plan.length + fx.design.length + fx.directory.length + fx.sources.reduce((n, s) => n + s.text.length, 0);
  const r = compareRoutes(fx);
  console.log(JSON.stringify({ fixtureChars: chars, ...r, NOT_VERIFIED }, null, 2));
}
