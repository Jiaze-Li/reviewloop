import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewerInvoke,
  createProductionReviewLoopProviders,
} from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('buildReviewerInvoke emits anti-bloat design contract prompt when taskType is design', async () => {
  const invoke = buildReviewerInvoke();
  let designPrompt = '';
  let codePrompt = '';

  await invoke({
    objective: {
      goal: 'Produce contract from brief',
      taskType: 'design',
      contractText: '# Brief\n- Problem: automate contract review',
    },
    diff: 'diff --git a/design/contract.md b/design/contract.md\n+## Scope',
    changedFiles: ['design/contract.md'],
    gate: { verdict: 'PASS' },
    transport: async (p) => {
      designPrompt = p;
      return { text: '{"findings":[]}' };
    },
  });

  await invoke({
    objective: {
      goal: 'Implement feature',
      taskType: 'code',
      contractText: '# Contract',
    },
    diff: 'diff --git a/a.js b/a.js\n+const x = 1;',
    changedFiles: ['a.js'],
    gate: { verdict: 'PASS' },
    transport: async (p) => {
      codePrompt = p;
      return { text: '{"findings":[]}' };
    },
  });

  assert.match(designPrompt, /You are an INDEPENDENT design contract reviewer\./);
  assert.match(designPrompt, /Faithfulness/);
  assert.match(designPrompt, /Executability & Anti-bloat/);
  assert.match(designPrompt, /violates:/);
  assert.match(designPrompt, /never suggest adding timers, locks, retries/);
  assert.doesNotMatch(designPrompt, /You are an INDEPENDENT code reviewer\./);

  assert.match(codePrompt, /You are an INDEPENDENT code reviewer\./);
  assert.doesNotMatch(codePrompt, /You are an INDEPENDENT design contract reviewer\./);
});

test('taskType=design routes review dispatches through the supervisor pool order while accounting under reviewerCalls', async () => {
  const routedRoles = [];
  const providers = createProductionReviewLoopProviders({
    callAgy: async (opts) => ({
      model: opts?.model ?? 'gemini-supervisor-test',
      exitCode: 0,
      text: '{"findings":[]}',
      usage: { input_tokens: 20, output_tokens: 5 },
    }),
  });

  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE',
      currentHead: 'HEAD1',
      evidenceComplete: true,
      noWorkerChangeYet: false,
      changedFiles: ['design/contract.md'],
      fingerprint: 'DELTA1',
      diff: 'diff --git a/design/contract.md b/design/contract.md\n+# Contract\n',
    }),
    runGateFn: async () => ({
      verdict: 'PASS',
      pass: true,
      fingerprint: 'GATE1',
      failureIdentities: [],
      results: [],
    }),
    discoverVerificationCommandsFn: ({ configured }) => ({
      source: 'configured',
      commands: configured ?? ['git diff --check'],
      manifestFingerprint: 'fp-1',
    }),
    routeReviewerFn: (signals, ctx) => {
      routedRoles.push('reviewer');
      return providers.routeReviewerFn(signals, ctx);
    },
    routeSupervisorFn: (signals, ctx) => {
      routedRoles.push('supervisor');
      return providers.routeSupervisorFn(signals, ctx);
    },
    reviewerFn: providers.reviewerFn,
    supervisorFn: providers.supervisorFn,
  });

  const begin = await ctl.begin({
    goal: 'Review design contract',
    cwd: '/repo',
    taskType: 'design',
    contractText: '# Brief\n- Keep it simple',
  });
  assert.equal(begin.taskType, 'design');

  const review = await ctl.review({ loopId: begin.loopId });
  assert.equal(review.status, 'PASS');
  assert.deepEqual(routedRoles, ['supervisor']);
  assert.equal(review.telemetry.reviewerCalls, 1);
  assert.equal(review.telemetry.supervisorCalls, 0);
});
