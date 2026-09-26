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
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function google401({ envelope = undefined, stderrSuffix = '' } = {}) {
  return Object.assign(new Error('agy exited with status 1'), {
    name: 'AgyExitError',
    code: 'AGY_NONZERO_EXIT',
    exitCode: 1,
    stderr:
      'UNAUTHENTICATED (code 401): Request had invalid authentication credentials. '
      + 'Expected OAuth 2 access token, login cookie or other valid authentication credential.'
      + String(stderrSuffix ?? ''),
    ...(envelope === undefined ? {} : { envelope }),
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

test('AGY classifier is narrow: canonical Google 401 matches, unrelated auth-looking exits do not', () => {
  assert.equal(
    isAgyTransientAuthBoundaryRejection(google401()),
    true,
    'the canonical "OAuth 2 access token" wording alone is not a usage diagnostic',
  );
  assert.equal(isAgyTransientAuthBoundaryRejection(Object.assign(new Error('x'), {
    code: 'AGY_NONZERO_EXIT',
    stderr: '403 PERMISSION_DENIED: caller lacks permission',
  })), false);
  assert.equal(isAgyTransientAuthBoundaryRejection(Object.assign(new Error('x'), {
    code: 'AGY_NONZERO_EXIT',
    stderr: '401 upstream proxy error with no authentication diagnostic',
  })), false);
  assert.equal(isAgyTransientAuthBoundaryRejection(google401({
    envelope: {
      status: 'UNAUTHENTICATED',
      code: 401,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  })), false, 'usage-bearing 401 is not mechanically zero-token and must fail closed');
  assert.equal(isAgyTransientAuthBoundaryRejection(google401({
    envelope: {
      status: 'UNAUTHENTICATED',
      code: 401,
      metadata: { input_tokens: 4 },
    },
  })), false, 'metadata-carried token counts are reported activity, never proven zero-token');
  assert.equal(isAgyTransientAuthBoundaryRejection(google401({
    envelope: {
      status: 'UNAUTHENTICATED',
      code: 401,
      meta: { token_usage: { total_tokens: 5 } },
    },
  })), false, 'meta-carried token counts are reported activity, never proven zero-token');
  assert.equal(isAgyTransientAuthBoundaryRejection(google401({
    stderrSuffix: '\nusage: input_tokens=6 output_tokens=0',
  })), false, 'stderr-carried token counts are reported activity, never proven zero-token');
  assert.equal(isAgyTransientAuthBoundaryRejection(google401({
    stderrSuffix: '\ntotal_tokens: 7',
  })), false, 'stderr total-token diagnostics are reported activity, never proven zero-token');
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

test('usage-bearing AGY 401 is never normalized to zero-token transient auth', async () => {
  const usageBearing = google401({
    envelope: {
      status: 'UNAUTHENTICATED',
      code: 401,
      usage: { input_tokens: 9, output_tokens: 0 },
    },
  });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => { throw usageBearing; },
    provisionMinimalAgent: () => ({ name: 'reviewloop-minimal', path: '/tmp/reviewloop-minimal.md' }),
    agyGeminiDir: '/tmp/reviewloop-test-gemini',
    customAgentSupport: null,
    transportRuntime: {
      'codex:default': { available: false, reason: 'test' },
      'claude:opus': { available: false, reason: 'test' },
    },
  });

  const selection = pool.route('reviewer');
  await assert.rejects(
    () => selection.transport('review this'),
    (err) => {
      assert.equal(err.code, 'AGY_NONZERO_EXIT');
      assert.notEqual(err.transientAuth, true);
      assert.deepEqual(err.envelope?.usage, { input_tokens: 9, output_tokens: 0 });
      return true;
    },
  );
});

test('metadata-carried AGY token counts keep the original fail-closed transport error', async () => {
  const metadataBearing = google401({
    envelope: {
      status: 'UNAUTHENTICATED',
      code: 401,
      metadata: { input_tokens: 11, output_tokens: 0 },
    },
  });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => { throw metadataBearing; },
    provisionMinimalAgent: () => ({ name: 'reviewloop-minimal', path: '/tmp/reviewloop-minimal.md' }),
    agyGeminiDir: '/tmp/reviewloop-test-gemini',
    customAgentSupport: null,
    transportRuntime: {
      'codex:default': { available: false, reason: 'test' },
      'claude:opus': { available: false, reason: 'test' },
    },
  });

  const selection = pool.route('reviewer');
  await assert.rejects(
    () => selection.transport('review this'),
    (err) => {
      assert.equal(err.code, 'AGY_NONZERO_EXIT');
      assert.notEqual(err.transientAuth, true);
      assert.deepEqual(err.envelope?.metadata, { input_tokens: 11, output_tokens: 0 });
      return true;
    },
  );
});

test('stderr-carried AGY token counts keep the original fail-closed transport error', async () => {
  const stderrBearing = google401({
    stderrSuffix: '\nToken usage: 13\ninput_tokens=13 output_tokens=0',
  });
  const pool = createReviewLoopProviderPool({
    callAgy: async () => { throw stderrBearing; },
    provisionMinimalAgent: () => ({ name: 'reviewloop-minimal', path: '/tmp/reviewloop-minimal.md' }),
    agyGeminiDir: '/tmp/reviewloop-test-gemini',
    customAgentSupport: null,
    transportRuntime: {
      'codex:default': { available: false, reason: 'test' },
      'claude:opus': { available: false, reason: 'test' },
    },
  });

  const selection = pool.route('reviewer');
  await assert.rejects(
    () => selection.transport('review this'),
    (err) => {
      assert.equal(err.code, 'AGY_NONZERO_EXIT');
      assert.notEqual(err.transientAuth, true);
      assert.match(err.stderr, /input_tokens=13/);
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

  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
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
        provider: 'agy-claude-gpt',
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

  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
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


test('process restart preserves transient-auth retry budget and physical attempt numbering', async () => {
  const persistence = new MemoryPersistence();

  const seedController = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await seedController.begin({ goal: 'g', cwd: '/r' });
  const operationId = `${loopId}:round-1:chunk-0`;

  // Simulate process A: physical attempt 1 reached the Google auth boundary,
  // was proven zero-token, and was durably accounted before the process died.
  const seedSpend = createReviewLoopSpend({ loopId, persistence });
  const seedEvidence = await seedSpend.registerEvidence({
    kind: 'external',
    taskId: operationId,
    fingerprint: 'seed-auth-retry',
  });
  await assert.rejects(
    () => seedSpend.meteredCall({
      role: 'reviewer',
      family: 'agy:opus',
      provider: 'agy-claude-gpt',
      model: 'claude-opus-4-6-thinking',
      operationId,
      attempt: 1,
      evidenceIds: [seedEvidence.evidenceId],
      call: async () => { throw transientProviderAuth(); },
    }),
    (err) => err?.code === 'PROVIDER_AUTH_FAILED',
  );

  // Simulate process B. Only one of the two same-family retries remains.
  // The next AGY failure consumes it; one further AGY failure exhausts the
  // family and normal failover starts at physical attempt 4.
  const families = [];
  const healthFailures = [];
  let agyBlocked = false;
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => (agyBlocked
      ? { family: 'codex:default', provider: 'codex', model: null, transport: async () => ({}) }
      : { family: 'agy:opus', provider: 'agy-claude-gpt', model: 'claude-opus-4-6-thinking', transport: async () => ({}) }),
    recordProviderFailure: (selection, failure) => {
      healthFailures.push({ family: selection.family, code: failure.code });
      if (selection.family === 'agy:opus') agyBlocked = true;
    },
    sleepFn: async () => {},
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      if (selection.family === 'agy:opus') throw transientProviderAuth();
      return { value: { findings: [] }, usage: { input_tokens: 4, output_tokens: 2 }, model: 'codex-test' };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
  assert.deepEqual(families, ['agy:opus', 'agy:opus', 'codex:default']);
  assert.deepEqual(healthFailures, [{ family: 'agy:opus', code: 'PROVIDER_AUTH_FAILED' }]);

  const state = await persistence.readWorkflowState(loopId);
  const durableRecords = (state.reviewLoopSpend?.records ?? [])
    .filter((r) => r.role === 'reviewer' && r.operationId === operationId);
  assert.ok(
    durableRecords.filter((r) => r.family === 'agy:opus')
      .every((r) => r.provider === 'agy-claude-gpt'),
    'AGY retry recovery must work with production provider ids, not a synthetic provider="agy"',
  );
  assert.deepEqual(
    durableRecords.map((r) => r.attempt),
    [1, 2, 3, 4],
    'restart must continue physical attempt numbering without reuse',
  );
});


test('restart after third transient AGY failure restores exhausted-family health before any fourth AGY dispatch', async () => {
  const persistence = new MemoryPersistence();

  const seedController = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await seedController.begin({ goal: 'g', cwd: '/r' });
  const operationId = `${loopId}:round-1:chunk-0`;

  // Exact crash-window state: all three auth-boundary failures are durable, but
  // the in-memory provider-health mutation after failure #3 never happened.
  const state = await persistence.readWorkflowState(loopId);
  await persistence.updateWorkflowState(loopId, {
    reviewLoopSpend: {
      records: [1, 2, 3].map((attempt) => ({
        role: 'reviewer',
        family: 'agy:opus',
        provider: 'agy-claude-gpt',
        model: 'claude-opus-4-6-thinking',
        usageKnown: true,
        usageVolume: 0,
        usageAccounting: {
          method: 'conservative_additive_unknown',
          semanticsKnown: false,
          volumeResolved: true,
          accountingClass: 'agy',
          reportedTotalTokens: null,
        },
        usageBreakdown: {
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          reportedTotalTokens: null,
          rawFieldSumTokens: 0,
        },
        costUsd: 0,
        costKnown: true,
        businessOutcome: 'FAILURE',
        failureCode: 'PROVIDER_AUTH_FAILED',
        transientAuth: true,
        operationId,
        attempt,
        rawUsage: { input_tokens: 0, output_tokens: 0 },
        round: 1,
        chunkIndex: 0,
        chunkTotal: 1,
        at: new Date(0).toISOString(),
      })),
    },
    modelSpendReservations: state.modelSpendReservations ?? {},
  });

  const families = [];
  const restoredHealth = [];
  let agyBlocked = false;
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => (agyBlocked
      ? { family: 'codex:default', provider: 'codex', model: null, transport: async () => ({}) }
      : { family: 'agy:opus', provider: 'agy-claude-gpt', model: 'claude-opus-4-6-thinking', transport: async () => ({}) }),
    recordProviderFailure: (selection, failure) => {
      restoredHealth.push({
        family: selection.family,
        code: failure.code,
        recovered: failure.recoveredFromDurableAuthExhaustion === true,
      });
      if (selection.family === 'agy:opus') agyBlocked = true;
    },
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      return { value: { findings: [] }, usage: { input_tokens: 5, output_tokens: 2 }, model: 'codex-test' };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const result = await controller.review({ loopId });
  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
  assert.deepEqual(families, ['codex:default'], 'no fourth AGY call is allowed after durable exhaustion');
  assert.deepEqual(restoredHealth, [{
    family: 'agy:opus',
    code: 'PROVIDER_AUTH_FAILED',
    recovered: true,
  }]);

  const finalState = await persistence.readWorkflowState(loopId);
  const newAttempt = (finalState.reviewLoopSpend?.records ?? [])
    .find((r) => r.operationId === operationId && r.businessOutcome === 'SUCCESS');
  assert.equal(newAttempt?.attempt, 4, 'failover resumes with the next physical attempt number');
});
