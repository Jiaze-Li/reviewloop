import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence, makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { resolveReviewLoopLimits } from '../src/reviewloop/reviewSpend.js';
import { reviewFingerprint } from '../src/reviewloop/reviewPolicy.js';

const phases = [
  {
    id: 'phase-1',
    title: 'Data semantics',
    objective: 'Establish the canonical data boundary.',
    exitCriteria: ['The canonical source is authoritative.'],
    carryForwardInvariants: ['Later work must not bypass the canonical source.'],
    verificationCommands: ['echo phase-1'],
  },
  {
    id: 'phase-2',
    title: 'UI integration',
    objective: 'Wire the UI to the canonical data boundary.',
    exitCriteria: ['The UI consumes only canonical results.'],
    carryForwardInvariants: ['The UI must preserve phase-1 data ownership.'],
    verificationCommands: ['echo phase-2'],
  },
];

test('phase plan: two PHASE_PASS results then one final PASS in the same loop', async () => {
  const { controller, calls, persistence } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'phase 1', changedFiles: ['a.js'] },
      { fingerprint: 'd2', diff: 'phase 2', changedFiles: ['a.js', 'b.js'] },
      // Final gate deliberately reviews the SAME cumulative diff as phase 2.
      { fingerprint: 'd2', diff: 'phase 2', changedFiles: ['a.js', 'b.js'] },
    ],
    reviews: [{ findings: [] }, { findings: [] }, { findings: [] }],
  });

  const begun = await controller.begin({ goal: 'large task', cwd: '/r', phases });
  assert.equal(begun.phaseCount, 2);
  assert.equal(begun.currentPhase, 'phase-1');

  const p1 = await controller.review({ loopId: begun.loopId });
  assert.equal(p1.status, 'PHASE_PASS');
  assert.equal(p1.completedPhase.id, 'phase-1');
  assert.equal(p1.nextPhase.id, 'phase-2');
  assert.equal(p1.finalGatePending, false);

  const p2 = await controller.review({ loopId: begun.loopId });
  assert.equal(p2.status, 'PHASE_PASS');
  assert.equal(p2.completedPhase.id, 'phase-2');
  assert.equal(p2.nextPhase, null);
  assert.equal(p2.finalGatePending, true);

  const final = await controller.review({ loopId: begun.loopId });
  assert.equal(final.status, 'PASS');
  assert.equal(calls.reviewer, 3, 'same diff is reviewable again under the distinct final scope');

  const persisted = await persistence.readWorkflowState(begun.loopId);
  assert.equal(persisted.reviewLoop.state, 'PASS');
  assert.equal(persisted.reviewLoop.currentPhaseIndex, 2);
  assert.deepEqual(persisted.reviewLoop.completedPhases.map((p) => p.id), ['phase-1', 'phase-2']);
});

test('phase pass is non-terminal and resets gate-local convergence state only', async () => {
  const { controller, persistence } = makeHarness({
    deltas: [
      { fingerprint: 'd1', diff: 'attempt 1' },
      { fingerprint: 'd2', diff: 'attempt 2' },
    ],
    reviews: [
      { findings: [finding('P1', 'a.js', 'fix me')] },
      { findings: [] },
    ],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', phases: [phases[0]] });

  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.gateRound, 1);

  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PHASE_PASS');

  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'READY_FOR_WORK');
  assert.equal(persisted.reviewLoop.round, 2, 'task-global audit round is monotonic');
  assert.equal(persisted.reviewLoop.gateRound, 0, 'next gate gets a fresh convergence counter');
  assert.deepEqual(persisted.reviewLoop.findingSignatureHistory, []);
  assert.equal(persisted.reviewLoop.supervisorInvoked, false);
  assert.equal(persisted.reviewLoop.budgetExhausted, false);
});

test('Supervisor non-convergence memory is gate-local and may be used once in a later phase too', async () => {
  const same = { findings: [finding('P1', 'a.js', 'persistent bug')] };
  const { controller, calls } = makeHarness({
    deltas: [
      { fingerprint: 'p1-a', diff: 'p1-a' },
      { fingerprint: 'p1-b', diff: 'p1-b' },
      { fingerprint: 'p1-c', diff: 'p1-c' },
      { fingerprint: 'p2-a', diff: 'p2-a' },
      { fingerprint: 'p2-b', diff: 'p2-b' },
    ],
    reviews: [same, same, { findings: [] }, same, same],
    supervisorReplies: [
      { guidance: 'phase 1 guidance', recommendation: 'REWORK' },
      { guidance: 'phase 2 guidance', recommendation: 'REWORK' },
    ],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', phases });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const p1r2 = await controller.review({ loopId });
  assert.equal(p1r2.status, 'REWORK');
  assert.equal(calls.supervisor, 1);

  assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  const p2r2 = await controller.review({ loopId });
  assert.equal(p2r2.status, 'REWORK');
  assert.equal(calls.supervisor, 2, 'phase 2 owns a fresh Supervisor escalation opportunity');
});

test('phase-specific verification commands join the zero-token deterministic Gate', async () => {
  const persistence = new MemoryPersistence();
  const seenCommands = [];
  let deltaCalls = 0;
  let reviewerCalls = 0;
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({
      head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true,
    }),
    collectWorkerDeltaFn: async () => {
      deltaCalls += 1;
      return {
        baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['a.js'], fingerprint: `d${deltaCalls}`, diff: 'diff',
      };
    },
    discoverVerificationCommandsFn: () => ({
      source: 'repo-config', commands: ['echo global'], manifestFingerprint: 'mf',
    }),
    runGateFn: async ({ commands }) => {
      seenCommands.push([...commands]);
      return { verdict: 'PASS', pass: true, fingerprint: `g${seenCommands.length}`, failureIdentities: [], results: [] };
    },
    reviewerFn: async () => {
      reviewerCalls += 1;
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });

  const { loopId } = await controller.begin({
    goal: 'g',
    cwd: '/r',
    phases: [phases[0]],
  });
  assert.deepEqual(seenCommands[0], ['echo global'], 'begin-time baseline Gate stays global');

  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PHASE_PASS');
  assert.deepEqual(seenCommands[1], ['echo global', 'echo phase-1']);
  assert.equal(reviewerCalls, 1);

  const final = await controller.review({ loopId });
  assert.equal(final.status, 'PASS');
  assert.deepEqual(
    seenCommands[2],
    ['echo global'],
    'final Gate uses only the frozen whole-task/global verification plan',
  );
});

test('phase plan is covered by immutable objective fingerprint', async () => {
  const { controller, persistence } = makeHarness();
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', phases: [phases[0]] });

  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.objective.phases[0].objective = 'weakened replacement';
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(
    () => controller.review({ loopId }),
    /ReviewObjective weakened|fingerprint/,
  );
});

test('ordinary task without phases preserves the existing single PASS behavior', async () => {
  const { controller } = makeHarness({ reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'small task', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(r.completedPhase, undefined);
});

test('coarse physical-call ceilings scale with frozen gate count while task-wide token ceilings do not', () => {
  const one = resolveReviewLoopLimits({}, { gateCount: 1 });
  const three = resolveReviewLoopLimits({}, { gateCount: 3 });

  assert.equal(three.maxReviewerCalls, one.maxReviewerCalls * 3);
  assert.equal(three.maxSupervisorCalls, one.maxSupervisorCalls * 3);
  assert.equal(three.maxUsageVolume, one.maxUsageVolume);
  assert.equal(three.maxCostUsd, one.maxCostUsd);
  assert.equal(three.maxSingleCallUsage, one.maxSingleCallUsage);
  assert.equal(three.maxContextOverheadTokens, one.maxContextOverheadTokens);
});

test('ordinary-task review fingerprint remains byte-compatible with pre-phase semantics', () => {
  const legacy = reviewFingerprint({ deltaFingerprint: 'd', gateFingerprint: 'g' });
  const explicitNoScope = reviewFingerprint({
    deltaFingerprint: 'd',
    gateFingerprint: 'g',
    reviewScopeFingerprint: '',
  });
  const phaseScoped = reviewFingerprint({
    deltaFingerprint: 'd',
    gateFingerprint: 'g',
    reviewScopeFingerprint: 'phase-scope',
  });
  assert.equal(explicitNoScope, legacy);
  assert.notEqual(phaseScoped, legacy);
});

test('phase progression cannot skip a frozen phase by editing durable state', async () => {
  const { controller, persistence } = makeHarness();
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', phases });

  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.currentPhaseIndex = 2;
  raw.reviewLoop.completedPhases = [];
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(
    () => controller.review({ loopId }),
    /phase progression invalid/,
  );
});

test('phase progression requires completed phase ids to match the frozen prefix', async () => {
  const { controller, persistence } = makeHarness();
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', phases });

  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.currentPhaseIndex = 1;
  raw.reviewLoop.completedPhases = [{ id: 'phase-2' }];
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(
    () => controller.review({ loopId }),
    /phase progression invalid/,
  );
});

test('legacy no-phase loop without gateRound keeps its already-spent convergence rounds', async () => {
  const blocker = { findings: [finding('P1', 'a.js', 'persistent legacy bug')] };
  const { controller, persistence } = makeHarness({
    deltas: [
      { fingerprint: 'legacy-d1', diff: 'legacy 1' },
      { fingerprint: 'legacy-d2', diff: 'legacy 2' },
      { fingerprint: 'legacy-d3', diff: 'legacy 3' },
    ],
    reviews: [blocker, blocker, blocker],
    supervisorReplies: [{ guidance: 'try once', recommendation: 'REWORK' }],
  });
  const { loopId } = await controller.begin({ goal: 'legacy task', cwd: '/r' });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  assert.equal((await controller.review({ loopId })).status, 'REWORK');

  const raw = await persistence.readWorkflowState(loopId);
  assert.equal(raw.reviewLoop.round, 2);
  delete raw.reviewLoop.gateRound; // simulate durable state written pre-phase
  await persistence.writeWorkflowState(loopId, raw);

  const third = await controller.review({ loopId });
  assert.equal(third.status, 'HUMAN_REQUIRED');
  assert.equal(third.gateRound, 3, 'legacy round 2 must migrate to gateRound 2 before the third review');
});

test('legacy checkpoint without gateRound resumes at its previously assigned round', async () => {
  const { controller, persistence, calls } = makeHarness({
    deltas: [
      { fingerprint: 'same', diff: 'same evidence' },
      { fingerprint: 'same', diff: 'same evidence' },
    ],
    reviews: [{ findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'legacy checkpoint task', cwd: '/r' });

  // Build a synthetic pre-phase checkpoint for logical round 2. No chunk result
  // is retained, so the resumed call must dispatch the Reviewer but must reuse
  // the already-assigned convergence round rather than reset it.
  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.round = 2;
  delete raw.reviewLoop.gateRound;
  raw.reviewLoop.chunkReviewCheckpoint = {
    key: 'stale-layout-key',
    deltaGateKey: null,
    chunkTotal: 1,
    chunks: {},
    round: 2,
  };
  await persistence.writeWorkflowState(loopId, raw);

  // Let the controller create the current logical checkpoint; the no-phase
  // migration path must never reduce convergence state below the legacy round.
  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PASS');
  const after = await persistence.readWorkflowState(loopId);
  assert.ok(after.reviewLoop.gateRound >= 2);
  assert.equal(calls.reviewer, 1);
});
