// Real-git integration for the unified Design path: the whole design file as
// gitEvidence ACTUALLY renders it must be recognised as sitting in one
// Reviewer request. Hand-written diff fixtures cannot prove that.
import { withReceipts } from './helpers/receiptEcho.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { captureBaseline, collectWorkerDelta } from '../src/reviewloop/gitEvidence.js';
import { readReviewTarget, assertTargetWithinOneChunk, designContentSha256 } from '../src/reviewloop/designTarget.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const PLAN = '# Plan\n- Goal: ship\n- Non-goals: none';
const DESIGN = '# Design\n中文 内容 with 多字节 text\n\n## Options\n- A: reuse\n\n## Assumptions\nNone\n';

function gitRepo() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rl-realgit-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  mkdirSync(path.join(cwd, 'docs'));
  writeFileSync(path.join(cwd, 'docs', 'keep.md'), 'keep');
  writeFileSync(path.join(cwd, 'README.md'), 'hi');
  g('add', '.');
  g('commit', '-qm', 'init');
  return cwd;
}

test('real git: a repo-root design file appears whole inside one Reviewer chunk', async () => {
  const cwd = gitRepo();
  const baseline = await captureBaseline({ cwd });
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
  const delta = await collectWorkerDelta({ cwd, baseline });
  assert.equal(delta.evidenceComplete, true);
  const target = await readReviewTarget({ cwd, reviewTarget: 'Prompt.md' });
  assert.equal(assertTargetWithinOneChunk({ diff: delta.diff, target, env: {} }), true);
  rmSync(cwd, { recursive: true, force: true });
});

test('real git: editing the file changes the delta fingerprint (a new round, never a stale PASS)', async () => {
  const cwd = gitRepo();
  const baseline = await captureBaseline({ cwd });
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
  const d1 = await collectWorkerDelta({ cwd, baseline });
  writeFileSync(path.join(cwd, 'Prompt.md'), `${DESIGN}\n## AC\n- observable\n`);
  const d2 = await collectWorkerDelta({ cwd, baseline });
  assert.notEqual(d1.fingerprint, d2.fingerprint);
  assert.ok(d2.diff.includes('## AC'), 'an UNCHANGED earlier paragraph and the new one are both in the cumulative diff');
  assert.ok(d2.diff.includes('## Options'));
  rmSync(cwd, { recursive: true, force: true });
});

test('real git: a subdirectory target is reviewable only where the runtime has an atomic symlink guard (documented limit)', async () => {
  const cwd = gitRepo();
  const baseline = await captureBaseline({ cwd });
  mkdirSync(path.join(cwd, 'docs', 'design'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs', 'design', 'Prompt.md'), DESIGN);
  const delta = await collectWorkerDelta({ cwd, baseline });
  if (process.platform === 'darwin') {
    assert.equal(delta.evidenceComplete, true);
  } else {
    assert.equal(delta.evidenceComplete, false);
    assert.match(delta.incompleteReasons.join(' '), /no atomic whole-path symlink guard/);
  }
  rmSync(cwd, { recursive: true, force: true });
});

test('real git end-to-end through the controller: PASS with the exact digest of the reviewed file', async () => {
  const cwd = gitRepo();
  let supervisorSaw = '';
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['git diff --check'], manifestFingerprint: 'fp' }),
    designReviewerFn: async (args) => ({
      value: args.stage === 'files'
        ? { requestedFiles: ['Prompt.md', 'README.md'] }
        : { proposals: [{ title: 'A', summary: 's', tradeoffs: 't' }] },
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'm',
    }),
    designSupervisorFn: async (args) => {
      supervisorSaw = String(args.prompt);
      return {
        value: withReceipts(args.prompt, {
          comparison: { verdict: 'MINOR_DIFF', reason: 'close', workerSummary: 'w', planConcern: null },
          blockingFindings: [], nonBlockingFindings: [], humanQuestions: [], designPassComment: 'Builds it.',
        }),
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'm',
      };
    },
  });
  const b = await ctl.begin({
    goal: 'Design it', cwd, taskType: 'design', contractText: PLAN, reviewTarget: 'Prompt.md',
  });
  writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(r.designSha256, designContentSha256(DESIGN));
  assert.ok(supervisorSaw.includes(DESIGN.trim()));
  assert.ok(r.designPassComment.endsWith(`designSha256: ${r.designSha256}`));

  // Code begin bound to that digest accepts the identical contract and refuses an edited one.
  const code = await ctl.begin({ goal: 'Implement', cwd, taskType: 'code', contractText: DESIGN, designSha256: r.designSha256 });
  assert.equal(code.taskType, 'code');
  await assert.rejects(
    () => ctl.begin({ goal: 'Implement', cwd, taskType: 'code', contractText: `${DESIGN}\nextra`, designSha256: r.designSha256 }),
    /does not match the approved Design/,
  );
  rmSync(cwd, { recursive: true, force: true });
});

test('begin warns when the target is in a subdirectory on a runtime without the atomic guard', async () => {
  const cwd = gitRepo();
  const ctl = createReviewLoopController({
    persistence: new MemoryPersistence(),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['git diff --check'], manifestFingerprint: 'fp' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
  });
  const b = await ctl.begin({
    goal: 'Design it', cwd, taskType: 'design', contractText: PLAN, reviewTarget: 'docs/design/Prompt.md',
  });
  const warned = (b.planWarnings ?? []).some((w) => /subdirectory/.test(w));
  assert.equal(warned, process.platform !== 'darwin');
  rmSync(cwd, { recursive: true, force: true });
});
