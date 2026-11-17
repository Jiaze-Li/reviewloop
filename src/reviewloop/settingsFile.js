// Shared ReviewLoop settings file.
//
// One JSON file inside the ReviewLoop repo (`reviewloop.settings.json`) holds
// the 13 managed budget, limit, and timeout parameters, so every MCP client
// (Claude Code, Antigravity, ...) and every model family gets the same values
// with a single edit.
//
// Authority: the settings file is the ONLY source in production. At startup,
// `applySettingsFile` discards any legacy `REVIEWLOOP_<KEY>` env vars for
// managed keys with a warning, then populates the env-shaped map from the file
// alone. Values still flow through each resolver's validator and hard caps, so
// a missing/invalid value falls back to the code default and never disables or
// inflates a guard.
//
// Fail-safe: a missing file is normal; a malformed file, unknown key or
// illegal value is ignored with a warning and never throws.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_FILE_ENV = 'REVIEWLOOP_SETTINGS_FILE';
export const DEFAULT_SETTINGS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reviewloop.settings.json',
);

// Complete set of 13 managed keys (short JSON key -> env-shaped key).
export const MANAGED_SETTINGS_KEYS = Object.freeze({
  MAX_COST_USD: 'REVIEWLOOP_MAX_COST_USD',
  MAX_USAGE_VOLUME: 'REVIEWLOOP_MAX_USAGE_VOLUME',
  MAX_REVIEW_ROUNDS: 'REVIEWLOOP_MAX_REVIEW_ROUNDS',
  MAX_REVIEWER_CALLS: 'REVIEWLOOP_MAX_REVIEWER_CALLS',
  MAX_SUPERVISOR_CALLS: 'REVIEWLOOP_MAX_SUPERVISOR_CALLS',
  MAX_SINGLE_CALL_USAGE: 'REVIEWLOOP_MAX_SINGLE_CALL_USAGE',
  MAX_CONTEXT_OVERHEAD_TOKENS: 'REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS',
  GATE_TIMEOUT_MS: 'REVIEWLOOP_GATE_TIMEOUT_MS',
  MAX_GATE_REPAIRS: 'REVIEWLOOP_MAX_GATE_REPAIRS',
  MAX_REVIEW_DIFF_CHARS: 'REVIEWLOOP_MAX_REVIEW_DIFF_CHARS',
  MAX_REVIEW_CHUNKS: 'REVIEWLOOP_MAX_REVIEW_CHUNKS',
  AUTH_PROBE_TIMEOUT_MS: 'REVIEWLOOP_AUTH_PROBE_TIMEOUT_MS',
  REVIEW_CALL_TIMEOUT_MS: 'REVIEWLOOP_REVIEW_CALL_TIMEOUT_MS',
});

export const INTEGER_SETTINGS_KEYS = new Set([
  'MAX_REVIEW_ROUNDS',
  'MAX_REVIEWER_CALLS',
  'MAX_SUPERVISOR_CALLS',
  'MAX_GATE_REPAIRS',
  'MAX_REVIEW_CHUNKS',
]);

// Shared positive-number / positive-integer / bounded validators so every
// resolver treats illegal values identically.
export function parsePositiveNumber(raw, fallback) {
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parsePositiveInt(raw, fallback) {
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseBoundedNumber(raw, fallback, hardCap) {
  const n = parsePositiveNumber(raw, NaN);
  return Number.isFinite(n) ? Math.min(n, hardCap) : fallback;
}

// Unified review-call timeout across AGY, Codex CLI, and Claude CLI.
export const DEFAULT_REVIEW_CALL_TIMEOUT_MS = 240_000;
export const MAX_REVIEW_CALL_TIMEOUT_MS = 600_000;
export const REVIEW_CALL_TIMEOUT_ENV = MANAGED_SETTINGS_KEYS.REVIEW_CALL_TIMEOUT_MS;

export function resolveReviewCallTimeoutMs(env = process.env) {
  return parseBoundedNumber(
    env?.[REVIEW_CALL_TIMEOUT_ENV],
    DEFAULT_REVIEW_CALL_TIMEOUT_MS,
    MAX_REVIEW_CALL_TIMEOUT_MS,
  );
}

export function resolveSettingsFilePath(env = process.env) {
  const override = env?.[SETTINGS_FILE_ENV];
  return typeof override === 'string' && override.trim() ? override : DEFAULT_SETTINGS_FILE;
}

// Returns { values: { REVIEWLOOP_X: '123' }, warnings: [string] }. Never throws.
export function readSettingsFile(filePath) {
  const values = {};
  const warnings = [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`cannot read settings file ${filePath}: ${err?.message ?? err}`);
    return { values, warnings };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warnings.push(`settings file ${filePath} is not valid JSON, ignored: ${err?.message ?? err}`);
    return { values, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`settings file ${filePath} must be a JSON object, ignored`);
    return { values, warnings };
  }
  for (const [key, value] of Object.entries(parsed)) {
    const envName = Object.hasOwn(MANAGED_SETTINGS_KEYS, key) ? MANAGED_SETTINGS_KEYS[key] : null;
    if (!envName) {
      warnings.push(`settings file: unknown key "${key}" ignored`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      warnings.push(`settings file: "${key}" must be a positive number, ignored`);
      continue;
    }
    if (INTEGER_SETTINGS_KEYS.has(key) && !Number.isInteger(value)) {
      warnings.push(`settings file: "${key}" must be a positive integer, ignored`);
      continue;
    }
    values[envName] = String(value);
  }
  return { values, warnings };
}

// Discard any legacy REVIEWLOOP_<KEY> env vars for managed keys (with one
// warning each), then populate `env` from `filePath`. Mutates and returns `env`.
export function applySettingsFile(
  env = process.env,
  { filePath = resolveSettingsFilePath(env), warn = (m) => process.stderr.write(`[reviewloop] ${m}\n`) } = {},
) {
  for (const envName of Object.values(MANAGED_SETTINGS_KEYS)) {
    if (Object.hasOwn(env, envName)) {
      if (env[envName] != null && String(env[envName]) !== '') {
        warn(`legacy env ${envName} ignored; ReviewLoop settings file is the only source — remove it from the client config`);
      }
      delete env[envName];
    }
  }
  const { values, warnings } = readSettingsFile(filePath);
  for (const w of warnings) warn(w);
  for (const [name, value] of Object.entries(values)) {
    env[name] = value;
  }
  return env;
}

// Write a temporary settings file merging `reviewloop.settings.json` with
// `overrides`, set REVIEWLOOP_SETTINGS_FILE on a shallow copy of `env`, and
// apply it. Used by live-certification scripts instead of legacy REVIEWLOOP_MAX_*
// env vars.
export function applySettingsOverridesToEnv(env, overrides, { dir = os.tmpdir() } = {}) {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(DEFAULT_SETTINGS_FILE, 'utf8'));
  } catch {
    base = {};
  }
  const merged = { ...base, ...overrides };
  const filePath = path.join(dir, `reviewloop-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
  const nextEnv = { ...env, [SETTINGS_FILE_ENV]: filePath };
  applySettingsFile(nextEnv, { filePath, warn: () => {} });
  return { env: nextEnv, filePath };
}
