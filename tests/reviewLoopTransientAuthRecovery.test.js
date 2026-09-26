// AGY OAuth self-healing: canonical Google 401/UNAUTHENTICATED failures are
// proven auth-boundary zero-token attempts, retried in the SAME logical review
// dispatch, and only poison provider health after the bounded retry budget is
// exhausted. No real provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewLoopProviderPool,
  isAgyTransientAuthBoundaryRejection,
} from '../src/reviewloop/providerWiring.js';
import {
  createReviewLoopController,
  DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS,
} from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function google401() {
  return Object.assign(new Error('agy exited with status 1'), {
    name: 'AgyExitError',
    code: 'AGY_NONZERO_EXIT',
    exitCode: 1,
    stderr:
      'UNAUTHENTICATED (code 401): Request had invalid authentication credentials. '
      + 'Expected OAuth 2 access token, login cookie or other valid authentication credential.',
  });
}

function transientProviderAuth() {
  return Object.assign(new Error('AGY authentication was rejected at the Google provider auth boundary'), {
    name: 'AgyTransientAuthError',
    code: 'PROVIDER_AUTH_FAILED',
    providerFailure: 'PROVIDER_AUTH_FAILED',
    transientAuth: true,
    transientAuthSource: 'agy-google-401-unauthenticated',
  });
}

function controllerHarness({ reviewerFn, routeReviewerFn, recordProviderFailure, sleepFn }) {
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    routeReviewerFn,
    recordProviderFailure,
    sleepFn,
    reviewerFn,
    captureBaselineFn: async () => ({
      head: 'B',
      dirtyFiles: [],
      evidenceComplete: true,
    }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'd',
      diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n',
      changedFiles: ['a.js'],
      currentHead: 'B',
      evidenceComplete: true,
      noWorkerChangeYet: false,
    }),
    runGateFn: async () => ({
      verdict: 'PASS',
      pass: true,
      fingerprint: 'g',
      failureIdentities: [],
      results: [],
    }),
    discoverVerificationCommandsFn: () => ({
      source: 'test',
      commands: ['echo test'],
    }),
  });
}

test('AGY classifier is narrow: canonical Google 401 matches, unrelated auth-looking exits do not', () => {
  assert.equal(isAgyTransientAuthBoundaryRejection(google401()), true);
  assert.equal(isAgyTransientAuthBoundaryRejection(Object.assign(new Error('x'), {
    code: 'AGY_NONZERO_EXIT',
    stderr: '403 PERMISSION_DENIED: caller lacks permission',
  })), false);
  assert.equal(isAgyTransientAuthBoundaryRejection(Object.assign(new Error('x'), {
    code: 'AGY_NONZERO_EXIT',
    stderr: '401 upstream proxy error with no authentication diagnostic',
  })), false);
});

test('AGY transport normalizes canonical Google 401 into retryable proven auth-boundary failure', async () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => { throw google401(); },
    provisionMinimalAgent: () => ({ name: 'reviewloop-minimal', path: '/tmp/reviewloop-minimal.md' }),
    agyGeminiDir: '/tmp/reviewloop-test-gemini',
    customAgentSupport: null,
    transportRuntime: {
      'codex:default': { available: false, reason: 'test' },
      'claude:opus': { available: false, reason: 'test' },
    },
  });

  const selection = pool.route('reviewer');
  assert.equal(selection.family, 'agy:opus');

  await assert.rejects(
    () => selection.transport('review this'),
    (err) => {
      assert.equal(err.code, 'PROVIDER_AUTH_FAILED');
      assert.equal(err.providerFailure, 'PROVIDER_AUTH_FAILED');
      assert.equal(err.transientAuth, true);
      assert.equal(err.transientAuthSource, 'agy-google-401-unauthenticated');
      return true;
    },
  );
});

test('one transient AGY 401 retries the same family and succeeds without poisoning provider health', async () => {
  const persistence = new MemoryPersistence();
  const calls = [];
  const delays = [];
  const healthFailures = [];
  let n = 0;

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => ({
      family: 'agy:opus',
      provider: 'agy',
      model: 'claude-opus-4-6-thinking',
      transport: async () => ({}),
    }),
    recordProviderFailure: (selection, failure) => healthFailures.push({ selection, failure }),
    sleepFn: async (ms) => { delays.push(ms); },
    reviewerFn: async ({ selection }) => {
      calls.push(selection.family);
      n += 1;
      if (n === 1) throw transientProviderAuth();
      return {
        value: { findings: [] },
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-opus-4-6-thinking',
      };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'd',
      diff: 'x',
      changedFiles: ['a.js'],
      currentHead: 'B',
      evidenceComplete: true,
      noWorkerChangeYet: false,
    }),
    runGateFn: async () => ({
      verdict: 'PASS',
      pass: true,
      fingerprint: 'g',
      failureIdentities: [],
      results: [],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const result = await controller.review({ loopId });

  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['agy:opus', 'agy:opus']);
  assert.deepEqual(delays, [DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS[0]]);
  assert.equal(healthFailures.length, 0, 'a recovered OAuth refresh race must not poison provider health');

  const state = await persistence.readWorkflowState(loopId);
  const spend = state.reviewLoopSpend?.records ?? [];
  assert.equal(spend.length, 2);
  assert.equal(spend[0].businessOutcome, 'FAILURE');
  assert.equal(spend[0].failureCode, 'PROVIDER_AUTH_FAILED');
  assert.equal(spend[0].usageVolume, 0, 'canonical auth-boundary rejection is mechanically zero-token');
  assert.equal(spend[1].businessOutcome, 'SUCCESS');
});

test('after two transient AGY retries, provider health is marked once and normal pool failover continues', async () => {
  const persistence = new MemoryPersistence();
  const families = [];
  const delays = [];
  const healthFailures = [];
  let agyBlocked = false;

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => (agyBlocked
      ? {
        family: 'codex:default',
        provider: 'codex',
        model: null,
        transport: async () => ({}),
      }
      : {
        family: 'agy:opus',
        provider: 'agy',
        model: 'claude-opus-4-6-thinking',
        transport: async () => ({}),
      }),
    recordProviderFailure: (selection, failure) => {
      healthFailures.push({ family: selection.family, code: failure.code });
      if (selection.family === 'agy:opus') agyBlocked = true;
    },
    sleepFn: async (ms) => { delays.push(ms); },
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      if (selection.family === 'agy:opus') throw transientProviderAuth();
      return {
        value: { findings: [] },
        usage: { input_tokens: 7, output_tokens: 3 },
        model: 'codex-test',
      };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'd',
      diff: 'x',
      changedFiles: ['a.js'],
      currentHead: 'B',
      evidenceComplete: true,
      noWorkerChangeYet: false,
    }),
    runGateFn: async () => ({
      verdict: 'PASS',
      pass: true,
      fingerprint: 'g',
      failureIdentities: [],
      results: [],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const result = await controller.review({ loopId });

  assert.equal(result.status, 'PASS');
  assert.deepEqual(families, ['agy:opus', 'agy:opus', 'agy:opus', 'codex:default']);
  assert.deepEqual(delays, [...DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS]);
  assert.deepEqual(healthFailures, [{ family: 'agy:opus', code: 'PROVIDER_AUTH_FAILED' }]);

  const state = await persistence.readWorkflowState(loopId);
  const spend = state.reviewLoopSpend?.records ?? [];
  assert.equal(spend.length, 4);
  assert.deepEqual(
    spend.slice(0, 3).map((r) => [r.businessOutcome, r.failureCode, r.usageVolume]),
    [
      ['FAILURE', 'PROVIDER_AUTH_FAILED', 0],
      ['FAILURE', 'PROVIDER_AUTH_FAILED', 0],
      ['FAILURE', 'PROVIDER_AUTH_FAILED', 0],
    ],
  );
  assert.equal(spend[3].businessOutcome, 'SUCCESS');
});
