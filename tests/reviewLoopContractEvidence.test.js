import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
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
  assert.equal(passed.evidenceRecords.length, 1);
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
