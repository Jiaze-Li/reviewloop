#!/usr/bin/env node
// ReviewLoop human CLI.
//
//   reviewloop doctor       zero-token prerequisite + repo-invariant check
//   reviewloop status       list local ReviewLoop sessions and their state
//   reviewloop profile      read-only per-loop physical-call/token breakdown
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
import { runDoctor, checkLegacyManagedEnv } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { acquireLoopFileLease } from '../src/reviewloop/loopLease.js';
import { acquireLeaseWithRetry } from '../src/reviewloop/prWatcher.js';
import { acknowledgeUnresolvedSpend } from '../src/reviewloop/spendRecovery.js';
import { reopenExhaustedGate } from '../src/reviewloop/gateReopen.js';
import { overrideLoopBudget } from '../src/reviewloop/budgetOverride.js';
import { buildTokenProfile, formatTokenProfile } from '../src/reviewloop/tokenProfile.js';
import { inspectSpend, formatSpendInspection } from '../src/reviewloop/spendInspect.js';
import { unfinishedLoopsFor, buildResumePrompt, isResumable, needsReopen } from '../src/reviewloop/resumeGuide.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';
import { applySettingsFile } from '../src/reviewloop/settingsFile.js';
import {
  formatPrStatusEntry,
  buildPrResumeText,
  stopPrTask,
  bindPrAgent,
  pushPrHeadCli,
  triggerPrReviewCli,
} from '../src/reviewloop/prCli.js';

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
      console.log(`  ${loop.loopId}  ${loop.state}  round=${loop.round ?? 0}  reviewer=${loop.reviewerCalls ?? 0} supervisor=${loop.supervisorCalls ?? 0}${loop.objective?.mode === 'PR' ? '  [RETIRED_PR]' : ''}`);
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
    console.log('  note: task-wide Reviewer/Supervisor call ceilings still apply; raise MAX_REVIEWER_CALLS / MAX_SUPERVISOR_CALLS in reviewloop.settings.json if they are the limit');
    console.log('Next: tell the Worker to fix the blocker and call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function overrideBudget(rest) {
  const loopId = flagValue(rest, '--loop');
  const maxUsage = flagValue(rest, '--max-usage');
  const maxCost = flagValue(rest, '--max-cost');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason || (!maxUsage && !maxCost)) {
    throw new Error('usage: reviewloop override-budget --loop <loopId> --reason "<explanation>" [--max-usage <tokens>] [--max-cost <usd>]');
  }
  const lease = await acquireLoopFileLease({ runtimeRoot: REVIEWLOOP_RUNTIME_ROOT, loopId });
  if (!lease.ok) {
    throw new Error(`cannot override budget while the loop is active: ${lease.heldBy?.reason ?? 'another process holds the loop lease'}`);
  }
  try {
    const result = await overrideLoopBudget({
      persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT),
      loopId,
      maxUsage,
      maxCost,
      reason,
    });
    console.log('Per-loop budget successfully expanded.');
    console.log(`  loop: ${result.loopId}`);
    if (result.previousUsageLimit !== result.newUsageLimit || maxUsage) {
      console.log(`  usage limit: ${result.previousUsageLimit} -> ${result.newUsageLimit} tokens (currently used: ${result.currentUsage})`);
    }
    if (result.previousCostLimit !== result.newCostLimit || maxCost) {
      console.log(`  cost limit: $${result.previousCostLimit} -> $${result.newCostLimit} (currently used: $${result.currentCost.toFixed(2)})`);
    }
    console.log(`  audit: override #${result.overridesCount} durably recorded`);
    if (result.stateRestored) {
      console.log(`  state: restored from HUMAN_REQUIRED to ${result.loopState}`);
      console.log('Next: tell the Worker to call reviewloop_review again with the same loopId.');
    } else {
      console.log(`  state: retained as ${result.loopState}`);
      console.log('Note: budget ceilings updated, but loop state was not restored (e.g. convergence rounds exhausted; use reviewloop reopen-gate if needed).');
    }
  } finally {
    await lease.release();
  }
}

async function profile(rest) {
  const loopId = flagValue(rest, '--loop');
  if (!loopId) throw new Error('usage: reviewloop profile --loop <loopId> [--json]');
  const workflow = await new Persistence(REVIEWLOOP_RUNTIME_ROOT).readWorkflowState(loopId);
  if (!workflow?.reviewLoop) throw new Error(`unknown ReviewLoop session: ${loopId}`);
  const report = buildTokenProfile({ loopId, workflow });
  console.log(rest.includes('--json') ? JSON.stringify(report, null, 2) : formatTokenProfile(report));
}

async function inspectSpendCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const reservationId = flagValue(rest, '--reservation');
  const operationId = flagValue(rest, '--operation');
  if (!loopId || Boolean(reservationId) === Boolean(operationId)) {
    throw new Error('usage: reviewloop inspect-spend --loop <loopId> (--reservation <uuid> | --operation <operationId>) [--json]');
  }
  const result = await inspectSpend({
    persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT),
    loopId, reservationId, operationId,
  });
  console.log(rest.includes('--json')
    ? JSON.stringify(result, null, 2)
    : formatSpendInspection(result));
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
    const candidates = unfinishedLoopsFor(loops, process.cwd());
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
  if (loop.objective?.mode === 'PR') {
    console.log(`Loop ${loop.loopId} is a retired PR review. Start a new review via claude-review-bot; the saved record remains unchanged.`);
    return;
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

async function handlePrCommand(rest) {
  const [sub, ...args] = rest;
  const loopId = flagValue(args, '--loop');
  const root = REVIEWLOOP_RUNTIME_ROOT;

  if (sub === 'status') {
    const entries = [];
    if (existsSync(root)) {
      for (const d of await readdir(root).catch(() => [])) {
        if (loopId && d !== loopId) continue;
        try {
          const state = JSON.parse(await readFile(path.join(root, d, 'workflow.json'), 'utf8'));
          if (state.reviewLoop?.objective?.mode === 'PR') continue;
          if (state.reviewLoop?.objective?.taskType === 'pr' && state.prTask) {
            entries.push(formatPrStatusEntry({ loopState: state.reviewLoop, prTask: state.prTask }));
          }
        } catch { /* skip */ }
      }
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (!entries.length) {
      console.log('No PR Task sessions found.');
      return;
    }
    for (const e of entries) {
      console.log(
        `  ${e.loopId}  PR #${e.prNumber} (${e.repoFullName})  state=${e.state}  bot=${e.botStatus}  findings=${e.openFindingsCount}  triggers=${e.postedReviewTriggers}/3  head=${String(e.boundHeadSha).slice(0, 8)}${e.watcherPid ? `  watcherPid=${e.watcherPid}` : ''}${e.wakeStatus ? `  wake=${e.wakeStatus}` : ''}`,
      );
    }
    return;
  }

  if (sub === 'resume') {
    if (!loopId) throw new Error('usage: reviewloop pr resume --loop <loopId>');
    const state = await new Persistence(root).readWorkflowState(loopId);
    console.log(buildPrResumeText({ loopState: state?.reviewLoop, prTask: state?.prTask }));
    return;
  }

  if (sub === 'stop') {
    if (!loopId) throw new Error('usage: reviewloop pr stop --loop <loopId> [--reason "<reason>"]');
    const reason = flagValue(args, '--reason') ?? 'stopped by user';
    const lease = await acquireLeaseWithRetry({ runtimeRoot: root, loopId, reason: 'pr-stop' });
    if (!lease.ok) {
      throw new Error(`cannot stop PR task while lease is held: ${lease.heldBy?.reason ?? 'active'}`);
    }
    try {
      const res = await stopPrTask({ persistence: new Persistence(root), loopId, reason });
      console.log(`Stopped PR Task ${res.loopId} (state=${res.state}, reason=${res.reason}).`);
    } finally {
      await lease.release();
    }
    return;
  }

  if (sub === 'push') {
    if (!loopId) throw new Error('usage: reviewloop pr push --loop <loopId>');
    const persistence = new Persistence(root);
    const withLeaseFn = async (fn) => {
      const lease = await acquireLeaseWithRetry({ runtimeRoot: root, loopId, reason: 'pr-push' });
      if (!lease.ok) throw new Error(`cannot push PR head while lease is held: ${lease.heldBy?.reason ?? 'active'}`);
      try {
        return await fn();
      } finally {
        await lease.release();
      }
    };
    const res = await pushPrHeadCli({ persistence, loopId, withLeaseFn });
    console.log(`Pushed ${res.headBranch} and bound PR Task ${loopId} to ${res.newHeadSha} (from ${res.oldHeadSha}).`);
    return;
  }

  if (sub === 'trigger-review') {
    if (!loopId) throw new Error('usage: reviewloop pr trigger-review --loop <loopId>');
    const persistence = new Persistence(root);
    const withLeaseFn = async (fn) => {
      const lease = await acquireLeaseWithRetry({ runtimeRoot: root, loopId, reason: 'pr-trigger' });
      if (!lease.ok) throw new Error(`cannot trigger review while lease is held: ${lease.heldBy?.reason ?? 'active'}`);
      try {
        return await fn();
      } finally {
        await lease.release();
      }
    };
    const res = await triggerPrReviewCli({ persistence, loopId, withLeaseFn });
    if (res.posted) {
      console.log(`Triggered @gemini review for ${loopId} (${res.postedCount}/3, commentId=${res.trigger?.commentId ?? 'unknown'}).`);
    } else {
      console.error(`Did not trigger @gemini review for ${loopId}: ${res.reason} (${res.postedCount}/3).`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'bind-agent') {
    const agentType = flagValue(args, '--agent');
    const agentSessionId = flagValue(args, '--session');
    if (!loopId || !agentType) {
      throw new Error('usage: reviewloop pr bind-agent --loop <loopId> --agent <claude|codex|agy> [--session <id>]');
    }
    const lease = await acquireLeaseWithRetry({ runtimeRoot: root, loopId, reason: 'pr-bind-agent' });
    if (!lease.ok) throw new Error(`cannot bind agent while lease is held: ${lease.heldBy?.reason ?? 'active'}`);
    try {
      const res = await bindPrAgent({ persistence: new Persistence(root), loopId, agentType, agentSessionId });
      console.log(`Bound agent=${res.agentType}${res.agentSessionId ? ` session=${res.agentSessionId}` : ''} to PR Task ${res.loopId}.`);
    } finally {
      await lease.release();
    }
    return;
  }

  throw new Error('usage: reviewloop pr <status|resume|stop|push|trigger-review|bind-agent> [--loop <loopId>]');
}

async function main() {
  const legacyEnv = checkLegacyManagedEnv(process.env);
  applySettingsFile(process.env);
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'doctor': {
      const report = runDoctor({ legacyEnv });
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case 'status':
      await listSessions();
      break;
    case 'profile':
      await profile(rest);
      break;
    case 'inspect-spend':
      await inspectSpendCommand(rest);
      break;
    case 'acknowledge-spend':
      await acknowledgeSpend(rest);
      break;
    case 'reopen-gate':
      await reopenGate(rest);
      break;
    case 'override-budget':
      await overrideBudget(rest);
      break;
    case 'resume':
      await resume(rest);
      break;
    case 'pr':
      await handlePrCommand(rest);
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
      console.log('usage: reviewloop <doctor|status|profile|inspect-spend|resume|acknowledge-spend|reopen-gate|override-budget|install|uninstall>');
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
