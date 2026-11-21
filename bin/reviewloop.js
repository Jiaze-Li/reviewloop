#!/usr/bin/env node
// ReviewLoop human CLI.
//
//   reviewloop doctor       zero-token prerequisite + repo-invariant check
//   reviewloop status       list local ReviewLoop sessions and their state
//   reviewloop profile      read-only per-loop physical-call/token breakdown
//   reviewloop report       read-only HUMAN_REQUIRED report rebuilt from the durable loop state
//   reviewloop acknowledge-token-anomaly  human confirmation of a tripped Token Sentinel stop
//   reviewloop reopen-gate  human override: fresh convergence budget for a stuck gate
//   reviewloop restore-hold human action: re-append the hard stop on an ambiguous old record
//   reviewloop authorize-rereview  human action: release a hard stop for ONE exact submission
//   reviewloop extend-calls task-level: more Reviewer/Supervisor calls for ONE loop (audited)
//   reviewloop stop-loop    human end of a task: STOPPED, every record kept
//   reviewloop accept-design-exception  human-authorized Design exception after a review-TOOL stop (never a PASS)
//   reviewloop lock-status  read-only: who holds a loop's lock and what to do about it
//   reviewloop resume       print a prompt that lets a fresh Worker continue an unfinished loop
//   reviewloop install      install/refresh the global ReviewLoop policy + MCP
//   reviewloop uninstall    remove the global ReviewLoop integration
//   reviewloop cli          status | repair [--apply]: diagnose / re-point the global command link
//
// The agent-facing surface is the MCP server (reviewloop_begin /
// reviewloop_review) — not this CLI.

import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants, existsSync } from 'node:fs';
import { runDoctor, checkLegacyManagedEnv } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';
import { runCliCommand } from '../scripts/cliLink.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { acquireLoopFileLease, describeLoopLease } from '../src/reviewloop/loopLease.js';
import { leaseRefusalMessage } from '../src/reviewloop/leaseGuidance.js';
import { extendCalls, effectiveCallLimits } from '../src/reviewloop/callAllowance.js';
import { stopLoop } from '../src/reviewloop/loopStop.js';
import { grantDesignException, revokeDesignException } from '../src/reviewloop/designException.js';
import { readLoopWorkflow } from '../src/reviewloop/humanActionGuard.js';
import { acknowledgeUnresolvedSpend } from '../src/reviewloop/spendRecovery.js';
import { reopenExhaustedGate } from '../src/reviewloop/gateReopen.js';
import { restoreHold } from '../src/reviewloop/holdRestore.js';
import { authorizeRereview } from '../src/reviewloop/rereviewAuthorization.js';
import { overrideLoopBudget } from '../src/reviewloop/budgetOverride.js';
import { acknowledgeTokenAnomaly } from '../src/reviewloop/tokenAnomalyAck.js';
import { buildHumanRequiredReport } from '../src/reviewloop/humanRequiredReport.js';
import { buildTokenProfile, formatTokenProfile } from '../src/reviewloop/tokenProfile.js';
import { inspectSpend, formatSpendInspection } from '../src/reviewloop/spendInspect.js';
import { unfinishedLoopsFor, buildResumePrompt, isResumable, needsReopen } from '../src/reviewloop/resumeGuide.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';
import { isRetiredPrLoop } from '../src/reviewloop/objective.js';
import { readSpec, formatSpec, SpecError } from '../src/reviewloop/engineeringSpec.js';
import { applySettingsFile } from '../src/reviewloop/settingsFile.js';
import {
  checkFinalPrDiff,
  formatContractComments,
  recoverPrContract,
  runFinalPrGateReport,
  verifyDesignArchiveAndCleanupReady,
} from '../src/reviewloop/prContract.js';
import {
  analyzeComments, applyProgressBlock, formatDraft, formatReview, inspectTrace, renderProgressBlock, verifyArchiveWithTrace,
} from '../src/reviewloop/designTrace.js';

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
      console.log(`  ${loop.loopId}  ${loop.state}  round=${loop.round ?? 0}  reviewer=${loop.reviewerCalls ?? 0} supervisor=${loop.supervisorCalls ?? 0}${isRetiredPrLoop(loop) || state.prTask ? '  [RETIRED_PR]' : ''}`);
    } catch { /* skip */ }
  }
  if (!found) console.log('No ReviewLoop sessions found.');
}

// Take the loop lease for a human action, or explain exactly why not. Never
// deletes or overwrites a lock and never signals the holder (leaseGuidance.js).
async function takeLoopLease(loopId, action) {
  const lease = await acquireLoopFileLease({ runtimeRoot: REVIEWLOOP_RUNTIME_ROOT, loopId });
  if (lease.ok) return lease;
  let held = lease.heldBy;
  try {
    const seen = await describeLoopLease({ runtimeRoot: REVIEWLOOP_RUNTIME_ROOT, loopId });
    if (seen.status === 'HELD') held = seen;
  } catch { /* keep the raw holder record */ }
  throw new Error(leaseRefusalMessage({ action, loopId, held }));
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

  const lease = await takeLoopLease(loopId, 'acknowledge spend');
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

async function currentCallLimits(persistence, loopId) {
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status !== 'OK') return null; // the action itself reports unknown/unreadable
  return effectiveCallLimits({ workflow: read.workflow });
}

async function reopenGate(rest) {
  const loopId = flagValue(rest, '--loop');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason) throw new Error('usage: reviewloop reopen-gate --loop <loopId> --reason "<why this gate should get another attempt>" [--max-reviewer-calls <n>] [--max-supervisor-calls <n>]  (the call budget is required from the 4th reopen on)');
  const lease = await takeLoopLease(loopId, 'reopen the gate');
  try {
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
    const result = await reopenExhaustedGate({
      persistence, loopId, reason,
      allowance: { reviewerCalls: flagValue(rest, '--max-reviewer-calls'), supervisorCalls: flagValue(rest, '--max-supervisor-calls') },
      currentLimits: await currentCallLimits(persistence, loopId),
    });
    console.log('Gate reopened with a fresh convergence budget.');
    console.log(`  loop: ${result.loopId}  (human reopen ${result.reopens}, ${result.tier})`);
    console.log('  kept: objective, baseline, completed phases, model spend, call ceilings');
    for (const a of result.allowance ?? []) console.log(`  call ceiling enforced for this loop (${a.role}): ${a.previousCeiling} -> ${a.newCeiling} (used ${a.usedAtGrant}, this attempt may use ${a.granted})`);
    console.log('  note: task-wide Reviewer/Supervisor call ceilings still apply; if they are the limit, `reviewloop extend-calls` raises them for THIS loop only');
    console.log('Next: tell the Worker to fix the blocker and call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function authorizeRereviewCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const submission = flagValue(rest, '--submission');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !submission || !reason) throw new Error('usage: reviewloop authorize-rereview --loop <loopId> --submission <submissionDigest shown when the Worker was refused> --reason "<your decision / what was fixed>" [--max-reviewer-calls <n>] [--max-supervisor-calls <n>]  (the call budget is required from the 4th authorization on)');
  const lease = await takeLoopLease(loopId, 'authorize a re-review');
  try {
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
    const result = await authorizeRereview({
      persistence, loopId, submission, reason,
      allowance: { reviewerCalls: flagValue(rest, '--max-reviewer-calls'), supervisorCalls: flagValue(rest, '--max-supervisor-calls') },
      currentLimits: await currentCallLimits(persistence, loopId),
    });
    console.log('Re-review authorized for exactly one submission of this task.');
    console.log(`  loop: ${result.loopId}  (authorization ${result.grants}, ${result.tier})`);
    console.log('  not reset: history, budgets, fingerprints, spend ledger, call ceilings');
    console.log('Next: tell the Worker to call reviewloop_review again with the same loopId and the same content; different content needs a new authorization.');
  } finally {
    await lease.release();
  }
}

async function restoreHoldCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason) throw new Error('usage: reviewloop restore-hold --loop <loopId> --reason "<why the earlier stop should be restored>"');
  const lease = await takeLoopLease(loopId, 'restore the hard stop');
  try {
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
    const result = await restoreHold({ persistence, loopId, reason });
    console.log('Hard stop restored. The loop is HUMAN_REQUIRED again; no earlier record was changed.');
    console.log(`  loop: ${result.loopId}`);
    console.log('Next: the Worker still cannot re-review by itself; see `reviewloop report --loop <id>` for the human actions that apply.');
  } finally {
    await lease.release();
  }
}

async function report(rest) {
  const loopId = flagValue(rest, '--loop');
  if (!loopId) throw new Error('usage: reviewloop report --loop <loopId> [--json]');
  const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
  const read = await readLoopWorkflow(persistence, loopId);
  if (read.status === 'MISSING') throw new Error(`unknown loopId ${loopId}: no task with that id was found`);
  if (read.status === 'UNREADABLE') {
    // Not a crash: the standard report, with the steps that keep the evidence.
    const unreadable = buildHumanRequiredReport({
      loopId, loop: null, workflow: null,
      result: {
        stateUnreadable: {
          errorClass: read.errorClass, errorMessage: read.errorMessage, dir: persistence.workflowDir(loopId),
        },
      },
    });
    console.log(rest.includes('--json') ? JSON.stringify(unreadable, null, 2) : unreadable.reportText);
    return;
  }
  const { workflow, loop } = read;
  if (loop.state !== 'HUMAN_REQUIRED') {
    throw new Error(`loop is ${loop.state}; a HUMAN_REQUIRED report only exists for a loop waiting for a human`);
  }
  const built = buildHumanRequiredReport({ loopId, loop, workflow });
  console.log(rest.includes('--json') ? JSON.stringify(built, null, 2) : built.reportText);
}

async function acknowledgeAnomaly(rest) {
  const loopId = flagValue(rest, '--loop');
  const latchAt = flagValue(rest, '--latch');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !latchAt || !reason) {
    throw new Error('usage: reviewloop acknowledge-token-anomaly --loop <loopId> --latch <latch timestamp shown in the report> --reason "<why continuing is safe>" [--max-reviewer-calls <n>] [--max-supervisor-calls <n>]  (the call budget is required from the 4th acknowledgement on)');
  }
  const lease = await takeLoopLease(loopId, 'acknowledge the token anomaly');
  try {
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);
    const result = await acknowledgeTokenAnomaly({
      persistence, loopId, latchAt, reason,
      allowance: { reviewerCalls: flagValue(rest, '--max-reviewer-calls'), supervisorCalls: flagValue(rest, '--max-supervisor-calls') },
      currentLimits: await currentCallLimits(persistence, loopId),
    });
    console.log('Token Sentinel stop acknowledged by a human.');
    console.log(`  loop: ${result.loopId}  (acknowledgement ${result.acknowledgements}, ${result.tier})`);
    for (const a of result.allowance ?? []) console.log(`  call ceiling enforced for this loop (${a.role}): ${a.previousCeiling} -> ${a.newCeiling} (used ${a.usedAtGrant}, this attempt may use ${a.granted})`);
    console.log(`  event: ${result.trigger ?? '?'} latched at ${result.latchAt}; ${result.acknowledgedRecords} existing spend record(s) will not re-latch`);
    console.log('  kept: spend ledger, anomaly record, objective, baseline, phases, evidence, other safety stops');
    console.log('  note: a NEW over-threshold call latches again; budgets, call ceilings and the independent Reviewer still apply');
    console.log('  note: identical evidence is never re-sent (no-new-information rule); the Worker must change the code/evidence materially before the next review');
    console.log('Next: tell the Worker to fix what the report pointed at, then call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function extendCallsCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const reviewerCalls = flagValue(rest, '--reviewer-calls');
  const supervisorCalls = flagValue(rest, '--supervisor-calls');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason || (!reviewerCalls && !supervisorCalls)) {
    throw new Error('usage: reviewloop extend-calls --loop <loopId> --reviewer-calls <n> [--supervisor-calls <n>] --reason "<why this loop needs more calls>"');
  }
  const lease = await takeLoopLease(loopId, 'extend the call allowance');
  try {
    const result = await extendCalls({
      persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT), loopId, reviewerCalls, supervisorCalls, reason,
    });
    console.log('Call allowance extended for this loop only.');
    console.log(`  loop: ${result.loopId}  (state stays ${result.loopState})`);
    for (const g of result.granted) console.log(`  ${g.role} calls: ceiling ${g.previousCeiling} -> ${g.newCeiling} (used ${g.usedAtGrant}, granted ${g.granted} more)`);
    console.log('  kept: global settings and every other loop are untouched; budgets, the Token Sentinel and the independent Reviewer still apply');
    console.log('Next: tell the Worker to call reviewloop_review again with the same loopId.');
  } finally {
    await lease.release();
  }
}

async function stopLoopCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason) throw new Error('usage: reviewloop stop-loop --loop <loopId> --reason "<why this task is being ended>"');
  const lease = await takeLoopLease(loopId, 'stop the loop');
  try {
    const result = await stopLoop({ persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT), loopId, reason });
    if (result.alreadyStopped) {
      console.log(`Loop ${result.loopId} was already stopped${result.stoppedAt ? ` (at ${result.stoppedAt})` : ''}; nothing was changed.`);
    } else {
      console.log('Task ended by a human (STOPPED).');
      console.log(`  loop: ${result.loopId}  (was ${result.priorState}, round ${result.round})`);
      console.log('  kept: every spend record, the Token Sentinel record and confirmations, evidence, contract, baseline and the full history');
      console.log('  note: this is not a pass; no further model call is made for this loop, and it cannot be resumed');
      console.log('Next: continuing the same work needs a new, explicit instruction to start a new task.');
    }
  } finally {
    await lease.release();
  }
}

// Human-authorized Design exception (never a Design PASS). CLI-only, lease-guarded.
async function designExceptionCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  const reason = flagValue(rest, '--reason');
  if (rest.includes('--revoke')) {
    if (!loopId || !reason) throw new Error('usage: reviewloop accept-design-exception --revoke --loop <loopId> --reason "<why the exception is withdrawn>"');
    const lease = await takeLoopLease(loopId, 'revoke the Design exception');
    try {
      const res = await revokeDesignException({ persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT), loopId, reason });
      console.log('Human Design exception revoked.');
      console.log(`  loop: ${res.loopId}  exception: ${res.revoked}  (kept in history)`);
      console.log('  note: the original Design review state was never changed and still is not a PASS');
    } finally {
      await lease.release();
    }
    return;
  }
  const usage = 'usage: reviewloop accept-design-exception --loop <loopId> --repo <owner/name> --pr <num> --task-id <id> --design-version <ver> --design-sha <sha256> --review-report <report.json> --reason "<why an alternative independent review is accepted>" [--accept-risk "<unverified risk you accept>"] [--archive-out <file>]';
  const reportPath = flagValue(rest, '--review-report');
  const repo = flagValue(rest, '--repo');
  const prNumber = flagValue(rest, '--pr');
  const taskId = flagValue(rest, '--task-id');
  const designVersion = flagValue(rest, '--design-version');
  const designSha256 = flagValue(rest, '--design-sha');
  if (!loopId || !reason || !reportPath || !repo || !prNumber || !taskId || !designVersion || !designSha256) throw new Error(usage);
  const reportText = await readFile(reportPath, 'utf8');
  const archiveOut = flagValue(rest, '--archive-out');
  // Preflight BEFORE anything is recorded: an archive path that cannot be
  // written must refuse the command, not lose the archive text afterwards.
  if (archiveOut) await assertWritableTarget(archiveOut);
  const lease = await takeLoopLease(loopId, 'grant a Design exception');
  let res;
  try {
    res = await grantDesignException({
      persistence: new Persistence(REVIEWLOOP_RUNTIME_ROOT), loopId, repo, prNumber, taskId, designVersion, designSha256,
      reportText, reason, acceptRisk: flagValue(rest, '--accept-risk'),
    });
  } finally {
    await lease.release();
  }
  const a = res.active;
  // The decision is already recorded; from here on nothing may be lost.
  let archiveWritten = false;
  let archiveError = null;
  if (archiveOut) {
    try {
      await writeFile(archiveOut, `${res.archiveText}\n`, 'utf8');
      archiveWritten = true;
    } catch (err) {
      archiveError = err?.message ?? String(err);
    }
  }
  console.log('Human-authorized Design exception recorded (NOT a ReviewLoop Design PASS).');
  console.log(`  loop: ${a.loopId}  (stays ${a.loopAnchor.state}, round ${a.loopAnchor.round}; review state, spend and safety records unchanged)`);
  console.log(`  exception: ${a.id}  design ${a.designSha256.slice(0, 12)}…  for ${a.repo}#${a.prNumber} ${a.taskId} ${a.designVersion}`);
  if (res.superseded) console.log(`  replaced earlier exception ${res.superseded} (kept in history)`);
  if (a.acceptedRisk) console.log(`  unverified risk accepted by you: ${a.acceptedRisk}`);
  console.log(`  allows only: ${a.allows.join(', ')}; never: ${a.forbids.join(', ')}`);
  console.log(`  archive record sha256: ${a.archiveSha256}`);
  console.log('Next (Worker):');
  console.log(`  1. archive the record: reviewloop contract format --task-id ${a.taskId} --type exception --version ${a.designVersion} --file ${archiveOut ?? '<archive file>'} ; post it and add it to the PR contract index`);
  console.log(`  2. archive the design with: reviewloop contract format ... --type design --exception (never the PASS trailer)`);
  console.log(`  3. reviewloop contract verify-archive --repo ${a.repo} --pr ${a.prNumber} --task-id ${a.taskId} --loop ${a.loopId}`);
  if (!archiveWritten) {
    console.log('--- archive record (save it to a file to archive) ---');
    console.log(res.archiveText);
  }
  if (archiveError) {
    console.error(`Warning: the exception IS recorded, but writing the archive file ${archiveOut} failed (${archiveError}); the full archive record is printed above — save it and archive it from there.`);
    process.exitCode = 1;
  }
}

// Refuse early when the archive output path cannot be written: its directory
// must exist and be writable, and an existing path must be a writable file.
async function assertWritableTarget(file) {
  try {
    const st = await stat(file).catch((err) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (st) {
      if (!st.isFile()) throw new Error('it exists and is not a regular file');
      await access(file, fsConstants.W_OK);
    } else {
      await access(path.dirname(path.resolve(file)), fsConstants.W_OK);
    }
  } catch (err) {
    throw new Error(`--archive-out ${file} cannot be written (${err?.message ?? err}); nothing was recorded`);
  }
}

async function lockStatusCommand(rest) {
  const loopId = flagValue(rest, '--loop');
  if (!loopId) throw new Error('usage: reviewloop lock-status --loop <loopId>');
  const seen = await describeLoopLease({ runtimeRoot: REVIEWLOOP_RUNTIME_ROOT, loopId });
  if (seen.status === 'FREE') { console.log(`No lock is held for ${loopId}.`); return; }
  if (seen.status === 'MALFORMED') { console.log(`The lock file for ${loopId} is unreadable as JSON; the next command reclaims it by itself.`); return; }
  if (seen.status === 'UNREADABLE') { console.log(`The lock file for ${loopId} cannot be read (${seen.error}); nothing can be proven about its owner.`); return; }
  if (seen.status === 'RECLAIMABLE') {
    console.log(`The lock for ${loopId} belongs to a process that is gone (pid ${seen.pid} on ${seen.host}); the next command reclaims it by itself.`);
    return;
  }
  console.log(leaseRefusalMessage({ action: 'run a recovery command', loopId, held: seen }));
}

async function overrideBudget(rest) {
  const loopId = flagValue(rest, '--loop');
  const maxUsage = flagValue(rest, '--max-usage');
  const maxCost = flagValue(rest, '--max-cost');
  const reason = flagValue(rest, '--reason');
  if (!loopId || !reason || (!maxUsage && !maxCost)) {
    throw new Error('usage: reviewloop override-budget --loop <loopId> --reason "<explanation>" [--max-usage <tokens>] [--max-cost <usd>]');
  }
  const lease = await takeLoopLease(loopId, 'override the budget');
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
  if (isRetiredPrLoop(loop)) {
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

function flagValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1));
    else if (args[i] === name && i + 1 < args.length) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

// `trace prepare` formats comment bodies (never posts); `trace inspect` reads the
// PR, verifies every trace record and can emit the updated PR description. The
// Worker posts / edits with `gh`; this command never writes to GitHub.
async function handleTraceCommand(rest) {
  const [sub, ...args] = rest;
  const asJson = args.includes('--json');
  const need = (name) => {
    const v = flagValue(args, name);
    if (!v) throw new Error(`missing ${name}`);
    return v;
  };
  if (sub === 'prepare') {
    const kind = need('--kind');
    const taskId = need('--task-id');
    let formatted;
    if (kind === 'draft') {
      const parts = flagValue(args, '--parts');
      formatted = formatDraft({
        taskId,
        version: need('--version'),
        content: await readFile(need('--file'), 'utf8'),
        policySha: need('--policy-sha'),
        planVersion: need('--plan-version'),
        planSha256: need('--plan-sha'),
        baseline: flagValue(args, '--baseline'),
        changeNote: flagValue(args, '--note'),
        findingResponses: flagValues(args, '--finding-response'),
        onlyParts: parts ? parts.split(',').map(Number) : null,
      });
    } else if (kind === 'review') {
      const designVersion = need('--design-version');
      if (args.includes('--external')) {
        formatted = formatReview({
          taskId, designVersion, version: flagValue(args, '--version'),
          external: {
            reviewer: need('--reviewer'), independence: need('--independence'), conclusion: need('--conclusion'),
            relayedBy: need('--relayed-by'), seq: flagValue(args, '--seq') ?? '1',
            reviewedDesignSha256: need('--reviewed-sha'),
            report: await readFile(need('--report-file'), 'utf8'),
          },
        });
      } else {
        const resultFile = flagValue(args, '--result');
        const result = resultFile ? JSON.parse(await readFile(resultFile, 'utf8')) : null;
        formatted = formatReview({
          taskId, designVersion, result, round: Number(flagValue(args, '--round')) || null,
          errorNote: flagValue(args, '--error-note'),
        });
      }
    } else {
      throw new Error('--kind must be draft or review');
    }
    const outDir = flagValue(args, '--out-dir');
    const files = [];
    if (outDir) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      for (const c of formatted.comments) {
        const f = path.join(outDir, `${formatted.kind}-${formatted.version}-part${c.part}of${c.total}.md`);
        await writeFile(f, c.body, 'utf8');
        files.push(f);
      }
    }
    const out = { kind: formatted.kind, version: formatted.version, sha256: formatted.sha256, totalParts: formatted.totalParts, files };
    if (asJson) console.log(JSON.stringify(outDir ? out : { ...out, comments: formatted.comments }, null, 2));
    else {
      console.log(`${out.kind} ${out.version} sha256=${out.sha256} parts=${out.totalParts}`);
      if (outDir) files.forEach((f) => console.log(`wrote ${f}`));
      else formatted.comments.forEach((c) => console.log(`--- part ${c.part}/${c.total} ---\n${c.body}`));
    }
    return;
  }
  if (sub === 'inspect') {
    const repo = need('--repo');
    const pr = need('--pr');
    const taskId = need('--task-id');
    const file = flagValue(args, '--file');
    const localDraft = file ? await readFile(file, 'utf8') : null;
    const res = await inspectTrace({ repo, prNumber: pr, taskId, localDraft });
    const block = renderProgressBlock(res, { repo, prNumber: pr, taskId });
    const bodyOut = flagValue(args, '--body-out');
    if (bodyOut) await writeFile(bodyOut, applyProgressBlock(res.prBody, block), 'utf8');
    const summary = {
      ok: res.ok,
      localState: res.localState,
      latestDraft: res.latestDraft ? { version: res.latestDraft.version, sha256: res.latestDraft.sha256, commentIds: res.latestDraft.commentIds } : null,
      records: res.records.map((r) => ({ kind: r.kind, version: r.version, valid: r.valid, sha256: r.sha256 ?? null, commentIds: r.commentIds ?? [], reason: r.reason ?? null, missingParts: r.missingParts ?? [] })),
      problems: res.problems,
      bodyOut: bodyOut ?? null,
    };
    if (asJson) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`trace: ${res.ok ? 'OK' : 'PROBLEMS'} · local draft: ${res.localState}`);
      res.records.forEach((r) => console.log(`  ${r.kind} ${r.version} ${r.valid ? `valid ${r.sha256.slice(0, 12)}` : `INVALID (${r.reason})`}`));
      res.problems.forEach((p) => console.log(`  ! ${p.code}: ${p.message}`));
      if (bodyOut) console.log(`wrote updated PR description to ${bodyOut}`);
    }
    if (!res.ok) process.exitCode = 1;
    return;
  }
  throw new Error('usage: reviewloop trace <prepare|inspect> ...  (prepare --kind draft|review --task-id <id> ...; inspect --repo <o/n> --pr <n> --task-id <id> [--file <design>] [--body-out <file>])');
}

async function handleContractCommand(rest) {
  const [sub, ...args] = rest;
  const asJson = args.includes('--json');
  const print = (obj, textLines) => {
    if (asJson) console.log(JSON.stringify(obj, null, 2));
    else for (const line of textLines) console.log(line);
  };

  if (sub === 'format') {
    const taskId = flagValue(args, '--task-id');
    const type = flagValue(args, '--type');
    const version = flagValue(args, '--version');
    const file = flagValue(args, '--file');
    const designSha256 = flagValue(args, '--design-sha');
    const humanException = args.includes('--exception');
    if (!taskId || !type || !version || !file) {
      throw new Error('usage: reviewloop contract format --task-id <id> --type <plan|design|exception> --version <ver> --file <path> [--design-sha <sha>] [--exception] [--json]');
    }
    const content = await readFile(file, 'utf8');
    const formatted = formatContractComments({ taskId, type, version, content, designSha256, humanException });
    print(formatted, [
      `taskId: ${formatted.taskId}  type: ${formatted.type}  version: ${formatted.version}`,
      `sha256: ${formatted.sha256}  parts: ${formatted.totalParts}`,
      ...formatted.comments.flatMap((c) => [`--- part ${c.part}/${c.total} ---`, c.body]),
    ]);
    return;
  }

  if (sub === 'recover') {
    const repo = flagValue(args, '--repo');
    const prNumber = flagValue(args, '--pr');
    const taskId = flagValue(args, '--task-id');
    const type = flagValue(args, '--type');
    const version = flagValue(args, '--version');
    const expectedDesignSha256 = flagValue(args, '--design-sha');
    const authors = flagValues(args, '--author');
    const requireMcpLimit = args.includes('--mcp-limit');
    if (!repo || !prNumber || !taskId || !type) {
      throw new Error('usage: reviewloop contract recover --repo <owner/name> --pr <num> --task-id <id> --type <plan|design|exception> [--version <ver>] [--design-sha <sha>] [--author <login>] [--mcp-limit] [--json]');
    }
    const res = await recoverPrContract({
      repo,
      prNumber: Number(prNumber),
      taskId,
      type,
      version,
      allowedAuthors: authors.length ? authors : null,
      expectedDesignSha256,
      requireMcpLimit,
    });
    print(res, [
      `Recovered ${res.type} ${res.version} for ${res.taskId} (sha256=${res.sha256}, parts=${res.totalParts}, comments=${res.commentIds.join(',')})`,
      `Trust: ${res.trustNote}`,
      ...res.warnings.map((w) => `Warning: ${w}`),
      '---',
      res.content,
    ]);
    return;
  }

  if (sub === 'verify-archive') {
    const repo = flagValue(args, '--repo');
    const prNumber = flagValue(args, '--pr');
    const taskId = flagValue(args, '--task-id');
    const version = flagValue(args, '--version');
    const loopId = flagValue(args, '--loop');
    const reviewTarget = flagValue(args, '--target');
    const cwd = flagValue(args, '--cwd') || process.cwd();
    const clean = args.includes('--clean');
    const authors = flagValues(args, '--author');
    if (!repo || !prNumber || !taskId) {
      throw new Error('usage: reviewloop contract verify-archive --repo <owner/name> --pr <num> --task-id <id> [--version <ver>] [--loop <loopId>] [--target <path>] [--cwd <dir>] [--clean] [--require-trace] [--json]');
    }
    const res = await verifyArchiveWithTrace({
      cwd,
      repo,
      prNumber: Number(prNumber),
      taskId,
      version,
      loopId,
      reviewTarget,
      allowedAuthors: authors.length ? authors : null,
      clean,
      requireTrace: args.includes('--require-trace'),
    });
    const source = res.authority === 'HUMAN_EXCEPTION'
      ? `Design source: HUMAN-AUTHORIZED EXCEPTION ${res.exceptionId} — NOT a ReviewLoop Design PASS (original review loop ${res.loopId} is unchanged).`
      : `Design source: ReviewLoop Design PASS (loop ${res.loopId}).`;
    print(res, [
      source,
      res.cleaned
        ? `Cleaned untracked design file ${res.reviewTarget} (designSha256=${res.designSha256}, loop=${res.loopId}).`
        : `Ready to clean ${res.reviewTarget} (designSha256=${res.designSha256}, loop=${res.loopId}); pass --clean to unlink.`,
      ...res.warnings.map((w) => `Warning: ${w}`),
    ]);
    return;
  }

  if (sub === 'diff-check') {
    const cwd = flagValue(args, '--cwd') || process.cwd();
    const baseRef = flagValue(args, '--base') || 'main';
    const approvedAssets = flagValues(args, '--approved-asset');
    const archivedContractHashes = flagValues(args, '--archived-hash');
    const res = await checkFinalPrDiff({ cwd, baseRef, approvedAssets, archivedContractHashes });
    print(res, [
      `localDiffCheck: ${res.ok ? 'PASS' : 'FAIL'} (base=${res.baseRef}, checked=${res.checkedFiles.length})`,
      ...res.violations.map((v) => `  - [${v.reason}] ${v.path}: ${v.message}`),
    ]);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'gate-report') {
    const repo = flagValue(args, '--repo');
    const prNumber = flagValue(args, '--pr');
    const cwd = flagValue(args, '--cwd') || process.cwd();
    const baseRef = flagValue(args, '--base');
    const approvedAssets = flagValues(args, '--approved-asset');
    if (!repo || !prNumber) {
      throw new Error('usage: reviewloop contract gate-report --repo <owner/name> --pr <num> [--cwd <dir>] [--base <ref>] [--approved-asset <path>] [--json]');
    }
    const report = await runFinalPrGateReport({
      cwd,
      repo,
      prNumber: Number(prNumber),
      baseRef,
      approvedAssets,
    });
    print(report, [
      `localCheck: ${report.localCheck.status}${report.localCheck.errors.length ? ` (${report.localCheck.errors.join('; ')})` : ''}`,
      `remoteProtection: ${report.remoteProtection.status} (${report.remoteProtection.detail})`,
      `prBotStatus: ${report.prBotStatus.status} (${report.prBotStatus.detail})`,
    ]);
    if (report.localCheck.status !== 'PASS') process.exitCode = 1;
    return;
  }

  throw new Error('usage: reviewloop contract <format|recover|verify-archive|diff-check|gate-report> ...');
}

function handleSpecCommand(args) {
  const stage = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--at');
  const atIdx = args.indexOf('--at');
  const at = atIdx >= 0 ? args[atIdx + 1] : null;
  if (!stage || (atIdx >= 0 && !at)) {
    console.error('usage: reviewloop spec <plan|design|code|review|pr> [--at <40-char sha>] [--allow-dirty]');
    process.exit(2);
  }
  try {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    console.log(formatSpec(readSpec({ repoRoot, stage, at, allowDirty: args.includes('--allow-dirty') })));
  } catch (err) {
    if (!(err instanceof SpecError)) throw err;
    console.error(`reviewloop spec: ${err.message}`);
    process.exit(1);
  }
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
    case 'restore-hold':
      await restoreHoldCommand(rest);
      break;
    case 'authorize-rereview':
      await authorizeRereviewCommand(rest);
      break;
    case 'report':
      await report(rest);
      break;
    case 'acknowledge-token-anomaly':
      await acknowledgeAnomaly(rest);
      break;
    case 'override-budget':
      await overrideBudget(rest);
      break;
    case 'extend-calls':
      await extendCallsCommand(rest);
      break;
    case 'stop-loop':
      await stopLoopCommand(rest);
      break;
    case 'accept-design-exception':
      await designExceptionCommand(rest);
      break;
    case 'lock-status':
      await lockStatusCommand(rest);
      break;
    case 'resume':
      await resume(rest);
      break;
    case 'contract':
      await handleContractCommand(rest);
      break;
    case 'trace':
      await handleTraceCommand(rest);
      break;
    case 'spec':
      handleSpecCommand(rest);
      break;
    case 'install': {
      const res = await installGlobal();
      console.log('ReviewLoop installed globally.');
      console.log(`  MCP server: ${res.mcpBin}`);
      break;
    }
    case 'cli':
      process.exit(runCliCommand(rest));
      break;
    case 'uninstall':
      await uninstallGlobal();
      console.log('ReviewLoop global integration removed.');
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log('usage: reviewloop <doctor|status|profile|report|inspect-spend|resume|acknowledge-spend|acknowledge-token-anomaly|reopen-gate|restore-hold|authorize-rereview|override-budget|extend-calls|stop-loop|accept-design-exception|lock-status|contract|trace|spec|install|uninstall|cli>');
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
