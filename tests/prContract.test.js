import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureBaseline, collectWorkerDelta } from '../src/reviewloop/gitEvidence.js';
import {
  PR_CONTRACT_COMMENT_MAX_CHARS,
  PrContractError,
  checkFinalPrDiff,
  contractContentSha256,
  extractContractCommentPart,
  formatContractComments,
  parseContractIndex,
  recoverPrContract,
  runFinalPrGateReport,
  upsertContractIndex,
  verifyDesignArchiveAndCleanupReady,
} from '../src/reviewloop/prContract.js';

function makeTempDir(prefix = 'rl-pr-contract-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initTempRepo() {
  const dir = makeTempDir('rl-pr-git-');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'Plan.md'), '# Historical Plan\n', 'utf8');
  git(dir, ['add', 'README.md', 'Plan.md']);
  git(dir, ['commit', '-m', 'init main with historical Plan.md']);
  git(dir, ['checkout', '-b', 'feat/test-pr']);
  return dir;
}

test('formatContractComments & extractContractCommentPart handle literal </details> and header markers', () => {
  const content = [
    '# Design — Literal Details Test',
    '',
    'Prose containing literal </details> tag and <!-- fake:end --> inside code/text.',
    '',
    '```html',
    '<details><summary>inner</summary>hello</details>',
    '```',
  ].join('\n');

  const formatted = formatContractComments({
    taskId: 'TASK-1',
    type: 'design',
    version: 'v1.0',
    content,
    designSha256: contractContentSha256(content),
  });
  assert.equal(formatted.totalParts, 1);
  // Prepend header prose that mentions literal marker text before the real begin marker.
  const bodyWithHeaderMention = `注意：不要误用正文里的 <!-- reviewloop-design:TASK-1:v1.0:begin -->。\n\n${formatted.comments[0].body}`;
  // Wait: if header prose literally contains the exact begin marker, regex matches the first one;
  // README forbids putting an exact duplicate begin marker before the real one, whereas
  // mentioning `<!-- reviewloop-design:... -->` or `</details>` in prose is safe.
  const safeHeaderBody = `说明：正文可能含 </details> 标签。\n\n${formatted.comments[0].body}`;
  const extracted = extractContractCommentPart(safeHeaderBody, {
    taskId: 'TASK-1',
    type: 'design',
    version: 'v1.0',
  });
  assert.equal(extracted.rawContent.trim(), content.trim());
  assert.equal(contractContentSha256(extracted.rawContent), formatted.sha256);
});

test('formatContractComments & recoverPrContract handle >60,000 char multi-part Plan roundtrip', async () => {
  const line = 'A'.repeat(120) + '\n';
  const longPlan = '# Plan — Long\n\n' + line.repeat(600); // ~72,600 chars
  assert.ok(longPlan.length > PR_CONTRACT_COMMENT_MAX_CHARS);

  const formatted = formatContractComments({
    taskId: 'TASK-LONG',
    type: 'plan',
    version: 'v1.0',
    content: longPlan,
  });
  assert.equal(formatted.totalParts, 2);

  const prBody = upsertContractIndex('## Plan Brief\n', {
    taskId: 'TASK-LONG',
    type: 'plan',
    version: 'v1.0',
    commentIds: ['1001', '1002'],
    sha256: formatted.sha256,
    totalParts: 2,
  });

  const runGh = async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ body: prBody, headRefOid: 'a'.repeat(40), baseRefName: 'main', headRefName: 'feat/x', url: 'https://github.com/Jiaze-Li/reviewloop/pull/99' });
    }
    if (args[0] === 'api' && args[1] === 'repos/Jiaze-Li/reviewloop/issues/comments/1001') {
      return JSON.stringify({ id: 1001, node_id: 'IC_1', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/99', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    }
    if (args[0] === 'api' && args[1] === 'repos/Jiaze-Li/reviewloop/issues/comments/1002') {
      return JSON.stringify({ id: 1002, node_id: 'IC_2', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/99', user: { login: 'Jiaze-Li' }, body: formatted.comments[1].body });
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };

  const recovered = await recoverPrContract({
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    taskId: 'TASK-LONG',
    type: 'plan',
    runGh,
  });
  assert.equal(recovered.sha256, formatted.sha256);
  assert.equal(recovered.content, longPlan.trim());
  assert.equal(recovered.totalParts, 2);
  assert.equal(recovered.editHistoryVerified, true);
  assert.equal(recovered.edited, false);

  // Must fail closed (never truncate) when requireMcpLimit=true and >64 KiB
  await assert.rejects(
    () => recoverPrContract({
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 99,
      taskId: 'TASK-LONG',
      type: 'plan',
      requireMcpLimit: true,
      runGh,
    }),
    (err) => err instanceof PrContractError && err.code === 'PR_CONTRACT_SIZE_EXCEEDED',
  );
});

test('parseContractIndex & upsertContractIndex enforce single current and reject multiple current', () => {
  const sha1 = 'a'.repeat(64);
  const sha2 = 'b'.repeat(64);
  let body = upsertContractIndex('Brief', {
    taskId: 'T1',
    type: 'plan',
    version: 'v1.0',
    commentIds: ['11111'],
    sha256: sha1,
    totalParts: 1,
  });
  body = upsertContractIndex(body, {
    taskId: 'T1',
    type: 'plan',
    version: 'v1.1',
    commentIds: ['22222'],
    sha256: sha2,
    totalParts: 1,
  });
  const rows = parseContractIndex(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'superseded');
  assert.equal(rows[1].status, 'current');

  const duplicateCurrentBody = [
    '### 合同索引',
    '| 任务 | 类型 | 版本 | 评论 ID | SHA-256 | 分段 | 状态 |',
    '|---|---|---|---|---|---|---|',
    `| T1 | Plan | v1.0 | 11111 | \`${sha1}\` | 1/1 | current |`,
    `| T1 | Plan | v1.1 | 22222 | \`${sha2}\` | 1/1 | current |`,
  ].join('\n');
  assert.throws(
    () => parseContractIndex(duplicateCurrentBody),
    (err) => err instanceof PrContractError && err.code === 'PR_CONTRACT_MULTIPLE_CURRENT',
  );
});

test('recoverPrContract fail-closed negative cases & GraphQL edit-history degradation', async () => {
  const planText = '# Plan — Test\n\nContent';
  const formatted = formatContractComments({
    taskId: 'T1',
    type: 'plan',
    version: 'v1.0',
    content: planText,
  });
  const prBody = upsertContractIndex('', {
    taskId: 'T1',
    type: 'plan',
    version: 'v1.0',
    commentIds: ['55555'],
    sha256: formatted.sha256,
    totalParts: 1,
  });

  const baseGh = (overrides = {}) => async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: overrides.prBody ?? prBody, headRefOid: 'a'.repeat(40) });
    if (args[1]?.includes('/issues/comments/')) {
      if (overrides.commentError) throw overrides.commentError;
      return JSON.stringify({
        id: 55555,
        node_id: 'IC_5',
        issue_url: overrides.issueUrl ?? 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/1',
        user: { login: overrides.author ?? 'Jiaze-Li' },
        body: overrides.commentBody ?? formatted.comments[0].body,
      });
    }
    if (args[1] === 'graphql') {
      if (overrides.graphqlError) throw overrides.graphqlError;
      return JSON.stringify({
        data: {
          node: {
            lastEditedAt: overrides.edited ? '2026-11-19T00:00:00Z' : null,
            userContentEdits: { totalCount: overrides.edited ? 1 : 0 },
          },
        },
      });
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  // 1. Untrusted author
  await assert.rejects(
    () => recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 1, taskId: 'T1', type: 'plan', runGh: baseGh({ author: 'evil-user' }) }),
    (err) => err.code === 'PR_CONTRACT_UNTRUSTED_AUTHOR',
  );

  // 2. Tampered comment body (hash mismatch)
  const tamperedBody = formatted.comments[0].body.replace('Content', 'Tampered');
  await assert.rejects(
    () => recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 1, taskId: 'T1', type: 'plan', runGh: baseGh({ commentBody: tamperedBody }) }),
    (err) => err.code === 'PR_CONTRACT_HASH_MISMATCH',
  );

  // 3. Version conflict
  await assert.rejects(
    () => recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 1, taskId: 'T1', type: 'plan', version: 'v2.0', runGh: baseGh() }),
    (err) => err.code === 'PR_CONTRACT_VERSION_CONFLICT',
  );

  // 4. Missing / 404 comment
  await assert.rejects(
    () => recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 1, taskId: 'T1', type: 'plan', runGh: baseGh({ commentError: new Error('404 Not Found') }) }),
    (err) => err.message.includes('404'),
  );

  // 4b. F005: comment from another PR/issue in the same repo must be rejected
  await assert.rejects(
    () => recoverPrContract({
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 1,
      taskId: 'T1',
      type: 'plan',
      runGh: baseGh({ issueUrl: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/999' }),
    }),
    (err) => err.code === 'PR_CONTRACT_COMMENT_PR_MISMATCH',
  );

  // 5. GraphQL edit history unreadable -> degrades with warning while hash passes
  const degraded = await recoverPrContract({
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 1,
    taskId: 'T1',
    type: 'plan',
    runGh: baseGh({ graphqlError: new Error('403 Forbidden') }),
  });
  assert.equal(degraded.editHistoryVerified, false);
  assert.ok(degraded.warnings.some((w) => w.includes('编辑历史未核验')));

  // 6. Edited comment with matching hash -> warns edited: true
  const editedOk = await recoverPrContract({
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 1,
    taskId: 'T1',
    type: 'plan',
    runGh: baseGh({ edited: true }),
  });
  assert.equal(editedOk.edited, true);
  assert.ok(editedOk.warnings.some((w) => w.includes('编辑记录')));
});

test('recoverPrContract rejects out-of-order / missing multi-part comments & Design anchor mismatch', async () => {
  const content = '# Design — Multi\n\n' + 'B'.repeat(70);
  const formatted = formatContractComments({
    taskId: 'T2',
    type: 'design',
    version: 'v1.0',
    content,
    maxCharsPerPart: 50,
  });
  assert.equal(formatted.totalParts, 2);

  const prBody = upsertContractIndex('', {
    taskId: 'T2',
    type: 'design',
    version: 'v1.0',
    commentIds: ['20001', '20002'],
    sha256: formatted.sha256,
    totalParts: 2,
  });

  // Swap part 2 into comment 20001 slot -> out-of-order
  const swappedGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: 'a'.repeat(40) });
    if (args[1].endsWith('/20001')) return JSON.stringify({ id: 20001, node_id: 'N1', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/1', user: { login: 'Jiaze-Li' }, body: formatted.comments[1].body });
    if (args[1].endsWith('/20002')) return JSON.stringify({ id: 20002, node_id: 'N2', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/1', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
  };
  await assert.rejects(
    () => recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 1, taskId: 'T2', type: 'design', runGh: swappedGh }),
    (err) => err.code === 'PR_CONTRACT_PART_MISMATCH',
  );

  // Design anchor mismatch
  const normalGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: 'a'.repeat(40) });
    if (args[1].endsWith('/20001')) return JSON.stringify({ id: 20001, node_id: 'N1', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/1', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    if (args[1].endsWith('/20002')) return JSON.stringify({ id: 20002, node_id: 'N2', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/1', user: { login: 'Jiaze-Li' }, body: formatted.comments[1].body });
    return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
  };
  await assert.rejects(
    () => recoverPrContract({
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 1,
      taskId: 'T2',
      type: 'design',
      expectedDesignSha256: 'f'.repeat(64),
      runGh: normalGh,
    }),
    (err) => err.code === 'PR_CONTRACT_DESIGN_ANCHOR_MISMATCH',
  );
});

test('verifyDesignArchiveAndCleanupReady enforces 4 preconditions and protects captureBaseline', async () => {
  const repoDir = initTempRepo();
  const runtimeDir = makeTempDir('rl-runtime-');
  const designText = '# Design — Clean Test\n\n## Options\nA\n\n## Assumptions\nNone\n\n## Work Contract\nDo X\n';
  const designSha = contractContentSha256(designText);
  const designFile = 'Design-test.md';
  fs.writeFileSync(path.join(repoDir, designFile), designText, 'utf8');

  // Create PASS loop in runtimeDir
  const loopId = 'rl-20261119000000-testpass';
  fs.mkdirSync(path.join(runtimeDir, loopId), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, loopId, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: designFile, designSha256: designSha, round: 1 },
      },
    }),
    'utf8',
  );

  const formatted = formatContractComments({
    taskId: 'T-CLEAN',
    type: 'design',
    version: 'v1.0',
    content: designText,
    designSha256: designSha,
  });
  const prBody = upsertContractIndex('', {
    taskId: 'T-CLEAN',
    type: 'design',
    version: 'v1.0',
    commentIds: ['77777'],
    sha256: designSha,
    totalParts: 1,
  });

  const runGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: 'a'.repeat(40) });
    if (args[1].endsWith('/77777')) return JSON.stringify({ id: 77777, node_id: 'N7', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/54', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
  };

  // Before cleanup: captureBaseline sees the untracked design file in untrackedHashes
  const dirtyBaseline = await captureBaseline({ cwd: repoDir });
  assert.ok(Object.hasOwn(dirtyBaseline.untrackedHashes, designFile));

  // Negative 1: missing PASS anchor
  await assert.rejects(
    () => verifyDesignArchiveAndCleanupReady({
      cwd: repoDir,
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 54,
      taskId: 'T-CLEAN',
      loopId: 'rl-missing',
      runtimeDir,
      clean: true,
      runGh,
    }),
    (err) => err.code === 'PR_CONTRACT_NO_DESIGN_PASS',
  );
  assert.ok(fs.existsSync(path.join(repoDir, designFile)));

  // Negative 2: local file drift refuses cleanup
  fs.writeFileSync(path.join(repoDir, designFile), `${designText}\nDRIFT`, 'utf8');
  await assert.rejects(
    () => verifyDesignArchiveAndCleanupReady({
      cwd: repoDir,
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 54,
      taskId: 'T-CLEAN',
      loopId,
      runtimeDir,
      clean: true,
      runGh,
    }),
    (err) => err.code === 'PR_CONTRACT_LOCAL_DRIFT',
  );
  assert.ok(fs.existsSync(path.join(repoDir, designFile)));
  fs.writeFileSync(path.join(repoDir, designFile), designText, 'utf8');

  // Read-only check leaves file on disk
  const dryRun = await verifyDesignArchiveAndCleanupReady({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    taskId: 'T-CLEAN',
    loopId,
    runtimeDir,
    clean: false,
    runGh,
  });
  assert.equal(dryRun.readyToClean, true);
  assert.equal(dryRun.cleaned, false);
  assert.ok(fs.existsSync(path.join(repoDir, designFile)));

  // Also verify F002: when --loop is omitted and a newer unrelated Design PASS exists,
  // verifyDesignArchiveAndCleanupReady still binds to the recovered Design's sha256.
  const newerOtherLoop = 'rl-20261119999999-other';
  fs.mkdirSync(path.join(runtimeDir, newerOtherLoop), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, newerOtherLoop, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: 'Design-other.md', designSha256: 'e'.repeat(64), round: 1 },
      },
    }),
    'utf8',
  );
  const dryRunNoLoop = await verifyDesignArchiveAndCleanupReady({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    taskId: 'T-CLEAN',
    runtimeDir,
    clean: false,
    runGh,
  });
  assert.equal(dryRunNoLoop.loopId, loopId);
  assert.equal(dryRunNoLoop.readyToClean, true);

  // Also verify F003: symlink parent directory is refused by lstatNoSymlinks
  const realSub = path.join(repoDir, 'real-sub');
  const linkSub = path.join(repoDir, 'link-sub');
  fs.mkdirSync(realSub, { recursive: true });
  fs.writeFileSync(path.join(realSub, 'Design-sym.md'), designText, 'utf8');
  fs.symlinkSync(realSub, linkSub);
  fs.writeFileSync(
    path.join(runtimeDir, loopId, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: 'link-sub/Design-sym.md', designSha256: designSha, round: 1 },
      },
    }),
    'utf8',
  );
  await assert.rejects(
    () => verifyDesignArchiveAndCleanupReady({
      cwd: repoDir,
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 54,
      taskId: 'T-CLEAN',
      loopId,
      runtimeDir,
      clean: true,
      runGh,
    }),
    (err) => err.code === 'PR_CONTRACT_LOCAL_FILE_INVALID',
  );
  assert.ok(fs.existsSync(path.join(realSub, 'Design-sym.md')));

  // Clean up F003 symlink fixtures before checking clean captureBaseline
  fs.unlinkSync(linkSub);
  fs.rmSync(realSub, { recursive: true, force: true });

  // Restore workflow.json for the clean: true check below
  fs.writeFileSync(
    path.join(runtimeDir, loopId, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: designFile, designSha256: designSha, round: 1 },
      },
    }),
    'utf8',
  );

  // Explicit clean: true removes ONLY Design-test.md (leaves historical Plan.md untouched)
  const cleaned = await verifyDesignArchiveAndCleanupReady({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    taskId: 'T-CLEAN',
    loopId,
    runtimeDir,
    clean: true,
    runGh,
  });
  assert.equal(cleaned.cleaned, true);
  assert.ok(!fs.existsSync(path.join(repoDir, designFile)));
  assert.ok(fs.existsSync(path.join(repoDir, 'Plan.md')));

  // After cleanup: captureBaseline has empty untrackedHashes and attributes new Worker files cleanly
  const cleanBaseline = await captureBaseline({ cwd: repoDir });
  assert.equal(Object.keys(cleanBaseline.untrackedHashes).length, 0);
  fs.writeFileSync(path.join(repoDir, 'new-worker-file.js'), 'export const ok = true;\n', 'utf8');
  const delta = await collectWorkerDelta({ cwd: repoDir, baseline: cleanBaseline });
  assert.ok(delta.evidenceComplete !== false);
  assert.ok(delta.changedFiles.includes('new-worker-file.js'));

  // Negative 3: tracked file is never cleaned
  await fsp.writeFile(path.join(repoDir, 'Design-tracked.md'), designText, 'utf8');
  git(repoDir, ['add', 'Design-tracked.md']);
  git(repoDir, ['commit', '-m', 'track design']);
  fs.writeFileSync(
    path.join(runtimeDir, loopId, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: 'Design-tracked.md', designSha256: designSha, round: 1 },
      },
    }),
    'utf8',
  );
  await assert.rejects(
    () => verifyDesignArchiveAndCleanupReady({
      cwd: repoDir,
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 54,
      taskId: 'T-CLEAN',
      loopId,
      runtimeDir,
      clean: true,
      runGh,
    }),
    (err) => err.code === 'PR_CONTRACT_TRACKED_FILE_REFUSED',
  );
  assert.ok(fs.existsSync(path.join(repoDir, 'Design-tracked.md')));
});

test('checkFinalPrDiff & runFinalPrGateReport block task contracts, allow approvedAssets & historical files, and split 3 states', async () => {
  const repoDir = initTempRepo();
  const archivedContent = '# Plan — Archived\n\nSecret contract';
  const archivedSha = contractContentSha256(archivedContent);

  // Add 1) approved long-term architecture doc, 2) unapproved task Design.v1.md,
  // 3) disguised copy, 4) F004 non-ASCII filename & non-ASCII disguised copy under quotePath=true
  git(repoDir, ['config', 'core.quotePath', 'true']);
  fs.mkdirSync(path.join(repoDir, 'docs', '中文'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'docs/Architecture-Design.md'), '# Long-term Arch\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'Design.v1.md'), '# Task Design\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'disguised-notes.md'), archivedContent, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'docs/中文/Design.md'), '# Non-ASCII Design\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, '文档.md'), archivedContent, 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'test diff']);
  const headOid = git(repoDir, ['rev-parse', 'HEAD']).trim();

  // Historical main/Plan.md was NOT modified on this branch -> must NOT be flagged
  const diffRes = await checkFinalPrDiff({
    cwd: repoDir,
    baseRef: 'main',
    approvedAssets: ['docs/Architecture-Design.md'],
    archivedContractHashes: [archivedSha],
  });
  assert.equal(diffRes.ok, false);
  const violationPaths = diffRes.violations.map((v) => v.path).sort();
  assert.deepEqual(violationPaths, ['Design.v1.md', 'disguised-notes.md', 'docs/中文/Design.md', '文档.md']);

  // Now test runFinalPrGateReport 3-state separation
  const prBody = upsertContractIndex('', {
    taskId: 'T-DIFF',
    type: 'plan',
    version: 'v1.0',
    commentIds: ['88888'],
    sha256: archivedSha,
    totalParts: 1,
  });
  const runGh = async (args) => {
    if (args[0] === 'pr') {
      return JSON.stringify({ body: prBody, headRefOid: headOid, baseRefName: 'main' });
    }
    if (args.some((a) => String(a).endsWith('/branches/main/protection'))) {
      throw new PrContractError('PR_CONTRACT_NOT_FOUND', 'HTTP 404 Branch not protected');
    }
    if (args.some((a) => String(a).includes('/issues/54/comments'))) {
      return JSON.stringify([
        {
          id: 1,
          user: { login: 'spoof-user' },
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${headOid}"} -->`,
        },
        {
          id: 2,
          user: { login: 'claude-review-bot[bot]' },
          created_at: '2026-11-19T00:00:00Z',
          updated_at: '2026-11-19T00:00:00Z',
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${headOid}"} -->\nlastReviewedHead: \`${headOid}\`\nStatus: READY`,
        },
      ]);
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  const report = await runFinalPrGateReport({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    approvedAssets: ['docs/Architecture-Design.md'],
    runGh,
  });
  assert.equal(report.localCheck.status, 'FAIL');
  assert.equal(report.remoteProtection.status, 'NOT_ENFORCED');
  assert.equal(report.prBotStatus.status, 'READY');

  // F001 regression: spoofed comment alone is MISSING; stale head from trusted bot is PENDING
  const staleGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: headOid, baseRefName: 'main' });
    if (args.some((a) => String(a).endsWith('/branches/main/protection'))) throw new PrContractError('PR_CONTRACT_NOT_FOUND', '404');
    if (args.some((a) => String(a).includes('/issues/54/comments'))) {
      return JSON.stringify([
        {
          id: 10,
          user: { login: 'spoof-user' },
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${headOid}"} -->`,
        },
        {
          id: 11,
          user: { login: 'claude-review-bot[bot]' },
          created_at: '2026-11-19T00:00:00Z',
          updated_at: '2026-11-19T00:00:00Z',
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${'0'.repeat(40)}"} -->`,
        },
      ]);
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const staleReport = await runFinalPrGateReport({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    approvedAssets: ['docs/Architecture-Design.md'],
    runGh: staleGh,
  });
  assert.equal(staleReport.prBotStatus.status, 'PENDING');

  // F001 highest-ID regression: even if an older comment ID has a newer updated_at,
  // inspectPrBotStatus must select the trusted bot's comment with the highest ID.
  const highestIdGh = async (args) => {
    if (args[0] === 'pr') return JSON.stringify({ body: prBody, headRefOid: headOid, baseRefName: 'main' });
    if (args.some((a) => String(a).endsWith('/branches/main/protection'))) throw new PrContractError('PR_CONTRACT_NOT_FOUND', '404');
    if (args.some((a) => String(a).includes('/issues/54/comments'))) {
      return JSON.stringify([
        {
          id: 50,
          user: { login: 'claude-review-bot[bot]' },
          created_at: '2026-11-19T00:00:00Z',
          updated_at: '2026-11-19T05:00:00Z', // newer updated_at on older ID
          body: `<!-- jiaze-review-session:v1 {"status":"READY","lastReviewedHead":"${headOid}"} -->`,
        },
        {
          id: 99,
          user: { login: 'claude-review-bot[bot]' },
          created_at: '2026-11-19T01:00:00Z',
          updated_at: '2026-11-19T01:00:00Z', // highest ID
          body: `<!-- jiaze-review-session:v1 {"status":"REWORK","lastReviewedHead":"${headOid}"} -->`,
        },
      ]);
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const highestIdReport = await runFinalPrGateReport({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 54,
    approvedAssets: ['docs/Architecture-Design.md'],
    runGh: highestIdGh,
  });
  assert.equal(highestIdReport.prBotStatus.status, 'REWORK');
});

test('AC08 simulated end-to-end lifecycle: empty-tree Plan -> Design PASS & clean -> Code recovery -> final diff guard', async () => {
  const repoDir = initTempRepo();
  const runtimeDir = makeTempDir('rl-e2e-');

  // 1. Plan: branch off main, empty-tree bootstrap commit + PR comment archive + index
  git(repoDir, ['checkout', '-b', 'feat/e2e-task']);
  git(repoDir, ['commit', '--allow-empty', '-m', 'chore: bootstrap plan PR']);
  const planText = '# Plan — E2E\n\n## Goal\nDeliver feature X cleanly.\n';
  const planFmt = formatContractComments({ taskId: 'T-E2E', type: 'plan', version: 'v1.0', content: planText });
  let prBody = upsertContractIndex('## Brief\nSummary\n', {
    taskId: 'T-E2E',
    type: 'plan',
    version: 'v1.0',
    commentIds: ['1001'],
    sha256: planFmt.sha256,
    totalParts: 1,
  });

  const comments = {
    1001: {
      id: 1001,
      node_id: 'N1001',
      issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/99',
      user: { login: 'Jiaze-Li' },
      body: planFmt.comments[0].body,
    },
  };
  const runGh = async (args) => {
    if (args[0] === 'pr') {
      const headRefOid = git(repoDir, ['rev-parse', 'HEAD']).trim();
      return JSON.stringify({ body: prBody, headRefOid, baseRefName: 'main' });
    }
    if (args[1]?.includes('/issues/comments/')) {
      const id = Number(args[1].split('/').pop());
      return JSON.stringify(comments[id]);
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
    }
    if (args.some((a) => String(a).endsWith('/branches/main/protection'))) {
      throw new PrContractError('PR_CONTRACT_NOT_FOUND', 'HTTP 404');
    }
    if (args.some((a) => String(a).includes('/issues/99/comments'))) {
      return JSON.stringify([]);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };

  // Recover Plan in a fresh session
  const recoveredPlan = await recoverPrContract({
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    taskId: 'T-E2E',
    type: 'plan',
    runGh,
  });
  assert.equal(recoveredPlan.content, planText.trim());

  // 2. Design: create untracked working file, record local PASS anchor, archive & clean
  const designFile = 'Design.T-E2E.md';
  const designText = '# Design — E2E\n\n## Options\nA\n\n## Assumptions\nNone\n\n## Work Contract\nImplement X\n';
  fs.writeFileSync(path.join(repoDir, designFile), designText, 'utf8');
  const designSha = contractContentSha256(designText);

  const loopId = 'rl-20261119000000-e2epass';
  fs.mkdirSync(path.join(runtimeDir, loopId), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, loopId, 'workflow.json'),
    JSON.stringify({
      reviewLoop: {
        state: 'PASS',
        designReview: { reviewTarget: designFile, designSha256: designSha, round: 1 },
      },
    }),
    'utf8',
  );

  const designFmt = formatContractComments({
    taskId: 'T-E2E',
    type: 'design',
    version: 'v1.0',
    content: designText,
    designSha256: designSha,
  });
  comments[1002] = {
    id: 1002,
    node_id: 'N1002',
    issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/99',
    user: { login: 'Jiaze-Li' },
    body: designFmt.comments[0].body,
  };
  prBody = upsertContractIndex(prBody, {
    taskId: 'T-E2E',
    type: 'design',
    version: 'v1.0',
    commentIds: ['1002'],
    sha256: designSha,
    totalParts: 1,
  });

  const cleanupRes = await verifyDesignArchiveAndCleanupReady({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    taskId: 'T-E2E',
    loopId,
    runtimeDir,
    clean: true,
    runGh,
  });
  assert.equal(cleanupRes.cleaned, true);
  assert.equal(fs.existsSync(path.join(repoDir, designFile)), false);

  // 3. Code: recover frozen Design with designSha256, commit code change, and verify final PR gate
  const recoveredDesign = await recoverPrContract({
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    taskId: 'T-E2E',
    type: 'design',
    expectedDesignSha256: designSha,
    runGh,
  });
  assert.equal(recoveredDesign.content, designText.trim());

  fs.writeFileSync(path.join(repoDir, 'feature.js'), 'export const x = 1;\n', 'utf8');
  git(repoDir, ['add', 'feature.js']);
  git(repoDir, ['commit', '-m', 'feat: implement x']);

  const cleanGate = await runFinalPrGateReport({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    runGh,
  });
  assert.equal(cleanGate.localCheck.status, 'PASS');
  assert.deepEqual(cleanGate.localCheck.diff.checkedFiles, [{ status: 'A', path: 'feature.js' }]);
  assert.equal(cleanGate.remoteProtection.status, 'NOT_ENFORCED');
  assert.equal(cleanGate.prBotStatus.status, 'MISSING');

  // Negative: wrong designSha256 is rejected
  await assert.rejects(
    () => recoverPrContract({
      repo: 'Jiaze-Li/reviewloop',
      prNumber: 99,
      taskId: 'T-E2E',
      type: 'design',
      expectedDesignSha256: '0'.repeat(64),
      runGh,
    }),
    (err) => err.code === 'PR_CONTRACT_DESIGN_ANCHOR_MISMATCH',
  );

  // Negative: committing a task-level Plan.md on the task branch fails the final diff guard
  fs.writeFileSync(path.join(repoDir, 'Plan.md'), '# Sneaky Plan\n', 'utf8');
  git(repoDir, ['add', 'Plan.md']);
  git(repoDir, ['commit', '-m', 'chore: accidentally commit Plan.md']);
  const dirtyGate = await runFinalPrGateReport({
    cwd: repoDir,
    repo: 'Jiaze-Li/reviewloop',
    prNumber: 99,
    runGh,
  });
  assert.equal(dirtyGate.localCheck.status, 'FAIL');
  assert.equal(dirtyGate.localCheck.diff.violations.some((v) => v.path === 'Plan.md'), true);
});
