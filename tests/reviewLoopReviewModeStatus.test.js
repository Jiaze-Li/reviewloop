import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewObjective, rehydrateObjective, resolveReviewMode, REVIEW_WORKFLOWS } from '../src/reviewloop/objective.js';
import { beginStatusLine, reviewStatusLine } from '../src/reviewloop/statusLine.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const base = { loopId: 'rl-1', goal: 'g', createdAt: '2026-11-11T00:00:00.000Z' };

test('reviewMode is explicit for code / legacy design / two-stage design', () => {
  assert.equal(createReviewObjective(base).reviewMode, REVIEW_WORKFLOWS.CODE);
  assert.equal(createReviewObjective({ ...base, taskType: 'design' }).reviewMode, REVIEW_WORKFLOWS.DESIGN_LEGACY);
  assert.equal(
    createReviewObjective({ ...base, taskType: 'design', reviewTarget: 'D.md' }).reviewMode,
    REVIEW_WORKFLOWS.DESIGN_TWO_STAGE,
  );
});

test('older persisted objectives without reviewMode resolve identically and keep their fingerprint', () => {
  for (const extra of [{}, { taskType: 'design' }, { taskType: 'design', reviewTarget: 'D.md' }]) {
    const o = createReviewObjective({ ...base, ...extra });
    const raw = JSON.parse(JSON.stringify(o));
    delete raw.reviewMode;
    const re = rehydrateObjective(raw);
    assert.equal(re.fingerprint, o.fingerprint);
    assert.equal(resolveReviewMode(re), o.reviewMode);
  }
});

test('a tampered stored reviewMode cannot change the resolved mode', () => {
  const o = createReviewObjective({ ...base, taskType: 'design', reviewTarget: 'D.md' });
  assert.equal(resolveReviewMode({ ...o, reviewMode: 'code' }), REVIEW_WORKFLOWS.DESIGN_TWO_STAGE);
});

test('statusLine formats are fixed', () => {
  assert.equal(beginStatusLine({ taskType: 'design', loopId: 'L' }), '[ReviewLoop | design | 启动] loopId=L');
  assert.equal(
    reviewStatusLine({ taskType: 'code', loopId: 'L', round: 2, status: 'REWORK' }),
    '[ReviewLoop | code | 第 2 轮 → REWORK] loopId=L',
  );
});

test('review() attaches statusLine and forwards onHeartbeat stage messages', async () => {
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'B', currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'F1', diff: 'diff --git a/a.js b/a.js\n+x\n',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G1', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['true'], manifestFingerprint: 'm' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  const b = await ctl.begin({ goal: 'g', cwd: process.cwd() });
  const beats = [];
  const res = await ctl.review({ loopId: b.loopId, onHeartbeat: async (m) => { beats.push(m); } });
  assert.match(res.statusLine, new RegExp(`^\\[ReviewLoop \\| code \\| 第 \\d+ 轮 → ${res.status}\\] loopId=${b.loopId}$`));
  assert.ok(beats.some((m) => m.includes('gate_running')));
});
