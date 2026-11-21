// Standard HUMAN_REQUIRED report (Design d1 §4.1/4.2) and its wiring.
// Zero provider calls: every model call is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  HEADLINE_MAX,
  buildHumanRequiredReport,
  classify,
  safeBuildHumanRequiredReport,
} from '../src/reviewloop/humanRequiredReport.js';
import { reviewStatusLine } from '../src/reviewloop/statusLine.js';
import { toolResultContent } from '../src/mcp/reviewloopMcpServer.js';
import { acknowledgeTokenAnomaly } from '../src/reviewloop/tokenAnomalyAck.js';
import { authorizeRereview } from '../src/reviewloop/rereviewAuthorization.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, RoleRouter, QuotaPoolRegistry, ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { MemoryPersistence, finding } from './helpers/reviewLoopHarness.js';

void DEFAULT_ROLE_POLICY;

const loopOf = (over = {}) => ({
  loopId: 'rl-x', state: 'HUMAN_REQUIRED', round: 3, objective: { taskType: 'code', mode: 'LOCAL' },
  history: [], ...over,
});
const withReason = (reason, over = {}) => loopOf({
  history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason, round: 3 }], ...over,
});
const REQUIRED_KEYS = ['version', 'category', 'headline', 'status', 'anomaly', 'causes', 'evidenceChecked',
  'evidenceGaps', 'impact', 'fixOptions', 'recommended', 'humanDecision', 'reportText'];

function assertComplete(r) {
  for (const k of REQUIRED_KEYS) assert.ok(r[k] !== undefined && r[k] !== null, `missing ${k}`);
  assert.ok(CATEGORIES.includes(r.category));
  assert.ok(r.headline.length > 0 && r.headline.length <= HEADLINE_MAX && !/\n/.test(r.headline));
  assert.ok(r.causes.confirmed.length + r.causes.probable.length + r.causes.unknown.length > 0);
  assert.ok(r.humanDecision.choices.length > 0);
  assert.ok(r.fixOptions.length > 0 && r.recommended);
  for (const part of ['发生了什么', '原因与证据', '影响范围', '修复方案', '推荐', '需要你决定']) {
    assert.ok(r.reportText.includes(part), `reportText lacks ${part}`);
  }
}

// One fixture per HUMAN_REQUIRED exit family listed in Design F5.
const EXITS = [
  ['TASK_DEFINITION', 'phase plan exceeds the bounded task-definition limit', {}],
  ['ATTRIBUTION_INCOMPLETE', 'baseline attribution incomplete', {}],
  ['ATTRIBUTION_INCOMPLETE', 'the deterministic Gate ran and the post-Gate Worker delta could not be re-collected safely: x', {}],
  ['CANCELLED', 'review cancelled by caller', {}],
  ['REVIEW_FAILED', 'review failed: transport timeout', { history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'review failed: transport timeout', round: 3, at: 'T', cause: { v: 1, kind: 'REVIEW_TOOL_FAILED', source: 'ENGINE', resume: 'HUMAN_AUTHORIZATION' } }] }],
  ['DESIGN_ROUNDS', 'design review round budget (3) is spent', {}],
  ['CONVERGENCE_EXHAUSTED', 'review did not converge', { budgetExhausted: true }],
  ['SUPERVISOR_ESCALATION', 'supervisor recommends human decision', { history: [{ from: 'SUPERVISING', to: 'HUMAN_REQUIRED', reason: 'supervisor recommends human decision', round: 3, at: 'T' }] }],
  ['UNACCOUNTED_SPEND', 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED (x)', {}],
  ['SPEND_CEILING', 'model spend blocked: SPEND_DENIED usage-volume ceiling', {}],
  ['CALL_CEILING', 'model spend blocked: reviewer call ceiling reached', {}],
  ['TOKEN_SENTINEL', 'model spend blocked: MODEL_SPEND_TOKEN_ANOMALY_BLOCKED (x)', {}],
  ['NO_NEW_INFORMATION', 'ReviewLoop model spend blocked: no fresh, unconsumed, eligible New Information evidence justifies a reviewer call', {}],
  ['OTHER', 'something nobody anticipated', {}],
];

test('every HUMAN_REQUIRED exit family gets a category and a complete report (AC01/AC08)', () => {
  for (const [cat, reason, over] of EXITS) {
    const loop = withReason(reason, over);
    const report = buildHumanRequiredReport({ loopId: 'rl-x', loop, workflow: { reviewLoop: loop } });
    assert.equal(report.category, cat, reason);
    assertComplete(report);
  }
});

test('OTHER lists what was checked, the gap and a minimal next step — never a bare "unknown" (AC08)', () => {
  const loop = withReason('something nobody anticipated');
  const r = buildHumanRequiredReport({ loopId: 'rl-x', loop, workflow: { reviewLoop: loop } });
  assert.equal(r.category, 'OTHER');
  assert.ok(r.evidenceChecked.length >= 2);
  assert.ok(r.evidenceGaps.length >= 1);
  assert.match(r.fixOptions.join(' '), /reviewloop profile --loop rl-x/);
  assert.ok(r.reportText.includes('something nobody anticipated'));
});

test('an empty reason still yields a report with an explicit gap', () => {
  const loop = loopOf();
  const r = buildHumanRequiredReport({ loopId: 'rl-x', loop, workflow: { reviewLoop: loop } });
  assertComplete(r);
  assert.ok(r.evidenceGaps.some((g) => /没有记录停止原因/.test(g)));
});

// ---- Token Sentinel diagnosis ---------------------------------------------

const call = (over = {}) => ({
  role: 'reviewer', family: 'agy:opus', provider: 'agy', model: 'm', usageKnown: true, usageVolume: 5000,
  usageAccounting: { volumeResolved: true, semanticsKnown: true }, contextOverheadTokens: 1000,
  usageBreakdown: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
  payloadMeta: { promptChars: 20000, estimatedPayloadTokens: 5000, promptComponentStats: { diffChars: 12000, contractChars: 6000 } },
  costKnown: false, businessOutcome: 'SUCCESS', reservationId: 'r1', ...over,
});
const sentinelWorkflow = (records, latchOver = {}) => ({
  reviewLoop: withReason('model spend blocked: MODEL_SPEND_TOKEN_ANOMALY_BLOCKED (x)'),
  reviewLoopSpend: { records },
  reviewLoopTokenAnomaly: {
    tripped: true, at: '2026-11-20T00:00:00.000Z', role: 'reviewer', family: 'agy:opus', provider: 'agy',
    resolvedModel: 'm', trigger: 'CONTEXT_OVERHEAD', usageVolume: 40000, contextOverheadTokens: 33217,
    threshold: 30000, ...latchOver,
  },
});
const reportOf = (workflow) => buildHumanRequiredReport({ loopId: 'rl-x', loop: workflow.reviewLoop, workflow });

test('33,217 vs 30,000: trigger facts are exact, the cause is NOT invented (AC02)', () => {
  const r = reportOf(sentinelWorkflow([])); // latch only, no call metadata at all
  assert.equal(r.category, 'TOKEN_SENTINEL');
  assert.equal(r.anomaly.value, 33217);
  assert.equal(r.anomaly.threshold, 30000);
  assert.equal(r.anomaly.excess, 3217);
  assert.match(r.reportText, /33,217/);
  assert.match(r.reportText, /3,217/);
  assert.match(r.reportText, /代理指标/);
  assert.equal(r.causes.probable.length, 0, 'no probable cause without call evidence');
  assert.ok(r.causes.unknown.length > 0);
  assert.ok(r.evidenceGaps.some((g) => /无法把哨兵记录对应到具体的调用记录|无法读取/.test(g)));
  // model/family appear only as background, never as the stated cause
  assert.match(r.reportText, /仅为背景，不等于根因/);
  assert.equal(r.causes.probable.some((p) => /agy|opus/.test(p.text)), false);
});

test('complete metadata: breakdown, top components, peer comparison and a probable (estimated) attribution (AC03)', () => {
  const trig = call({
    usageVolume: 40000, contextOverheadTokens: 33217,
    usageBreakdown: { inputTokens: 40000, outputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 0 },
    payloadMeta: { promptChars: 150000, estimatedPayloadTokens: 38000, promptComponentStats: { diffChars: 100000, contractChars: 40000, gateChars: 500, extra: 'ignored' } },
    reservationId: 'r9',
  });
  const r = reportOf(sentinelWorkflow([call({ reservationId: 'a' }), call({ reservationId: 'b' }), trig]));
  const text = r.reportText;
  assert.match(text, /模型报告的用量：输入 40,000/);
  assert.match(text, /最大的 3 个组成（字符数，非 Token）：diff 100,000，contract 40,000/);
  assert.match(text, /中位数为 1,000，本次约为其 33\.2 倍/);
  assert.equal(r.causes.probable.length, 1);
  assert.match(r.causes.probable[0].text, /ReviewLoop 发送的内容（估计）/);
  assert.match(r.causes.probable[0].uncertainty, /字符数\/4/);
  assert.ok(r.causes.unknown.some((u) => /提供商内部/.test(u)), 'observability boundary always stated');
});

test('large input vs estimate with cache recorded -> transport/cache stage, still labelled an estimate', () => {
  const trig = call({
    usageVolume: 40000, contextOverheadTokens: 33217,
    usageBreakdown: { inputTokens: 40000, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 0 },
    payloadMeta: { promptChars: 28000, estimatedPayloadTokens: 7000, promptComponentStats: { diffChars: 20000 } },
  });
  const r = reportOf(sentinelWorkflow([trig]));
  assert.match(r.causes.probable[0].text, /传输或缓存环节.*（估计）/);
  assert.ok(r.evidenceGaps.some((g) => /相邻调用不足 2 条/.test(g)));
});

test('insufficient evidence -> only gaps, no attribution; legacy record shape does not crash (AC11)', () => {
  const legacy = { role: 'reviewer', usageKnown: true, usageVolume: 60000, contextOverheadTokens: 33217 };
  const r = reportOf(sentinelWorkflow([legacy]));
  assert.equal(r.causes.probable.length, 0);
  assert.ok(r.evidenceGaps.some((g) => /没有 Prompt 组成统计/.test(g)));
  assert.ok(r.evidenceGaps.some((g) => /提供商未报告/.test(g)));
  assertComplete(r);
});

test('privacy: prompt/diff/credential text planted in the workflow never reaches the report (AC09/I5)', () => {
  const SECRET = 'SECRET-TOKEN-sk-1234567890';
  const w = sentinelWorkflow([call({
    prompt: SECRET, diff: SECRET, apiKey: SECRET,
    payloadMeta: { promptChars: 1, estimatedPayloadTokens: 1, promptComponentStats: { diffChars: 5 }, promptText: SECRET },
  })]);
  w.reviewLoop.objective.contractText = SECRET;
  const r = reportOf(w);
  assert.equal(JSON.stringify(r).includes(SECRET), false);
});

test('long reason text is clipped; a multi-line reason cannot break the single-line headline', () => {
  const loop = withReason(`line1\nline2 ${'x'.repeat(500)}`);
  const r = buildHumanRequiredReport({ loopId: 'rl-x', loop, workflow: { reviewLoop: loop } });
  assert.ok(!r.headline.includes('\n'));
  assert.ok(r.headline.length <= HEADLINE_MAX);
  assert.ok(r.reportText.length < 6000);
});

test('past the standard confirmations the report still offers the command, now asking for a numeric call budget (AC14)', () => {
  const w = sentinelWorkflow([call()]);
  w.reviewLoopTokenAnomalyAcks = [{}, {}, {}];
  const r = reportOf(w);
  assert.match(r.humanDecision.command, /--max-reviewer-calls/);
  assert.doesNotMatch(r.reportText, /不能再次解锁/);
  assert.match(r.reportText, /系统会按这个数字强制执行/);
  assert.match(r.humanDecision.terminate, /^reviewloop stop-loop --loop rl-x/);
});

test('the Token Sentinel report carries the exact copyable recovery command bound to the latch event', () => {
  const r = reportOf(sentinelWorkflow([call()]));
  assert.match(r.humanDecision.command, /^reviewloop acknowledge-token-anomaly --loop rl-x --latch 2026-11-20T00:00:00\.000Z --reason /);
});

test('builder failure degrades to a minimal, still-actionable report (I4)', () => {
  const boom = { get reviewLoopSpend() { throw new Error('read boom'); }, reviewLoopTokenAnomaly: { tripped: true } };
  const r = safeBuildHumanRequiredReport({ loopId: 'rl-x', loop: loopOf(), workflow: boom, result: { reason: 'blocked', round: 2 } });
  assert.equal(r.category, 'OTHER');
  assert.match(r.reportText, /诊断生成失败：read boom/);
  assert.match(r.reportText, /blocked/);
  assertComplete(r);
});

test('the generator is read-only: it never mutates its inputs (I4)', () => {
  const w = sentinelWorkflow([call()]);
  const before = JSON.stringify(w);
  reportOf(w);
  classify({ loop: w.reviewLoop, workflow: w, reason: 'x' });
  assert.equal(JSON.stringify(w), before);
});

// ---- status line / MCP content --------------------------------------------

test('non-HUMAN_REQUIRED status lines are byte-identical to before; HUMAN_REQUIRED adds a single-line cause', () => {
  assert.equal(
    reviewStatusLine({ taskType: 'code', loopId: 'L', round: 2, status: 'REWORK' }),
    '[ReviewLoop | code | 第 2 轮 → REWORK] loopId=L',
  );
  const line = reviewStatusLine({ taskType: 'code', loopId: 'L', round: 2, status: 'HUMAN_REQUIRED', headline: 'a\nb  c' });
  assert.equal(line, '[ReviewLoop | code | 第 2 轮 → HUMAN_REQUIRED] loopId=L｜a b c');
});

test('toolResultContent appends reportText as its own block and keeps indexes 0/1', () => {
  const blocks = toolResultContent({ status: 'HUMAN_REQUIRED', statusLine: 'S', reviewRecord: 'R', reportText: 'REPORT' });
  assert.equal(blocks[0].text, 'S');
  assert.match(blocks[1].text, /"status": "HUMAN_REQUIRED"/);
  assert.deepEqual(blocks.slice(2).map((b) => b.text), ['R', 'REPORT']);
  assert.equal(toolResultContent({ status: 'X' }).length, 1);
});

// ---- end to end through the real controller --------------------------------

function e2eController({ persistence, usage, delta = { fingerprint: 'd', diff: 'x' } }) {
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const resolver = (family) => ({
    requestedFamily: family, resolvedModel: `${family}-rt`, provider: family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: false, supportedEfforts: ['medium'] },
  });
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  return createReviewLoopController({
    persistence,
    env: {}, // default Sentinel limits regardless of the ambient settings
    routeReviewerFn: (signals) => {
      const s = router.route('reviewer', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    reviewerFn: async ({ selection }) => ({ value: { findings: [finding('P3')] }, usage: usage(), model: selection.model }),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: delta.fingerprint, diff: delta.diff, changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
}

test('controller: HUMAN_REQUIRED carries report + cause in statusLine; human acknowledgement continues the SAME loop without a PASS (AC01/AC05/AC12)', async () => {
  const persistence = new MemoryPersistence();
  let big = true;
  const delta = { fingerprint: 'd', diff: 'x' };
  const controller = e2eController({
    persistence, delta, usage: () => (big ? { input_tokens: 200000, output_tokens: 0 } : { input_tokens: 100, output_tokens: 10 }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });

  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(r.humanRequiredReport.category, 'TOKEN_SENTINEL');
  assert.match(r.statusLine, /→ HUMAN_REQUIRED\] loopId=.+｜Token 安全哨兵/);
  assert.ok(!r.statusLine.includes('\n'));
  assert.equal(r.reportText, r.humanRequiredReport.reportText);
  assert.match(r.reportText, /200,000/);
  assert.equal(toolResultContent(r).some((b) => b.text === r.reportText), true);
  // facts agree across status line, structured report and text (AC01)
  assert.equal(r.statusLine.endsWith(r.humanRequiredReport.headline), true);

  const wf = await persistence.readWorkflowState(loopId);
  const before = JSON.stringify({ spend: wf.reviewLoopSpend, loop: wf.reviewLoop, objective: wf.reviewLoop.objective });
  // the recovery command in the report is bound to this very latch
  assert.ok(r.humanRequiredReport.humanDecision.command.includes(wf.reviewLoopTokenAnomaly.at));

  await acknowledgeTokenAnomaly({ persistence, loopId, latchAt: wf.reviewLoopTokenAnomaly.at, reason: 'checked the report' });
  const wf2 = await persistence.readWorkflowState(loopId);
  assert.equal(JSON.stringify({ spend: wf2.reviewLoopSpend, loop: wf2.reviewLoop, objective: wf2.reviewLoop.objective }), before);

  big = false;
  // Identical evidence is still refused by the independent no-new-information
  // gate: the acknowledgement must NOT bypass it (AC06).
  const same = await controller.review({ loopId });
  assert.equal(same.status, 'HUMAN_REQUIRED');
  assert.equal(same.humanRequiredReport.category, 'NO_NEW_INFORMATION');
  // The Worker changes the code (what the report asked for) -> normal review resumes.
  delta.fingerprint = 'd2'; delta.diff = 'y';
  // Changed content alone does NOT release a hard stop: the call is refused read-only.
  const refused = await controller.review({ loopId });
  assert.equal(refused.status, 'HUMAN_REQUIRED');
  assert.equal(refused.hardStop, true);
  assert.ok(refused.submissionDigest);
  await authorizeRereview({ persistence, loopId, submission: refused.submissionDigest, reason: 'code was changed as the report asked' });
  const r2 = await controller.review({ loopId });
  assert.equal(r2.loopId, loopId);
  assert.notEqual(r2.status, 'PASS');
  assert.notEqual(r2.status, 'HUMAN_REQUIRED', `continued normally, got ${r2.status}: ${r2.reason}`);
  assert.equal(r2.statusLine.includes('｜'), false, 'non-HUMAN_REQUIRED status line has no cause suffix');
  assert.equal(r2.reportText, undefined);
});

test('controller: without a human acknowledgement the loop stays blocked (AC04)', async () => {
  const persistence = new MemoryPersistence();
  const controller = e2eController({ persistence, usage: () => ({ input_tokens: 200000, output_tokens: 0 }) });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await controller.review({ loopId });
  const again = await controller.review({ loopId });
  assert.equal(again.status, 'HUMAN_REQUIRED');
  assert.equal(again.humanRequiredReport.category, 'TOKEN_SENTINEL');
});
