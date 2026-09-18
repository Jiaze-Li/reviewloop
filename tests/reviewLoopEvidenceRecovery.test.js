import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { EVIDENCE_LIMITS } from '../src/reviewloop/contractEvidence.js';
import { buildReviewerInvoke } from '../src/reviewloop/providerWiring.js';
import { MemoryPersistence, mockPrBackend, prTestFakes, finding } from './helpers/reviewLoopHarness.js';

const requirement = (id, extra = {}) => ({
  id, type: 'runtime', description: `Verify the production behavior for ${id}.`,
  gate: 'final', required: true, covers: ['AC1'], ...extra,
});
const proof = (requirementId, summary = 'Completed the production interaction and verified its result.') => ({ requirementId, summary });
const phases = [1, 2].map((n) => ({
  id: `phase-${n}`, title: `Phase ${n}`, objective: `Implement part ${n}.`,
  exitCriteria: [`Part ${n} works.`], carryForwardInvariants: [`Preserve part ${n}.`],
  verificationCommands: [`echo phase-${n}`], verificationEvidence: [`Exercise part ${n}.`],
}));

// Restart creates a new controller over the same durable state. No real model,
// shell, filesystem or GitHub calls are used by either target.
function world(mode, reviews = [{ findings: [] }]) {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: ['H1', 'H2'] });
  const calls = { reviewer: 0, supervisor: 0, bundles: [], commands: [] };
  let code = 'code-1';
  const restart = () => createReviewLoopController({
    persistence, env: {},
    ...(mode === 'PR' ? { prBackend: backend, ...prTestFakes(backend) } : {}),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: code, diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
      changedFiles: ['a.js'], currentHead: 'H1', baselineHead: 'BASE',
      evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false,
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo global'] }),
    runGateFn: async ({ commands }) => {
      calls.commands.push(commands);
      return { verdict: 'PASS', pass: true, fingerprint: 'same-gate', failureIdentities: [], results: [] };
    },
    reviewerFn: async ({ evidence }) => {
      calls.bundles.push(evidence);
      const value = reviews[Math.min(calls.reviewer, reviews.length - 1)];
      calls.reviewer += 1;
      return { value, usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => {
      calls.supervisor += 1;
      return { value: { guidance: 'Repair it.', recommendation: 'REWORK' }, usage: { input_tokens: 8, output_tokens: 4 } };
    },
  });
  return {
    persistence, calls, restart, controller: restart(),
    advanceCode() { code = 'code-2'; backend.advanceHead(); },
    beginArgs: { goal: 'Prove the actual runtime behavior.', cwd: '/r', ...(mode === 'PR' ? { prNumber: 7 } : {}) },
  };
}

for (const mode of ['LOCAL', 'PR']) {
  test(`${mode}: invalid evidence is atomic, structured, zero-spend and recoverable`, async () => {
    const w = world(mode);
    const { loopId } = await w.controller.begin({
      ...w.beginArgs, evidenceRequirements: [requirement('a'), requirement('b')],
    });
    const missing = await w.controller.review({ loopId, evidence: [proof('a', 'Previously accepted proof.')] });
    assert.equal(missing.status, 'REWORK');
    assert.equal(missing.round, 0);
    assert.equal(missing.gateRound, 0);
    assert.equal(missing.maxRounds, 3);
    assert.equal(missing.currentPhase, null);
    assert.deepEqual(missing.gate, { verdict: 'PASS', failures: [] });
    assert.equal(missing.head, 'H1');
    assert.deepEqual(missing.missingEvidenceRequirements.map((r) => r.id), ['b']);
    const before = (await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords;
    for (const evidence of [
      [proof('a', 'Must not persist.'), proof('typo')],
      [proof('a', 'Must not persist.'), {}],
      [proof('a'), proof('a')],
      { malformed: true },
      [proof('b', 'raw-log-'.repeat(1000))],
      [{ ...proof('b'), artifactRef: 'x'.repeat(EVIDENCE_LIMITS.artifactRefBytes + 1) }],
    ]) {
      const result = await w.controller.review({ loopId, evidence });
      assert.equal(result.status, 'REWORK');
      assert.match(result.reason, /reviewloop_review:/);
      assert.deepEqual(result.gate, { verdict: mode === 'PR' ? 'NOT_RUN' : 'PASS', failures: [] });
      assert.equal(result.round, 0);
      assert.equal(result.maxRounds, 3);
      assert.equal(result.head, 'H1');
      assert.equal(JSON.stringify(result).includes('raw-log-'), false);
      assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, before);
    }
    assert.equal(w.calls.reviewer, 0);
    assert.equal(w.calls.supervisor, 0);
    assert.equal((await w.restart().review({ loopId, evidence: [proof('b')] })).status, 'PASS');
    assert.equal(w.calls.reviewer, 1);
  });

  test(`${mode}: wrong-gate proof is rejected and completed-phase evidence cannot satisfy the next gate`, async () => {
    const w = world(mode);
    const { loopId } = await w.controller.begin({
      ...w.beginArgs, phases,
      evidenceRequirements: [requirement('p1', { gate: 'phase-1' }), requirement('p2', { gate: 'phase-2' })],
    });
    const wrong = await w.controller.review({ loopId, evidence: [proof('p1'), proof('p2')] });
    assert.equal(wrong.status, 'REWORK');
    assert.equal(wrong.currentPhase, 'phase-1');
    assert.equal(w.calls.reviewer, 0);
    assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, []);
    assert.equal((await w.controller.review({ loopId, evidence: [proof('p1')] })).status, 'PHASE_PASS');
    const stale = await w.restart().review({ loopId, evidence: [proof('p1')] });
    assert.equal(stale.status, 'REWORK');
    assert.equal(stale.currentPhase, 'phase-2');
    assert.equal(w.calls.reviewer, 1);
    assert.equal((await w.restart().review({ loopId, evidence: [proof('p2')] })).status, 'PHASE_PASS');
  });

  test(`${mode}: aggregate and persisted evidence budgets block before any model call`, async () => {
    const w = world(mode);
    const requirements = Array.from({ length: 6 }, (_, i) => requirement(`r${i}`));
    const { loopId } = await w.controller.begin({ ...w.beginArgs, evidenceRequirements: requirements });
    const large = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes);
    const first = requirements.slice(0, 5).map((r) => proof(r.id, large));
    assert.equal((await w.controller.review({ loopId, evidence: first })).status, 'REWORK');
    const rejected = await w.controller.review({ loopId, evidence: [proof('r5', large)] });
    assert.equal(rejected.status, 'REWORK');
    assert.match(rejected.reason, /combined evidence prompt/);
    assert.equal(w.calls.reviewer, 0);
    const raw = await w.persistence.readWorkflowState(loopId);
    assert.equal(raw.reviewLoop.evidenceRecords.length, 5);
    raw.reviewLoop.evidenceRecords[0].summary = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes + 1);
    await w.persistence.writeWorkflowState(loopId, raw);
    const reloaded = await w.restart().review({ loopId });
    assert.equal(reloaded.status, 'REWORK');
    assert.match(reloaded.reason, /byte limit/);
    assert.equal(w.calls.reviewer, 0);
    const corrected = await w.restart().review({ loopId, evidence: requirements.map((r) => proof(r.id)) });
    assert.equal(corrected.status, 'PASS');
    assert.equal(w.calls.reviewer, 1);
    assert.equal(w.calls.supervisor, 0);
  });

  test(`${mode}: invalid retries do not consume progress; identical proof is NO_PROGRESS and improved proof is reviewed`, async () => {
    const w = world(mode, [
      { findings: [finding('P1', 'a.js', 'Runtime proof is incomplete.')] }, { findings: [] },
    ]);
    const { loopId } = await w.controller.begin({ ...w.beginArgs, evidenceRequirements: [requirement('r')] });
    const weak = [proof('r', 'Only opened the application.')];
    assert.equal((await w.controller.review({ loopId, evidence: weak })).status, 'REWORK');
    assert.equal(w.calls.reviewer, 1);
    assert.equal((await w.controller.review({ loopId, evidence: { malformed: true } })).status, 'REWORK');
    assert.equal((await w.controller.review({ loopId, evidence: weak })).status, 'NO_PROGRESS');
    assert.equal(w.calls.reviewer, 1);
    const improved = await w.controller.review({ loopId, evidence: [proof('r')] });
    assert.equal(improved.status, 'PASS');
    assert.equal(improved.round, 2);
    assert.equal(w.calls.reviewer, 2);
  });

  test(`${mode}: changed code invalidates the corrected runtime evidence`, async () => {
    const w = world(mode, [{ findings: [finding('P1', 'a.js', 'Repair the implementation.')] }]);
    const { loopId } = await w.controller.begin({ ...w.beginArgs, evidenceRequirements: [requirement('r')] });
    assert.equal((await w.controller.review({ loopId, evidence: [proof('r')] })).status, 'REWORK');
    w.advanceCode();
    const result = await w.controller.review({ loopId });
    assert.equal(result.status, 'REWORK');
    assert.deepEqual(result.missingEvidenceRequirements.map((r) => r.id), ['r']);
    assert.equal(w.calls.reviewer, 1);
  });

  test(`${mode}: intermediate and last-phase durable resume retain the complete task and final obligations`, async () => {
    const w = world(mode);
    const contractText = 'Implement and verify both parts; the final real-runtime check is mandatory.';
    const requirements = [
      requirement('p1', { gate: 'phase-1' }), requirement('p2', { gate: 'phase-2' }),
      requirement('final-proof'), requirement('trace', { type: 'artifact', required: false }),
    ];
    const begun = await w.controller.begin({ ...w.beginArgs, contractText, phases, evidenceRequirements: requirements });
    const { loopId } = begun;
    const p1 = await w.controller.review({ loopId, evidence: [proof('p1')] });
    assert.equal(p1.status, 'PHASE_PASS');
    let durable = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
    assert.deepEqual(durable.resumePacket, p1.resumePacket);
    const packet = durable.resumePacket;
    assert.equal(packet.goal, w.beginArgs.goal);
    assert.equal(packet.contractText, contractText);
    assert.equal(packet.objectiveFingerprint, begun.objectiveFingerprint);
    assert.deepEqual(packet.phasePlan, durable.objective.phases);
    assert.deepEqual(packet.repository, durable.objective.repository);
    assert.deepEqual(packet.verificationPlan.commands, ['echo global']);
    assert.deepEqual(packet.pendingEvidenceRequirements.map((r) => r.id), ['p2', 'final-proof', 'trace']);
    assert.deepEqual(packet.nextPhase.carryForwardInvariants, phases[1].carryForwardInvariants);
    assert.deepEqual(packet.carryForwardInvariants, phases[0].carryForwardInvariants);
    assert.equal(packet.completedPhases[0].proof, durable.completedPhases[0].proof);
    assert.equal(packet.loopId, loopId);
    const p2 = await w.restart().review({ loopId, evidence: [proof('p2')] });
    assert.equal(p2.status, 'PHASE_PASS');
    durable = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
    assert.deepEqual(durable.resumePacket, p2.resumePacket);
    assert.equal(p2.resumePacket.nextPhase, null);
    assert.equal(p2.resumePacket.finalGatePending, true);
    assert.equal(p2.resumePacket.goal, w.beginArgs.goal);
    assert.equal(p2.resumePacket.contractText, contractText);
    assert.deepEqual(p2.resumePacket.pendingEvidenceRequirements, requirements.slice(2));
    assert.equal(durable.round, 2);
    assert.equal(durable.reviewerCalls, 2);
    assert.equal(durable.objective.fingerprint, begun.objectiveFingerprint);
    const missing = await w.restart().review({ loopId });
    assert.equal(missing.status, 'REWORK');
    assert.equal(missing.currentPhase, 'final');
    assert.equal(w.calls.reviewer, 2);
    const final = await w.restart().review({ loopId, evidence: [proof('final-proof')] });
    assert.equal(final.status, 'PASS');
    assert.equal(final.round, 3);
    assert.equal(w.calls.reviewer, 3);
    assert.equal(w.calls.supervisor, 0);
    assert.deepEqual(w.calls.commands.at(-1), ['echo global'], 'final uses only the global verification plan');
    assert.equal((await w.persistence.readWorkflowState(loopId)).reviewLoop.resumePacket, null);
  });
}

test('actual Reviewer transport rejects oversized input before dispatch and preserves optional evidence context', async () => {
  const invoke = buildReviewerInvoke();
  let calls = 0;
  let prompt = '';
  const args = {
    objective: { goal: 'Binding goal.', contractText: 'Binding contract.' }, diff: 'change', changedFiles: ['a.js'],
    gate: { verdict: 'PASS' }, transport: async (text) => { calls += 1; prompt = text; return { text: '{"findings":[]}' }; },
  };
  await assert.rejects(() => invoke({
    ...args, evidence: { requirements: [requirement('r')], submissions: [proof('r', 'x'.repeat(EVIDENCE_LIMITS.summaryBytes + 1))] },
  }), /byte limit/);
  assert.equal(calls, 0);
  const optional = requirement('trace', { required: false, description: 'Optional diagnostic trace.' });
  await invoke({ ...args, evidence: { requirements: [optional], submissions: [proof('trace')] } });
  assert.equal(calls, 1);
  assert.match(prompt, /trace \[runtime; optional\]: Optional diagnostic trace\./);
  assert.match(prompt, /Binding goal\./);
  assert.match(prompt, /Binding contract\./);
  assert.match(prompt, /Do not treat mere presence as proof/);
});
