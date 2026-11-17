import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewRecord } from '../src/reviewloop/reviewRecord.js';
import { run, checkHandoff } from '../scripts/check-pr-handoff.js';
import { toolResultContent } from '../src/mcp/reviewloopMcpServer.js';

const h = (to, round, from = 'REVIEWING') => ({ from, to, round });
const loop = (state, history, taskType = 'design') => ({ loopId: 'rl-1', state, objective: { taskType }, history });

test('REWORK -> REWORK -> PASS is listed in order with terminal PASS', () => {
  const r = buildReviewRecord(loop('PASS', [h('REVIEWING', 0, 'READY_FOR_WORK'), h('REWORK', 1), h('REVIEWING', 1, 'REWORK'), h('REWORK', 2), h('REVIEWING', 2, 'REWORK'), h('PASS', 3)]), { status: 'PASS' });
  assert.equal(r, '[ReviewLoop 记录 | design | loopId=rl-1 | REWORK@已审1轮 → REWORK@已审2轮 → PASS@已审3轮 | 终态 PASS | 条目含 Gate 修复与人工操作，不等于审查轮数]');
});

test('HUMAN_REQUIRED then re-review then PASS (real sample shape)', () => {
  const r = buildReviewRecord(loop('PASS', [h('REVIEWING', 0, 'READY_FOR_WORK'), h('HUMAN_REQUIRED', 1), h('REVIEWING', 1, 'HUMAN_REQUIRED'), h('PASS', 2)]), { status: 'PASS' });
  assert.match(r, /HUMAN_REQUIRED@已审1轮 → PASS@已审2轮 \| 终态 PASS/);
});

test('HUMAN_REQUIRED and FAILED are never shown as PASS', () => {
  const a = buildReviewRecord(loop('HUMAN_REQUIRED', [h('HUMAN_REQUIRED', 1)]), { status: 'HUMAN_REQUIRED' });
  assert.match(a, /终态 HUMAN_REQUIRED/); assert.doesNotMatch(a, /PASS/);
  const b = buildReviewRecord(loop('FAILED', [h('FAILED', 1)]), { status: 'FAILED' });
  assert.match(b, /终态 FAILED/); assert.doesNotMatch(b, /PASS/);
});

test('PHASE_PASS is labelled and the loop is not terminal', () => {
  const r = buildReviewRecord(loop('READY_FOR_WORK', [h('READY_FOR_WORK', 1)]), { status: 'PHASE_PASS' });
  assert.match(r, /PHASE_PASS@已审1轮 \| 当前 READY_FOR_WORK（未结束）/);
});

test('status not present in history is flagged, not invented', () => {
  const r = buildReviewRecord(loop('REWORK', [h('REWORK', 1)]), { status: 'NO_PROGRESS' });
  assert.match(r, /本次结果 NO_PROGRESS 未写入历史/);
});

test('missing / corrupt history says 记录不完整 and never PASS', () => {
  assert.match(buildReviewRecord(loop('PASS', undefined), { status: 'PASS' }), /记录不完整/);
  assert.match(buildReviewRecord(null, { loopId: 'x', status: 'PASS' }), /记录不完整/);
  assert.match(buildReviewRecord(loop('REWORK', [null, { to: 5 }, h('REWORK', 1)]), { status: 'REWORK' }), /记录不完整: 有损坏/);
});

test('record is a third block; statusLine and JSON keep positions 0 and 1', () => {
  const c = toolResultContent({ status: 'REWORK', statusLine: 'S', reviewRecord: 'R' });
  assert.deepEqual(c.map((b) => b.text === 'S' || b.text === 'R'), [true, false, true]);
  assert.equal(c[0].text, 'S'); assert.equal(JSON.parse(c[1].text).status, 'REWORK'); assert.equal(c[2].text, 'R');
});

const SHA = 'a'.repeat(40);
const body = (sha = SHA, stage = 'code') => `<!-- reviewloop-handoff head=${sha} stage=${stage} loop=rl-1 -->\n做了什么: x\n验收清单: y\n已验证: z\n风险: w`;
const gh = (d) => () => d;

test('handoff check: good sample passes with the not-a-review-PASS wording', () => {
  const r = run(['5', '--stage', 'code'], gh({ headRefOid: SHA, body: body() }));
  assert.equal(r.code, 0); assert.match(r.out, /不代表审查 PASS/);
});

test('handoff check: marker, HEAD, stage and section failures are non-zero', () => {
  assert.equal(run(['5'], gh({ headRefOid: SHA, body: '做了什么 验收清单 已验证 风险' })).code, 1);
  assert.match(run(['5'], gh({ headRefOid: 'b'.repeat(40), body: body() })).out, /不是 PR 当前 HEAD/);
  assert.match(run(['5', '--stage', 'design'], gh({ headRefOid: SHA, body: body() })).out, /阶段 code 与要求的 design 不符/);
  assert.match(run(['5'], gh({ headRefOid: SHA, body: body().replace('风险: w', '') })).out, /缺少「风险」/);
  assert.match(checkHandoff({ headRefOid: SHA, body: null }).join(), /缺少 reviewloop-handoff/);
});

test('handoff check: unreadable PR or bad args never reports success', () => {
  const boom = () => { throw new Error('no gh'); };
  const r = run(['5'], boom); assert.equal(r.code, 3); assert.match(r.out, /无法核实/);
  assert.equal(run(['x']).code, 2);
  assert.equal(run(['5', '--stage', 'nope']).code, 2);
});

test('handoff check: --stage without a value is a usage error, never a pass', () => {
  assert.equal(run(['5', '--stage'], gh({ headRefOid: SHA, body: body() })).code, 2);
});

test('record never claims entries are Reviewer rounds (no 第N轮 wording, note present)', () => {
  const r = buildReviewRecord(loop('HUMAN_REQUIRED', [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', round: 2, reason: 'baseline attribution incomplete' }]), { status: 'HUMAN_REQUIRED' });
  assert.doesNotMatch(r, /第\d+轮/); assert.match(r, /不等于审查轮数/);
});

test('handoff check: words inside prose, quotes or code do not count as sections', () => {
  const marker = `<!-- reviewloop-handoff head=${SHA} stage=code loop=rl-1 -->`;
  const prose = `${marker}\nThis is unverified and rebuilt, with some risk and acceptance noise.`;
  const r = run(['5'], gh({ headRefOid: SHA, body: prose }));
  assert.equal(r.code, 1);
  for (const n of ['做了什么', '验收清单', '已验证', '风险']) assert.match(r.out, new RegExp(`缺少「${n}」`));
  const fenced = `${marker}\n\`\`\`\n做了什么 验收清单 已验证 风险\n\`\`\``;
  assert.equal(run(['5'], gh({ headRefOid: SHA, body: fenced })).code, 1);
  const real = `${marker}\n**做了什么**\nx\n## Acceptance\ny\n- Verified: z\n**风险与偏离**\nw`;
  assert.equal(run(['5'], gh({ headRefOid: SHA, body: real })).code, 0);
});
