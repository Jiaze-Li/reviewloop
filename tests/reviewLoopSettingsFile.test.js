import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applySettingsFile, readSettingsFile, resolveSettingsFilePath, DEFAULT_SETTINGS_FILE, SETTINGS_FILE_ENV,
} from '../src/reviewloop/settingsFile.js';
import { resolveReviewLoopLimits } from '../src/reviewloop/reviewSpend.js';

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

test('file value is applied as default and flows through the limit resolver', () => {
  const env = {};
  const w = apply(env, tmpFile('{"MAX_SINGLE_CALL_USAGE": 55000, "MAX_COST_USD": 7}'));
  assert.deepEqual(w, []);
  const l = resolveReviewLoopLimits(env);
  assert.equal(l.maxSingleCallUsage, 55000);
  assert.equal(l.maxCostUsd, 7);
});

test('explicit env wins over the file', () => {
  const env = { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '90000' };
  apply(env, tmpFile('{"MAX_SINGLE_CALL_USAGE": 55000}'));
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 90000);
});

test('missing file is silent and leaves code defaults', () => {
  const env = {};
  const w = apply(env, path.join(os.tmpdir(), 'rl-does-not-exist.json'));
  assert.deepEqual(w, []);
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 40000);
});

test('malformed JSON / non-object is ignored with a warning, never throws', () => {
  for (const content of ['{nope', '[1,2]', 'null', '"x"']) {
    const env = {};
    const w = apply(env, tmpFile(content));
    assert.equal(w.length, 1, content);
    assert.deepEqual(env, {});
  }
});

test('unknown key and illegal values are ignored with warnings', () => {
  const env = {};
  const w = apply(env, tmpFile(JSON.stringify({
    BOGUS: 1, MAX_SINGLE_CALL_USAGE: '50000', MAX_COST_USD: -1, MAX_USAGE_VOLUME: 0, MAX_REVIEW_ROUNDS: null,
  })));
  assert.equal(w.length, 5);
  assert.deepEqual(env, {});
});

test('file value above the hard cap is still clamped by the resolver', () => {
  const env = {};
  apply(env, tmpFile('{"MAX_SINGLE_CALL_USAGE": 99999999}'));
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 250000);
});

test('settings path override via REVIEWLOOP_SETTINGS_FILE', () => {
  assert.equal(resolveSettingsFilePath({ [SETTINGS_FILE_ENV]: '/x/y.json' }), '/x/y.json');
  assert.equal(resolveSettingsFilePath({}), DEFAULT_SETTINGS_FILE);
});

test('shipped settings file parses cleanly and sets the single-call limit to 50000', () => {
  const { values, warnings } = readSettingsFile(DEFAULT_SETTINGS_FILE);
  assert.deepEqual(warnings, []);
  assert.deepEqual(values, { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '50000' });
  const env = {};
  applySettingsFile(env, { filePath: DEFAULT_SETTINGS_FILE });
  assert.equal(resolveReviewLoopLimits(env).maxSingleCallUsage, 50000);
});

test('inherited object names ("constructor", "toString", "__proto__") are unknown keys, not whitelisted', () => {
  const env = {};
  const w = apply(env, tmpFile('{"constructor": 1, "toString": 2, "hasOwnProperty": 3, "__proto__": {"x": 1}}'));
  assert.equal(w.length, 4);
  assert.ok(w.every((m) => /unknown key/.test(m)), JSON.stringify(w));
  assert.deepEqual(env, {});
});
