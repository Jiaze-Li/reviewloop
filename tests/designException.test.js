// RL-HUMAN-AUTHORITY-20261120: human-authorized Design-review exception.
// Synthetic #66-type scenario (Design loop stopped at HUMAN_REQUIRED by the
// review-tool source limit) + every refusal path. Zero model calls: there is
// no provider in any of these paths; fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Persistence } from '../src/orchestrator/persistence.js';
import {
  grantDesignException, revokeDesignException, validateExternalReviewReport,
} from '../src/reviewloop/designException.js';
import {
  DESIGN_EXCEPTION_KEY, DESIGN_SOURCE_LIMIT_REASON, EXTERNAL_REVIEW_SCHEMA, evaluateDesignException,
} from '../src/reviewloop/designExceptionState.js';
import {
  contractContentSha256, findLocalDesignExceptionAnchor, findLocalDesignPassAnchor, formatContractComments,
  recoverPrContract, upsertContractIndex, verifyDesignArchiveAndCleanupReady,
} from '../src/reviewloop/prContract.js';
import { buildHumanRequiredReport } from '../src/reviewloop/humanRequiredReport.js';
import { withInProcessLoopLock } from '../src/reviewloop/loopLease.js';

const CLI = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
const REPO = 'Jiaze-Li/reviewloop';
const PR = 67;
const TASK = 'RL-TEST-EXC';
const VERSION = 'v1.0';
const LOOP = 'rl-20261120000000-design01';
const PLAN = '# Plan\n\nAC-01 something observable.\n';
const DESIGN = '# Design\n\n## Options\nA\n\n## Assumptions\nNone\n\n## Work Contract\nDo X\n';
const PLAN_SHA = contractContentSha256(PLAN);
const DESIGN_SHA = contractContentSha256(DESIGN);
const DESIGN_FILE = 'Design.RL-TEST-EXC.md';
const T0 = '2026-11-20T01:00:00.000Z';
const NOW = () => new Date('2026-11-20T03:00:00.000Z');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function initRepo() {
  const dir = tmp('rl-exc-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(dir, DESIGN_FILE), DESIGN);
  return dir;
}

function designLoop(repoRoot, over = {}) {
  return {
    loopId: LOOP, state: 'HUMAN_REQUIRED', round: 2, updatedAt: T0,
    objective: { mode: 'LOCAL', taskType: 'design', reviewTarget: DESIGN_FILE, contractText: PLAN, repository: { root: repoRoot } },
    history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: DESIGN_SOURCE_LIMIT_REASON, round: 2, at: T0 }],
    ...over,
  };
}

function reportJson(over = {}) {
  return JSON.stringify({
    schema: EXTERNAL_REVIEW_SCHEMA,
    planSha256: PLAN_SHA,
    designSha256: DESIGN_SHA,
    reviewer: 'isolated read-only Claude context (no shared conversation with the Worker)',
    rounds: [{ round: 1, verdict: 'NO_BLOCKING', designSha256: DESIGN_SHA }],
    verdict: 'NO_BLOCKING',
    openFindings: [{ severity: 'P3', title: 'nit' }],
    verifiedSources: [{ path: 'src/x.js', lines: '1-20', commit: 'a'.repeat(40) }],
    unverifiedRisks: [],
    testsNotRun: ['npm test'],
    ...over,
  }, null, 2);
}

async function setup({ loopOver = {}, workflowExtra = {} } = {}) {
  const repoDir = initRepo();
  const runtimeDir = tmp('rl-exc-runtime-');
  const persistence = new Persistence(runtimeDir);
  await persistence.writeWorkflowState(LOOP, { reviewLoop: designLoop(repoDir, loopOver), ...workflowExtra });
  return { repoDir, runtimeDir, persistence };
}

const grantArgs = (persistence, over = {}) => ({
  persistence, loopId: LOOP, repo: REPO, prNumber: PR, taskId: TASK, designVersion: VERSION,
  designSha256: DESIGN_SHA, reportText: reportJson(), reason: 'review tool cannot read the large source files', now: NOW, env: {},
  ...over,
});

// Builds the PR world (stub gh) holding Plan, Design (exception-labelled) and the exception record.
function prWorld({ archiveText, planText = PLAN, designText = DESIGN, includeException = true, exceptionVersion = VERSION, repo = REPO, pr = PR }) {
  const plan = formatContractComments({ taskId: TASK, type: 'plan', version: VERSION, content: planText });
  const design = formatContractComments({ taskId: TASK, type: 'design', version: VERSION, content: designText, humanException: true });
  const comments = { 1001: plan.comments[0].body, 1002: design.comments[0].body };
  let body = upsertContractIndex('', { taskId: TASK, type: 'plan', version: VERSION, commentIds: ['1001'], sha256: plan.sha256, totalParts: 1 });
  body = upsertContractIndex(body, { taskId: TASK, type: 'design', version: VERSION, commentIds: ['1002'], sha256: design.sha256, totalParts: 1 });
  if (includeException) {
    const exc = formatContractComments({ taskId: TASK, type: 'exception', version: exceptionVersion, content: archiveText });
    comments[1003] = exc.comments[0].body;
    body = upsertContractIndex(body, { taskId: TASK, type: 'exception', version: exceptionVersion, commentIds: ['1003'], sha256: exc.sha256, totalParts: 1 });
  }
  const calls = { gh: 0 };
  const runGh = async (args) => {
    calls.gh += 1;
    if (args[0] === 'pr') return JSON.stringify({ body, headRefOid: 'b'.repeat(40) });
    if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
    const id = args[1].split('/').pop();
    return JSON.stringify({ id: Number(id), node_id: `N${id}`, issue_url: `https://api.github.com/repos/${repo}/issues/${pr}`, user: { login: repo.split('/')[0] }, body: comments[id] });
  };
  return { runGh, calls, design };
}

// ---- positive: synthetic #66 scenario end to end (AC-02, AC-04) ---------------

test('#66-type scenario: grant -> archive -> verify-archive --clean succeeds as HUMAN_EXCEPTION; the loop stays HUMAN_REQUIRED and is never a PASS', async () => {
  const { repoDir, runtimeDir, persistence } = await setup();
  const before = await persistence.readWorkflowState(LOOP);
  const res = await grantDesignException(grantArgs(persistence));

  const after = await persistence.readWorkflowState(LOOP);
  assert.deepEqual(after.reviewLoop, before.reviewLoop, 'I1: the original loop object is byte-for-byte unchanged');
  assert.equal(after.reviewLoop.state, 'HUMAN_REQUIRED');
  assert.equal(after[DESIGN_EXCEPTION_KEY].active.id, res.active.id);
  assert.equal(after[DESIGN_EXCEPTION_KEY].active.loopAnchor.category, 'DESIGN_SOURCE_LIMIT');
  assert.equal(res.active.archiveSha256, contractContentSha256(res.archiveText));
  assert.match(res.archiveText, /非 ReviewLoop PASS/);
  assert.doesNotMatch(res.archiveText, new RegExp(repoDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no local paths in the PR archive');

  // I2: the PASS lookup never sees an exception.
  assert.equal(await findLocalDesignPassAnchor({ runtimeDir, designSha256: DESIGN_SHA }), null);
  assert.equal((await findLocalDesignExceptionAnchor({ runtimeDir, designSha256: DESIGN_SHA })).id, res.active.id);

  const { runGh, design } = prWorld({ archiveText: res.archiveText });
  assert.match(design.comments[0].body, /designSha256 \(human exception, not ReviewLoop PASS\): /);
  assert.doesNotMatch(design.comments[0].body, /^designSha256: /m, 'never the PASS trailer');
  assert.match(design.comments[0].body, /审查来源：人工授权例外（非 ReviewLoop PASS）/);
  // AC-04: the normal recovery protocol (author + index + hash) accepts the archive.
  const recovered = await recoverPrContract({ repo: REPO, prNumber: PR, taskId: TASK, type: 'design', runGh });
  assert.equal(recovered.sha256, DESIGN_SHA);

  const ok = await verifyDesignArchiveAndCleanupReady({ cwd: repoDir, repo: REPO, prNumber: PR, taskId: TASK, runtimeDir, runGh, clean: true });
  assert.equal(ok.authority, 'HUMAN_EXCEPTION');
  assert.equal(ok.exceptionId, res.active.id);
  assert.equal(ok.cleaned, true);
  assert.equal(fs.existsSync(path.join(repoDir, DESIGN_FILE)), false);
  assert.equal((await persistence.readWorkflowState(LOOP)).reviewLoop.state, 'HUMAN_REQUIRED');
});

test('a real Design PASS is still found first and reported as REVIEWLOOP_PASS (AC-01, I5)', async () => {
  const { repoDir, runtimeDir } = await setup();
  const passId = 'rl-20261120000001-pass';
  fs.mkdirSync(path.join(runtimeDir, passId));
  fs.writeFileSync(path.join(runtimeDir, passId, 'workflow.json'), JSON.stringify({
    reviewLoop: { state: 'PASS', designReview: { reviewTarget: DESIGN_FILE, designSha256: DESIGN_SHA, round: 1 } },
  }));
  const { runGh } = prWorld({ archiveText: 'unused', includeException: false });
  const res = await verifyDesignArchiveAndCleanupReady({ cwd: repoDir, repo: REPO, prNumber: PR, taskId: TASK, runtimeDir, runGh });
  assert.equal(res.authority, 'REVIEWLOOP_PASS');
  assert.equal(res.loopId, passId);
  assert.equal(res.exceptionId, undefined);
});

test('no PASS and no exception: verify-archive still refuses (AC-01)', async () => {
  const { repoDir, runtimeDir } = await setup();
  const { runGh } = prWorld({ archiveText: 'unused', includeException: false });
  await assert.rejects(
    () => verifyDesignArchiveAndCleanupReady({ cwd: repoDir, repo: REPO, prNumber: PR, taskId: TASK, runtimeDir, runGh, clean: true }),
    (e) => e.code === 'PR_CONTRACT_NO_DESIGN_PASS',
  );
  assert.ok(fs.existsSync(path.join(repoDir, DESIGN_FILE)));
});

// ---- refusals at grant time: nothing written (AC-03, AC-05, AC-06, I4) --------

async function assertGrantRefused(persistence, over, pattern) {
  const frozen = JSON.stringify(await persistence.readWorkflowState(LOOP));
  await assert.rejects(() => grantDesignException(grantArgs(persistence, over)), pattern);
  assert.equal(JSON.stringify(await persistence.readWorkflowState(LOOP)), frozen, 'a refusal writes nothing');
}

test('grant refuses bad bindings: changed design, wrong hash, report for another design/plan, missing/invalid report (AC-03)', async () => {
  const { repoDir, persistence } = await setup();
  await assertGrantRefused(persistence, { designSha256: 'f'.repeat(64) }, /not the --design-sha you approved/);
  await assertGrantRefused(persistence, { reportText: reportJson({ designSha256: 'e'.repeat(64) }) }, /reviewed design .* not the current design/);
  await assertGrantRefused(persistence, { reportText: reportJson({ planSha256: 'd'.repeat(64) }) }, /made for Plan/);
  await assertGrantRefused(persistence, { reportText: '' }, /external review report/);
  await assertGrantRefused(persistence, { reportText: '{not json' }, /not valid JSON/);
  await assertGrantRefused(persistence, { reportText: reportJson({ schema: 'other' }) }, /must declare "schema"/);
  await assertGrantRefused(persistence, { reportText: reportJson({ rounds: [] }) }, /at least one review round/);
  await assertGrantRefused(persistence, { reportText: reportJson({ reviewer: '' }) }, /name the reviewer/);
  await assertGrantRefused(persistence, { reason: ' ' }, /explicit --reason/);
  await assertGrantRefused(persistence, { repo: 'noslash' }, /owner\/name/);
  await assertGrantRefused(persistence, { prNumber: 'x' }, /PR number/);
  // Changing the design by ONE byte after the external review voids it.
  fs.appendFileSync(path.join(repoDir, DESIGN_FILE), 'x');
  await assertGrantRefused(persistence, {}, /hashes to .* not the --design-sha/);
});

test('blocking external findings are kept, never accepted; unverified risks need a separate explicit acceptance (AC-06)', async () => {
  const { persistence } = await setup();
  await assertGrantRefused(persistence, { reportText: reportJson({ verdict: 'BLOCKING' }) }, /only "NO_BLOCKING"/);
  await assertGrantRefused(persistence, { reportText: reportJson({ openFindings: [{ severity: 'P2', title: 'real gap' }] }) }, /open P1\/P2/);
  await assertGrantRefused(persistence, { reportText: reportJson({ openFindings: [{ severity: 'p1', title: 'x' }] }) }, /open P1\/P2/);
  const risky = reportJson({ unverifiedRisks: ['bin/reviewloop.js lease use not re-read'] });
  await assertGrantRefused(persistence, { reportText: risky }, /--accept-risk/);
  const res = await grantDesignException(grantArgs(persistence, { reportText: risky, acceptRisk: 'I accept the unverified lease detail' }));
  assert.equal(res.active.acceptedRisk, 'I accept the unverified lease detail');
  assert.equal(res.active.reportSummary.verdict, 'NO_BLOCKING');
  assert.match(res.archiveText, /acceptedRisk: I accept the unverified lease detail/);
});

test('only review-TOOL stops are eligible; other stops and still-active blockers are refused (AC-03, AC-05)', async () => {
  const cases = [
    ['token sentinel', { history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['unaccounted spend', { history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'model spend blocked: MODEL_SPEND_USAGE_UNRESOLVED', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['call ceiling', { history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'model spend blocked: SPEND_DENIED (ReviewLoop reviewer call ceiling (2) reached)', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['design rounds', { budgetExhausted: true, history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'design review round budget (3) is spent', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['supervisor needs human', { history: [{ from: 'SUPERVISING', to: 'HUMAN_REQUIRED', reason: 'the adjudicator needs a decision', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['unknown reason', { history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'zzz', round: 2, at: T0 }] }, {}, /not a review-tool failure/],
    ['tool stop but sentinel still tripped', {}, { reviewLoopTokenAnomaly: { tripped: true, at: T0 } }, /not a review-tool failure|still in force/],
    ['tool stop but call ceiling reached', {}, { reviewLoopSpend: { records: [{ role: 'reviewer' }, { role: 'reviewer' }] }, reviewLoopCallAllowance: { maxReviewerCalls: 2 } }, /still in force \(CALL_CEILING/],
  ];
  for (const [name, loopOver, workflowExtra, pattern] of cases) {
    const { persistence } = await setup({ loopOver, workflowExtra });
    await assertGrantRefused(persistence, {}, pattern).catch((e) => { throw new Error(`${name}: ${e.message}`); });
  }
});

test('wrong state or wrong loop type is refused (AC-03)', async () => {
  for (const [loopOver, pattern] of [
    [{ state: 'PASS' }, /loop is PASS/],
    [{ state: 'REWORK' }, /loop is REWORK/],
    [{ state: 'STOPPED', humanStop: { priorState: 'REWORK', round: 2 } }, /loop is STOPPED/],
    [{ objective: { mode: 'LOCAL', taskType: 'code', contractText: PLAN, repository: { root: '/x' } } }, /only to a Design loop with a reviewTarget/],
  ]) {
    const { persistence } = await setup({ loopOver });
    await assertGrantRefused(persistence, {}, pattern);
  }
  const { persistence } = await setup();
  await assert.rejects(() => grantDesignException(grantArgs(persistence, { loopId: 'rl-nope' })), /unknown loopId/);
});

// ---- replay / scope / staleness at verify time (AC-03, AC-07) -----------------

test('verify-archive refuses a replayed or stale exception: wrong PR, task, version, plan, archive; loop moved on', async () => {
  const { repoDir, runtimeDir, persistence } = await setup();
  const res = await grantDesignException(grantArgs(persistence));
  const verify = (runGh, over = {}) => verifyDesignArchiveAndCleanupReady({
    cwd: repoDir, repo: REPO, prNumber: PR, taskId: TASK, runtimeDir, runGh, clean: true, ...over,
  });
  const good = prWorld({ archiveText: res.archiveText });

  // The same design archived consistently in ANOTHER PR / repo: the grant does not travel.
  const pr68 = prWorld({ archiveText: res.archiveText, pr: 68 });
  await assert.rejects(() => verify(pr68.runGh, { prNumber: 68 }), (e) => e.code === 'PR_CONTRACT_EXCEPTION_SCOPE_MISMATCH');
  const otherRepo = prWorld({ archiveText: res.archiveText, repo: 'someone/else' });
  await assert.rejects(() => verify(otherRepo.runGh, { repo: 'someone/else' }), (e) => e.code === 'PR_CONTRACT_EXCEPTION_SCOPE_MISMATCH');

  // Another task id in the same PR index with the same design content.
  const otherTask = prWorld({ archiveText: res.archiveText });
  await assert.rejects(() => verify(otherTask.runGh, { taskId: 'RL-OTHER' }), (e) => /PR_CONTRACT_(NOT_FOUND|EXCEPTION_SCOPE_MISMATCH)/.test(e.code));

  // Plan in the PR differs from the Plan the exception was granted for.
  const otherPlan = prWorld({ archiveText: res.archiveText, planText: `${PLAN}\nAC-02 extra` });
  await assert.rejects(() => verify(otherPlan.runGh), (e) => e.code === 'PR_CONTRACT_EXCEPTION_PLAN_MISMATCH');

  // Exception record missing from the PR, or tampered.
  await assert.rejects(() => verify(prWorld({ archiveText: res.archiveText, includeException: false }).runGh), (e) => e.code === 'PR_CONTRACT_NOT_FOUND');
  await assert.rejects(() => verify(prWorld({ archiveText: `${res.archiveText}\n- tampered: yes` }).runGh), (e) => e.code === 'PR_CONTRACT_EXCEPTION_ARCHIVE_MISMATCH');

  // Archived design version differs from the one the human approved.
  const v11 = prWorld({ archiveText: res.archiveText, exceptionVersion: 'v1.1' });
  await assert.rejects(() => verify(v11.runGh), (e) => e.code === 'PR_CONTRACT_VERSION_CONFLICT');

  // Local design file drift after the grant.
  fs.appendFileSync(path.join(repoDir, DESIGN_FILE), 'drift');
  await assert.rejects(() => verify(good.runGh), (e) => e.code === 'PR_CONTRACT_LOCAL_DRIFT');
  fs.writeFileSync(path.join(repoDir, DESIGN_FILE), DESIGN);

  // The loop went back to review: the exception is void.
  const wf = await persistence.readWorkflowState(LOOP);
  await persistence.writeWorkflowState(LOOP, { ...wf, reviewLoop: { ...wf.reviewLoop, state: 'REWORK', round: 3 } });
  await assert.rejects(() => verify(good.runGh), (e) => e.code === 'PR_CONTRACT_NO_DESIGN_PASS');
  assert.ok(fs.existsSync(path.join(repoDir, DESIGN_FILE)), 'nothing was cleaned on any refusal');
});

test('validity rule: same HUMAN_REQUIRED round or a human stop of it; anything else is void (5.4)', () => {
  const active = {
    id: 'dx-1', at: T0, repo: REPO, taskId: TASK, designVersion: VERSION, loopId: LOOP, reviewTarget: DESIGN_FILE, reason: 'r',
    planSha256: PLAN_SHA, designSha256: DESIGN_SHA, reportSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), prNumber: PR,
    loopAnchor: { state: 'HUMAN_REQUIRED', round: 2 },
  };
  const wf = (loop, a = active) => ({ reviewLoop: { loopId: LOOP, ...loop }, [DESIGN_EXCEPTION_KEY]: { active: a } });
  assert.equal(evaluateDesignException(wf({ state: 'HUMAN_REQUIRED', round: 2 })).valid, true);
  assert.equal(evaluateDesignException(wf({ state: 'STOPPED', round: 2, humanStop: { priorState: 'HUMAN_REQUIRED', round: 2 } })).valid, true);
  assert.equal(evaluateDesignException(wf({ state: 'HUMAN_REQUIRED', round: 3 })).valid, false);
  assert.equal(evaluateDesignException(wf({ state: 'PASS', round: 2 })).valid, false);
  assert.equal(evaluateDesignException(wf({ state: 'STOPPED', round: 2, humanStop: { priorState: 'REWORK', round: 2 } })).valid, false);
  assert.equal(evaluateDesignException(wf({ state: 'HUMAN_REQUIRED', round: 2 }, { ...active, archiveSha256: 'short' })).status, 'INVALID');
  assert.equal(evaluateDesignException({ reviewLoop: { state: 'HUMAN_REQUIRED' } }).status, 'NONE');
});

// ---- one active grant, revoke, restart, concurrency (AC-07) --------------------

test('re-grant supersedes (never two active), revoke voids, and a fresh process reads the same record', async () => {
  const { runtimeDir, persistence } = await setup();
  const first = await grantDesignException(grantArgs(persistence));
  const second = await grantDesignException(grantArgs(persistence, { now: () => new Date('2026-11-20T04:00:00.000Z'), reason: 'second external round' }));
  let rec = (await new Persistence(runtimeDir).readWorkflowState(LOOP))[DESIGN_EXCEPTION_KEY];
  assert.equal(rec.active.id, second.active.id);
  assert.equal(second.superseded, first.active.id);
  assert.deepEqual(rec.history.map((h) => [h.id, h.status]), [[first.active.id, 'superseded']]);

  await revokeDesignException({ persistence, loopId: LOOP, reason: 'changed my mind', now: NOW });
  rec = (await new Persistence(runtimeDir).readWorkflowState(LOOP))[DESIGN_EXCEPTION_KEY];
  assert.equal(rec.active, null);
  assert.equal(rec.history.at(-1).status, 'revoked');
  assert.equal(await findLocalDesignExceptionAnchor({ runtimeDir, designSha256: DESIGN_SHA }), null);
  await assert.rejects(() => revokeDesignException({ persistence, loopId: LOOP, reason: 'again', now: NOW }), /no active Design exception/);
  await assert.rejects(() => revokeDesignException({ persistence, loopId: LOOP, reason: ' ' }), /explicit --reason/);
});

test('a concurrent change to the loop between read and write refuses the grant and writes nothing', async () => {
  const { persistence } = await setup();
  const original = persistence.readWorkflowState.bind(persistence);
  let reads = 0;
  persistence.readWorkflowState = async (id) => {
    reads += 1;
    const wf = await original(id);
    // The guarded re-read (2nd read) sees a workflow another writer changed.
    if (reads === 2) return { ...wf, reviewLoopSpend: { records: [{ role: 'reviewer' }] } };
    return wf;
  };
  const frozen = JSON.stringify(await original(LOOP));
  await assert.rejects(() => grantDesignException(grantArgs(persistence)), /concurrent modification/);
  assert.equal(JSON.stringify(await original(LOOP)), frozen);
});

test('the grant is serialized on the per-loop lock with other human actions', async () => {
  const { persistence } = await setup();
  let released;
  const held = withInProcessLoopLock(LOOP, () => new Promise((r) => { released = r; }));
  let done = false;
  const p = grantDesignException(grantArgs(persistence)).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, 'waits for the lock');
  released();
  await held;
  await p;
  assert.equal(done, true);
});

// ---- report (AC-09) and CLI surface (CLI-only, never MCP) ---------------------

test('report: the tool-limit stop offers exception / fix-then-re-review / terminate; a valid exception is shown as NOT a PASS', async () => {
  const { persistence } = await setup();
  let wf = await persistence.readWorkflowState(LOOP);
  let r = buildHumanRequiredReport({ loopId: LOOP, loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.equal(r.category, 'DESIGN_SOURCE_LIMIT');
  assert.equal(r.humanDecision.choices.length, 3);
  assert.match(r.humanDecision.choices[0], /人工授权例外，不是 ReviewLoop 审查通过/);
  assert.match(r.humanDecision.choices[1], /修复审查工具/);
  assert.match(r.humanDecision.command, /^reviewloop accept-design-exception --loop /);
  assert.match(r.humanDecision.terminate, /reviewloop stop-loop/);

  await grantDesignException(grantArgs(persistence));
  wf = await persistence.readWorkflowState(LOOP);
  r = buildHumanRequiredReport({ loopId: LOOP, loop: wf.reviewLoop, workflow: wf, env: {} });
  assert.ok(r.causes.confirmed.some((c) => /已由人工授权例外.*不是 ReviewLoop 审查通过/.test(c)));
  assert.equal(r.status.state, 'HUMAN_REQUIRED');
  assert.doesNotMatch(r.reportText, /审查已通过|Design PASS 已/);
});

test('report: REVIEW_FAILED on a new Design loop also offers the exception; a code loop does not', () => {
  const base = (taskType) => ({
    loopId: 'rl-y', state: 'HUMAN_REQUIRED', round: 1,
    objective: { mode: 'LOCAL', taskType, ...(taskType === 'design' ? { reviewTarget: 'D.md' } : {}) },
    history: [{ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason: 'review failed: provider timeout', round: 1, at: T0 }],
  });
  const d = buildHumanRequiredReport({ loopId: 'rl-y', loop: base('design'), workflow: { reviewLoop: base('design') }, env: {} });
  assert.ok(d.humanDecision.choices.some((c) => /人工授权例外/.test(c)));
  assert.ok(d.fixOptions.some((f) => /accept-design-exception/.test(f)));
  const c = buildHumanRequiredReport({ loopId: 'rl-y', loop: base('code'), workflow: { reviewLoop: base('code') }, env: {} });
  assert.ok(!c.humanDecision.choices.some((x) => /人工授权例外/.test(x)));
});

test('the exception is a CLI human command only; the Worker MCP surface does not expose it', () => {
  const mcp = fs.readFileSync(fileURLToPath(new URL('../src/mcp/reviewloopMcpServer.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(mcp, /design-exception|DesignException|accept-design/i);
  const usage = spawnSync(process.execPath, [CLI, 'accept-design-exception'], { encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /usage: reviewloop accept-design-exception/);
});

test('CLI end to end: grant through the real command writes the record and the archive file; the loop stays HUMAN_REQUIRED', async () => {
  const { runtimeDir } = await setup();
  const dir = tmp('rl-exc-cli-');
  const reportPath = path.join(dir, 'report.json');
  const archivePath = path.join(dir, 'archive.md');
  fs.writeFileSync(reportPath, reportJson());
  const out = spawnSync(process.execPath, [CLI, 'accept-design-exception', '--loop', LOOP, '--repo', REPO, '--pr', String(PR),
    '--task-id', TASK, '--design-version', VERSION, '--design-sha', DESIGN_SHA, '--review-report', reportPath,
    '--reason', 'tool cannot read large files', '--archive-out', archivePath], {
    encoding: 'utf8', env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: runtimeDir },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /NOT a ReviewLoop Design PASS/);
  const wf = JSON.parse(fs.readFileSync(path.join(runtimeDir, LOOP, 'workflow.json'), 'utf8'));
  assert.equal(wf.reviewLoop.state, 'HUMAN_REQUIRED');
  assert.equal(contractContentSha256(fs.readFileSync(archivePath, 'utf8')), wf[DESIGN_EXCEPTION_KEY].active.archiveSha256);
});

test('validateExternalReviewReport is pure and bound to exact hashes', () => {
  const s = validateExternalReviewReport(reportJson(), { planSha256: PLAN_SHA, designSha256: DESIGN_SHA });
  assert.equal(s.verdict, 'NO_BLOCKING');
  assert.equal(s.openFindings, 1);
  assert.throws(() => validateExternalReviewReport(reportJson({ openFindings: 'none' }), { planSha256: PLAN_SHA, designSha256: DESIGN_SHA }), /"openFindings" as a list/);
});

// ---- PR #67 F001: the archive text is never lost -------------------------------

function cliGrant(runtimeDir, archivePath) {
  const dir = tmp('rl-exc-cli2-');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(reportPath, reportJson());
  return spawnSync(process.execPath, [CLI, 'accept-design-exception', '--loop', LOOP, '--repo', REPO, '--pr', String(PR),
    '--task-id', TASK, '--design-version', VERSION, '--design-sha', DESIGN_SHA, '--review-report', reportPath,
    '--reason', 'tool cannot read large files', '--archive-out', archivePath], {
    encoding: 'utf8', env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: runtimeDir },
  });
}

test('F001: an unwritable --archive-out refuses BEFORE anything is recorded', async () => {
  const { runtimeDir } = await setup();
  const frozen = fs.readFileSync(path.join(runtimeDir, LOOP, 'workflow.json'), 'utf8');
  const out = cliGrant(runtimeDir, path.join(tmp('rl-exc-x-'), 'no-such-dir', 'archive.md'));
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /cannot be written .*nothing was recorded/);
  assert.equal(fs.readFileSync(path.join(runtimeDir, LOOP, 'workflow.json'), 'utf8'), frozen, 'no exception was recorded');
});

test('F001: if the archive write still fails after the grant, the full archive text is printed and the command exits non-zero', async () => {
  const { runtimeDir } = await setup();
  // A dangling symlink passes the preflight (its directory is writable) but the write fails.
  const dir = tmp('rl-exc-y-');
  const archivePath = path.join(dir, 'archive.md');
  fs.symlinkSync(path.join(dir, 'missing-dir', 'target.md'), archivePath);
  const out = cliGrant(runtimeDir, archivePath);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /the exception IS recorded, but writing the archive file/);
  const wf = JSON.parse(fs.readFileSync(path.join(runtimeDir, LOOP, 'workflow.json'), 'utf8'));
  const active = wf[DESIGN_EXCEPTION_KEY].active;
  const printed = out.stdout.split('--- archive record (save it to a file to archive) ---\n')[1];
  assert.ok(printed, 'archive record printed');
  assert.equal(contractContentSha256(printed), active.archiveSha256, 'the printed text is exactly the archived record');
  assert.equal(wf.reviewLoop.state, 'HUMAN_REQUIRED');
});
