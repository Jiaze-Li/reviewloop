#!/usr/bin/env node
// doctor — deterministic, zero-model prerequisite + repo-invariant check for
// the local ReviewLoop runtime.
//
// Mandatory core prerequisites: Node, Git, the ReviewLoop runtime dir, and
// COMMON/source consistency (a repo invariant). The global install state is a
// diagnostic warning only — a stale or absent global install never fails
// doctor, and doctor never mutates the real environment or makes a model call.

import path from 'node:path';
import os from 'node:os';
import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { extractManagedPolicy, resolveGlobalConfigDir, hasLegacyManagedPolicy } from '../bin/install-plugin.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';

const DEFAULT_POLICY_FILE = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));
// Computed from THIS repo/module — never hard-coded. This is the MCP entrypoint
// every installed frontend's `reviewloop` server command MUST resolve to.
const EXPECTED_MCP_BIN = fileURLToPath(new URL('../bin/reviewloop-mcp.js', import.meta.url));
const MCP_NAME = 'reviewloop';
const ACTIVE_ROLES = ['supervisor', 'reviewer'];

// Does an MCP server command/args array point at THIS repo's reviewloop-mcp.js?
function mcpArgsMatchExpected(parts) {
  const flat = (Array.isArray(parts) ? parts : [parts]).map((p) => String(p ?? ''));
  if (flat.some((p) => p === EXPECTED_MCP_BIN)) return { ok: true };
  const stale = flat.find((p) => /reviewloop-mcp\.js$/.test(p) || /gpt-dev-loop\b/.test(p));
  if (stale) return { ok: false, reason: 'stale-path', found: stale };
  return { ok: false, reason: 'no-reviewloop-mcp-path', found: flat.join(' ') || '(empty)' };
}

// Inspect each installed frontend's `reviewloop` MCP registration and check its
// command actually resolves to EXPECTED_MCP_BIN. A stale registration (pointing
// at an old gpt-dev-loop checkout) is a WARNING with a fix hint — never fatal,
// and never reported as an "MCP match".
export function checkMcpServerBinding({
  execSync, homeDir = os.homedir(), configDir, env = process.env,
} = {}) {
  const exec = execSync || nodeExecSync;
  const frontends = {};
  const issues = [];

  const cliBinding = (command) => {
    let out;
    try {
      out = String(exec(`${command} mcp get ${MCP_NAME}`, { stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      return null; // not installed / not registered
    }
    if (!out || !out.trim()) return null;
    const m = mcpArgsMatchExpected(out.split(/\s+/));
    return { ...m, raw: out.trim().slice(0, 400) };
  };

  for (const command of ['claude', 'codex']) {
    const b = cliBinding(command);
    if (!b) { frontends[command] = { ok: true, reason: 'not-registered' }; continue; }
    frontends[command] = b;
    if (!b.ok) {
      issues.push(`${command} reviewloop MCP does not point at ${EXPECTED_MCP_BIN} (${b.reason}: ${b.found}) — run \`npm run install-global\``);
    }
  }

  const agyConfigDir = configDir ?? resolveGlobalConfigDir(env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigFile, 'utf8'));
      const server = config?.mcpServers?.[MCP_NAME];
      if (server) {
        const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
        const m = mcpArgsMatchExpected(parts);
        frontends.agy = { ...m, raw: parts.join(' ').slice(0, 400) };
        if (!m.ok) {
          issues.push(`agy reviewloop MCP does not point at ${EXPECTED_MCP_BIN} (${m.reason}: ${m.found}) — run \`npm run install-global\``);
        }
      } else {
        frontends.agy = { ok: true, reason: 'not-registered' };
      }
    } catch (err) {
      frontends.agy = { ok: false, reason: `mcp_config.json unreadable: ${err.message}` };
    }
  } else {
    frontends.agy = { ok: true, reason: 'not-configured' };
  }

  return {
    name: 'mcp_binding', ok: issues.length === 0, expected: EXPECTED_MCP_BIN, frontends, issues,
  };
}

function probe(execSync, command) {
  return String(execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

export function checkGit({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'git', ok: true, version: probe(exec, 'git --version') }; }
  catch (err) { return { name: 'git', ok: false, error: err.message }; }
}

export function checkNode({ env } = {}) {
  const version = (env && env.npm_config_node_version) || process.version;
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return { name: 'node', ok: Number.isFinite(major) && major >= 20, version };
}

export function checkRuntimeDir({ root = REVIEWLOOP_RUNTIME_ROOT } = {}) {
  try {
    if (existsSync(root)) accessSync(root, constants.R_OK | constants.W_OK);
    return { name: 'runtime_dir', ok: true, path: root };
  } catch (err) {
    return { name: 'runtime_dir', ok: false, error: err.message, path: root };
  }
}

export function checkRepoInvariants({ policyFile = DEFAULT_POLICY_FILE } = {}) {
  const issues = [];
  const roles = Object.keys(DEFAULT_ROLE_POLICY).sort();
  if (JSON.stringify(roles) !== JSON.stringify([...ACTIVE_ROLES].sort())) {
    issues.push(`DEFAULT_ROLE_POLICY roles are [${roles}] — expected exactly [reviewer, supervisor]`);
  }
  for (const forbidden of ['planner', 'executor']) {
    if (forbidden in DEFAULT_ROLE_POLICY) issues.push(`active "${forbidden}" role must not exist`);
    for (const caps of Object.values(PRODUCTION_ROLE_CAPABILITIES)) {
      if (caps.includes(forbidden)) issues.push(`PRODUCTION_ROLE_CAPABILITIES still declares "${forbidden}"`);
    }
  }
  let common;
  try {
    common = readFileSync(policyFile, 'utf8');
  } catch (err) {
    return { name: 'repo_invariants', ok: false, issues: [`unreadable COMMON policy: ${err.message}`] };
  }
  if (!/ReviewLoop Worker Contract/.test(common)) issues.push('COMMON is not the ReviewLoop Worker Contract');
  const version = common.match(/Contract version:\s*(\d+)/i);
  if (!version || Number(version[1]) < 1) issues.push('COMMON has no valid "Contract version:" >= 1');
  if (/Front[- ]Agent|supergpt_route|Fast Path|Full Path|\bPlanner\b|\bExecutor\b/.test(common)) {
    issues.push('COMMON still references retired SuperGPT concepts (Front Agent / route / Fast/Full / Planner / Executor)');
  }
  const bytes = Buffer.byteLength(common, 'utf8');
  if (bytes > 2560) issues.push(`COMMON is ${bytes} bytes — exceeds the 2.5KB Worker-context target`);
  return { name: 'repo_invariants', ok: issues.length === 0, issues, commonBytes: bytes };
}

export function checkGlobalPolicy({
  homeDir = os.homedir(), configDir, env = process.env, policyFile = DEFAULT_POLICY_FILE,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(env, homeDir);
  const targets = {
    claude: path.join(homeDir, '.claude', 'CLAUDE.md'),
    codex: path.join(homeDir, '.codex', 'AGENTS.md'),
    agy: path.join(homeDir, '.gemini', 'GEMINI.md'),
  };
  let expected;
  try { expected = readFileSync(policyFile, 'utf8').trim(); }
  catch (err) { return { name: 'global_policy', ok: false, error: `unreadable COMMON policy: ${err.message}` }; }

  const frontends = {};
  const issues = [];
  for (const [frontend, filePath] of Object.entries(targets)) {
    if (!existsSync(filePath)) { frontends[frontend] = { ok: true, reason: 'not-configured' }; continue; }
    let text;
    try { text = readFileSync(filePath, 'utf8'); } catch { frontends[frontend] = { ok: false, reason: 'unreadable' }; issues.push(`${frontend} rules unreadable`); continue; }
    let content;
    try { content = extractManagedPolicy(text); } catch (err) { frontends[frontend] = { ok: false, reason: 'corrupt-block' }; issues.push(`${frontend} managed block corrupt: ${err.message}`); continue; }
    if (hasLegacyManagedPolicy(text)) issues.push(`${frontend} still carries the legacy SuperGPT managed block — run the installer to migrate`);
    if (content === null) { frontends[frontend] = { ok: false, reason: 'missing-block' }; issues.push(`${frontend} ReviewLoop policy not installed`); }
    else if (content !== expected) { frontends[frontend] = { ok: false, reason: 'stale-content' }; issues.push(`${frontend} ReviewLoop policy stale`); }
    else frontends[frontend] = { ok: true, reason: 'ok' };
  }

  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  let agyMcp = { ok: true, reason: 'not-configured' };
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigFile, 'utf8'));
      if (config?.mcpServers?.[MCP_NAME]) agyMcp = { ok: true, reason: 'ok' };
      else { agyMcp = { ok: false, reason: 'not-registered' }; issues.push('reviewloop MCP not registered for AGY'); }
      if (config?.mcpServers?.supergpt) issues.push('legacy `supergpt` MCP still registered for AGY');
    } catch (err) { agyMcp = { ok: false, reason: 'invalid-config' }; issues.push(`AGY MCP config invalid: ${err.message}`); }
  }

  return { name: 'global_policy', ok: issues.length === 0, frontends, agyMcp, issues };
}

export function checkReviewerSupervisorPools() {
  const eligible = { reviewer: [], supervisor: [] };
  const highContext = { reviewer: [], supervisor: [] };
  for (const role of ACTIVE_ROLES) {
    for (const cand of DEFAULT_ROLE_POLICY[role] ?? []) {
      if (!(PRODUCTION_ROLE_CAPABILITIES[cand.family] ?? []).includes(role)) continue;
      if (cand.highContext) highContext[role].push(cand.family);
      else eligible[role].push(cand.family);
    }
  }
  const issues = [];
  if (eligible.reviewer.length === 0) issues.push('no auto-eligible Reviewer candidate available');
  if (eligible.supervisor.length === 0) issues.push('no auto-eligible Supervisor candidate available');
  return { name: 'model_pools', ok: issues.length === 0, eligible, highContext, issues };
}

// Diagnostic mirror of the MCP startup preflight. This stays zero-model:
// version checks establish CLI presence; local auth-status commands establish
// whether the CLI family can be selected before any prompt-bearing dispatch.
export function checkReviewTransportRuntime({ execSync, env } = {}) {
  const exec = execSync || nodeExecSync;
  const probeRuntime = (bin, authCommand) => {
    try { probe(exec, `${bin} --version`); }
    catch (err) {
      const enoent = /ENOENT|not found|command not found/i.test(err.message);
      return { available: false, reason: enoent ? 'CLI not installed' : 'version probe failed' };
    }
    try {
      probe(exec, authCommand);
      return { available: true, reason: 'ok' };
    } catch {
      return { available: false, reason: 'not authenticated' };
    }
  };
  const transportRuntime = {
    'codex:default': probeRuntime('codex', 'codex login status'),
    'claude:opus': probeRuntime('claude', 'claude auth status'),
  };
  let runtimeStatus = {};
  try {
    runtimeStatus = createReviewLoopProviderPool({ env: env || process.env, transportRuntime }).runtimeStatus;
  } catch (err) {
    return { name: 'review_transports', ok: true, error: err.message, families: {} };
  }
  return { name: 'review_transports', ok: true, families: runtimeStatus };
}

export function runDoctor({ execSync, log, env } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const core = [
    checkNode({ env: environment }),
    checkGit({ execSync: exec }),
    checkRuntimeDir(),
    checkRepoInvariants(),
  ];
  const ok = core.every((r) => r.ok);

  for (const r of core) {
    if (r.name === 'repo_invariants') {
      if (r.ok) write(`  ok    repo_invariants (reviewer+supervisor only, no planner/executor, COMMON ${r.commonBytes}B)`);
      else for (const i of r.issues) write(`  FAIL  repo_invariants: ${i}`);
      continue;
    }
    if (r.ok) write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}${r.path ? ` (${r.path})` : ''}`);
    else write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
  }

  const pools = checkReviewerSupervisorPools();
  write(`  ${pools.ok ? 'ok  ' : 'warn'}  model_pools: reviewer=[${pools.eligible.reviewer.join(',') || 'none'}] supervisor=[${pools.eligible.supervisor.join(',') || 'none'}]`);
  const hc = [...new Set([...(pools.highContext?.reviewer ?? []), ...(pools.highContext?.supervisor ?? [])])];
  if (hc.length) write(`  info  model_pools: high-context (opt-in only, not auto-selected): ${hc.join(',')}`);
  for (const i of pools.issues) write(`  warn  model_pools: ${i}`);
  write('  info  Worker = external / current coding agent (not selected, spawned, or budgeted by ReviewLoop)');

  const transports = checkReviewTransportRuntime({ execSync: exec, env: environment });
  for (const [family, s] of Object.entries(transports.families)) {
    const rt = s.runtimeAvailable ? 'runtime available + locally authenticated' : `runtime UNAVAILABLE (${s.reason})`;
    const iso = family.startsWith('agy:')
      ? `, isolatedAgentLoading=${s.effectiveLoadingVerified ? 'verified' : 'not probed here (verified at MCP startup + per call)'}`
      : '';
    write(`  info  transport ${family}: adapter=${s.adapterImplemented ? 'yes' : 'NO'}, ${rt}${iso}, model=${s.defaultModelResolution ?? 'n/a'}, versionPinnedByDefault=${s.concreteVersionPinnedByDefault ? 'YES' : 'no'}`);
  }

  const policy = checkGlobalPolicy({ env: environment });
  if (policy.ok) write('  ok    global_policy (ReviewLoop managed blocks match COMMON)');
  else if (policy.error) write(`  warn  global_policy: ${policy.error} (diagnostic only)`);
  else {
    for (const i of policy.issues) write(`  warn  global_policy: ${i}`);
    write('  info  global_policy issues are non-fatal — run `npm run install-global` to configure or refresh');
  }

  const mcpBinding = checkMcpServerBinding({ execSync: exec, env: environment });
  if (mcpBinding.ok) {
    const seen = Object.entries(mcpBinding.frontends)
      .filter(([, v]) => v.ok && v.reason !== 'not-registered' && v.reason !== 'not-configured')
      .map(([k]) => k);
    write(`  ok    mcp_binding: reviewloop MCP command resolves to this repo${seen.length ? ` (${seen.join(',')})` : ' (none registered)'}`);
  } else {
    for (const i of mcpBinding.issues) write(`  warn  mcp_binding: ${i}`);
    write('  info  mcp_binding issues are non-fatal, but ReviewLoop tools will run the OLD checkout until you run `npm run install-global`');
  }

  const quota = new QuotaPoolRegistry();
  for (const pool of quota.summary()) write(`  info  quota ${pool.poolId}: ${pool.status}`);

  write(ok ? 'doctor: all core prerequisites satisfied' : 'doctor: missing core prerequisites');
  return {
    ok,
    status: ok ? 'pass' : 'fail',
    results: Object.fromEntries([...core, pools, transports, policy, mcpBinding].map((r) => [r.name, r])),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = runDoctor();
  process.exit(report.ok ? 0 : 1);
}
