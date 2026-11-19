import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run, runExtendedChecks } from '../scripts/check-pr-handoff.js';
import {
  PrContractError,
  contractContentSha256,
  formatContractComments,
  upsertContractIndex,
} from '../src/reviewloop/prContract.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'reviewloop.js');

function initTempGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-cli-git-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Base\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'init']);
  git(['checkout', '-b', 'feat/cli']);
  return { dir, git };
}

test('reviewloop contract format & diff-check CLI work end-to-end', async () => {
  const { dir, git } = initTempGit();
  const planFile = path.join(dir, 'tmp-plan.md');
  const planText = '# Plan — CLI\n\nBody text\n';
  fs.writeFileSync(planFile, planText, 'utf8');

  const { stdout } = await execFileAsync('node', [
    CLI_PATH, 'contract', 'format',
    '--task-id', 'T-CLI',
    '--type', 'plan',
    '--version', 'v1.0',
    '--file', planFile,
    '--json',
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.sha256, contractContentSha256(planText));
  assert.equal(parsed.totalParts, 1);

  // Add an unapproved Plan.md on the feature branch -> diff-check must exit 1
  fs.writeFileSync(path.join(dir, 'Plan.md'), planText, 'utf8');
  git(['add', 'Plan.md']);
  git(['commit', '-m', 'add Plan.md']);

  await assert.rejects(
    () => execFileAsync('node', [CLI_PATH, 'contract', 'diff-check', '--cwd', dir, '--base', 'main', '--json']),
    (err) => {
      assert.equal(err.code, 1);
      const res = JSON.parse(err.stdout);
      assert.equal(res.ok, false);
      assert.equal(res.violations[0].path, 'Plan.md');
      return true;
    },
  );

  // When Plan.md is explicitly listed in --approved-asset, diff-check passes
  const { stdout: okOut } = await execFileAsync('node', [
    CLI_PATH, 'contract', 'diff-check',
    '--cwd', dir,
    '--base', 'main',
    '--approved-asset', 'Plan.md',
    '--json',
  ]);
  assert.equal(JSON.parse(okOut).ok, true);
});

test('check-pr-handoff.js keeps legacy behavior unchanged and supports --check-contract / --check-diff', async () => {
  const { dir, git } = initTempGit();
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const x = 1;\n', 'utf8');
  git(['add', 'src.js']);
  git(['commit', '-m', 'add code']);
  const head = git(['rev-parse', 'HEAD']).trim();

  const designText = '# Design — Handoff\n\n## Options\nA\n\n## Assumptions\nNone\n\n## Work Contract\nDo\n';
  const designSha = contractContentSha256(designText);
  const formatted = formatContractComments({
    taskId: 'T-HANDOFF',
    type: 'design',
    version: 'v1.0',
    content: designText,
    designSha256: designSha,
  });

  const prBodyBase = [
    '<!-- reviewloop-handoff head=' + head + ' stage=code loop=rl-1 -->',
    'built: x',
    'acceptance: ok',
    'verified: npm test',
    'risks: none',
  ].join('\n');
  const prBody = upsertContractIndex(prBodyBase, {
    taskId: 'T-HANDOFF',
    type: 'design',
    version: 'v1.0',
    commentIds: ['90001'],
    sha256: designSha,
    totalParts: 1,
  });

  // 1. Legacy synchronous run() without new flags
  const legacyRes = run(['54', '--stage', 'code'], () => ({ headRefOid: head, body: prBody }));
  assert.equal(legacyRes.code, 0);

  // 2. Extended --check-contract --check-diff PASS
  const runGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: head, baseRefName: 'main' });
    if (args[1].endsWith('/90001')) return JSON.stringify({ id: 90001, node_id: 'N9', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    if (args[1] === 'graphql') return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
    if (args.some((a) => String(a).endsWith('/protection'))) throw new PrContractError('PR_CONTRACT_NOT_FOUND', '404');
    if (args.some((a) => String(a).includes('/issues/54/comments'))) return JSON.stringify([]);
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  const extRes = await runExtendedChecks(
    ['54', '--stage', 'code', '--check-contract', '--check-diff', '--repo', 'Jiaze-Li/reviewloop', '--task-id', 'T-HANDOFF', '--type', 'design', '--design-sha', designSha, '--cwd', dir, '--base', 'main'],
    () => ({ headRefOid: head, body: prBody }),
    { runGh },
  );
  assert.equal(extRes.code, 0);
  assert.match(extRes.out, /合同核验 PASS/);
  assert.match(extRes.out, /localCheck: PASS/);
  assert.match(extRes.out, /remoteProtection: NOT_ENFORCED/);
  assert.match(extRes.out, /prBotStatus: MISSING/);

  // 3. Extended --check-diff FAIL when Design.md is committed without exemption
  fs.writeFileSync(path.join(dir, 'Design.md'), designText, 'utf8');
  git(['add', 'Design.md']);
  git(['commit', '-m', 'leak Design.md']);
  const head2 = git(['rev-parse', 'HEAD']).trim();
  const prBody2 = prBody.replace(head, head2);
  const failRes = await runExtendedChecks(
    ['54', '--stage', 'code', '--check-diff', '--repo', 'Jiaze-Li/reviewloop', '--cwd', dir, '--base', 'main'],
    () => ({ headRefOid: head2, body: prBody2 }),
    { runGh },
  );
  assert.equal(failRes.code, 1);
  assert.match(failRes.out, /localCheck: FAIL/);
});
