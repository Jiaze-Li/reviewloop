import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySettingsFile,
  readSettingsFile,
  resolveSettingsFilePath,
  resolveReviewCallTimeoutMs,
  MANAGED_SETTINGS_KEYS,
  INTEGER_SETTINGS_KEYS,
  DEFAULT_SETTINGS_FILE,
  SETTINGS_FILE_ENV,
} from '../src/reviewloop/settingsFile.js';
import { resolveReviewLoopLimits } from '../src/reviewloop/reviewSpend.js';
import { resolveAuthProbeTimeoutMs } from '../src/reviewloop/adapters/cliReviewTransports.js';
import { reviewDiffBudget } from '../src/reviewloop/diffChunker.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-settings-'));
  const file = path.join(dir, 'settings.json');
  if (content != null) fs.writeFileSync(file, content);
  return file;
}

const apply = (env, file) => {
  const warnings = [];
  applySettingsFile(env, { filePath: file, warn: (m) => warnings.push(m) });
  return warnings;
};

test('AC1: shipped settings file contains all 13 managed keys with valid values and resolvers read them', () => {
  const raw = JSON.parse(fs.readFileSync(DEFAULT_SETTINGS_FILE, 'utf8'));
  const expectedKeys = Object.keys(MANAGED_SETTINGS_KEYS).sort();
  assert.equal(expectedKeys.length, 13);
  assert.deepEqual(Object.keys(raw).sort(), expectedKeys);

  const { values, warnings } = readSettingsFile(DEFAULT_SETTINGS_FILE);
  assert.deepEqual(warnings, []);
  assert.equal(Object.keys(values).length, 13);

  const env = {};
  applySettingsFile(env, { filePath: DEFAULT_SETTINGS_FILE });
  const limits = resolveReviewLoopLimits(env);
  assert.equal(limits.maxCostUsd, 5);
  assert.equal(limits.maxUsageVolume, 400_000);
  assert.equal(limits.maxReviewRounds, 3);
  assert.equal(limits.maxReviewerCalls, 91);
  assert.equal(limits.maxSupervisorCalls, 8);
  assert.equal(limits.maxSingleCallUsage, 80_000);
  assert.equal(limits.maxContextOverheadTokens, 30_000);
  assert.equal(resolveReviewCallTimeoutMs(env), 240_000);
  assert.equal(resolveAuthProbeTimeoutMs(env), 25_000);
  assert.deepEqual(reviewDiffBudget(env), { limit: 45_000, maxChunks: 12 });
  assert.equal(env.REVIEWLOOP_GATE_TIMEOUT_MS, '600000');
  assert.equal(env.REVIEWLOOP_MAX_GATE_REPAIRS, '15');
});

test('AC2: legacy REVIEWLOOP_<KEY> env is discarded with one warning per key and file value wins', () => {
  const env = {
    REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '90000',
    REVIEWLOOP_MAX_GATE_REPAIRS: '99', // not in the temp file below, must still be cleared
    UNRELATED_VAR: 'keep-me',
  };
  const w = apply(env, tmpFile('{"MAX_SINGLE_CALL_USAGE": 55000}'));
  assert.equal(w.length, 2);
  assert.ok(w.some((m) => m.includes('REVIEWLOOP_MAX_SINGLE_CALL_USAGE') && /ignored/.test(m)));
  assert.ok(w.some((m) => m.includes('REVIEWLOOP_MAX_GATE_REPAIRS') && /ignored/.test(m)));
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 55_000);
  assert.equal('REVIEWLOOP_MAX_GATE_REPAIRS' in env, false);
  assert.equal(env.UNRELATED_VAR, 'keep-me');
});

test('AC5: missing file is silent and leaves code defaults', () => {
  const env = {};
  const w = apply(env, path.join(os.tmpdir(), 'rl-does-not-exist.json'));
  assert.deepEqual(w, []);
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 40_000);
  assert.equal(resolveReviewCallTimeoutMs(env), 240_000);
  assert.equal(resolveAuthProbeTimeoutMs(env), 25_000);
  assert.deepEqual(reviewDiffBudget(env), { limit: 45_000, maxChunks: 12 });
});

test('AC5: malformed JSON / non-object is ignored with a warning, never throws', () => {
  for (const content of ['{nope', '[1,2]', 'null', '"x"']) {
    const env = {};
    const w = apply(env, tmpFile(content));
    assert.equal(w.length, 1, content);
    assert.deepEqual(env, {});
  }
});

test('AC5: unknown keys, non-positive numbers, and non-integers for integer keys are ignored with warnings', () => {
  const env = {};
  const bad = {
    BOGUS: 1,
    MAX_SINGLE_CALL_USAGE: '50000',
    MAX_COST_USD: -1,
    MAX_USAGE_VOLUME: 0,
    MAX_REVIEW_ROUNDS: null,
    MAX_GATE_REPAIRS: 2.5,
    MAX_REVIEW_CHUNKS: 1.2,
    REVIEW_CALL_TIMEOUT_MS: -500,
    AUTH_PROBE_TIMEOUT_MS: 0,
  };
  const w = apply(env, tmpFile(JSON.stringify(bad)));
  assert.equal(w.length, Object.keys(bad).length);
  assert.deepEqual(env, {});
  for (const k of INTEGER_SETTINGS_KEYS) {
    assert.ok(k in MANAGED_SETTINGS_KEYS);
  }
});

test('AC5: file values above hard caps are clamped by resolvers', () => {
  const env = {};
  apply(env, tmpFile(JSON.stringify({
    MAX_SINGLE_CALL_USAGE: 99_999_999,
    MAX_CONTEXT_OVERHEAD_TOKENS: 99_999_999,
    AUTH_PROBE_TIMEOUT_MS: 99_999_999,
    REVIEW_CALL_TIMEOUT_MS: 99_999_999,
  })));
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 250_000);
  assert.equal(resolveReviewLoopLimits(env).maxContextOverheadTokens, 200_000);
  assert.equal(resolveAuthProbeTimeoutMs(env), 60_000);
  assert.equal(resolveReviewCallTimeoutMs(env), 600_000);
});

test('settings path override via REVIEWLOOP_SETTINGS_FILE', () => {
  assert.equal(resolveSettingsFilePath({ [SETTINGS_FILE_ENV]: '/x/y.json' }), '/x/y.json');
  assert.equal(resolveSettingsFilePath({}), DEFAULT_SETTINGS_FILE);
});

test('inherited object names ("constructor", "toString", "__proto__") are unknown keys, not whitelisted', () => {
  const env = {};
  const w = apply(env, tmpFile('{"constructor": 1, "toString": 2, "hasOwnProperty": 3, "__proto__": {"x": 1}}'));
  assert.equal(w.length, 4);
  assert.ok(w.every((m) => /unknown key/.test(m)), JSON.stringify(w));
  assert.deepEqual(env, {});
});

test('AC3 & AC6: removed AGY/CLI timeout symbols and stale env/number references are absent', () => {
  const forbiddenCodeSymbols = [
    'REVIEWLOOP_AGY_TIMEOUT_MS',
    'resolveAgyReviewTimeoutMs',
    'DEFAULT_AGY_REVIEW_TIMEOUT_MS',
    'MAX_AGY_REVIEW_TIMEOUT_MS',
    'DEFAULT_CLI_TRANSPORT_TIMEOUT_MS',
  ];
  const scanDirs = ['src', 'bin', 'scripts'];
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  for (const d of scanDirs) {
    for (const file of walk(path.join(REPO_ROOT, d))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const sym of forbiddenCodeSymbols) {
        assert.equal(text.includes(sym), false, `${path.relative(REPO_ROOT, file)} must not reference ${sym}`);
      }
    }
  }

  // Docs and CLI hint text must not quote removed REVIEWLOOP_<MANAGED_KEY> env names
  // or stale numeric defaults for managed parameters.
  const managedEnvPattern = new RegExp(
    `\\b(?:${Object.values(MANAGED_SETTINGS_KEYS).join('|')}|REVIEWLOOP_MAX_\\*)\\b`,
  );
  const staleDefaultPatterns = [
    /\bdefault\s+(?:15|40[\s_]?000|30[\s_]?000|50[\s_]?000)\b/i,
    /\bsets\s+`?MAX_SINGLE_CALL_USAGE`?\s+to\s+50[\s_]?000\b/i,
    /\(40000\s+single-call/i,
    /\bhard\s+cap\s+(?:250[\s_]?000|200[\s_]?000|60[\s_]?000|600[\s_]?000)\b/i,
    /TOKEN_SENTINEL_HARD_CAPS[^\n]*(?:250[\s_]?000|200[\s_]?000)/,
  ];
  for (const rel of ['README.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md', 'bin/reviewloop.js']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.equal(managedEnvPattern.test(text), false, `${rel} must not quote legacy managed REVIEWLOOP_* env names`);
    for (const re of staleDefaultPatterns) {
      assert.equal(re.test(text), false, `${rel} must not quote stale numeric default (${re})`);
    }
  }
});

test('Production entrypoints applySettingsFile before any resolver reads limits', () => {
  const mcpServer = fs.readFileSync(path.join(REPO_ROOT, 'src/mcp/reviewloopMcpServer.js'), 'utf8');
  const startIdx = mcpServer.indexOf('export async function startReviewLoopMcpServer');
  assert.ok(startIdx >= 0);
  const startBody = mcpServer.slice(startIdx);
  const applyIdx = startBody.indexOf('applySettingsFile(process.env)');
  const runtimeIdx = startBody.indexOf('resolveMcpStartupRuntimeInputs');
  const createIdx = startBody.indexOf('createReviewLoopMcpServer');
  assert.ok(applyIdx > 0 && applyIdx < runtimeIdx && applyIdx < createIdx);

  const cli = fs.readFileSync(path.join(REPO_ROOT, 'bin/reviewloop.js'), 'utf8');
  const mainIdx = cli.indexOf('async function main()');
  const cliApplyIdx = cli.indexOf('applySettingsFile(process.env)', mainIdx);
  const switchIdx = cli.indexOf('switch (command)', mainIdx);
  assert.ok(cliApplyIdx > mainIdx && cliApplyIdx < switchIdx);

  const doctor = fs.readFileSync(path.join(REPO_ROOT, 'scripts/doctor.js'), 'utf8');
  const directIdx = doctor.indexOf('if (invokedDirectly)');
  const docApplyIdx = doctor.indexOf('applySettingsFile(process.env)', directIdx);
  const runDocIdx = doctor.indexOf('runDoctor(', directIdx);
  assert.ok(docApplyIdx > directIdx && docApplyIdx < runDocIdx);

  for (const rel of ['scripts/live-reviewloop-certify.mjs', 'scripts/live-reviewloop-certify-candidates.mjs']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.equal(src.includes('applySettingsOverridesToEnv'), true, `${rel} must use applySettingsOverridesToEnv`);
    assert.equal(/REVIEWLOOP_MAX_/.test(src), false, `${rel} must not pass legacy REVIEWLOOP_MAX_* env vars`);
  }
});
