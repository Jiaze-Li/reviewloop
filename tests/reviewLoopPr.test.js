// PR target: reviewed by the ONE unified ReviewLoop engine.
//
// A PR is a review TARGET (PR base -> exact PR HEAD), never a reviewer
// transport. The same deterministic Gate, internal Reviewer routing,
// Supervisor, spend accounting and 3-round convergence policy that judge a
// LOCAL target judge a PR target. There is no `@codex review` / `@claude
// review`, no external-review polling, no reaction-as-clean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  MemoryPersistence, mockPrBackend, finding, prTestFakes,
} from './helpers/reviewLoopHarness.js';

function build({
  prBackend, reviews = [], gates = [], supervisorReplies = [], onReviewer, persistence = new MemoryPersistence(),
} = {}) {
  const calls = { reviewer: 0, supervisor: 0, gate: 0 };
  let ri = 0;
  let gi = 0;
  let si = 0;
  const controller = createReviewLoopController({
    persistence,
    prBackend,
    ...prTestFakes(prBackend),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => {
      const g = gates[gi] ?? gates[gates.length - 1] ?? { verdict: 'PASS' };
      gi += 1;
      calls.gate += 1;
      return {
        pass: g.verdict !== 'FAIL', results: [], fingerprint: `g${gi}`, failureIdentities: [], ...g,
      };
    },
    reviewerFn: async (args) => {
      const r = reviews[ri] ?? reviews[reviews.length - 1] ?? { findings: [] };
      ri += 1;
      calls.reviewer += 1;
      onReviewer?.(args);
      return { value: r, usage: { input_tokens: 3, output_tokens: 2 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => {
      const s = supervisorReplies[si] ?? { guidance: 'g', recommendation: 'REWORK' };
      si += 1;
      calls.supervisor += 1;
      return { value: s, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  return { controller, persistence, calls };
}

const phasePlan = [
  {
    id: 'phase-1',
    title: 'Core',
    objective: 'Establish the core behavior.',
    exitCriteria: ['Core behavior is correct.'],
    carryForwardInvariants: ['Later phases preserve the core behavior.'],
    verificationCommands: ['echo phase-1'],
  },
  {
    id: 'phase-2',
    title: 'Integration',
    objective: 'Integrate the core behavior.',
    exitCriteria: ['Integration is complete.'],
    carryForwardInvariants: ['Final behavior preserves the core contract.'],
    verificationCommands: ['echo phase-2'],
  },
];

// A -- PR target uses the internal Reviewer pool, not an external trigger.
test('A: PR review runs the internal Reviewer, not an external trigger', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller, calls } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId, ...begun } = await controller.begin({ goal: 'fix pr', cwd: '/r', prNumber: 4 });
  assert.equal(begun.mode, 'PR');
  assert.equal(begun.reviewer, 'internal');
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(calls.reviewer, 1);
  assert.equal(calls.gate, 1);
  assert.equal(typeof backend.postReviewTrigger, 'undefined');
  assert.equal(typeof backend.waitForReview, 'undefined');
});

// B -- the PR base->head delta is the Reviewer evidence.
test('B: the Reviewer sees the PR base->HEAD diff', async () => {
  const backend = mockPrBackend({
    base: 'BASE9', heads: ['H1'],
    diffByHead: { H1: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+PR_DIFF_BODY\n' },
  });
  let seen = null;
  const { controller } = build({
    prBackend: backend, reviews: [{ findings: [] }], onReviewer: (a) => { seen = a; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 7 });
  await controller.review({ loopId });
  assert.match(seen.diff, /PR_DIFF_BODY/);
  assert.deepEqual(seen.changedFiles, ['f.js']);
});

// C -- CLEAN + final HEAD unchanged -> PASS.
test('C: Reviewer CLEAN and the PR HEAD still current -> PASS', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller } = build({ prBackend: backend, reviews: [{ findings: [finding('P3')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
});

// D -- CLEAN but the PR HEAD moved during the review -> never PASS the stale review.
test('D: Reviewer CLEAN but the PR HEAD moved -> not PASS', async () => {
  // getPrHead: 1st (observed)=H1, every later call=H2 -> the pre-PASS recheck
  // and every rebind see a moving HEAD.
  const backend = mockPrBackend({ movingHead: true });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'WAITING_FOR_REVIEW');
  const st = await persistence.readWorkflowState(loopId);
  assert.notEqual(st.reviewLoop.state, 'PASS');
  // The stale-HEAD event was recorded.
  assert.ok((r.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_PR_HEAD_MOVED_DURING_REVIEW'));
});

// E -- blocking finding -> REWORK; a new HEAD lets the next round run.
test('E: blocking PR finding -> REWORK, then the next HEAD -> a fresh round', async () => {
  const backend = mockPrBackend({ heads: ['H1', 'H2'] });
  const { controller } = build({
    prBackend: backend,
    reviews: [{ findings: [finding('P1')] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.round, 1);
  assert.equal(r1.blockingFindings.length, 1);

  // No push yet -> PUSH_REQUIRED, Reviewer not re-run.
  const rp = await controller.review({ loopId });
  assert.equal(rp.status, 'PUSH_REQUIRED');

  backend.advanceHead(); // Worker pushed H2
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(r2.round, 2);
});


test('revised runtime evidence can be re-reviewed on the same PR HEAD', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller, calls } = build({
    prBackend: backend,
    gates: [
      { verdict: 'PASS', fingerprint: 'same-gate' },
      { verdict: 'PASS', fingerprint: 'same-gate' },
    ],
    reviews: [
      { findings: [finding('P1', 'ui.js', 'runtime evidence is too weak')] },
      { findings: [] },
    ],
  });
  const { loopId } = await controller.begin({
    goal: 'PR runtime evidence task',
    contractText: 'Goal: prove the runtime behavior on the reviewed PR.',
    cwd: '/r',
    prNumber: 4,
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
      summary: 'Completed the full production interaction and observed the required result.',
    }],
  });
  assert.equal(improved.status, 'PASS');
  assert.equal(calls.reviewer, 2, 'evidence-only progress must not require an unrelated push');
});

// F -- durable audit record.
test('F: every PR round writes a recoverable, tamper-evident audit record', async () => {
  const backend = mockPrBackend({ base: 'BASEabc', heads: ['H1'] });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'audit me', cwd: '/r', prNumber: 12 });
  await controller.review({ loopId });
  const audit = (await persistence.readWorkflowState(loopId)).reviewLoop.audit;
  assert.equal(audit.length, 1);
  const rec = audit[0];
  assert.equal(rec.target.type, 'PR');
  assert.equal(rec.target.repository, 'acme/repo');
  assert.equal(rec.target.prNumber, 12);
  assert.equal(rec.target.baseSha, 'BASEabc');
  assert.equal(rec.target.reviewedHeadSha, 'H1');
  assert.equal(rec.target.finalObservedHeadSha, 'H1');
  assert.equal(rec.target.headStillCurrent, true);
  assert.equal(rec.result, 'PASS');
  assert.equal(rec.review.reviewer, 'internal pool');
  assert.ok(Array.isArray(rec.review.physicalCalls) && rec.review.physicalCalls.length >= 1, 'every physical Reviewer attempt is recorded');
  assert.ok(rec.review.physicalCalls.every((pc) => pc.role === 'reviewer' && pc.family), 'each physical call carries its family/provider');
  assert.ok(rec.gate && rec.gate.verdict);
  assert.ok(rec.spend && typeof rec.spend.reviewerCalls === 'number');
  assert.ok(rec.objective.fingerprint);
  assert.ok(rec.targetFingerprint);
});

// G -- resume keeps the exact PR snapshot identity.
test('G: a resumed PR loop keeps its frozen snapshot identity', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1', 'H2'] });
  const persistence = new MemoryPersistence();
  const { controller } = build({
    prBackend: backend, persistence, reviews: [{ findings: [finding('P1')] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });
  const obj = (await persistence.readWorkflowState(loopId)).reviewLoop.objective;
  assert.equal(obj.prBaseSha, 'B1');
  assert.equal(obj.reviewedHeadSha, 'H1');
  assert.equal(obj.prNumber, 4);
  // A fresh controller over the SAME persistence resumes without losing identity.
  const { controller: c2 } = build({ prBackend: backend, persistence, reviews: [{ findings: [] }] });
  backend.advanceHead();
  const r = await c2.review({ loopId });
  assert.equal(r.status, 'PASS');
  const obj2 = (await persistence.readWorkflowState(loopId)).reviewLoop.objective;
  assert.equal(obj2.reviewedHeadSha, 'H1', 'the frozen begin-time HEAD is unchanged');
});

// H -- tampered persisted PR identity -> objective integrity fails closed.
test('H: editing the persisted PR base/HEAD SHA fails the objective integrity check', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1'] });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.objective.prBaseSha = 'ATTACKER_BASE';
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(() => controller.review({ loopId }), /weakened|integrity|fingerprint/i);
});

// I -- no external-review path is ever taken.
test('I: the PR review path never calls an external reviewer trigger or poll', async () => {
  const backend = mockPrBackend({ heads: ['H1', 'H2', 'H3'] });
  let externalTouch = 0;
  const proxied = new Proxy(backend, {
    get(t, p) {
      if (['postReviewTrigger', 'waitForReview', 'findExistingReview', 'listIssueCommentReactions', 'listReviews'].includes(p)) {
        externalTouch += 1;
      }
      return t[p];
    },
  });
  const { controller } = build({ prBackend: proxied, reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });
  backend.advanceHead();
  await controller.review({ loopId });
  assert.equal(externalTouch, 0);
});

// PR reviewer identity is always internal — no external reviewer concept.
test('PR objective reviewer is always internal', async () => {
  const { createReviewObjective } = await import('../src/reviewloop/objective.js');
  const o = createReviewObjective({
    loopId: 'l', goal: 'g', mode: 'PR', prNumber: 4, prBaseSha: 'B', reviewedHeadSha: 'H',
  });
  assert.equal(o.reviewer, 'internal');
});

// begin fails closed when the PR snapshot cannot be resolved.
test('begin fails closed when the PR base SHA cannot be resolved', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  backend.getPrBaseSha = async () => null;
  const { controller } = build({ prBackend: backend });
  await assert.rejects(
    () => controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
    /cannot resolve the base SHA/,
  );
});

// a cancelled PR review never reaches the Reviewer.
test('a cancelled PR review stops before the Reviewer', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller, calls } = build({ prBackend: backend, reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const ac = new AbortController();
  ac.abort();
  const r = await controller.review({ loopId, signal: ac.signal });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.notEqual(r.terminal, true);
  assert.equal(calls.reviewer, 0);
});

// J -- a failover round keeps EVERY physical Reviewer attempt in the audit.
test('J: a failover round keeps every physical Reviewer attempt in the audit, not just the winner', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  let calls = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, results: [], fingerprint: 'g1', failureIdentities: [],
    }),
    routeReviewerFn: ({ reworkCycles }) => (reworkCycles === 0
      ? { family: 'agy:opus', provider: 'agy', model: 'claude-opus-4-6' }
      : { family: 'agy:sonnet', provider: 'agy', model: 'claude-sonnet-5' }),
    reviewerFn: async ({ selection }) => {
      calls += 1;
      if (selection?.family === 'agy:opus') {
        // Mechanically-zero pre-send failure (never reached the provider) —
        // retryable via failover AND settles known-zero usage, so it never
        // trips the separate "unaccounted spend" fail-closed latch this test
        // is not exercising.
        const err = new Error('provider unavailable');
        err.code = 'PROVIDER_UNAVAILABLE';
        throw err;
      }
      return { value: { findings: [] }, usage: { input_tokens: 4, output_tokens: 2 }, model: selection?.model };
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(calls, 2, 'the failing first attempt and the succeeding failover attempt both physically ran');

  const audit = (await controller._persistence.readWorkflowState(loopId)).reviewLoop.audit;
  const physicalCalls = audit[0].review.physicalCalls;
  assert.equal(physicalCalls.length, 2, 'both physical attempts are traceable — not collapsed into one abstract "internal"');
  assert.equal(physicalCalls[0].family, 'agy:opus');
  assert.equal(physicalCalls[0].outcome, 'FAILURE');
  assert.equal(physicalCalls[0].code, 'PROVIDER_UNAVAILABLE');
  assert.equal(physicalCalls[0].usage, null);
  assert.equal(physicalCalls[1].family, 'agy:sonnet');
  assert.equal(physicalCalls[1].outcome, 'SUCCESS');
  assert.equal(physicalCalls[1].resolvedModel, 'claude-sonnet-5');
  assert.deepEqual(physicalCalls[1].usage, { input_tokens: 4, output_tokens: 2 });
});

// ReviewLoop still never pushes / merges.
test('the controller exposes no push / merge / force-push operation', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/reviewloop/controller.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /git push|gh pr merge|forcePush|--force\b/);
});


// K -- phase-aware PR flow is covered end-to-end, including audit binding.
test('K: PR phases produce PHASE_PASS -> PHASE_PASS -> final PASS in one loop', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1'] });
  const { controller, persistence, calls } = build({
    prBackend: backend,
    reviews: [{ findings: [] }, { findings: [] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({
    goal: 'phase-aware PR',
    cwd: '/r',
    prNumber: 4,
    phases: phasePlan,
  });

  const p1 = await controller.review({ loopId });
  assert.equal(p1.status, 'PHASE_PASS');
  assert.equal(p1.completedPhase.id, 'phase-1');
  assert.equal(p1.nextPhase.id, 'phase-2');

  const p2 = await controller.review({ loopId });
  assert.equal(p2.status, 'PHASE_PASS');
  assert.equal(p2.completedPhase.id, 'phase-2');
  assert.equal(p2.finalGatePending, true);

  const final = await controller.review({ loopId });
  assert.equal(final.status, 'PASS');
  assert.equal(calls.reviewer, 3);

  const persisted = await persistence.readWorkflowState(loopId);
  assert.deepEqual(
    persisted.reviewLoop.audit.map((record) => record.result),
    ['PHASE_PASS', 'PHASE_PASS', 'PASS'],
  );
  assert.deepEqual(
    persisted.reviewLoop.completedPhases.map((phase) => phase.id),
    ['phase-1', 'phase-2'],
  );
  assert.ok(persisted.reviewLoop.completedPhases.every((phase) => phase.proof));
  assert.ok(
    persisted.reviewLoop.completedPhases.every((phase) =>
      persisted.reviewLoop.audit.some((record) =>
        record.result === 'PHASE_PASS'
        && record.reviewScope.id === phase.id
        && record.targetFingerprint === phase.auditTargetFingerprint
      )),
  );
});

// L -- a stale clean phase review cannot advance the phase; the new HEAD must be reviewed first.
test('L: PR phase waits for exact-HEAD re-review before PHASE_PASS when HEAD moves', async () => {
  const backend = mockPrBackend({
    base: 'B1',
    // begin=H1, first round observed=H1, pre-pass recheck=H2,
    // rebind observed=H2, second pre-pass recheck=H2.
    headScript: ['H1', 'H1', 'H2', 'H2', 'H2', 'H2'],
  });
  const { controller, persistence, calls } = build({
    prBackend: backend,
    reviews: [{ findings: [] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({
    goal: 'moving phase PR',
    cwd: '/r',
    prNumber: 4,
    phases: [phasePlan[0]],
  });

  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PHASE_PASS');
  assert.equal(calls.reviewer, 2, 'the stale H1 review is not reused to complete the phase');

  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.completedPhases[0].head, 'H2');
  assert.deepEqual(
    persisted.reviewLoop.audit.map((record) => record.result),
    ['REWORK', 'PHASE_PASS'],
  );
  assert.equal(persisted.reviewLoop.audit[0].target.headStillCurrent, false);
  assert.equal(persisted.reviewLoop.audit[1].target.reviewedHeadSha, 'H2');
});

// M -- PR phase completion is rejected if its successful audit evidence is removed.
test('M: completed PR phase must remain bound to its PHASE_PASS audit record', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1'] });
  const { controller, persistence } = build({
    prBackend: backend,
    reviews: [{ findings: [] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({
    goal: 'phase audit binding',
    cwd: '/r',
    prNumber: 4,
    phases: [phasePlan[0]],
  });

  assert.equal((await controller.review({ loopId })).status, 'PHASE_PASS');
  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.audit = [];
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(
    () => controller.review({ loopId }),
    /successful exact-HEAD PHASE_PASS audit record|phase progression invalid/,
  );
});
