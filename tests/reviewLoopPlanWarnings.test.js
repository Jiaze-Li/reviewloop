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
    goal: 'g', cwd: '/r', contractText: 'full contract', phases: [phase('a', { verificationCommands: ['npm test'] }), phase('b')],
  });
  assert.equal(r.planWarnings.length, 1);
  assert.match(r.planWarnings[0], /phase b/);
});

test('no warning when a global verification plan is frozen', async () => {
  const r = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r', contractText: 'full contract', phases: [phase('a'), phase('b')] });
  assert.equal(r.planWarnings, undefined);
});

test('begin warns when a plan has many phases', async () => {
  const phases = Array.from({ length: 9 }, (_, i) => phase(`p${i}`));
  const r = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r', contractText: 'full contract', phases });
  assert.match(r.planWarnings.join('\n'), /9 phases/);
});

test('begin warns, before any edit, about untracked files that would make review unattributable', async () => {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({
      head: 'H', dirtyFiles: [], untrackedHashes: { 'notes.txt': 'a', 'tmp/x.log': 'b' }, evidenceComplete: true,
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['npm test'] }),
  });
  const r = await controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal(r.planWarnings.length, 1);
  assert.match(r.planWarnings[0], /2 untracked file\(s\).*notes\.txt.*BEFORE editing/);
});

test('begin warns when the baseline attribution is already incomplete', async () => {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({
      head: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: false, incompleteReasons: ['symlink escapes the repository'],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['npm test'] }),
  });
  const r = await controller.begin({ goal: 'g', cwd: '/r' });
  assert.match(r.planWarnings.join('\n'), /already incomplete \(symlink escapes the repository\)/);
});

test('begin warns when phases are registered without the contract text', async () => {
  const r = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r', phases: [phase('a'), phase('b')] });
  assert.match(r.planWarnings.join('\n'), /without contractText.*acceptance criteria/);
  const ok = await controllerWith(['npm test']).begin({ goal: 'g', cwd: '/r' });
  assert.equal(ok.planWarnings, undefined, 'an unphased task needs no contract warning');
});
