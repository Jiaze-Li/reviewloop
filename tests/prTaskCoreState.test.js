import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createReviewObjective,
  rehydrateObjective,
  assertObjectiveNotWeakened,
  resolveReviewMode,
  REVIEW_WORKFLOWS,
  TASK_TYPES,
} from '../src/reviewloop/objective.js';
import { ReviewLoopStore, initialPrTaskState } from '../src/reviewloop/state.js';
import { createBeginTask } from '../src/reviewloop/taskBegin.js';
import { isResumable } from '../src/reviewloop/resumeGuide.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const BASE_PR_CONTEXT = {
  repoFullName: 'Jiaze-Li/reviewloop',
  repoRoot: '/repo',
  prNumber: 51,
  baseBranch: 'main',
  headBranch: 'plan/pr-task-20261118',
  boundHeadSha: '23eec050666e0f6d688f680af4a8fc1538e14e68',
  originLoopId: 'rl-origin-1',
  originContractText: '# Work Contract',
  originDesignSha256: 'fde355a235c68edd3012899aa0400ea6769342e15b730f07e0f4716c189a0816',
};

test('createReviewObjective supports taskType=pr, freezes prContext into fingerprint, and isolates retired mode=PR', () => {
  const obj = createReviewObjective({
    loopId: 'rl-pr-1',
    goal: 'Fix PR #51 findings',
    taskType: TASK_TYPES.PR,
    prContext: BASE_PR_CONTEXT,
    createdAt: '2026-11-18T00:00:00.000Z',
  });

  assert.equal(obj.mode, 'LOCAL');
  assert.equal(obj.taskType, 'pr');
  assert.equal(resolveReviewMode(obj), REVIEW_WORKFLOWS.PR);
  assert.equal(obj.prContext.prNumber, 51);
  assert.equal(obj.prContext.originPolicySha, 'unknown');
  assert.deepEqual(obj.prContext.trustedBotLogins, ['jiaze-claude-review-bot[bot]', 'claude-review-bot[bot]']);
  assert.deepEqual(obj.prContext.permissions, {
    edit: false,
    commit: false,
    push: false,
    comment: false,
    autoWake: false,
  });
  assert.equal(Object.isFrozen(obj.prContext), true);
  assert.equal(Object.isFrozen(obj.prContext.permissions), true);

  const rehydrated = rehydrateObjective(JSON.parse(JSON.stringify(obj)));
  assert.equal(rehydrated.fingerprint, obj.fingerprint);
  assert.doesNotThrow(() => assertObjectiveNotWeakened(obj, rehydrated));

  // Tampering prContext invalidates fingerprint and triggers weakening check
  const tampered = JSON.parse(JSON.stringify(obj));
  tampered.prContext.boundHeadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.throws(() => rehydrateObjective(tampered), /fingerprint does not match/);

  const otherHead = createReviewObjective({
    loopId: 'rl-pr-1',
    goal: 'Fix PR #51 findings',
    taskType: TASK_TYPES.PR,
    prContext: { ...BASE_PR_CONTEXT, boundHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    createdAt: '2026-11-18T00:00:00.000Z',
  });
  assert.throws(() => assertObjectiveNotWeakened(obj, otherHead), /prContext changed/);

  // Retired mode=PR and top-level prNumber remain rejected
  assert.throws(
    () => createReviewObjective({ loopId: 'rl-old', goal: 'g', mode: 'PR' }),
    /PR mode retired/,
  );
  assert.throws(
    () => createReviewObjective({ loopId: 'rl-old', goal: 'g', prNumber: 51 }),
    /PR mode retired/,
  );
  // prContext is rejected for non-pr taskType, and required for pr
  assert.throws(
    () => createReviewObjective({ loopId: 'rl-code', goal: 'g', taskType: 'code', prContext: BASE_PR_CONTEXT }),
    /prContext is only valid for taskType "pr"/,
  );
  assert.throws(
    () => createReviewObjective({ loopId: 'rl-pr-missing', goal: 'g', taskType: 'pr' }),
    /prContext must be an object/,
  );
});

test('taskBegin + ReviewLoopStore persist prTask alongside reviewLoop without overwriting and keep retired PR isolated', async () => {
  const persistence = new MemoryPersistence();
  const store = new ReviewLoopStore(persistence);
  const begin = createBeginTask({
    clock: () => Date.parse('2026-11-18T00:00:00.000Z'),
    captureBaselineFn: async () => ({ head: BASE_PR_CONTEXT.boundHeadSha, dirtyFiles: [], evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: 'mechanical', commands: ['git diff --check'] }),
    runGateFn: async () => ({ pass: true, results: [] }),
    gateRunner: null,
    env: {},
    store,
    onEvent: () => {},
  });

  await assert.rejects(
    () => begin({
      goal: 'Fix PR #51',
      cwd: '/other-repo',
      taskType: 'pr',
      prContext: BASE_PR_CONTEXT,
    }),
    /prContext\.repoRoot .* does not match cwd/,
  );

  const res = await begin({
    goal: 'Fix PR #51',
    cwd: '/repo',
    taskType: 'pr',
    prContext: {
      ...BASE_PR_CONTEXT,
      repoRoot: undefined,
      permissions: { edit: true, comment: true },
    },
  });

  assert.equal(res.taskType, 'pr');
  assert.equal(res.mode, 'LOCAL');
  assert.equal(res.prContext.repoRoot, '/repo');
  assert.equal(res.prContext.permissions.edit, true);
  assert.equal(res.prContext.permissions.push, false);

  const loopState = await store.load(res.loopId);
  const prTask = await store.loadPrTask(res.loopId);
  assert.equal(loopState.objective.taskType, 'pr');
  assert.equal(prTask.prNumber, 51);
  assert.deepEqual(prTask.reviewTriggers, []);
  assert.equal(prTask.originLoopId, 'rl-origin-1');
  assert.equal(isResumable(loopState), true);

  // Retired mode=PR stays unresumable
  const retired = { loopId: 'old-pr', state: 'REWORK', objective: { mode: 'PR', repository: { root: '/repo' } } };
  assert.equal(isResumable(retired), false);
});

test('MCP reviewloop_begin accepts taskType=pr with prContext and validates outputSchema', async () => {
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: BASE_PR_CONTEXT.boundHeadSha, dirtyFiles: [], evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: 'mechanical', commands: ['git diff --check'] }),
  });
  const server = createReviewLoopMcpServer({ controller: ctl, cwd: '/repo' });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const res = await client.callTool({
      name: 'reviewloop_begin',
      arguments: {
        goal: 'Fix PR #51',
        cwd: '/repo',
        taskType: 'pr',
        prContext: {
          ...BASE_PR_CONTEXT,
          agentType: 'claude',
          agentSessionId: 'sess-real-123',
        },
      },
    });
    assert.equal(res.isError ?? false, false);
    assert.equal(res.structuredContent.taskType, 'pr');
    assert.equal(res.structuredContent.mode, 'LOCAL');
    assert.equal(res.structuredContent.prContext.prNumber, 51);
    assert.equal(res.structuredContent.prContext.agentType, 'claude');
    assert.equal(res.structuredContent.prContext.agentSessionId, 'sess-real-123');
    assert.match(res.structuredContent.statusLine, /^\[ReviewLoop \| pr \| 启动\] loopId=/);

    // Retired top-level prNumber still errors
    const errRes = await client.callTool({
      name: 'reviewloop_begin',
      arguments: {
        goal: 'Old PR',
        cwd: '/repo',
        prNumber: 51,
      },
    });
    assert.equal(errRes.isError, true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
