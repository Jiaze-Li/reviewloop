#!/usr/bin/env node
// ReviewLoop global installer.
//
// Installs the ReviewLoop Worker Contract (agent-policy/COMMON.md) and the
// shared `reviewloop` MCP server into whichever supported coding agents are
// present (Claude, Codex, Gemini/AGY). Missing agents are skipped, not fatal.
//
// It ALSO transactionally migrates an older SuperGPT install found on the
// machine:
//   - removes the `supergpt` MCP registration it owns (claude / codex / agy)
//   - removes the `<!-- SUPERGPT-GLOBAL-POLICY -->` managed block
//   - removes the old AGY `supergpt` skill
// Unrelated user content outside the managed block is preserved byte-for-byte.
// Every touched file is snapshotted first; any failure rolls all of them back.

import path from 'node:path';
import os from 'node:os';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import {
  readFile, writeFile, mkdir, rm, lstat, stat, readlink, realpath, chmod, readdir, rmdir,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_BIN = path.join(REPO_ROOT, 'bin', 'reviewloop-mcp.js');
const POLICY_FILE = path.join(REPO_ROOT, 'agent-policy', 'COMMON.md');

const MCP_NAME = 'reviewloop';
const LEGACY_MCP_NAME = 'supergpt';
const MANAGED_BEGIN = '<!-- REVIEWLOOP-GLOBAL-POLICY:BEGIN -->';
const MANAGED_END = '<!-- REVIEWLOOP-GLOBAL-POLICY:END -->';
const LEGACY_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const LEGACY_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';

export function resolveGlobalConfigDir(env = process.env, homeDir = os.homedir()) {
  if (env.ANTIGRAVITY_CONFIG_DIR) return env.ANTIGRAVITY_CONFIG_DIR;
  if (env.GEMINI_CONFIG_DIR) return env.GEMINI_CONFIG_DIR;
  return path.join(homeDir, '.gemini', 'config');
}

function managedBlock(content) {
  return `${MANAGED_BEGIN}\n${String(content).trim()}\n${MANAGED_END}`;
}

function locate(text, begin, end, label) {
  const raw = String(text);
  const b = raw.indexOf(begin);
  const e = raw.indexOf(end);
  if (b === -1 && e === -1) return null;
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`Refusing to modify malformed ${label} managed policy block`);
  }
  if (raw.indexOf(begin, b + begin.length) !== -1) {
    throw new Error(`Refusing to modify duplicate ${label} managed policy blocks`);
  }
  return { raw, begin: b, end: e + end.length };
}

function stripOne(text, begin, end, label) {
  const located = locate(text, begin, end, label);
  if (!located) return String(text);
  const { raw, begin: b, end: e } = located;
  const before = raw.slice(0, b).trimEnd();
  const after = raw.slice(e).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

// Removes BOTH the current ReviewLoop block and any legacy SuperGPT block.
export function stripManagedPolicy(text = '') {
  return stripOne(stripOne(text, LEGACY_BEGIN, LEGACY_END, 'SuperGPT'), MANAGED_BEGIN, MANAGED_END, 'ReviewLoop');
}

export function extractManagedPolicy(text = '') {
  const located = locate(text, MANAGED_BEGIN, MANAGED_END, 'ReviewLoop');
  if (!located) return null;
  const { raw, begin, end } = located;
  return raw.slice(begin + MANAGED_BEGIN.length, end - MANAGED_END.length).trim();
}

export function hasLegacyManagedPolicy(text = '') {
  return String(text).includes(LEGACY_BEGIN);
}

async function mkdirTracked(dir, ctx) {
  const first = await mkdir(dir, { recursive: true });
  if (first && ctx) ctx.createdDirs.push(first);
}

// Remember what the install itself left on disk at a path. Rollback only
// overwrites a path whose current bytes are the pre-install bytes or one of
// these; anything else was changed by someone else in the meantime.
async function noteWritten(ctx, filePath) {
  try {
    const hash = sha256(await readFile(filePath));
    if (!ctx.written.has(filePath)) ctx.written.set(filePath, new Set());
    ctx.written.get(filePath).add(hash);
  } catch { /* path unreadable/absent: nothing to remember */ }
}

async function upsertManagedPolicy(filePath, content, ctx) {
  await mkdirTracked(path.dirname(filePath), ctx);
  const existing = existsSync(filePath) ? await readFile(filePath, 'utf8') : '';
  const unmanaged = stripManagedPolicy(existing).trimEnd();
  const next = `${unmanaged ? `${unmanaged}\n\n` : ''}${managedBlock(content)}\n`;
  await writeFile(filePath, next, 'utf8');
  if (ctx) await noteWritten(ctx, filePath);
}

async function removeManagedPolicy(filePath) {
  if (!existsSync(filePath)) return false;
  const existing = await readFile(filePath, 'utf8');
  if (!existing.includes(MANAGED_BEGIN) && !existing.includes(LEGACY_BEGIN)) return false;
  const unmanaged = stripManagedPolicy(existing);
  await writeFile(filePath, unmanaged ? `${unmanaged.trimEnd()}\n` : '', 'utf8');
  return true;
}

function runCli(execFileSync, command, args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '').trim();
  } catch (err) {
    if (allowFailure) return null;
    const detail = err?.stderr ? String(err.stderr).trim() : err?.message;
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function frontendAvailable(execFileSync, command) {
  return runCli(execFileSync, command, ['--version'], { allowFailure: true }) !== null;
}

function registerClaudeMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'claude', ['mcp', 'remove', LEGACY_MCP_NAME, '--scope', 'user'], { allowFailure: true });
  runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true });
  runCli(execFileSync, 'claude', ['mcp', 'add', MCP_NAME, '--scope', 'user', '--', nodeBin, mcpBin]);
}

function registerCodexMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'codex', ['mcp', 'remove', LEGACY_MCP_NAME], { allowFailure: true });
  runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true });
  runCli(execFileSync, 'codex', ['mcp', 'add', MCP_NAME, '--', nodeBin, mcpBin]);
}

function removeClaudeMcp(execFileSync) {
  runCli(execFileSync, 'claude', ['mcp', 'remove', LEGACY_MCP_NAME, '--scope', 'user'], { allowFailure: true });
  return runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true }) !== null;
}

function removeCodexMcp(execFileSync) {
  runCli(execFileSync, 'codex', ['mcp', 'remove', LEGACY_MCP_NAME], { allowFailure: true });
  return runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true }) !== null;
}

// Tri-state registration query: 'present' | 'absent' | 'unknown'. Only a failure
// whose output clearly says "not found / not configured" counts as absent; any
// other failure (timeout, crash, auth, unexpected output) is 'unknown' and is
// never treated as permission to remove or to declare success.
const NOT_REGISTERED_RE = /not\s+found|no\s+mcp\s+server|not\s+configured|no\s+such|does\s+not\s+exist|unknown\s+server/i;
function mcpState(execFileSync, command, name) {
  try {
    execFileSync(command, ['mcp', 'get', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'present';
  } catch (err) {
    const text = `${err?.stderr ?? ''} ${err?.stdout ?? ''} ${err?.message ?? ''}`;
    return NOT_REGISTERED_RE.test(text) ? 'absent' : 'unknown';
  }
}

function hasClaudeMcp(execFileSync, name = MCP_NAME) {
  return runCli(execFileSync, 'claude', ['mcp', 'get', name], { allowFailure: true }) !== null;
}

function hasCodexMcp(execFileSync, name = MCP_NAME) {
  return runCli(execFileSync, 'codex', ['mcp', 'get', name], { allowFailure: true }) !== null;
}

function renderAgySkill(commonPolicy) {
  return `---\nname: reviewloop\ndescription: Shared ReviewLoop Worker contract.\n---\n\n${String(commonPolicy).trim()}\n`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Type-aware snapshot. A path is one of:
//   missing     - nothing there
//   file        - regular file (bytes + mode)
//   symlink     - link to a regular file (readlink string + resolved target bytes + mode)
//   dangling    - link whose target does not exist (never written through)
//   unsupported - directory / special file / non-directory parent (never written)
async function snapshotFileState(filePath) {
  let st;
  try {
    st = await lstat(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { kind: 'missing' };
    if (err?.code === 'ENOTDIR') return { kind: 'unsupported', reason: 'a parent of this path is not a directory' };
    throw err;
  }
  if (st.isSymbolicLink()) {
    const linkTarget = await readlink(filePath);
    let resolved;
    try {
      resolved = await realpath(filePath);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ELOOP' || err?.code === 'ENOTDIR') return { kind: 'dangling', linkTarget };
      throw err;
    }
    const rst = await stat(resolved);
    if (!rst.isFile()) return { kind: 'unsupported', linkTarget, reason: 'symlink does not point at a regular file' };
    return { kind: 'symlink', linkTarget, resolved, bytes: await readFile(resolved), mode: rst.mode & 0o7777 };
  }
  if (!st.isFile()) return { kind: 'unsupported', reason: 'not a regular file' };
  return { kind: 'file', bytes: await readFile(filePath), mode: st.mode & 0o7777 };
}

function describeSnapshot(snap) {
  switch (snap.kind) {
    case 'missing': return 'absent';
    case 'file': return `regular file sha256=${sha256(snap.bytes).slice(0, 12)} mode=${snap.mode.toString(8)}`;
    case 'symlink': return `symlink -> ${snap.linkTarget}, target sha256=${sha256(snap.bytes).slice(0, 12)} mode=${snap.mode.toString(8)}`;
    case 'dangling': return `dangling symlink -> ${snap.linkTarget}`;
    default: return `unsupported (${snap.reason})`;
  }
}

// Refuse BEFORE any side effect when a path we are about to write is a
// dangling link or not a regular file: writing through it would create files
// in unexpected places, and rollback could not restore it faithfully.
function assertWritable(filePath, snap) {
  if (snap.kind === 'dangling') {
    throw new Error(`Refusing to install: ${filePath} is a dangling symlink -> ${snap.linkTarget}. Nothing was changed. Fix or remove the broken link (or restore its target in your dotfiles repo), then re-run the install.`);
  }
  if (snap.kind === 'unsupported') {
    throw new Error(`Refusing to install: ${filePath} is not a regular file or a symlink to one (${snap.reason}). Nothing was changed. Resolve it manually, then re-run the install.`);
  }
}

// Current state of a path, in the same vocabulary as a snapshot, for verification.
async function verifyAgainst(filePath, snap) {
  const current = await snapshotFileState(filePath).catch((err) => ({ kind: 'unreadable', reason: err?.message || String(err) }));
  if (current.kind !== snap.kind) return { ok: false, actual: describeSnapshot(current) };
  if (snap.kind === 'missing') return { ok: true };
  if (snap.kind === 'symlink' && current.linkTarget !== snap.linkTarget) return { ok: false, actual: describeSnapshot(current) };
  if (snap.kind === 'file' || snap.kind === 'symlink') {
    if (sha256(current.bytes) !== sha256(snap.bytes) || current.mode !== snap.mode) return { ok: false, actual: describeSnapshot(current) };
  }
  return { ok: true };
}

// Restore in place. Never rm a file or symlink that existed before the install.
async function restoreFileState(filePath, snap) {
  switch (snap.kind) {
    case 'missing':
      await rm(filePath, { force: true });
      return;
    case 'file':
      await writeFile(filePath, snap.bytes);
      await chmod(filePath, snap.mode);
      return;
    case 'symlink': {
      // The link itself is never touched; only its target's bytes/mode are put back.
      const current = await readFile(snap.resolved).catch(() => null);
      if (!current || sha256(current) !== sha256(snap.bytes)) await writeFile(snap.resolved, snap.bytes);
      await chmod(snap.resolved, snap.mode);
      return;
    }
    default:
      return; // dangling / unsupported are rejected before any write
  }
}

async function pruneEmptyDirs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    if (entry.isDirectory()) await pruneEmptyDirs(path.join(dir, entry.name));
  }
  try { await rmdir(dir); return true; } catch { return false; }
}

async function currentHash(filePath) {
  try { return sha256(await readFile(filePath)); } catch { return null; }
}

async function restoreFileStates(snapshots, ctx) {
  const restored = [];
  const residual = [];
  for (const [filePath, snap] of snapshots) {
    if (snap.kind === 'dangling' || snap.kind === 'unsupported') continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      if ((await verifyAgainst(filePath, snap)).ok) { restored.push(filePath); continue; }
      // eslint-disable-next-line no-await-in-loop
      const current = await currentHash(filePath);
      const snapHash = snap.bytes ? sha256(snap.bytes) : null;
      if (current !== null && current !== snapHash && !ctx.written.get(filePath)?.has(current)) {
        residual.push({
          path: filePath,
          what: 'changed by someone else during the install',
          expected: describeSnapshot(snap),
          actual: 'content differs from both the pre-install content and what this install wrote; left untouched',
          next: `Review ${filePath} yourself (it may hold your concurrent edit); the install did not overwrite it.`,
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await restoreFileState(filePath, snap);
    } catch (err) {
      residual.push({
        path: filePath,
        what: 'file restore failed',
        expected: describeSnapshot(snap),
        actual: `restore error: ${err?.message || err}`,
        next: `Inspect ${filePath} and restore it from your backup or dotfiles git history (git diff / git checkout -- <file>).`,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const check = await verifyAgainst(filePath, snap);
    if (check.ok) restored.push(filePath);
    else {
      residual.push({
        path: filePath,
        what: 'state differs after rollback',
        expected: describeSnapshot(snap),
        actual: check.actual,
        next: `Compare ${filePath} with your backup or dotfiles git history and restore it by hand.`,
      });
    }
  }
  // Remove only directories THIS install created, and only while empty.
  for (const dir of [...ctx.createdDirs].reverse()) {
    // eslint-disable-next-line no-await-in-loop
    await pruneEmptyDirs(dir);
  }
  return { restored, residual };
}

async function readAgyConfig(mcpConfigFile) {
  let config = { mcpServers: {} };
  if (existsSync(mcpConfigFile)) {
    try {
      config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a JSON object');
    } catch (err) {
      throw new Error(`Refusing to overwrite existing invalid MCP config ${mcpConfigFile}: ${err.message}`);
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }
  return config;
}

function reconcileMcp({ execFileSync, present, mcpBefore, residual }) {
  const report = {};
  for (const frontend of ['claude', 'codex']) {
    if (!present[frontend]) continue;
    const before = mcpBefore[frontend];
    report[frontend] = {};
    for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
      let after = mcpState(execFileSync, frontend, name);
      let action = 'unchanged';
      // Remove ONLY a registration proven absent before and proven present now.
      if (before[name] === 'absent' && after === 'present') {
        runCli(execFileSync, frontend, frontend === 'claude' ? ['mcp', 'remove', name, '--scope', 'user'] : ['mcp', 'remove', name], { allowFailure: true });
        after = mcpState(execFileSync, frontend, name);
        action = after === 'absent' ? 'removed-new-registration' : 'remove-failed';
      } else if (before[name] === 'present' && after === 'absent') {
        action = 'lost';
      } else if (before[name] === 'unknown' || after === 'unknown') {
        action = before[name] === 'absent' && after === 'absent' ? 'unchanged' : 'unverified';
      }
      report[frontend][name] = { before: before[name], after, action };
      if (action === 'lost' || action === 'remove-failed' || action === 'unverified') {
        const cmd = `${frontend} mcp ${name}`;
        residual.push({
          path: cmd,
          what: 'MCP registration',
          expected: before[name] === 'present' ? 'registered (as before the install)' : before[name] === 'absent' ? 'not registered' : 'unknown (the pre-install query failed)',
          actual: action === 'lost' ? 'not registered' : action === 'remove-failed' ? 'still registered' : `could not verify (now: ${after}); left exactly as found, nothing removed`,
          next: action === 'lost'
            ? `Re-register it: run \`${frontend} mcp add ${name} -- <node> <path to reviewloop-mcp.js>\` or re-run \`npm run install-global\` after fixing the cause.`
            : action === 'remove-failed'
              ? `Remove it: run \`${frontend} mcp remove ${name}\`.`
              : `Check it yourself: run \`${frontend} mcp get ${name}\`; keep it if you had it registered, otherwise \`${frontend} mcp remove ${name}\`.`,
        });
      }
    }
  }
  return report;
}

export async function installGlobal({
  configDir,
  homeDir = os.homedir(),
  mcpBin = MCP_BIN,
  policyFile = POLICY_FILE,
  nodeBin = process.execPath || 'node',
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillTargetDir = path.join(agyConfigDir, 'skills', MCP_NAME);
  const legacyAgySkillDir = path.join(agyConfigDir, 'skills', LEGACY_MCP_NAME);
  const agyPolicyFile = path.join(agySkillTargetDir, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  const commonPolicy = await readFile(policyFile, 'utf8');
  const agyConfig = await readAgyConfig(mcpConfigFile);

  const present = {
    claude: frontendAvailable(execFileSync, 'claude'),
    codex: frontendAvailable(execFileSync, 'codex'),
    agy: frontendAvailable(execFileSync, 'agy'),
  };
  if (!present.claude && !present.codex && !present.agy) {
    throw new Error('No supported coding agent (claude / codex / agy) found on this machine');
  }

  const transactionalPaths = [
    mcpConfigFile, agyPolicyFile,
    claudePolicyFile, codexPolicyFile, geminiPolicyFile,
    path.join(homeDir, '.claude.json'), path.join(homeDir, '.codex', 'config.toml'),
  ];
  const snapshots = new Map();
  for (const filePath of transactionalPaths) {
    // eslint-disable-next-line no-await-in-loop
    snapshots.set(filePath, await snapshotFileState(filePath));
  }

  const snapText = (filePath) => {
    const snap = snapshots.get(filePath);
    return snap && (snap.kind === 'file' || snap.kind === 'symlink') ? snap.bytes.toString('utf8') : null;
  };

  for (const policyPath of [claudePolicyFile, codexPolicyFile, geminiPolicyFile]) {
    const text = snapText(policyPath);
    if (text !== null) stripManagedPolicy(text);
  }

  // Fail closed before ANY side effect: never write through a dangling link or
  // a non-regular-file target.
  const agyWillWrite = present.agy || snapshots.get(mcpConfigFile).kind !== 'missing';
  const willWrite = [];
  if (present.claude) willWrite.push(claudePolicyFile, path.join(homeDir, '.claude.json'));
  if (present.codex) willWrite.push(codexPolicyFile, path.join(homeDir, '.codex', 'config.toml'));
  if (agyWillWrite) willWrite.push(mcpConfigFile, agyPolicyFile, geminiPolicyFile);
  for (const filePath of willWrite) assertWritable(filePath, snapshots.get(filePath));

  const ctx = { createdDirs: [], written: new Map() };
  const claudeJsonFile = path.join(homeDir, '.claude.json');
  const codexConfigFile = path.join(homeDir, '.codex', 'config.toml');
  const mcpBefore = {
    claude: present.claude ? { [MCP_NAME]: mcpState(execFileSync, 'claude', MCP_NAME), [LEGACY_MCP_NAME]: mcpState(execFileSync, 'claude', LEGACY_MCP_NAME) } : null,
    codex: present.codex ? { [MCP_NAME]: mcpState(execFileSync, 'codex', MCP_NAME), [LEGACY_MCP_NAME]: mcpState(execFileSync, 'codex', LEGACY_MCP_NAME) } : null,
  };

  const migrated = { legacyBlocks: [], legacyMcp: [], legacySkill: false };

  try {
    // The CLIs own their config files; checkpoint what each call left behind
    // (even when it failed part-way) so rollback can tell its own output from
    // someone else's concurrent edit.
    if (present.claude) {
      try { registerClaudeMcp(execFileSync, nodeBin, mcpBin); } finally { await noteWritten(ctx, claudeJsonFile); }
    }
    if (present.codex) {
      try { registerCodexMcp(execFileSync, nodeBin, mcpBin); } finally { await noteWritten(ctx, codexConfigFile); }
    }

    if (snapshots.get(mcpConfigFile).kind !== 'missing' && agyConfig.mcpServers[LEGACY_MCP_NAME]) {
      migrated.legacyMcp.push('agy');
    }
    delete agyConfig.mcpServers[LEGACY_MCP_NAME];

    if (agyWillWrite) {
      await mkdirTracked(agyConfigDir, ctx);
      await mkdirTracked(agySkillTargetDir, ctx);
      // Re-read right before writing so edits made since the first read are kept.
      const freshAgyConfig = await readAgyConfig(mcpConfigFile);
      delete freshAgyConfig.mcpServers[LEGACY_MCP_NAME];
      freshAgyConfig.mcpServers[MCP_NAME] = { command: nodeBin, args: [mcpBin] };
      await writeFile(mcpConfigFile, `${JSON.stringify(freshAgyConfig, null, 2)}\n`, 'utf8');
      await noteWritten(ctx, mcpConfigFile);
      await writeFile(agyPolicyFile, renderAgySkill(commonPolicy), 'utf8');
      await noteWritten(ctx, agyPolicyFile);
    }

    for (const [frontend, policyPath] of [
      ['claude', claudePolicyFile], ['codex', codexPolicyFile], ['agy', geminiPolicyFile],
    ]) {
      const text = snapText(policyPath);
      const legacy = text !== null && hasLegacyManagedPolicy(text);
      if (legacy) migrated.legacyBlocks.push(frontend);
      if (present[frontend] || legacy) {
        // eslint-disable-next-line no-await-in-loop
        await upsertManagedPolicy(policyPath, commonPolicy, ctx);
      }
    }
  } catch (err) {
    // 1) put every snapshotted file back (this also restores MCP registrations,
    //    which the claude/codex CLIs keep in ~/.claude.json / ~/.codex/config.toml)
    const { restored, residual } = await restoreFileStates(snapshots, ctx);
    // 2) reconcile registrations against the pre-install state: only remove ones
    //    that did not exist before; report any we cannot prove restored.
    const mcp = reconcileMcp({ execFileSync, present, mcpBefore, residual });
    err.rollback = { restored, residual, mcp };
    err.rollbackErrors = residual.map((r) => `${r.path}: ${r.actual}`);
    err.message = `${err.message} (rollback: ${restored.length} file(s) verified restored${
      residual.length ? `; ${residual.length} NOT fully restored: ${residual.map((r) => `${r.path} [expected ${r.expected}; found ${r.actual}] next: ${r.next}`).join(' | ')}` : '; no residual state'
    })`;
    throw err;
  }

  // Every fallible write above has now succeeded. ONLY now delete the legacy
  // SuperGPT skill directory — it is not in `transactionalPaths` (a dir, not a
  // file) and cannot be snapshot-restored, so deferring its removal to here is
  // what guarantees a rolled-back install never loses the user's prior skill.
  if (agyWillWrite && existsSync(legacyAgySkillDir)) {
    await rm(legacyAgySkillDir, { recursive: true, force: true });
    migrated.legacySkill = true;
  }

  return {
    success: true,
    present,
    migrated,
    mcpBin,
    mcpConfigFile,
    agyPolicyFile,
    claudePolicyFile,
    codexPolicyFile,
    geminiPolicyFile,
  };
}

export async function uninstallGlobal({
  configDir,
  homeDir = os.homedir(),
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillTargetDir = path.join(agyConfigDir, 'skills', MCP_NAME);
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  let removedAgyMcp = false;
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      let changed = false;
      for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
        if (config?.mcpServers?.[name]) { delete config.mcpServers[name]; changed = true; }
      }
      if (changed) {
        await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        removedAgyMcp = true;
      }
    } catch { /* never rewrite unrelated malformed user config */ }
  }

  const removedAgyPolicy = existsSync(agySkillTargetDir);
  if (removedAgyPolicy) await rm(agySkillTargetDir, { recursive: true, force: true });

  const removedClaudeMcp = removeClaudeMcp(execFileSync);
  const removedCodexMcp = removeCodexMcp(execFileSync);
  const removedClaudePolicy = await removeManagedPolicy(claudePolicyFile);
  const removedCodexPolicy = await removeManagedPolicy(codexPolicyFile);
  const removedGeminiPolicy = await removeManagedPolicy(geminiPolicyFile);

  return {
    success: true,
    removedAgyMcp,
    removedClaudeMcp,
    removedCodexMcp,
    removedAgyPolicy,
    removedClaudePolicy,
    removedCodexPolicy,
    removedGeminiPolicy,
  };
}

export async function checkGlobalStatus({
  configDir,
  homeDir = os.homedir(),
  policyFile = POLICY_FILE,
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillFile = path.join(agyConfigDir, 'skills', MCP_NAME, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  const expectedPolicy = (await readFile(policyFile, 'utf8')).trim();

  let agyMcpInstalled = false;
  let legacyAgyMcp = false;
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      agyMcpInstalled = Boolean(config?.mcpServers?.[MCP_NAME]);
      legacyAgyMcp = Boolean(config?.mcpServers?.[LEGACY_MCP_NAME]);
    } catch { /* report false */ }
  }

  const managedPolicyState = async (filePath) => {
    if (!existsSync(filePath)) return { policyInstalled: false, reason: 'missing-file', legacy: false };
    let text;
    try { text = await readFile(filePath, 'utf8'); } catch { return { policyInstalled: false, reason: 'unreadable', legacy: false }; }
    const legacy = hasLegacyManagedPolicy(text);
    let content;
    try { content = extractManagedPolicy(text); } catch (err) { return { policyInstalled: false, reason: 'corrupt-block', detail: err.message, legacy }; }
    if (content === null) return { policyInstalled: false, reason: 'missing-block', legacy };
    if (content !== expectedPolicy) return { policyInstalled: false, reason: 'stale-content', legacy };
    return { policyInstalled: true, reason: 'ok', legacy };
  };

  const avail = (command) => runCli(execFileSync, command, ['--version'], { allowFailure: true }) !== null;
  const [claudePolicy, codexPolicy, geminiPolicy] = await Promise.all([
    managedPolicyState(claudePolicyFile),
    managedPolicyState(codexPolicyFile),
    managedPolicyState(geminiPolicyFile),
  ]);

  return {
    mcpConfigFile,
    legacyAgyMcp,
    agy: {
      available: avail('agy'),
      mcpInstalled: agyMcpInstalled,
      policyInstalled: geminiPolicy.policyInstalled,
      policyReason: geminiPolicy.reason,
      legacyPolicy: geminiPolicy.legacy,
      policyFile: geminiPolicyFile,
      skillInstalled: existsSync(agySkillFile),
      skillFile: agySkillFile,
    },
    claude: {
      available: avail('claude'),
      mcpInstalled: hasClaudeMcp(execFileSync),
      policyInstalled: claudePolicy.policyInstalled,
      policyReason: claudePolicy.reason,
      legacyPolicy: claudePolicy.legacy,
      policyFile: claudePolicyFile,
    },
    codex: {
      available: avail('codex'),
      mcpInstalled: hasCodexMcp(execFileSync),
      policyInstalled: codexPolicy.policyInstalled,
      policyReason: codexPolicy.reason,
      legacyPolicy: codexPolicy.legacy,
      policyFile: codexPolicyFile,
    },
  };
}

function installedText(frontend) {
  if (!frontend.available) return 'Skipped (agent not installed)';
  if (frontend.mcpInstalled && frontend.policyInstalled) return 'Installed';
  const notes = [];
  if (!frontend.mcpInstalled) notes.push('MCP not registered');
  if (!frontend.policyInstalled) notes.push(`policy ${frontend.policyReason || 'not installed'}`);
  return `Incomplete (${notes.join(', ')})`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const status = await checkGlobalStatus();
    console.log('ReviewLoop global status:');
    console.log(`  AGY:     ${installedText(status.agy)}`);
    console.log(`  Claude:  ${installedText(status.claude)}`);
    console.log(`  Codex:   ${installedText(status.codex)}`);
    if (status.legacyAgyMcp) console.log('  note: legacy `supergpt` MCP registration still present — run install to migrate');
    return;
  }
  if (args.includes('--uninstall')) {
    await uninstallGlobal();
    console.log('ReviewLoop global integration removed.');
    return;
  }
  const result = await installGlobal();
  const targets = Object.entries(result.present).filter(([, v]) => v).map(([k]) => k);
  console.log(`ReviewLoop installed globally for: ${targets.join(', ') || '(none available)'}`);
  console.log(`  MCP server: ${result.mcpBin}`);
  console.log('  Policy:     agent-policy/COMMON.md (single source of truth)');
  if (result.migrated.legacyBlocks.length || result.migrated.legacyMcp.length || result.migrated.legacySkill) {
    console.log(`  Migrated legacy SuperGPT: blocks=[${result.migrated.legacyBlocks}] mcp=[${result.migrated.legacyMcp}] skill=${result.migrated.legacySkill}`);
  }
  console.log('Restart/open a new agent session so each client reloads its MCP and policy.');
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('ReviewLoop installation failed:', err.message);
    process.exitCode = 1;
  });
}
