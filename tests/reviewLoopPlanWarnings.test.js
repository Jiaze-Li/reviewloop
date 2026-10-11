import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function controllerWith(commands) {
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: commands.length ? 'test' : 'mechanical', commands }),
  });
}
const phase = (id, extra = {}) => ({ id, objective: id, exitCriteria: ['ok'], ...extra });

test('begin warns about phases that only a model can judge', async () => {
  const r = await controllerWith([]).begin({
    goal: 'g', cwd: '/r', phases: [phase('a', { verificationCommands: ['npm test'] }), phase('b')],
  });
  assert.equal(r.planWarnings.length, 1);
  assert.match(r.planWarnings[0], /phase b/);
});

test('no warning when a global verification plan is frozen', async () => {
  const r = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r', phases: [phase('a'), phase('b')] });
  assert.equal(r.planWarnings, undefined);
});

test('begin warns when a plan has many phases', async () => {
  const phases = Array.from({ length: 9 }, (_, i) => phase(`p${i}`));
  const r = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r', phases });
  assert.match(r.planWarnings.join('\n'), /9 phases/);
});
