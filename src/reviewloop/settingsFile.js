// Shared ReviewLoop settings file.
//
// One JSON file inside the ReviewLoop repo (`reviewloop.settings.json`) holds
// the budget/limit parameters, so every MCP client (Claude Code, Antigravity,
// ...) that launches ReviewLoop gets the same values with a single edit.
//
// Precedence: explicit REVIEWLOOP_* environment variable > settings file >
// code default. File values are only *injected as defaults into the env*; they
// then flow through the exact same resolver (num / boundedThreshold, hard caps)
// as an env override, so the file can never disable or inflate a protection.
//
// Fail-safe: a missing file is normal; a malformed file, unknown key or
// illegal value is ignored with a warning and never throws.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWLOOP_ENV } from './reviewSpend.js';

export const SETTINGS_FILE_ENV = 'REVIEWLOOP_SETTINGS_FILE';
export const DEFAULT_SETTINGS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reviewloop.settings.json',
);

// Short keys (as written in the file) -> env var names. Whitelist = limits only.
const ALLOWED_KEYS = Object.freeze({ ...REVIEWLOOP_ENV });

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
    const envName = Object.hasOwn(ALLOWED_KEYS, key) ? ALLOWED_KEYS[key] : null;
    if (!envName) {
      warnings.push(`settings file: unknown key "${key}" ignored`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      warnings.push(`settings file: "${key}" must be a positive number, ignored`);
      continue;
    }
    values[envName] = String(value);
  }
  return { values, warnings };
}

// Inject file values into `env` ONLY for names the env does not already set
// (env wins). Mutates and returns `env`. Warnings go to `warn`.
export function applySettingsFile(env = process.env, { filePath = resolveSettingsFilePath(env), warn = (m) => process.stderr.write(`[reviewloop] ${m}\n`) } = {}) {
  const { values, warnings } = readSettingsFile(filePath);
  for (const w of warnings) warn(w);
  for (const [name, value] of Object.entries(values)) {
    if (env[name] == null || env[name] === '') env[name] = value;
  }
  return env;
}
