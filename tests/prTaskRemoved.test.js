// V11: the PR task type is gone, and stored PR-type loops are only read-only retired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';
import { makeHarness } from './helpers/reviewLoopHarness.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function schemaOf(tool) {
  const server = createReviewLoopMcpServer({ controller: { begin: async () => ({}), review: async () => ({}) } });
  const schema = (server._registeredTools ?? server.registeredTools)[tool].inputSchema;
  return schema.shape ?? schema._zod?.def?.shape ?? schema;
}

test('V11a: MCP schema rejects taskType "pr"; prContext/prNumber are explicit tripwires', async () => {
  const begin = schemaOf('reviewloop_begin');
  assert.equal(begin.taskType.safeParse('pr').success, false);
  assert.equal(begin.taskType.safeParse('code').success, true);
  assert.equal(begin.taskType.safeParse('design').success, true);
  const h = makeHarness();
  await assert.rejects(() => h.controller.begin({ goal: 'g', cwd: '/r', prContext: { prNumber: 1 } }), /PR task type removed; handle PR fixes per engineering\/README\.md PR stage/);
  await assert.rejects(() => h.controller.begin({ goal: 'g', cwd: '/r', prNumber: 5 }), /PR task type removed/);
  await assert.rejects(() => h.controller.begin({ goal: 'g', cwd: '/r', taskType: 'pr' }), /unknown taskType "pr"/);
});

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('V11b/N3: src and bin carry no PR watcher, wake, local PR-state persistence or detached spawn', () => {
  const banned = [/prWatcher|prWakeAdapter|prTaskEngine|prCli\b/, /PR_TASK_KEY|savePrTask|loadPrTask|initialPrTaskState/, /spawnPrWatcher/];
  // Detached child processes are only legitimate for Gate process-tree isolation (src/orchestrator), never for ReviewLoop controller code.
  for (const file of walk(path.join(REPO, 'src', 'reviewloop'))) {
    assert.equal(/detached\s*:\s*true/.test(readFileSync(file, 'utf8')), false, `${path.relative(REPO, file)} spawns a detached process`);
  }
  for (const file of [...walk(path.join(REPO, 'src')), path.join(REPO, 'bin', 'reviewloop.js')]) {
    const text = readFileSync(file, 'utf8');
    for (const re of banned) assert.equal(re.test(text), false, `${path.relative(REPO, file)} matches ${re}`);
  }
});

function retiredWorkflow(loopId) {
  return {
    reviewLoop: {
      loopId, state: 'REWORK', round: 2, reviewerCalls: 1, supervisorCalls: 0,
      objective: { loopId, taskType: 'pr', mode: 'LOCAL', goal: 'old pr task', repository: { root: '/old' }, prContext: { prNumber: 51 } },
    },
    prTask: { loopId, prNumber: 51, watcher: { pid: 4242 }, reviewTriggers: [] },
  };
}

test('V11c: controller.review on a stored PR-type loop reports retired and leaves the stored state untouched', async () => {
  const h = makeHarness();
  const before = retiredWorkflow('rl-old-pr');
  await h.persistence.writeWorkflowState('rl-old-pr', before);
  await assert.rejects(() => h.controller.review({ loopId: 'rl-old-pr' }), /PR session retired.*left unchanged/);
  assert.deepEqual(await h.persistence.readWorkflowState('rl-old-pr'), before);
});

test('V11c: CLI status/resume mark a stored PR-type loop retired; files are byte- and mtime-identical', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rl-retired-'));
  try {
    const dir = path.join(root, 'rl-old-pr');
    mkdirSync(dir);
    const file = path.join(dir, 'workflow.json');
    writeFileSync(file, JSON.stringify(retiredWorkflow('rl-old-pr')));
    const bytes = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    const env = { ...process.env, REVIEWLOOP_RUNTIME_DIR: root };
    const status = spawnSync('node', ['bin/reviewloop.js', 'status'], { cwd: REPO, env, encoding: 'utf8' });
    assert.match(status.stdout, /rl-old-pr.*\[RETIRED_PR\]/);
    const resume = spawnSync('node', ['bin/reviewloop.js', 'resume', '--loop', 'rl-old-pr'], { cwd: REPO, env, encoding: 'utf8' });
    assert.match(resume.stdout, /retired PR review/);
    const gone = spawnSync('node', ['bin/reviewloop.js', 'pr', 'status'], { cwd: REPO, env, encoding: 'utf8' });
    assert.notEqual(gone.status, 0);
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(statSync(file).mtimeMs, mtime);
    assert.deepEqual(readdirSync(dir), ['workflow.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V11d: a workflow.json with an unknown prTask key is read by a LOCAL task without error and the key survives', async () => {
  const h = makeHarness();
  const begun = await h.controller.begin({ goal: 'local task', cwd: '/r' });
  const state = await h.persistence.readWorkflowState(begun.loopId);
  await h.persistence.updateWorkflowState(begun.loopId, { prTask: { legacy: true } });
  const again = await h.persistence.readWorkflowState(begun.loopId);
  assert.deepEqual(again.prTask, { legacy: true });
  assert.equal(again.reviewLoop.loopId, state.reviewLoop.loopId);
});
