// One user instruction == one bounded ReviewLoop convergence strategy.
// The initial epoch keeps the default 3 Reviewer rounds, but round 3 no longer
// hands ordinary non-convergence to the user: Supervisor guidance may open up to
// two bounded 2-review epochs. HUMAN_REQUIRED is terminal only after the full
// automatic strategy is exhausted (or Supervisor explicitly asks for a human).
// Cooperative-Worker model — no crypto, no approval tokens, no reset CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence, mockPrBackend, prTestFakes } from './helpers/reviewLoopHarness.js';

const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };

// A PR-review controller wired to the ONE unified engine: deterministic Gate +
// internal Reviewer. `resultByHead` maps a PR HEAD SHA to the reviewer payload.
function prController(persistence, prBackend, {
  resultByHead = {}, defaultResult = { findings: [P1] }, supervisorFn,
} = {}) {
  let defaultSupervisorRound = 0;
  return createReviewLoopController({
    persistence,
    prBackend,
    ...prTestFakes(prBackend),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, results: [], fingerprint: `g${Math.random()}`, failureIdentities: [] }),
    reviewerFn: async () => ({
      value: resultByHead[prBackend.head()] ?? defaultResult,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'test-reviewer',
    }),
    supervisorFn: supervisorFn
      ?? (async () => {
        defaultSupervisorRound += 1;
        return {
          value: { guidance: `strategy-${defaultSupervisorRound}`, recommendation: 'REWORK' },
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
  });
}

function localController(persistence, { reviews }) {
  let i = 0;
  let supervisorRound = 0;
  return createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: `fp${i}`, diff: `diff ${i}` }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: `g${i}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo'], manifestFingerprint: 'mf' }),
    reviewerFn: async () => { const r = reviews[Math.min(i, reviews.length - 1)]; i += 1; return { value: r, usage: { input_tokens: 1, output_tokens: 1 } }; },
    supervisorFn: async () => {
      supervisorRound += 1;
      return {
        value: { guidance: `local-strategy-${supervisorRound}`, recommendation: 'REWORK' },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
}

const PR_HEADS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];

test('PR: round 3 still blocking escalates/continues automatically instead of HUMAN_REQUIRED', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  const r1 = await controller.review({ loopId }); assert.equal(r1.status, 'REWORK'); assert.equal(r1.round, 1);
  backend.advanceHead();
  const r2 = await controller.review({ loopId }); assert.equal(r2.status, 'REWORK'); assert.equal(r2.round, 2);
  backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'REWORK');
  assert.equal(r3.round, 3);
  assert.notEqual(r3.terminal, true);
  assert.equal(r3.convergenceEpoch, 1, 'persistent blocker already caused one Supervisor-guided epoch');
});

test('PR: full convergence exhaustion is terminal — a further reviewloop_review cannot continue the loop', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  let terminal = null;
  for (let round = 1; round <= 6; round += 1) {
    // Repeated blocker escalates early, so the bounded path is:
    // review, Supervisor, review, Supervisor, review, terminal review.
    // eslint-disable-next-line no-await-in-loop
    terminal = await controller.review({ loopId });
    if (round < 6) backend.advanceHead();
  }
  assert.equal(terminal.status, 'HUMAN_REQUIRED');
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.budgetExhausted, true);
  assert.equal(terminal.round, 6);
  assert.equal(terminal.supervisorEscalationCount, 2);

  const diffReadsBefore = backend.state.diffReads;
  backend.advanceHead();
  const again = await controller.review({ loopId });
  assert.equal(again.status, 'HUMAN_REQUIRED', 'terminal convergence exhaustion cannot re-enter REVIEWING');
  assert.equal(again.terminal, true);
  assert.equal(again.round, 6, 'the global review round did not advance');
  assert.equal(backend.state.diffReads, diffReadsBefore, 'the PR was not re-reviewed');

  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'HUMAN_REQUIRED');
});

test('PR: a new independent task starts fresh after a fully exhausted prior loop', async () => {
  const persistence = new MemoryPersistence();
  const b1 = mockPrBackend({ heads: PR_HEADS });
  const c1 = prController(persistence, b1);
  const first = await c1.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  let exhausted = null;
  for (let round = 1; round <= 6; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    exhausted = await c1.review({ loopId: first.loopId });
    if (round < 6) b1.advanceHead();
  }
  assert.equal(exhausted.status, 'HUMAN_REQUIRED');
  assert.equal(exhausted.terminal, true);

  // A genuinely new user task gets a new immutable objective + budget.
  const b2 = mockPrBackend({ heads: ['H9'] });
  const c2 = prController(persistence, b2, { defaultResult: { findings: [] } });
  const second = await c2.begin({ goal: 'continue PR #4 as a new task', cwd: '/r', prNumber: 4 });
  assert.notEqual(second.loopId, first.loopId);
  assert.equal(second.status, 'READY');
  const result = await c2.review({ loopId: second.loopId });
  assert.equal(result.round, 1);
  assert.equal(result.status, 'PASS');
});

test('PR: a settled-but-unusable Supervisor result remains resumable and creates no strategy epoch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  let supCalls = 0;
  const controller = prController(persistence, backend, {
    supervisorFn: async () => {
      supCalls += 1;
      return { value: { guidance: '', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK', 'a transient Supervisor failure does not stall the loop');
  assert.equal(r2.round, 2);
  assert.equal(r2.supervisorGuidance, null);
  assert.ok(supCalls >= 1);
  assert.ok((r2.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE'));

  let persisted = await persistence.readWorkflowState(loopId);
  assert.notEqual(persisted.reviewLoop.budgetExhausted, true);
  assert.equal(persisted.reviewLoop.supervisorInvoked, false, 'unusable output is not a valid escalation');
  assert.equal(persisted.reviewLoop.convergenceEpoch, 0);

  backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'REWORK', 'the old round-3 boundary does not force a human after Supervisor unavailability');
  assert.notEqual(r3.terminal, true);
  persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.convergenceEpoch, 0, 'no new strategy epoch exists without usable guidance');
});

test('PR: a Supervisor call dispatched with unresolvable usage is the deliberate fail-closed stop (not a degrade)', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend, {
    // Provider threw mid-call: the reservation cannot be settled (UNKNOWN != ZERO).
    supervisorFn: async () => { throw new Error('socket hang up'); },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED', 'unresolved model spend fails closed');
  assert.notEqual(r2.terminal, true, 'a spend-safety stop is not budget-exhausted');
  assert.match(r2.reason, /model spend blocked/i);

  const persisted = await persistence.readWorkflowState(loopId);
  assert.notEqual(persisted.reviewLoop.budgetExhausted, true);
});

test('PR: a clean review PASSes normally', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: ['H1'] });
  const controller = prController(persistence, backend, { defaultResult: { findings: [{ severity: 'P3', file: 'a', title: 'nit' }] } });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal((await controller.review({ loopId })).status, 'PASS');
});

test('LOCAL: bounded Supervisor-guided convergence eventually becomes terminal; a fresh task still starts at round 1', async () => {
  const persistence = new MemoryPersistence();
  const blocking = { findings: [{ severity: 'P1', file: 'a.js', line: 1, title: 'bug' }] };
  const c1 = localController(persistence, { reviews: Array.from({ length: 6 }, () => blocking) });
  const { loopId } = await c1.begin({ goal: 'g', cwd: '/r' });

  let terminal = null;
  for (let round = 1; round <= 6; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    terminal = await c1.review({ loopId });
  }
  assert.equal(terminal.status, 'HUMAN_REQUIRED');
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.round, 6);
  assert.equal(terminal.supervisorEscalationCount, 2);

  const again = await c1.review({ loopId });
  assert.equal(again.status, 'HUMAN_REQUIRED');
  assert.equal(again.terminal, true);
  assert.equal(again.round, 6);

  const c2 = localController(persistence, { reviews: [{ findings: [] }] });
  const fresh = await c2.begin({ goal: 'continue', cwd: '/r' });
  const clean = await c2.review({ loopId: fresh.loopId });
  assert.equal(clean.round, 1);
  assert.equal(clean.status, 'PASS');

  const persistedFresh = await persistence.readWorkflowState(fresh.loopId);
  assert.deepEqual(persistedFresh.reviewLoop.audit ?? [], [], 'a LOCAL loop never writes a PR audit record');
});