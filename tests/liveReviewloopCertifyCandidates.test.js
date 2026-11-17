// Deterministic tests for the per-candidate LIVE certification harness.
//
// NONE of these make a real provider call. They assert the hard opt-in guard,
// argument validation, the derived candidate matrix (completeness + no
// duplicates), unavailable-provider handling, the AGY isolation requirement,
// the accounting gate (no UNKNOWN settlement accepted), the single physical
// call (a failure never reaches a second provider), and that the script is not
// wired into `npm test` / doctor / benchmark.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  main, parseArgs, runCandidateCertification,
  CANDIDATES, ALL_CANDIDATES, SINGLE_CALL_CEILINGS, OPT_IN_ENV, VALID_ROLES,
} from '../scripts/live-reviewloop-certify-candidates.mjs';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { DEFAULT_ROLE_POLICY } from '../src/orchestrator/roleRouting.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function spy(returnValue) {
  const fn = (...args) => { fn.calls.push(args); return typeof returnValue === 'function' ? returnValue(...args) : returnValue; };
  fn.calls = [];
  return fn;
}

// Real pool (real RoleRouter, real catalog resolution, real runtimeStatus) with
// only the transport leaves faked — exactly the surface the harness reads.
function buildProviders({
  codexTransport = null, callAgy = null, transportRuntime = null,
  customAgentSupport = { supported: true, reason: 'test' },
} = {}) {
  const baseCallAgy = callAgy
    ?? (async () => ({ text: '{"findings":[]}', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 }, model: 'agy-cert-model' }));
  const wrappedCallAgy = async (opts) => {
    if (opts?.logFile) {
      try { writeFileSync(opts.logFile, 'Starting new conversation (agent=true)\n'); } catch { /* ignore */ }
    }
    return baseCallAgy(opts);
  };
  const pool = createReviewLoopProviderPool({
    callAgy: wrappedCallAgy,
    customAgentSupport,
    transportRuntime: transportRuntime ?? { 'codex:default': { available: true }, 'claude:opus': { available: false } },
    transportOverrides: codexTransport ? { 'codex:default': codexTransport } : null,
  });
  return { pool, runtimeStatus: pool.runtimeStatus };
}

const okReviewerCodex = () => spy(async () => ({
  text: '{"findings":[]}', usage: { input_tokens: 1500, output_tokens: 40, total_tokens: 1540 }, model: 'gpt-5-codex',
}));

// ---- argument validation -------------------------------------------------

test('parseArgs rejects a missing/invalid role and a family outside the role pool', () => {
  assert.throws(() => parseArgs([]), /--role must be one of/);
  assert.throws(() => parseArgs(['--role', 'planner', '--family', 'codex:default']), /--role must be one of/);
  assert.throws(() => parseArgs(['--role', 'reviewer']), /--family for role reviewer/);
  assert.throws(() => parseArgs(['--role', 'reviewer', '--family', 'agy:gemini-supervisor']), /--family for role reviewer/);
  assert.deepEqual(parseArgs(['--role', 'reviewer', '--family', 'agy:sonnet']), { role: 'reviewer', family: 'agy:sonnet' });
  assert.deepEqual(parseArgs(['--role=supervisor', '--family=agy:gemini-supervisor']), { role: 'supervisor', family: 'agy:gemini-supervisor' });
});

// ---- candidate matrix: completeness + duplicate prevention --------------

test('candidate matrix matches the required candidate set exactly', () => {
  assert.deepEqual(CANDIDATES.reviewer, ['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus']);
  assert.deepEqual(CANDIDATES.supervisor, ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus']);
  // derived straight from the production policy — no second source of truth
  for (const role of VALID_ROLES) {
    assert.deepEqual(CANDIDATES[role], DEFAULT_ROLE_POLICY[role].map((e) => e.family));
  }
  assert.equal(ALL_CANDIDATES.length, 10);
});

test('no duplicate candidate within a role, and no duplicate role|family across the matrix', () => {
  for (const role of VALID_ROLES) {
    assert.equal(new Set(CANDIDATES[role]).size, CANDIDATES[role].length, `role ${role} has a duplicate family`);
  }
  const keys = ALL_CANDIDATES.map((c) => `${c.role}|${c.family}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ---- opt-in guard ------------------------------------------------------

test('without REVIEWLOOP_LIVE_CERTIFY=1 -> zero wiring, opt-in notice, non-zero exit', async () => {
  const deps = {
    createProviders: spy({}),
    probeAgyModelCatalog: spy(null),
    probeReviewTransportRuntime: spy(Promise.resolve({})),
    detectAgyCustomAgentSupport: spy(Promise.resolve({ supported: true })),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'agy:sonnet'], env: {}, deps });
  assert.equal(exitCode, 3);
  assert.equal(output.status, 'OPT_IN_REQUIRED');
  assert.match(output.message, /ZERO provider\/model calls/);
  assert.equal(deps.createProviders.calls.length, 0);
  assert.equal(deps.probeAgyModelCatalog.calls.length, 0);
  assert.equal(deps.probeReviewTransportRuntime.calls.length, 0);
  assert.equal(deps.detectAgyCustomAgentSupport.calls.length, 0);
});

test('a bad --family -> BAD_INVOCATION, zero wiring, exit 2', async () => {
  const deps = {
    createProviders: spy({}),
    probeAgyModelCatalog: spy(null),
    probeReviewTransportRuntime: spy(Promise.resolve({})),
    detectAgyCustomAgentSupport: spy(Promise.resolve({ supported: true })),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'bogus'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 2);
  assert.equal(output.status, 'BAD_INVOCATION');
  assert.equal(deps.createProviders.calls.length, 0);
});

// ---- unavailable provider handling -----------------------------------

test('an unavailable candidate -> UNAVAILABLE, no fallback, no transport call', async () => {
  const codexTransport = okReviewerCodex();
  const deps = {
    createProviders: () => buildProviders({
      // no override (an override would force runtimeAvailable=true); codex not logged in
      transportRuntime: { 'codex:default': { available: false, reason: 'codex not logged in' }, 'claude:opus': { available: false } },
    }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: false }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'UNAVAILABLE');
  assert.equal(output.usageVolume, 0);
  assert.equal(codexTransport.calls.length, 0);
});

// ---- AGY isolation requirement --------------------------------------

test('AGY candidate with an unverified isolated agent -> ISOLATION_UNVERIFIED, no agy call', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => { agyCalls.push(opts); return { text: '{"findings":[]}', usage: { total_tokens: 10 } }; };
  const deps = {
    createProviders: () => buildProviders({ callAgy, customAgentSupport: { supported: false, reason: 'agy started the conversation with no custom agent (agent=false)' } }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: false }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: false, reason: 'agy started the conversation with no custom agent (agent=false)' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'agy:sonnet'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'ISOLATION_UNVERIFIED');
  assert.equal(output.isolationVerified, false);
  assert.equal(agyCalls.length, 0, 'a default-agent reply must never be solicited');
});

test('AGY candidate when custom-agent support was never probed -> ISOLATION_UNVERIFIED', async () => {
  // customAgentSupport:null == "not probed" -> effectiveLoadingVerified stays false
  const deps = {
    createProviders: () => buildProviders({ customAgentSupport: null }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: false }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => null,
  };
  const { output } = await main({ argv: ['--role', 'reviewer', '--family', 'agy:gpt-oss'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(output.status, 'ISOLATION_UNVERIFIED');
  assert.equal(output.isolationVerified, false);
});

// ---- the single physical call + accounting gate --------------------

test('reviewer / codex:default happy path -> PASS, exactly one transport call, resolved accounting', async () => {
  const codexTransport = okReviewerCodex();
  const deps = {
    createProviders: () => buildProviders({ codexTransport }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 0, JSON.stringify(output));
  assert.equal(output.status, 'PASS');
  assert.equal(output.role, 'reviewer');
  assert.equal(output.family, 'codex:default');
  assert.equal(codexTransport.calls.length, 1);
  assert.equal(output.usageVolume, 1540);
  assert.equal(output.accounting.method, 'provider_total');
  assert.equal(output.accounting.volumeResolved, true);
  assert.equal(output.isolationVerified, null);
  assert.equal(output.error, null);
});

test('supervisor / agy:sonnet happy path -> PASS, one agy call through the minimal agent, isolationVerified true', async () => {
  const agyCalls = [];
  const callAgy = async (opts) => {
    agyCalls.push(opts);
    return { text: '{"guidance":"tighten the diff","recommendation":"REWORK"}', usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 }, model: 'agy-sonnet-cert' };
  };
  const deps = {
    createProviders: () => buildProviders({ callAgy }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: false }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'supervisor', '--family', 'agy:sonnet'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 0, JSON.stringify(output));
  assert.equal(output.status, 'PASS');
  assert.equal(output.isolationVerified, true);
  assert.equal(agyCalls.length, 1);
  assert.equal(agyCalls[0].agent, 'reviewloop-minimal');
  assert.equal(output.usageVolume, 340);
});

test('a malformed provider reply -> FAIL (never silently an empty finding list)', async () => {
  const codexTransport = spy(async () => ({ text: 'sorry I cannot do that', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, model: 'gpt-5-codex' }));
  const deps = {
    createProviders: () => buildProviders({ codexTransport }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL');
  assert.match(output.error, /did not parse/);
});

test('usage present but not resolvable by provider-aware accounting -> FAIL (no UNKNOWN settlement)', async () => {
  // openai class needs BOTH input and output; only input present -> volumeResolved false
  const codexTransport = spy(async () => ({ text: '{"findings":[]}', usage: { input_tokens: 900 }, model: 'gpt-5-codex' }));
  const deps = {
    createProviders: () => buildProviders({ codexTransport }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(output.status, 'FAIL');
  assert.match(output.failures.join(' '), /UNKNOWN settlement|mechanically-known volume/);
});

test('missing usage object -> FAIL', async () => {
  const codexTransport = spy(async () => ({ text: '{"findings":[]}', model: 'gpt-5-codex' }));
  const deps = {
    createProviders: () => buildProviders({ codexTransport }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(output.status, 'FAIL');
  assert.match(output.failures.join(' '), /no usage object/);
});

test('a candidate call failure is reported FAIL and never reaches a second provider', async () => {
  const codexTransport = spy(async () => { throw Object.assign(new Error('codex exec failed'), { code: 'PROVIDER_PROTOCOL_ERROR' }); });
  const agyCalls = [];
  const callAgy = async (opts) => { agyCalls.push(opts); return { text: '{"findings":[]}', usage: { total_tokens: 5 } }; };
  const deps = {
    createProviders: () => buildProviders({ codexTransport, callAgy }),
    probeAgyModelCatalog: () => null,
    probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
    detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
  };
  const { exitCode, output } = await main({ argv: ['--role', 'reviewer', '--family', 'codex:default'], env: { [OPT_IN_ENV]: '1' }, deps });
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL');
  assert.equal(codexTransport.calls.length, 1, 'exactly one physical attempt');
  assert.equal(agyCalls.length, 0, 'no second provider');
  assert.match(output.error, /PROVIDER_PROTOCOL_ERROR/);
});

test('single-call ceilings are declared', () => {
  assert.equal(SINGLE_CALL_CEILINGS.MAX_REVIEWER_CALLS, 1);
  assert.equal(SINGLE_CALL_CEILINGS.MAX_SUPERVISOR_CALLS, 1);
});

// ---- not wired into automated runs ---------------------------------

test('the candidate live certification script is not referenced by npm test / doctor / benchmark', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(!cmd.includes('live-reviewloop-certify-candidates'), `package.json script "${name}" must not invoke the candidate live harness`);
  }
  for (const rel of ['scripts/doctor.js', 'scripts/benchmark-context-footprint.js', 'scripts/benchmark-review-transports.js']) {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(!src.includes('live-reviewloop-certify-candidates'), `${rel} must not reference the candidate live harness`);
  }
});

// runCandidateCertification is exported for targeted external use
test('runCandidateCertification is callable directly with injected deps', async () => {
  const codexTransport = okReviewerCodex();
  const res = await runCandidateCertification({
    role: 'reviewer',
    family: 'codex:default',
    env: { [OPT_IN_ENV]: '1' },
    deps: {
      createProviders: () => buildProviders({ codexTransport }),
      probeAgyModelCatalog: () => null,
      probeReviewTransportRuntime: async () => ({ 'codex:default': { available: true }, 'claude:opus': { available: false } }),
      detectAgyCustomAgentSupport: async () => ({ supported: true, reason: 'test' }),
    },
  });
  assert.equal(res.output.status, 'PASS');
});
