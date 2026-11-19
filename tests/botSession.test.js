import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustedBotSession } from '../src/reviewloop/botSession.js';
const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

function encodeReviewStateComment(stateObj, visibleStatus = 'READY') {
  const b64 = Buffer.from(JSON.stringify(stateObj), 'utf8').toString('base64url');
  return ['<!-- jiaze-review-session:v1 -->', `Status: **${visibleStatus}**`, `<!-- jiaze-review-state:${b64} -->`].join('\n');
}

const BOT = { login: 'jiaze-claude-review-bot[bot]' };
const parse = (comment) => parseTrustedBotSession({ comments: [{ author: BOT, ...comment }] });

test('AC-01: parses the real base64url jiaze-review-state and fails closed on invalid state', () => {
  const ready = {
    version: 1, sessionId: 'claude-d33d63ef1f29', lastReviewedHead: HEAD_A, status: 'READY', auditCompleted: true,
    findings: [
      { id: 'F001', severity: 'P1', status: 'FIXED', title: 'Fixed P1' },
      { id: 'F002', severity: 'P3', status: 'OPEN', downgradedFrom: 'P2', title: 'Downgraded non-blocking P3' },
    ],
  };
  const ok = parse({ id: '1', body: encodeReviewStateComment(ready), updatedAt: '2026-11-18T05:17:37.343Z' });
  assert.equal(ok.sessionStatus, 'READY');
  assert.equal(ok.hasAuthoritativeState, true);
  assert.equal(ok.auditCompleted, true);
  assert.equal(ok.openFindings.length, 0, 'FIXED and downgraded P3 are not blocking');

  const rework = parse({ id: '2', body: encodeReviewStateComment({
    ...ready, status: 'REWORK', findings: [{ id: 'F003', severity: 'P3', status: 'OPEN', title: 'Blocking P3' }],
  }, 'REWORK') });
  assert.equal(rework.sessionStatus, 'REWORK');
  assert.equal(rework.openFindings.length, 1, 'a P3 without downgradedFrom still blocks');

  // Malformed state must fail closed even if the visible markdown says READY
  const malformed = parse({ id: 'bad', body: '<!-- jiaze-review-session:v1 -->\nStatus: **READY**\n<!-- jiaze-review-state:not_valid_base64_json -->' });
  assert.equal(malformed.parseable, false);
  assert.equal(malformed.sessionStatus, 'UNKNOWN');

  const incomplete = parse({ id: 'c', body: encodeReviewStateComment({ ...ready, auditCompleted: false }) });
  assert.equal(incomplete.auditCompleted, false);

  const staleMarked = parse({ id: 'd', body: encodeReviewStateComment({ ...ready, staleFor: HEAD_A }) });
  assert.equal(staleMarked.staleFor, HEAD_A);

  const oldHead = parse({ id: 'e', body: encodeReviewStateComment({
    ...ready, status: 'REWORK', lastReviewedHead: HEAD_B, findings: [{ id: 'F005', severity: 'P2', status: 'OPEN', title: 'x' }],
  }, 'REWORK') });
  assert.equal(oldHead.lastReviewedHead, HEAD_B);
  assert.equal(oldHead.openFindings.length, 1);

  // Untrusted author is ignored entirely
  const untrusted = parseTrustedBotSession({ comments: [{ author: { login: 'mallory' }, body: encodeReviewStateComment(ready) }] });
  assert.equal(untrusted.found, false);
  assert.equal(untrusted.sessionStatus, 'MISSING');
});

test('parseTrustedBotSession ignores null and non-object entries in findings array', () => {
  const payload = {
    version: 1,
    sessionId: 'claude-null-guard',
    lastReviewedHead: HEAD_A,
    status: 'REWORK',
    auditCompleted: true,
    findings: [null, 'bad-string', 42, ['nested'], { id: 'F010', severity: 'P2', status: 'OPEN', title: 'Valid finding' }],
  };
  const parsed = parse({ id: 'null-guard', body: encodeReviewStateComment(payload, 'REWORK') });
  assert.equal(parsed.parseable, true);
  assert.equal(parsed.sessionStatus, 'REWORK');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].id, 'F010');
  assert.equal(parsed.openFindings.length, 1);
});
