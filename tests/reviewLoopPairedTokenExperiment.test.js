import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePairedTokenProfiles, formatPairedTokenEvaluation } from '../src/reviewloop/tokenExperiment.js';

function workflow(loopId, volumes, {
  fp = 'frozen-contract-and-baseline-hash',
  reviewed = 'same-reviewed-code-gate-evidence-hash',
  mode = 'LOCAL',
  state = 'PASS',
  model = 'fixed-test-reviewer',
  unknown = false,
  unknownCost = false,
} = {}) {
  return {
    reviewLoop: {
      loopId, state, lastReviewedFingerprint: reviewed,
      objective: { mode, fingerprint: fp },
    },
    reviewLoopSpend: {
      records: volumes.map((usageVolume, i) => ({
        role: 'reviewer', round: i + 1, family: 'agy:reviewer',
        model, usageVolume,
        usageKnown: !unknown,
        costKnown: !unknownCost,
        costUsd: (usageVolume / 100000),
        usageAccounting: { semanticsKnown: true },
        usageBreakdown: { inputTokens: usageVolume - 5, outputTokens: 5 },
      })),
    },
    unrelatedText: 'CONFIDENTIAL-DO-NOT-EXPORT',
  };
}

test('matched frozen objective, reviewed state and model permit one measured physical spend comparison', () => {
  const before = workflow('before-run', [180, 120]);
  const after = workflow('after-run', [110]);
  const result = evaluatePairedTokenProfiles({ beforeWorkflow: before, afterWorkflow: after });
  assert.equal(result.comparable, true);
  assert.equal(result.status, 'MATCHED_PAIR_OBSERVATION');
  assert.deepEqual(result.usageVolume, { before: 300, after: 110,
    change: -190, changePercent: (-190 / 300) * 100 });
  assert.equal(result.physicalCalls.change, -1);
  assert.equal(result.knownCostUsd.change, -0.0019);
  assert.equal(JSON.stringify(result).includes('CONFIDENTIAL-DO-NOT-EXPORT'), false);
  assert.match(formatPairedTokenEvaluation(result), /Recorded usageVolume/);
  assert.match(formatPairedTokenEvaluation(result), /single pair does not prove causal savings/i);
});

test('changed objective or reviewed code makes spend savings non-comparable, not falsely positive', () => {
  const before = workflow('before', [100]);
  const changed = workflow('after', [10], { fp: 'different-objective', reviewed: 'different-code' });
  const result = evaluatePairedTokenProfiles({ beforeWorkflow: before, afterWorkflow: changed });
  assert.equal(result.status, 'NOT_COMPARABLE');
  assert.equal(result.usageVolume, null);
  assert.equal(result.physicalCalls, null);
  assert.match(formatPairedTokenEvaluation(result), /NO VALID TOKEN-SAVINGS CLAIM/);
  assert.ok(result.reasons.some((x) => x.includes('frozen objective')));
  assert.ok(result.reasons.some((x) => x.includes('reviewed code')));
});

test('UNKNOWN usage, mismatched provider or unfinished runs cannot produce a savings claim', () => {
  const before = workflow('before', [100]);
  for (const changed of [
    workflow('after', [10], { unknown: true }),
    workflow('after', [10], { model: 'different-model' }),
    workflow('after', [10], { state: 'REWORK' }),
    { reviewLoop: { loopId: 'after', objective: { mode: 'LOCAL', fingerprint: before.reviewLoop.objective.fingerprint },
      lastReviewedFingerprint: before.reviewLoop.lastReviewedFingerprint, state: 'PASS' } },
  ]) {
    const result = evaluatePairedTokenProfiles({ beforeWorkflow: before, afterWorkflow: changed });
    assert.equal(result.comparable, false, JSON.stringify(result));
    assert.equal(result.usageVolume, null);
  }
});

test('unknown dollar cost forbids cost-savings claim while measured token volume remains comparable', () => {
  const result = evaluatePairedTokenProfiles({
    beforeWorkflow: workflow('before', [200], { unknownCost: true }),
    afterWorkflow: workflow('after', [120]),
  });
  assert.equal(result.comparable, true);
  assert.equal(result.usageVolume.change, -80);
  assert.equal(result.knownCostUsd, null);
  assert.match(formatPairedTokenEvaluation(result), /INCOMPLETE/);
});

test('offline CLI reads two explicit files without mutation, and returns exit 2 for invalid matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rl-paired-profiles-'));
  try {
    const script = fileURLToPath(new URL('../scripts/compare-token-profiles.mjs', import.meta.url));
    const a = path.join(root, 'before.workflow.json');
    const b = path.join(root, 'after.workflow.json');
    const beforeRaw = JSON.stringify(workflow('before', [150, 100]), null, 2);
    const afterRaw = JSON.stringify(workflow('after', [120]), null, 2);
    await writeFile(a, beforeRaw);
    await writeFile(b, afterRaw);
    const run = (args) => spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000,
    });
    const success = run([a, b, '--json']);
    assert.equal(success.status, 0, success.stderr);
    const parsed = JSON.parse(success.stdout);
    assert.equal(parsed.usageVolume.change, -130);
    assert.equal(await readFile(a, 'utf8'), beforeRaw);
    assert.equal(await readFile(b, 'utf8'), afterRaw);
    assert.equal(success.stdout.includes('CONFIDENTIAL-DO-NOT-EXPORT'), false);

    const invalid = { ...workflow('after', [120]), reviewLoop: {
      ...workflow('after', [120]).reviewLoop, state: 'HUMAN_REQUIRED',
    } };
    await writeFile(b, JSON.stringify(invalid));
    const refused = run([a, b]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stdout, /NO VALID TOKEN-SAVINGS CLAIM/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
