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

test('proven AGY network-unavailable failure settles zero and permits one bounded failover attempt', async () => {
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
