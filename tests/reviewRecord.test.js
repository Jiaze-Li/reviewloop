import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewRecord } from '../src/reviewloop/reviewRecord.js';
import { run, checkHandoff } from '../scripts/check-pr-handoff.js';
import { toolResultContent } from '../src/mcp/reviewloopMcpServer.js';

const h = (to, round, from = 'REVIEWING') => ({ from, to, round });
const loop = (state, history, taskType = 'design') => ({ loopId: 'rl-1', state, objective: { taskType }, history });

test('REWORK -> REWORK -> PASS is listed in order with terminal PASS', () => {
  const r = buildReviewRecord(loop('PASS', [h('REVIEWING', 0, 'READY_FOR_WORK'), h('REWORK', 1), h('REVIEWING', 1, 'REWORK'), h('REWORK', 2), h('REVIEWING', 2, 'REWORK'), h('PASS', 3)]), { status: 'PASS' });
  assert.equal(r, '[ReviewLoop 记录 | design | loopId=rl-1 | 第1轮 REWORK → 第2轮 REWORK → 第3轮 PASS | 终态 PASS]');
});

test('HUMAN_REQUIRED then re-review then PASS (real sample shape)', () => {
  const r = buildReviewRecord(loop('PASS', [h('REVIEWING', 0, 'READY_FOR_WORK'), h('HUMAN_REQUIRED', 1), h('REVIEWING', 1, 'HUMAN_REQUIRED'), h('PASS', 2)]), { status: 'PASS' });
  assert.match(r, /第1轮 HUMAN_REQUIRED → 第2轮 PASS \| 终态 PASS/);
});

test('HUMAN_REQUIRED and FAILED are never shown as PASS', () => {
  const a = buildReviewRecord(loop('HUMAN_REQUIRED', [h('HUMAN_REQUIRED', 1)]), { status: 'HUMAN_REQUIRED' });
  assert.match(a, /终态 HUMAN_REQUIRED/); assert.doesNotMatch(a, /PASS/);
  const b = buildReviewRecord(loop('FAILED', [h('FAILED', 1)]), { status: 'FAILED' });
  assert.match(b, /终态 FAILED/); assert.doesNotMatch(b, /PASS/);
});

test('PHASE_PASS is labelled and the loop is not terminal', () => {
  const r = buildReviewRecord(loop('READY_FOR_WORK', [h('READY_FOR_WORK', 1)]), { status: 'PHASE_PASS' });
  assert.match(r, /第1轮 PHASE_PASS \| 当前 READY_FOR_WORK（未结束）/);
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

test('Gate repair / human reopen REWORK entries are not counted as Reviewer rounds', () => {
  const gate = { from: 'REVIEWING', to: 'REWORK', round: 1, reason: 'gate regression' };
  const drift = { from: 'REVIEWING', to: 'REWORK', round: 1, reason: 'verification plan drift' };
  const human = { from: 'REVIEWING', to: 'REWORK', round: 1, reason: 'human reopen: x' };
  const r = buildReviewRecord(loop('PASS', [gate, drift, human, h('REWORK', 1), h('PASS', 2)]), { status: 'PASS' });
  assert.match(r, /Gate修复 → Gate修复 → 人工重开 → 第1轮 REWORK → 第2轮 PASS \| 终态 PASS/);
  const only = buildReviewRecord(loop('REWORK', [gate]), { status: 'REWORK' });
  assert.doesNotMatch(only, /第\d+轮 REWORK/); assert.match(only, /本次结果 REWORK 未写入历史/);
});

test('handoff check: --stage without a value is a usage error, never a pass', () => {
  assert.equal(run(['5', '--stage'], gh({ headRefOid: SHA, body: body() })).code, 2);
});

test('tagged non-Reviewer REWORK (e.g. evidence rework) is not a Reviewer round', () => {
  const ev = { from: 'REVIEWING', to: 'REWORK', round: 1, reason: 'artifact evidence changed…', source: 'non-reviewer' };
  const r = buildReviewRecord(loop('REWORK', [ev]), { status: 'REWORK' });
  assert.match(r, /非审查返工/); assert.doesNotMatch(r, /第\d+轮 REWORK/);
});

test('every non-Reviewer REWORK call site in the controller carries the tag; untagged ones are Reviewer decisions', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../src/reviewloop/${f}`, import.meta.url), 'utf8');
  const tag = /\{ source: 'non-reviewer' \}/;
  const ctl = read('controller.js');
  for (const reason of ["'gate regression'", "'verification plan drift'"]) {
    assert.match(ctl, new RegExp(`REWORK, ${reason}, \\{ source: 'non-reviewer' \\}\\)`));
  }
  assert.match(ctl, /REWORK, reason, \{ source: 'non-reviewer' \}\)/); // evidenceRework
  assert.match(read('budgetOverride.js'), /human budget override: \$\{reason\}`, \{ source: 'non-reviewer' \}\)/);
  assert.match(read('gateReopen.js'), /human reopen: \$\{reason\}`, \{ source: 'non-reviewer' \}\)/);
  // Any other REWORK call site must be an explicit Reviewer/Supervisor decision (reviewed list).
  const allowed = /decision\.reason|design differs materially|design adjudication found blocking defects/;
  for (const f of ['controller.js', 'budgetOverride.js', 'gateReopen.js']) {
    for (const m of read(f).matchAll(/recordTransition\(\w+, REVIEW_LOOP_STATES\.REWORK, ([^\n]+)\);/g)) {
      if (!tag.test(m[1])) assert.match(m[1], allowed, `untagged REWORK reason not in the reviewed list: ${m[1]}`);
    }
  }
});
