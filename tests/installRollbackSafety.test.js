import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, readlink, chmod, readdir,
} from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SKIP_ROOT = isRoot ? 'permission-bit fault injection does not apply to root' : false;

import { installGlobal, uninstallGlobal, extractManagedPolicy } from '../bin/install-plugin.js';

const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// File-backed fake of the claude/codex CLIs: registrations live in
// ~/.claude.json and ~/.codex/config.toml (where the real CLIs keep them), so
// restoring those snapshotted files really restores the registration.
function makeFileBackedCli(home, { failOn = null, onCall = null, agy = false } = {}) {
  const calls = [];
  const claudeFile = path.join(home, '.claude.json');
  const codexFile = path.join(home, '.codex', 'config.toml');
  const readClaude = () => (existsSync(claudeFile) ? JSON.parse(readFileSync(claudeFile, 'utf8')) : { mcpServers: {} });
  const execFileSync = (command, args = []) => {
    calls.push([command, ...args]);
    if (onCall) onCall(command, args);
    if (args[0] === '--version') {
      if (command === 'agy' && !agy) throw new Error('agy: command not found');
      return `${command} test\n`;
    }
    if (command === 'claude' && args[0] === 'mcp') {
      const [, action, name] = args;
      const cfg = readClaude();
      cfg.mcpServers ||= {};
      if (action === 'get') { if (!cfg.mcpServers[name]) throw new Error('not configured'); return `${name}\n`; }
      if (action === 'remove') {
        if (!cfg.mcpServers[name]) throw new Error('not configured');
        delete cfg.mcpServers[name];
        writeFileSync(claudeFile, JSON.stringify(cfg));
        return 'removed\n';
      }
      if (action === 'add') {
        if (failOn?.command === 'claude' && failOn.action === 'add') throw new Error('boom claude add');
        cfg.mcpServers[name] = { command: args[args.length - 2], args: [args[args.length - 1]] };
        writeFileSync(claudeFile, JSON.stringify(cfg));
        return 'added\n';
      }
    }
    if (command === 'codex' && args[0] === 'mcp') {
      const [, action, name] = args;
      const text = existsSync(codexFile) ? readFileSync(codexFile, 'utf8') : '';
      const header = `[mcp_servers.${name}]`;
      const has = text.includes(header);
      if (action === 'get') { if (!has) throw new Error('not configured'); return `${name}\n`; }
      if (action === 'remove') {
        if (!has) throw new Error('not configured');
        writeFileSync(codexFile, text.split('\n').filter((l) => l !== header && !l.startsWith('command =')).join('\n'));
        return 'removed\n';
      }
      if (action === 'add') {
        if (failOn?.command === 'codex' && failOn.action === 'add') throw new Error('boom codex add');
        writeFileSync(codexFile, `${text}${header}\ncommand = "${args[args.length - 2]}"\n`);
        return 'added\n';
      }
    }
    throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
  };
  return { execFileSync, calls, claudeFile, codexFile };
}

async function sandbox() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rl-rbsafe-'));
  const home = path.join(tmp, 'home');
  const dot = path.join(tmp, 'dotfiles');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(dot, { recursive: true });
  return { tmp, home, dot, configDir: path.join(tmp, 'agycfg') };
}

const baseOpts = (sb, cli, extra = {}) => ({
  configDir: sb.configDir,
  homeDir: sb.home,
  policyFile: COMMON,
  mcpBin: '/opt/reviewloop/bin/reviewloop-mcp.js',
  nodeBin: '/usr/bin/node',
  execFileSync: cli.execFileSync,
  ...extra,
});

async function linkState(p) {
  const st = await lstat(p);
  return {
    symlink: st.isSymbolicLink(),
    target: st.isSymbolicLink() ? await readlink(p) : null,
    hash: sha(await readFile(p)),
    mode: (await lstat(await (async () => (st.isSymbolicLink() ? path.resolve(path.dirname(p), await readlink(p)) : p))())).mode & 0o7777,
  };
}

async function makeStowLink(sb, name, linkPath, content) {
  const real = path.join(sb.dot, name);
  await writeFile(real, content);
  const rel = path.relative(path.dirname(linkPath), real);
  await symlink(rel, linkPath);
  return real;
}

test('G1: codex registration failure keeps a Stow-style symlinked rules file a symlink with identical target', async () => {
  const sb = await sandbox();
  try {
    const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
    await makeStowLink(sb, 'CLAUDE.md', claudeMd, '# my dotfiles claude rules\n');
    const before = await linkState(claudeMd);
    const cli = makeFileBackedCli(sb.home, { failOn: { command: 'codex', action: 'add' } });
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)), /boom codex add/);
    // the real fault branch was hit
    assert.ok(cli.calls.some((c) => c[0] === 'codex' && c[2] === 'add'));
    assert.deepEqual(await linkState(claudeMd), before);
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: a LATE failure (read-only codex rules file) after the claude rules file was already written still restores the symlink', { skip: SKIP_ROOT }, async () => {
  const sb = await sandbox();
  try {
    const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
    const agents = path.join(sb.home, '.codex', 'AGENTS.md');
    await makeStowLink(sb, 'CLAUDE.md', claudeMd, '# my claude rules\n');
    await writeFile(agents, '# codex rules\n');
    await chmod(agents, 0o444);
    const before = await linkState(claudeMd);
    const cli = makeFileBackedCli(sb.home);
    const err = await installGlobal(baseOpts(sb, cli)).then(() => null, (e) => e);
    assert.ok(err, 'install must fail on the read-only rules file');
    assert.match(String(err.message), /EACCES|permission/i);
    // claude rules file WAS written before the fault, so rollback really had work to do
    assert.deepEqual(await linkState(claudeMd), before);
    assert.equal(await readFile(agents, 'utf8'), '# codex rules\n');
    assert.ok(err.rollback && Array.isArray(err.rollback.restored));
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: a dangling symlink target is rejected before any side effect and the link survives', async () => {
  const sb = await sandbox();
  try {
    const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
    const ghost = path.join(sb.dot, 'does-not-exist.md');
    await symlink(path.relative(path.dirname(claudeMd), ghost), claudeMd);
    const cli = makeFileBackedCli(sb.home);
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)), /dangling|broken|symlink/i);
    assert.equal((await lstat(claudeMd)).isSymbolicLink(), true);
    assert.equal(existsSync(ghost), false, 'must not create the link target');
    assert.equal(cli.calls.some((c) => c[1] === 'mcp' && c[2] === 'add'), false, 'no MCP registration before the refusal');
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: pre-existing valid MCP registrations survive a mid-install failure (not blindly removed)', async () => {
  const sb = await sandbox();
  try {
    await writeFile(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { reviewloop: { command: 'node', args: ['/custom/mine.js'] }, other: { command: 'x' } } }));
    const originalClaude = await readFile(path.join(sb.home, '.claude.json'));
    const cli = makeFileBackedCli(sb.home, { failOn: { command: 'codex', action: 'add' } });
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)), /boom codex add/);
    assert.equal(sha(await readFile(path.join(sb.home, '.claude.json'))), sha(originalClaude));
    assert.doesNotThrow(() => cli.execFileSync('claude', ['mcp', 'get', 'reviewloop']));
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: a registration that did not exist before is removed on failure', async () => {
  const sb = await sandbox();
  try {
    const cli = makeFileBackedCli(sb.home, { failOn: { command: 'codex', action: 'add' } });
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)), /boom codex add/);
    assert.throws(() => cli.execFileSync('claude', ['mcp', 'get', 'reviewloop']));
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: a failed rollback is reported structurally (path, expected, actual, next step) and never as success', { skip: SKIP_ROOT }, async () => {
  const sb = await sandbox();
  const claudeJson = path.join(sb.home, '.claude.json');
  try {
    await writeFile(claudeJson, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    // when codex registration is attempted, make the claude config un-restorable
    const cli = makeFileBackedCli(sb.home, {
      failOn: { command: 'codex', action: 'add' },
      onCall: (command, args) => { if (command === 'codex' && args[1] === 'add') chmodSync(claudeJson, 0o444); },
    });
    const err = await installGlobal(baseOpts(sb, cli)).then(() => null, (e) => e);
    assert.ok(err, 'install must fail');
    assert.match(err.message, /boom codex add/);
    assert.match(err.message, /rollback/i);
    const entry = err.rollback.residual.find((r) => r.path === claudeJson);
    assert.ok(entry, 'un-restorable file is listed');
    assert.ok(entry.expected && entry.actual && entry.next, 'entry names expected, actual and next step');
  } finally { await chmod(claudeJson, 0o644).catch(() => {}); await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: an unverifiable pre-existing registration is listed as residual, not hidden', async () => {
  const sb = await sandbox();
  try {
    // in-memory fake (registration not stored in snapshotted files) => file restore cannot bring it back
    const mcp = { claude: { reviewloop: true }, codex: {} };
    const execFileSync = (command, args = []) => {
      if (args[0] === '--version') { if (command === 'agy') throw new Error('nf'); return 'v\n'; }
      const [, action, name] = args;
      if (action === 'add') { if (command === 'claude') throw new Error('boom claude add'); mcp[command][name] = true; return ''; }
      if (action === 'remove') { if (!mcp[command][name]) throw new Error('nc'); delete mcp[command][name]; return ''; }
      if (action === 'get') { if (!mcp[command][name]) throw new Error('nc'); return 'ok'; }
      throw new Error('unexpected');
    };
    const err = await installGlobal(baseOpts(sb, { execFileSync })).then(() => null, (e) => e);
    assert.ok(err);
    const claudeResidual = err.rollback.residual.find((r) => /claude/i.test(r.path) || /claude/i.test(String(r.what)));
    assert.ok(claudeResidual, 'lost claude registration must be listed');
    assert.match(String(claudeResidual.next), /mcp add|reviewloop install|npm run install-global/);
    assert.match(err.message, /rollback/i);
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: repeat install and uninstall keep the symlink identity and only touch the managed block', async () => {
  const sb = await sandbox();
  try {
    const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
    const real = await makeStowLink(sb, 'CLAUDE.md', claudeMd, '# user rules\n\nkeep me\n');
    const cli = makeFileBackedCli(sb.home);
    await installGlobal(baseOpts(sb, cli));
    await installGlobal(baseOpts(sb, cli));
    assert.equal((await lstat(claudeMd)).isSymbolicLink(), true);
    const text = await readFile(real, 'utf8');
    assert.ok(text.startsWith('# user rules\n\nkeep me\n'));
    assert.equal(text.split('REVIEWLOOP-GLOBAL-POLICY:BEGIN').length - 1, 1);
    assert.equal(extractManagedPolicy(text), (await readFile(COMMON, 'utf8')).trim());
    await uninstallGlobal({ configDir: sb.configDir, homeDir: sb.home, execFileSync: cli.execFileSync });
    assert.equal((await lstat(claudeMd)).isSymbolicLink(), true);
    assert.equal((await readFile(real, 'utf8')).trim(), '# user rules\n\nkeep me'.trim());
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: directories created by a failed install are cleaned up; pre-existing ones are not', async () => {
  const sb = await sandbox();
  try {
    const cli = makeFileBackedCli(sb.home, { failOn: { command: 'codex', action: 'add' } });
    // an agy config exists so the agy branch is active
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(path.join(sb.configDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { keep: { command: 'k' } } }));
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)), /boom codex add/);
    assert.equal(existsSync(sb.configDir), true);
    assert.deepEqual(await readdir(sb.configDir), ['mcp_config.json']);
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: directories the failed install created (fresh agy config dir) are really removed', { skip: SKIP_ROOT }, async () => {
  const sb = await sandbox();
  try {
    const agents = path.join(sb.home, '.codex', 'AGENTS.md');
    await writeFile(agents, '# codex\n');
    await chmod(agents, 0o444); // fails AFTER the agy files were written
    const cli = makeFileBackedCli(sb.home, { agy: true });
    assert.equal(existsSync(sb.configDir), false);
    await assert.rejects(() => installGlobal(baseOpts(sb, cli)));
    assert.equal(existsSync(sb.configDir), false, 'agy config dir created by the install must be gone');
  } finally { await chmod(path.join(sb.home, '.codex', 'AGENTS.md'), 0o644).catch(() => {}); await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G1: a concurrent user edit made during the install is not overwritten by rollback and is reported', async () => {
  const sb = await sandbox();
  try {
    const claudeMd = path.join(sb.home, '.claude', 'CLAUDE.md');
    await writeFile(claudeMd, '# before\n');
    const cli = makeFileBackedCli(sb.home, {
      failOn: { command: 'codex', action: 'add' },
      onCall: (command, args) => { if (command === 'codex' && args[1] === 'add') writeFileSync(claudeMd, '# before\nmy concurrent edit\n'); },
    });
    const err = await installGlobal(baseOpts(sb, cli)).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(await readFile(claudeMd, 'utf8'), '# before\nmy concurrent edit\n', 'concurrent edit must survive');
    const entry = err.rollback.residual.find((r) => r.path === claudeMd);
    assert.ok(entry && /someone else/.test(entry.what));
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});

test('G2-adjacent: an AGY mcp_config edited while the install runs keeps the edit (fresh re-read before write)', async () => {
  const sb = await sandbox();
  try {
    await mkdir(sb.configDir, { recursive: true });
    const cfg = path.join(sb.configDir, 'mcp_config.json');
    await writeFile(cfg, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const cli = makeFileBackedCli(sb.home, {
      agy: true,
      onCall: (command, args) => {
        if (command === 'codex' && args[1] === 'add') writeFileSync(cfg, JSON.stringify({ mcpServers: { a: { command: 'a' }, added_meanwhile: { command: 'b' } } }));
      },
    });
    await installGlobal(baseOpts(sb, cli));
    const after = JSON.parse(await readFile(cfg, 'utf8'));
    assert.ok(after.mcpServers.added_meanwhile, 'edit made during install must be kept');
    assert.ok(after.mcpServers.reviewloop && after.mcpServers.a);
  } finally { await rm(sb.tmp, { recursive: true, force: true }); }
});
