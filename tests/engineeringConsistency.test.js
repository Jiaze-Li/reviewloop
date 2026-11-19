import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEngineeringConsistency } from '../scripts/check-engineering-consistency.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rl-eng-'));
  for (const d of ['engineering', 'docs', 'agent-policy', 'src', 'bin', 'scripts']) cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  return dir;
}

test('real repository engineering docs are consistent', () => {
  const res = checkEngineeringConsistency({ root: REPO });
  assert.deepEqual(res.issues, []);
});

test('V3: injected removed task type is detected', () => {
  const dir = fixture();
  try {
    const p = path.join(dir, 'engineering', 'lead.md');
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n用 \`reviewloop_begin\` 的 taskType: "pr" 启动。\n`);
    const res = checkEngineeringConsistency({ root: dir });
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => /taskType=pr/.test(i)), res.issues.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V3: nonexistent state name and identifier are detected', () => {
  const dir = fixture();
  try {
    const p = path.join(dir, 'engineering', 'reviewer.md');
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n状态 \`TOTALLY_FAKE_STATE\` 与参数 \`noSuchParamName\`。\n`);
    const res = checkEngineeringConsistency({ root: dir });
    assert.ok(res.issues.some((i) => /TOTALLY_FAKE_STATE/.test(i)));
    assert.ok(res.issues.some((i) => /noSuchParamName/.test(i)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale personal-skills reference, broken link, missing stage file and version skew are detected', () => {
  const dir = fixture();
  try {
    const arch = path.join(dir, 'engineering', 'architect.md');
    writeFileSync(arch, readFileSync(arch, 'utf8').replace(/v\d+\.\d+\.\d+/, 'v0.0.1') + '\n读取 personal-skills 的 engineering-architect。[x](nope.md)\n');
    const readme = path.join(dir, 'engineering', 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8').replace('| pr | README.md |', '| pr | README.md, ghost.md |'));
    const res = checkEngineeringConsistency({ root: dir });
    const all = res.issues.join('\n');
    assert.match(all, /current reference to personal-skills/);
    assert.match(all, /broken link nope\.md/);
    assert.match(all, /missing file ghost\.md/);
    assert.match(all, /title version differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V13: COMMON and README must reference docs/BOUNDARY.md', () => {
  const dir = fixture();
  try {
    const p = path.join(dir, 'agent-policy', 'COMMON.md');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('docs/BOUNDARY.md', 'docs/X.md'));
    assert.match(checkEngineeringConsistency({ root: dir }).issues.join('\n'), /COMMON\.md does not reference docs\/BOUNDARY\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor runs the engineering consistency check and fails on drift', async () => {
  const { runDoctor, checkEngineering } = await import('../scripts/doctor.js');
  const lines = [];
  runDoctor({ log: (l) => lines.push(l), execSync: () => 'ok', env: {} });
  assert.ok(lines.some((l) => /ok\s+engineering_consistency/.test(l)), lines.join('\n'));
  assert.equal(checkEngineering().ok, true);
});

test('doctor reports ok=false and prints FAIL when the engineering check finds drift', async () => {
  const { runDoctor } = await import('../scripts/doctor.js');
  const lines = [];
  const report = runDoctor({
    log: (l) => lines.push(l), execSync: () => 'ok', env: {},
    engineeringCheck: () => ({ ok: false, issues: ['simulated drift'] }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.results.engineering_consistency.ok, false);
  assert.ok(lines.some((l) => /FAIL\s+engineering_consistency: simulated drift/.test(l)));
});
