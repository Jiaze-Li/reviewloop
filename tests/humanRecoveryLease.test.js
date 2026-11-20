// Design d3 §4.8: a live holder keeps the loop lease forever (same host); the
// human path is "identify, stop it yourself, check unsettled calls, then
// continue or end" - never a forced unlock. Real lock files, real CLI process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLoopFileLease, describeLoopLease } from '../src/reviewloop/loopLease.js';

const cli = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
const runCli = (root, args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 15000, env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: root },
});
const ID = 'rl-20261120000000-lease';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reviewloop-lease-'));
  const dir = path.join(root, ID);
  await mkdir(dir, { recursive: true });
  const wf = {
    reviewLoop: {
      loopId: ID, state: 'REWORK', round: 2, objective: { mode: 'LOCAL', taskType: 'code' },
      history: [], updatedAt: '2026-11-20T00:00:00.000Z',
    },
  };
  const file = path.join(dir, 'workflow.json');
  await writeFile(file, JSON.stringify(wf, null, 2));
  return { root, dir, file, lock: path.join(dir, 'reviewloop.lock') };
}

test('a live same-host holder is NEVER reclaimed, even long after its expiry time (the d2 premise was wrong)', async () => {
  const t = await setup();
  try {
    const held = await acquireLoopFileLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(held.ok, true);
    const tenHours = () => Date.now() + 10 * 3600 * 1000;
    const second = await acquireLoopFileLease({ runtimeRoot: t.root, loopId: ID, clock: tenHours });
    assert.equal(second.ok, false, 'an expired TTL does not free a live same-host owner');

    const lockBefore = await readFile(t.lock, 'utf8');
    const mtimeBefore = (await stat(t.lock)).mtimeMs;
    const seen = await describeLoopLease({ runtimeRoot: t.root, loopId: ID, clock: tenHours });
    assert.equal(seen.status, 'HELD');
    assert.equal(seen.alive, true);
    assert.equal(seen.sameHost, true);
    assert.equal(seen.ttlExpired, true);
    assert.equal(seen.reclaimable, false);
    assert.equal(seen.pid, process.pid);
    assert.ok(seen.secondsSinceRenewal >= 9 * 3600);
    assert.equal(await readFile(t.lock, 'utf8'), lockBefore, 'describeLoopLease never writes');
    assert.equal((await stat(t.lock)).mtimeMs, mtimeBefore);
    await held.release();
    assert.equal((await describeLoopLease({ runtimeRoot: t.root, loopId: ID })).status, 'FREE');
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('other host: expiry decides; a holder whose pid is gone is reclaimable; describe agrees with the real rule', async () => {
  const t = await setup();
  try {
    const rec = (over) => JSON.stringify({
      token: 't', pid: 1, host: 'some-other-host', acquiredAt: '2026-11-20T00:00:00.000Z', renewedAt: '2026-11-20T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...over,
    });
    await writeFile(t.lock, rec({}));
    let seen = await describeLoopLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(seen.status, 'HELD'); assert.equal(seen.sameHost, false); assert.equal(seen.reclaimable, false);
    assert.equal((await acquireLoopFileLease({ runtimeRoot: t.root, loopId: ID })).ok, false);

    await writeFile(t.lock, rec({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    seen = await describeLoopLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(seen.status, 'RECLAIMABLE');

    const gone = spawnSync(process.execPath, ['-e', '']).pid; // a pid that has exited
    await writeFile(t.lock, rec({ host: os.hostname(), pid: gone }));
    seen = await describeLoopLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(seen.status, 'RECLAIMABLE'); assert.equal(seen.alive, false);
    const lease = await acquireLoopFileLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(lease.ok, true, 'once the process is gone the next command reclaims the lock by itself');
    await lease.release();
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

const ACTIONS = (id) => ({
  'stop-loop': ['stop-loop', '--loop', id, '--reason', 'r'],
  'extend-calls': ['extend-calls', '--loop', id, '--reviewer-calls', '3', '--reason', 'r'],
  'reopen-gate': ['reopen-gate', '--loop', id, '--reason', 'r'],
  'acknowledge-token-anomaly': ['acknowledge-token-anomaly', '--loop', id, '--latch', 'x', '--reason', 'r'],
  'override-budget': ['override-budget', '--loop', id, '--max-usage', '999999', '--reason', 'r'],
  'acknowledge-spend': ['acknowledge-spend', '--loop', id, '--reservation', 'r1', '--reason', 'r'],
});

test('all six human actions refuse a held lock with the SAME guidance, change nothing, and succeed once the holder is gone', async () => {
  const t = await setup();
  try {
    const initial = await readFile(t.file, 'utf8');
    const held = await acquireLoopFileLease({ runtimeRoot: t.root, loopId: ID });
    assert.equal(held.ok, true);
    const lockBefore = await readFile(t.lock, 'utf8');
    for (const [name, args] of Object.entries(ACTIONS(ID))) {
      const out = runCli(t.root, args);
      assert.notEqual(out.status, 0, name);
      assert.match(out.stderr, new RegExp(`pid ${process.pid} on ${os.hostname().replace(/\./g, '\\.')}`), name);
      assert.match(out.stderr, /NEVER reclaimed while that process is alive/, name);
      assert.match(out.stderr, /stop it yourself/, name);
      assert.match(out.stderr, /unsettled calls/, name);
      assert.match(out.stderr, /Do NOT delete or overwrite reviewloop\.lock/, name);
      assert.equal(await readFile(t.file, 'utf8'), initial, `${name} wrote nothing`);
      assert.equal(await readFile(t.lock, 'utf8'), lockBefore, `${name} left the lock alone`);
    }
    const status = runCli(t.root, ['lock-status', '--loop', ID]);
    assert.equal(status.status, 0);
    assert.match(status.stdout, new RegExp(`pid ${process.pid}`));

    await held.release();
    const stop = runCli(t.root, ACTIONS(ID)['stop-loop']);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(await readFile(t.file, 'utf8')).reviewLoop.state, 'STOPPED');
    const files = await readdir(t.dir);
    assert.ok(!files.includes('reviewloop.lock'), 'the CLI released its own lock');
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('static: nothing outside the lease module can delete, rename or overwrite a loop lock (I8)', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  await walk(path.join(root, 'src'));
  await walk(path.join(root, 'bin'));
  for (const f of files) {
    if (path.basename(f) === 'loopLease.js') continue;
    const text = await readFile(f, 'utf8');
    if (!/reviewloop\.lock|lockPath/.test(text)) continue;
    assert.doesNotMatch(text, /\b(unlink|unlinkSync|rm|rmSync|rename|renameSync|writeFile|writeFileSync)\s*\(/, `${path.relative(root, f)} must not touch the lock file`);
  }
  // and the new guidance/describe code never signals a process
  assert.doesNotMatch(await readFile(path.join(root, 'src/reviewloop/leaseGuidance.js'), 'utf8'), /process\.kill|SIGKILL|SIGTERM/);
  const lease = await readFile(path.join(root, 'src/reviewloop/loopLease.js'), 'utf8');
  const describeBody = lease.slice(lease.indexOf('export async function describeLoopLease'));
  assert.doesNotMatch(describeBody, /unlink|writeFile|rename|\.kill\(/, 'describeLoopLease is read-only');
});
