import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildTokenProfile, formatTokenProfile } from '../src/reviewloop/tokenProfile.js';

const HASH = 'a'.repeat(64);

function fixture() {
  return {
    reviewLoop: { loopId: 'rl-profile-test', state: 'REWORK', round: 7 },
    reviewLoopSpend: {
      records: [
        {
          role: 'reviewer', round: 7, chunkIndex: 0, chunkTotal: 2,
          model: 'codex-test', family: 'codex:default', provider: 'codex',
          usageKnown: true, usageVolume: 120, costKnown: true, costUsd: 0.04,
          usageAccounting: { method: 'openai_input_plus_output', semanticsKnown: true },
          usageBreakdown: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
          payloadMeta: {
            promptChars: 400, diffChars: 100, estimatedPayloadTokens: 100,
            promptText: 'SECRET-PROMPT-DO-NOT-EXPORT',
            promptComponentStats: {
              goalChars: 50, contractChars: 80, contractSha256: HASH,
              evidenceChars: 12, diffChars: 100,
            },
          },
          contextOverheadTokens: 0, businessOutcome: 'SUCCESS',
        },
        {
          role: 'reviewer', round: 7, chunkIndex: 1, chunkTotal: 2,
          model: 'codex-test', family: 'codex:default', provider: 'codex',
          usageKnown: true, usageVolume: 185, costKnown: false, costUsd: 0,
          usageAccounting: { method: 'openai_input_plus_output', semanticsKnown: true },
          usageBreakdown: { inputTokens: 160, outputTokens: 25, cacheReadTokens: 80 },
          payloadMeta: {
            promptChars: 450, diffChars: 150, estimatedPayloadTokens: 113,
            promptComponentStats: {
              goalChars: 50, contractChars: 80, contractSha256: HASH,
              evidenceChars: 12, diffChars: 150,
            },
          },
          contextOverheadTokens: 47, businessOutcome: 'SUCCESS',
        },
        {
          role: 'supervisor', round: 7, chunkIndex: null, chunkTotal: null,
          model: null, family: 'agy:gemini-supervisor',
          usageKnown: false, usageVolume: 0, costKnown: false, costUsd: 0,
          usageAccounting: { method: 'no_usage_reported', semanticsKnown: false },
          usageBreakdown: {},
          payloadMeta: { promptChars: 90, estimatedPayloadTokens: 23 },
          contextOverheadTokens: null, businessOutcome: 'FAILURE',
        },
      ],
    },
  };
}

test('token profile sums durable budget volume without double-counting cache fields', () => {
  const p = buildTokenProfile({ loopId: 'rl-profile-test', workflow: fixture() });
  assert.equal(p.version, 1);
  assert.equal(p.summary.physicalCalls, 3);
  assert.equal(p.summary.reviewerCalls, 2);
  assert.equal(p.summary.supervisorCalls, 1);
  assert.equal(p.summary.ledgerUsageVolume, 305); // 120+185, NOT 305+60+80
  assert.equal(p.summary.unknownUsageCalls, 1);
  assert.equal(p.summary.unknownCostCalls, 2);
  assert.equal(p.summary.knownCostUsd, 0.04);
  assert.equal(p.summary.unknownSemanticsCalls, 1);
  assert.deepEqual(p.rawUsage.inputTokens, { reportedCalls: 2, sum: 260 });
  assert.deepEqual(p.rawUsage.cacheReadTokens, { reportedCalls: 2, sum: 140 });
  assert.equal(p.prompt.verifiedRepeatedContractChars, 80);
  assert.deepEqual(p.prompt.components.contractChars, { reportedCalls: 2, chars: 160 });
  assert.equal(p.prompt.estimatedContextOverheadTokens.estimatedTokens, 47);
});

test('profile reports every round, chunk and model, with absent fields as unknown', () => {
  const p = buildTokenProfile({ loopId: 'rl-profile-test', workflow: fixture() });
  assert.equal(p.rounds.length, 1);
  assert.equal(p.rounds[0].round, 7);
  assert.deepEqual(p.rounds[0].calls.map((c) => c.chunkIndex), [0, 1, null]);
  assert.equal(p.rounds[0].summary.ledgerUsageVolume, 305);
  assert.equal(p.rounds[0].calls[2].breakdown.inputTokens, null);
  assert.equal(p.rounds[0].calls[2].costUsd, null);
  const txt = formatTokenProfile(p);
  assert.match(txt, /Round 7/);
  assert.match(txt, /chunk=0\/2/);
  assert.match(txt, /chunk=1\/2/);
  assert.match(txt, /unknown usage calls: 1/);
  assert.match(txt, /NOT additive/);
  assert.match(txt, /CHARACTERS, not tokens/);
});

test('token profiling is a pure read-only projection and does not echo prompt content', () => {
  const state = fixture();
  const prior = structuredClone(state);
  const p = buildTokenProfile({ loopId: 'rl-profile-test', workflow: state });
  assert.deepEqual(state, prior);
  assert.equal(JSON.stringify(p).includes('SECRET-PROMPT-DO-NOT-EXPORT'), false);
  assert.equal(p.rounds[0].calls[0].prompt.promptChars, 400);
  assert.equal(p.rounds[0].calls[0].prompt.estimatedPayloadTokens, 100);
});

test('unavailable ledger or legacy usage metadata is never silently treated as exact spend', () => {
  const missing = buildTokenProfile({ loopId: 'legacy', workflow: { reviewLoop: { loopId: 'legacy' } } });
  assert.equal(missing.ledgerAvailable, false);
  assert.match(formatTokenProfile(missing), /MISSING \(cannot infer zero usage\)/);
  const legacy = buildTokenProfile({
    loopId: 'legacy',
    workflow: { reviewLoop: { loopId: 'legacy' }, reviewLoopSpend: { records: [
      { role: 'reviewer', round: 2, usageVolume: 300, costUsd: 0, costKnown: false },
      { role: 'reviewer', round: null, usageKnown: false, usageVolume: null },
    ] } },
  });
  assert.equal(legacy.summary.ledgerUsageVolume, 300);
  assert.equal(legacy.summary.missingVolumeRecords, 1);
  assert.equal(legacy.summary.unknownUsageCalls, 2);
  assert.equal(legacy.summary.unknownCostCalls, 2);
  assert.equal(legacy.rounds.length, 2);
  assert.equal(legacy.rounds[1].round, null);
  assert.throws(() => buildTokenProfile({
    loopId: 'legacy', workflow: { reviewLoop: {}, reviewLoopSpend: { records: [null] } },
  }), /invalid durable spend record/);
});

test('CLI profile --json reads workflow.json without mutating it or calling models', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewloop-profile-'));
  try {
    const loopId = 'rl-profile-test';
    mkdirSync(join(root, loopId));
    const file = join(root, loopId, 'workflow.json');
    const original = JSON.stringify(fixture(), null, 2);
    writeFileSync(file, original);
    const cli = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
    const res = spawnSync(process.execPath, [cli, 'profile', '--loop', loopId, '--json'], {
      env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: root },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(res.status, 0, res.stderr);
    const profile = JSON.parse(res.stdout);
    assert.equal(profile.summary.ledgerUsageVolume, 305);
    assert.equal(profile.rounds[0].calls[1].chunkIndex, 1);
    assert.equal(readFileSync(file, 'utf8'), original, 'the profile command must not rewrite state');
    assert.equal(JSON.stringify(profile).includes('SECRET-PROMPT-DO-NOT-EXPORT'), false);

    const missing = spawnSync(process.execPath, [cli, 'profile', '--loop', 'does-not-exist'], {
      env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: root }, encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /unknown ReviewLoop session/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
