import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewObjective,
  rehydrateObjective,
  assertObjectiveNotWeakened,
  TASK_TYPES,
} from '../src/reviewloop/objective.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('createReviewObjective defaults taskType to code and preserves legacy fingerprint', () => {
  const implicit = createReviewObjective({
    loopId: 'rl-1',
    goal: 'Implement feature',
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  const explicitCode = createReviewObjective({
    loopId: 'rl-1',
    goal: 'Implement feature',
    taskType: TASK_TYPES.CODE,
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  assert.equal(implicit.taskType, 'code');
  assert.equal(explicitCode.taskType, 'code');
  assert.equal(implicit.fingerprint, explicitCode.fingerprint);

  // A legacy persisted objective without a taskType field still rehydrates cleanly.
  const legacyRaw = JSON.parse(JSON.stringify(implicit));
  delete legacyRaw.taskType;
  const rehydrated = rehydrateObjective(legacyRaw);
  assert.equal(rehydrated.fingerprint, implicit.fingerprint);
});

test('createReviewObjective with taskType=design folds taskType into fingerprint and prevents weakening', () => {
  const codeObj = createReviewObjective({
    loopId: 'rl-design',
    goal: 'Draft contract',
    taskType: 'code',
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  const designObj = createReviewObjective({
    loopId: 'rl-design',
    goal: 'Draft contract',
    taskType: 'design',
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  assert.equal(designObj.taskType, 'design');
  assert.notEqual(designObj.fingerprint, codeObj.fingerprint);

  const rehydrated = rehydrateObjective(JSON.parse(JSON.stringify(designObj)));
  assert.equal(rehydrated.taskType, 'design');
  assert.doesNotThrow(() => assertObjectiveNotWeakened(designObj, rehydrated));
  assert.throws(
    () => assertObjectiveNotWeakened(designObj, codeObj),
    /taskType changed/,
  );

  // Tampering taskType on a persisted design objective invalidates its fingerprint.
  const tampered = JSON.parse(JSON.stringify(designObj));
  tampered.taskType = 'code';
  assert.throws(() => rehydrateObjective(tampered), /fingerprint does not match/);
});

test('createReviewObjective and begin reject unknown taskType', async () => {
  assert.throws(
    () => createReviewObjective({ loopId: 'rl-x', goal: 'g', taskType: 'unknown' }),
    /unknown taskType/,
  );
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: 'mechanical', commands: ['git diff --check'] }),
  });
  await assert.rejects(
    () => ctl.begin({ goal: 'g', cwd: '/repo', taskType: 'invalid' }),
    /unknown taskType/,
  );
});

test('begin with taskType=design defaults verificationCommands to git diff --check and skips baselineGate execution', async () => {
  let gateRanAtBegin = 0;
  let discoveredConfigured = null;
  const persistence = new MemoryPersistence();
  const ctl = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    discoverVerificationCommandsFn: ({ configured }) => {
      discoveredConfigured = configured;
      return {
        source: configured ? 'configured' : 'package.json',
        commands: configured ?? ['npm test'],
        manifestFingerprint: 'fp-design',
      };
    },
    runGateFn: async () => {
      gateRanAtBegin += 1;
      return { verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] };
    },
  });

  const res = await ctl.begin({
    goal: 'Produce minimal contract matching brief',
    cwd: '/repo',
    taskType: 'design',
    contractText: '# Brief\n- Problem: x',
  });
  assert.equal(res.taskType, 'design');
  assert.deepEqual(discoveredConfigured, ['git diff --check']);
  assert.equal(gateRanAtBegin, 0, 'design mode default gate must not run npm test at begin');
  const saved = await persistence.readWorkflowState(res.loopId);
  assert.equal(saved.reviewLoop.objective.verificationPlan.source, 'design-default');
  assert.deepEqual(saved.reviewLoop.objective.verificationPlan.commands, ['git diff --check']);
});
