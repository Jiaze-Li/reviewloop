// Cross-process loop-lease contender. Spins on a barrier file, then races to
// acquire the ReviewLoop per-loop file lease against a pre-planted STALE lock.
// Exactly one contender across all processes may win.
//
//   LEASE_ROOT     runtimeRoot
//   LEASE_LOOP     loopId
//   LEASE_BARRIER  barrier dir (writes ready-<id>, spins until <barrier>/go)
//   LEASE_ID       this contender's id
//   LEASE_N        number of contenders; the winner holds the lease until all
//                  of them have made their attempt (see below)

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { acquireLoopFileLease } from '../../src/reviewloop/loopLease.js';

const root = process.env.LEASE_ROOT;
const loopId = process.env.LEASE_LOOP;
const barrierDir = process.env.LEASE_BARRIER;
const id = process.env.LEASE_ID || String(process.pid);

mkdirSync(barrierDir, { recursive: true });
writeFileSync(path.join(barrierDir, `ready-${id}`), '1');

const started = Date.now();
while (!existsSync(path.join(barrierDir, 'go'))) {
  if (Date.now() - started > 15000) { process.stdout.write(JSON.stringify({ id, error: 'barrier timeout' }) + '\n'); process.exit(2); }
}

const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId });
process.stdout.write(JSON.stringify({ id, pid: process.pid, ok: lease.ok }) + '\n');
// Record that this contender has made its attempt.
writeFileSync(path.join(barrierDir, `done-${id}`), '1');
if (lease.ok) {
  // Hold the lease until EVERY contender has attempted (not for a fixed time):
  // on a loaded runner a slow peer can start its attempt long after a timed hold
  // expired, and would then legitimately acquire the released lock - which is
  // not the race this test is about. Bounded so a crashed peer cannot hang us.
  const total = Number(process.env.LEASE_N) || 1;
  const deadline = Date.now() + 10000;
  while (readdirSync(barrierDir).filter((f) => f.startsWith('done-')).length < total && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await lease.release();
}
