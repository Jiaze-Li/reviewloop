import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSpec, parseStageTable, SpecError } from '../src/reviewloop/engineeringSpec.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function tempRepo({ withEngineering = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rl-spec-'));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'init');
  const pre = g(dir, 'rev-parse', 'HEAD');
  if (withEngineering) {
    cpSync(path.join(REPO, 'engineering'), path.join(dir, 'engineering'), { recursive: true });
    g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'engineering');
  }
  return { dir, pre, head: g(dir, 'rev-parse', 'HEAD') };
}

test('V1: every stage prints exactly the files in the README stage table', () => {
  const { dir, head } = tempRepo();
  try {
    const table = parseStageTable(readFileSync(path.join(REPO, 'engineering', 'README.md'), 'utf8'));
    assert.deepEqual(Object.keys(table).sort(), ['code', 'design', 'plan', 'pr', 'review']);
    for (const [stage, files] of Object.entries(table)) {
      const spec = readSpec({ repoRoot: dir, stage });
      assert.equal(spec.policyRef, `reviewloop@${head}`);
      assert.deepEqual(spec.files.map((f) => f.path), files.map((f) => `engineering/${f}`));
      assert.ok(files.includes('authorization.md'), `stage ${stage} must include authorization.md`);
      assert.ok(spec.files.every((f) => f.content.length > 0));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V4: dirty engineering/ fails unless --allow-dirty; clean passes', () => {
  const { dir } = tempRepo();
  try {
    writeFileSync(path.join(dir, 'engineering', 'lead.md'), 'edited');
    assert.throws(() => readSpec({ repoRoot: dir, stage: 'plan' }), (e) => e instanceof SpecError && /uncommitted/.test(e.message));
    assert.ok(readSpec({ repoRoot: dir, stage: 'plan', allowDirty: true }).files.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V5: --at a pre-unification SHA refuses with a personal-skills pointer; unknown stage/bad sha refuse', () => {
  const { dir, pre, head } = tempRepo();
  try {
    assert.throws(() => readSpec({ repoRoot: dir, stage: 'plan', at: pre }), (e) => /predates the unified engineering/.test(e.message) && /personal-skills/.test(e.message));
    assert.throws(() => readSpec({ repoRoot: dir, stage: 'nope', at: head }), /unknown stage/);
    assert.throws(() => readSpec({ repoRoot: dir, stage: 'plan', at: 'abc' }), /40-character/);
    assert.throws(() => readSpec({ repoRoot: dir, stage: 'plan', at: '7164af4f820ea2bd640a69d7d2696128bad63bc3' }), /personal-skills/);
    // --at reads the frozen commit, not later working-tree edits
    writeFileSync(path.join(dir, 'engineering', 'lead.md'), 'later edit');
    const frozen = readSpec({ repoRoot: dir, stage: 'plan', at: head });
    assert.notEqual(frozen.files.find((f) => f.path === 'engineering/lead.md').content, 'later edit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: exits non-zero with a message for unknown stage and prints policy_ref for a known one', () => {
  const bad = spawnSync('node', ['bin/reviewloop.js', 'spec', 'nope', '--allow-dirty'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown stage/);
  const ok = spawnSync('node', ['bin/reviewloop.js', 'spec', 'code', '--allow-dirty'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^policy_ref=reviewloop@[0-9a-f]{40}/);
});
