import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { PHASE_PLAN_MAX_BYTES, PHASE_VERIFICATION_EVIDENCE_LIMITS } from '../src/reviewloop/objective.js';
import {
  CONTRACT_TEXT_MAX_BYTES, EVIDENCE_LIMITS, normalizeContractText,
  assertContractHandoff, declaredPhasePlan, bindEvidenceSubmissions,
  latestEvidenceRecords, evidenceStatusForScope,
} from '../src/reviewloop/contractEvidence.js';
import { buildReviewerInvoke, buildSupervisorInvoke } from '../src/reviewloop/providerWiring.js';
import { MemoryPersistence, mockPrBackend, prTestFakes, finding, makeHarness } from './helpers/reviewLoopHarness.js';

const req = (id = 'runtime', extra = {}) => ({
  id, type: 'runtime', description: `Prove ${id}.`, gate: 'final', required: true, covers: [], ...extra,
});
const proof = (requirementId = 'runtime', summary = 'Verified the real interaction on the current code.') => ({ requirementId, summary });
const phases = [1, 2].map((n) => ({
  id: `p${n}`, title: `Part ${n}`, objective: `Implement part ${n}.`,
  exitCriteria: [`Part ${n} works.`], carryForwardInvariants: [`Preserve part ${n}.`],
}));

function world(mode, reviews = [{ findings: [] }]) {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: ['H1', 'H2'] });
  const fakes = prTestFakes(backend);
  const calls = { gate: 0, snapshots: 0, reviewer: 0, supervisor: 0, bundles: [] };
  let code = 'A';
  let verdict = 'PASS';
  let mutations = [];
  const delta = () => ({
    fingerprint: code, diff: `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+${code}\n`,
    changedFiles: ['a.js'], currentHead: 'H1', baselineHead: 'BASE',
    evidenceComplete: true, noWorkerChangeYet: false, preExistingTouched: [],
  });
  const restart = () => createReviewLoopController({
    persistence, env: {},
    ...(mode === 'PR' ? {
      prBackend: backend, ...fakes,
      buildPrSnapshotFn: async (...args) => { calls.snapshots += 1; return fakes.buildPrSnapshotFn(...args); },
    } : {}),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => delta(),
    collectPostGateDeltaFn: async () => delta(),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo verify'] }),
    runGateFn: async () => {
      calls.gate += 1;
      if (mutations.length) code = mutations.shift();
      return { verdict, pass: verdict === 'PASS', fingerprint: `gate-${verdict}`, failureIdentities: verdict === 'FAIL' ? ['regression'] : [], results: [] };
    },
    reviewerFn: async ({ evidence }) => {
      calls.bundles.push(evidence);
      const value = reviews[Math.min(calls.reviewer, reviews.length - 1)];
      calls.reviewer += 1;
      return { value, usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => { calls.supervisor += 1; throw new Error('Supervisor must not run'); },
  });
  return {
    persistence, calls, backend, restart, controller: restart(),
    mutate(sequence) { mutations = [...sequence]; },
    gate(next) { verdict = next; },
    args: { goal: 'Implement the runtime-sensitive behavior.', cwd: '/r', ...(mode === 'PR' ? { prNumber: 7 } : {}) },
  };
}

for (const type of ['runtime', 'manual', 'artifact', 'other']) {
  for (const phased of [false, true]) {
    test(`LOCAL ${type}/${phased ? 'phase' : 'task'}: Gate changes invalidate pre-Gate proof before any model spend`, async () => {
      const w = world('LOCAL');
      const begun = await w.controller.begin({
        ...w.args, ...(phased ? { phases } : {}),
        evidenceRequirements: [req('runtime', { type, gate: phased ? 'p1' : 'final' })],
      });
      const { loopId } = begun;
      const beforeGate = w.calls.gate;
      w.mutate(['B', 'C']);
      const rejected = await w.controller.review({ loopId, evidence: [proof('runtime', 'Proof collected against A.')] });
      assert.equal(rejected.status, 'REWORK');
      assert.equal(rejected.evidenceSubmission.reason, 'CODE_CHANGED');
      assert.equal(rejected.evidenceSubmission.status, 'NOT_ACCEPTED');
      assert.equal(rejected.evidenceSubmission.retryRequired, true);
      assert.equal(w.calls.gate - beforeGate, 3, 'Gate must stabilize completely before handing off the new tree');
      assert.equal(w.calls.reviewer, 0);
      assert.equal(w.calls.supervisor, 0);
      let durable = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
      assert.equal(durable.round, 0);
      assert.deepEqual(durable.evidenceRecords, []);
      assert.equal(durable.objective.fingerprint, begun.objectiveFingerprint);
      const accepted = await w.restart().review({ loopId, evidence: [proof('runtime', 'Fresh proof collected against C.')] });
      assert.equal(accepted.status, phased ? 'PHASE_PASS' : 'PASS');
      durable = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
      assert.equal(durable.evidenceRecords[0].evidenceFingerprint, 'C');
      assert.equal(w.calls.reviewer, 1);
      assert.equal(durable.round, 1);
    });
  }
}

test('LOCAL A -> B -> A stabilization never resurrects previously bound current-scope proof', async () => {
  const w = world('LOCAL', [{ findings: [finding('P1', 'a.js', 'Proof insufficient.')] }, { findings: [] }]);
  const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req()] });
  assert.equal((await w.controller.review({ loopId, evidence: [proof()] })).status, 'REWORK');
  w.mutate(['B', 'A']);
  const rejected = await w.controller.review({ loopId, evidence: [proof()] });
  assert.equal(rejected.status, 'REWORK');
  assert.equal(rejected.evidenceSubmission.reason, 'CODE_CHANGED');
  assert.equal(w.calls.reviewer, 1);
  assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, []);
  const accepted = await w.restart().review({ loopId, evidence: [proof('runtime', 'Re-verified after stabilization.')] });
  assert.equal(accepted.status, 'PASS');
  assert.equal(accepted.round, 2);
});

test('LOCAL optional pre-Gate submission gets an explicit rejection; omitting optional proof is still allowed', async () => {
  const w = world('LOCAL');
  const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req('trace', { required: false })] });
  w.mutate(['B']);
  const rejected = await w.controller.review({ loopId, evidence: [proof('trace')] });
  assert.equal(rejected.evidenceSubmission.reason, 'CODE_CHANGED');
  assert.equal(w.calls.reviewer, 0);
  assert.equal((await w.restart().review({ loopId })).status, 'PASS');
  assert.deepEqual(w.calls.bundles[0].submissions, []);
});

test('LOCAL ordinary task without evidence still reviews the stabilized tree', async () => {
  const w = world('LOCAL');
  const { loopId } = await w.controller.begin(w.args);
  w.mutate(['B']);
  assert.equal((await w.controller.review({ loopId })).status, 'PASS');
  assert.equal(w.calls.reviewer, 1);
});

for (const declared of [false, true]) {
  test(`PR ${declared ? 'with' : 'without'} requirements: invalid unchanged-HEAD retries never build a snapshot or run Gate`, async () => {
    const w = world('PR', [{ findings: [finding('P1', 'a.js', 'Needs repair.')] }, { findings: [] }]);
    const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: declared ? [req()] : [] });
    const weak = declared ? [proof('runtime', 'Weak proof.')] : [];
    assert.equal((await w.controller.review({ loopId, evidence: weak })).status, 'REWORK');
    const before = { gate: w.calls.gate, snapshots: w.calls.snapshots, reviewer: w.calls.reviewer };
    const saved = (await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords;
    const bad = [[proof('bogus')], { malformed: true }, [null], [proof('runtime', 'x'.repeat(EVIDENCE_LIMITS.summaryBytes + 1))]];
    if (declared) bad.push([proof(), proof('bogus')], [proof(), proof()]);
    for (const evidence of bad) {
      const result = await w.restart().review({ loopId, evidence });
      assert.equal(result.status, 'REWORK');
      assert.equal(result.gate.verdict, 'NOT_RUN');
      assert.equal(result.evidenceSubmission.reason, 'INVALID_EVIDENCE');
      assert.equal(result.head, 'H1');
      assert.equal(result.round, 1);
      assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, saved);
    }
    for (const evidence of [[], null, undefined]) {
      assert.equal((await w.controller.review({ loopId, evidence })).status, 'PUSH_REQUIRED');
    }
    assert.deepEqual({ gate: w.calls.gate, snapshots: w.calls.snapshots, reviewer: w.calls.reviewer }, before);
    if (declared) {
      assert.equal((await w.restart().review({ loopId, evidence: weak })).status, 'NO_PROGRESS');
      const done = await w.restart().review({ loopId, evidence: [proof('runtime', 'New complete observations.')] });
      assert.equal(done.status, 'PASS');
      assert.equal(done.round, 2);
    }
  });
}

test('PR wrong-gate and mixed batches are rejected before any worktree/Gate execution', async () => {
  const w = world('PR');
  const { loopId } = await w.controller.begin({ ...w.args, phases,
    evidenceRequirements: [req('p1-proof', { gate: 'p1' }), req('p2-proof', { gate: 'p2' })],
  });
  const before = { gate: w.calls.gate, snapshots: w.calls.snapshots };
  const result = await w.controller.review({ loopId, evidence: [proof('p1-proof'), proof('p2-proof')] });
  assert.equal(result.status, 'REWORK');
  assert.equal(result.currentPhase, 'p1');
  assert.equal(result.gate.verdict, 'NOT_RUN');
  assert.deepEqual({ gate: w.calls.gate, snapshots: w.calls.snapshots }, before);
  assert.equal(w.calls.reviewer, 0);
  assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, []);
});

for (const mode of ['LOCAL', 'PR']) {
  test(`${mode}: Gate FAIL and repeated failure acknowledge discarded evidence without new model progress`, async () => {
    const w = world(mode);
    const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req()] });
    w.gate('FAIL');
    for (const [index, summary] of ['First runtime proof.', 'Different proof does not repair Gate.'].entries()) {
      const result = await w.controller.review({ loopId, evidence: [proof('runtime', summary)] });
      assert.equal(result.status, index === 0 ? 'REWORK' : 'NO_PROGRESS');
      assert.deepEqual(result.evidenceSubmission, { status: 'NOT_ACCEPTED', reason: 'GATE_FAILED', submittedCount: 1, retryRequired: true });
      assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, []);
      assert.equal(w.calls.reviewer, 0);
    }
    w.gate('PASS');
    const missing = await w.restart().review({ loopId });
    assert.equal(missing.status, 'REWORK');
    assert.deepEqual(missing.missingEvidenceRequirements.map((r) => r.id), ['runtime']);
    assert.equal(w.calls.reviewer, 0);
    assert.equal((await w.restart().review({ loopId, evidence: [proof()] })).status, 'PASS');
  });

  test(`${mode}: durable history reload compacts superseded records without changing completion proofs or budgets`, async () => {
    const w = world(mode);
    const { loopId } = await w.controller.begin({ ...w.args, phases, evidenceRequirements: [req('p1-proof', { gate: 'p1' })] });
    assert.equal((await w.controller.review({ loopId, evidence: [proof('p1-proof')] })).status, 'PHASE_PASS');
    const raw = await w.persistence.readWorkflowState(loopId);
    const completed = structuredClone(raw.reviewLoop.completedPhases);
    const record = raw.reviewLoop.evidenceRecords[0];
    raw.reviewLoop.evidenceRecords = Array.from({ length: 150 }, (_, i) => ({ ...record, evidenceFingerprint: `old-${i}` })).concat(record);
    await w.persistence.writeWorkflowState(loopId, raw);
    const next = await w.restart().review({ loopId });
    assert.equal(next.status, 'PHASE_PASS');
    const after = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
    assert.equal(after.evidenceRecords.length, 1);
    assert.deepEqual(after.completedPhases[0], completed[0]);
    assert.equal(after.round, 2);
    assert.equal(after.reviewerCalls, 2);
    assert.equal(after.objective.fingerprint, raw.reviewLoop.objective.fingerprint);
    assert.equal(next.resumePacket.evidenceRecordCount, 1);
  });
}

for (const text of [
  'Execution plan: continue where phase 1 left off; phase 2 of the migration was already handled last sprint.',
  'Execution Plan: repair compatibility between Phase 1 and Phase 2 of the existing protocol.',
  'Execution plan:\nInvestigate old phase 1 and phase 2 logs; this task has no staged execution.',
]) {
  test(`phase history is not a declared plan: ${text}`, () => {
    assert.equal(declaredPhasePlan(text).count, null);
    assert.doesNotThrow(() => assertContractHandoff({ goal: text, phases: [] }));
  });
}
for (const text of [
  'Execution Plan: Phase 1 foundation. Phase 2 integration.',
  'Execution Plan: Phase 1 handles legacy Phase 9 data. Phase 2 integration.',
  'Execution Plan\nPhase 1 Foundation\nPhase 2 Integration',
  'Full spec has 2 phases.',
]) {
  test(`real declared plan still rejects empty and truncated handoffs: ${text}`, () => {
    assert.equal(declaredPhasePlan(text).count, 2);
    assert.throws(() => assertContractHandoff({ goal: text, phases: [] }), /phases\[\] is empty/);
    assert.throws(() => assertContractHandoff({ goal: text, phases: [phases[0]] }), /truncated/);
    assert.doesNotThrow(() => assertContractHandoff({ goal: text, phases }));
  });
}
test('noncontiguous or conflicting declared phase plans still fail closed', () => {
  for (const text of ['Execution Plan: Phase 1 foundation. Phase 3 integration.', 'Full spec has 3 phases.\nPhase 1 Foundation\nPhase 2 Integration']) {
    assert.throws(() => assertContractHandoff({ goal: text, phases }), /inconsistent/);
  }
});

test('contract limit is UTF-8, rejects raw padding, and never truncates accepted text', async () => {
  const exact = 'a'.repeat(CONTRACT_TEXT_MAX_BYTES);
  assert.equal(normalizeContractText(exact), exact);
  const unicode = '界'.repeat(Math.floor(CONTRACT_TEXT_MAX_BYTES / 3));
  assert.equal(normalizeContractText(unicode), unicode);
  for (const value of [exact + 'x', unicode + '界', ' '.repeat(CONTRACT_TEXT_MAX_BYTES) + 'x']) {
    assert.throws(() => normalizeContractText(value), /UTF-8 limit/);
    const h = makeHarness();
    await assert.rejects(h.controller.begin({ cwd: '/r', goal: 'Bounded task.', contractText: value }), /UTF-8 limit/);
    assert.equal(h.calls.baseline, 0);
    assert.equal(h.calls.gate, 0);
  }
  for (const invoke of [buildReviewerInvoke(), buildSupervisorInvoke()]) {
    let called = 0;
    await assert.rejects(invoke({
      objective: { goal: 'Binding goal.', contractText: exact + 'x' },
      diff: 'change', changedFiles: ['a.js'], blockingFindings: [], gate: { verdict: 'PASS' },
      transport: async () => { called += 1; return { text: '{}' }; },
    }), /UTF-8 limit/);
    assert.equal(called, 0);
  }
});

test('latest-only evidence retention is bounded across code versions and does not resurrect older matching proof', () => {
  const objective = { evidenceRequirements: [req()] };
  const reviewScope = { type: 'task', id: 'task', fingerprint: '' };
  const state = { evidenceRecords: [], completedPhases: [{ proof: 'leave-unchanged' }] };
  for (let n = 0; n < 200; n += 1) {
    bindEvidenceSubmissions({ loopState: state, objective, reviewScope, evidenceFingerprint: `code-${n}`, submissions: [proof()] });
    assert.equal(state.evidenceRecords.length, 1);
  }
  assert.deepEqual(state.completedPhases, [{ proof: 'leave-unchanged' }]);
  const newest = state.evidenceRecords[0];
  const legacy = [{ ...newest, evidenceFingerprint: 'old-code', recordedAt: 'far-future' }, newest];
  assert.deepEqual(latestEvidenceRecords(legacy, objective), [newest]);
  const status = evidenceStatusForScope({ loopState: { evidenceRecords: legacy }, objective, reviewScope, evidenceFingerprint: 'old-code' });
  assert.deepEqual(status.records, []);
  assert.equal(status.missing.length, 1);
});

test('LOCAL mutation with omitted mandatory evidence still fails closed on the new tree', async () => {
  const w = world('LOCAL');
  const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req()] });
  w.mutate(['B']);
  const result = await w.controller.review({ loopId });
  assert.equal(result.status, 'REWORK');
  assert.deepEqual(result.missingEvidenceRequirements.map((r) => r.id), ['runtime']);
  assert.equal(result.evidenceSubmission, undefined);
  assert.match(result.reason, /required evidence missing/);
  assert.equal(w.calls.reviewer, 0);
});

// Simulate the prior version's frozen objective: its fingerprint legitimately
// included an oversized contract before this limit existed. This is a fixture
// builder, not a production path for weakening or rewriting an objective.
function legacyFingerprint(o) {
  const fields = {
    goal: o.goal, repository: o.repository ?? null, mode: o.mode,
    prNumber: o.prNumber ?? null, reviewer: o.reviewer, constraints: o.constraints ?? [],
    blockingSeverities: o.blockingSeverities ?? [], maxReviewRounds: o.maxReviewRounds,
  };
  if (o.phases?.length) fields.phases = o.phases;
  if (o.contractText) fields.contractText = o.contractText;
  if (o.evidenceRequirements?.length) fields.evidenceRequirements = o.evidenceRequirements;
  if (o.verificationPlan) fields.verificationPlan = o.verificationPlan;
  if (o.prBaseSha) fields.prBaseSha = o.prBaseSha;
  if (o.reviewedHeadSha) fields.reviewedHeadSha = o.reviewedHeadSha;
  if (o.baseline) fields.baseline = {
    head: o.baseline.head ?? null, baselineRef: o.baseline.baselineRef ?? null,
    untrackedHashes: o.baseline.untrackedHashes ?? {}, evidenceComplete: o.baseline.evidenceComplete !== false,
  };
  if (o.baselineGateEvidence) fields.baselineGateEvidence = o.baselineGateEvidence;
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
for (const mode of ['LOCAL', 'PR']) {
  test(`${mode}: oversized legacy frozen contract is retained but blocked before Gate/model after reload`, async () => {
    const w = world(mode);
    const { loopId } = await w.controller.begin(w.args);
    const raw = await w.persistence.readWorkflowState(loopId);
    const objective = raw.reviewLoop.objective;
    assert.equal(legacyFingerprint(objective), objective.fingerprint, 'fixture uses the actual prior fingerprint fields');
    objective.contractText = 'x'.repeat(CONTRACT_TEXT_MAX_BYTES + 1);
    objective.fingerprint = legacyFingerprint(objective);
    await w.persistence.writeWorkflowState(loopId, raw);
    const gateBefore = w.calls.gate;
    const result = await w.restart().review({ loopId });
    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.match(result.reason, /UTF-8 limit/);
    assert.equal(w.calls.gate, gateBefore);
    assert.equal(w.calls.reviewer, 0);
    assert.equal(w.calls.supervisor, 0);
    const after = (await w.persistence.readWorkflowState(loopId)).reviewLoop;
    assert.deepEqual(after.objective, objective, 'never truncate or mutate a frozen contract during reload');
  });
}


test('LOCAL failing Gate that mutates the tree invalidates previously bound exact-code proof', async () => {
  const w = world('LOCAL', [{ findings: [finding('P1', 'a.js', 'Proof needs improvement.')] }, { findings: [] }]);
  const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req()] });
  assert.equal((await w.controller.review({ loopId, evidence: [proof('runtime', 'Proof for code A.')] })).status, 'REWORK');
  assert.equal((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords[0].evidenceFingerprint, 'A');

  w.gate('FAIL');
  w.mutate(['B']);
  const failed = await w.restart().review({ loopId });
  assert.equal(failed.status, 'REWORK');
  assert.equal(failed.gate.verdict, 'FAIL');
  assert.deepEqual((await w.persistence.readWorkflowState(loopId)).reviewLoop.evidenceRecords, []);
  assert.equal(w.calls.reviewer, 1, 'a failing Gate must not spend Reviewer calls');

  w.gate('PASS');
  const missing = await w.restart().review({ loopId });
  assert.equal(missing.status, 'REWORK');
  assert.deepEqual(missing.missingEvidenceRequirements.map((r) => r.id), ['runtime']);
  assert.equal(w.calls.reviewer, 1, 'old proof must not resurrect after the failing Gate mutation');

  const fresh = await w.restart().review({ loopId, evidence: [proof('runtime', 'Fresh proof collected against code B.')] });
  assert.equal(fresh.status, 'PASS');
  assert.equal(w.calls.reviewer, 2);
});

test('historical explicit phase counts without execution-plan context do not force phased handoff', () => {
  for (const text of [
    'Repair compatibility including the 2 phases of the legacy handshake.',
    'Document the subsystem including the 3 phases of its historical protocol.',
  ]) {
    assert.equal(declaredPhasePlan(text).count, null);
    assert.doesNotThrow(() => assertContractHandoff({ goal: text, phases: [] }));
  }
  assert.equal(declaredPhasePlan('Execution plan includes the 2 phases.').count, 2);
  assert.throws(
    () => assertContractHandoff({ goal: 'Execution plan includes the 2 phases.', phases: [] }),
    /phases\[\] is empty/,
  );
});

test('goal and contractText phase headings cannot combine across the source boundary', () => {
  assert.doesNotThrow(() => assertContractHandoff({
    goal: 'Phase 1 compatibility note.',
    contractText: 'Phase 2 migration example.',
    phases: [],
  }));
  assert.throws(() => assertContractHandoff({
    goal: 'Full spec has 2 phases.',
    contractText: 'Phase 1 Foundation\nPhase 2 Integration',
    phases: [],
  }), /phases\[\] is empty/);
});

test('declared plans reject mixed canonical/custom ids but allow consistently custom ids', () => {
  const canonical = [
    { ...phases[0], id: 'phase-1' },
    { ...phases[1], id: 'phase-2' },
  ];
  assert.doesNotThrow(() => assertContractHandoff({ goal: 'Full spec has 2 phases.', phases: canonical }));
  assert.throws(() => assertContractHandoff({
    goal: 'Full spec has 2 phases.',
    phases: [{ ...canonical[0] }, { ...canonical[1], id: 'integration' }],
  }), /mixes canonical phase-N ids with custom ids/);
  assert.doesNotThrow(() => assertContractHandoff({ goal: 'Full spec has 2 phases.', phases }));
});

test('blank optional artifactRef is normalized as absent for direct controller/library callers', () => {
  const objective = { evidenceRequirements: [req()] };
  const reviewScope = { type: 'task', id: 'task', fingerprint: '' };
  const state = { evidenceRecords: [] };
  bindEvidenceSubmissions({
    loopState: state,
    objective,
    reviewScope,
    submissions: [{ requirementId: 'runtime', summary: 'Verified behavior.', artifactRef: '   ' }],
    evidenceFingerprint: 'code-A',
  });
  assert.equal(state.evidenceRecords.length, 1);
  assert.equal(state.evidenceRecords[0].artifactRef, null);
});


test('Gate mutation with no submitted evidence reports missing proof, not a fake NOT_ACCEPTED receipt', async () => {
  const w = world('LOCAL');
  const { loopId } = await w.controller.begin({ ...w.args, evidenceRequirements: [req()] });
  w.mutate(['B']);
  const result = await w.controller.review({ loopId });
  assert.equal(result.status, 'REWORK');
  assert.deepEqual(result.missingEvidenceRequirements.map((r) => r.id), ['runtime']);
  assert.equal(result.evidenceSubmission, undefined);
  assert.match(result.reason, /required evidence missing/);
  assert.equal(w.calls.reviewer, 0);
});

test('generic phase headings and plain phase-plan prose do not declare the current task without strong plan context', () => {
  for (const text of [
    'Phase 1 Legacy protocol\nPhase 2 Current protocol',
    'Document the 2 phases plan used by the old subsystem.',
  ]) {
    assert.equal(declaredPhasePlan(text).count, null);
    assert.doesNotThrow(() => assertContractHandoff({ goal: text, phases: [] }));
  }
});

test('numbered Markdown phase lists under Execution Plan are fail-closed declarations', () => {
  const text = 'Execution Plan:\n1. Phase 1 Foundation\n2. Phase 2 Integration';
  assert.equal(declaredPhasePlan(text).count, 2);
  assert.throws(() => assertContractHandoff({ goal: text, phases: [] }), /phases\[\] is empty/);
  assert.doesNotThrow(() => assertContractHandoff({ goal: text, phases }));
});

test('missing prior-contract references are detected across line breaks', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.controller.begin({
    cwd: '/r',
    goal: 'Full specification was provided\nin the previous conversation.',
  }), /no self-contained contractText|prior conversation/i);
  assert.equal(h.calls.baseline, 0);
  assert.equal(h.calls.gate, 0);
});

test('phase verificationEvidence is bounded per item and in aggregate before baseline/model work', async () => {
  const perItem = 'x'.repeat(PHASE_VERIFICATION_EVIDENCE_LIMITS.itemBytes + 1);
  const aggregate = Array.from({ length: 5 }, (_, i) =>
    `proof-${i}-${'x'.repeat(3500)}`);
  for (const verificationEvidence of [[perItem], aggregate]) {
    const h = makeHarness();
    await assert.rejects(() => h.controller.begin({
      cwd: '/r',
      goal: 'Bound phase evidence.',
      phases: [{
        id: 'p1', title: 'P1', objective: 'Do P1.',
        exitCriteria: ['P1 complete.'], verificationEvidence,
      }],
    }), /verificationEvidence exceeds/);
    assert.equal(h.calls.baseline, 0);
    assert.equal(h.calls.gate, 0);
  }
});


test('explicit multi-phase counts recognize 10-19 and larger values', () => {
  for (const [text, count] of [
    ['Full spec has 12 phases.', 12],
    ['10-phase execution plan', 10],
    ['Execution plan contains 19 phases.', 19],
    ['Execution plan includes the 20 phases.', 20],
  ]) {
    assert.equal(declaredPhasePlan(text).count, count);
    assert.throws(() => assertContractHandoff({ goal: text, phases: [] }), /phases\[\] is empty/);
  }
});

test('reserved ids report reserved and mixed-id violations together when both apply', () => {
  const three = [
    { ...phases[0], id: 'final' },
    { ...phases[1], id: 'phase-2' },
    { ...phases[1], id: 'integration', title: 'Integration 2' },
  ];
  assert.throws(
    () => assertContractHandoff({ goal: 'Full spec has 3 phases.', phases: three }),
    (error) => /phase id "final" is reserved/i.test(error.message)
      && /mixes canonical phase-N ids with custom ids/i.test(error.message),
  );
});


test('full specification and contract wording are explicit multi-phase declarations', () => {
  for (const text of [
    'Full specification has 3 phases: Phase 1 foundation; Phase 2 integration; Phase 3 finish.',
    'Full contract has 3 phases.',
    'Complete specification has 3 phases.',
  ]) {
    assert.equal(declaredPhasePlan(text).count, 3);
    assert.throws(() => assertContractHandoff({ goal: text, phases: [] }), /phases\[\] is empty/);
  }
});

test('complete structured phase metadata is aggregate-bounded before baseline/Gate work', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.controller.begin({
    cwd: '/r',
    goal: 'Bound the full phase resume contract.',
    phases: [{
      id: 'p1',
      title: 'P1',
      objective: 'x'.repeat(PHASE_PLAN_MAX_BYTES + 1),
      exitCriteria: ['P1 complete.'],
      carryForwardInvariants: ['Preserve P1.'],
      verificationCommands: ['echo verify'],
    }],
  }), /complete structured phase plan exceeds/);
  assert.equal(h.calls.baseline, 0);
  assert.equal(h.calls.gate, 0);
});
