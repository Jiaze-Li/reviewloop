#!/usr/bin/env node
// ReviewLoop human CLI.
//
//   reviewloop doctor       zero-token prerequisite + repo-invariant check
//   reviewloop status       list local ReviewLoop sessions and their state
//   reviewloop reopen-gate  human override: fresh convergence budget for a stuck gate
//   reviewloop resume       print a prompt that lets a fresh Worker continue an unfinished loop
//   reviewloop install      install/refresh the global ReviewLoop policy + MCP
//   reviewloop uninstall    remove the global ReviewLoop integration
//
// The agent-facing surface is the MCP server (reviewloop_begin /
// reviewloop_review) — not this CLI.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runDoctor } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { acquireLoopFileLease } from '../src/reviewloop/loopLease.js';
import { acknowledgeUnresolvedSpend } from '../src/reviewloop/spendRecovery.js';
import { reopenExhaustedGate } from '../src/reviewloop/gateReopen.js';
import { resumableLoopsFor, buildResumePrompt, isResumable, needsReopen } from '../src/reviewloop/resumeGuide.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';

async function listSessions() {
  const root = REVIEWLOOP_RUNTIME_ROOT;
  if (!existsSync(root)) {
    console.log('No ReviewLoop sessions found.');
    return;
  }
  const dirs = await readdir(root).catch(() => []);
  let found = 0;
  for (const d of dirs) {
    const stateFile = path.join(root, d, 'workflow.json');
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      const loop = state.reviewLoop;
      if (!loop) continue;
      found += 1;
      console.log(`  ${loop.loopId}  ${loop.state}  round=${loop.round ?? 0}  reviewer=${loop.reviewerCalls ?? 0} supervisor=${loop.supervisorCalls ?? 0}`);
    } catch { /* skip */ }
  }
  if (!found) console.log('No ReviewLoop sessions found.');
}

function flagValue(args, name) {
  const eq = args.find((x) => x.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function acknowledgeSpend(rest) {
  const loopId = flagValue(rest, '--loop');
  const reservationId = flagValue(rest, '--reservation');
  const reason = flagValue(rest, '--reason');
  const excludeFamilies = flagValue(rest, '--exclude-family');
  const excludePools = flagValue(rest, '--exclude-pool');
  if (!loopId || !reservationId || !reason) {
    throw new Error(
      'usage: reviewloop acknowledge-spend --loop <loopId> --reservation <reservationId> --reason "<reason>" '
      + '[--exclude-family <family[,family]>] [--exclude-pool <pool[,pool]>]',
    );
  }

  const lease = await acquireLoopFileLease({
    runtimeRoot: REVIEWLOOP_RUNTIME_ROOT,
    loopId,
  });
  if (!lease.ok) {
    throw new Error(
      `cannot acknowledge spend while the loop is active: ${lease.heldBy?.reason ?? 'another process holds the loop lease'}`,
    );
  }
  try {
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
    const result = await acknowledgeUnresolvedSpend({
      persistence, loopId, reservationId, reason, excludeFamilies, excludePools,
    });
    console.log(result.alreadyAcknowledged
      ? 'Unresolved spend was already acknowledged.'
      : 'Unresolved spend acknowledged.');
    console.log(`  loop: ${result.loopId}`);
    console.log(`  reservation: ${result.reservationId}`);
    console.log(`  evidence: ${result.evidenceId}`);
    console.log('  accounting: usage UNKNOWN, cost UNKNOWN (preserved)');
    console.log('  retry: one human-authorized dispatch for the same operation/evidence');
    console.log(result.excludedFamilies?.length
      ? `  excluded from routing (this loop, all roles): ${result.excludedFamilies.join(', ')}`
      : '  excluded from routing: none (pass --exclude-family / --exclude-pool to avoid re-calling a known-bad entry)');
    console.log('Next: call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function reopenGate(rest) {
  const loopId = flagValue(rest, '--loop');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason) throw new Error('usage: reviewloop reopen-gate --loop <loopId> --reason "<why this gate should get another attempt>"');
  const lease = await acquireLoopFileLease({ runtimeRoot: REVIEWLOOP_RUNTIME_ROOT, loopId });
  if (!lease.ok) {
    throw new Error(`cannot reopen while the loop is active: ${lease.heldBy?.reason ?? 'another process holds the loop lease'}`);
  }
  try {
    const result = await reopenExhaustedGate({ persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT), loopId, reason });
    console.log('Gate reopened with a fresh convergence budget.');
    console.log(`  loop: ${result.loopId}  (human reopen ${result.reopens})`);
    console.log('  kept: objective, baseline, completed phases, model spend, call ceilings');
    console.log('  note: task-wide Reviewer/Supervisor call ceilings still apply; raise REVIEWLOOP_MAX_REVIEWER_CALLS / REVIEWLOOP_MAX_SUPERVISOR_CALLS if they are the limit');
    console.log('Next: tell the Worker to fix the blocker and call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function readLoops() {
  const root = REVIEWLOOP_RUNTIME_ROOT;
  if (!existsSync(root)) return [];
  const loops = [];
  for (const d of await readdir(root).catch(() => [])) {
    try {
      const state = JSON.parse(await readFile(path.join(root, d, 'workflow.json'), 'utf8'));
      if (state.reviewLoop) loops.push(state.reviewLoop);
    } catch { /* skip */ }
  }
  return loops;
}

async function resume(rest) {
  const loops = await readLoops();
  const wanted = flagValue(rest, '--loop');
  let loop;
  if (wanted) {
    loop = loops.find((l) => l.loopId === wanted);
    if (!loop) throw new Error(`unknown loopId ${wanted}`);
  } else {
    const candidates = resumableLoopsFor(loops, process.cwd());
    if (!candidates.length) {
      console.log(`No unfinished ReviewLoop task found for ${process.cwd()}.`);
      console.log('Run this from the project directory, or pass --loop <loopId> (see: reviewloop status).');
      return;
    }
    loop = candidates[0];
    if (candidates.length > 1) {
      console.error(`${candidates.length} unfinished loops here; showing the newest. Others: ${candidates.slice(1).map((l) => l.loopId).join(', ')}`);
    }
  }
  if (needsReopen(loop)) {
    console.log(`Loop ${loop.loopId} stopped with a spent budget; it needs a human decision first:`);
    console.log(`  reviewloop reopen-gate --loop ${loop.loopId} --reason "<why it should get another attempt>"`);
    console.log('then run this command again.');
    return;
  }
  if (!isResumable(loop)) {
    console.log(`Loop ${loop.loopId} is ${loop.state}; nothing to resume.`);
    return;
  }
  console.log('Paste the following into a fresh Worker session (claude / agy):');
  console.log('------------------------------------------------------------');
  console.log(buildResumePrompt(loop));
  console.log('------------------------------------------------------------');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'doctor': {
      const report = runDoctor();
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case 'status':
      await listSessions();
      break;
    case 'acknowledge-spend':
      await acknowledgeSpend(rest);
      break;
    case 'reopen-gate':
      await reopenGate(rest);
      break;
    case 'resume':
      await resume(rest);
      break;
    case 'install': {
      const res = await installGlobal();
      console.log('ReviewLoop installed globally.');
      console.log(`  MCP server: ${res.mcpBin}`);
      break;
    }
    case 'uninstall':
      await uninstallGlobal();
      console.log('ReviewLoop global integration removed.');
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log('usage: reviewloop <doctor|status|resume|acknowledge-spend|reopen-gate|install|uninstall>');
      break;
    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
