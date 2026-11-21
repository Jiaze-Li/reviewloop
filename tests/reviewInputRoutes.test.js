// Zero-paid A/B/C route comparison + candidate-protocol mocks (PR #71, F1-F8).
// B/C are deterministic mocks of a candidate protocol: nothing here is production
// end-to-end evidence or a statement about real provider quality/cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  makeLargeFixture, compareRoutes, simulateA, simulateB, simulateC, createBroker, createSession, segmentText,
  TIGHT_BUDGET_BYTES, CANDIDATE_LIMITS, NOT_VERIFIED,
} from '../scripts/benchmark-review-input-routes.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HEAD = 'a'.repeat(40);

function brokerFor(stage, fx = makeLargeFixture(), extra = {}) {
  const review = 'REVIEW BODY mentions DESIGN-HINT';
  const resources = {
    plan: fx.plan, design: fx.design,
    repo: Object.fromEntries(fx.sources.map((s) => [s.path, s.text])),
    tracked: new Set(fx.sources.map((s) => s.path)),
    reviews: { 'c-1': review },
  };
  const manifest = {
    plan: { sha256: sha(fx.plan) }, design: { sha256: sha(fx.design) }, source: { commitSha: HEAD },
    allowlistedEvidence: [{ id: 'c-1', sha256: sha(review) }, ...(extra.evidence ?? [])],
  };
  return { broker: createBroker({ stage, manifest, resources }), manifest, resources };
}

test('F1: ~220k-char input at the 58 KiB budget — A refuses pre-dispatch, nothing truncated', () => {
  const fx = makeLargeFixture();
  const chars = fx.plan.length + fx.design.length + fx.directory.length + fx.sources.reduce((n, s) => n + s.text.length, 0);
  assert.ok(chars >= 200_000);
  const a = simulateA(fx, TIGHT_BUDGET_BYTES);
  assert.equal(a.admitted, false);
  assert.equal(a.stop, 'INPUT_TOO_LARGE');
  assert.equal(a.calls, 0);
  assert.equal(a.totalSentBytes, 0);
  assert.ok(a.attemptedPeakBytes > TIGHT_BUDGET_BYTES);
  assert.ok(a.unverifiedCriticalClaims > 0);
});

test('F1: C keeps every call inside the budget; B grows past it; neither silently drops text', () => {
  const small = makeLargeFixture({ sourceTotalBytes: 48 * 1024 });
  const { A, B, C } = compareRoutes(small);
  assert.equal(A.admitted, false);
  assert.equal(C.admitted, true);
  assert.ok(C.peakPromptBytes <= TIGHT_BUDGET_BYTES);
  assert.equal(C.unverifiedCriticalClaims, 0);
  assert.equal(B.exceedsSameBudget, true);
  assert.equal(B.requiresAdapterChange, true);
  assert.ok(B.peakPromptBytes > C.peakPromptBytes);
  assert.ok(B.totalSentBytes > C.totalSentBytes, 'B re-sends its growing context every turn (no cache assumed)');
  // every segment is whole-line and the segments rebuild the original text exactly
  assert.equal(segmentText('plan', small.plan).map((s) => s.text).join(''), small.plan);
});

test('F1/F2: the full 96 KiB of source is admitted; more source reads than the cap leaves a visible coverage gap', () => {
  const full = simulateC(makeLargeFixture(), TIGHT_BUDGET_BYTES);
  assert.equal(full.admitted, true);
  assert.ok(full.reads <= CANDIDATE_LIMITS.maxRead + 6, 'plan/design segments are pushed by the Controller and not capped');
  const many = simulateC(makeLargeFixture({ sourceFiles: 24, sourceTotalBytes: 96 * 1024 }), TIGHT_BUDGET_BYTES);
  assert.equal(many.admitted, false);
  assert.equal(many.stop, 'READ_BUDGET_COVERAGE_GAP');
  assert.ok(many.unverifiedCriticalClaims > 0);
});

test('F2: Plan and Design each legal but combined over budget; related sections must be co-visible', () => {
  const fx = makeLargeFixture({ sourceTotalBytes: 16 * 1024 });
  assert.ok(Buffer.byteLength(fx.plan) < 64 * 1024 && Buffer.byteLength(fx.design) <= 64 * 1024);
  assert.equal(simulateA(fx, TIGHT_BUDGET_BYTES).admitted, false);
  assert.equal(simulateC(fx, TIGHT_BUDGET_BYTES).admitted, true);
  // a related group of 3 full segments (~72 KiB) cannot be shown together in one 58 KiB call
  const big = simulateC(fx, TIGHT_BUDGET_BYTES, { relatedGroupSize: 3 });
  assert.equal(big.admitted, false);
  assert.ok(['INPUT_TOO_LARGE', 'RELATED_SEGMENTS_NOT_CO_VISIBLE'].includes(big.stop));
});

test('F2/F3: final verdict blocks on open P1/P2, uncovered text, non-co-visible related text, UNVERIFIED claims, drift', () => {
  const required = ['s1', 's2'];
  const ok = () => { const s = createSession(); s.cover('s1'); s.cover('s2'); return s; };
  assert.equal(ok().final({ requiredSegments: required }).verdict, 'PASS');
  const missing = createSession(); missing.cover('s1');
  assert.match(missing.final({ requiredSegments: required }).reasons.join(), /UNCOVERED_SEGMENTS:1/);
  const p2 = ok(); p2.addFinding('F-1', 'P2');
  assert.match(p2.final({ requiredSegments: required }).reasons.join(), /OPEN_BLOCKING_FINDINGS:F-1/);
  assert.match(ok().final({ requiredSegments: required, relatedGroups: [['s1', 's2']], visibleTogether: ['s1'] }).reasons.join(), /RELATED_SEGMENTS_NOT_CO_VISIBLE/);
  assert.match(ok().final({ requiredSegments: required, unverifiedCritical: 1 }).reasons.join(), /UNVERIFIED_CRITICAL:1/);
  assert.match(ok().final({ requiredSegments: required, drift: true }).reasons.join(), /VERSION_OR_HEAD_DRIFT/);
  assert.match(ok().final({ requiredSegments: required, error: true }).reasons.join(), /SOURCE_IDENTITY_UNREADABLE/);
});

test('F3: a model summary cannot delete an open finding; closing needs evidence; survives model switch/restart', () => {
  const s = createSession();
  s.addFinding('F-1', 'P1');
  s.applySummary({ closed: [] });                       // summary silently omits F-1
  s.applySummary({ closed: [{ id: 'F-1', evidence: [] }] });
  assert.equal(s.state.findings['F-1'].open, true);
  const restarted = createSession(JSON.parse(JSON.stringify(s.state)));   // "different model" resumes from checkpoint
  assert.equal(restarted.state.findings['F-1'].open, true);
  restarted.applySummary({ closed: [{ id: 'F-1', evidence: ['repo:src/m0.js#L1-L5'] }] });
  assert.equal(restarted.state.findings['F-1'].open, false);
});

test('F4: SEARCH -> READ with 24 KiB / 400 line / 96 KiB limits, caching, tracked-only, HEAD drift', () => {
  const fx = makeLargeFixture();
  const { broker } = brokerFor(2, fx);
  const hit = broker.search({ scope: 'repo', query: 'SRC1 line 00003' });
  assert.equal(hit.ok, true);
  assert.equal(hit.hits[0].path, 'src/m1.js');
  const r = broker.read({ resource: 'repo', ref: 'src/m1.js', start: 1, end: 400, expectHead: HEAD });
  assert.equal(r.ok, true);
  assert.equal(r.sha256, sha(r.text));
  assert.equal(r.sourceHead, HEAD);
  assert.equal(broker.read({ resource: 'repo', ref: 'src/m1.js', start: 1, end: 401 }).reason, 'SEGMENT_TOO_LARGE');
  assert.equal(broker.read({ resource: 'repo', ref: 'untracked.js', start: 1, end: 5 }).reason, 'NOT_TRACKED');
  assert.equal(broker.read({ resource: 'repo', ref: 'src/m1.js', start: 1, end: 5, expectHead: 'b'.repeat(40) }).reason, 'HEAD_DRIFT');
  const before = broker.counts().reads;
  assert.equal(broker.read({ resource: 'repo', ref: 'src/m1.js', start: 1, end: 400 }).ok, true);
  assert.equal(broker.counts().reads, before, 'duplicate READ is served from cache and not re-counted');
  // source caps: the cumulative 96 KiB and the per-stage read count are both hard stops
  const { broker: b2 } = brokerFor(2, makeLargeFixture({ sourceFiles: 8, sourceTotalBytes: 96 * 1024 }));
  let rejected = null;
  for (let i = 0; i < 8 && !rejected; i += 1) {
    for (const [start, end] of [[1, 200], [201, 400], [1, 199]]) {
      const x = b2.read({ resource: 'repo', ref: `src/m${i}.js`, start, end });
      if (!x.ok) { rejected = x.reason; break; }
    }
  }
  assert.ok(['SOURCE_TOTAL_CAP', 'READ_BUDGET'].includes(rejected));
});

test('F4: READ/SEARCH budgets are hard stops, not silent truncation', () => {
  const { broker } = brokerFor(2);
  for (let i = 0; i < CANDIDATE_LIMITS.maxSearch; i += 1) assert.equal(broker.search({ scope: 'repo', query: 'x' }).ok, true);
  assert.equal(broker.search({ scope: 'repo', query: 'x' }).reason, 'SEARCH_BUDGET');
});

test('F5: stage 1 cannot read the Worker Design or history; stage 2 only allowlisted evidence with matching SHA', () => {
  const s1 = brokerFor(1).broker;
  assert.equal(s1.read({ resource: 'design', ref: 'design', start: 1, end: 5 }).reason, 'RESOURCE_FORBIDDEN');
  assert.equal(s1.read({ resource: 'allowlistedReview', ref: 'c-1' }).reason, 'RESOURCE_FORBIDDEN');
  assert.equal(s1.search({ scope: 'allowlistedReview', query: 'DESIGN-HINT' }).reason, 'RESOURCE_FORBIDDEN');
  assert.equal(s1.read({ resource: 'plan', ref: 'plan', start: 1, end: 5 }).ok, true);
  const s2 = brokerFor(2).broker;
  assert.equal(s2.read({ resource: 'design', ref: 'design', start: 1, end: 5 }).ok, true);
  assert.equal(s2.read({ resource: 'allowlistedReview', ref: 'c-1', start: 1, end: 1 }).ok, true);
  assert.equal(s2.read({ resource: 'allowlistedReview', ref: 'c-2', start: 1, end: 1 }).reason, 'NOT_ALLOWLISTED_OR_SHA_MISMATCH');
  const forged = brokerFor(2, makeLargeFixture(), { evidence: [{ id: 'c-3', sha256: 'f'.repeat(64) }] });
  forged.resources.reviews['c-3'] = 'tampered';
  assert.equal(forged.broker.read({ resource: 'allowlistedReview', ref: 'c-3', start: 1, end: 1 }).reason, 'NOT_ALLOWLISTED_OR_SHA_MISMATCH');
});

test('F5: Plan/Design version drift is rejected', () => {
  const { broker } = brokerFor(2);
  assert.equal(broker.read({ resource: 'design', ref: 'design', start: 1, end: 5, expectSha: 'e'.repeat(64) }).reason, 'VERSION_DRIFT');
  assert.equal(broker.read({ resource: 'plan', ref: 'plan', start: 1, end: 5, expectSha: 'e'.repeat(64) }).reason, 'VERSION_DRIFT');
});

test('F6: settled steps are reused after restart; a dispatched-but-unsettled step is never re-sent or assumed free', async () => {
  let calls = 0;
  const dispatch = async () => { calls += 1; return { ok: calls }; };
  const s = createSession();
  assert.deepEqual((await s.runStep('step-1', { action: 'READ', reason: 'r1' }, dispatch)).result, { ok: 1 });
  const restarted = createSession(JSON.parse(JSON.stringify(s.state)));
  const again = await restarted.runStep('step-1', { action: 'READ', reason: 'r1' }, dispatch);
  assert.equal(again.reused, true);
  assert.equal(calls, 1);
  // crash between persist and settle: the state says DISPATCHED
  const crashed = createSession({ findings: {}, covered: [], steps: { 'step-2': { status: 'DISPATCHED' } }, spent: 1, noProgress: {} });
  const r = await crashed.runStep('step-2', { action: 'READ', reason: 'r2' }, dispatch);
  assert.equal(r.stop, 'UNKNOWN_SPEND');
  assert.equal(calls, 1);
});

test('F6: step cap and repeated no-progress stop the loop; spend never exceeds one unit per paid step', async () => {
  const s = createSession();
  for (let i = 0; i < CANDIDATE_LIMITS.maxSteps; i += 1) await s.runStep(`s${i}`, { action: `A${i}`, reason: 'r' }, async () => 1);
  assert.equal(s.state.spent, CANDIDATE_LIMITS.maxSteps);
  assert.equal((await s.runStep('over', { action: 'A', reason: 'r' }, async () => 1)).stop, 'STEP_BUDGET');
  const t = createSession();
  await t.runStep('a', { action: 'READ', reason: 'same', newEvidence: false }, async () => 1);
  assert.equal((await t.runStep('b', { action: 'READ', reason: 'same', newEvidence: false }, async () => 1)).stop, 'NO_PROGRESS');
  assert.equal(t.state.spent, 1);
});

test('F8: comparison table reports measured metrics and keeps unverified items explicit', () => {
  const r = compareRoutes(makeLargeFixture({ sourceTotalBytes: 48 * 1024 }));
  for (const route of [r.A, r.B, r.C]) {
    for (const k of ['calls', 'peakPromptBytes', 'totalSentBytes', 'estimatedTokens', 'searches', 'reads', 'checkpointBytes', 'unverifiedCriticalClaims']) {
      assert.equal(typeof route[k], 'number', `${route.route}.${k}`);
    }
  }
  assert.ok(NOT_VERIFIED.some((n) => /provider semantic review quality/.test(n)));
  assert.ok(NOT_VERIFIED.some((n) => /tool support/.test(n)));
});

// ------------------------------------------------------------- Domain A (F7)
const AUTH = readFileSync(new URL('../engineering/authorization.md', import.meta.url), 'utf8');
const section = AUTH.split(/^## 5\. /m)[1]?.split(/^## 6\. /m)[0] ?? '';
const TAIL = '本决策来自 Jack，由 AI 根据 Jack 的明确指示代为整理和发布。';

test('F7/AC-01..05: authorization.md defines decision provenance once, with the verbatim tail and five source kinds', () => {
  assert.ok(section.includes(TAIL));
  for (const kind of ['Jack 已决定', 'Jack 委托 AI 发布', 'AI 建议，待 Jack 确认', '独立 Reviewer 原始意见', '他人转贴']) assert.ok(section.includes(kind), kind);
  assert.match(section, /不自动扩大[^。]*具体 AC[^。]*Code[^。]*人工例外[^。]*merge/);
  assert.match(section, /来源标记与 GitHub author 都不是机器可信的授权凭证/);
  assert.match(section, /不是审批系统/);
});

test('F7/AC-03: the tail and author cannot lift any high-impact stop (the stops stay in §3/§4)', () => {
  for (const stop of ['HUMAN_REQUIRED', 'Design PASS', '人工例外', 'Code', 'merge', '部署', '权限']) assert.ok(section.includes(stop), stop);
  assert.match(section, /Jack 在当前对话里亲自、单独授权/);
});

test('F7/AC-05: other manuals reference the provenance rule and never repeat the verbatim tail', () => {
  for (const f of ['README.md', 'lead.md', 'architect.md', 'task-spec.md', 'reviewer.md', 'chatgpt.md', 'handoff.md', 'contracts.md']) {
    const body = readFileSync(new URL(`../engineering/${f}`, import.meta.url), 'utf8');
    assert.equal(body.includes(TAIL), false, `${f} must not redefine the tail`);
  }
  assert.match(readFileSync(new URL('../engineering/handoff.md', import.meta.url), 'utf8'), /authorization\.md` §5/);
});
