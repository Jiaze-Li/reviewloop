// Unified Design review: the complete design file (reviewTarget) is reviewed on
// the SAME engine as Code, PASS is bound to the exact reviewed content, and
// pre-existing (legacy) Design loops keep their historical route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { createReviewObjective, usesSupervisorPoolForReview, assertObjectiveNotWeakened } from '../src/reviewloop/objective.js';
import {
  designContentSha256, normalizeReviewTargetPath, readReviewTarget, assertReviewTargetAbsent,
  assertTargetWithinOneChunk, DESIGN_TARGET_MAX_BYTES, DesignTargetError,
} from '../src/reviewloop/designTarget.js';
import { createProductionReviewLoopProviders } from '../src/reviewloop/providerWiring.js';
import { buildResumePrompt } from '../src/reviewloop/resumeGuide.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const PLAN = '# Plan\n- Goal: ship a thing\n- Non-goals: nothing else';
const DESIGN = '# Design\n\n## Options\n- A: reuse\n\n## Assumptions\nNone\n\n## Work Contract\nDo X.\n';
const sha = (v) => createHash('sha256').update(v).digest('hex');

function tmpRepo() {
  return mkdtempSync(path.join(os.tmpdir(), 'rl-design-'));
}

const untrackedBlock = (rel, text) => `--- Worker untracked file ${rel} (${Buffer.byteLength(text)} bytes) ---\n${text}`;

// A scripted controller whose delta diff is rendered LIVE from the file on
// disk, exactly like gitEvidence does for a new untracked file.
function makeCtl({
  cwd, rel = 'Prompt.md', reviewerFn, routeReviewerFn, routeSupervisorFn, env, deltaFingerprint,
  extraDiff = '', readText,
} = {}) {
  const calls = { reviewer: 0, delta: 0 };
  const persistence = new MemoryPersistence();
  const ctl = createReviewLoopController({
    persistence,
    env: env ?? { ...process.env },
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      calls.delta += 1;
      let text = '';
      try { text = readText ? readText() : (await import('node:fs')).readFileSync(path.join(cwd, rel), 'utf8'); } catch { text = ''; }
      return {
        baselineHead: 'BASE',
        currentHead: 'BASE',
        evidenceComplete: true,
        noWorkerChangeYet: false,
        changedFiles: [rel],
        fingerprint: deltaFingerprint ? deltaFingerprint(calls.delta) : sha(`BASE\n${text}`),
        diff: `${extraDiff}${untrackedBlock(rel, text)}`,
      };
    },
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, fingerprint: 'GATE1', failureIdentities: [], results: [],
    }),
    discoverVerificationCommandsFn: ({ configured }) => ({
      source: 'configured', commands: configured ?? ['git diff --check'], manifestFingerprint: 'fp-1',
    }),
    reviewerFn: reviewerFn ?? (async () => {
      calls.reviewer += 1;
      return { value: { findings: [] }, usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-reviewer' };
    }),
    ...(routeReviewerFn ? { routeReviewerFn } : {}),
    ...(routeSupervisorFn ? { routeSupervisorFn } : {}),
  });
  return { ctl, calls, persistence };
}

const designBegin = (ctl, cwd, extra = {}) => ctl.begin({
  goal: 'Design the thing', cwd, taskType: 'design', contractText: PLAN, reviewTarget: 'Prompt.md', ...extra,
});

// ---------------------------------------------------------------- helpers

test('designContentSha256 hashes the whitespace-trimmed UTF-8 content', () => {
  assert.equal(designContentSha256('  abc\n\n'), sha('abc'));
  assert.equal(designContentSha256('abc'), designContentSha256('abc\n\n\n'));
  assert.notEqual(designContentSha256('abc'), designContentSha256('abd'));
  assert.equal(designContentSha256('中文 设计'), sha(Buffer.from('中文 设计', 'utf8')));
});

test('normalizeReviewTargetPath accepts one relative file and rejects traversal / absolute / directories', () => {
  assert.equal(normalizeReviewTargetPath('docs/Prompt.md'), 'docs/Prompt.md');
  assert.equal(normalizeReviewTargetPath('./docs//Prompt.md'), 'docs/Prompt.md');
  for (const bad of ['', '  ', '/etc/passwd', '../x.md', 'a/../../x.md', 'C:/x.md', 'a\\b.md', 'dir/', '.', '..', '.git/config', 'a/.git/x', 'a\0b']) {
    assert.throws(() => normalizeReviewTargetPath(bad), (e) => e instanceof DesignTargetError && e.code === 'DESIGN_TARGET_PATH_INVALID', `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeReviewTargetPath(null), DesignTargetError);
});

test('readReviewTarget reads the whole file and reports content, size and digest', async () => {
  const cwd = tmpRepo();
  writeFileSync(path.join(cwd, 'Prompt.md'), `${DESIGN}\n\n`);
  const t = await readReviewTarget({ cwd, reviewTarget: 'Prompt.md' });
  assert.equal(t.text, `${DESIGN}\n\n`);
  assert.equal(t.bytes, Buffer.byteLength(`${DESIGN}\n\n`));
  assert.equal(t.sha256, designContentSha256(DESIGN));
  rmSync(cwd, { recursive: true, force: true });
});

test('readReviewTarget fails closed: missing, directory, symlink, symlinked parent, non-UTF-8, oversized', async () => {
  const cwd = tmpRepo();
  const code = async (fn) => fn().then(() => null, (e) => e.code);
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'nope.md' })), 'DESIGN_TARGET_MISSING');

  mkdirSync(path.join(cwd, 'dir'));
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'dir' })), 'DESIGN_TARGET_NOT_FILE');

  writeFileSync(path.join(cwd, 'real.md'), 'x');
  symlinkSync(path.join(cwd, 'real.md'), path.join(cwd, 'link.md'));
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'link.md' })), 'DESIGN_TARGET_SYMLINK');

  const outside = tmpRepo();
  writeFileSync(path.join(outside, 'secret.md'), 'secret');
  symlinkSync(outside, path.join(cwd, 'escape'));
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'escape/secret.md' })), 'DESIGN_TARGET_SYMLINK');

  writeFileSync(path.join(cwd, 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]));
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'bin.md' })), 'DESIGN_TARGET_NOT_UTF8');

  writeFileSync(path.join(cwd, 'big.md'), 'a'.repeat(DESIGN_TARGET_MAX_BYTES + 1));
  assert.equal(await code(() => readReviewTarget({ cwd, reviewTarget: 'big.md' })), 'DESIGN_TARGET_TOO_LARGE');
  writeFileSync(path.join(cwd, 'edge.md'), 'a'.repeat(DESIGN_TARGET_MAX_BYTES));
  assert.equal((await readReviewTarget({ cwd, reviewTarget: 'edge.md' })).bytes, DESIGN_TARGET_MAX_BYTES);

  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('readReviewTarget keeps a leading BOM so the digest matches the evidence rendering', async () => {
  const cwd = tmpRepo();
  writeFileSync(path.join(cwd, 'Prompt.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]));
  const t = await readReviewTarget({ cwd, reviewTarget: 'Prompt.md' });
  assert.equal(t.text.charCodeAt(0), 0xfeff);
  rmSync(cwd, { recursive: true, force: true });
});

test('assertReviewTargetAbsent refuses an existing file, directory or symlink', async () => {
  const cwd = tmpRepo();
  assert.equal(await assertReviewTargetAbsent({ cwd, reviewTarget: 'Prompt.md' }), 'Prompt.md');
  writeFileSync(path.join(cwd, 'Prompt.md'), 'x');
  await assert.rejects(() => assertReviewTargetAbsent({ cwd, reviewTarget: 'Prompt.md' }), (e) => e.code === 'DESIGN_TARGET_EXISTS');
  symlinkSync(path.join(cwd, 'Prompt.md'), path.join(cwd, 'l.md'));
  await assert.rejects(() => assertReviewTargetAbsent({ cwd, reviewTarget: 'l.md' }), (e) => e.code === 'DESIGN_TARGET_SYMLINK');
  rmSync(cwd, { recursive: true, force: true });
});

test('assertTargetWithinOneChunk: whole file in one chunk passes; a file split across chunks is rejected', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i} of the design`).join('\n');
  const target = { path: 'Prompt.md', text, bytes: Buffer.byteLength(text) };
  const diff = untrackedBlock('Prompt.md', text);
  assert.equal(assertTargetWithinOneChunk({ diff, target, env: {} }), true);
  assert.throws(
    () => assertTargetWithinOneChunk({ diff, target, env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '200' } }),
    (e) => e instanceof DesignTargetError && e.code === 'DESIGN_TARGET_SPLIT',
  );
  assert.throws(
    () => assertTargetWithinOneChunk({ diff: 'diff --git a/other b/other\n+x', target, env: {} }),
    (e) => e.code === 'DESIGN_TARGET_SPLIT',
  );
});

test('assertTargetWithinOneChunk also recognises a committed (diff --git) new file', () => {
  const body = '+# Design\n+text';
  const diff = `diff --git a/Prompt.md b/Prompt.md\nnew file mode 100644\n--- /dev/null\n+++ b/Prompt.md\n@@ -0,0 +1,2 @@\n${body}\ndiff --git a/other.js b/other.js\n+x`;
  const target = { path: 'Prompt.md', text: '# Design\ntext', bytes: 12 };
  assert.equal(assertTargetWithinOneChunk({ diff, target, env: {} }), true);
});

// -------------------------------------------------------------- objective

test('objective: reviewTarget only for design, folded into the fingerprint only when present', () => {
  const base = {
    loopId: 'L', goal: 'g', repository: { root: '/r' }, mode: 'LOCAL', contractText: PLAN,
  };
  const legacy = createReviewObjective({ ...base, taskType: 'design' });
  const unified = createReviewObjective({ ...base, taskType: 'design', reviewTarget: 'Prompt.md' });
  assert.equal('reviewTarget' in legacy, false, 'legacy objectives must not gain a field');
  assert.equal(unified.reviewTarget, 'Prompt.md');
  assert.notEqual(legacy.fingerprint, unified.fingerprint);
  assert.throws(() => createReviewObjective({ ...base, taskType: 'code', reviewTarget: 'Prompt.md' }), /only valid for taskType "design"/);
  assert.throws(() => assertObjectiveNotWeakened(unified, { ...unified, reviewTarget: 'Other.md' }), /reviewTarget changed/);
  assert.throws(() => assertObjectiveNotWeakened(unified, { ...unified, reviewTarget: undefined }), /reviewTarget changed/);
  assert.equal(assertObjectiveNotWeakened(legacy, { ...legacy }), true);
});

test('usesSupervisorPoolForReview: only a legacy Design loop (no reviewTarget)', () => {
  assert.equal(usesSupervisorPoolForReview({ taskType: 'design' }), true);
  assert.equal(usesSupervisorPoolForReview({ taskType: 'design', reviewTarget: 'Prompt.md' }), false);
  assert.equal(usesSupervisorPoolForReview({ taskType: 'code' }), false);
  assert.equal(usesSupervisorPoolForReview(null), false);
});

// ------------------------------------------------------------------ begin

test('begin: design + reviewTarget freezes the target and reports it', async () => {
  const cwd = tmpRepo();
  const { ctl } = makeCtl({ cwd });
  const b = await designBegin(ctl, cwd);
  assert.equal(b.taskType, 'design');
  assert.equal(b.reviewTarget, 'Prompt.md');
  rmSync(cwd, { recursive: true, force: true });
});

test('begin: refuses an existing target, phases, missing Plan and non-design types', async () => {
  const cwd = tmpRepo();
  const { ctl } = makeCtl({ cwd });
  writeFileSync(path.join(cwd, 'Prompt.md'), 'already here');
  await assert.rejects(() => designBegin(ctl, cwd), /already exists/);
  rmSync(path.join(cwd, 'Prompt.md'));

  const phases = [{ id: 'p1', objective: 'o', exitCriteria: ['c'] }];
  await assert.rejects(
    () => designBegin(ctl, cwd, { phases, contractText: `${PLAN}\nPhase 1: o\nexit: c` }),
    /single whole-task gate/,
  );
  await assert.rejects(() => designBegin(ctl, cwd, { contractText: '' }), /requires the complete Plan/);
  await assert.rejects(
    () => ctl.begin({ goal: 'g', cwd, taskType: 'code', contractText: PLAN, reviewTarget: 'Prompt.md' }),
    /only valid with taskType "design"/,
  );
  await assert.rejects(() => designBegin(ctl, cwd, { reviewTarget: '../escape.md' }), /inside the repository/);
  rmSync(cwd, { recursive: true, force: true });
});

test('begin: a design loop WITHOUT reviewTarget behaves exactly as before (legacy)', async () => {
  const cwd = tmpRepo();
  const { ctl } = makeCtl({ cwd });
  const b = await ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: PLAN });
  assert.equal(b.taskType, 'design');
  assert.equal('reviewTarget' in b, false);
  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------------------- review path

test('review: Reviewer gets the whole design file; PASS returns and persists designSha256', async () => {
  const cwd = tmpRepo();
  const seen = [];
  const { ctl, persistence, calls } = makeCtl({
    cwd,
    reviewerFn: async (args) => {
      seen.push(args.diff ?? args.delta?.diff ?? '');
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
  });
  const b = await designBegin(ctl, cwd);
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);

  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(r.designSha256, designContentSha256(DESIGN));
  assert.equal(r.reviewTarget, 'Prompt.md');
  assert.equal(calls.delta >= 2, true, 'delta is re-collected after the Reviewer');
  assert.ok(seen.join('\n').includes(DESIGN.trim()), 'the Reviewer request carries the complete design text');

  const persisted = (await persistence.readWorkflowState(b.loopId)).reviewLoop;
  assert.equal(persisted.designReview.designSha256, designContentSha256(DESIGN));
  // A later read of the terminal PASS still returns the approved digest.
  const again = await ctl.review({ loopId: b.loopId });
  assert.equal(again.status, 'PASS');
  assert.equal(again.terminal, true);
  assert.equal(again.designSha256, designContentSha256(DESIGN));
  rmSync(cwd, { recursive: true, force: true });
});

test('review: missing design file => REWORK with a clear reason and ZERO Reviewer calls', async () => {
  const cwd = tmpRepo();
  const { ctl, calls } = makeCtl({ cwd, readText: () => 'something else' });
  const b = await designBegin(ctl, cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.match(r.reason, /design review target \(Prompt\.md\).*does not exist/);
  assert.equal(calls.reviewer, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test('review: a design file split across Reviewer chunks => REWORK, ZERO Reviewer calls, never PASS', async () => {
  const cwd = tmpRepo();
  const { ctl, calls } = makeCtl({ cwd, env: { ...process.env, REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '200' } });
  const b = await designBegin(ctl, cwd);
  writeFileSync(path.join(cwd, 'Prompt.md'), Array.from({ length: 60 }, (_, i) => `design line ${i}`).join('\n'));
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.match(r.reason, /not inside a single Reviewer request/);
  assert.equal(calls.reviewer, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test('review: design file edited WHILE the Reviewer runs => no PASS even if the Reviewer says CLEAN', async () => {
  const cwd = tmpRepo();
  const file = path.join(cwd, 'Prompt.md');
  const { ctl } = makeCtl({
    cwd,
    reviewerFn: async () => {
      writeFileSync(file, `${DESIGN}\nSneaky late edit\n`);
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
  });
  const b = await designBegin(ctl, cwd);
  writeFileSync(file, DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.match(r.reason, /design file changed while the Reviewer was running/);
  assert.equal(r.designSha256, undefined);
  rmSync(cwd, { recursive: true, force: true });
});

test('review: Worker delta changing while the Reviewer runs (file unchanged) => no PASS', async () => {
  const cwd = tmpRepo();
  const file = path.join(cwd, 'Prompt.md');
  let n = 0;
  const { ctl } = makeCtl({ cwd, deltaFingerprint: () => { n += 1; return n <= 1 ? 'F-before' : 'F-after'; } });
  const b = await designBegin(ctl, cwd);
  writeFileSync(file, DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.match(r.reason, /git delta\) changed while the Reviewer was running/);
  rmSync(cwd, { recursive: true, force: true });
});

test('review: a design file deleted while the Reviewer runs => no PASS', async () => {
  const cwd = tmpRepo();
  const file = path.join(cwd, 'Prompt.md');
  const { ctl } = makeCtl({
    cwd,
    reviewerFn: async () => {
      rmSync(file);
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
  });
  const b = await designBegin(ctl, cwd);
  writeFileSync(file, DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.match(r.reason, /could not be re-verified/);
  rmSync(cwd, { recursive: true, force: true });
});

test('review: blocking finding => REWORK; fixing the file and re-reviewing in the SAME loop passes with the NEW digest', async () => {
  const cwd = tmpRepo();
  const file = path.join(cwd, 'Prompt.md');
  let round = 0;
  const { ctl } = makeCtl({
    cwd,
    reviewerFn: async () => {
      round += 1;
      return {
        value: { findings: round === 1 ? [{ severity: 'P2', file: 'Prompt.md', line: 1, title: 'violates: missing AC; cost: rework' }] : [] },
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'm',
      };
    },
  });
  const b = await designBegin(ctl, cwd);
  writeFileSync(file, DESIGN);
  const r1 = await ctl.review({ loopId: b.loopId });
  assert.equal(r1.status, 'REWORK');
  const fixed = `${DESIGN}\n## AC\n- observable\n`;
  writeFileSync(file, fixed);
  const r2 = await ctl.review({ loopId: b.loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(r2.loopId, b.loopId);
  assert.equal(r2.designSha256, designContentSha256(fixed));
  assert.notEqual(r2.designSha256, designContentSha256(DESIGN));
  rmSync(cwd, { recursive: true, force: true });
});

// ----------------------------------------------------------------- routing

function routingCtl({ cwd, routedRoles }) {
  const providers = createProductionReviewLoopProviders({
    callAgy: async (opts) => ({
      model: opts?.model ?? 'm', exitCode: 0, text: '{"findings":[]}', usage: { input_tokens: 20, output_tokens: 5 },
    }),
  });
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      let text = '';
      try { text = (await import('node:fs')).readFileSync(path.join(cwd, 'Prompt.md'), 'utf8'); } catch { text = ''; }
      return {
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['Prompt.md'], fingerprint: sha(text || 'none'), diff: untrackedBlock('Prompt.md', text),
      };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['git diff --check'], manifestFingerprint: 'fp' }),
    routeReviewerFn: (s, c) => { routedRoles.push('reviewer'); return providers.routeReviewerFn(s, c); },
    routeSupervisorFn: (s, c) => { routedRoles.push('supervisor'); return providers.routeSupervisorFn(s, c); },
    reviewerFn: providers.reviewerFn,
    supervisorFn: providers.supervisorFn,
  });
}

test('routing: a NEW Design loop (reviewTarget) routes its ordinary review through the REVIEWER pool', async () => {
  const cwd = tmpRepo();
  const routedRoles = [];
  const ctl = routingCtl({ cwd, routedRoles });
  const b = await designBegin(ctl, cwd);
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(routedRoles, ['reviewer'], 'actual route selection, not the ledger role label');
  assert.equal(r.telemetry.reviewerCalls, 1);
  assert.equal(r.telemetry.supervisorCalls, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test('routing: a legacy Design loop (no reviewTarget) keeps the historical Supervisor-pool route', async () => {
  const cwd = tmpRepo();
  const routedRoles = [];
  const ctl = routingCtl({ cwd, routedRoles });
  const b = await ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: PLAN });
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(routedRoles, ['supervisor']);
  assert.equal(r.designSha256, undefined, 'legacy Design loops do not gain a digest');
  rmSync(cwd, { recursive: true, force: true });
});

test('routing: Code loops still route through the Reviewer pool (unchanged)', async () => {
  const cwd = tmpRepo();
  const routedRoles = [];
  const ctl = routingCtl({ cwd, routedRoles });
  const b = await ctl.begin({ goal: 'g', cwd, taskType: 'code', contractText: PLAN });
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(routedRoles, ['reviewer']);
  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------- Code begin: designSha256

test('code begin: designSha256 must match the whitespace-trimmed contractText content', async () => {
  const cwd = tmpRepo();
  const { ctl } = makeCtl({ cwd });
  const digest = designContentSha256(DESIGN);

  const ok = await ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: DESIGN, designSha256: digest });
  assert.equal(ok.taskType, 'code');

  // trailing / leading whitespace does not change the trimmed content
  await ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: `\n\n${DESIGN}\n\n`, designSha256: digest.toUpperCase() });

  await assert.rejects(
    () => ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: `${DESIGN}\nOne more requirement`, designSha256: digest }),
    /does not match the approved Design/,
  );
  await assert.rejects(
    () => ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: DESIGN.replace('Do X', 'Do Y'), designSha256: digest }),
    /does not match the approved Design/,
  );
  await assert.rejects(
    () => ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: DESIGN, designSha256: 'abc' }),
    /64 hexadecimal/,
  );
  await assert.rejects(
    () => ctl.begin({ goal: 'implement', cwd, taskType: 'code', designSha256: digest }),
    /does not match|requires/,
  );
  await assert.rejects(
    () => ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: PLAN, designSha256: digest }),
    /only valid with taskType "code"/,
  );
  rmSync(cwd, { recursive: true, force: true });
});

test('code begin: without designSha256 behaviour is unchanged', async () => {
  const cwd = tmpRepo();
  const { ctl } = makeCtl({ cwd });
  const b = await ctl.begin({ goal: 'implement', cwd, taskType: 'code', contractText: DESIGN });
  assert.equal(b.taskType, 'code');
  assert.equal('reviewTarget' in b, false);
  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------------------ resume / handoff

test('resume prompt carries the frozen reviewTarget and the approved digest', async () => {
  const objective = createReviewObjective({
    loopId: 'L', goal: 'g', repository: { root: '/r' }, mode: 'LOCAL', taskType: 'design', contractText: PLAN, reviewTarget: 'Prompt.md',
  });
  const loop = { loopId: 'L', state: 'PASS', objective, designReview: { designSha256: 'a'.repeat(64), reviewTarget: 'Prompt.md' } };
  const text = buildResumePrompt(loop);
  assert.match(text, /design review target: Prompt\.md/);
  assert.match(text, new RegExp(`approved designSha256: ${'a'.repeat(64)}`));
});
