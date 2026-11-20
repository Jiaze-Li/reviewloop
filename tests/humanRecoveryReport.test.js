// Design d3 §4.3-4.5: every HUMAN_REQUIRED category has a real human exit, the
// supervisor stop is classified honestly, a human action never hides another
// stop, and an unreadable state gets a preserve-the-evidence report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, buildHumanRequiredReport } from '../src/reviewloop/humanRequiredReport.js';
import { acknowledgeTokenAnomaly } from '../src/reviewloop/tokenAnomalyAck.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { makeHarness, finding, MemoryPersistence } from './helpers/reviewLoopHarness.js';

const cli = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
const cliSource = await readFile(cli, 'utf8');
const dispatched = new Set([...cliSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
const T0 = '2026-11-20T01:00:00.000Z';
const T1 = '2026-11-20T02:00:00.000Z';

function loopWith({ reason, from = 'REVIEWING', extra = {} }) {
  return {
    loopId: 'rl-x', state: 'HUMAN_REQUIRED', round: 4, objective: { mode: 'LOCAL', taskType: 'code' },
    history: [{ from, to: 'HUMAN_REQUIRED', reason, round: 4, at: T0 }], ...extra,
  };
}
function report(loop, workflowExtra = {}, env = {}) {
  return buildHumanRequiredReport({ loopId: 'rl-x', loop, workflow: { reviewLoop: loop, ...workflowExtra }, env });
}
const latch = (over = {}) => ({ tripped: true, at: '2026-11-20T00:30:00.000Z', trigger: 'SINGLE_CALL_USAGE', usageVolume: 50000, threshold: 40000, ...over });
const verbsIn = (text) => [...String(text).matchAll(/reviewloop ([a-z-]+) --loop/g)].map((m) => m[1]);

// ---- AC14: every category has a real, executable human path -------------------

const SCENARIOS = {
  TOKEN_SENTINEL: () => report(loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }), { reviewLoopTokenAnomaly: latch() }),
  UNACCOUNTED_SPEND: () => report(loopWith({ reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED' })),
  SPEND_CEILING: () => report(loopWith({ reason: 'model spend blocked: SPEND_DENIED (ReviewLoop usage-volume ceiling reached)' })),
  CALL_CEILING: () => report(loopWith({ reason: 'model spend blocked: SPEND_DENIED (ReviewLoop reviewer call ceiling (2) reached)' })),
  CONVERGENCE_EXHAUSTED: () => report(loopWith({ reason: 'review did not converge', extra: { budgetExhausted: true } })),
  NO_NEW_INFORMATION: () => report(loopWith({ reason: 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED' })),
  ATTRIBUTION_INCOMPLETE: () => report(loopWith({ reason: 'baseline attribution incomplete' })),
  REVIEW_FAILED: () => report(loopWith({ reason: 'review failed: provider timeout' })),
  TASK_DEFINITION: () => report(loopWith({ reason: 'task definition fingerprint mismatch' })),
  SUPERVISOR_ESCALATION: () => report(loopWith({ reason: 'Supervisor says a product decision is needed', from: 'SUPERVISING', extra: { budgetExhausted: true } })),
  CANCELLED: () => report(loopWith({ reason: 'review cancelled by caller' })),
  DESIGN_ROUNDS: () => report(loopWith({ reason: 'design review round budget (3) is spent', extra: { budgetExhausted: true } })),
  RESUME_PENDING: () => report(
    loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }),
    { reviewLoopTokenAnomaly: latch({ tripped: false }), reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at, tier: 'STANDARD' }] },
  ),
  STATE_UNREADABLE: () => buildHumanRequiredReport({
    loopId: 'rl-x', loop: null, workflow: null,
    result: { stateUnreadable: { errorClass: 'SyntaxError', errorMessage: 'Unexpected token', dir: '/runtime/rl-x' } },
  }),
  DESIGN_SOURCE_LIMIT: () => report(loopWith({
    reason: 'critical code facts could not be independently verified within repository/read boundaries',
    extra: { objective: { mode: 'LOCAL', taskType: 'design', reviewTarget: 'Design.md' } },
  })),
  OTHER: () => report(loopWith({ reason: 'zzz nothing matches' })),
};

test('every category is covered by a scenario and classified as expected', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), [...CATEGORIES].sort());
  for (const [category, make] of Object.entries(SCENARIOS)) assert.equal(make().category, category, category);
});

test('AC14: every category offers a real human path and the task can always be ended (except unreadable state, which gets the preserve-evidence path)', () => {
  for (const [category, make] of Object.entries(SCENARIOS)) {
    const r = make();
    assert.ok(r.humanDecision.choices.length >= 1, `${category} has a choice`);
    assert.ok(r.fixOptions.length >= 1, `${category} has a fix path`);
    if (category === 'STATE_UNREADABLE') {
      assert.equal(r.humanDecision.terminate, null, 'nothing can be written to an unreadable record');
      assert.match(r.reportText, /cp -R "\/runtime\/rl-x"/);
      assert.doesNotMatch(r.reportText, /已恢复|原位恢复成功|可原位修复/);
      assert.match(r.reportText, /不承诺能在原位恢复/);
      continue;
    }
    assert.match(r.humanDecision.terminate, /^reviewloop stop-loop --loop rl-x --reason /, category);
    assert.ok(r.reportText.includes(r.humanDecision.terminate), `${category} shows the terminate command`);
    for (const verb of verbsIn(`${r.humanDecision.command ?? ''}\n${r.humanDecision.terminate}`)) {
      assert.ok(dispatched.has(verb), `${category}: "reviewloop ${verb}" is a real CLI command`);
    }
  }
});

test('category-specific commands are the right ones (call ceiling -> extend-calls, not a global setting)', () => {
  assert.match(SCENARIOS.CALL_CEILING().humanDecision.command, /^reviewloop extend-calls --loop rl-x --reviewer-calls /);
  assert.match(SCENARIOS.CALL_CEILING().fixOptions.join(' '), /只为本任务/);
  assert.match(SCENARIOS.TOKEN_SENTINEL().humanDecision.command, /^reviewloop acknowledge-token-anomaly /);
  assert.match(SCENARIOS.SPEND_CEILING().humanDecision.command, /^reviewloop override-budget /);
  assert.match(SCENARIOS.UNACCOUNTED_SPEND().humanDecision.command, /^reviewloop acknowledge-spend /);
  assert.match(SCENARIOS.CONVERGENCE_EXHAUSTED().humanDecision.command, /^reviewloop reopen-gate /);
});

// ---- AC16: the supervisor's stop --------------------------------------------

test('AC16: a Supervisor HUMAN_REQUIRED (real controller) is a supervisor escalation, not "review did not converge"', async () => {
  const same = { findings: [finding('P2', 'a.js', 'contract conflict')] };
  const h = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: 'one' }, { fingerprint: 'd2', diff: 'two' }],
    reviews: [same, same],
    supervisorReplies: [{ guidance: 'The frozen requirements conflict and require a product decision.', recommendation: 'HUMAN_REQUIRED' }],
  });
  const { loopId } = await h.controller.begin({ goal: 'g', cwd: '/r' });
  await h.controller.review({ loopId });
  const result = await h.controller.review({ loopId });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.budgetExhausted, true, 'the supervisor path also sets the spent-budget flag (the old misclassification trigger)');
  const r = result.humanRequiredReport;
  assert.equal(r.category, 'SUPERVISOR_ESCALATION');
  assert.doesNotMatch(r.recommended, /重新开放关卡即可|单纯重开会解决/);
  assert.match(r.recommended, /产品或范围决定/);
  assert.match(r.reportText, /监督者的结论（节选）：The frozen requirements conflict/);
  assert.match(r.humanDecision.command, /^reviewloop reopen-gate --loop /);
  assert.match(r.humanDecision.terminate, /^reviewloop stop-loop /);
});

// ---- AC06/AC17: a human action never hides another stop ----------------------

const spendWith = (n = 1, usage = 10) => ({ records: Array.from({ length: n }, (_, i) => ({ role: 'reviewer', usageVolume: usage, usageKnown: true, reservationId: `r${i}` })) });

test('AC17(d): the stop was acted on and nothing else blocks -> RESUME_PENDING, no stale command', () => {
  const r = SCENARIOS.RESUME_PENDING();
  assert.equal(r.category, 'RESUME_PENDING');
  assert.match(r.reportText, /已由人工确认（第 1 次/);
  assert.match(r.reportText, /送审内容与上次完全相同会被信息增量规则拦住/);
  assert.equal(r.humanDecision.command, null);
  assert.doesNotMatch(r.reportText, /acknowledge-token-anomaly --loop/);
  assert.match(r.humanDecision.terminate, /stop-loop/);
});

test('AC17(a): budget raised by a human but the convergence budget is still spent -> NOT resume-pending; reopen-gate is offered', () => {
  const loop = loopWith({ reason: 'model spend blocked: SPEND_DENIED (ReviewLoop usage-volume ceiling reached)', extra: { budgetExhausted: true } });
  const r = report(loop, { budgetOverrides: { maxUsageVolume: 900000, history: [{ at: T1 }] }, reviewLoopSpend: spendWith() });
  assert.equal(r.category, 'CONVERGENCE_EXHAUSTED');
  assert.match(r.reportText, /此前已由人工处理：预算上限已由人工提高/);
  assert.match(r.humanDecision.command, /^reviewloop reopen-gate /);
});

test('AC17(b): token stop confirmed but an unsettled call remains -> UNACCOUNTED_SPEND with the acknowledge-spend command', () => {
  const r = report(
    loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }),
    {
      reviewLoopTokenAnomaly: latch({ tripped: false }),
      reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at }],
      modelSpendReservations: { 'orphan-1': { reservationId: 'orphan-1', status: 'UNRESOLVED', role: 'reviewer' } },
    },
  );
  assert.equal(r.category, 'UNACCOUNTED_SPEND');
  assert.match(r.reportText, /Token 哨兵异常已由人工确认/);
  assert.match(r.humanDecision.command, /^reviewloop acknowledge-spend /);
  assert.doesNotMatch(r.reportText, /acknowledge-token-anomaly --loop/);
});

test('AC17(c): token stop confirmed but the call ceiling is reached -> CALL_CEILING with extend-calls', () => {
  const r = report(
    loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }),
    {
      reviewLoopTokenAnomaly: latch({ tripped: false }),
      reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at }],
      reviewLoopSpend: spendWith(2),
    },
    { REVIEWLOOP_MAX_REVIEWER_CALLS: '2' },
  );
  assert.equal(r.category, 'CALL_CEILING');
  assert.match(r.humanDecision.command, /^reviewloop extend-calls /);
});

test('an unsettled call that a human already registered no longer blocks; one still open does (spend-ack path)', () => {
  const stop = loopWith({ reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED (x)' });
  const open = report(stop, { modelSpendReservations: { a: { status: 'UNRESOLVED', role: 'reviewer' } } });
  assert.equal(open.category, 'UNACCOUNTED_SPEND');
  const done = report(stop, { modelSpendReservations: { a: { status: 'UNRESOLVED', role: 'reviewer', humanAcknowledgement: { accepted: true, accountingRecorded: true, acknowledgedAt: T1 } } } });
  assert.equal(done.category, 'RESUME_PENDING');
  assert.match(done.reportText, /已由人工登记为用量未知/);
});

test('if the independent limits cannot be read, the report never claims "nothing blocks": it falls back to OTHER and says so', () => {
  const unreadableOverrides = new Proxy({}, { ownKeys() { throw new Error('unreadable'); } });
  const r = report(
    loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }),
    {
      reviewLoopTokenAnomaly: latch({ tripped: false }),
      reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at }],
      budgetOverrides: unreadableOverrides,
    },
  );
  assert.equal(r.category, 'OTHER');
  assert.notEqual(r.category, 'RESUME_PENDING');
  assert.ok(r.evidenceChecked.some((x) => /读取失败/.test(x)));
});

test('real flow: trip -> confirm -> rebuild shows RESUME_PENDING; a NEW trip is a TOKEN_SENTINEL bound to the new event (AC17)', async () => {
  const persistence = new MemoryPersistence();
  const loop = loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED', extra: {} });
  loop.loopId = 'L';
  loop.history[0].at = '2000-01-01T00:00:00.000Z';
  await persistence.updateWorkflowState('L', { reviewLoop: loop });
  let n = 0;
  const meter = async (spend, usage) => {
    const op = `op-${++n}`;
    const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: op, diffHash: `${op}::G` });
    return spend.meteredCall({
      role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: op, attempt: 1, evidenceIds: [ev.evidenceId],
      call: async () => ({ value: { findings: [] }, usage, model: 'm' }),
    });
  };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await assert.rejects(() => meter(spend, { input_tokens: 40001, output_tokens: 0 }), (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED');
  let wf = await persistence.readWorkflowState('L');
  const first = buildHumanRequiredReport({ loopId: 'L', loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.equal(first.category, 'TOKEN_SENTINEL');
  assert.ok(first.humanDecision.command.includes(wf.reviewLoopTokenAnomaly.at));

  await acknowledgeTokenAnomaly({ persistence, loopId: 'L', latchAt: wf.reviewLoopTokenAnomaly.at, reason: 'reviewed' });
  wf = await persistence.readWorkflowState('L');
  const after = buildHumanRequiredReport({ loopId: 'L', loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.equal(after.category, 'RESUME_PENDING');
  assert.doesNotMatch(after.reportText, /acknowledge-token-anomaly --loop/);

  await new Promise((r) => setTimeout(r, 15));
  const again = createReviewLoopSpend({ loopId: 'L', persistence, env: {} });
  await assert.rejects(() => meter(again, { input_tokens: 40001, output_tokens: 0 }), (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED');
  wf = await persistence.readWorkflowState('L');
  const second = buildHumanRequiredReport({ loopId: 'L', loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.equal(second.category, 'TOKEN_SENTINEL');
  assert.ok(second.humanDecision.command.includes(wf.reviewLoopTokenAnomaly.at));
  assert.ok(!second.humanDecision.command.includes(first.humanDecision.command.match(/--latch (\S+)/)[1]));
});

// ---- AC17: unreadable state ---------------------------------------------------

test('reviewloop_review on an unreadable record returns the standard report, not a raw error (AC17)', async () => {
  const h = makeHarness({ reviews: [{ findings: [] }] });
  const { loopId } = await h.controller.begin({ goal: 'g', cwd: '/r' });
  const callsBefore = { ...h.calls };
  h.persistence.readWorkflowState = async () => { throw new SyntaxError('Unexpected token } in JSON at position 17: {"secret":"PROMPT-TEXT"'); };
  const res = await h.controller.review({ loopId });
  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.equal(res.terminal, true);
  assert.equal(res.humanRequiredReport.category, 'STATE_UNREADABLE');
  assert.match(res.statusLine, /任务状态记录无法读取/);
  assert.match(res.reportText, /不承诺能在原位恢复/);
  assert.deepEqual(h.calls, callsBefore, 'no model or gate work');
});

test('CLI report: corrupt record -> preserve-evidence report with the real path; unknown id -> plain "unknown" (not a migration guide); nothing is modified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-unreadable-'));
  try {
    const dir = path.join(root, 'rl-corrupt');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'workflow.json');
    const garbage = '{"reviewLoop": {"loopId": "rl-corrupt", "secret": "PROMPT-TEXT-SHOULD-NOT-LEAK" ';
    await writeFile(file, garbage);
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: root } });

    const rep = run(['report', '--loop', 'rl-corrupt']);
    assert.equal(rep.status, 0, rep.stderr);
    assert.match(rep.stdout, /任务状态记录无法读取/);
    assert.ok(rep.stdout.includes(`cp -R "${dir}"`), 'the real directory is in the preserve step');
    assert.doesNotMatch(rep.stdout, /PROMPT-TEXT-SHOULD-NOT-LEAK/, 'record content is never printed');
    assert.doesNotMatch(rep.stdout, /stop-loop/);

    const stop = run(['stop-loop', '--loop', 'rl-corrupt', '--reason', 'r']);
    assert.notEqual(stop.status, 0);
    assert.match(stop.stderr, /cannot be read.*reviewloop report --loop rl-corrupt/s);

    const missing = run(['report', '--loop', 'rl-nope']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /unknown loopId rl-nope/);
    assert.doesNotMatch(missing.stdout + missing.stderr, /cp -R/);

    assert.equal(await readFile(file, 'utf8'), garbage, 'the record was not touched');

    // a workflow with no loop in it is also "cannot be read", not "unknown"
    const dir2 = path.join(root, 'rl-noloop');
    await mkdir(dir2, { recursive: true });
    await writeFile(path.join(dir2, 'workflow.json'), JSON.stringify({ other: 1 }));
    const noloop = run(['report', '--loop', 'rl-noloop']);
    assert.equal(noloop.status, 0, noloop.stderr);
    assert.match(noloop.stdout, /任务状态记录无法读取/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- a call that crossed the dispatch boundary is still a live stop -----------

test('DISPATCHING reservation (sent, never settled) is a live blocker: the report must not say "nothing blocks" (AC06/AC17)', () => {
  const acked = {
    reviewLoopTokenAnomaly: latch({ tripped: false }),
    reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at }],
  };
  const stop = loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' });
  const r = report(stop, { ...acked, modelSpendReservations: { d1: { reservationId: 'd1', status: 'DISPATCHING', role: 'reviewer' } } });
  assert.equal(r.category, 'UNACCOUNTED_SPEND');
  assert.notEqual(r.category, 'RESUME_PENDING');
  assert.match(r.humanDecision.command, /^reviewloop acknowledge-spend /);

  // same for a spend-recovery stop where a human acknowledged one call but another is still DISPATCHING
  const spendStop = loopWith({ reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED (x)' });
  const both = report(spendStop, {
    modelSpendReservations: {
      a: { status: 'UNRESOLVED', role: 'reviewer', humanAcknowledgement: { accepted: true, accountingRecorded: true, acknowledgedAt: T1 } },
      d1: { status: 'DISPATCHING', role: 'reviewer' },
    },
  });
  assert.equal(both.category, 'UNACCOUNTED_SPEND');
});

test('the report agrees with the spend authority on what blocks: acknowledged-and-recorded UNRESOLVED does not, DISPATCHING always does', async () => {
  const { isBlockingReservationStatus, isHumanAcknowledgedUnresolved } = await import('../src/orchestrator/modelSpendReservation.js');
  const cases = [
    [{ status: 'UNRESOLVED' }, true],
    [{ status: 'UNRESOLVED', humanAcknowledgement: { accepted: true, accountingRecorded: true } }, false],
    [{ status: 'UNRESOLVED', humanAcknowledgement: { accepted: true } }, true],
    [{ status: 'DISPATCHING', humanAcknowledgement: { accepted: true, accountingRecorded: true } }, true],
    [{ status: 'RESERVED' }, false],
    [{ status: 'SETTLED_KNOWN' }, false],
    [{ status: 'CANCELLED_PRE_DISPATCH' }, false],
  ];
  const acked = {
    reviewLoopTokenAnomaly: latch({ tripped: false }),
    reviewLoopTokenAnomalyAcks: [{ at: T1, latchAt: latch().at }],
  };
  for (const [rv, blocks] of cases) {
    assert.equal(isBlockingReservationStatus(rv.status) && !isHumanAcknowledgedUnresolved(rv), blocks, JSON.stringify(rv));
    const r = report(loopWith({ reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }), { ...acked, modelSpendReservations: { x: { ...rv, role: 'reviewer' } } });
    assert.equal(r.category === 'UNACCOUNTED_SPEND', blocks, `report vs authority for ${JSON.stringify(rv)}`);
    assert.equal(r.category === 'RESUME_PENDING', !blocks, JSON.stringify(rv));
  }
});
