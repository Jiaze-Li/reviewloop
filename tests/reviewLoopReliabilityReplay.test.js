// P4 (RL-REVIEW-RELIABILITY): end-to-end replay of a #65-style OLD stopped task
// (synthetic snapshot, no real state, no model). The new runtime must read it
// without rewriting it, refuse a bare Worker re-call at zero cost, offer only
// commands that would be accepted, and let the user release it for one exact
// submission while every earlier record stays untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { authorizeRereview } from '../src/reviewloop/rereviewAuthorization.js';
import { buildHumanRequiredReport } from '../src/reviewloop/humanRequiredReport.js';

const OLD_REASON = 'Supervisor adjudication unusable (Supervisor fact adjudication reply was not JSON; model output began: the token anomaly is unresolved, Supervisor says stop)';

function build(persistence, { reviewer } = {}) {
  const calls = { reviewer: 0, gate: 0 };
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FP1', diff: 'diff --git a/a.js b/a.js\n+++ b/a.js\n+x\n' }),
    runGateFn: async () => { calls.gate += 1; return { verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }; },
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => { calls.reviewer += 1; return reviewer ? reviewer() : { value: { findings: [] }, usage: { input_tokens: 2, output_tokens: 1 } }; },
  });
  return { controller, calls };
}

test('#65-style old stop: read without rewriting, refused at zero cost, released for one exact submission, history preserved', async () => {
  const persistence = new MemoryPersistence();
  const seed = build(persistence);
  const { loopId } = await seed.controller.begin({ goal: 'g', cwd: '/r' });
  // Rewrite the durable record into the OLD shape: a legacy template stop with NO structured cause.
  const wf = await persistence.readWorkflowState(loopId);
  wf.reviewLoop.state = 'HUMAN_REQUIRED';
  wf.reviewLoop.round = 2;
  wf.reviewLoop.history.push({ from: 'READY_FOR_WORK', to: 'REVIEWING', reason: 'review requested', round: 1, at: '2026-11-20T01:00:00.000Z' });
  wf.reviewLoop.history.push({ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: OLD_REASON, round: 2, at: '2026-11-20T01:05:00.000Z' });
  await persistence.writeWorkflowState(loopId, wf);
  const oldHistory = JSON.stringify((await persistence.readWorkflowState(loopId)).reviewLoop.history);

  const { controller, calls } = build(persistence);

  // 1. The model's words ("token anomaly", "Supervisor", "unresolved") do not change the category.
  const report = buildHumanRequiredReport({ loopId, loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.equal(report.category, 'REVIEW_FAILED');
  assert.ok(!report.reportText.includes('model output began'), 'no model text in the human report');

  // 2. A bare Worker call is refused read-only: nothing runs, nothing is written.
  const before = JSON.stringify(await persistence.readWorkflowState(loopId));
  const refused = await controller.review({ loopId });
  assert.equal(refused.hardStop, true);
  assert.deepEqual([calls.gate, calls.reviewer], [0, 0]);
  assert.equal(JSON.stringify(await persistence.readWorkflowState(loopId)), before);

  // 3. The command the report offers is exactly the one the user then runs.
  assert.ok(refused.reportText.includes(`authorize-rereview --loop ${loopId} --submission ${refused.submissionDigest}`));
  await authorizeRereview({ persistence, loopId, submission: refused.submissionDigest, reason: 'provider recovered; same content' });

  // 4. One authorized review runs in the SAME loop and passes; the old records are intact.
  const done = await controller.review({ loopId });
  assert.equal(done.status, 'PASS');
  assert.equal(done.loopId, loopId);
  assert.equal(calls.reviewer, 1);
  const after = (await persistence.readWorkflowState(loopId)).reviewLoop;
  assert.equal(JSON.stringify(after.history.slice(0, JSON.parse(oldHistory).length)), oldHistory, 'earlier history is byte-identical');
  assert.ok(after.rereviewGrants[0].consumedAt);
});
