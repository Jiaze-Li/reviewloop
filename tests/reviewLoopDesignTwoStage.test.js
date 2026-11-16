// Two-stage Design review: Reviewer independent proposal + Supervisor adjudication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  validateAdjudication, validateProposals, validateFileRequest, decideDesignTransition, finalizePassComment,
  collectDesignContext, readRequestedFiles, DESIGN_LIMITS,
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
