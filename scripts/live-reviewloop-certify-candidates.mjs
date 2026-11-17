#!/usr/bin/env node
// Per-candidate ReviewLoop provider LIVE certification harness.
//
// Companion to scripts/live-reviewloop-certify.mjs. That harness certifies the
// two PRODUCTION MAIN paths end to end through the real controller. THIS harness
// certifies each individual Reviewer / Supervisor FALLBACK CANDIDATE in
// isolation: one controlled real provider smoke per candidate, no controller, no
// production routing, no failover.
//
//   node scripts/live-reviewloop-certify-candidates.mjs --role reviewer   --family agy:sonnet
//   node scripts/live-reviewloop-certify-candidates.mjs --role supervisor --family claude:opus
//
// Exactly ONE candidate per invocation -> structurally at most ONE physical
// model call per run. The harness never calls the RoleRouter, so a candidate
// that is unavailable is reported UNAVAILABLE and NOTHING else is dispatched:
// no fallback traversal, no retry, no second provider.
//
// Without REVIEWLOOP_LIVE_CERTIFY=1 the script performs ZERO provider/model
// calls, prints an opt-in-required notice, and exits non-zero.
//
// What each candidate is checked for:
//   provider availability : the family's transport is wired (executable present,
//                           auth available, transport constructs) per the real
//                           production pool runtimeStatus. Not wired -> UNAVAILABLE.
//   response              : the one real reply parses through the real
//                           parseJsonish + the real Reviewer/Supervisor payload
//                           validator into the expected shape.
//   accounting            : provider usage present, resolved by the real
//                           provider-aware accounting (usageAccountingOf) into a
//                           mechanically-known volume — volumeResolved must not
//                           be false, the method must not be a no-usage / UNKNOWN
//                           settlement, and usageVolume must be a finite > 0.
//   AGY isolation         : for every agy:* family the startup capability probe
//                           must confirm the isolated reviewloop-minimal agent
//                           loads (customAgentSupport.supported === true) AND the
//                           pool must have per-call effective-loading verification
//                           active (effectiveLoadingVerified === true). If AGY
//                           isolation is not verified the candidate FAILs
//                           (ISOLATION_UNVERIFIED) — a default-agent reply is
//                           never accepted.
//
// Output: one compact JSON object:
//   { role, family, status, resolvedModel, usageVolume, accounting,
//     isolationVerified, durationMs, error }
// Never prints prompts, diffs, credentials, HOME config, or raw provider replies.
//
// Safety: no fallback traversal, no failure-retry, no second provider, no
// provider-health mutation, no real user-config writes (AGY uses the isolated
// redirected gemini dir), production routing / DEFAULT_ROLE_POLICY / accounting
// / controller are untouched.

import { rmSync } from 'node:fs';
import {
  createProductionReviewLoopProviders,
  detectAgyCustomAgentSupport,
  narrowAgyGeminiDir,
  parseJsonish,
  validateReviewerPayload,
  validateSupervisorPayload,
} from '../src/reviewloop/providerWiring.js';
import {
  usageAccountingOf,
  accountingProvenanceOf,
} from '../src/reviewloop/reviewSpend.js';
import { DEFAULT_ROLE_POLICY } from '../src/orchestrator/roleRouting.js';
import { probeAgyModelCatalog } from '../src/agy/agyModelCatalog.js';
import { probeReviewTransportRuntime } from '../src/reviewloop/adapters/cliReviewTransports.js';
import { applySettingsOverridesToEnv } from '../src/reviewloop/settingsFile.js';

export const OPT_IN_ENV = 'REVIEWLOOP_LIVE_CERTIFY';
export const VALID_ROLES = Object.freeze(['reviewer', 'supervisor']);

// The candidate matrix is DERIVED from the production role policy so a policy
// edit that adds / drops / reorders a fallback candidate is reflected here with
// no second source of truth — and a deterministic test pins the derived matrix
// to the exact expected candidate set.
export const CANDIDATES = Object.freeze(
  Object.fromEntries(
    VALID_ROLES.map((role) => [
      role,
      Object.freeze((DEFAULT_ROLE_POLICY[role] ?? []).map((entry) => entry.family)),
    ]),
  ),
);

export const ALL_CANDIDATES = Object.freeze(
  VALID_ROLES.flatMap((role) => CANDIDATES[role].map((family) => Object.freeze({ role, family }))),
);

// One physical certification call — never a failover chain. Informational: this
// harness makes exactly one transport call by construction and never touches the
// RoleRouter, but the ceilings are still exported so a wrapper can assert them.
export const SINGLE_CALL_CEILINGS = Object.freeze({
  MAX_REVIEWER_CALLS: 1,
  MAX_SUPERVISOR_CALLS: 1,
  MAX_REVIEW_ROUNDS: 1,
  MAX_USAGE_VOLUME: 40000,
});

export const HARNESS_TIMEOUT_MS = 300_000;

const AGY_MISSING_RE = /binary not found|not found|failed to spawn|does not accept|requires a geminiDir/i;

export function parseArgs(argv = []) {
  let role = null;
  let family = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--role') { role = argv[i + 1] ?? null; i += 1; continue; }
    if (a.startsWith('--role=')) { role = a.slice('--role='.length); continue; }
    if (a === '--family') { family = argv[i + 1] ?? null; i += 1; continue; }
    if (a.startsWith('--family=')) { family = a.slice('--family='.length); continue; }
  }
  if (!role || !VALID_ROLES.includes(role)) {
    throw Object.assign(
      new Error(`--role must be one of: ${VALID_ROLES.join(', ')}${role ? ` (got ${JSON.stringify(role)})` : ' (missing)'}`),
      { code: 'BAD_ARGS' },
    );
  }
  if (!family || !CANDIDATES[role].includes(family)) {
    throw Object.assign(
      new Error(
        `--family for role ${role} must be one of: ${CANDIDATES[role].join(', ')}`
        + `${family ? ` (got ${JSON.stringify(family)})` : ' (missing)'}`,
      ),
      { code: 'BAD_ARGS' },
    );
  }
  return { role, family };
}

export function optInSatisfied(env = process.env) {
  return env?.[OPT_IN_ENV] === '1';
}

const defaultDeps = Object.freeze({
  createProviders: (opts) => createProductionReviewLoopProviders(opts),
  probeAgyModelCatalog: () => probeAgyModelCatalog({ geminiDir: narrowAgyGeminiDir() }),
  probeReviewTransportRuntime: (o) => probeReviewTransportRuntime(o),
  detectAgyCustomAgentSupport: () => detectAgyCustomAgentSupport({ geminiDir: narrowAgyGeminiDir() }),
});

function reviewerPrompt() {
  return [
    'You are an INDEPENDENT code reviewer. This is a wiring smoke test.',
    'ORIGINAL OBJECTIVE: add a trailing newline to a README file.',
    'GIT DIFF (primary evidence):',
    '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+hello\n',
    '',
    'Return ONLY JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
    'If nothing is wrong, return {"findings":[]}.',
  ].join('\n');
}

function supervisorPrompt() {
  return [
    'You are a repair STRATEGIST, not an implementer. This is a wiring smoke test.',
    'ORIGINAL OBJECTIVE: add a trailing newline to a README file.',
    'PERSISTENT BLOCKING FINDINGS:',
    JSON.stringify([{ severity: 'P1', file: 'README.md', line: 1, title: 'synthetic blocker for the smoke test' }], null, 2),
    'Return ONLY JSON: {"guidance":"","recommendation":"REWORK|HUMAN_REQUIRED"}.',
  ].join('\n');
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} exceeded ${ms}ms`), { code: 'HARNESS_TIMEOUT' })),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function summary({
  role, family, status, resolvedModel = null, usageVolume = 0, accounting = null,
  isolationVerified = null, durationMs = 0, error = null, failures = [],
}) {
  return {
    certification: `reviewloop-live/candidate/${role}/${family}`,
    role,
    family,
    status,
    resolvedModel,
    usageVolume,
    accounting,
    isolationVerified,
    durationMs,
    error,
    ...(failures.length ? { failures } : {}),
  };
}

export async function runCandidateCertification({ role, family, env = process.env, deps = {} } = {}) {
  const d = { ...defaultDeps, ...deps };
  const isAgy = family.startsWith('agy:');
  const { env: baseEnv, filePath: settingsFile } = applySettingsOverridesToEnv(env, SINGLE_CALL_CEILINGS);
  try {

  const agyCatalog = d.probeAgyModelCatalog();
  const transportRuntime = await d.probeReviewTransportRuntime();
  const customAgentSupport = await d.detectAgyCustomAgentSupport();
  const providers = d.createProviders({ env: baseEnv, agyCatalog, transportRuntime, customAgentSupport });
  const pool = providers.pool;

  const rt = pool.runtimeStatus?.[family] ?? null;
  const resolvedFromCatalog = pool.resolution?.[family] ?? null;
  const provider = resolvedFromCatalog?.provider
    ?? (isAgy ? family.replace(':', '-') : family.split(':')[0]);
  const base = { role, family, resolvedModel: resolvedFromCatalog?.resolvedModel ?? null };

  // --- provider availability -------------------------------------------------
  if (!rt || rt.runtimeAvailable !== true) {
    // Distinguish "agy is present but refuses to load the isolated agent"
    // (a certification FAILURE — a default-agent reply must never be accepted)
    // from "the executable / auth / transport is simply not available here"
    // (UNAVAILABLE — nothing to certify on this machine).
    const agyIsolationBroken = isAgy
      && customAgentSupport?.supported === false
      && !AGY_MISSING_RE.test(String(customAgentSupport?.reason ?? ''));
    return {
      exitCode: 1,
      output: summary({
        ...base,
        status: agyIsolationBroken ? 'ISOLATION_UNVERIFIED' : 'UNAVAILABLE',
        isolationVerified: isAgy ? false : null,
        error: rt?.reason ?? 'family not wired in the production pool',
      }),
    };
  }

  // --- AGY isolation precondition ------------------------------------------
  if (isAgy) {
    const isolationOk = customAgentSupport?.supported === true
      && rt.effectiveLoadingVerified === true;
    if (!isolationOk) {
      return {
        exitCode: 1,
        output: summary({
          ...base,
          status: 'ISOLATION_UNVERIFIED',
          isolationVerified: false,
          error: `AGY isolation not verified (customAgentSupport.supported=${customAgentSupport?.supported}, `
            + `effectiveLoadingVerified=${rt.effectiveLoadingVerified}); default-agent output is not acceptable`,
        }),
      };
    }
  }

  const transport = pool.transports?.[family];
  if (typeof transport !== 'function') {
    return {
      exitCode: 1,
      output: summary({
        ...base, status: 'UNAVAILABLE', isolationVerified: isAgy ? false : null,
        error: 'transport is wired-available in runtimeStatus but no transport function was constructed',
      }),
    };
  }

  // --- the single physical certification call -----------------------------
  const prompt = role === 'reviewer' ? reviewerPrompt() : supervisorPrompt();
  const t0 = Date.now();
  let res;
  try {
    res = await withTimeout(transport(prompt), HARNESS_TIMEOUT_MS, `${role} ${family} certification call`);
  } catch (err) {
    const durationMs = Date.now() - t0;
    const code = err?.code ?? err?.providerFailure ?? null;
    const isolationFail = code === 'AGY_ISOLATION_UNVERIFIED';
    return {
      exitCode: 1,
      output: summary({
        ...base,
        status: isolationFail ? 'ISOLATION_UNVERIFIED' : 'FAIL',
        isolationVerified: isAgy ? false : null,
        durationMs,
        error: `${code ?? 'ERROR'}: ${String(err?.message ?? err)}`,
      }),
    };
  }
  const durationMs = Date.now() - t0;

  const resolvedModel = (typeof res?.model === 'string' && res.model)
    ? res.model
    : base.resolvedModel;

  // --- response parse + shape -------------------------------------------
  const failures = [];
  const { parsed, raw } = parseJsonish(res);
  const payload = role === 'reviewer'
    ? validateReviewerPayload(parsed, { raw })
    : validateSupervisorPayload(parsed, { raw });
  if (payload?.malformed) {
    failures.push(`response did not parse into the expected ${role} shape: ${payload.reason}`);
  }

  // --- accounting ------------------------------------------------------
  const acc = usageAccountingOf({ usage: res?.usage ?? null, family, provider });
  const accounting = accountingProvenanceOf(acc);
  if (res?.usage == null) {
    failures.push('provider returned no usage object — usage not resolved');
  }
  if (acc.volumeResolved === false) {
    failures.push(`provider-aware accounting could not resolve a mechanically-known volume (method=${acc.usageAccountingMethod}) — UNKNOWN settlement`);
  }
  if (!acc.usageAccountingMethod || acc.usageAccountingMethod === 'no_usage_reported') {
    failures.push(`accounting method is ${acc.usageAccountingMethod || 'missing'}`);
  }
  if (!Number.isFinite(acc.usageVolume) || acc.usageVolume <= 0) {
    failures.push(`resolved usageVolume is ${acc.usageVolume}`);
  }

  // --- AGY isolation (per-call) --------------------------------------
  // A successful agy:* transport return means the pool's per-call
  // effective-loading verification passed (it throws AGY_ISOLATION_UNVERIFIED
  // otherwise, handled above).
  const isolationVerified = isAgy
    ? (rt.effectiveLoadingVerified === true && customAgentSupport?.supported === true)
    : null;
  if (isAgy && isolationVerified !== true) {
    failures.push('AGY isolation could not be confirmed for this call');
  }

  const status = failures.length ? 'FAIL' : 'PASS';
  return {
    exitCode: status === 'PASS' ? 0 : 1,
    output: summary({
      role,
      family,
      status,
      resolvedModel,
      usageVolume: acc.usageVolume,
      accounting,
      isolationVerified,
      durationMs,
      error: failures.length ? failures[0] : null,
      failures,
    }),
  };
  } finally {
    try { rmSync(settingsFile, { force: true }); } catch { /* best effort */ }
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  let role;
  let family;
  try {
    ({ role, family } = parseArgs(argv));
  } catch (err) {
    return {
      exitCode: 2,
      output: { certification: 'reviewloop-live/candidate', status: 'BAD_INVOCATION', error: err.message },
    };
  }

  if (!optInSatisfied(env)) {
    return {
      exitCode: 3,
      output: {
        certification: `reviewloop-live/candidate/${role}/${family}`,
        status: 'OPT_IN_REQUIRED',
        message: `live certification is opt-in only: set ${OPT_IN_ENV}=1 to run one real, controlled, `
          + 'single-call candidate certification. ZERO provider/model calls were made.',
      },
    };
  }

  try {
    return await runCandidateCertification({ role, family, env, deps });
  } catch (err) {
    return {
      exitCode: 1,
      output: {
        certification: `reviewloop-live/candidate/${role}/${family}`,
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
