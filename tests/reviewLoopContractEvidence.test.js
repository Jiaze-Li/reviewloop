import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { bindEvidenceSubmissions, reviewerEvidenceBundle, EVIDENCE_LIMITS } from '../src/reviewloop/contractEvidence.js';
import { buildReviewerInvoke, buildSupervisorInvoke } from '../src/reviewloop/providerWiring.js';
import { MemoryPersistence, makeHarness, finding } from './helpers/reviewLoopHarness.js';

const phases = [
  {
    id: 'phase-1',
    title: 'Foundation',
    objective: 'Establish the durable foundation.',
    exitCriteria: ['Foundation is complete.'],
    carryForwardInvariants: ['Later work preserves the foundation.'],
    verificationCommands: ['echo p1'],
    verificationEvidence: ['Inspect the durable record after reload.'],
  },
  {
    id: 'phase-2',
    title: 'Integration',
    objective: 'Integrate the user-facing flow.',
    exitCriteria: ['Integration is complete.'],
    carryForwardInvariants: ['The foundation remains authoritative.'],
    verificationCommands: ['echo p2'],
    verificationEvidence: ['Exercise the real interaction path.'],
  },
];

test('begin fails closed when task text clearly declares phases but phases[] is empty', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Full spec has 3 phases: Phase 1 foundation; Phase 2 integration; Phase 3 final wiring.',
      cwd: '/r',
    }),
    /phases\[\] is empty|silently downgrade/i,
  );
});

test('begin rejects a nonempty but truncated structured phase plan', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Full spec has 3 phases.',
      contractText: [
        'Execution Plan',
        'Phase 1 Foundation',
        'Phase 2 Integration',
        'Phase 3 Final wiring',
      ].join('\n'),
      cwd: '/r',
      phases: [phases[0]],
    }),
    /declares 3 phases.*contains 1|truncated/i,
  );
});

test('begin rejects a partially truncated structured phase plan', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Full spec has 3 phases.',
      contractText: 'Execution Plan: Phase 1 Foundation. Phase 2 Integration. Phase 3 Final wiring.',
      cwd: '/r',
      phases,
    }),
    /declares 3 phases.*contains 2|truncated/i,
  );
});

test('begin accepts a complete canonical structured phase plan', async () => {
  const { controller } = makeHarness();
  const threePhases = [
    ...phases,
    {
      id: 'phase-3',
      title: 'Final wiring',
      objective: 'Complete the final wiring.',
      exitCriteria: ['Final wiring is complete.'],
      carryForwardInvariants: ['Final wiring preserves earlier behavior.'],
    },
  ];
  const begun = await controller.begin({
    goal: 'Full spec has 3 phases.',
    contractText: [
      'Execution Plan',
      'Phase 1 Foundation',
      'Phase 2 Integration',
      'Phase 3 Final wiring',
    ].join('\n'),
    cwd: '/r',
    phases: threePhases,
  });
  assert.equal(begun.phaseCount, 3);
  assert.equal(begun.currentPhase, 'phase-1');
});

test('begin rejects out-of-order canonical structured phase ids', async () => {
  const { controller } = makeHarness();
  const wrongOrder = [
    phases[0],
    { ...phases[1], id: 'phase-3' },
    {
      id: 'phase-2',
      title: 'Final wiring',
      objective: 'Complete the final wiring.',
      exitCriteria: ['Final wiring is complete.'],
    },
  ];
  await assert.rejects(
    () => controller.begin({
      goal: 'Full spec has 3 phases.',
      contractText: 'Execution Plan: Phase 1 Foundation. Phase 2 Integration. Phase 3 Final wiring.',
      cwd: '/r',
      phases: wrongOrder,
    }),
    /canonical structured phase ids.*phase-1\.\.phase-3|got 1, 3, 2/i,
  );
});

test('incidental phase-number prose does not force phased execution', async () => {
  const { controller } = makeHarness();
  const begun = await controller.begin({
    goal: 'Compare phase 1 and phase 2 behavior in the existing algorithm; this is not an execution plan.',
    cwd: '/r',
  });
  assert.equal(begun.phaseCount, 0);
  assert.equal(begun.currentPhase, 'task');
});

test('begin fails closed when task points to prior conversation instead of supplying the contract', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Full spec was provided in the user\'s original task message in this conversation; treat it as authoritative.',
      cwd: '/r',
    }),
    /self-contained contractText|prior conversation/i,
  );
});

test('structured phase handoff preserves descriptive phase verification evidence', async () => {
  const { controller, persistence } = makeHarness();
  const { loopId } = await controller.begin({
    goal: 'Implement the frozen task.',
    contractText: 'Goal: implement the frozen task. Execution Plan: Phase 1 Foundation. Phase 2 Integration.',
    cwd: '/r',
    phases,
  });
  const raw = await persistence.readWorkflowState(loopId);
  assert.deepEqual(
    raw.reviewLoop.objective.phases.map((p) => p.verificationEvidence),
    [
      ['Inspect the durable record after reload.'],
      ['Exercise the real interaction path.'],
    ],
  );
  assert.match(raw.reviewLoop.objective.contractText, /Execution Plan/);
});


test('evidence requirements target one explicit gate; ambiguous all-scope is rejected', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Evidence-scoped task.',
      contractText: 'Goal: evidence-scoped task.',
      cwd: '/r',
      evidenceRequirements: [{
        id: 'runtime',
        type: 'runtime',
        description: 'Run the runtime check.',
        gate: 'all',
      }],
    }),
    /unknown gate "all"/i,
  );
});

test('legacy task evidence scope is rejected in favor of universal final scope', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Evidence-scoped task.',
      contractText: 'Goal: evidence-scoped task.',
      cwd: '/r',
      evidenceRequirements: [{
        id: 'runtime-task-alias',
        type: 'runtime',
        description: 'Run the runtime check.',
        gate: 'task',
      }],
    }),
    /unknown gate \"task\"/i,
  );
});

test('reserved review-scope ids cannot be used as phase ids', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.begin({
      goal: 'Two-phase task.',
      contractText: 'Execution Plan: Phase 1 Foundation. Phase 2 Completion.',
      cwd: '/r',
      phases: [
        phases[0],
        {
          ...phases[1],
          id: 'final',
        },
      ],
    }),
    /phase id "final" is reserved/i,
  );
});

test('submitted optional evidence keeps its requirement description for Reviewer context', () => {
  const objective = {
    evidenceRequirements: [{
      id: 'optional-diagnostic',
      type: 'artifact',
      description: 'Optional diagnostic trace that can strengthen review confidence.',
      gate: 'final',
      required: false,
      covers: [],
    }],
  };
  const reviewScope = { type: 'task', id: 'task', fingerprint: '' };
  const loopState = { evidenceRecords: [] };
  bindEvidenceSubmissions({
    loopState,
    objective,
    reviewScope,
    submissions: [{
      requirementId: 'optional-diagnostic',
      summary: 'Attached the diagnostic trace.',
      artifactRef: 'trace.txt',
    }],
    evidenceFingerprint: 'code-1',
    head: 'H1',
    now: '2026-09-18T00:00:00Z',
  });
  const bundle = reviewerEvidenceBundle({
    loopState, objective, reviewScope, evidenceFingerprint: 'code-1',
  });
  assert.equal(bundle.requirements.length, 1);
  assert.equal(bundle.requirements[0].description, objective.evidenceRequirements[0].description);
  assert.equal(bundle.submissions[0].requirementId, 'optional-diagnostic');
});

test('reviewer and supervisor prompts keep the mandatory goal when contractText is present', async () => {
  let reviewerPrompt = '';
  const reviewerInvoke = buildReviewerInvoke();
  await reviewerInvoke({
    objective: {
      goal: 'Preserve the actual success definition.',
      contractText: 'Phase/evidence details that do not restate the concise goal.',
      constraints: [],
    },
    diff: 'diff --git a/a.js b/a.js',
    changedFiles: ['a.js'],
    gate: { verdict: 'PASS' },
    transport: async (prompt) => {
      reviewerPrompt = prompt;
      return { text: '{"findings":[]}' };
    },
  });
  assert.match(reviewerPrompt, /ORIGINAL TASK GOAL .*Preserve the actual success definition\./);
  assert.ok(reviewerPrompt.includes('FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\nPhase/evidence details'));

  let supervisorPrompt = '';
  const supervisorInvoke = buildSupervisorInvoke();
  await supervisorInvoke({
    objective: {
      goal: 'Preserve the actual success definition.',
      contractText: 'Phase/evidence details that do not restate the concise goal.',
    },
    blockingFindings: [{ severity: 'P1', title: 'x' }],
    transport: async (prompt) => {
      supervisorPrompt = prompt;
      return { text: '{"guidance":"fix x","recommendation":"REWORK"}' };
    },
  });
  assert.match(supervisorPrompt, /ORIGINAL TASK GOAL .*Preserve the actual success definition\./);
  assert.ok(supervisorPrompt.includes('FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\nPhase/evidence details'));
});

test('required final runtime evidence blocks Reviewer spend until submitted', async () => {
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'same', diff: 'change' },
      { fingerprint: 'same', diff: 'change' },
    ],
    reviews: [{ findings: [] }],
  });
  const { loopId } = await controller.begin({
    goal: 'Change a real interaction.',
    contractText: 'Goal: change the real interaction and prove it in the running app.',
    cwd: '/r',
    evidenceRequirements: [{
      id: 'runtime-ui',
      type: 'runtime',
      description: 'Exercise the production UI interaction in the running application.',
      gate: 'final',
      covers: ['AC1'],
    }],
  });

  const missing = await controller.review({ loopId });
  assert.equal(missing.status, 'REWORK');
  assert.deepEqual(missing.missingEvidenceRequirements.map((r) => r.id), ['runtime-ui']);
  assert.equal(calls.reviewer, 0, 'missing mandatory evidence is a zero-model deterministic block');

  const passed = await controller.review({
    loopId,
    evidence: [{
      requirementId: 'runtime-ui',
      summary: 'Launched the production app and completed the AC1 interaction successfully.',
      artifactRef: 'runtime-smoke-2026-09-18',
    }],
  });
  assert.equal(passed.status, 'PASS');
  assert.equal(calls.reviewer, 1);
  assert.equal(passed.evidenceRecordCount, 1);
  assert.equal(passed.evidenceRecords, undefined);
});

test('evidence is bound to the exact diff and becomes stale after code changes', async () => {
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'first change' },
      { fingerprint: 'd1', diff: 'first change' },
      { fingerprint: 'd2', diff: 'second change' },
    ],
    reviews: [
      { findings: [finding('P1', 'a.js', 'needs a code fix')] },
    ],
  });
  const { loopId } = await controller.begin({
    goal: 'Runtime-sensitive task.',
    contractText: 'Goal: runtime-sensitive task.',
    cwd: '/r',
    evidenceRequirements: [{
      id: 'runtime',
      type: 'runtime',
      description: 'Run the real runtime smoke test.',
      gate: 'final',
    }],
  });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const reviewed = await controller.review({
    loopId,
    evidence: [{ requirementId: 'runtime', summary: 'Runtime smoke passed on d1.' }],
  });
  assert.equal(reviewed.status, 'REWORK');
  assert.equal(calls.reviewer, 1);

  const stale = await controller.review({ loopId });
  assert.equal(stale.status, 'REWORK');
  assert.deepEqual(stale.missingEvidenceRequirements.map((r) => r.id), ['runtime']);
  assert.equal(calls.reviewer, 1, 'stale runtime evidence cannot authorize a new-code review');
});


test('PASS and resume packets never echo raw evidence summaries into Worker context', async () => {
  const huge = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes);

  const passHarness = makeHarness({
    deltas: [{ fingerprint: 'bounded-pass', diff: 'change' }],
    reviews: [{ findings: [] }],
  });
  const { loopId: passLoop } = await passHarness.controller.begin({
    goal: 'Bound final evidence output.',
    contractText: 'Goal: bound final evidence output.',
    cwd: '/r',
    evidenceRequirements: [{
      id: 'runtime',
      type: 'runtime',
      description: 'Runtime proof.',
      gate: 'final',
    }],
  });
  const passed = await passHarness.controller.review({
    loopId: passLoop,
    evidence: [{ requirementId: 'runtime', summary: huge }],
  });
  assert.equal(passed.status, 'PASS');
  assert.equal(passed.evidenceRecordCount, 1);
  assert.equal(JSON.stringify(passed).includes(huge.slice(0, 1000)), false);

  const phaseHarness = makeHarness({
    deltas: [{ fingerprint: 'bounded-phase', diff: 'phase change' }],
    reviews: [{ findings: [] }],
  });
  const { loopId: phaseLoop } = await phaseHarness.controller.begin({
    goal: 'Two-phase task.',
    contractText: 'Execution Plan: Phase 1 Foundation. Phase 2 Integration.',
    cwd: '/r',
    phases,
    evidenceRequirements: [{
      id: 'phase-proof',
      type: 'runtime',
      description: 'Phase 1 runtime proof.',
      gate: 'phase-1',
    }],
  });
  const phasePass = await phaseHarness.controller.review({
    loopId: phaseLoop,
    evidence: [{ requirementId: 'phase-proof', summary: huge }],
  });
  assert.equal(phasePass.status, 'PHASE_PASS');
  assert.equal(phasePass.resumePacket.evidenceRecordCount, 1);
  assert.equal(phasePass.resumePacket.evidenceRecords, undefined);
  assert.equal(JSON.stringify(phasePass.resumePacket).includes(huge.slice(0, 1000)), false);
});

test('improved evidence is new information even when code and Gate are unchanged', async () => {
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'same-code', diff: 'same change' },
      { fingerprint: 'same-code', diff: 'same change' },
    ],
    gates: [
      { verdict: 'PASS', fingerprint: 'same-gate', failureIdentities: [] },
      { verdict: 'PASS', fingerprint: 'same-gate', failureIdentities: [] },
    ],
    reviews: [
      { findings: [finding('P1', 'ui.js', 'runtime evidence is too weak')] },
      { findings: [] },
    ],
  });
  const { loopId } = await controller.begin({
    goal: 'Prove the runtime-sensitive behavior.',
    contractText: 'Goal: prove the runtime-sensitive behavior with sufficient runtime evidence.',
    cwd: '/r',
    evidenceRequirements: [{
      id: 'runtime-ui',
      type: 'runtime',
      description: 'Exercise the real production interaction.',
      gate: 'final',
    }],
  });

  const weak = await controller.review({
    loopId,
    evidence: [{ requirementId: 'runtime-ui', summary: 'Opened the app only.' }],
  });
  assert.equal(weak.status, 'REWORK');
  assert.equal(calls.reviewer, 1);

  const improved = await controller.review({
    loopId,
    evidence: [{
      requirementId: 'runtime-ui',
      summary: 'Ran the complete production interaction and observed the required state transition.',
    }],
  });
  assert.equal(improved.status, 'PASS');
  assert.equal(calls.reviewer, 2, 'revised proof authorizes a fresh review without unrelated code churn');
});

test('PHASE_PASS returns and durably stores a compact resume packet for context refresh', async () => {
  const { controller, persistence } = makeHarness({
    deltas: [{ fingerprint: 'p1', diff: 'phase 1 change' }],
    reviews: [{ findings: [] }],
  });
  const { loopId } = await controller.begin({
    goal: 'Two-phase task.',
    contractText: 'Goal: two-phase task. Execution Plan: Phase 1 Foundation. Phase 2 Integration.',
    cwd: '/r',
    phases,
  });

  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PHASE_PASS');
  assert.equal(result.contextRefreshSafe, true);
  assert.equal(result.resumePacket.loopId, loopId);
  assert.equal(result.resumePacket.nextPhase.id, 'phase-2');
  assert.deepEqual(
    result.resumePacket.nextPhase.carryForwardInvariants,
    ['The foundation remains authoritative.'],
  );
  assert.deepEqual(
    result.resumePacket.carryForwardInvariants,
    ['Later work preserves the foundation.'],
  );
  assert.deepEqual(
    result.resumePacket.nextPhase.verificationEvidence,
    ['Exercise the real interaction path.'],
  );

  const raw = await persistence.readWorkflowState(loopId);
  assert.deepEqual(raw.reviewLoop.resumePacket, result.resumePacket);
  assert.equal(raw.reviewLoop.currentPhaseIndex, 1);
});
