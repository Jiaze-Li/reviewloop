// Two-stage Design review: Reviewer independent proposal + Supervisor adjudication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  buildFileRequestPrompt, validateAdjudication, validateProposals, validateFileRequest, decideDesignTransition, finalizePassComment,
  collectDesignContext, collectCodeIdentity, parseGitStatusDirtyPaths, validateFactFileRequest,
  readRequestedFiles, DESIGN_LIMITS, buildProposalPrompt, buildAdjudicationPrompt,
} from '../src/reviewloop/designTwoStage.js';
import { designContentSha256, readRepoFileBytesBounded, splitSourceLines } from '../src/reviewloop/designTarget.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const PLAN = '# Plan\n- Goal: ship a thing\n- Non-goals: nothing else';
const DESIGN = '# Design\n\nSECRET-DESIGN-MARKER\n\n## Options\n- A: reuse\n\n## Assumptions\nNone\n';
const sha = (v) => designContentSha256(v);

const adj = (over = {}) => ({
  comparison: { verdict: 'ALIGNED', reason: 'same', workerSummary: 'worker approach', planConcern: null, ...(over.comparison ?? {}) },
  blockingFindings: over.blockingFindings ?? [],
  nonBlockingFindings: over.nonBlockingFindings ?? [],
  humanQuestions: over.humanQuestions ?? [],
  designPassComment: 'designPassComment' in over ? over.designPassComment : 'Builds the thing.',
  ...('factChecks' in over ? { factChecks: over.factChecks } : {}),
});
const PROPOSALS = { proposals: [{ title: 'Reuse', summary: 'reuse engine', tradeoffs: 'rigid' }], confidenceNote: '' };

function gitRepo() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rl-2stage-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@e.x'); g('config', 'user.name', 't');
  writeFileSync(path.join(cwd, 'README.md'), 'README-CONTENT');
  writeFileSync(path.join(cwd, 'package.json'), '{"name":"x"}');
  g('add', '.'); g('commit', '-qm', 'init');
  return cwd;
}

function makeCtl({ cwd, fakes = {}, deltaFp, inputBudget = null }) {
  const log = { reviewer: [], supervisor: [] };
  let n = 0;
  const persistence = new MemoryPersistence();
  const ctl = createReviewLoopController({
    persistence,
    ...(inputBudget ? { designInputBudgetFn: async () => inputBudget } : {}),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      let text = '';
      try { text = (await import('node:fs')).readFileSync(path.join(cwd, 'Prompt.md'), 'utf8'); } catch { text = ''; }
      n += 1;
      return {
        baselineHead: 'B', currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['Prompt.md'],
        fingerprint: deltaFp ? deltaFp(n) : sha(text || 'none'),
        diff: `--- Worker untracked file Prompt.md (${Buffer.byteLength(text)} bytes) ---\n${text}`,
      };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['true'], manifestFingerprint: 'f' }),
    designReviewerFn: async (a) => {
      log.reviewer.push(a);
      if (fakes.reviewer) return fakes.reviewer(a, log);
      return { value: a.stage === 'files' ? { requestedFiles: [] } : PROPOSALS, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
    designSupervisorFn: async (a) => {
      log.supervisor.push(a);
      const v = fakes.supervisor ? fakes.supervisor(log.supervisor.length, a) : adj();
      return { value: v, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
    reviewerFn: async () => { throw new Error('single-pass reviewer must not run for two-stage design'); },
  });
  return { ctl, log, persistence };
}
const begin = (ctl, cwd) => ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: PLAN, reviewTarget: 'Prompt.md' });
const writeDesign = (cwd, text = DESIGN) => writeFileSync(path.join(cwd, 'Prompt.md'), text);

// ------------------------------------------------------------------ pure

test('validateAdjudication fails closed on every malformed shape', () => {
  assert.equal(validateAdjudication(null).malformed, true);
  assert.equal(validateAdjudication({}).malformed, true);
  assert.equal(validateAdjudication(adj({ comparison: { verdict: 'MAYBE' } })).malformed, true);
  assert.equal(validateAdjudication({ ...adj(), blockingFindings: 'x' }).malformed, true);
  assert.equal(validateAdjudication(adj({ blockingFindings: [{ severity: 'P3', title: 't' }] })).malformed, true);
  assert.equal(validateAdjudication(adj({ comparison: { verdict: 'NEEDS_HUMAN' } })).malformed, true, 'NEEDS_HUMAN needs questions');
  assert.equal(validateAdjudication(adj({ comparison: { reason: '' } })).malformed, true);
  assert.equal(validateAdjudication(adj()).malformed, undefined);
});

test('validateProposals / validateFileRequest bound their output', () => {
  assert.equal(validateProposals({ proposals: [] }).malformed, true);
  const three = { proposals: [1, 2, 3].map((i) => ({ title: `t${i}`, summary: 's', tradeoffs: 'c' })) };
  assert.equal(validateProposals(three).malformed, true);
  assert.equal(validateProposals({ proposals: [{ title: 't', summary: 's' }] }).malformed, true);
  assert.equal(validateFileRequest({ requestedFiles: [1] }).malformed, true);
  assert.equal(validateFileRequest({ requestedFiles: Array(40).fill('a') }).requestedFiles.length, DESIGN_LIMITS.maxRequestedFiles);
});

test('decideDesignTransition: full table incl. exchange bound', () => {
  const t = (over, ex = 0) => decideDesignTransition({ adjudication: validateAdjudication(adj(over)), exchangeCount: ex });
  assert.equal(t({ comparison: { verdict: 'NEEDS_HUMAN' }, humanQuestions: ['q'] }).kind, 'HUMAN');
  assert.equal(t({ comparison: { verdict: 'ALIGNED' }, blockingFindings: [{ severity: 'P2', title: 'x' }] }).kind, 'REWORK_DEFECTS');
  assert.equal(t({ comparison: { verdict: 'MAJOR_DIFF' }, blockingFindings: [{ severity: 'P1', title: 'x' }] }, 2).kind, 'REWORK_DEFECTS');
  assert.deepEqual(t({ comparison: { verdict: 'MAJOR_DIFF' } }, 0), { kind: 'EXCHANGE', exchangeCount: 1 });
  assert.deepEqual(t({ comparison: { verdict: 'MAJOR_DIFF' } }, 1), { kind: 'EXCHANGE', exchangeCount: 2 });
  assert.equal(t({ comparison: { verdict: 'MAJOR_DIFF' } }, 2).kind, 'HUMAN');
  assert.equal(t({}).kind, 'PASS');
  assert.equal(t({ comparison: { verdict: 'MINOR_DIFF' } }).kind, 'PASS');
  assert.equal(t({ designPassComment: null }).kind, 'FAILED');
});

test('finalizePassComment replaces any model-written digest line', () => {
  const out = finalizePassComment('Hello\ndesignSha256: deadbeef\nbye', 'a'.repeat(64));
  assert.equal(out, `Hello\nbye\n\ndesignSha256: ${'a'.repeat(64)}`);
});

test('readRequestedFiles: only tracked files; design file, traversal, untracked, symlink and caps rejected', async () => {
  const cwd = gitRepo();
  writeDesign(cwd);
  writeFileSync(path.join(cwd, 'scratch.txt'), 'untracked');
  symlinkSync('/etc/hosts', path.join(cwd, 'link'));
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  assert.ok(!context.tree.includes('Prompt.md'));
  const r = await readRequestedFiles({
    cwd, context, requested: ['README.md', 'Prompt.md', '../x', 'scratch.txt', 'link', 'missing.md'],
  });
  assert.deepEqual(r.files.map((f) => f.path), ['README.md']);
  assert.equal(r.rejected.length, 4, 'the design file is dropped silently, never echoed');
  rmSync(cwd, { recursive: true, force: true });
});

// ----------------------------------------------------------- controller

test('I1: Round-1 Reviewer prompts never contain the design, even when it requests the design file; tracked files are proxied', async () => {
  const cwd = gitRepo();
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      reviewer: (a) => ({
        value: a.stage === 'files' ? { requestedFiles: ['Prompt.md', 'README.md'] } : PROPOSALS,
        usage: { input_tokens: 1, output_tokens: 1 }, model: 'm',
      }),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  const all = log.reviewer.map((a) => a.prompt).join('\n');
  assert.ok(!all.includes('SECRET-DESIGN-MARKER'));
  assert.ok(!all.includes('Prompt.md'), 'neither content nor path of the design file');
  assert.ok(log.reviewer[1].prompt.includes('README-CONTENT'), 'requested tracked file is supplied');
  assert.ok(log.reviewer[1].prompt.includes('PLAN (the user'));
  rmSync(cwd, { recursive: true, force: true });
});

test('MAJOR_DIFF: two exchanges (Worker gets proposals, Reviewer gets a summary only), third => terminal HUMAN_REQUIRED', async () => {
  const cwd = gitRepo();
  const { ctl, log } = makeCtl({ cwd, fakes: { supervisor: () => adj({ comparison: { verdict: 'MAJOR_DIFF', workerSummary: 'WORKER-SUMMARY' } }) } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r1 = await ctl.review({ loopId: b.loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.exchangeCount, 1);
  assert.equal(r1.reviewerProposals[0].title, 'Reuse');
  // The Worker may defend an unchanged design: no NO_PROGRESS stall, exchange is bounded instead.
  const r2 = await ctl.review({ loopId: b.loopId });
  assert.equal(r2.status, 'REWORK');
  assert.equal(r2.exchangeCount, 2);
  const exchangePrompt = log.reviewer.at(-1).prompt;
  assert.ok(exchangePrompt.includes('WORKER-SUMMARY'));
  assert.ok(!exchangePrompt.includes('SECRET-DESIGN-MARKER'));
  const r3 = await ctl.review({ loopId: b.loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.equal(r3.terminal, true);
  assert.match(r3.reason, /after 2 exchanges/);
  const r4 = await ctl.review({ loopId: b.loopId });
  assert.equal(r4.status, 'HUMAN_REQUIRED');
  assert.equal(log.supervisor.length, 3, 'no model call after the budget is spent');
  rmSync(cwd, { recursive: true, force: true });
});

test('blocking defects => REWORK without consuming the exchange budget; planConcern is surfaced', async () => {
  const cwd = gitRepo();
  const { ctl } = makeCtl({
    cwd,
    fakes: {
      supervisor: (n) => (n === 1
        ? adj({ comparison: { verdict: 'MAJOR_DIFF' }, blockingFindings: [{ severity: 'P2', title: 'missing AC' }], designPassComment: null })
        : adj({ comparison: { planConcern: 'Plan itself may be wrong' } })),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r1 = await ctl.review({ loopId: b.loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.exchangeCount, undefined);
  assert.equal(r1.blockingFindings[0].title, 'missing AC');
  writeDesign(cwd, `${DESIGN}\n## AC\n- ok\n`);
  const r2 = await ctl.review({ loopId: b.loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(r2.planConcern, 'Plan itself may be wrong');
  rmSync(cwd, { recursive: true, force: true });
});

test('NEEDS_HUMAN in round 1 => resumable HUMAN_REQUIRED with questions', async () => {
  const cwd = gitRepo();
  const { ctl } = makeCtl({ cwd, fakes: { supervisor: () => adj({ comparison: { verdict: 'NEEDS_HUMAN' }, humanQuestions: ['Which user group?'], designPassComment: null }) } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.deepEqual(r.humanQuestions, ['Which user group?']);
  assert.notEqual(r.terminal, true);
  rmSync(cwd, { recursive: true, force: true });
});

test('I2: invalid/unusable Reviewer or Supervisor output, or a missing PASS comment, never PASSes', async () => {
  const cases = {
    supervisorGarbage: { supervisor: () => ({ nonsense: true }) },
    supervisorMalformedMarker: { supervisor: () => ({ malformed: true, reason: 'x' }) },
    noComment: { supervisor: () => adj({ designPassComment: null }) },
    reviewerGarbage: { reviewer: () => ({ value: { proposals: 'no' }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }) },
    reviewerNoFileShape: { reviewer: () => ({ value: { malformed: true }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }) },
  };
  for (const [name, fakes] of Object.entries(cases)) {
    const cwd = gitRepo();
    const { ctl } = makeCtl({ cwd, fakes });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED', name);
    assert.equal(r.designSha256, undefined, name);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('P1: an unusable Design reply persists an ENGINE stop cause that text cannot change', async () => {
  const cwd = gitRepo();
  const { ctl, persistence } = makeCtl({ cwd, fakes: { supervisor: () => ({ malformed: true, reason: 'the Supervisor says UNRESOLVED token anomaly' }) } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  const loop = (await persistence.readWorkflowState(b.loopId)).reviewLoop;
  const last = [...loop.history].reverse().find((h) => h.to === 'HUMAN_REQUIRED');
  assert.equal(last.cause.kind, 'REVIEW_TOOL_FAILED');
  assert.equal(last.cause.source, 'ENGINE');
  rmSync(cwd, { recursive: true, force: true });
});

test('I2: a provider throw fails closed (never PASS)', async () => {
  const cwd = gitRepo();
  const { ctl } = makeCtl({ cwd, fakes: { supervisor: () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' }); } } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.notEqual(r.status, 'PASS');
  rmSync(cwd, { recursive: true, force: true });
});

test('I3/I5: code and legacy design never use the two-stage transports; two-stage round makes at most 3 calls', async () => {
  const cwd = gitRepo();
  let twoStageCalls = 0;
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'B', currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a'], fingerprint: 'F', diff: 'diff --git a/a b/a\n+x\n',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['true'], manifestFingerprint: 'f' }),
    designReviewerFn: async () => { twoStageCalls += 1; throw new Error('must not run'); },
    designSupervisorFn: async () => { twoStageCalls += 1; throw new Error('must not run'); },
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  const code = await ctl.begin({ goal: 'g', cwd, taskType: 'code' });
  assert.equal((await ctl.review({ loopId: code.loopId })).status, 'PASS');
  const legacy = await ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: PLAN });
  assert.equal((await ctl.review({ loopId: legacy.loopId })).status, 'PASS');
  assert.equal(twoStageCalls, 0);

  const { ctl: ctl2, log } = makeCtl({ cwd });
  const b = await begin(ctl2, cwd);
  writeDesign(cwd);
  const r = await ctl2.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.ok(log.reviewer.length <= 2 && log.supervisor.length === 1);
  assert.match(r.statusLine, /^\[ReviewLoop \| design \| 第 1 轮 → PASS\]/);
  rmSync(cwd, { recursive: true, force: true });
});

test('stage heartbeats are emitted in order for a two-stage round', async () => {
  const cwd = gitRepo();
  const { ctl } = makeCtl({ cwd });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const beats = [];
  await ctl.review({ loopId: b.loopId, onHeartbeat: async (m) => { beats.push(m); } });
  const stages = beats.map((m) => m.replace('ReviewLoop stage: ', ''));
  assert.deepEqual(stages.filter((s) => ['gate_running', 'collecting_context', 'reviewer_proposing', 'supervisor_adjudicating'].includes(s)),
    ['gate_running', 'collecting_context', 'reviewer_proposing', 'supervisor_adjudicating']);
  rmSync(cwd, { recursive: true, force: true });
});

test('file-request prompt says oversize files are unavailable (not truncated) and the proposal prompt reports them', async () => {
  const cwd = gitRepo();
  writeFileSync(path.join(cwd, 'big.txt'), 'x'.repeat(DESIGN_LIMITS.maxFileBytes + 1));
  execFileSync('git', ['add', 'big.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'big'], { cwd });
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const prompt = buildFileRequestPrompt({ plan: PLAN, context, workerSummary: null });
  assert.match(prompt, /unavailable, not truncated/);
  assert.doesNotMatch(prompt, /is truncated to/);
  const r = await readRequestedFiles({ cwd, context, requested: ['big.txt'] });
  assert.equal(r.files.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.path), ['big.txt']);
  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------- malformed-output retry

const OK_USAGE = { input_tokens: 1, output_tokens: 1 };

test('prompts state field rules and carry a concrete example JSON', () => {
  const ctx = { tree: [], treeOmitted: 0, architecture: null, packageJson: null };
  const f = buildFileRequestPrompt({ plan: PLAN, context: ctx, workerSummary: null });
  const p = buildProposalPrompt({ plan: PLAN, context: ctx, files: [], rejected: [], workerSummary: null });
  const a = buildAdjudicationPrompt({ plan: PLAN, proposals: PROPOSALS.proposals, designText: DESIGN, history: [], exchangeCount: 0 });
  for (const [name, prompt] of Object.entries({ f, p, a })) {
    assert.match(prompt, /ONE JSON object and nothing else/, name);
    const ex = prompt.split('\n').find((l) => l.startsWith('Example: '));
    assert.ok(ex, `${name} has an example`);
    assert.doesNotThrow(() => JSON.parse(ex.slice('Example: '.length)), name);
    assert.ok(!ex.includes('P1|P2'), name);
  }
  assert.match(p, /title, summary and tradeoffs/);
  assert.match(a, /MUST be non-empty when verdict is NEEDS_HUMAN/);
  assert.match(a, /severity exactly "P1" or "P2"/);
  assert.match(a, /non-empty strings/);
  assert.match(a, /omit routine technical premises/);
  assert.doesNotMatch(a, /the Assumptions to confirm/);
});

test('one malformed Reviewer proposal output is retried once with the concrete error, then the round succeeds', async () => {
  const cwd = gitRepo();
  let proposalCalls = 0;
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      reviewer: (a) => {
        if (a.stage === 'files') return { value: { requestedFiles: [] }, usage: OK_USAGE, model: 'm' };
        proposalCalls += 1;
        if (proposalCalls === 1) return { value: { malformed: true, reason: 'model output is not a JSON object', raw: 'Sure! Here is my plan' }, usage: OK_USAGE, model: 'm' };
        return { value: PROPOSALS, usage: OK_USAGE, model: 'm' };
      },
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  const proposalPrompts = log.reviewer.filter((x) => x.stage === 'proposal').map((x) => x.prompt);
  assert.equal(proposalPrompts.length, 2);
  assert.ok(!proposalPrompts[0].includes('PREVIOUS REPLY WAS REJECTED'));
  assert.ok(proposalPrompts[1].startsWith(proposalPrompts[0]));
  assert.match(proposalPrompts[1], /PREVIOUS REPLY WAS REJECTED: proposal output is not a JSON object/);
  assert.equal(r.telemetry.reviewerCalls, 3);
  rmSync(cwd, { recursive: true, force: true });
});

test('a malformed Supervisor adjudication is retried once and can then PASS', async () => {
  const cwd = gitRepo();
  const { ctl, log } = makeCtl({ cwd, fakes: { supervisor: (n) => (n === 1 ? { comparison: { verdict: 'NEEDS_HUMAN', reason: 'r', workerSummary: 'w' }, blockingFindings: [] } : adj()) } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(log.supervisor.length, 2);
  assert.match(log.supervisor[1].prompt, /NEEDS_HUMAN requires humanQuestions/);
  assert.equal(r.telemetry.supervisorCalls, 2);
  rmSync(cwd, { recursive: true, force: true });
});

test('two malformed outputs in a row fail closed with the concrete reason and a bounded raw excerpt', async () => {
  const cwd = gitRepo();
  const long = `Sure, here is my answer ${'x'.repeat(1000)}`;
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      reviewer: (a) => (a.stage === 'files'
        ? { value: { requestedFiles: [] }, usage: OK_USAGE, model: 'm' }
        : { value: { malformed: true, reason: 'model output is not a JSON object', raw: long }, usage: OK_USAGE, model: 'm' }),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(r.designSha256, undefined);
  assert.equal(log.reviewer.filter((x) => x.stage === 'proposal').length, 2, 'exactly one retry, no more');
  assert.equal(log.supervisor.length, 0);
  const text = JSON.stringify(r);
  assert.match(text, /Reviewer proposals unusable \(proposal output is not a JSON object\)/);
  assert.match(text, /Sure, here is my answer/);
  assert.ok(!text.includes('x'.repeat(400)), 'excerpt is bounded');
  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------ independent fact verification

test('parseGitStatusDirtyPaths handles renames/copies without shifting subsequent entries', () => {
  const raw = 'R  new.js\0old.js\0 M src/a.js\0?? Prompt.md\0?? other.txt\0';
  const dirty = parseGitStatusDirtyPaths(raw, 'Prompt.md');
  assert.equal(dirty.has('new.js'), true);
  assert.equal(dirty.has('old.js'), true);
  assert.equal(dirty.has('src/a.js'), true);
  assert.equal(dirty.has('other.txt'), true);
  assert.equal(dirty.has('Prompt.md'), false);
});

test('collectCodeIdentity reports clean git-head, per-file dirty status, and no-git fallback', async () => {
  const cwd = gitRepo();
  const clean = await collectCodeIdentity({ cwd, reviewTarget: 'Prompt.md' });
  assert.equal(clean.sourceMode, 'git-head');
  assert.equal(clean.worktreeDirty, false);
  assert.match(clean.headSha, /^[0-9a-f]{40}$/);
  assert.ok(clean.branch);

  writeFileSync(path.join(cwd, 'README.md'), 'MODIFIED');
  writeFileSync(path.join(cwd, 'Prompt.md'), 'UNTRACKED-TARGET');
  const dirty = await collectCodeIdentity({ cwd, reviewTarget: 'Prompt.md' });
  assert.equal(dirty.sourceMode, 'worktree-dirty');
  assert.equal(dirty.worktreeDirty, true);
  assert.equal(dirty.dirtyPaths.has('README.md'), true);
  assert.equal(dirty.dirtyPaths.has('package.json'), false);
  assert.equal(dirty.dirtyPaths.has('Prompt.md'), false);

  const noGit = mkdtempSync(path.join(os.tmpdir(), 'rl-nogit-'));
  const ng = await collectCodeIdentity({ cwd: noGit, reviewTarget: 'Prompt.md' });
  assert.equal(ng.sourceMode, 'no-git');
  assert.equal(ng.headSha, null);

  rmSync(cwd, { recursive: true, force: true });
  rmSync(noGit, { recursive: true, force: true });
});

test('I2 anti-hallucination: validateAdjudication rejects SUPPORTED factCheck citing unread or rejected files', () => {
  const verifiedPaths = new Set(['src/a.js']);
  const noSources = validateAdjudication(
    adj({ factChecks: [{ claim: 'c', critical: true, status: 'SUPPORTED', evidenceSources: [], reason: 'r' }] }),
    { verifiedPaths },
  );
  assert.equal(noSources.malformed, true);

  const unreadSource = validateAdjudication(
    adj({ factChecks: [{ claim: 'c', critical: true, status: 'SUPPORTED', evidenceSources: ['src/unread.js'], reason: 'r' }] }),
    { verifiedPaths },
  );
  assert.equal(unreadSource.malformed, true);

  const valid = validateAdjudication(
    adj({ factChecks: [{ claim: 'c', critical: true, status: 'SUPPORTED', evidenceSources: ['src/a.js'], reason: 'r' }] }),
    { verifiedPaths },
  );
  assert.equal(valid.malformed, undefined);
  assert.equal(valid.factChecks.length, 1);
});

test('AC02 (#59 living lock-holder TTL): true claim PASSes after Stage 2 fetch; false claim is CONTRADICTED -> REWORK', async () => {
  const cwd = gitRepo();
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  writeFileSync(path.join(cwd, 'src/lock.js'), 'export function canReclaim(lock, isPidAlive) {\n  if (isPidAlive(lock.pid)) return false;\n  return Date.now() > lock.expiresAt;\n}\n');
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add lock'], { cwd, stdio: 'pipe' });

  // Positive: Design states living same-host lock holder is NOT reclaimed by TTL
  {
    const { ctl, log } = makeCtl({
      cwd,
      fakes: {
        supervisor: (n, a) => {
          if (n === 1) return { needFactFiles: true, requestedFiles: ['src/lock.js'], pendingClaims: ['living holder not reclaimed by TTL'] };
          assert.match(a.prompt, /VERIFIED SOURCE FILE src\/lock\.js/);
          assert.match(a.prompt, /if \(isPidAlive\(lock\.pid\)\) return false;/);
          assert.match(a.prompt, /UNTRUSTED DATA/);
          return adj({
            factChecks: [{
              claim: 'Living lock holder on same host is not reclaimed by TTL',
              critical: true,
              status: 'SUPPORTED',
              evidenceSources: ['src/lock.js'],
              reason: 'canReclaim returns false whenever isPidAlive(lock.pid) is true',
            }],
          });
        },
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd, '# Design\nRelies on src/lock.js: living holder is not reclaimed.\n\n## Options\n- A\n\n## Assumptions\nNone\n');
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'PASS');
    assert.equal(log.supervisor.length, 2);
    assert.equal(r.factVerification.extraModelCalls, 1);
    assert.equal(r.factVerification.checkedFiles.length, 1);
    assert.equal(r.factVerification.checkedFiles[0].path, 'src/lock.js');
    assert.equal(r.factVerification.checkedFiles[0].source, 'stage2-fetch');
  }

  // Negative: Design falsely claims living lock holder IS reclaimed by TTL (even if Supervisor omits blockingFindings)
  rmSync(path.join(cwd, 'Prompt.md'), { force: true });
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        supervisor: (n) => {
          if (n === 1) return { needFactFiles: true, requestedFiles: ['src/lock.js'], pendingClaims: ['TTL reclaims living holder'] };
          return adj({
            blockingFindings: [],
            designPassComment: null,
            factChecks: [{
              claim: 'Living lock holder is automatically reclaimed by TTL',
              critical: true,
              status: 'CONTRADICTED',
              evidenceSources: ['src/lock.js'],
              reason: 'canReclaim explicitly returns false when isPidAlive(lock.pid) is true',
            }],
          });
        },
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd, '# Design\nAssumes TTL reclaims living lock holder.\n\n## Options\n- A\n\n## Assumptions\nNone\n');
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'REWORK');
    assert.equal(r.designSha256, undefined);
    assert.equal(r.blockingFindings.length, 1);
    assert.equal(r.blockingFindings[0].severity, 'P1');
  }

  rmSync(cwd, { recursive: true, force: true });
});

test('AC03 & AC05 (#59 global call cap): Supervisor fetches caller/config and blocks false task-local claim', async () => {
  const cwd = gitRepo();
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  writeFileSync(path.join(cwd, 'src/config.js'), 'export const GLOBAL_CALL_CAP = 50;\n');
  writeFileSync(path.join(cwd, 'src/runner.js'), 'import { GLOBAL_CALL_CAP } from "./config.js";\nexport function checkAllTasks(total) { return total < GLOBAL_CALL_CAP; }\n');
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add config and runner'], { cwd, stdio: 'pipe' });

  const { ctl } = makeCtl({
    cwd,
    fakes: {
      supervisor: (n, a) => {
        if (n === 1) {
          assert.match(a.prompt, /src\/runner\.js/);
          return { needFactFiles: true, requestedFiles: ['src/config.js', 'src/runner.js'], pendingClaims: ['GLOBAL_CALL_CAP is task-local'] };
        }
        return adj({
          blockingFindings: [],
          designPassComment: null,
          factChecks: [{
            claim: 'Adjusting GLOBAL_CALL_CAP only affects the current task',
            critical: true,
            status: 'CONTRADICTED',
            evidenceSources: ['src/config.js', 'src/runner.js'],
            reason: 'runner.js applies GLOBAL_CALL_CAP across all tasks via checkAllTasks(total)',
          }],
        });
      },
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd, '# Design\nQuotes GLOBAL_CALL_CAP = 50 and claims it is per-task.\n\n## Options\n- A\n\n## Assumptions\nNone\n');
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'REWORK');
  assert.equal(r.factVerification.checkedFiles.map((f) => f.path).sort().join(','), 'src/config.js,src/runner.js');
  rmSync(cwd, { recursive: true, force: true });
});

test('AC06 & AC08: Stage 1 reads do not starve Stage 2 fact fetch; Stage 2 cap -> HUMAN_REQUIRED; non-critical UNVERIFIED can PASS', async () => {
  const cwd = gitRepo();
  for (let i = 0; i < 21; i += 1) {
    writeFileSync(path.join(cwd, `f${i}.js`), `export const v${i} = ${i};\n`);
  }
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add files'], { cwd, stdio: 'pipe' });

  // Stage 1 reads 10 files (f0..f9); Stage 2 requests 11 new files (f10..f20) plus invalid path ->
  // Stage 2 still gets its own 10 new files (f10..f19), f20 is rejected with cap reached -> critical UNVERIFIED => HUMAN_REQUIRED
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        reviewer: (a) => (a.stage === 'files'
          ? { value: { requestedFiles: Array.from({ length: 10 }, (_, i) => `f${i}.js`) }, usage: OK_USAGE, model: 'm' }
          : { value: PROPOSALS, usage: OK_USAGE, model: 'm' }),
        supervisor: (n) => {
          if (n === 1) {
            return {
              needFactFiles: true,
              requestedFiles: [...Array.from({ length: 11 }, (_, i) => `f${10 + i}.js`), '../secret.txt'],
              pendingClaims: ['check f20.js'],
            };
          }
          return adj({
            factChecks: [{
              claim: 'f20.js invariant',
              critical: true,
              status: 'UNVERIFIED',
              evidenceSources: [],
              reason: 'f20.js was rejected due to file count cap',
            }],
          });
        },
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.equal(r.designSha256, undefined);
    assert.equal(r.factVerification.checkedFiles.length, 20);
    assert.ok(r.factVerification.rejectedFiles.some((x) => x.path === 'f20.js' && x.reason === 'file count cap reached'));
    assert.ok(r.factVerification.rejectedFiles.some((x) => x.reason === 'invalid path'));
  }

  // Non-critical UNVERIFIED does not block PASS; critical UNVERIFIED without boundary block => REWORK_DEFECTS
  const nonBoundaryRework = decideDesignTransition({
    adjudication: adj({
      factChecks: [{ claim: 'Check lock caller', critical: true, status: 'UNVERIFIED', evidenceSources: [], reason: 'Missing file reference in design' }],
    }),
    exchangeCount: 0,
    rejectedFiles: [],
    codeIdentity: { sourceMode: 'git-head' },
  });
  assert.equal(nonBoundaryRework.kind, 'REWORK_DEFECTS');
  assert.equal(nonBoundaryRework.synthesizedFindings.length, 1);

  rmSync(path.join(cwd, 'Prompt.md'), { force: true });
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        supervisor: () => adj({
          factChecks: [{
            claim: 'Optional README note',
            critical: false,
            status: 'UNVERIFIED',
            evidenceSources: [],
            reason: 'Not checked',
          }],
        }),
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'PASS');
    assert.equal(r.factVerification.extraModelCalls, 0);
  }

  rmSync(cwd, { recursive: true, force: true });
});

test('AC10 & AC11: ordinary designs without needFactFiles incur 0 extra calls and legacy adjudication without factChecks still works', async () => {
  const cwd = gitRepo();
  const { ctl, log } = makeCtl({ cwd });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(log.reviewer.length, 2);
  assert.equal(log.supervisor.length, 1);
  assert.equal(r.factVerification.extraModelCalls, 0);
  assert.deepEqual(r.factVerification.factChecks, []);
  rmSync(cwd, { recursive: true, force: true });
});

test('pendingClaims closure: dropping a pendingClaim from factChecks is rejected as malformed', () => {
  const verifiedPaths = new Set(['src/a.js']);
  const dropped = validateAdjudication(
    adj({
      factChecks: [{ claim: 'Lock check', critical: true, status: 'SUPPORTED', evidenceSources: ['src/a.js'], reason: 'ok' }],
    }),
    { verifiedPaths, requireFactChecks: true, pendingClaims: ['Lock check', 'Budget scope'] },
  );
  assert.equal(dropped.malformed, true);
  assert.match(dropped.reason, /pendingClaims/);

  const complete = validateAdjudication(
    adj({
      factChecks: [
        { claim: 'Lock check', critical: true, status: 'SUPPORTED', evidenceSources: ['src/a.js'], reason: 'ok' },
        { claim: 'Budget scope', critical: true, status: 'SUPPORTED', evidenceSources: ['src/a.js'], reason: 'ok' },
      ],
    }),
    { verifiedPaths, requireFactChecks: true, pendingClaims: ['Lock check', 'Budget scope'] },
  );
  assert.equal(complete.malformed, undefined);
});

test('collectCodeIdentity marks git status failure as status-unverified and blocks clean PASS', async () => {
  const execFileFn = async (_cmd, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'a'.repeat(40) + '\n' };
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n' };
    if (args[0] === 'status') throw new Error('git status failed');
    return { stdout: '' };
  };
  const id = await collectCodeIdentity({ cwd: '/tmp', reviewTarget: 'Prompt.md', execFileFn });
  assert.equal(id.sourceMode, 'status-unverified');
  assert.equal(id.worktreeDirty, null);
  assert.equal(id.statusVerified, false);

  const transition = decideDesignTransition({
    adjudication: adj({
      factChecks: [{ claim: 'Lock check', critical: true, status: 'SUPPORTED', evidenceSources: ['src/a.js'], reason: 'ok' }],
    }),
    exchangeCount: 0,
    rejectedFiles: [],
    codeIdentity: id,
  });
  assert.equal(transition.kind, 'HUMAN');
});

test('readRequestedFiles records over-10 file requests in rejected instead of silently truncating', async () => {
  const cwd = gitRepo();
  const names = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `extra-${i}.js`;
    names.push(name);
    writeFileSync(path.join(cwd, name), `export const n = ${i};\n`);
  }
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add 12 files'], { cwd, stdio: 'pipe' });

  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const req = validateFileRequest({ requestedFiles: names });
  assert.equal(req.requestedFiles.length, 10);
  assert.deepEqual(req.overflowFiles, ['extra-10.js', 'extra-11.js']);
  const { files, rejected } = await readRequestedFiles({ cwd, requested: [...req.requestedFiles, ...(req.overflowFiles ?? [])], context });
  assert.equal(files.length, 10);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].path, 'extra-10.js');
  assert.equal(rejected[0].reason, 'file count cap reached');
  assert.equal(rejected[1].path, 'extra-11.js');
  assert.equal(rejected[1].reason, 'file count cap reached');
  rmSync(cwd, { recursive: true, force: true });
});

test('F002: decideDesignTransition blocks PASS when critical SUPPORTED factCheck cites a dirty worktree file', () => {
  const transition = decideDesignTransition({
    adjudication: adj({
      factChecks: [{
        claim: 'Lock check',
        critical: true,
        status: 'SUPPORTED',
        evidenceSources: ['src/lock.js'],
        reason: 'matches uncommitted local edit',
      }],
    }),
    exchangeCount: 0,
    rejectedFiles: [],
    codeIdentity: { sourceMode: 'worktree-dirty' },
    dirtyVerifiedPaths: new Set(['src/lock.js']),
  });
  assert.equal(transition.kind, 'HUMAN');
  assert.match(transition.reason, /uncommitted worktree modifications/);
});

test('F003 & F004: Stage 1 overflow rejections do not force HUMAN_REQUIRED, and dirty file end-to-end blocks PASS', async () => {
  const cwd = gitRepo();
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(path.join(cwd, `s1-${i}.js`), `export const x = ${i};\n`);
  }
  writeFileSync(path.join(cwd, 'lock.js'), 'export const ttl = false;\n');
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add files'], { cwd, stdio: 'pipe' });

  // F003: Stage 1 requests 12 files (2 rejected in Stage 1); Stage 2 has critical UNVERIFIED with 0 Stage 2 rejections => REWORK (not HUMAN_REQUIRED)
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        reviewer: (a) => (a.stage === 'files'
          ? { value: { requestedFiles: Array.from({ length: 12 }, (_, i) => `s1-${i}.js`) }, usage: OK_USAGE, model: 'm' }
          : { value: PROPOSALS, usage: OK_USAGE, model: 'm' }),
        supervisor: () => adj({
          factChecks: [{
            claim: 'Clarify lock design',
            critical: true,
            status: 'UNVERIFIED',
            evidenceSources: [],
            reason: 'Design needs clearer lock reference',
          }],
        }),
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'REWORK');
    assert.equal(r.factVerification.rejectedFiles.length, 2);
    assert.equal(r.factVerification.stage2RejectedFiles.length, 0);
  }

  // F004: end-to-end controller blocks PASS when a verified file has uncommitted worktree modifications
  rmSync(path.join(cwd, 'Prompt.md'), { force: true });
  writeFileSync(path.join(cwd, 'lock.js'), 'export const ttl = true; // uncommitted edit\n');
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        supervisor: (n) => {
          if (n === 1) return { needFactFiles: true, requestedFiles: ['lock.js'], pendingClaims: ['lock ttl'] };
          return adj({
            factChecks: [{
              claim: 'lock.js ttl',
              critical: true,
              status: 'SUPPORTED',
              evidenceSources: ['lock.js'],
              reason: 'matches dirty worktree file',
            }],
          });
        },
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.equal(r.designSha256, undefined);
    assert.equal(r.factVerification.checkedFiles[0].dirty, true);
  }

  rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------- line-range excerpts (RL-DESIGN-SOURCE-20261120)

const rawSha = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const BIG_LINE = (i) => `// line ${i} ${'x'.repeat(50)}`;
const BIG_LINES = 1000;

// gitRepo() plus a committed src/big.js (~60 KiB, 1000 numbered lines).
function bigRepo(extra = {}) {
  const cwd = gitRepo();
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  writeFileSync(path.join(cwd, 'src/big.js'), `${Array.from({ length: BIG_LINES }, (_, i) => BIG_LINE(i + 1)).join('\n')}\n`);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), content);
  }
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'big');
  return cwd;
}
const range = (p, startLine, endLine) => ({ path: p, startLine, endLine });

test('AC-01: a >24 KiB tracked file is rejected whole (with totalLines) but its exact line range is provided, nothing outside it', async () => {
  const cwd = bigRepo();
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  assert.ok(Buffer.byteLength(readFileSync(path.join(cwd, 'src/big.js'))) > 60 * 1024 - 2000);
  const whole = await readRequestedFiles({ cwd, context, requested: ['src/big.js'] });
  assert.equal(whole.files.length, 0);
  assert.deepEqual(whole.rejected, [{ path: 'src/big.js', reason: 'DESIGN_TARGET_TOO_LARGE', totalLines: BIG_LINES }]);

  const r = await readRequestedFiles({ cwd, context, requested: [range('src/big.js', 120, 260)] });
  assert.deepEqual(r.rejected, []);
  assert.equal(r.files.length, 1);
  const f = r.files[0];
  assert.equal(f.citation, 'src/big.js#L120-L260');
  assert.equal(f.text, Array.from({ length: 141 }, (_, i) => BIG_LINE(120 + i)).join('\n'));
  assert.ok(f.bytes <= DESIGN_LIMITS.maxFileBytes, 'charged bytes incl. prefixes within the per-item cap');
  assert.equal(f.bytes, Buffer.byteLength(f.body));

  const prompt = buildAdjudicationPrompt({
    plan: PLAN, proposals: PROPOSALS.proposals, designText: DESIGN, history: [], exchangeCount: 0, context, files: r.files,
  });
  assert.match(prompt, /VERIFIED SOURCE EXCERPT src\/big\.js#L120-L260 \(lines 120-260 of 1000; NOT the whole file; fileSha256=[0-9a-f]{64}, excerptSha256=[0-9a-f]{64}, headBlobMatch=true, dirty=false/);
  assert.match(prompt, /\n120\| \/\/ line 120 /);
  assert.match(prompt, /\n260\| \/\/ line 260 /);
  assert.ok(!prompt.includes('// line 119 '), 'line before the range never reaches the model');
  assert.ok(!prompt.includes('// line 261 '), 'line after the range never reaches the model');
  assert.match(prompt, /src\/big\.js \[large: \d+ bytes — request line ranges\]/);
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-02: hashes, CRLF, no trailing newline, multibyte edges, empty file and headBlobMatch on clean vs post-status edit', async () => {
  const crlf = 'a\r\nb\r\nc\r\n';
  const noNl = 'one\ntwo\nthree';
  const multi = 'α首行\nβ第二行😀\nγ\n';
  const cwd = bigRepo({ 'crlf.txt': crlf, 'nonl.txt': noNl, 'multi.txt': multi, 'empty.txt': '' });
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const r = await readRequestedFiles({
    cwd, context, requested: [range('crlf.txt', 2, 3), range('nonl.txt', 3, 3), range('multi.txt', 1, 2), range('empty.txt', 1, 1)],
  });
  const by = Object.fromEntries(r.files.map((f) => [f.citation, f]));
  assert.equal(by['crlf.txt#L2-L3'].text, 'b\r\nc\r', 'CR kept verbatim');
  assert.equal(by['crlf.txt#L2-L3'].totalLines, 3);
  assert.equal(by['crlf.txt#L2-L3'].fileSha256, rawSha(Buffer.from(crlf)));
  assert.equal(by['crlf.txt#L2-L3'].excerptSha256, rawSha(Buffer.from('b\r\nc\r', 'utf8')));
  assert.equal(by['nonl.txt#L3-L3'].text, 'three');
  assert.equal(by['nonl.txt#L3-L3'].totalLines, 3);
  assert.equal(by['multi.txt#L1-L2'].text, 'α首行\nβ第二行😀');
  assert.equal(by['multi.txt#L1-L2'].totalLines, 3, 'trailing newline creates no extra line');
  for (const f of r.files) {
    assert.equal(f.headBlobMatch, true, f.citation);
    assert.equal(f.dirty, false, f.citation);
    assert.equal(f.sha256, f.excerptSha256);
  }
  assert.deepEqual(r.rejected, [{ path: 'empty.txt', startLine: 1, endLine: 1, reason: 'range out of bounds', totalLines: 0 }]);

  // Modified after the status snapshot: porcelain still says clean, the blob check catches it.
  writeFileSync(path.join(cwd, 'nonl.txt'), 'one\ntwo\nTHREE');
  const after = await readRequestedFiles({ cwd, context, requested: [range('nonl.txt', 3, 3)] });
  assert.equal(context.codeIdentity.dirtyPaths.has('nonl.txt'), false);
  assert.equal(after.files[0].headBlobMatch, false);
  assert.equal(after.files[0].dirty, true);
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-03: SUPPORTED must cite the exact provided label (bare path / other range malformed); Stage-2 range rejection + critical UNVERIFIED => HUMAN', async () => {
  const verifiedPaths = new Set(['src/big.js#L10-L20']);
  const fc = (src) => adj({ factChecks: [{ claim: 'c', critical: true, status: 'SUPPORTED', evidenceSources: [src], reason: 'r' }] });
  assert.equal(validateAdjudication(fc('src/big.js'), { verifiedPaths }).malformed, true, 'bare path when only an excerpt exists');
  assert.equal(validateAdjudication(fc('src/big.js#L10-L15'), { verifiedPaths }).malformed, true, 'sub-range');
  assert.equal(validateAdjudication(fc('src/big.js#L1-L20'), { verifiedPaths }).malformed, true, 'different range');
  assert.equal(validateAdjudication(fc('src/big.js#L10-L20'), { verifiedPaths }).malformed, undefined);

  const cwd = bigRepo();
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      supervisor: (n) => (n === 1
        ? { needFactFiles: true, requestedFiles: [range('src/big.js', 990, 1200)], pendingClaims: ['tail invariant'] }
        : adj({ factChecks: [{ claim: 'tail invariant', critical: true, status: 'UNVERIFIED', evidenceSources: [], reason: 'range rejected' }] })),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(log.supervisor.length, 2);
  assert.deepEqual(r.factVerification.stage2RejectedFiles, [{ path: 'src/big.js', startLine: 990, endLine: 1200, reason: 'range out of bounds', totalLines: BIG_LINES }]);
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-03/I4: a porcelain-dirty excerpt and a blob-mismatched (eol=crlf) excerpt backing critical SUPPORTED both => HUMAN via the citation label', async () => {
  for (const variant of ['dirty', 'eol']) {
    const cwd = bigRepo(variant === 'eol' ? { '.gitattributes': 'crlf.txt text eol=crlf\n', 'crlf.txt': 'a\nb\nc\n' } : {});
    let rel = 'src/big.js';
    if (variant === 'dirty') {
      writeFileSync(path.join(cwd, 'src/big.js'), `${BIG_LINE(1)}\nEDITED\n`);
    } else {
      rel = 'crlf.txt';
      rmSync(path.join(cwd, rel));
      git(cwd, 'checkout', '--', rel);
      assert.equal(readFileSync(path.join(cwd, rel), 'utf8'), 'a\r\nb\r\nc\r\n', 'checkout converted to CRLF');
      assert.equal(git(cwd, 'status', '--porcelain').toString(), '', 'porcelain clean');
    }
    const label = `${rel}#L1-L2`;
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        supervisor: (n) => (n === 1
          ? { needFactFiles: true, requestedFiles: [range(rel, 1, 2)], pendingClaims: ['claim'] }
          : adj({ factChecks: [{ claim: 'claim', critical: true, status: 'SUPPORTED', evidenceSources: [label], reason: 'ok' }] })),
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED', variant);
    assert.match(r.reason, /uncommitted worktree modifications/, variant);
    const cf = r.factVerification.checkedFiles[0];
    assert.equal(cf.citation, label);
    assert.equal(cf.dirty, true);
    assert.equal(cf.headBlobMatch, false, `${variant}: fail-closed blob mismatch`);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('AC-04: excerpts share the 10-item / 96 KiB caps; 401 lines and >24 KiB excerpts rejected; Stage 2 keeps its own budget', async () => {
  const wide = `${Array.from({ length: 400 }, (_, i) => `${i} ${'w'.repeat(95)}`).join('\n')}\n`;
  const cwd = bigRepo({ 'wide.txt': wide });
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const eleven = Array.from({ length: 11 }, (_, i) => range('src/big.js', i + 1, i + 1));
  const r1 = await readRequestedFiles({ cwd, context, requested: eleven });
  assert.equal(r1.files.length, 10);
  assert.deepEqual(r1.rejected, [{ path: 'src/big.js', startLine: 11, endLine: 11, reason: 'file count cap reached' }]);

  // ~23 KiB charged each, overlapping: the 5th exceeds 96 KiB.
  const overlapping = Array.from({ length: 5 }, (_, i) => range('src/big.js', 1 + i, 360 + i));
  const r2 = await readRequestedFiles({ cwd, context, requested: overlapping });
  assert.equal(r2.files.length, 4);
  assert.ok(r2.files.reduce((s, f) => s + f.bytes, 0) <= DESIGN_LIMITS.maxTotalFileBytes);
  assert.deepEqual(r2.rejected.map((x) => x.reason), ['total size cap reached']);

  const r3 = await readRequestedFiles({ cwd, context, requested: [range('src/big.js', 1, 401), range('wide.txt', 1, 300)] });
  assert.deepEqual(r3.rejected.map((x) => x.reason), ['invalid range', 'excerpt too large']);

  // Stage 2 (countExisting:false) still gets its own 10 items after 10 Stage 1 excerpts.
  const r4 = await readRequestedFiles({
    cwd, context, existingFiles: r1.files, countExisting: false, source: 'stage2-fetch',
    requested: Array.from({ length: 10 }, (_, i) => range('src/big.js', 100 + i, 100 + i)),
  });
  assert.equal(r4.files.length, 10);
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-05: every bad excerpt item is reported in rejected with a reason and costs no extra model call; envelope violations still use the one retry', async () => {
  const cwd = bigRepo({
    'sub/a.js': 'a\n', 'dir-later': 'x\n', 'fifo-later': 'x\n', 'gone.txt': 'x\n', 'latin1.txt': 'x\n', 'weird.js#L1-L2': 'x\n', 'small.js': '1\n2\n3\n',
  });
  // Replace committed entries after the commit so the tracked set still lists them.
  writeFileSync(path.join(cwd, 'latin1.txt'), Buffer.from([0x61, 0xff, 0x0a]));
  rmSync(path.join(cwd, 'gone.txt'));
  rmSync(path.join(cwd, 'dir-later')); mkdirSync(path.join(cwd, 'dir-later'));
  rmSync(path.join(cwd, 'fifo-later')); execFileSync('mkfifo', [path.join(cwd, 'fifo-later')]);
  const real = mkdtempSync(path.join(os.tmpdir(), 'rl-real-'));
  writeFileSync(path.join(real, 'a.js'), 'OUTSIDE-REPO-MARKER\n');
  rmSync(path.join(cwd, 'sub'), { recursive: true }); symlinkSync(real, path.join(cwd, 'sub'));
  writeFileSync(path.join(cwd, 'scratch.txt'), 'untracked\n');
  const bad = [
    range('../x', 1, 1), range('.git/config', 1, 1), range('sub/a.js', 1, 1), range('scratch.txt', 1, 1), range('dir-later', 1, 1),
    range('fifo-later', 1, 1), range('gone.txt', 1, 1), range('latin1.txt', 1, 1), range('small.js', 0, 1), range('small.js', 3, 2),
    range('small.js', 2, 9), { path: 'small.js', startLine: 1.5, endLine: 2 }, { path: 'small.js', startLine: 1, endLine: 2, extra: 1 },
    { path: 'small.js', startLine: 1 }, { startLine: 1, endLine: 2 }, range('weird.js#L1-L2', 1, 1), range('Prompt.md', 1, 1),
  ];
  const expected = [
    'invalid path', 'invalid path', 'DESIGN_TARGET_SYMLINK', 'not a tracked file', 'DESIGN_TARGET_NOT_FILE',
    'DESIGN_TARGET_NOT_FILE', 'DESIGN_TARGET_MISSING', 'DESIGN_TARGET_NOT_UTF8', 'invalid range', 'invalid range',
    'range out of bounds', 'invalid range request', 'invalid range request', 'invalid range request', 'invalid range request', 'ambiguous path',
  ];
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      supervisor: (n) => (n === 1
        ? { needFactFiles: true, requestedFiles: bad, pendingClaims: ['c'] }
        : adj({ factChecks: [{ claim: 'c', critical: false, status: 'UNVERIFIED', evidenceSources: [], reason: 'all rejected' }] })),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(log.reviewer.length, 2, 'no reviewer retry');
  assert.equal(log.supervisor.length, 2, 'fact fetch + final adjudication only: no corrective retry');
  const reasons = r.factVerification.stage2RejectedFiles.map((x) => x.reason);
  assert.deepEqual(reasons, expected);
  assert.ok(!JSON.stringify(r.factVerification).includes('[object Object]'));
  assert.ok(!log.supervisor.map((a) => a.prompt).join('\n').includes('OUTSIDE-REPO-MARKER'), 'symlinked parent never read');
  assert.ok(!JSON.stringify(r.factVerification.stage2RejectedFiles).includes('Prompt.md'), 'design target silently dropped');

  assert.equal(validateFactFileRequest({ needFactFiles: true, requestedFiles: [1], pendingClaims: ['c'] }).malformed, true);
  for (const item of [null, ['a'], 3, true]) assert.equal(validateFileRequest({ requestedFiles: [item] }).malformed, true);
  assert.equal(validateFileRequest({ requestedFiles: [{}] }).malformed, undefined, 'object item content is an item rule, not an envelope rule');
  rmSync(cwd, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
});

test('envelope violation in the fact fetch (number item) is malformed and uses exactly the existing single retry', async () => {
  const cwd = bigRepo();
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      supervisor: (n) => (n === 1 ? { needFactFiles: true, requestedFiles: [7], pendingClaims: ['c'] } : adj()),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(log.supervisor.length, 2);
  assert.match(log.supervisor[1].prompt, /PREVIOUS REPLY WAS REJECTED: needFactFiles requires a non-empty requestedFiles array/);
  rmSync(cwd, { recursive: true, force: true });
});

test('version anchor: BOM kept in line 1 with fileSha256 over raw bytes; headBlobMatch reads the RECORDED headSha with Buffer output', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond\n')]);
  const cwd = bigRepo();
  writeFileSync(path.join(cwd, 'bom.txt'), bom);
  git(cwd, 'add', 'bom.txt'); git(cwd, 'commit', '-qm', 'bom');
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const recorded = context.codeIdentity.headSha;
  // HEAD moves after the snapshot: the comparison must still use the recorded sha.
  writeFileSync(path.join(cwd, 'bom.txt'), 'changed\n'); git(cwd, 'commit', '-qam', 'move head');
  writeFileSync(path.join(cwd, 'bom.txt'), bom);
  const calls = [];
  const real = (await import('node:util')).promisify((await import('node:child_process')).execFile);
  const execFileFn = (cmd, args, opts) => { calls.push({ args, opts }); return real(cmd, args, opts); };
  const r = await readRequestedFiles({ cwd, context, requested: [range('bom.txt', 1, 1)], execFileFn });
  const f = r.files[0];
  assert.equal(f.text, '\uFEFFfirst');
  assert.equal(f.fileSha256, rawSha(bom));
  assert.equal(f.headBlobMatch, true, 'bytes equal the RECORDED head blob, not the moved HEAD');
  const cat = calls.filter((c) => c.args[0] === 'cat-file');
  assert.equal(cat.length, 1);
  assert.deepEqual(cat[0].args, ['cat-file', 'blob', `${recorded}:./bom.txt`]);
  assert.equal(cat[0].opts.encoding, 'buffer');
  rmSync(cwd, { recursive: true, force: true });
});

test('EV-BUFFER (R2-P3-3): headBlobMatch is raw byte equality — invalid-UTF-8 blob vs U+FFFD worktree is false; a string result is never trusted', async () => {
  const cwd = bigRepo();
  writeFileSync(path.join(cwd, 'enc.txt'), Buffer.from([0x61, 0xff, 0x0a]));
  git(cwd, 'add', 'enc.txt'); git(cwd, 'commit', '-qm', 'enc');
  writeFileSync(path.join(cwd, 'enc.txt'), 'a\uFFFD\n');
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  // Decoded as strings both sides read "a\uFFFD\n"; as bytes they differ.
  assert.equal(Buffer.from([0x61, 0xff, 0x0a]).toString('utf8'), readFileSync(path.join(cwd, 'enc.txt'), 'utf8'));
  const r = await readRequestedFiles({ cwd, context, requested: [range('enc.txt', 1, 1)] });
  assert.equal(r.files[0].headBlobMatch, false);
  assert.equal(r.files[0].dirty, true);

  // A git stand-in that returns a (decoded) string, even an identical one, is not a byte comparison: null => dirty.
  const ctx2 = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  ctx2.codeIdentity.dirtyPaths = new Set();
  writeFileSync(path.join(cwd, 'same.txt'), 'same\n');
  git(cwd, 'add', 'same.txt'); git(cwd, 'commit', '-qm', 'same');
  ctx2.tracked.add('same.txt');
  const stringFn = async () => ({ stdout: 'same\n' });
  const r2 = await readRequestedFiles({ cwd, context: ctx2, requested: [range('same.txt', 1, 1)], execFileFn: stringFn });
  assert.equal(r2.files[0].headBlobMatch, null);
  assert.equal(r2.files[0].dirty, true);
  rmSync(cwd, { recursive: true, force: true });
});

test('EV-CACHE (R2-P3-4): within one batch a path is read once and every excerpt is cut from those bytes; its blob verdict describes exactly them', async () => {
  const cwd = bigRepo();
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const real = (await import('node:util')).promisify((await import('node:child_process')).execFile);
  let catCalls = 0;
  const execFileFn = async (cmd, args, opts) => {
    if (args[0] === 'cat-file') {
      catCalls += 1;
      // The file changes on disk right after the first read, before the second excerpt.
      writeFileSync(path.join(cwd, 'src/big.js'), 'TAMPERED\n'.repeat(BIG_LINES));
    }
    return real(cmd, args, opts);
  };
  const original = readFileSync(path.join(cwd, 'src/big.js'));
  const r = await readRequestedFiles({ cwd, context, requested: [range('src/big.js', 1, 2), range('src/big.js', 500, 501)], execFileFn });
  assert.equal(catCalls, 1, 'one blob lookup per path per batch');
  assert.equal(r.files.length, 2);
  for (const f of r.files) {
    assert.equal(f.fileSha256, rawSha(original), 'both excerpts come from the same bytes');
    assert.ok(!f.text.includes('TAMPERED'));
    assert.equal(f.headBlobMatch, true, 'the verdict is about the bytes actually shown');
  }
  assert.equal(r.files[1].text, `${BIG_LINE(500)}\n${BIG_LINE(501)}`);
  // A new batch re-reads and sees the tampering as a blob mismatch.
  const again = await readRequestedFiles({ cwd, context, requested: [range('src/big.js', 1, 2)] });
  assert.equal(again.files[0].headBlobMatch, false);
  assert.equal(again.files[0].dirty, true);
  rmSync(cwd, { recursive: true, force: true });
});

test('carry-over: Stage 1 excerpt then Stage 2 another range + whole request of a large file; whole-then-excerpt is alreadyProvided, not a rejection', async () => {
  const cwd = bigRepo({ 'small.js': 'one\ntwo\n' });
  const { ctl, log } = makeCtl({
    cwd,
    fakes: {
      reviewer: (a) => ({ value: a.stage === 'files' ? { requestedFiles: [range('src/big.js', 1, 10), 'small.js'] } : PROPOSALS, usage: OK_USAGE, model: 'm' }),
      supervisor: (n) => (n === 1
        ? { needFactFiles: true, requestedFiles: [range('src/big.js', 20, 30), 'src/big.js', range('small.js', 1, 1)], pendingClaims: ['a', 'b'] }
        : adj({
          factChecks: [
            { claim: 'a', critical: true, status: 'SUPPORTED', evidenceSources: ['src/big.js#L1-L10', 'src/big.js#L20-L30'], reason: 'ok' },
            { claim: 'b', critical: true, status: 'SUPPORTED', evidenceSources: ['small.js'], reason: 'ok' },
          ],
        })),
    },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.match(log.reviewer[1].prompt, /SOURCE EXCERPT src\/big\.js#L1-L10 \(lines 1-10 of 1000; NOT the whole file/);
  assert.deepEqual(r.factVerification.checkedFiles.map((f) => f.citation), ['src/big.js#L1-L10', 'small.js', 'src/big.js#L20-L30']);
  assert.deepEqual(r.factVerification.stage2RejectedFiles, [{ path: 'src/big.js', reason: 'DESIGN_TARGET_TOO_LARGE', totalLines: BIG_LINES }]);
  assert.deepEqual(r.factVerification.alreadyProvided, [{ path: 'small.js', requested: 'small.js#L1-L1' }]);
  assert.match(log.supervisor[1].prompt, /ALREADY PROVIDED AS WHOLE FILE: small\.js — cite "small\.js"/);
  // A whole-file Stage 2 rejection exists, but no critical claim is UNVERIFIED: PASS.
  assert.equal(r.status, 'PASS');
  rmSync(cwd, { recursive: true, force: true });
});

test('tree markers are display-only: tree and tracked set unchanged; symlinked entries get no marker', async () => {
  const cwd = bigRepo();
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const listed = git(cwd, 'ls-files', '-z').toString().split('\0').filter(Boolean);
  assert.deepEqual([...context.tracked].sort(), listed.sort());
  assert.deepEqual([...context.tree].sort(), listed.sort());
  assert.ok(context.tree.includes('src/big.js'), 'raw path, no marker inside the tree array');
  assert.ok(context.largeFiles.has('src/big.js'));
  assert.equal(context.largeFiles.has('README.md'), false);
  const p = buildFileRequestPrompt({ plan: PLAN, context, workerSummary: null });
  assert.match(p, /src\/big\.js \[large: \d+ bytes — request line ranges\]/);
  assert.match(p, /unavailable, not truncated/);
  assert.match(p, /label is for CITING only and is never a request path/);
  rmSync(cwd, { recursive: true, force: true });
});

test('R2-P3-1/5/6/9: label strings as request paths, platform without O_NOFOLLOW, subdirectory cwd, readable rejected object path', async () => {
  const cwd = bigRepo({ 'pkg/inner.js': 'inner-1\ninner-2\n' });
  const context = await collectDesignContext({ cwd, reviewTarget: 'Prompt.md' });
  const lbl = await readRequestedFiles({ cwd, context, requested: ['src/big.js#L1-L5'] });
  assert.match(lbl.rejected[0].reason, /excerpt label is a citation, not a request path/);

  await assert.rejects(
    readRepoFileBytesBounded({ cwd, rel: 'README.md', maxBytes: 1024, fsConstants: { O_RDONLY: 0 } }),
    (err) => err.code === 'DESIGN_TARGET_UNREADABLE',
  );
  const ok = await readRepoFileBytesBounded({ cwd, rel: 'README.md', maxBytes: 1024 });
  assert.equal(ok.text, 'README-CONTENT');
  await assert.rejects(readRepoFileBytesBounded({ cwd, rel: 'src/big.js', maxBytes: 1024 }), (err) => err.code === 'DESIGN_SOURCE_TOO_LARGE');
  assert.deepEqual(splitSourceLines('a\n\nb\n'), ['a', '', 'b']);
  assert.deepEqual(splitSourceLines('\n'), ['']);

  const sub = path.join(cwd, 'pkg');
  const subCtx = await collectDesignContext({ cwd: sub, reviewTarget: 'Prompt.md' });
  assert.ok(subCtx.tracked.has('inner.js'));
  const r = await readRequestedFiles({ cwd: sub, context: subCtx, requested: [range('inner.js', 2, 2)] });
  assert.equal(r.files[0].text, 'inner-2');
  assert.equal(r.files[0].headBlobMatch, true, 'cat-file <sha>:./path resolves relative to cwd');

  const noPath = await readRequestedFiles({ cwd, context, requested: [{ startLine: 1, endLine: 2 }] });
  assert.equal(noPath.rejected[0].path, '(range request without a path string)');
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-07 (synthetic, stub models): Supervisor fetches a range of a large tracked file, cites its label and the round PASSes; a wrong label is malformed and retried', async () => {
  for (const variant of ['right', 'wrongThenRight']) {
    const cwd = bigRepo();
    const { ctl, log } = makeCtl({
      cwd,
      fakes: {
        supervisor: (n) => {
          if (n === 1) return { needFactFiles: true, requestedFiles: [range('src/big.js', 400, 420)], pendingClaims: ['line 410 exists'] };
          const cite = variant === 'wrongThenRight' && n === 2 ? 'src/big.js' : 'src/big.js#L400-L420';
          return adj({ factChecks: [{ claim: 'line 410 exists', critical: true, status: 'SUPPORTED', evidenceSources: [cite], reason: 'seen at 410|' }] });
        },
      },
    });
    const b = await begin(ctl, cwd);
    writeDesign(cwd);
    const r = await ctl.review({ loopId: b.loopId });
    assert.equal(r.status, 'PASS', variant);
    assert.equal(log.supervisor.length, variant === 'right' ? 2 : 3, variant);
    if (variant === 'wrongThenRight') assert.match(log.supervisor[2].prompt, /cites file\(s\) not actually read by the controller/);
    const cf = r.factVerification.checkedFiles[0];
    assert.equal(cf.citation, 'src/big.js#L400-L420');
    assert.equal(cf.startLine, 400);
    assert.equal(cf.endLine, 420);
    assert.equal(cf.totalLines, BIG_LINES);
    assert.match(cf.fileSha256, /^[0-9a-f]{64}$/);
    assert.equal(cf.excerptSha256, cf.sha256);
    assert.equal(cf.headBlobMatch, true);
    assert.equal(cf.dirty, false);
    assert.equal(r.factVerification.factChecks[0].evidenceSources[0], 'src/big.js#L400-L420');
    assert.ok(!log.supervisor[1].prompt.includes('// line 399 ') && !log.supervisor[1].prompt.includes('// line 421 '));
    rmSync(cwd, { recursive: true, force: true });
  }
});


// ============================ P2: input budget, retries, evidence ============================

const budgetText = (bytes, tag) => {
  const line = `${tag} line of ordinary design prose that is long enough to be a realistic line\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
};

function budgetRepo() {
  const cwd = gitRepo();
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  for (let i = 0; i < 4; i += 1) writeFileSync(path.join(cwd, `big${i}.txt`), budgetText(24_000, `file${i}`));
  g('add', '.'); g('commit', '-qm', 'big files');
  return cwd;
}
const BUDGET_PLAN = budgetText(60_000, 'plan');
const BUDGET_DESIGN = `${budgetText(40_000, 'design')}\n## Options\n- A\n\n## Assumptions\nNone\n`;
const beginBudget = (ctl, cwd) => ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: BUDGET_PLAN, reviewTarget: 'Prompt.md' });
const wantsBudgetFiles = (a) => (a.stage === 'files'
  ? { value: { requestedFiles: ['big0.txt', 'big1.txt', 'big2.txt', 'big3.txt'] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }
  : { value: PROPOSALS, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' });
const persistedState = async (persistence, loopId) => (await persistence.readWorkflowState(loopId));
const lastHrEntry = (loop) => [...loop.history].reverse().find((h) => h.to === 'HUMAN_REQUIRED');

test('P2 AC-01/03: an adjudication prompt over budget (~220K chars) stops with ZERO supervisor calls, no trimming, no retry', async () => {
  const cwd = budgetRepo();
  const { ctl, log, persistence } = makeCtl({ cwd, fakes: { reviewer: wantsBudgetFiles }, inputBudget: { limitBytes: 180_000, source: 'TOKEN_BUDGET' } });
  const b = await beginBudget(ctl, cwd);
  writeDesign(cwd, BUDGET_DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(r.designSha256, undefined);
  assert.equal(log.supervisor.length, 0, 'not one supervisor call');
  assert.equal(log.reviewer.length, 2, 'files + proposal stages only; the failed stage was never sent or retried');
  assert.match(r.reason, /Supervisor adjudication input too large \(\d+ bytes > 180000-byte budget from TOKEN_BUDGET; overflow from (FIXED_MATERIAL|EVIDENCE)/);
  assert.match(r.reason, /no model call was made and nothing was trimmed/);
  const wf = await persistedState(persistence, b.loopId);
  assert.ok(!JSON.stringify(wf).includes('design-adjudicate'), 'no evidence registration / reservation for the refused stage');
  const stop = lastHrEntry(wf.reviewLoop);
  assert.equal(stop.cause.kind, 'INPUT_TOO_LARGE');
  assert.notEqual(wf.reviewLoop.supervisorInvoked, true, 'a refused-before-dispatch prompt is not a Supervisor invocation');
  const fr = wf.reviewLoop.failedRounds[0];
  assert.ok(fr.promptBytes > 180_000);
  assert.equal(fr.components.plan, 60_000);
  assert.ok(fr.components.design > 40_000 && fr.components.files > 90_000, JSON.stringify(fr.components));
  assert.equal(fr.replyClass, 'NOT_SENT');
  assert.equal(fr.visibility, 'LOCAL_CONSTRUCTED', 'never claims the model saw anything');
  assert.equal(readFileSync(path.join(cwd, 'Prompt.md'), 'utf8'), BUDGET_DESIGN, 'the design file is untouched');
  rmSync(cwd, { recursive: true, force: true });
});

test('P2 AC-01/03: the proposal stage is refused before ITS paid call too (fixed + selected evidence)', async () => {
  const cwd = budgetRepo();
  const { ctl, log } = makeCtl({ cwd, fakes: { reviewer: wantsBudgetFiles }, inputBudget: { limitBytes: 140_000, source: 'TRANSPORT_MEASURED_LOCAL' } });
  const b = await beginBudget(ctl, cwd);
  writeDesign(cwd, BUDGET_DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(log.reviewer.length, 1, 'only the small file-request stage ran');
  assert.equal(log.supervisor.length, 0);
  assert.match(r.reason, /Reviewer proposals input too large/);
  rmSync(cwd, { recursive: true, force: true });
});

test('P2: a prompt within budget is untouched and PASSes; metrics are recorded as numbers/enums only', async () => {
  const cwd = gitRepo();
  const { ctl, persistence } = makeCtl({ cwd, inputBudget: { limitBytes: 1_000_000, source: 'TEST' } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  const m = (await persistedState(persistence, b.loopId)).reviewLoop.reviewMetrics;
  assert.equal(m.length, 1);
  assert.deepEqual(Object.keys(m[0]).sort(), ['estimatedTokens', 'evidenceBytes', 'fixedBytes', 'outcomeKind', 'physicalCalls', 'rejectedCount', 'round']);
  assert.ok(Object.values(m[0]).every((v) => typeof v === 'number' || /^[A-Z_]+$/.test(v)));
  assert.equal(m[0].outcomeKind, 'DECIDED');
  rmSync(cwd, { recursive: true, force: true });
});

test('AC-07: design adjudication preserves exact Plan and Design without mandatory echo receipts', async () => {
  const cwd = gitRepo();
  const { ctl, log } = makeCtl({ cwd, inputBudget: { limitBytes: 1_000_000, source: 'TEST' } });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  const sent = String(log.supervisor[0].prompt);
  assert.ok(sent.includes(PLAN) && sent.includes(DESIGN), 'complete frozen texts remain in the prompt');
  assert.ok(!sent.includes('TRANSPORT RECEIPTS') && !sent.includes('⟦RL:'), 'no forced model echo cost');
  rmSync(cwd, { recursive: true, force: true });
});
test('P2 AC-09: an EMPTY reply is not re-bought; a format-only reply still gets exactly one retry', async () => {
  const cwd = gitRepo();
  const empty = makeCtl({
    cwd,
    fakes: { reviewer: () => ({ value: { malformed: true, raw: '' }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }) },
    inputBudget: { limitBytes: 1_000_000, source: 'TEST' },
  });
  const b = await begin(empty.ctl, cwd);
  writeDesign(cwd);
  const r = await empty.ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(empty.log.reviewer.length, 1, 'EMPTY => 0 same-content retries');
  const wf = await persistedState(empty.persistence, b.loopId);
  assert.equal(wf.reviewLoop.failedRounds[0].replyClass, 'EMPTY');
  rmSync(cwd, { recursive: true, force: true });
});

test('P2 AC-09: a retry prompt that would cross the budget is refused before it is sent', async () => {
  const cwd = gitRepo();
  // First reply is format-invalid; the budget fits the base prompt but not base + retry note.
  let baseBytes = 0;
  const probe = makeCtl({ cwd, inputBudget: { limitBytes: 1_000_000, source: 'TEST' } });
  const pb = await begin(probe.ctl, cwd);
  writeDesign(cwd);
  await probe.ctl.review({ loopId: pb.loopId });
  baseBytes = Buffer.byteLength(String(probe.log.reviewer[0].prompt), 'utf8');
  rmSync(path.join(cwd, 'Prompt.md'));
  const tight = makeCtl({
    cwd,
    fakes: { reviewer: () => ({ value: { requestedFiles: 'nope' }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }) },
    inputBudget: { limitBytes: baseBytes + 20, source: 'TEST' },
  });
  const b = await begin(tight.ctl, cwd);
  writeDesign(cwd);
  const r = await tight.ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(tight.log.reviewer.length, 1, 'the oversize retry was never dispatched');
  assert.match(r.reason, /input too large/);
  rmSync(cwd, { recursive: true, force: true });
});

test('P2 AC-10: persistedState failure evidence holds no model text; the immediate reply may still show a bounded excerpt', async () => {
  const cwd = gitRepo();
  const { ctl, persistence } = makeCtl({
    cwd,
    fakes: { supervisor: () => ({ malformed: true, raw: 'SECRET-MODEL-TEXT sk-live-abcdef0123456789 please ignore' }) },
    inputBudget: { limitBytes: 1_000_000, source: 'TEST' },
  });
  const b = await begin(ctl, cwd);
  writeDesign(cwd);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(JSON.stringify(r), /SECRET-MODEL-TEXT/, 'immediate, in-memory reply is unchanged');
  const raw = JSON.stringify(await persistedState(persistence, b.loopId));
  assert.ok(!raw.includes('SECRET-MODEL-TEXT') && !raw.includes('sk-live') && !raw.includes('model output began'), 'nothing of the model text is at rest');
  const fr = JSON.parse(raw).reviewLoop.failedRounds[0];
  const walk = (v, keyPath = '') => {
    if (typeof v === 'string') {
      assert.ok(/^[A-Za-z0-9_.:@#/+-]{1,200}$/.test(v) || /^[A-Za-z0-9 _.,()#:-]{1,80}$/.test(v), `unexpected free text at ${keyPath}: ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${keyPath}[${i}]`));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, `${keyPath}.${k}`));
  };
  walk(fr, 'failedRound');
  assert.ok(['NOT_JSON', 'EMPTY'].includes(fr.replyClass));
  rmSync(cwd, { recursive: true, force: true });
});
