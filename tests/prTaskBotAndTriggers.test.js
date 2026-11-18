import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrustedBotSession,
  evaluatePrStatus,
  triggerGeminiReview,
  buildDismissComment,
  assertPrActionAuthorized,
  recordPrFixRound,
  triggerMarker,
  MAX_REVIEW_TRIGGERS,
} from '../src/reviewloop/prTaskEngine.js';
import { ReviewLoopStore } from '../src/reviewloop/state.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makePrTask(overrides = {}) {
  return {
    loopId: 'rl-pr-test',
    prNumber: 51,
    repoFullName: 'Jiaze-Li/reviewloop',
    repoRoot: '/repo',
    baseBranch: 'main',
    headBranch: 'feat/pr-task',
    boundHeadSha: HEAD_A,
    trustedBotLogins: ['claude-review-bot[bot]'],
    permissions: { edit: true, commit: true, push: true, comment: true, autoWake: false },
    reviewTriggers: [],
    sharedBoundaryStreak: { count: 0, boundaryKey: null, roundHistory: [] },
    ...overrides,
  };
}

test('parseTrustedBotSession ignores untrusted authors and missing markers, and parses JSON & markdown sessions', () => {
  const comments = [
    {
      id: 'c1',
      author: { login: 'random-user' },
      body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${HEAD_A}"} -->`,
      createdAt: '2026-11-18T01:00:00Z',
    },
    {
      id: 'c2',
      author: { login: 'claude-review-bot[bot]' },
      body: 'Status: READY without marker',
      createdAt: '2026-11-18T01:01:00Z',
    },
    {
      id: 'c3',
      author: { login: 'claude-review-bot[bot]' },
      body: [
        '<!-- jiaze-review-session:v1 -->',
        'Status: REWORK',
        `lastReviewedHead: ${HEAD_A}`,
        '- [P1] F001: Missing null guard',
        '- [P3] F002 [DISMISSED]: Style nit',
      ].join('\n'),
      createdAt: '2026-11-18T01:02:00Z',
    },
  ];

  const parsed = parseTrustedBotSession({ comments });
  assert.equal(parsed.found, true);
  assert.equal(parsed.parseable, true);
  assert.equal(parsed.commentId, 'c3');
  assert.equal(parsed.sessionStatus, 'REWORK');
  assert.equal(parsed.lastReviewedHead, HEAD_A);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.openFindings.length, 1);
  assert.equal(parsed.openFindings[0].id, 'F001');
});

test('evaluatePrStatus never marks stale READY, AUDIT_PENDING, PARTIAL, or MISSING as PASS', () => {
  const prTask = makePrTask();
  const prState = { state: 'OPEN', headRefOid: HEAD_A };

  // Stale READY on HEAD_B while live HEAD is HEAD_A
  const staleReady = evaluatePrStatus({
    prState,
    prTask,
    comments: [{
      id: 'c1',
      author: { login: 'claude-review-bot[bot]' },
      body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${HEAD_B}"} -->`,
    }],
  });
  assert.equal(staleReady.verdict, 'WAITING_FOR_REVIEW');
  assert.equal(staleReady.reason, 'STALE_BOT_READY');

  // AUDIT_PENDING & PARTIAL -> WAITING_FOR_REVIEW
  for (const status of ['AUDIT_PENDING', 'PARTIAL', 'REVIEW_IN_PROGRESS']) {
    const waiting = evaluatePrStatus({
      prState,
      prTask,
      comments: [{
        id: 'c2',
        author: { login: 'claude-review-bot[bot]' },
        body: `<!-- jiaze-review-session:v1 {"status":"${status}","lastReviewedHead":"${HEAD_A}"} -->`,
      }],
    });
    assert.equal(waiting.verdict, 'WAITING_FOR_REVIEW');
  }

  // Missing session -> WAITING_FOR_REVIEW
  assert.equal(evaluatePrStatus({ prState, prTask, comments: [] }).verdict, 'WAITING_FOR_REVIEW');

  // HUMAN_REQUIRED -> HUMAN_REQUIRED
  const human = evaluatePrStatus({
    prState,
    prTask,
    comments: [{
      id: 'c3',
      author: { login: 'claude-review-bot[bot]' },
      body: `<!-- jiaze-review-session:v1 {"status":"HUMAN_REQUIRED","lastReviewedHead":"${HEAD_A}"} -->`,
    }],
  });
  assert.equal(human.verdict, 'HUMAN_REQUIRED');

  // HEAD drift -> HUMAN_REQUIRED
  assert.equal(
    evaluatePrStatus({ prState: { state: 'OPEN', headRefOid: HEAD_B }, prTask, comments: [] }).verdict,
    'HUMAN_REQUIRED',
  );

  // Closed PR -> STOPPED
  assert.equal(
    evaluatePrStatus({ prState: { state: 'CLOSED', headRefOid: HEAD_A }, prTask, comments: [] }).verdict,
    'STOPPED',
  );

  // Matching READY on live HEAD -> PASS
  const ready = evaluatePrStatus({
    prState,
    prTask,
    comments: [{
      id: 'c4',
      author: { login: 'claude-review-bot[bot]' },
      body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${HEAD_A}"} -->`,
    }],
  });
  assert.equal(ready.verdict, 'PASS');
});

test('triggerGeminiReview enforces max 3 posted triggers, ignores failed/dismiss, and recovers PENDING on crash', async () => {
  const persistence = new MemoryPersistence();
  const store = new ReviewLoopStore(persistence);
  const prTask = makePrTask();
  await store.savePrTask(prTask.loopId, prTask);

  let postCalls = 0;
  // 1. Failed post does NOT consume the 3-comment limit
  const failRes = await triggerGeminiReview({
    loopId: prTask.loopId,
    prTask,
    prState: { state: 'OPEN', headRefOid: HEAD_A },
    comments: [],
    store,
    postCommentFn: async () => {
      postCalls += 1;
      throw new Error('network error');
    },
  });
  assert.equal(failRes.posted, false);
  assert.equal(failRes.postedCount, 0);
  assert.equal(prTask.reviewTriggers[0].status, 'FAILED');

  // 2. Three successful posts on 3 distinct HEADs
  for (let i = 1; i <= MAX_REVIEW_TRIGGERS; i += 1) {
    const sha = `${String(i).repeat(40)}`;
    prTask.boundHeadSha = sha;
    const res = await triggerGeminiReview({
      loopId: prTask.loopId,
      prTask,
      prState: { state: 'OPEN', headRefOid: sha },
      comments: [],
      store,
      postCommentFn: async () => {
        postCalls += 1;
        return { commentId: `gh-${i}`, commentUrl: `https://github.com/x/y/pull/51#issuecomment-${i}` };
      },
    });
    assert.equal(res.posted, true);
    assert.equal(res.postedCount, i);
  }
  assert.equal(postCalls, 4);

  // 3. 4th post is blocked by TRIGGER_LIMIT_REACHED
  prTask.boundHeadSha = '9'.repeat(40);
  const fourth = await triggerGeminiReview({
    loopId: prTask.loopId,
    prTask,
    prState: { state: 'OPEN', headRefOid: prTask.boundHeadSha },
    comments: [],
    store,
    postCommentFn: async () => {
      postCalls += 1;
      return { commentId: 'gh-4' };
    },
  });
  assert.equal(fourth.posted, false);
  assert.equal(fourth.reason, 'TRIGGER_LIMIT_REACHED');
  assert.equal(postCalls, 4);

  // 4. Dismiss helper does not write to reviewTriggers
  const dismissBody = buildDismissComment({
    findingId: 'F001',
    reason: 'False positive',
    evidence: 'Guarded at line 42',
  });
  assert.match(dismissBody, /^@gemini dismiss F001/);
  assert.equal(prTask.reviewTriggers.filter((t) => t.status === 'POSTED').length, 3);

  // 5. Crash recovery: PENDING trigger already on GitHub promotes to POSTED without re-posting
  const crashTask = makePrTask({
    loopId: 'rl-crash',
    reviewTriggers: [{
      idempotencyKey: 'rl-abc123',
      headSha: HEAD_A,
      status: 'PENDING',
      commentId: null,
      commentUrl: null,
      createdAt: '2026-11-18T00:00:00Z',
      postedAt: null,
      error: null,
    }],
  });
  await store.savePrTask('rl-crash', crashTask);
  let crashPostCalls = 0;
  const recovered = await triggerGeminiReview({
    loopId: 'rl-crash',
    prTask: crashTask,
    prState: { state: 'OPEN', headRefOid: HEAD_A },
    comments: [{
      id: 'gh-recovered',
      url: 'https://github.com/x/y/pull/51#issuecomment-999',
      body: `@gemini review\n${triggerMarker('rl-abc123')}`,
    }],
    store,
    postCommentFn: async () => {
      crashPostCalls += 1;
      return { commentId: 'dup' };
    },
  });
  assert.equal(recovered.posted, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.trigger.commentId, 'gh-recovered');
  assert.equal(crashPostCalls, 0);
});

test('assertPrActionAuthorized and recordPrFixRound enforce per-action permissions and 2-round shared boundary escalation', () => {
  const prTask = makePrTask({ permissions: { edit: true, commit: false, push: false, comment: false, autoWake: false } });
  const prState = { state: 'OPEN', headRefOid: HEAD_A };

  assert.equal(assertPrActionAuthorized({ action: 'edit', prTask, prState }), true);
  assert.throws(() => assertPrActionAuthorized({ action: 'push', prTask, prState }), /not authorized/);
  assert.throws(
    () => assertPrActionAuthorized({ action: 'edit', prTask, prState: { state: 'OPEN', headRefOid: HEAD_B } }),
    /HEAD drift/,
  );

  const r1 = recordPrFixRound({ prTask, boundaryKey: 'auth-session', introducedNewBlocker: true });
  assert.equal(r1.escalateHumanRequired, false);
  const r2 = recordPrFixRound({ prTask, boundaryKey: 'auth-session', introducedNewBlocker: true });
  assert.equal(r2.escalateHumanRequired, true);
  assert.equal(r2.reason, 'SHARED_BOUNDARY_REGRESSION');
  assert.equal(r2.requiresReadOnlyRootCauseAudit, true);
});

test('controller.review dispatches taskType=pr without calling LLM Reviewer or Supervisor', async () => {
  let reviewerCalls = 0;
  let botStatus = 'AUDIT_PENDING';
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: HEAD_A, dirtyFiles: [], evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: 'mechanical', commands: ['git diff --check'] }),
    reviewerFn: async () => {
      reviewerCalls += 1;
      throw new Error('LLM must not be called for taskType=pr');
    },
    fetchPrSnapshotFn: async () => ({
      prState: { state: 'OPEN', headRefOid: HEAD_A, baseRefName: 'main', headRefName: 'feat/pr-task' },
      comments: [{
        id: 'bot-1',
        author: { login: 'claude-review-bot[bot]' },
        body: `<!-- jiaze-review-session:v1 {"status":"${botStatus}","lastReviewedHead":"${HEAD_A}"} -->`,
      }],
    }),
  });

  const begun = await ctl.begin({
    goal: 'Handle PR #51',
    cwd: '/repo',
    taskType: 'pr',
    prContext: {
      repoFullName: 'Jiaze-Li/reviewloop',
      prNumber: 51,
      baseBranch: 'main',
      headBranch: 'feat/pr-task',
      boundHeadSha: HEAD_A,
    },
  });

  const waiting = await ctl.review({ loopId: begun.loopId });
  assert.equal(waiting.status, 'WAITING_FOR_REVIEW');
  assert.equal(reviewerCalls, 0);

  botStatus = 'READY';
  const passed = await ctl.review({ loopId: begun.loopId });
  assert.equal(passed.status, 'PASS');
  assert.equal(passed.terminal, true);
  assert.equal(reviewerCalls, 0);
});
