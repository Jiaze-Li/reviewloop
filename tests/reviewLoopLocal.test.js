import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';

test('begin captures an immutable objective + baseline with zero model calls', async () => {
  const { controller, calls } = makeHarness();
  const res = await controller.begin({ goal: 'add feature X', cwd: '/repo' });
  assert.equal(res.status, 'READY');
  assert.equal(res.mode, 'LOCAL');
  assert.equal(res.baseline.head, 'BASE');
  assert.equal(calls.reviewer, 0);
  assert.equal(calls.supervisor, 0);
  assert.ok(res.loopId.startsWith('rl-'));
});

test('clean first pass: Gate PASS + Reviewer clean -> PASS, reviewer=1 supervisor=0', async () => {
  const { controller, calls } = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: 'x', changedFiles: ['a.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'g1' }],
    reviews: [{ findings: [finding('P3')] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(calls.reviewer, 1);
  assert.equal(calls.supervisor, 0);
  assert.equal(r.telemetry.reviewerCalls, 1);
  assert.equal(r.telemetry.workerUsage, 'external / not observable by ReviewLoop');
});

test('P3-only findings do not block: PASS', async () => {
  const { controller } = makeHarness({ reviews: [{ findings: [finding('P3'), finding('P3', 'b.js')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
});

test('Gate regression -> REWORK directly, reviewer=0 supervisor=0', async () => {
  const { controller, calls } = makeHarness({
    gates: [{ verdict: 'FAIL', fingerprint: 'gf', failureIdentities: ['test:foo'] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'REWORK');
  assert.equal(calls.reviewer, 0);
  assert.equal(calls.supervisor, 0);
});

test('ordinary Reviewer P1/P2 -> REWORK, supervisor=0 on first occurrence', async () => {
  const { controller, calls } = makeHarness({ reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'REWORK');
  assert.equal(r.blockingFindings.length, 1);
  assert.equal(calls.supervisor, 0);
  assert.match(r.nextAction, /same session/);
});

test('persistent blocker triggers Supervisor and opens a supervised epoch instead of round-3 HUMAN_REQUIRED', async () => {
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'a', changedFiles: ['a.js'] },
      { fingerprint: 'd2', diff: 'b', changedFiles: ['a.js'] },
      { fingerprint: 'd3', diff: 'c', changedFiles: ['a.js'] },
    ],
    gates: [{ verdict: 'PASS', fingerprint: 'g1' }, { verdict: 'PASS', fingerprint: 'g2' }, { verdict: 'PASS', fingerprint: 'g3' }],
    reviews: [
      { findings: [finding('P1', 'a.js', 'same bug')] },
      { findings: [finding('P1', 'a.js', 'same bug')] },
      { findings: [finding('P1', 'a.js', 'same bug')] },
    ],
    supervisorReplies: [{ guidance: 'refactor the parser', recommendation: 'REWORK' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(calls.supervisor, 0);
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK');
  assert.equal(calls.supervisor, 1);
  assert.equal(r2.supervisorGuidance, 'refactor the parser');
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'REWORK');
  assert.equal(r3.convergenceEpoch, 1);
  assert.equal(r3.epochReviewRound, 1);
  assert.equal(calls.supervisor, 1, 'first supervised epoch does not immediately re-escalate on its first review');
});

test('no new information: identical delta + gate -> no Reviewer/Supervisor call', async () => {
  const { controller, calls } = makeHarness({
    deltas: [{ fingerprint: 'SAME', diff: 'x', changedFiles: ['a.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'SAMEGATE' }],
    reviews: [{ findings: [finding('P1')] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await controller.review({ loopId });
  assert.equal(calls.reviewer, 1);
  const again = await controller.review({ loopId });
  assert.equal(again.status, 'NO_PROGRESS');
  assert.equal(calls.reviewer, 1);
  assert.equal(calls.supervisor, 0);
});

test('immutable objective cannot be weakened on resume', async () => {
  const { controller, persistence } = makeHarness({ reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'big original goal', cwd: '/r', blockingSeverities: ['P1', 'P2'] });
  // tamper with the persisted objective
  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.objective.blockingSeverities = ['P1'];
  raw.reviewLoop.objective.goal = 'tiny goal';
  await persistence.writeWorkflowState(loopId, raw);
  await assert.rejects(() => controller.review({ loopId }), /ReviewObjective weakened/);
});

test('legacy SuperGPT workflow snapshot is not silently resumed', async () => {
  const { controller, persistence } = makeHarness();
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await persistence.writeWorkflowState(loopId, {
    reviewLoop: { workflowStatus: 'EXECUTING', stage: 'EXECUTOR', taskIndex: 1, executorModel: 'sonnet' },
  });
  await assert.rejects(() => controller.review({ loopId }), /legacy SuperGPT/);
});

test('the architecture has no operation that spawns a repair Worker', async () => {
  const mod = await import('../src/reviewloop/controller.js');
  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/reviewloop/controller.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /spawn.*[Ww]orker|createExecutor|claudeSessionManager|runRepairTask/);
  assert.equal(typeof mod.createReviewLoopController, 'function');
});
