#!/usr/bin/env node
// Final ReviewLoop LIVE certification harness.
//
// This is the ONLY script in the repo that is designed to make real provider
// model calls. It is never run by `npm test`, `npm run doctor`, or any
// benchmark. It requires a hard opt-in and, even then, drives exactly ONE
// physical model call per run behind single-call ceilings.
//
//   node scripts/live-reviewloop-certify.mjs --mode reviewer
//   node scripts/live-reviewloop-certify.mjs --mode supervisor
//
// Without REVIEWLOOP_LIVE_CERTIFY=1 the script performs ZERO provider/model
// calls, prints an opt-in-required notice, and exits non-zero.
//
// Mode A (reviewer): certifies the normal production main path end to end —
//   real temp git repo -> reviewloop_begin -> Worker delta -> deterministic
//   Gate PASS -> production RoleRouter -> agy:opus (the Reviewer head — AGY
//   Claude Opus, resolved dynamically from the AGY runtime catalog, AGY
//   "Claude & GPT" quota pool) -> real isolated reviewloop-minimal AGY
//   transport -> ModelSpendAuthority -> reservation -> provider-aware usage
//   accounting -> ReviewPolicy -> terminal PASS. ANY failover to a second
//   Reviewer family is a certification FAILURE (failover already has
//   deterministic fake coverage; this run must not burn a second provider).
//   resolvedModel MUST be a `claude-opus-*` id (or null = provider default).
//
// Mode B (supervisor): certifies the Gemini Medium Supervisor's controller
//   integration with the least possible token spend. The Reviewer is a
//   SYNTHETIC deterministic precondition (injected) that constructs a
//   persistent-blocker state; the Supervisor itself goes through real
//   production routing + real AGY transport (agy:gemini-supervisor -> runtime catalog ->
//   reviewloop-minimal agent -> real physical call -> usage accounting ->
//   controller transition). It is NOT a full controller E2E. If the first
//   real Gemini call fails, the script FAILS rather than trying Codex.
//
// Output: one compact JSON object. Never prints prompts, diffs, credentials,
// HOME config, or raw provider responses.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  createProductionReviewLoopProviders,
  detectAgyCustomAgentSupport,
  narrowAgyGeminiDir,
} from '../src/reviewloop/providerWiring.js';
import { probeAgyModelCatalog } from '../src/agy/agyModelCatalog.js';
import { probeReviewTransportRuntime } from '../src/reviewloop/adapters/cliReviewTransports.js';

export const OPT_IN_ENV = 'REVIEWLOOP_LIVE_CERTIFY';
export const VALID_MODES = Object.freeze(['reviewer', 'supervisor']);

// Single-call ceilings — one physical certification call, never a failover chain.
export const MODE_CEILINGS = Object.freeze({
  reviewer: Object.freeze({
    REVIEWLOOP_MAX_REVIEWER_CALLS: '1',
    REVIEWLOOP_MAX_USAGE_VOLUME: '30000',
    REVIEWLOOP_MAX_REVIEW_ROUNDS: '1',
  }),
  supervisor: Object.freeze({
    REVIEWLOOP_MAX_SUPERVISOR_CALLS: '1',
    REVIEWLOOP_MAX_USAGE_VOLUME: '20000',
    REVIEWLOOP_MAX_REVIEWER_CALLS: '4',
  }),
});

const CERT_FILE = 'result.txt';
const CERT_TARGET = 'reviewloop-live-cert-ok';

export function parseArgs(argv = []) {
  let mode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') { mode = argv[i + 1] ?? null; i += 1; continue; }
    if (a.startsWith('--mode=')) { mode = a.slice('--mode='.length); continue; }
  }
  if (!mode || !VALID_MODES.includes(mode)) {
    const err = new Error(
      `--mode must be one of: ${VALID_MODES.join(', ')}${mode ? ` (got ${JSON.stringify(mode)})` : ' (missing)'}`,
    );
    err.code = 'BAD_MODE';
    throw err;
  }
  return { mode };
}

export function optInSatisfied(env = process.env) {
  return env?.[OPT_IN_ENV] === '1';
}

function makeTempGitRepo(baselineFiles) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-live-cert-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'live-cert@reviewloop.local');
  git('config', 'user.name', 'reviewloop-live-cert');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(baselineFiles)) {
    writeFileSync(path.join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  return {
    dir,
    write: (name, content) => writeFileSync(path.join(dir, name), content),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

function makeTempRuntimeRoot() {
  // The real ReviewLoop runtime lives outside the reviewed worktree
  // (~/.reviewloop). Keep certification state outside the temp git repo too;
  // otherwise ReviewLoop correctly sees its own workflow/lock files as
  // untracked Worker output on platforms where whole-path anti-symlink reads
  // fail closed.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-live-runtime-'));
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

async function readSpendRecords(ctl, loopId) {
  try {
    const wf = await ctl._persistence.readWorkflowState(loopId);
    const raw = wf?.reviewLoopSpend?.records;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

const defaultDeps = Object.freeze({
  createProviders: (opts) => createProductionReviewLoopProviders(opts),
  probeAgyModelCatalog: () => probeAgyModelCatalog({ geminiDir: narrowAgyGeminiDir() }),
  probeReviewTransportRuntime: (o) => probeReviewTransportRuntime(o),
  detectAgyCustomAgentSupport: () => detectAgyCustomAgentSupport({ geminiDir: narrowAgyGeminiDir() }),
});

// ---- Mode A: reviewer -------------------------------------------------------

export async function runReviewerCertification({ env = process.env, deps = {} } = {}) {
  const d = { ...defaultDeps, ...deps };
  const repo = makeTempGitRepo({ [CERT_FILE]: 'before\n' });
  const runtime = makeTempRuntimeRoot();
  const runtimeRoot = runtime.dir;
  const failures = [];

  try {
    const baseEnv = { ...env, ...MODE_CEILINGS.reviewer };
    const agyCatalog = d.probeAgyModelCatalog();
    const transportRuntime = await d.probeReviewTransportRuntime();
    const customAgentSupport = await d.detectAgyCustomAgentSupport();
    const providers = d.createProviders({ env: baseEnv, agyCatalog, transportRuntime, customAgentSupport });

    const reviewerSelections = [];
    const suppressedFallbackFamilies = [];
    const providerFailures = [];
    // Certification target isolation. Production RoleRouter still picks the
    // candidate (health / quota-cooldown aware), but this harness refuses to
    // physically dispatch anything outside the Reviewer certification scope
    // (agy:opus — the production Reviewer head, AGY Claude Opus reached through
    // the isolated reviewloop-minimal AGY transport). If the router would
    // advance to a fallback family — because the Opus head was skipped before
    // dispatch, or because a first real call failed safely and failover
    // re-routed — we record the family name only and hand the controller a null
    // selection, which stops the failover loop with ZERO fallback-provider
    // physical calls. Certification then FAILs on the missing terminal PASS /
    // missing agy:opus selection.
    const routeReviewerFn = (signals) => {
      const sel = providers.routeReviewerFn(signals);
      if (!sel?.family) return sel;
      if (sel.family !== 'agy:opus') {
        suppressedFallbackFamilies.push(sel.family);
        return null;
      }
      reviewerSelections.push(sel.family);
      return sel;
    };
    const recordProviderFailure = (selection, failure) => {
      providerFailures.push({ role: selection?.role ?? null, family: selection?.family ?? null, code: failure?.code ?? null });
      return providers.recordProviderFailure?.(selection, failure);
    };

    const ctl = createReviewLoopController({
      ...providers, env: baseEnv, runtimeRoot, routeReviewerFn, recordProviderFailure,
    });

    const begin = await ctl.begin({
      goal: `The file ${CERT_FILE} must contain exactly "${CERT_TARGET}" (a single trailing newline is allowed).`,
      cwd: repo.dir,
    });
    // Worker delta.
    repo.write(CERT_FILE, `${CERT_TARGET}\n`);
    const res = await ctl.review({ loopId: begin.loopId });

    const records = await readSpendRecords(ctl, begin.loopId);
    const reviewerRecord = records.find((r) => r.role === 'reviewer') ?? null;
    const tel = res.telemetry ?? {};

    const selectedReviewerFamily = reviewerSelections[0] ?? null;
    const usageResolved = Boolean(
      reviewerRecord?.usageKnown && reviewerRecord?.usageAccounting?.volumeResolved !== false,
    );

    if (res.status !== 'PASS') failures.push(`terminal is ${res.status}, expected PASS (${res.reason ?? ''})`);
    if (selectedReviewerFamily !== 'agy:opus') {
      failures.push(`selected Reviewer family is ${selectedReviewerFamily ?? 'none'}, expected agy:opus`);
    }
    if (reviewerSelections.length !== 1) failures.push(`Reviewer routed ${reviewerSelections.length} times (${reviewerSelections.join(' -> ')}); a single certification call must not failover`);
    if (suppressedFallbackFamilies.length) failures.push(`production routing would have dispatched an out-of-scope fallback Reviewer family: ${suppressedFallbackFamilies.join(', ')}`);
    if (providerFailures.length) failures.push(`provider failover/failure recorded: ${JSON.stringify(providerFailures)}`);
    if ((tel.reviewerCalls ?? 0) !== 1) failures.push(`reviewerCalls=${tel.reviewerCalls}, expected 1`);
    if ((tel.supervisorCalls ?? 0) !== 0) failures.push(`supervisorCalls=${tel.supervisorCalls}, expected 0`);
    if (!usageResolved) failures.push('Reviewer usage was not resolved by provider-aware accounting');
    if (customAgentSupport?.supported !== true) failures.push(`agy custom-agent capability probe did not confirm isolated-agent loading: ${customAgentSupport?.reason ?? 'unknown'}`);
    if (providers.runtimeStatus?.['agy:opus']?.effectiveLoadingVerified !== true) failures.push('agy:opus effective-loading verification is not active');
    const reviewerResolvedModel = reviewerRecord?.model
      ?? providers.pool?.resolution?.['agy:opus']?.resolvedModel ?? null;
    if (reviewerResolvedModel && !/^claude-opus-/.test(reviewerResolvedModel)) {
      failures.push(`Reviewer resolvedModel ${reviewerResolvedModel} is not a claude-opus-* id (telemetry must record the concrete Opus actually called)`);
    }

    const status = failures.length ? 'FAIL' : 'PASS';
    return {
      exitCode: status === 'PASS' ? 0 : 1,
      output: {
        certification: 'reviewloop-live/reviewer-v1',
        status,
        terminal: res.status,
        selectedReviewerFamily,
        resolvedModel: reviewerRecord?.model
          ?? providers.pool?.resolution?.['agy:opus']?.resolvedModel ?? null,
        effectiveLoadingVerified: providers.runtimeStatus?.['agy:opus']?.effectiveLoadingVerified === true,
        customAgentSupport: { supported: customAgentSupport?.supported === true, reason: customAgentSupport?.reason ?? null },
        reviewerCalls: tel.reviewerCalls ?? 0,
        supervisorCalls: tel.supervisorCalls ?? 0,
        usageVolume: tel.usageVolume ?? 0,
        usageAccounting: reviewerRecord?.usageAccounting ?? {},
        usageBreakdown: tel.usageBreakdown ?? {},
        gatePass: (tel.reviewerCalls ?? 0) >= 1 || res.status === 'PASS',
        tempRepo: true,
        ...(suppressedFallbackFamilies.length ? { suppressedFallbackFamilies } : {}),
        ...(failures.length ? { failures } : {}),
      },
    };
  } finally {
    runtime.cleanup();
    repo.cleanup();
  }
}

// ---- Mode B: supervisor ----------------------------------------------------

const SYNTHETIC_BLOCKER = Object.freeze({
  severity: 'P1',
  file: CERT_FILE,
  line: 1,
  title: 'synthetic deterministic precondition — forces the Supervisor convergence path',
});

export async function runSupervisorCertification({ env = process.env, deps = {} } = {}) {
  const d = { ...defaultDeps, ...deps };
  const repo = makeTempGitRepo({ [CERT_FILE]: 'before\n' });
  const runtime = makeTempRuntimeRoot();
  const runtimeRoot = runtime.dir;
  const failures = [];

  try {
    const baseEnv = { ...env, ...MODE_CEILINGS.supervisor };
    const agyCatalog = d.probeAgyModelCatalog();
    const transportRuntime = await d.probeReviewTransportRuntime();
    const customAgentSupport = await d.detectAgyCustomAgentSupport();
    const providers = d.createProviders({ env: baseEnv, agyCatalog, transportRuntime, customAgentSupport });

    const supervisorSelections = [];
    const suppressedFallbackFamilies = [];
    const providerFailures = [];

    // Reviewer: SYNTHETIC deterministic precondition. No real transport is
    // consulted for the Reviewer; it only establishes the persistent-blocker
    // state the Supervisor trigger requires.
    const routeReviewerFn = () => ({
      role: 'reviewer', family: 'synthetic:precondition', provider: 'synthetic',
      model: 'synthetic-precondition', transport: null,
    });
    const reviewerFn = async () => ({
      value: { findings: [{ ...SYNTHETIC_BLOCKER }] },
      // Deterministic, mechanically-known usage so the synthetic precondition
      // settles cleanly through ModelSpendAuthority without consuming a real
      // provider call. Marked synthetic by its family (synthetic:precondition).
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      model: 'synthetic-precondition',
    });

    // Certification target isolation — same contract as the Reviewer wrapper,
    // scoped to agy:gemini-supervisor. Production RoleRouter still chooses the candidate;
    // the harness refuses to physically dispatch any Supervisor family outside
    // certification scope. A skipped-before-dispatch Gemini, or a first real
    // Gemini call that fails safely and re-routes, yields a null selection
    // (failover loop stops, ZERO fallback calls) and a certification FAIL.
    const routeSupervisorFn = (signals) => {
      const sel = providers.routeSupervisorFn(signals);
      if (!sel?.family) return sel;
      if (sel.family !== 'agy:gemini-supervisor') {
        suppressedFallbackFamilies.push(sel.family);
        return null;
      }
      supervisorSelections.push(sel.family);
      return sel;
    };
    const recordProviderFailure = (selection, failure) => {
      providerFailures.push({ role: selection?.role ?? null, family: selection?.family ?? null, code: failure?.code ?? null });
      return providers.recordProviderFailure?.(selection, failure);
    };

    const ctl = createReviewLoopController({
      ...providers, env: baseEnv, runtimeRoot,
      reviewerFn, routeReviewerFn, routeSupervisorFn, recordProviderFailure,
    });

    const begin = await ctl.begin({
      goal: `The file ${CERT_FILE} must contain exactly "${CERT_TARGET}".`,
      cwd: repo.dir,
    });

    // Round 1: genuine Worker delta -> synthetic blocker -> REWORK.
    repo.write(CERT_FILE, 'cert round 1\n');
    const r1 = await ctl.review({ loopId: begin.loopId });

    // Round 2: genuine CHANGED delta, same synthetic blocker -> Supervisor.
    repo.write(CERT_FILE, `cert round 2 ${CERT_TARGET}\n`);
    const r2 = await ctl.review({ loopId: begin.loopId });

    const records = await readSpendRecords(ctl, begin.loopId);
    const supervisorRecord = records.find((r) => r.role === 'supervisor') ?? null;
    const tel = r2.telemetry ?? {};
    const selectedSupervisorFamily = supervisorSelections[0] ?? null;
    const usageResolved = Boolean(
      supervisorRecord?.usageKnown && supervisorRecord?.usageAccounting?.volumeResolved !== false,
    );
    const supervisorFallback = providerFailures.filter((f) => f.role === 'supervisor');

    if (r1.status !== 'REWORK') failures.push(`round 1 terminal is ${r1.status}, expected REWORK (${r1.reason ?? ''})`);
    if (!['REWORK', 'PASS'].includes(r2.status)) failures.push(`round 2 terminal is ${r2.status} (${r2.reason ?? ''})`);
    if (!r2.supervisorGuidance) failures.push('controller did not surface Supervisor guidance — Supervisor path did not complete');
    if (selectedSupervisorFamily !== 'agy:gemini-supervisor') failures.push(`selected Supervisor family is ${selectedSupervisorFamily ?? 'none'}, expected agy:gemini-supervisor`);
    if (customAgentSupport?.supported !== true) failures.push(`agy custom-agent capability probe did not confirm isolated-agent loading: ${customAgentSupport?.reason ?? 'unknown'}`);
    if (providers.runtimeStatus?.['agy:gemini-supervisor']?.effectiveLoadingVerified !== true) failures.push('agy:gemini-supervisor effective-loading verification is not active');
    const supervisorResolvedModel = supervisorRecord?.model
      ?? providers.pool?.resolution?.['agy:gemini-supervisor']?.resolvedModel ?? null;
    if (supervisorResolvedModel && !/-medium$/.test(supervisorResolvedModel)) {
      failures.push(`Supervisor resolvedModel ${supervisorResolvedModel} is not a -medium Gemini variant`);
    }
    if (suppressedFallbackFamilies.length) failures.push(`production routing would have dispatched an out-of-scope fallback Supervisor family: ${suppressedFallbackFamilies.join(', ')}`);
    if ((tel.supervisorCalls ?? 0) !== 1) failures.push(`supervisorCalls=${tel.supervisorCalls}, expected 1`);
    if (supervisorFallback.length) failures.push(`Supervisor failover/failure recorded (certification does not fall back to Codex): ${JSON.stringify(supervisorFallback)}`);
    if (!supervisorRecord) failures.push('no durable Supervisor spend record — physical call not accounted');
    else if (!usageResolved) failures.push('Supervisor usage was not resolved by provider-aware accounting');

    const status = failures.length ? 'FAIL' : 'PASS';
    return {
      exitCode: status === 'PASS' ? 0 : 1,
      output: {
        certification: 'reviewloop-live/supervisor-v1',
        status,
        selectedSupervisorFamily,
        resolvedModel: supervisorRecord?.model
          ?? providers.pool?.resolution?.['agy:gemini-supervisor']?.resolvedModel ?? null,
        supervisorCalls: tel.supervisorCalls ?? 0,
        usageVolume: tel.usageVolume ?? 0,
        usageAccounting: supervisorRecord?.usageAccounting ?? {},
        usageBreakdown: tel.usageBreakdown ?? {},
        minimalAgent: providers.runtimeStatus?.['agy:gemini-supervisor']?.runtimeAvailable === true,
        effectiveLoadingVerified: providers.runtimeStatus?.['agy:gemini-supervisor']?.effectiveLoadingVerified === true,
        customAgentSupport: { supported: customAgentSupport?.supported === true, reason: customAgentSupport?.reason ?? null },
        reviewerPrecondition: 'synthetic',
        ...(suppressedFallbackFamilies.length ? { suppressedFallbackFamilies } : {}),
        ...(failures.length ? { failures } : {}),
      },
    };
  } finally {
    runtime.cleanup();
    repo.cleanup();
  }
}

// ---- entrypoint ----------------------------------------------------------

export async function main({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  let mode;
  try {
    ({ mode } = parseArgs(argv));
  } catch (err) {
    return {
      exitCode: 2,
      output: { certification: 'reviewloop-live', status: 'BAD_INVOCATION', error: err.message },
    };
  }

  if (!optInSatisfied(env)) {
    return {
      exitCode: 3,
      output: {
        certification: `reviewloop-live/${mode}-v1`,
        status: 'OPT_IN_REQUIRED',
        message: `live certification is opt-in only: set ${OPT_IN_ENV}=1 to run a real, controlled, single-call certification. ZERO provider/model calls were made.`,
      },
    };
  }

  try {
    const run = mode === 'reviewer' ? runReviewerCertification : runSupervisorCertification;
    return await run({ env, deps });
  } catch (err) {
    return {
      exitCode: 1,
      output: {
        certification: `reviewloop-live/${mode}-v1`,
        status: 'ERROR',
        error: String(err?.message ?? err),
      },
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(({ exitCode, output }) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(exitCode);
  });
}
