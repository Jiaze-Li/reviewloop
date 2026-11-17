// Deterministic tests for the LIVE ReviewLoop certification harness.
//
// NONE of these run a real certification. They assert the hard opt-in guard,
// invalid-mode rejection, the structural wiring each mode drives (real
// controller + real production routing + real spend accounting, only the
// transport leaf faked), the single-call ceilings, and that the script is not
// wired into `npm test` / doctor / benchmark.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main, parseArgs, MODE_CEILINGS, OPT_IN_ENV,
} from '../scripts/live-reviewloop-certify.mjs';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { narrowReviewTransportCwd } from '../src/reviewloop/adapters/scratchCwd.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function spy(returnValue) {
  const fn = (...args) => { fn.calls.push(args); return typeof returnValue === 'function' ? returnValue(...args) : returnValue; };
  fn.calls = [];
  return fn;
}

// A providers object shaped like createProductionReviewLoopProviders(), built on
// the REAL pool (real RoleRouter, real DEFAULT_ROLE_POLICY, real catalog
// resolution) with only the transport leaves faked.
function fakeProviders({
  codexTransport = null, callAgy = null, transportRuntime = null,
  customAgentSupport = { supported: true, reason: 'test' },
} = {}) {
  const baseCallAgy = callAgy
    ?? (async () => ({ text: '{"guidance":"do x","recommendation":"REWORK"}', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model: 'gemini-cert-medium' }));
  // When the pool enforces per-call effective-loading verification it passes a
  // --log-file path; emit the activation marker agy would write so a faked
  // transport still passes the isolation check.
  const wrappedCallAgy = async (opts) => {
    if (opts?.logFile) {
      try { writeFileSync(opts.logFile, 'Starting new conversation (agent=true)\n'); } catch { /* ignore */ }
    }
    return baseCallAgy(opts);
  };
  const pool = createReviewLoopProviderPool({
    callAgy: wrappedCallAgy,
    customAgentSupport,
    transportRuntime: transportRuntime ?? { 'codex:default': { available: true, reason: 'test' }, 'claude:opus': { available: false, reason: 'test' } },
    transportOverrides: codexTransport ? { 'codex:default': codexTransport } : null,
  });
  const invoke = (parse) => async (args) => {
    const sel = args.selection ?? pool.route(args.role ?? 'reviewer');
    if (!sel?.transport) throw Object.assign(new Error('no eligible provider'), { code: 'PROVIDER_UNAVAILABLE' });
    const res = await sel.transport('cert-prompt');
    return { value: parse(res), usage: res.usage ?? null, model: res.model ?? sel.model ?? null };
  };
  return {
    pool,
    runtimeStatus: pool.runtimeStatus,
    routeReviewerFn: (s) => pool.route('reviewer', s),
    routeSupervisorFn: (s) => pool.route('supervisor', s),
    recordProviderFailure: pool.recordFailure,
    reviewerFn: invoke((res) => JSON.parse(res.text)),
    supervisorFn: invoke((res) => {
      const p = JSON.parse(res.text);
      return { guidance: String(p.guidance), recommendation: String(p.recommendation).toUpperCase() };
    }),
  };
}

test('parseArgs rejects a missing or invalid mode', () => {
  assert.throws(() => parseArgs([]), /--mode must be one of/);
  assert.throws(() => parseArgs(['--mode', 'planner']), /--mode must be one of/);
  assert.deepEqual(parseArgs(['--mode', 'reviewer']), { mode: 'reviewer' });
  assert.deepEqual(parseArgs(['--mode=supervisor']), { mode: 'supervisor' });
});

test('1. without REVIEWLOOP_LIVE_CERTIFY=1 -> zero wiring, opt-in notice, non-zero exit', async () => {
  const deps = {
    createProviders: spy({}),
    probeAgyModelCatalog: spy(null),
    probeReviewTransportRuntime: spy(Promise.resolve({})),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'reviewer'], env: {}, deps });
  assert.equal(exitCode, 3);
  assert.equal(output.status, 'OPT_IN_REQUIRED');
  assert.match(output.message, /ZERO provider\/model calls/);
  assert.equal(deps.createProviders.calls.length, 0);
  assert.equal(deps.probeAgyModelCatalog.calls.length, 0);
  assert.equal(deps.probeReviewTransportRuntime.calls.length, 0);
});

test('2. invalid mode -> zero wiring, non-zero exit', async () => {
  const deps = {
    createProviders: spy({}),
    probeAgyModelCatalog: spy(null),
    probeReviewTransportRuntime: spy(Promise.resolve({})),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'bogus'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 2);
  assert.equal(output.status, 'BAD_INVOCATION');
  assert.equal(deps.createProviders.calls.length, 0);
  assert.equal(deps.probeAgyModelCatalog.calls.length, 0);
  assert.equal(deps.probeReviewTransportRuntime.calls.length, 0);
});

test('3. reviewer mode drives the real controller production route to agy:opus (isolated)', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    return { text: '{"findings":[]}', usage: { input_tokens: 1200, output_tokens: 20, total_tokens: 1220 }, model: 'claude-opus-4-6' };
  };
  const deps = {
    createProviders: () => fakeProviders({ callAgy }),
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'reviewer'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(output.status, 'PASS', JSON.stringify(output));
  assert.equal(exitCode, 0);
  assert.equal(output.terminal, 'PASS');
  assert.equal(output.selectedReviewerFamily, 'agy:opus');
  assert.equal(output.reviewerCalls, 1);
  assert.equal(output.supervisorCalls, 0);
  // proves the review actually went through the controller + the isolated AGY transport
  assert.equal(agyCalls.length, 1);
  assert.equal(agyCalls[0].agent, 'reviewloop-minimal');
  assert.equal(agyCalls[0].cwd, narrowReviewTransportCwd());
  assert.match(output.resolvedModel, /^claude-opus-/);
  assert.equal(output.effectiveLoadingVerified, true);
  assert.equal(output.tempRepo, true);
});

test('4. supervisor mode drives the real Supervisor route (agy:gemini-supervisor + reviewloop-minimal) and cannot be replaced by a fake transport', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    return { text: '{"guidance":"adjust the approach","recommendation":"REWORK"}', usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 }, model: 'gemini-cert-medium' };
  };
  const deps = {
    createProviders: () => fakeProviders({ callAgy }),
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: false }, 'claude:opus': { available: false } }),
  };
  const { output } = await main({ argv: ['--mode', 'supervisor'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(output.status, 'PASS', JSON.stringify(output));
  assert.equal(output.selectedSupervisorFamily, 'agy:gemini-supervisor');
  assert.equal(output.supervisorCalls, 1);
  assert.equal(output.reviewerPrecondition, 'synthetic');
  // the real Supervisor physical path: exactly one AGY call, through the
  // workspace-local minimal agent, from the isolated scratch cwd.
  assert.equal(agyCalls.length, 1);
  assert.equal(agyCalls[0].agent, 'reviewloop-minimal');
  assert.equal(agyCalls[0].cwd, narrowReviewTransportCwd());
  assert.equal(output.usageAccounting.method, 'provider_total');
});

test('5. single-call ceilings: a first-call Supervisor failure does NOT fall back to a second provider', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    throw Object.assign(new Error('agy executable not found'), { code: 'AGY_ENOENT', exitCode: 127 });
  };
  const deps = {
    createProviders: () => fakeProviders({ callAgy }),
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: true } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'supervisor'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL');
  assert.equal(agyCalls.length, 1, 'exactly one physical Supervisor attempt — no Codex fallback');
  assert.equal(MODE_CEILINGS.supervisor.MAX_SUPERVISOR_CALLS, 1);
  assert.equal(MODE_CEILINGS.reviewer.MAX_REVIEWER_CALLS, 1);
});

// ---- certification target isolation --------------------------------------
//
// Production RoleRouter still chooses the candidate, but the harness refuses to
// physically dispatch any family outside the certification target. A fallback
// the router would have picked is recorded by name only (suppressedFallback-
// Families) and never reaches the controller for dispatch.

const OK_FINDINGS = () => ({ text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, model: 'gemini-cert-low' });

test('R-A. reviewer: Opus head skipped before dispatch -> router would pick the next family -> zero calls, FAIL', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => { agyCalls.push(opts); return OK_FINDINGS(); };
  const deps = {
    createProviders: () => {
      const p = fakeProviders({ callAgy });
      p.recordProviderFailure({ role: 'reviewer', family: 'agy:opus', provider: 'agy-claude-gpt' }, { code: 'PROVIDER_UNAVAILABLE' });
      return p;
    },
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'reviewer'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL', JSON.stringify(output));
  assert.notEqual(output.terminal, 'PASS');
  assert.deepEqual(output.suppressedFallbackFamilies, ['agy:gemini-reviewer'], 'production routing would next choose agy:gemini-reviewer');
  assert.equal(agyCalls.length, 0, 'zero physical calls when the target is skipped before dispatch');
  assert.equal(output.reviewerCalls, 0);
});

test('R-B. reviewer: Opus head selected -> retryable pre-send failure -> router advances -> one Opus call, zero fallback calls, FAIL', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    throw Object.assign(new Error('opus pre-send failure'), { code: 'PROVIDER_UNAVAILABLE' });
  };
  const deps = {
    createProviders: () => fakeProviders({ callAgy }),
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'reviewer'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL', JSON.stringify(output));
  assert.equal(agyCalls.length, 1, 'Opus physicalInvocations = 1');
  assert.deepEqual(output.suppressedFallbackFamilies, ['agy:gemini-reviewer']);
});

test('S-A. supervisor: gemini unavailable -> router would pick codex -> zero Codex calls, FAIL', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => { agyCalls.push(opts); return { text: '{"guidance":"x","recommendation":"REWORK"}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, model: 'gemini-cert' }; };
  const deps = {
    createProviders: () => {
      const p = fakeProviders({ callAgy });
      p.recordProviderFailure({ role: 'supervisor', family: 'agy:gemini-supervisor', provider: 'agy-gemini' }, { code: 'PROVIDER_UNAVAILABLE' });
      return p;
    },
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'supervisor'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL', JSON.stringify(output));
  assert.deepEqual(output.suppressedFallbackFamilies, ['codex:default'], 'production routing would next choose codex:default');
  assert.equal(output.supervisorCalls, 0, 'Codex physicalInvocations = 0');
  // the synthetic reviewer precondition is the only agy consumer here
  assert.equal(agyCalls.length, 0);
});

test('S-B. supervisor: gemini selected -> retryable safe failure -> router advances Codex -> one Gemini call, zero Codex calls, FAIL', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    throw Object.assign(new Error('gemini transport unavailable (retryable, pre-send)'), { code: 'PROVIDER_UNAVAILABLE' });
  };
  const deps = {
    createProviders: () => fakeProviders({ callAgy, transportRuntime: { 'codex:default': { available: true }, 'claude:opus': { available: false } } }),
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
  };
  const { exitCode, output } = await main({ argv: ['--mode', 'supervisor'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL', JSON.stringify(output));
  assert.equal(agyCalls.length, 1, 'Gemini physicalInvocations = 1');
  assert.deepEqual(output.suppressedFallbackFamilies, ['codex:default'], 'Codex physicalInvocations = 0 (selected by the router, suppressed before dispatch)');
  // exactly one metered Supervisor attempt (the Gemini one) — the suppressed
  // Codex re-route is never dispatched or accounted.
  assert.equal(output.supervisorCalls, 1);
  assert.equal(output.selectedSupervisorFamily, 'agy:gemini-supervisor');
});

test('6. the live certification script is not referenced by npm test / doctor / benchmark', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(!cmd.includes('live-reviewloop-certify'), `package.json script "${name}" must not invoke the live harness`);
  }
  for (const rel of ['scripts/doctor.js', 'scripts/benchmark-context-footprint.js', 'scripts/benchmark-review-transports.js']) {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(!src.includes('live-reviewloop-certify'), `${rel} must not reference the live harness`);
  }
});
