// V7/V10: managed-policy install -> revert -> reinstall, with non-managed bytes preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync as realExec } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, extractManagedPolicy } from '../bin/install-plugin.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_COMMON = path.join(REPO, 'agent-policy', 'COMMON.md');
const BASELINE = '721ff873d1d07368b04f295d29f65e9510cb44ba';

const fakeExec = (command, args = []) => {
  if (args[0] === '--version') return `${command} test\n`;
  if (args[0] === 'mcp') return 'ok\n';
  throw new Error(`unexpected ${command} ${args.join(' ')}`);
};

function baselineCommonOrNull() {
  try { return realExec('git', ['show', `${BASELINE}:agent-policy/COMMON.md`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

test('V10: install new policy, revert to the baseline policy, reinstall — managed block follows, user bytes never change', async (t) => {
  const oldCommon = baselineCommonOrNull();
  if (!oldCommon) { t.skip('baseline commit not available in this checkout (shallow clone)'); return; }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rl-rollback-'));
  try {
    const oldFile = path.join(tmp, 'OLD_COMMON.md');
    writeFileSync(oldFile, oldCommon);
    mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md');
    const userBytes = '# my own rules\nnever touch this line\n';
    writeFileSync(claudeMd, userBytes);
    const base = { homeDir: tmp, configDir: path.join(tmp, '.gemini', 'config'), mcpBin: '/x/mcp.js', nodeBin: '/usr/bin/node', execFileSync: fakeExec };

    await installGlobal({ ...base, policyFile: NEW_COMMON });
    const managed = () => extractManagedPolicy(readFileSync(claudeMd, 'utf8'));
    assert.equal(managed(), readFileSync(NEW_COMMON, 'utf8').trim());
    assert.ok(readFileSync(claudeMd, 'utf8').startsWith(userBytes.trimEnd()), 'user content stays in place');

    await installGlobal({ ...base, policyFile: oldFile }); // revert
    assert.equal(managed(), oldCommon.trim());
    assert.match(managed(), /personal-skills/);

    await installGlobal({ ...base, policyFile: NEW_COMMON }); // reinstall
    assert.equal(managed(), readFileSync(NEW_COMMON, 'utf8').trim());
    assert.ok(readFileSync(claudeMd, 'utf8').includes('never touch this line'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
