// Tests for scripts/doctor.js — deterministic ReviewLoop prerequisite checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkGit,
  checkNode,
  checkRepoInvariants,
  checkReviewerSupervisorPools,
  checkGlobalPolicy,
  runDoctor,
} from '../scripts/doctor.js';
import { installGlobal } from '../bin/install-plugin.js';

const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));

function fakeExec(map) {
  return (command) => {
    if (Object.prototype.hasOwnProperty.call(map, command)) {
      const v = map[command];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`command not found: ${command}`);
  };
}

function frontendExec() {
  const mcp = { claude: false, codex: false };
  return (command, args = []) => {
    if (args[0] === '--version') return `${command} test\n`;
    if ((command === 'claude' || command === 'codex') && args[0] === 'mcp') {
      const action = args[1];
      if (action === 'add') { mcp[command] = true; return 'added\n'; }
      if (action === 'remove') { if (!mcp[command]) throw new Error('not configured'); mcp[command] = false; return 'removed\n'; }
      if (action === 'get') { if (!mcp[command]) throw new Error('not configured'); return 'ok\n'; }
    }
    throw new Error(`unexpected: ${command} ${args.join(' ')}`);
  };
}

async function freshGlobalHome(tag) {
  const home = path.join('/tmp', `reviewloop-doctor-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(home, '.gemini', 'config');
  await mkdir(home, { recursive: true });
  await installGlobal({
    configDir,
    homeDir: home,
    policyFile: COMMON,
    mcpBin: '/opt/reviewloop/bin/reviewloop-mcp.js',
    nodeBin: '/usr/bin/node',
    execFileSync: frontendExec(),
  });
  return { home, configDir };
}

test('checkGit / checkNode report local runtime prerequisites', () => {
  assert.deepEqual(checkGit({ execSync: fakeExec({ 'git --version': 'git version 2.42.0\n' }) }), {
    name: 'git', ok: true, version: 'git version 2.42.0',
  });
  assert.equal(checkNode().ok, true);
  assert.equal(checkNode({ env: { npm_config_node_version: 'v22.0.0' } }).ok, true);
  assert.equal(checkNode({ env: { npm_config_node_version: 'v18.0.0' } }).ok, false);
});

test('repo invariants: reviewer+supervisor only, ReviewLoop COMMON, no retired concepts', () => {
  const r = checkRepoInvariants();
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.commonBytes <= 2560);
});

test('reviewer + supervisor pools have eligible internal candidates', () => {
  const r = checkReviewerSupervisorPools();
  assert.equal(r.ok, true);
  assert.ok(r.eligible.reviewer.length > 0 && r.eligible.supervisor.length > 0);
  // No family is high-context any more: every policy candidate is auto-eligible.
  assert.deepEqual(r.highContext.reviewer, []);
  assert.deepEqual(r.highContext.supervisor, []);
  assert.ok(r.eligible.reviewer.includes('agy:gemini-reviewer') && r.eligible.supervisor.includes('agy:gemini-supervisor'));
});

test('runDoctor passes on core prerequisites and reports Worker as external', () => {
  const lines = [];
  const report = runDoctor({
    execSync: fakeExec({ 'git --version': 'git version 2.42.0' }),
    log: (l) => lines.push(l),
    env: {},
  });
  assert.equal(report.ok, true);
  assert.ok(lines.some((l) => l.includes('Worker = external')));
  assert.ok(!lines.some((l) => /Executor = Sonnet|Planner pool|Front Agent/.test(l)));
  assert.ok(lines.includes('doctor: all core prerequisites satisfied'));
});

test('a stale / absent global install is a warning, never a doctor failure', async () => {
  const { home, configDir } = await freshGlobalHome('stale');
  try {
    await writeFile(path.join(home, '.codex', 'AGENTS.md'), '<!-- REVIEWLOOP-GLOBAL-POLICY:BEGIN -->\nnot the policy\n<!-- REVIEWLOOP-GLOBAL-POLICY:END -->\n');
    const policy = checkGlobalPolicy({ homeDir: home, configDir, policyFile: COMMON });
    assert.equal(policy.ok, false);
    assert.equal(policy.frontends.codex.reason, 'stale-content');

    const lines = [];
    const report = runDoctor({
      execSync: fakeExec({ 'git --version': 'git version 2.42.0' }),
      log: (l) => lines.push(l),
      env: {},
    });
    // doctor's own checkGlobalPolicy runs against the real HOME (not our
    // fixture); regardless, a global-policy issue is never fatal.
    assert.equal(report.results.repo_invariants.ok, true);
    assert.equal(report.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkGlobalPolicy flags a leftover legacy SuperGPT block', async () => {
  const { home, configDir } = await freshGlobalHome('legacy');
  try {
    const f = path.join(home, '.claude', 'CLAUDE.md');
    await writeFile(f, `${readFileSync(f, 'utf8')}\n<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->\nold\n<!-- SUPERGPT-GLOBAL-POLICY:END -->\n`);
    const policy = checkGlobalPolicy({ homeDir: home, configDir, policyFile: COMMON });
    assert.ok(policy.issues.some((i) => /legacy SuperGPT/.test(i)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('package.json exposes the reviewloop bins and doctor script', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(pkg.name, 'reviewloop');
  assert.equal(pkg.scripts.doctor, 'node ./scripts/doctor.js');
  assert.ok(pkg.bin.reviewloop && pkg.bin['reviewloop-mcp']);
});
