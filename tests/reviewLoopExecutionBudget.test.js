// One user instruction == one bounded ReviewLoop convergence strategy.
// The initial epoch keeps the default 3 Reviewer rounds, but round 3 no longer
// hands ordinary non-convergence to the user: Supervisor guidance may open up to
// two bounded 2-review epochs. HUMAN_REQUIRED is terminal only after the full
// automatic strategy is exhausted (or Supervisor explicitly asks for a human).
// Cooperative-Worker model — no crypto, no approval tokens, no reset CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };

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
  assert.equal(persistedFresh.reviewLoop.audit, undefined, 'LOCAL loop never creates a PR audit record');
});