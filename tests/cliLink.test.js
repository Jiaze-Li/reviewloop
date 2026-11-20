import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  mkdtemp, mkdir, writeFile, symlink, lstat, readlink, rm, chmod, readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  inspectCliLinks, planCliRepair, applyCliRepair, runCliCommand, checkCliLink,
} from '../scripts/cliLink.js';
import { runDoctor } from '../scripts/doctor.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = (file, args, opts) => {
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) { const e = new Error(r.stderr || `exit ${r.status}`); e.stderr = r.stderr; throw e; }
  return r.stdout;
};

async function prefixWith({ lib = 'good', bin = 'good' } = {}) {
  const prefix = await mkdtemp(path.join(os.tmpdir(), 'rl-cli-'));
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await mkdir(path.join(prefix, 'lib', 'node_modules'), { recursive: true });
  const libPkg = path.join(prefix, 'lib', 'node_modules', 'reviewloop');
  if (lib === 'good') await symlink(REPO, libPkg);
  if (lib === 'dangling-owned') await symlink(path.join(prefix, 'old-place', 'reviewloop'), libPkg);
  if (lib === 'dangling-foreign') await symlink(path.join(prefix, 'old-place', 'something-else'), libPkg);
  if (lib === 'other-checkout') {
    const other = path.join(prefix, 'other', 'reviewloop');
    await mkdir(other, { recursive: true });
    await symlink(other, libPkg);
  }
  if (lib === 'real-dir') await mkdir(libPkg);
  if (bin === 'good') {
    for (const n of ['reviewloop', 'reviewloop-mcp']) await symlink(`../lib/node_modules/reviewloop/bin/${n}.js`, path.join(prefix, 'bin', n));
  }
  if (bin === 'foreign') {
    for (const n of ['reviewloop', 'reviewloop-mcp']) await symlink('/usr/bin/true', path.join(prefix, 'bin', n));
  }
  return { prefix, libPkg };
}
const inspect = (prefix, extra = {}) => inspectCliLinks({ prefix, repoRoot: REPO, pathEnv: path.join(prefix, 'bin'), execFileSync: exec, ...extra });
const statuses = (r) => Object.fromEntries(r.links.map((l) => [l.name, l.status]));

test('healthy links: ok AND the linked command really runs (spec through the binary)', async () => {
  const { prefix } = await prefixWith();
  try {
    const r = inspect(prefix);
    assert.deepEqual(statuses(r), { reviewloop: 'ok', 'reviewloop-mcp': 'ok' });
    assert.equal(r.links[0].runnable, true);
    assert.equal(r.ok, true);
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('the reported failure shape (package link -> missing ".../reviewloop" subdir) is dangling-owned and repairable', async () => {
  const { prefix } = await prefixWith({ lib: 'dangling-owned' });
  try {
    const r = inspect(prefix);
    assert.deepEqual(statuses(r), { reviewloop: 'dangling-owned', 'reviewloop-mcp': 'dangling-owned' });
    assert.equal(r.ok, false);
    assert.equal(planCliRepair(r).length, 1, 'one shared package link to fix');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('dry run changes nothing; --apply re-points the link atomically and the command then runs', async () => {
  const { prefix, libPkg } = await prefixWith({ lib: 'dangling-owned' });
  try {
    const before = await readlink(libPkg);
    const lines = [];
    assert.equal(runCliCommand(['repair'], { prefix, repoRoot: REPO, pathEnv: path.join(prefix, 'bin'), execFileSync: exec, log: (l) => lines.push(l) }), 1);
    assert.equal(await readlink(libPkg), before, 'dry run must not touch the link');
    assert.ok(lines.some((l) => /Dry run only/.test(l)));

    const code = runCliCommand(['repair', '--apply'], { prefix, repoRoot: REPO, pathEnv: path.join(prefix, 'bin'), execFileSync: exec, log: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(await readlink(libPkg), REPO);
    assert.equal(inspect(prefix).ok, true);
    assert.equal(existsSync(`${libPkg}.rl-tmp-${process.pid}`), false, 'no temp link left behind');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('foreign / other-checkout / real directory / dangling-but-not-ReviewLoop links are reported and never modified', async () => {
  for (const [lib, bin, expected] of [
    ['dangling-foreign', 'good', 'foreign'],
    ['other-checkout', 'good', 'wrong-target'],
    ['real-dir', 'good', 'foreign'],
    ['good', 'foreign', 'foreign'],
  ]) {
    const { prefix, libPkg } = await prefixWith({ lib, bin });
    try {
      const snapshot = async () => ({
        lib: await lstat(libPkg).then(async (s) => (s.isSymbolicLink() ? readlink(libPkg) : 'dir'), () => 'none'),
        bin: await readlink(path.join(prefix, 'bin', 'reviewloop')).catch(() => 'none'),
      });
      const before = await snapshot();
      const r = inspect(prefix);
      assert.equal(r.links[0].status, expected, `${lib}/${bin}`);
      assert.equal(planCliRepair(r).length, 0);
      const code = runCliCommand(['repair', '--apply'], { prefix, repoRoot: REPO, pathEnv: path.join(prefix, 'bin'), execFileSync: exec, log: () => {} });
      assert.equal(code, 1);
      assert.deepEqual(await snapshot(), before);
    } finally { await rm(prefix, { recursive: true, force: true }); }
  }
});

test('PATH conflict: another `reviewloop` earlier on PATH is path-shadowed, reported, not touched', async () => {
  const { prefix } = await prefixWith();
  const other = await mkdtemp(path.join(os.tmpdir(), 'rl-other-'));
  try {
    const rival = path.join(other, 'reviewloop');
    await writeFile(rival, '#!/bin/sh\nexit 0\n');
    await chmod(rival, 0o755);
    const r = inspect(prefix, { pathEnv: [other, path.join(prefix, 'bin')].join(path.delimiter) });
    assert.equal(r.links.find((l) => l.name === 'reviewloop').status, 'path-shadowed');
    assert.equal(await readFile(rival, 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally { await rm(prefix, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('nothing global at all is absent with a manual next step; repair does nothing', async () => {
  const { prefix } = await prefixWith({ lib: 'none', bin: 'none' });
  try {
    const r = inspect(prefix);
    assert.equal(r.links[0].status, 'absent');
    assert.match(r.links[0].next, /npm link/);
    assert.equal(planCliRepair(r).length, 0);
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('unknown prefix: reports and stops, plans nothing', () => {
  const r = inspectCliLinks({ prefix: null, repoRoot: REPO });
  assert.equal(r.prefixKnown, false);
  assert.equal(r.ok, false);
  assert.deepEqual(planCliRepair(r), []);
  assert.equal(runCliCommand(['repair', '--apply'], { prefix: null, repoRoot: REPO, log: () => {} }), 1);
});

test('permission denied: reports, leaves the old link, gives a next step, never escalates', async () => {
  const { prefix, libPkg } = await prefixWith({ lib: 'dangling-owned' });
  const parent = path.dirname(libPkg);
  try {
    const before = await readlink(libPkg);
    await chmod(parent, 0o555);
    const results = applyCliRepair(planCliRepair(inspect(prefix)));
    await chmod(parent, 0o755);
    assert.equal(results[0].applied, false);
    assert.match(results[0].next, /Nothing was changed|No permission/);
    assert.equal(await readlink(libPkg), before);
  } finally { await chmod(parent, 0o755).catch(() => {}); await rm(prefix, { recursive: true, force: true }); }
});

test('doctor: a broken command link is a warning, never a core failure; healthy prints ok', async () => {
  const { prefix } = await prefixWith({ lib: 'dangling-owned' });
  try {
    const lines = [];
    const report = runDoctor({
      log: (l) => lines.push(l), execSync: () => 'ok', env: {},
      cliLinkCheck: () => checkCliLink({ prefix, repoRoot: REPO, pathEnv: path.join(prefix, 'bin'), execFileSync: exec }),
    });
    assert.ok(lines.some((l) => /warn\s+cli_link:.*dangling-owned/.test(l)));
    assert.ok(lines.some((l) => /cli repair/.test(l)));
    assert.equal(report.results.cli_link.ok, false);
    assert.equal(report.ok, true, 'cli_link must not change the core verdict');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('package.json exposes cli:status and cli:repair', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['cli:status'], /reviewloop\.js cli status/);
  assert.match(pkg.scripts['cli:repair'], /reviewloop\.js cli repair/);
});

test('links ok but bin dir not on PATH is not-on-path (not a false "ok")', async () => {
  const { prefix } = await prefixWith();
  try {
    const r = inspect(prefix, { pathEnv: '/nonexistent-dir' });
    assert.equal(r.links[0].status, 'not-on-path');
    assert.equal(r.ok, false);
    assert.equal(planCliRepair(r).length, 0);
    assert.match(r.links[0].next, /PATH/);
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('the runnable probe does not call a healthy link broken when engineering/ has uncommitted edits', async () => {
  const { prefix } = await prefixWith();
  const probe = [];
  try {
    const r = inspect(prefix, { execFileSync: (file, args, o) => { probe.push(args); return exec(file, args, o); } });
    assert.equal(r.links[0].status, 'ok');
    assert.ok(probe.some((a) => a.includes('--allow-dirty')), 'probe must pass --allow-dirty');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});
