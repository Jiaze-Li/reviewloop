// P3 (RL-REVIEW-RELIABILITY): HUMAN_REQUIRED is an engine-enforced hard stop;
// human re-review authorization; recovery commands that always satisfy their own
// preconditions. Zero real model calls: every provider is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { authorizeRereview, rereviewPrecondition, STANDARD_REREVIEW_GRANTS } from '../src/reviewloop/rereviewAuthorization.js';
import { buildHumanRequiredReport } from '../src/reviewloop/humanRequiredReport.js';
import { restoreHold } from '../src/reviewloop/holdRestore.js';
import { releaseHardStop } from './helpers/humanRelease.js';

function world({ failReviewer = true, gateVerdict = 'PASS' } = {}) {
  const persistence = new MemoryPersistence();
  const calls = { reviewer: 0, gate: 0, delta: 0 };
  const state = { fingerprint: 'DELTA_1', failReviewer, gateVerdict };
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      calls.delta += 1;
      return {
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['a.js'], fingerprint: state.fingerprint, diff: `diff --git a/a.js b/a.js\n+++ b/a.js\n+// ${state.fingerprint}\n`,
      };
    },
    runGateFn: async () => {
      calls.gate += 1;
      return state.gateVerdict === 'PASS'
        ? { verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }
        : { verdict: 'FAIL', pass: false, fingerprint: `GATE_FAIL_${state.fingerprint}`, failureIdentities: ['t1'], results: [] };
    },
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => {
      calls.reviewer += 1;
      if (state.failReviewer) throw Object.assign(new Error('provider blip'), { code: 'PROVIDER_UNAVAILABLE' });
      return { value: { findings: [] }, usage: { input_tokens: 2, output_tokens: 1 } };
    },
  });
  return { persistence, controller, calls, state };
}

async function stopped(opts) {
  const w = world(opts);
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  const r = await w.controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  return { ...w, loopId };
}
const snapshot = async (w) => JSON.stringify(await w.persistence.readWorkflowState(w.loopId));
const hr = (loop) => [...loop.history].reverse().find((h) => h.to === 'HUMAN_REQUIRED');

// ---- AC-05 ---------------------------------------------------------------------------

test('AC-05: every ordinary review call on a stopped loop is read-only - same content, changed content, repeated, invalid args', async () => {
  const w = await stopped();
  const before = await snapshot(w);
  const callsBefore = { ...w.calls };
  const variants = [
    {}, {}, // identical and repeated
    { evidence: [{ requirementId: 'nope', summary: 'x' }] }, // invalid arguments
    { evidence: 'not-an-array' },
  ];
  for (const v of variants) {
    const r = await w.controller.review({ loopId: w.loopId, ...v });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.equal(r.hardStop, true);
    assert.equal(r.humanRequiredReport.category, 'REVIEW_FAILED');
  }
  w.state.fingerprint = 'DELTA_CHANGED'; // the Worker changed its content
  const changed = await w.controller.review({ loopId: w.loopId });
  assert.equal(changed.hardStop, true, 'changed content alone never releases the stop');
  assert.equal(w.calls.gate, callsBefore.gate, 'zero Gate runs');
  assert.equal(w.calls.reviewer, callsBefore.reviewer, 'zero model calls');
  assert.equal(await snapshot(w), before, 'state, history and spend are byte-identical');
});

test('AC-05: the refusal names the exact command, shows the submission digest, and never recommends a bare Worker retry', async () => {
  const w = await stopped();
  const r = await w.controller.review({ loopId: w.loopId });
  assert.match(r.submissionDigest, /^[0-9a-f]{64}$/);
  assert.ok(r.reportText.includes(`reviewloop authorize-rereview --loop ${w.loopId} --submission ${r.submissionDigest}`));
  assert.ok(!r.reportText.includes('让 Worker 用同一个任务再次发起审查'));
});

// ---- AC-06 ---------------------------------------------------------------------------

test('AC-06: a grant releases exactly one submission, once; upgrading the tool changes nothing', async () => {
  const w = await stopped();
  const refused = await w.controller.review({ loopId: w.loopId });
  const grantAt = await authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: refused.submissionDigest, reason: 'provider recovered' });
  assert.equal(grantAt.grants, 1);
  const wf = await w.persistence.readWorkflowState(w.loopId);
  assert.equal(wf.reviewLoop.rereviewGrants[0].stopAt, hr(wf.reviewLoop).at);
  assert.equal(wf.reviewLoop.rereviewGrants[0].consumedAt, null);
  assert.equal(wf.reviewLoop.state, 'HUMAN_REQUIRED', 'authorizing alone does not run anything');

  w.state.failReviewer = false;
  const r = await w.controller.review({ loopId: w.loopId });
  assert.notEqual(r.hardStop, true);
  assert.equal(r.status, 'PASS');
  assert.equal(w.calls.reviewer >= 2, true);
  const after = (await w.persistence.readWorkflowState(w.loopId)).reviewLoop;
  assert.ok(after.rereviewGrants[0].consumedAt, 'the grant was consumed by the paid review');
  assert.equal(after.history.length >= wf.reviewLoop.history.length, true, 'history only grew');
});

test('AC-06: a grant for other content, an older stop, or a consumed grant releases nothing', async () => {
  const w = await stopped();
  const refused = await w.controller.review({ loopId: w.loopId });
  // wrong submission digest
  await authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: 'a'.repeat(64), reason: 'wrong content' });
  const r1 = await w.controller.review({ loopId: w.loopId });
  assert.equal(r1.hardStop, true, 'a grant for different content does not release this content');
  // right digest, then the content changes before the Worker re-calls
  await authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: refused.submissionDigest, reason: 'right content' });
  w.state.fingerprint = 'DELTA_2';
  const r2 = await w.controller.review({ loopId: w.loopId });
  assert.equal(r2.hardStop, true, 'a grant never extends to later, different content');
  // consume it for real, then stop again: the consumed grant must not release the NEW stop
  w.state.fingerprint = 'DELTA_1';
  const r3 = await w.controller.review({ loopId: w.loopId });
  assert.equal(r3.hardStop, undefined);
  assert.equal(r3.status, 'HUMAN_REQUIRED', 'the provider is still failing: a NEW stop');
  const wf = (await w.persistence.readWorkflowState(w.loopId)).reviewLoop;
  const newStop = hr(wf);
  const again = await w.controller.review({ loopId: w.loopId });
  assert.equal(again.hardStop, true, 'a consumed grant is single use; the new stop needs a new one');
  assert.notEqual(wf.rereviewGrants[1].stopAt, newStop.at);
});

test('AC-06 / I3: a Gate failure under a grant spends nothing, leaves the stop and the SAME grant intact', async () => {
  const w = await stopped();
  w.state.gateVerdict = 'FAIL';
  w.state.failReviewer = false;
  const refused = await w.controller.review({ loopId: w.loopId });
  await authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: refused.submissionDigest, reason: 'try the gate' });
  const before = JSON.parse(await snapshot(w));
  const callsBefore = w.calls.reviewer;
  const r = await w.controller.review({ loopId: w.loopId });
  assert.equal(w.calls.reviewer, callsBefore, 'the Gate stopped it before any model call');
  assert.notEqual(r.status, 'PASS');
  const after = JSON.parse(await snapshot(w));
  assert.equal(after.reviewLoop.state, 'HUMAN_REQUIRED', 'still stopped: no REVIEWING ambiguity is left behind');
  assert.deepEqual(after.reviewLoop.history, before.reviewLoop.history);
  assert.equal(after.reviewLoop.rereviewGrants[0].consumedAt, null, 'grant not consumed');
  // the same content can retry under the same grant once the Gate passes
  w.state.gateVerdict = 'PASS';
  const ok = await w.controller.review({ loopId: w.loopId });
  assert.equal(ok.status, 'PASS');
});

test('AC-06: authorizations beyond the standard count need a stated call budget; budget and ledger are never reset', async () => {
  const w = await stopped();
  const refused = await w.controller.review({ loopId: w.loopId });
  for (let i = 0; i < STANDARD_REREVIEW_GRANTS; i += 1) {
    await authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: refused.submissionDigest, reason: `r${i}` });
  }
  await assert.rejects(
    () => authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: refused.submissionDigest, reason: 'one more' }),
    /--max-reviewer-calls/,
  );
  const wf = await w.persistence.readWorkflowState(w.loopId);
  assert.equal(wf.reviewLoop.round, 1, 'round counter untouched');
  assert.equal(wf.reviewLoop.humanReopens, undefined, 'not a reopen-gate: no budget reset');
});

test('authorize-rereview refuses what it cannot honour, writes nothing, and the report agrees (dry-run parity)', async () => {
  const w = await stopped();
  const before = await snapshot(w);
  await assert.rejects(() => authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: 'zz', reason: 'r' }), /--submission/);
  await assert.rejects(() => authorizeRereview({ persistence: w.persistence, loopId: w.loopId, submission: 'a'.repeat(64), reason: '' }), /requires a loopId and a reason/);
  assert.equal(await snapshot(w), before);
  // Not stopped => not eligible, and the report offers no such command.
  const live = world();
  const { loopId } = await live.controller.begin({ goal: 'g', cwd: '/r' });
  const wf = await live.persistence.readWorkflowState(loopId);
  assert.equal(rereviewPrecondition({ loop: wf.reviewLoop, workflow: wf }).ok, false);
  // An independent safety stop in force: refused and NOT recommended.
  const tripped = await stopped();
  const wf2 = await tripped.persistence.readWorkflowState(tripped.loopId);
  wf2.reviewLoopTokenAnomaly = { tripped: true, at: '2026-11-20T00:30:00.000Z', trigger: 'SINGLE_CALL_USAGE', usageVolume: 50000, threshold: 40000 };
  await tripped.persistence.writeWorkflowState(tripped.loopId, wf2);
  assert.equal(rereviewPrecondition({ loop: wf2.reviewLoop, workflow: wf2 }).ok, false);
  const rep = buildHumanRequiredReport({ loopId: tripped.loopId, loop: wf2.reviewLoop, workflow: wf2 });
  assert.ok(!rep.reportText.includes('authorize-rereview'), 'the sentinel stop never offers a re-review command');
  await assert.rejects(() => authorizeRereview({ persistence: tripped.persistence, loopId: tripped.loopId, submission: 'a'.repeat(64), reason: 'r' }), /independent stops are still in force/);
});

test('a human action recorded after the stop (raised call ceiling) still lets the Worker continue, as before', async () => {
  const w = await stopped();
  const wf = await w.persistence.readWorkflowState(w.loopId);
  // a human-granted allowance written after the stop is an auditable human action
  wf.reviewLoopCallAllowance = { maxReviewerCalls: 50, maxSupervisorCalls: 8, history: [{ at: new Date(Date.now() + 5).toISOString(), role: 'reviewer', newCeiling: 50, tier: 'STANDARD' }] };
  await w.persistence.writeWorkflowState(w.loopId, wf);
  w.state.failReviewer = false;
  const r = await w.controller.review({ loopId: w.loopId });
  assert.notEqual(r.hardStop, true);
});

// ---- AMBIGUOUS recovery end to end ---------------------------------------------------

test('a stranded REVIEWING record is restored to the hard stop by the user, then needs a grant (not a bare Worker call)', async () => {
  const w = await stopped();
  const wf = await w.persistence.readWorkflowState(w.loopId);
  const stop = hr(wf.reviewLoop);
  // Reproduce the OLD behaviour's footprint: an ordinary call moved HR -> REVIEWING with no outcome.
  wf.reviewLoop.state = 'REVIEWING';
  wf.reviewLoop.history.push({ from: 'HUMAN_REQUIRED', to: 'REVIEWING', reason: 'review requested', round: wf.reviewLoop.round, at: new Date(Date.parse(stop.at) + 1000).toISOString() });
  wf.modelSpendReservations = {};
  wf.reviewLoopSpend = { records: [] };
  wf.reviewLoop.lastReview = null;
  await w.persistence.writeWorkflowState(w.loopId, wf);
  await restoreHold({ persistence: w.persistence, loopId: w.loopId, reason: 'restore the earlier stop' });
  const after = (await w.persistence.readWorkflowState(w.loopId)).reviewLoop;
  assert.equal(after.state, 'HUMAN_REQUIRED');
  const refused = await w.controller.review({ loopId: w.loopId });
  assert.equal(refused.hardStop, true);
  assert.equal(refused.humanRequiredReport.category, 'REVIEW_FAILED', 'the restored stop keeps its ORIGINAL category');
});

test('release helper sanity: refuse, authorize, continue', async () => {
  const w = await stopped();
  w.state.failReviewer = false;
  await releaseHardStop({ controller: w.controller, persistence: w.persistence, loopId: w.loopId });
  assert.equal((await w.controller.review({ loopId: w.loopId })).status, 'PASS');
});

// ---- AC-08: the report offers a re-review command exactly when it would be accepted -------

test('AC-08: state matrix - authorize-rereview is listed iff its own dry-run precondition holds', () => {
  const T0 = '2026-11-20T01:00:00.000Z';
  const engine = { v: 1, kind: 'REVIEW_TOOL_FAILED', source: 'ENGINE', resume: 'HUMAN_AUTHORIZATION' };
  const mk = ({ reason, from = 'REVIEWING', cause = null, extra = {}, objective = { mode: 'LOCAL', taskType: 'code' } }) => ({
    loopId: 'rl-m', state: 'HUMAN_REQUIRED', round: 3, objective,
    history: [{ from, to: 'HUMAN_REQUIRED', reason, round: 3, at: T0, ...(cause ? { cause } : {}) }], ...extra,
  });
  const latch = { tripped: true, at: '2026-11-20T00:30:00.000Z', trigger: 'SINGLE_CALL_USAGE', usageVolume: 50000, threshold: 40000 };
  const table = [
    ['REVIEW_FAILED', mk({ reason: 'Supervisor adjudication unusable (x)', cause: engine }), {}, true],
    ['SUPERVISOR_ESCALATION (not exhausted)', mk({ reason: 'needs a decision', from: 'SUPERVISING' }), {}, true],
    ['SUPERVISOR_ESCALATION (budget spent)', mk({ reason: 'needs a decision', from: 'SUPERVISING', extra: { budgetExhausted: true } }), {}, false],
    ['CONVERGENCE_EXHAUSTED', mk({ reason: 'review did not converge', extra: { budgetExhausted: true } }), {}, false],
    ['TOKEN_SENTINEL', mk({ reason: 'model spend blocked: MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' }), { reviewLoopTokenAnomaly: latch }, false],
    ['UNACCOUNTED_SPEND', mk({ reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED' }), { modelSpendReservations: { r1: { status: 'UNRESOLVED' } } }, false],
    ['NO_NEW_INFORMATION', mk({ reason: 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED' }), {}, true],
    ['DESIGN_SOURCE_LIMIT', mk({ reason: 'critical code facts could not be independently verified within repository/read boundaries', objective: { mode: 'LOCAL', taskType: 'design', reviewTarget: 'D.md' } }), {}, true],
    ['TASK_DEFINITION', mk({ reason: 'phase plan exceeds the bounded task-definition limit' }), {}, false],
    ['ATTRIBUTION_INCOMPLETE', mk({ reason: 'baseline attribution incomplete' }), {}, true],
    ['CANCELLED', mk({ reason: 'review cancelled by caller' }), {}, true],
    ['OTHER', mk({ reason: 'something nobody anticipated' }), {}, true],
  ];
  for (const [name, loop, wfExtra, offered] of table) {
    const workflow = { reviewLoop: loop, ...wfExtra };
    const dry = rereviewPrecondition({ loop, workflow });
    const text = buildHumanRequiredReport({ loopId: 'rl-m', loop, workflow, env: {} }).reportText;
    assert.equal(dry.ok, offered, `${name}: dry-run (${dry.why ?? 'ok'})`);
    assert.equal(text.includes('reviewloop authorize-rereview --loop rl-m'), offered, `${name}: report agrees with the dry-run`);
    assert.ok(!text.includes('让 Worker 用同一个任务再次发起审查'), `${name}: no bare Worker retry advice`);
  }
});
