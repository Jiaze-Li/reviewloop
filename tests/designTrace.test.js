import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRACE_BLOCK_BEGIN,
  TRACE_BLOCK_END,
  analyzeComments,
  applyProgressBlock,
  compareVersions,
  formatDraft,
  formatReview,
  inspectTrace,
  renderProgressBlock,
  scanSensitive,
} from '../src/reviewloop/designTrace.js';
import {
  contractContentSha256,
  extractContractCommentPart,
  formatContractComments,
  parseContractIndex,
  upsertContractIndex,
} from '../src/reviewloop/prContract.js';
import { PrContractError } from '../src/reviewloop/prContract.js';

const TASK = 'T-TRACE';
const OWNER = 'octo';
const PLAN_SHA = 'a'.repeat(64);
const draftArgs = (content, version = 'v1.0', extra = {}) => ({
  taskId: TASK, version, content, policySha: 'reviewloop@abc', planVersion: 'v1.0', planSha256: PLAN_SHA, ...extra,
});
let nextId = 100;
const asComments = (formatted, { author = OWNER } = {}) => formatted.comments.map((c) => ({
  id: nextId += 1, user: { login: author }, body: c.body, created_at: 't', updated_at: 't',
}));
const analyze = (comments, extra = {}) => analyzeComments(comments, { taskId: TASK, owner: OWNER, ...extra });

test('draft round-trips: verified record equals local text and is marked UNREVIEWED', () => {
  const text = '# Design\n\nBody\n';
  const f = formatDraft(draftArgs(text));
  assert.equal(f.sha256, contractContentSha256(text));
  assert.match(f.comments[0].body, /UNREVIEWED · NOT DESIGN PASS/);
  const a = analyze(asComments(f), { localDraft: text });
  assert.equal(a.ok, true);
  assert.equal(a.localState, 'ARCHIVED');
  assert.equal(a.latestDraft.content, text.trim());
});

test('a changed local file is NOT_ARCHIVED, not silently the old version', () => {
  const a = analyze(asComments(formatDraft(draftArgs('v1 text'))), { localDraft: 'v1 text changed' });
  assert.equal(a.localState, 'NOT_ARCHIVED');
});

test('draft and review comments are invisible to the formal contract recovery tools', () => {
  const f = formatDraft(draftArgs('# Design\nx'));
  for (const kind of ['plan', 'design', 'exception']) {
    assert.throws(() => extractContractCommentPart(f.comments[0].body, { taskId: TASK, type: kind }), PrContractError);
  }
  const r = formatReview({ taskId: TASK, designVersion: 'v1.0', result: { status: 'REWORK', loopId: 'rl-1', round: 1, adjudicatedDesignSha256: f.sha256, blockingFindings: [] } });
  assert.throws(() => extractContractCommentPart(r.comments[0].body, { taskId: TASK, type: 'design' }), PrContractError);
});

test('long drafts split into parts; a missing part is reported as partial, never guessed', () => {
  const text = `# D\n${'line of design text\n'.repeat(200)}`;
  const f = formatDraft(draftArgs(text, 'v1.0', { maxCharsPerPart: 1000 }));
  assert.ok(f.totalParts > 2);
  const all = asComments(f);
  assert.equal(analyze(all).ok, true);
  const partial = analyze(all.filter((_, i) => i !== 1));
  assert.equal(partial.ok, false);
  assert.equal(partial.problems[0].code, 'TRACE_PARTIAL');
  assert.deepEqual(partial.problems[0].missingParts, [2]);
  assert.equal(partial.latestDraft, null);
  // Safe top-up: only the missing part is re-formatted and now completes the record.
  const top = formatDraft(draftArgs(text, 'v1.0', { maxCharsPerPart: 1000, onlyParts: [2] }));
  assert.equal(top.comments.length, 1);
  assert.equal(analyze([...all.filter((_, i) => i !== 1), ...asComments(top)]).ok, true);
});

test('identical duplicate comments keep the lowest id as canonical; conflicting content fails closed', () => {
  const f = formatDraft(draftArgs('same text'));
  const first = asComments(f);
  const dup = asComments(f);
  const a = analyze([...dup, ...first]);
  assert.equal(a.ok, true);
  assert.equal(a.latestDraft.commentIds[0], String(first[0].id));
  assert.equal(a.latestDraft.duplicateCommentIds.length, 1);

  const other = formatDraft(draftArgs('different text'));
  const conflict = analyze([...first, ...asComments(other)]);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.problems[0].code, 'TRACE_CONFLICT');
  assert.equal(conflict.latestDraft, null);
});

test('wrong author, edited-body hash mismatch and malformed markers are rejected', () => {
  const f = formatDraft(draftArgs('text'));
  const stranger = analyze(asComments(f, { author: 'mallory' }));
  assert.equal(stranger.problems[0].code, 'TRACE_UNTRUSTED_AUTHOR');
  assert.equal(stranger.latestDraft, null);

  const tampered = asComments(f);
  tampered[0].body = tampered[0].body.replace('\ntext\n', '\ntext EDITED\n');
  const t = analyze(tampered);
  assert.equal(t.problems[0].code, 'TRACE_HASH_MISMATCH');
  assert.equal(t.latestDraft, null);

  const broken = asComments(f);
  broken[0].body = broken[0].body.replace(/<!-- reviewloop-draft:[^>]*:end -->/, '');
  assert.equal(analyze(broken).problems[0].code, 'TRACE_COMMENT_MALFORMED');
});

test('review records bind ONLY the tool-returned hash; no hash means explicitly unbound', () => {
  const d = formatDraft(draftArgs('design one'));
  const rework = formatReview({
    taskId: TASK, designVersion: 'v1.0',
    result: { status: 'REWORK', loopId: 'rl-1', round: 1, adjudicatedDesignSha256: d.sha256, blockingFindings: [{ severity: 'P1', title: 'Bad thing', detail: 'why' }] },
  });
  assert.match(rework.comments[0].body, /Bad thing/);
  const failed = formatReview({
    taskId: TASK, designVersion: 'v1.0', errorNote: 'input too large',
    result: { status: 'HUMAN_REQUIRED', loopId: 'rl-1', round: 2, reason: 'Supervisor input too large' },
  });
  assert.match(failed.comments[0].body, /未绑定任何设计版本/);
  assert.doesNotMatch(failed.comments[0].body, /返回 PASS|· PASS/);
  const none = formatReview({ taskId: TASK, designVersion: 'v1.0', round: 3, errorNote: 'tool crashed' });
  assert.match(none.comments[0].body, /NO_RESULT/);

  const a = analyze([...asComments(d), ...asComments(rework), ...asComments(failed, {}), ...asComments(none)]);
  assert.equal(a.ok, true);
  const metas = a.records.filter((r) => r.kind === 'review').map((r) => r.meta);
  assert.equal(metas.filter((m) => m.adjudicatedDesignSha256).length, 1);
  assert.equal(metas.find((m) => m.status === 'HUMAN_REQUIRED').source, 'REVIEWLOOP_NO_ADJUDICATION');
});

test('a PASS record carries the tool designSha256 but still says it is not an authorization', () => {
  const d = formatDraft(draftArgs('pass me'));
  const pass = formatReview({ taskId: TASK, designVersion: 'v1.0', result: { status: 'PASS', loopId: 'rl-2', round: 2, designSha256: d.sha256, blockingFindings: [] } });
  assert.match(pass.comments[0].body, /本记录不是授权/);
  const a = analyze([...asComments(d), ...asComments(pass)]);
  const rec = a.records.find((r) => r.kind === 'review');
  assert.equal(rec.meta.adjudicatedDesignSha256, d.sha256);
});

test('revision keeps v1.0 and its review; the old verdict is shown as expired for v1.1', () => {
  const d1 = formatDraft(draftArgs('first design'));
  const d2 = formatDraft(draftArgs('second design', 'v1.1', { changeNote: 'fix P1', findingResponses: ['P1 Bad thing: fixed'] }));
  const rev = formatReview({ taskId: TASK, designVersion: 'v1.0', result: { status: 'REWORK', loopId: 'rl-1', round: 1, adjudicatedDesignSha256: d1.sha256, blockingFindings: [{ severity: 'P1', title: 'Bad thing' }] } });
  const a = analyze([...asComments(d1), ...asComments(rev), ...asComments(d2)]);
  assert.equal(a.latestDraft.version, 'v1.1');
  const block = renderProgressBlock(a, { repo: 'o/r', prNumber: 1, taskId: TASK });
  assert.match(block, /已过期（当前为 v1.1）/);
  assert.match(block, /\| 草稿 \| v1\.0 /);
  assert.match(block, /\| 草稿 \| v1\.1 .*current/);
  assert.match(block, /Code 授权 \| 未授权/);
  assert.match(d2.comments[0].body, /Worker 声明，未经审查确认/);
});

test('external report is labelled as relayed, unverified independence, and never authorizes', () => {
  const ext = formatReview({
    taskId: TASK, designVersion: 'v1.0',
    external: { reviewer: 'Other model', independence: '独立上下文', conclusion: 'NO_BLOCKING', relayedBy: 'owner', seq: 1, report: 'looks fine' },
  });
  const body = ext.comments[0].body;
  assert.match(body, /系统未验证/);
  assert.match(body, /不构成 Design PASS、人工例外或 Code 授权/);
  const a = analyze(asComments(ext));
  const block = renderProgressBlock({ ...a, contractRows: [] }, { repo: 'o/r', prNumber: 1, taskId: TASK });
  assert.match(block, /EXTERNAL_REPORT · NO_BLOCKING/);
  assert.match(block, /Code 授权 \| 未授权/);
  assert.doesNotMatch(block, /DESIGN_ARCHIVED_PASS|已通过/);
});

test('formal Design / exception rows are reported but never VERIFIED by the trace', () => {
  const rows = parseContractIndex(upsertContractIndex('Brief', { taskId: TASK, type: 'design', version: 'v1.1', sha256: 'b'.repeat(64), commentIds: ['9'], totalParts: 1 }));
  const block = renderProgressBlock({ ...analyze([]), contractRows: rows }, { repo: 'o/r', prNumber: 1, taskId: TASK });
  assert.match(block, /NOT_VERIFIED/);
});

test('progress block touches only its own region and leaves the contract index parseable', () => {
  const base = upsertContractIndex('## Brief\nkeep me', { taskId: TASK, type: 'plan', version: 'v1.0', sha256: PLAN_SHA, commentIds: ['7'], totalParts: 1 });
  const block = renderProgressBlock({ ...analyze([]), contractRows: parseContractIndex(base) }, { repo: 'o/r', prNumber: 1, taskId: TASK });
  const once = applyProgressBlock(base, block);
  assert.ok(once.includes('keep me'));
  assert.deepEqual(parseContractIndex(once), parseContractIndex(base));
  // Re-applying replaces in place (idempotent) and a later contract upsert keeps the block.
  assert.equal(applyProgressBlock(once, block), once);
  const upserted = upsertContractIndex(once, { taskId: TASK, type: 'design', version: 'v1.0', sha256: 'c'.repeat(64), commentIds: ['8'], totalParts: 1 });
  assert.ok(upserted.includes(TRACE_BLOCK_BEGIN) && upserted.includes(TRACE_BLOCK_END));
  assert.equal(parseContractIndex(upserted).length, 2);
  assert.throws(() => applyProgressBlock(`x\n${TRACE_BLOCK_BEGIN}\ny`, block), (e) => e.code === 'TRACE_BLOCK_CORRUPT');
});

test('sensitive content is refused with no bypass', () => {
  assert.ok(scanSensitive('token = ghp_abcdefghijklmnopqrstuvwxyz0123').length);
  assert.ok(scanSensitive('see /Users/alice/project/x').length);
  assert.ok(scanSensitive('mail bob@example.com').length);
  assert.equal(scanSensitive('plain design text, src/reviewloop/x.js:12').length, 0);
  assert.throws(() => formatDraft(draftArgs('has /Users/alice/secret.txt inside')), (e) => e.code === 'TRACE_SENSITIVE_CONTENT');
  assert.throws(() => formatReview({ taskId: TASK, designVersion: 'v1.0', result: { status: 'HUMAN_REQUIRED', reason: 'key AKIAABCDEFGHIJKLMNOP' } }), (e) => e.code === 'TRACE_SENSITIVE_CONTENT');
});

test('version ordering is numeric', () => {
  assert.ok(compareVersions('v1.10', 'v1.9') > 0);
  assert.ok(compareVersions('v2', 'v1.9') > 0);
});

test('inspectTrace recovers purely from PR comments after a failed description write (injected gh)', async () => {
  const d1 = formatDraft(draftArgs('persisted design'));
  const comments = asComments(d1);
  const calls = [];
  const runGh = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api') return JSON.stringify([comments]);
    return JSON.stringify({ body: '## Brief', headRefOid: 'f'.repeat(40) });
  };
  const res = await inspectTrace({ repo: `${OWNER}/r`, prNumber: 5, taskId: TASK, localDraft: 'persisted design', runGh });
  assert.equal(res.ok, true);
  assert.equal(res.localState, 'ARCHIVED');
  assert.ok(calls.some((c) => c.includes('--paginate')));
  const body = applyProgressBlock(res.prBody, renderProgressBlock(res, { repo: `${OWNER}/r`, prNumber: 5, taskId: TASK }));
  assert.ok(body.includes('当前草稿'));
  assert.ok(calls.every((c) => !/POST|--method|edit|comment /i.test(c)), 'inspect never writes');
});

test('reviewloop trace prepare CLI writes comment files, refuses sensitive text, never posts', async () => {
  const { execFile } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'reviewloop.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-trace-cli-'));
  const good = path.join(dir, 'design.md');
  fs.writeFileSync(good, '# Design\nok\n');
  const base = ['prepare', '--kind', 'draft', '--task-id', TASK, '--version', 'v1.0', '--policy-sha', 'reviewloop@x',
    '--plan-version', 'v1.0', '--plan-sha', PLAN_SHA, '--out-dir', path.join(dir, 'out'), '--json'];
  const { stdout } = await run('node', [cli, 'trace', ...base, '--file', good]);
  const out = JSON.parse(stdout);
  assert.equal(out.sha256, contractContentSha256('# Design\nok\n'));
  assert.equal(out.files.length, 1);
  assert.match(fs.readFileSync(out.files[0], 'utf8'), /UNREVIEWED · NOT DESIGN PASS/);
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(bad, 'see /Users/alice/x');
  await assert.rejects(run('node', [cli, 'trace', ...base, '--file', bad]), (e) => /possible sensitive content/.test(e.stderr));
});
