// Two-stage Design review: Reviewer independent proposal + Supervisor adjudication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  buildFileRequestPrompt, validateAdjudication, validateProposals, validateFileRequest, decideDesignTransition, finalizePassComment,
  collectDesignContext, collectCodeIdentity, parseGitStatusDirtyPaths, validateFactFileRequest,
  readRequestedFiles, DESIGN_LIMITS, buildProposalPrompt, buildAdjudicationPrompt,
} from '../src/reviewloop/designTwoStage.js';
import { designContentSha256 } from '../src/reviewloop/designTarget.js';
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

function makeCtl({ cwd, fakes = {}, deltaFp }) {
  const log = { reviewer: [], supervisor: [] };
  let n = 0;
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
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
  return { ctl, log };
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

test('AC06 & AC08: critical UNVERIFIED (rejected/cap/missing) -> HUMAN_REQUIRED; non-critical UNVERIFIED can PASS', async () => {
  const cwd = gitRepo();
  for (let i = 0; i < 11; i += 1) {
    writeFileSync(path.join(cwd, `f${i}.js`), `export const v${i} = ${i};\n`);
  }
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add files'], { cwd, stdio: 'pipe' });

  // Stage 1 reads 9 files; Stage 2 requests 3 more => only 1 read, 2 rejected with cap reached => critical UNVERIFIED => HUMAN_REQUIRED
  {
    const { ctl } = makeCtl({
      cwd,
      fakes: {
        reviewer: (a) => (a.stage === 'files'
          ? { value: { requestedFiles: Array.from({ length: 9 }, (_, i) => `f${i}.js`) }, usage: OK_USAGE, model: 'm' }
          : { value: PROPOSALS, usage: OK_USAGE, model: 'm' }),
        supervisor: (n) => {
          if (n === 1) return { needFactFiles: true, requestedFiles: ['f9.js', 'f10.js', '../secret.txt'], pendingClaims: ['check f10.js'] };
          return adj({
            factChecks: [{
              claim: 'f10.js invariant',
              critical: true,
              status: 'UNVERIFIED',
              evidenceSources: [],
              reason: 'f10.js was rejected due to file count cap',
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
    assert.equal(r.factVerification.checkedFiles.length, 10);
    assert.ok(r.factVerification.rejectedFiles.some((x) => x.path === 'f10.js' && x.reason === 'file count cap reached'));
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
