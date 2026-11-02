import test from 'node:test';
import assert from 'node:assert/strict';
import { overrideLoopBudget } from '../src/reviewloop/budgetOverride.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { REVIEW_LOOP_STATES } from '../src/reviewloop/state.js';

class MockPersistence {
  constructor(initial = {}) {
    this._state = JSON.parse(JSON.stringify(initial));
  }
  async readWorkflowState(id) {
    return this._state[id] ?? null;
  }
  async updateWorkflowState(id, patch) {
    this._state[id] = { ...(this._state[id] ?? {}), ...patch };
  }
}

async function oneReviewerCall(spend, hash, usage = { input_tokens: 100, output_tokens: 50 }, costUsd = 0.01) {
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: `t-${hash}`, diffHash: hash });
  return spend.meteredCall({
    role: 'reviewer',
    operationId: `op-${hash}`,
    evidenceIds: [ev.evidenceId],
    call: async () => ({ value: {}, usage, costUsd }),
  });
}

test('overrideLoopBudget validates arguments strictly', async () => {
  const p = new MockPersistence();
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: '' }),
    /requires a loopId/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'l1', reason: '' }),
    /requires an explicit reason/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'l1', reason: 'expand' }),
    /requires --max-usage or --max-cost/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'l1', reason: 'expand', maxUsage: -10 }),
    /maxUsage must be a positive integer/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'l1', reason: 'expand', maxUsage: 12.5 }),
    /maxUsage must be a positive integer/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'l1', reason: 'expand', maxCost: -5 }),
    /maxCost must be a positive number/,
  );
});

test('overrideLoopBudget refuses unknown loop, retired PR, or tripped Token Sentinel', async () => {
  const p = new MockPersistence({
    'retired-pr': { reviewLoop: { objective: { mode: 'PR' } } },
    'sentinel-tripped': {
      reviewLoop: { state: 'HUMAN_REQUIRED' },
      reviewLoopTokenAnomaly: { tripped: true },
    },
  });

  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'unknown', reason: 'expand', maxUsage: 500000 }),
    /unknown loopId/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'retired-pr', reason: 'expand', maxUsage: 500000 }),
    /ReviewLoop PR session retired/,
  );
  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'sentinel-tripped', reason: 'expand', maxUsage: 500000 }),
    /Token Sentinel tripped/,
  );
});

test('overrideLoopBudget rejects new ceiling that does not exceed currently accumulated spend', async () => {
  const p = new MockPersistence({
    'spent-loop': {
      reviewLoop: { state: 'HUMAN_REQUIRED', round: 5 },
      reviewLoopSpend: {
        records: [
          { usageVolume: 200000, costUsd: 2.5 },
          { usageVolume: 203000, costUsd: 2.5 },
        ],
      },
    },
  });

  await assert.rejects(
    () => overrideLoopBudget({ persistence: p, loopId: 'spent-loop', reason: 'more tokens', maxUsage: 400000 }),
    /must exceed currently accumulated spend \(403000 tokens\)/,
  );
});

test('overrideLoopBudget durably records audit trail and restores SPEND_DENIED loop to REWORK', async () => {
  const p = new MockPersistence({
    'loop-1': {
      reviewLoop: {
        loopId: 'loop-1',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 8,
        currentPhaseIndex: 1,
        budgetExhausted: true,
        reason: 'ReviewLoop model spend blocked: SPEND_DENIED',
      },
      reviewLoopSpend: {
        records: [
          { usageVolume: 403165, costUsd: 0 },
        ],
      },
    },
  });

  const res = await overrideLoopBudget({
    persistence: p,
    loopId: 'loop-1',
    maxUsage: 480000,
    reason: 'Workflow Gallery MVP final chunk pending approval',
    now: () => new Date('2026-11-02T20:00:00Z'),
  });

  assert.equal(res.previousLimit, 400000);
  assert.equal(res.newLimit, 480000);
  assert.equal(res.currentUsage, 403165);
  assert.equal(res.overridesCount, 1);
  assert.equal(res.stateRestored, true);
  assert.equal(res.loopState, REVIEW_LOOP_STATES.REWORK);

  const updated = await p.readWorkflowState('loop-1');
  assert.equal(updated.reviewLoop.state, REVIEW_LOOP_STATES.REWORK);
  assert.equal(updated.reviewLoop.budgetExhausted, false);
  assert.equal(updated.reviewLoop.maxUsageVolumeOverride, 480000);
  assert.equal(updated.budgetOverrides.maxUsageVolume, 480000);
  assert.equal(updated.reviewLoop.budgetOverrides.length, 1);
  assert.deepEqual(updated.reviewLoop.budgetOverrides[0], {
    at: '2026-11-02T20:00:00.000Z',
    requestedBy: 'human',
    previousUsageLimit: 400000,
    newUsageLimit: 480000,
    previousCostLimit: 5,
    newCostLimit: 5,
    reason: 'Workflow Gallery MVP final chunk pending approval',
    round: 8,
    phaseIndex: 1,
  });

  // Verify spend records were NOT reset or truncated
  assert.equal(updated.reviewLoopSpend.records.length, 1);
  assert.equal(updated.reviewLoopSpend.records[0].usageVolume, 403165);
});

test('Spend authority honors durable budget override on subsequent dispatches', async () => {
  const p = new MockPersistence({
    'overridden-loop': {
      reviewLoop: {
        loopId: 'overridden-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        budgetExhausted: true,
        reason: 'SPEND_DENIED',
      },
      reviewLoopSpend: {
        records: [
          {
            role: 'reviewer',
            round: 1,
            attempt: 1,
            family: 'agy:opus',
            provider: 'agy',
            usageVolume: 401000,
            costUsd: 1,
            settlementReason: 'KNOWN',
          },
        ],
      },
    },
  });

  // Under default limits, authority denies because 401,000 >= 400,000
  const spendBefore = createReviewLoopSpend({ loopId: 'overridden-loop', persistence: p });
  const telemetryBefore = await spendBefore.telemetry();
  assert.equal(telemetryBefore.limits.maxUsageVolume, 400000);
  await assert.rejects(
    () => oneReviewerCall(spendBefore, 'call-before'),
    /usage-volume ceiling \(400000\) reached/,
  );

  // Apply override to 480,000
  await overrideLoopBudget({
    persistence: p,
    loopId: 'overridden-loop',
    maxUsage: 480000,
    reason: 'Authorized expansion',
  });

  // Now createReviewLoopSpend automatically recognizes the 480,000 ceiling from disk
  const spendAfter = createReviewLoopSpend({ loopId: 'overridden-loop', persistence: p });
  const telemetryAfter = await spendAfter.telemetry();
  assert.equal(telemetryAfter.limits.maxUsageVolume, 480000);

  // Call succeeds under new 480,000 ceiling
  await oneReviewerCall(spendAfter, 'call-after');
  const telemetryFinal = await spendAfter.telemetry();
  assert.equal(telemetryFinal.usageVolume, 401150);
});

test('overrideLoopBudget refuses to restore loops stopped by non-ceiling denials', async () => {
  const p = new MockPersistence({
    'unaccounted-spend-loop': {
      reviewLoop: {
        loopId: 'unaccounted-spend-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 3,
        reason: 'ReviewLoop model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED' },
        ],
      },
      reviewLoopSpend: {
        records: [{ usageVolume: 100000, costUsd: 1 }],
      },
    },
  });

  const res = await overrideLoopBudget({
    persistence: p,
    loopId: 'unaccounted-spend-loop',
    maxUsage: 500000,
    reason: 'Trying to bypass unaccounted spend with budget override',
  });

  assert.equal(res.stateRestored, false);
  assert.equal(res.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);

  const state = await p.readWorkflowState('unaccounted-spend-loop');
  assert.equal(state.reviewLoop.state, REVIEW_LOOP_STATES.HUMAN_REQUIRED);
});

test('overrideLoopBudget restores only when the exhausted limit is cleared', async () => {
  const p = new MockPersistence({
    'usage-exhausted-loop': {
      reviewLoop: {
        loopId: 'usage-exhausted-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 8,
        reason: 'ReviewLoop model spend blocked: SPEND_DENIED (ReviewLoop usage-volume ceiling (400000) reached)',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'model spend blocked: SPEND_DENIED' },
        ],
      },
      reviewLoopSpend: {
        records: [{ usageVolume: 403165, costUsd: 1.5 }],
      },
    },
    'cost-exhausted-loop': {
      reviewLoop: {
        loopId: 'cost-exhausted-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 4,
        reason: 'ReviewLoop model spend blocked: SPEND_DENIED (ReviewLoop cost ceiling ($5) reached)',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'model spend blocked: SPEND_DENIED' },
        ],
      },
      reviewLoopSpend: {
        records: [{ usageVolume: 50000, costUsd: 5.5 }],
      },
    },
  });

  // Raising only --max-cost on a usage-exhausted loop must NOT restore it
  const usageOnlyCostOverride = await overrideLoopBudget({
    persistence: p,
    loopId: 'usage-exhausted-loop',
    maxCost: 10,
    reason: 'Raising cost only',
  });
  assert.equal(usageOnlyCostOverride.stateRestored, false);
  assert.equal(usageOnlyCostOverride.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);

  // Raising --max-usage on the usage-exhausted loop DOES restore it
  const usageClearedOverride = await overrideLoopBudget({
    persistence: p,
    loopId: 'usage-exhausted-loop',
    maxUsage: 480000,
    reason: 'Raising usage ceiling past 403165',
  });
  assert.equal(usageClearedOverride.stateRestored, true);
  assert.equal(usageClearedOverride.loopState, REVIEW_LOOP_STATES.REWORK);

  // Raising only --max-usage on a cost-exhausted loop must NOT restore it
  const costOnlyUsageOverride = await overrideLoopBudget({
    persistence: p,
    loopId: 'cost-exhausted-loop',
    maxUsage: 600000,
    reason: 'Raising usage only',
  });
  assert.equal(costOnlyUsageOverride.stateRestored, false);
  assert.equal(costOnlyUsageOverride.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);

  // Raising --max-cost on the cost-exhausted loop DOES restore it
  const costClearedOverride = await overrideLoopBudget({
    persistence: p,
    loopId: 'cost-exhausted-loop',
    maxCost: 15,
    reason: 'Raising cost ceiling past 5.5',
  });
  assert.equal(costClearedOverride.stateRestored, true);
  assert.equal(costClearedOverride.loopState, REVIEW_LOOP_STATES.REWORK);
});

test('overrideLoopBudget resolves effective limits from env and rejects partial override against env limit', async () => {
  const p = new MockPersistence({
    'env-limited-loop': {
      reviewLoop: {
        loopId: 'env-limited-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 4,
        budgetExhausted: true,
        reason: 'SPEND_DENIED',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'model spend blocked: SPEND_DENIED' },
        ],
      },
      reviewLoopSpend: {
        records: [{ usageVolume: 250000, costUsd: 1.0 }],
      },
    },
  });

  const customEnv = { REVIEWLOOP_MAX_USAGE_VOLUME: '200000' };

  // Even though 250,000 < 400,000 (default), it exceeds customEnv (200,000).
  // Raising only --max-cost must NOT restore the loop.
  const costOnlyRes = await overrideLoopBudget({
    persistence: p,
    loopId: 'env-limited-loop',
    maxCost: 10,
    reason: 'Raising cost only',
    env: customEnv,
  });
  assert.equal(costOnlyRes.stateRestored, false);
  assert.equal(costOnlyRes.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);
  assert.equal(costOnlyRes.previousLimit, 200000);

  // Raising max-usage past 250,000 DOES restore the loop
  const usageRes = await overrideLoopBudget({
    persistence: p,
    loopId: 'env-limited-loop',
    maxUsage: 300000,
    reason: 'Raising usage ceiling to 300000',
    env: customEnv,
  });
  assert.equal(usageRes.stateRestored, true);
  assert.equal(usageRes.loopState, REVIEW_LOOP_STATES.REWORK);
  assert.equal(usageRes.previousLimit, 200000);
  assert.equal(usageRes.newLimit, 300000);
});

test('overrideLoopBudget refuses to restore loops stopped by call ceiling or round exhaustion', async () => {
  const reviewerCalls = Array.from({ length: 15 }, (_, i) => ({
    role: 'reviewer',
    usageVolume: 1000,
    costUsd: 0.01,
  }));

  const p = new MockPersistence({
    'call-limited-loop': {
      reviewLoop: {
        loopId: 'call-limited-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 4,
        reason: 'ReviewLoop model spend blocked: SPEND_DENIED (ReviewLoop reviewer call ceiling (12) reached)',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'model spend blocked: SPEND_DENIED (ReviewLoop reviewer call ceiling (12) reached)' },
        ],
      },
      reviewLoopSpend: {
        records: reviewerCalls,
      },
    },
    'round-exhausted-loop': {
      reviewLoop: {
        loopId: 'round-exhausted-loop',
        state: REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        round: 3,
        budgetExhausted: true,
        reason: 'review did not converge',
        history: [
          { from: 'REVIEWING', to: REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason: 'review did not converge' },
        ],
      },
      reviewLoopSpend: {
        records: [{ usageVolume: 20000, costUsd: 0.5 }],
      },
    },
  });

  const customEnv = { REVIEWLOOP_MAX_REVIEWER_CALLS: '12' };

  // Call ceiling cannot be cleared by budget override
  const callRes = await overrideLoopBudget({
    persistence: p,
    loopId: 'call-limited-loop',
    maxUsage: 500000,
    reason: 'Trying to unblock call limit with token budget',
    env: customEnv,
  });
  assert.equal(callRes.stateRestored, false);
  assert.equal(callRes.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);

  // Round convergence cannot be cleared by budget override (needs reopen-gate)
  const roundRes = await overrideLoopBudget({
    persistence: p,
    loopId: 'round-exhausted-loop',
    maxUsage: 500000,
    reason: 'Trying to unblock round exhaustion with token budget',
  });
  assert.equal(roundRes.stateRestored, false);
  assert.equal(roundRes.loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED);
});
