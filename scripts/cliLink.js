// Global `reviewloop` command diagnosis + safe repair.
//
// npm's global layout (what `npm link` / `npm i -g <dir>` produce) is two links:
//   <prefix>/lib/node_modules/reviewloop  ->  <repo checkout>          (package link)
//   <prefix>/bin/<name>                   ->  ../lib/node_modules/reviewloop/bin/<name>.js
// ReviewLoop's installer never creates these; they are left by an earlier npm
// link. This module only INSPECTS them and, on explicit request, re-points a
// dangling package link that is recognisably ReviewLoop's own. It never writes
// anything it does not own, never uses sudo, and does zero model calls.

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI_NAMES = ['reviewloop', 'reviewloop-mcp'];
const PACKAGE_DIR = 'reviewloop';
const OWNED_DIR_NAMES = new Set(['reviewloop', 'gpt-dev-loop']);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getGlobalPrefix({ execFileSync = nodeExecFileSync } = {}) {
  try {
    const out = String(execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return out || null;
  } catch {
    return null;
  }
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isOwnedDirName(target) {
  return OWNED_DIR_NAMES.has(path.basename(String(target)).toLowerCase());
}

function expectedBinTarget(name) {
  return `../lib/node_modules/${PACKAGE_DIR}/bin/${name}.js`;
}

// First `name` executable found on PATH (what a shell would run).
function firstOnPath(name, pathEnv) {
  for (const dir of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function probeRunnable(binLink, name, execFileSync) {
  // reviewloop-mcp is a stdio server: do not start it, only prove the file is executable.
  try {
    if (name === 'reviewloop') {
      execFileSync(binLink, ['spec', 'plan', '--allow-dirty'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 });
    } else {
      fs.accessSync(binLink, fs.constants.X_OK);
    }
    return { runnable: true };
  } catch (err) {
    return { runnable: false, error: String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 200) };
  }
}

function inspectOne({ name, prefix, repoRoot, pathEnv, execFileSync }) {
  const binLink = path.join(prefix, 'bin', name);
  const libPkg = path.join(prefix, 'lib', 'node_modules', PACKAGE_DIR);
  const base = { name, binLink, libPkg, repoRoot, runnable: false };
  const repoReal = realpathOrNull(repoRoot) || repoRoot;

  const binSt = lstatOrNull(binLink);
  const libSt = lstatOrNull(libPkg);
  const binIsLink = binSt?.isSymbolicLink();
  const libIsLink = libSt?.isSymbolicLink();
  const binTarget = binIsLink ? fs.readlinkSync(binLink) : null;
  const libTarget = libIsLink ? fs.readlinkSync(libPkg) : null;
  const ln = `ln -sfn "${repoRoot}" "${libPkg}"`;

  if (!binSt && !libSt) {
    return { ...base, status: 'absent', detail: 'no global link exists', repairable: false, next: `From the checkout run \`npm link\` (creates ${libPkg} and ${binLink}); it may need write access to ${prefix}.` };
  }
  if ((binSt && !binIsLink) || (libSt && !libIsLink)) {
    return { ...base, status: 'foreign', detail: `${binSt && !binIsLink ? binLink : libPkg} is a real file/directory, not a link`, repairable: false, next: 'Not touched: another tool (or a copied install) owns it. Remove it yourself if it is stale, then run `npm link` from the checkout.' };
  }
  if (binIsLink && binTarget !== expectedBinTarget(name)) {
    return { ...base, status: 'foreign', detail: `${binLink} -> ${binTarget} (not the ReviewLoop npm layout)`, repairable: false, next: 'Not touched: this link points somewhere that is not ReviewLoop\'s npm package link.' };
  }
  if (libIsLink) {
    const libReal = realpathOrNull(libPkg);
    if (!libReal) {
      const owned = isOwnedDirName(libTarget);
      return owned
        ? { ...base, status: 'dangling-owned', detail: `${libPkg} -> ${libTarget} (target no longer exists)`, repairable: true, next: `Preview: reviewloop cli repair. Apply: node "${path.join(repoRoot, 'bin', 'reviewloop.js')}" cli repair --apply (equivalent to: ${ln}).` }
        : { ...base, status: 'foreign', detail: `${libPkg} -> ${libTarget} is dangling but not recognisably ReviewLoop's`, repairable: false, next: 'Not touched: the dangling link does not look like ReviewLoop\'s.' };
    }
    if (libReal !== repoReal) {
      return { ...base, status: 'wrong-target', detail: `${libPkg} -> ${libReal}, not this checkout (${repoReal})`, repairable: false, next: `An existing, different checkout is linked. If you want this one: ${ln}` };
    }
  } else if (binIsLink) {
    // package link missing while the bin link still has the npm layout => owned, repairable.
    return { ...base, status: 'absent', detail: `${libPkg} is missing; ${binLink} is dangling`, repairable: true, next: `Preview: reviewloop cli repair. Apply: node "${path.join(repoRoot, 'bin', 'reviewloop.js')}" cli repair --apply (equivalent to: ${ln}).` };
  } else {
    return { ...base, status: 'absent', detail: `${binLink} is missing (package link present)`, repairable: false, next: `From the checkout run \`npm link\` to recreate ${binLink}.` };
  }

  if (!binSt) {
    return { ...base, status: 'absent', detail: `${binLink} is missing (package link present)`, repairable: false, next: `From the checkout run \`npm link\` to recreate ${binLink}.` };
  }

  const probe = probeRunnable(binLink, name, execFileSync);
  if (!probe.runnable) {
    return { ...base, status: 'broken', detail: `links resolve but the command does not run: ${probe.error}`, repairable: false, next: 'Run `node bin/reviewloop.js doctor` from the checkout for details.' };
  }
  const first = firstOnPath(name, pathEnv);
  if (!first) {
    return { ...base, runnable: true, status: 'not-on-path', detail: `links resolve and run, but no \`${name}\` is on PATH (${path.dirname(binLink)} is not in PATH)`, repairable: false, next: `Not touched: add ${path.dirname(binLink)} to PATH in your shell profile.` };
  }
  if ( realpathOrNull(first) !== realpathOrNull(binLink)) {
    return { ...base, runnable: true, status: 'path-shadowed', detail: `PATH resolves \`${name}\` to ${first} first`, repairable: false, shadow: first, next: `Not touched: put ${path.dirname(binLink)} before ${path.dirname(first)} in PATH, or remove the other program yourself.` };
  }
  return { ...base, runnable: true, status: 'ok', detail: 'links resolve and the command runs', repairable: false, next: null };
}

export function inspectCliLinks({
  prefix,
  repoRoot = DEFAULT_REPO_ROOT,
  pathEnv = process.env.PATH,
  execFileSync = nodeExecFileSync,
} = {}) {
  if (!prefix) {
    return { ok: false, prefix: null, prefixKnown: false, links: [], issues: ['global npm prefix unknown (npm prefix -g failed); nothing was inspected or changed'] };
  }
  const links = CLI_NAMES.map((name) => inspectOne({ name, prefix, repoRoot, pathEnv, execFileSync }));
  const issues = links.filter((l) => l.status !== 'ok').map((l) => `${l.name}: ${l.status} — ${l.detail}${l.next ? ` | next: ${l.next}` : ''}`);
  return { ok: issues.length === 0, prefix, prefixKnown: true, links, issues };
}

// The only repair there is: re-point the shared package link at this checkout.
export function planCliRepair(report) {
  if (!report.prefixKnown) return [];
  const seen = new Set();
  const actions = [];
  for (const link of report.links) {
    if (!link.repairable || seen.has(link.libPkg)) continue;
    seen.add(link.libPkg);
    actions.push({ kind: 'relink-package', path: link.libPkg, target: link.repoRoot, because: `${link.name}: ${link.detail}` });
  }
  return actions;
}

export function applyCliRepair(actions) {
  const results = [];
  for (const action of actions) {
    const tmp = `${action.path}.rl-tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(action.path), { recursive: true });
      fs.rmSync(tmp, { force: true });
      fs.symlinkSync(action.target, tmp);
      fs.renameSync(tmp, action.path); // atomic replace of the old (dangling) link
      results.push({ ...action, applied: true });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      const denied = err?.code === 'EACCES' || err?.code === 'EPERM';
      results.push({
        ...action,
        applied: false,
        error: err?.message || String(err),
        next: denied
          ? `No permission to write ${path.dirname(action.path)}. Nothing was changed. Run it yourself with the access you choose: ln -sfn "${action.target}" "${action.path}"`
          : `Nothing was changed. Run it yourself: ln -sfn "${action.target}" "${action.path}"`,
      });
    }
  }
  return results;
}

export function checkCliLink({ execFileSync = nodeExecFileSync, repoRoot, pathEnv, prefix } = {}) {
  const resolvedPrefix = prefix === undefined ? getGlobalPrefix({ execFileSync }) : prefix;
  const report = inspectCliLinks({ prefix: resolvedPrefix, repoRoot, pathEnv, execFileSync });
  return { name: 'cli_link', ...report };
}

function formatStatus(report) {
  const lines = [`Global command links (prefix: ${report.prefix ?? 'unknown'}):`];
  if (!report.prefixKnown) { lines.push(`  ${report.issues[0]}`); return lines; }
  for (const l of report.links) {
    lines.push(`  ${l.status === 'ok' ? 'ok  ' : 'warn'}  ${l.name}: ${l.status} — ${l.detail}`);
    if (l.next) lines.push(`        next: ${l.next}`);
  }
  return lines;
}

// `reviewloop cli status|repair [--apply]` — returns the process exit code.
export function runCliCommand(args, {
  execFileSync = nodeExecFileSync, repoRoot, pathEnv, prefix, log = console.log,
} = {}) {
  const [sub, ...flags] = args;
  if (sub !== 'status' && sub !== 'repair') {
    log('usage: reviewloop cli <status|repair [--apply]>');
    return 1;
  }
  const resolvedPrefix = prefix === undefined ? getGlobalPrefix({ execFileSync }) : prefix;
  const report = inspectCliLinks({ prefix: resolvedPrefix, repoRoot, pathEnv, execFileSync });
  for (const line of formatStatus(report)) log(line);
  if (sub === 'status') return report.ok ? 0 : 1;

  const actions = planCliRepair(report);
  if (actions.length === 0) {
    log(report.ok ? 'Nothing to repair.' : 'Nothing this command is allowed to repair (see the notes above).');
    return report.ok ? 0 : 1;
  }
  const apply = flags.includes('--apply');
  for (const a of actions) log(`${apply ? 'repairing' : 'would repair'}: point ${a.path} -> ${a.target} (${a.because})`);
  if (!apply) { log('Dry run only — nothing changed. Re-run with --apply to perform it.'); return 1; }

  const results = applyCliRepair(actions);
  let failed = false;
  for (const r of results) {
    if (r.applied) log(`done: ${r.path} -> ${r.target}`);
    else { failed = true; log(`FAILED: ${r.path}: ${r.error}`); log(`  next: ${r.next}`); }
  }
  if (failed) return 1;
  const after = inspectCliLinks({ prefix: resolvedPrefix, repoRoot, pathEnv, execFileSync });
  for (const line of formatStatus(after)) log(line);
  return after.ok ? 0 : 1;
}
