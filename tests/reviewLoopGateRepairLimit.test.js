import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { reopenExhaustedGate } from '../src/reviewloop/gateReopen.js';

function world(limit) {
  const persistence = new MemoryPersistence();
  let n = 0;
  let gateFails = true;
  const controller = createReviewLoopController({
    persistence,
    env: limit ? { ...process.env, REVIEWLOOP_MAX_GATE_REPAIRS: String(limit) } : process.env,
    captureBaselineFn: async () => ({ head: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      n += 1;
      return { baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, fingerprint: `d${n}`, diff: `diff${n}`, changedFiles: ['a.js'] };
    },
    // a DIFFERENT failure every time, so NO_PROGRESS never fires
    runGateFn: async () => (gateFails
      ? { pass: false, verdict: 'FAIL', fingerprint: `g${n}`, failureIdentities: [`t${n}`], results: [] }
      : { pass: true, verdict: 'PASS', fingerprint: `g${n}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo t'] }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  return { controller, persistence, fixGate: () => { gateFails = false; } };
}

test('a Gate that keeps failing for new reasons stops for a human after the limit', async () => {
  const w = world(2);
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal((await w.controller.review({ loopId })).status, 'REWORK');
  assert.equal((await w.controller.review({ loopId })).status, 'REWORK');
  const third = await w.controller.review({ loopId });
  assert.equal(third.status, 'HUMAN_REQUIRED');
  assert.equal(third.terminal, true);
  assert.match(third.reason, /Gate failed 3 times in this gate \(limit 2\)/);
  assert.equal((await w.controller.review({ loopId })).terminal, true, 'the Worker stays stopped');
});

test('reopen-gate gives the stuck gate a fresh repair budget', async () => {
  const w = world(1);
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  await w.controller.review({ loopId });
  assert.equal((await w.controller.review({ loopId })).status, 'HUMAN_REQUIRED');
  await reopenExhaustedGate({ persistence: w.persistence, loopId, reason: 'flaky test fixed' });
  w.fixGate();
  assert.equal((await w.controller.review({ loopId })).status, 'PASS');
});

test('the default limit is generous', async () => {
  const w = world(0);
  const { loopId } = await w.controller.begin({ goal: 'g', cwd: '/r' });
  for (let i = 0; i < 15; i += 1) assert.equal((await w.controller.review({ loopId })).status, 'REWORK'); // eslint-disable-line no-await-in-loop
  assert.equal((await w.controller.review({ loopId })).status, 'HUMAN_REQUIRED');
});
