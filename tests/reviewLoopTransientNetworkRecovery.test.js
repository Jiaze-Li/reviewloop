// AGY transient network recovery: only connection-establishment failures that
// prove no provider response/usage are normalized into safe failover. Mid-stream
// network ambiguity remains fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AgyExitError } from '../src/agy/agyClient.js';
import {
  createReviewLoopProviderPool,
  isAgyTransientPreSendNetworkFailure,
} from '../src/reviewloop/providerWiring.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const OBSERVED_SOCKET_ERROR =
  'agent executor error: generating and executing: request failed: Post '
  + '"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": '
  + 'write tcp [fe80::cd4:d264:d307:5358%utun8]:58301->[2001:4860:4843:400::]:443: '
  + 'write: socket is not connected';

function networkExit({ stderr = OBSERVED_SOCKET_ERROR, stdout = '' } = {}) {
  return new AgyExitError(1, stderr, { stdout, durationMs: 12 });
}

test('observed VPN/IPv6 socket-not-connected failure is classified as proven pre-send network unavailability', () => {
  const err = networkExit();
  assert.equal(err.stdoutWasEmpty, true);
  assert.equal(err.usageEvidenceState, 'absent');
  assert.equal(isAgyTransientPreSendNetworkFailure(err), true);
});

test('network classifier stays narrow: provider output, usage, and mid-stream reset are not auto-retried', () => {
  assert.equal(
    isAgyTransientPreSendNetworkFailure(networkExit({ stdout: JSON.stringify({ result: 'provider replied' }) })),
    false,
    'non-empty stdout means a provider/model response may exist',
  );
  assert.equal(
    isAgyTransientPreSendNetworkFailure(networkExit({
      stderr: OBSERVED_SOCKET_ERROR + '\ninput_tokens: 3',
    })),
    false,
    'reported usage is never mechanically zero',
  );
  assert.equal(
    isAgyTransientPreSendNetworkFailure(networkExit({
      stderr: 'request failed: read tcp 10.0.0.2:50000->1.2.3.4:443: read: connection reset by peer',
    })),
    false,
    'mid-stream reset may have reached the provider',
  );
  assert.equal(
    isAgyTransientPreSendNetworkFailure(networkExit({
      stderr: 'request failed: write tcp 10.0.0.2:50000->1.2.3.4:443: write: broken pipe',
    })),
    false,
    'broken pipe is not proven pre-send',
  );
});

test('AGY transport normalizes the observed socket failure into retryable AGY_NETWORK_UNAVAILABLE', async () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => { throw networkExit(); },
    provisionMinimalAgent: () => ({
      name: 'reviewloop-minimal',
      path: '/tmp/reviewloop-minimal.md',
    }),
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
      assert.equal(err.code, 'AGY_NETWORK_UNAVAILABLE');
      assert.equal(err.providerFailure, 'AGY_NETWORK_UNAVAILABLE');
      assert.equal(err.transientNetwork, true);
      assert.equal(err.preSendZeroProven, true);
      assert.equal(err.details?.preSendZeroProven, true);
      return true;
    },
  );
});

test('proven AGY network-unavailable failure settles zero and permits bounded reuse of the same logical evidence', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'net-failover', persistence });
  const ev = await spend.registerEvidence({
    kind: 'reviewstate',
    taskId: 'op',
    diffHash: 'D::G',
  });

  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer',
      family: 'agy:opus',
      provider: 'agy-claude-gpt',
      operationId: 'op',
      attempt: 1,
      evidenceIds: [ev.evidenceId],
      call: async () => {
        const e = new Error('pre-send network unavailable');
        e.code = 'AGY_NETWORK_UNAVAILABLE';
        e.providerFailure = 'AGY_NETWORK_UNAVAILABLE';
        e.preSendZeroProven = true;
        e.transientNetwork = true;
        throw e;
      },
    }),
    /pre-send network unavailable/,
  );

  const out = await spend.meteredCall({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'op',
    attempt: 2,
    evidenceIds: [ev.evidenceId],
    call: async () => ({
      value: { findings: [] },
      usage: { input_tokens: 2, output_tokens: 1 },
      model: 'codex-test',
    }),
  });
  assert.deepEqual(out, { findings: [] });

  const state = await persistence.readWorkflowState('net-failover');
  const records = state.reviewLoopSpend?.records ?? [];
  assert.equal(records.length, 2);
  assert.equal(records[0].failureCode, 'AGY_NETWORK_UNAVAILABLE');
  assert.equal(records[0].usageVolume, 0);
  assert.equal(records[0].usageKnown, true);
  assert.equal(records[0].transientNetwork, true);
  assert.equal(records[1].businessOutcome, 'SUCCESS');
});

test('unproven AGY_NETWORK_UNAVAILABLE cannot manufacture zero-spend failover eligibility', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'net-unproven', persistence });
  const ev = await spend.registerEvidence({
    kind: 'reviewstate',
    taskId: 'op',
    diffHash: 'D::G',
  });

  let firstErr = null;
  await spend.meteredCall({
    role: 'reviewer',
    family: 'agy:opus',
    provider: 'agy-claude-gpt',
    operationId: 'op',
    attempt: 1,
    evidenceIds: [ev.evidenceId],
    call: async () => {
      const e = new Error('network label without proof');
      e.code = 'AGY_NETWORK_UNAVAILABLE';
      throw e;
    },
  }).catch((e) => { firstErr = e; });
  assert.ok(firstErr);

  let secondCalls = 0;
  let denied = null;
  await spend.meteredCall({
    role: 'reviewer',
    family: 'codex:default',
    provider: 'codex',
    operationId: 'op',
    attempt: 2,
    evidenceIds: [ev.evidenceId],
    call: async () => {
      secondCalls += 1;
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  }).catch((e) => { denied = e; });

  assert.ok(denied, 'second attempt must be blocked because first usage is unresolved');
  assert.equal(secondCalls, 0);
});


test('one transient AGY network failure fresh-retries the same family and succeeds', async () => {
  const persistence = new MemoryPersistence();
  const families = [];
  const delays = [];
  const healthFailures = [];
  let n = 0;

  const { createReviewLoopController, DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS } =
    await import('../src/reviewloop/controller.js');

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => ({
      family: 'agy:opus',
      provider: 'agy-claude-gpt',
      model: 'claude-opus-4-6-thinking',
      transport: async () => ({}),
    }),
    recordProviderFailure: (selection, failure) => {
      healthFailures.push({ family: selection.family, code: failure.code });
    },
    sleepFn: async (ms) => { delays.push(ms); },
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      n += 1;
      if (n === 1) {
        const e = new Error('socket path unavailable');
        e.code = 'AGY_NETWORK_UNAVAILABLE';
        e.providerFailure = 'AGY_NETWORK_UNAVAILABLE';
        e.transientNetwork = true;
        e.preSendZeroProven = true;
        return Promise.reject(e);
      }
      return {
        value: { findings: [] },
        usage: { input_tokens: 5, output_tokens: 2 },
        model: 'claude-opus-4-6-thinking',
      };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'd', diff: 'x', changedFiles: ['a.js'],
      currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false,
    }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const result = await controller.review({ loopId });

  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
  assert.deepEqual(families, ['agy:opus', 'agy:opus']);
  assert.deepEqual(delays, [DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS[0]]);
  assert.equal(healthFailures.length, 0, 'a recovered socket race must not poison provider health');
});

test('two transient AGY network retries then fail over after the third failure', async () => {
  const persistence = new MemoryPersistence();
  const families = [];
  const delays = [];
  const healthFailures = [];
  let routedCalls = 0;

  const { createReviewLoopController, DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS } =
    await import('../src/reviewloop/controller.js');

  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals = {}) => {
      routedCalls += 1;
      const excluded = new Set(signals.excludeFamilies ?? []);
      return excluded.has('agy:opus')
        ? { family: 'codex:default', provider: 'codex', model: null, transport: async () => ({}) }
        : { family: 'agy:opus', provider: 'agy-claude-gpt', model: 'claude-opus-4-6-thinking', transport: async () => ({}) };
    },
    recordProviderFailure: (selection, failure) => {
      healthFailures.push({ family: selection.family, code: failure.code });
    },
    sleepFn: async (ms) => { delays.push(ms); },
    reviewerFn: async ({ selection }) => {
      families.push(selection.family);
      if (selection.family === 'agy:opus') {
        const e = new Error('socket path unavailable');
        e.code = 'AGY_NETWORK_UNAVAILABLE';
        e.providerFailure = 'AGY_NETWORK_UNAVAILABLE';
        e.transientNetwork = true;
        e.preSendZeroProven = true;
        throw e;
      }
      return {
        value: { findings: [] },
        usage: { input_tokens: 4, output_tokens: 2 },
        model: 'codex-test',
      };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      fingerprint: 'd', diff: 'x', changedFiles: ['a.js'],
      currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false,
    }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [],
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });

  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const result = await controller.review({ loopId });

  assert.equal(result.status, 'PASS', result.reason ?? JSON.stringify(result));
  assert.deepEqual(families, ['agy:opus', 'agy:opus', 'agy:opus', 'codex:default']);
  assert.deepEqual(delays, [...DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS]);
  assert.deepEqual(healthFailures, [], 'transient network exhaustion must not poison provider health');
  assert.ok(routedCalls >= 4, 'controller re-routes after operation-local exhaustion');

  const state = await persistence.readWorkflowState(loopId);
  const records = (state.reviewLoopSpend?.records ?? [])
    .filter((r) => r.role === 'reviewer');
  assert.deepEqual(
    records.slice(0, 3).map((r) => [r.family, r.failureCode, r.transientNetwork, r.usageVolume]),
    [
      ['agy:opus', 'AGY_NETWORK_UNAVAILABLE', true, 0],
      ['agy:opus', 'AGY_NETWORK_UNAVAILABLE', true, 0],
      ['agy:opus', 'AGY_NETWORK_UNAVAILABLE', true, 0],
    ],
  );
  assert.equal(records[3].family, 'codex:default');
  assert.equal(records[3].businessOutcome, 'SUCCESS');
});
