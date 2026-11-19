// `reviewloop spec <stage>`: print the engineering method files a stage must
// read, plus the policy_ref (reviewloop@<sha>) that pins them. The stage ->
// files table lives once, in engineering/README.md, and is parsed from there.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const STAGE_HEADING = '## 阶段必读文件';

export class SpecError extends Error {}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function parseStageTable(readmeText) {
  const start = readmeText.indexOf(STAGE_HEADING);
  if (start < 0) throw new SpecError('engineering/README.md has no stage table');
  const stages = {};
  for (const line of readmeText.slice(start).split('\n').slice(1)) {
    if (/^## /.test(line)) break;
    const m = /^\|\s*([a-z]+)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    stages[m[1]] = m[2].split(',').map((f) => f.trim()).filter(Boolean);
  }
  if (Object.keys(stages).length === 0) throw new SpecError('engineering/README.md stage table is empty');
  return stages;
}

export function readSpec({ repoRoot, stage, at = null, allowDirty = false }) {
  let sha;
  let readFile;
  if (at) {
    if (!SHA_RE.test(at)) throw new SpecError(`--at needs a full 40-character lowercase commit SHA, got "${at}"`);
    try { git(repoRoot, ['cat-file', '-e', `${at}^{commit}`]); }
    catch { throw new SpecError(`commit ${at} not found in this checkout; if this is a legacy personal-skills SHA, read it from Jiaze-Li/personal-skills at that SHA instead of here`); }
    sha = at;
    readFile = (f) => git(repoRoot, ['show', `${sha}:engineering/${f}`]);
    try { readFile('README.md'); }
    catch { throw new SpecError(`SHA ${at} predates the unified engineering/ directory; read it from Jiaze-Li/personal-skills at that SHA (legacy task), not from here`); }
  } else {
    sha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
    const dirty = git(repoRoot, ['status', '--porcelain', '--', 'engineering']).trim();
    if (dirty && !allowDirty) {
      throw new SpecError(`engineering/ has uncommitted changes, so reviewloop@${sha.slice(0, 7)} would not reproduce what you read; commit them or pass --allow-dirty (self-test only):\n${dirty}`);
    }
    readFile = (f) => readFileSync(path.join(repoRoot, 'engineering', f), 'utf8');
  }
  const stages = parseStageTable(readFile('README.md'));
  const files = stages[stage];
  if (!files) throw new SpecError(`unknown stage "${stage}"; expected one of: ${Object.keys(stages).join(', ')}`);
  return { policyRef: `reviewloop@${sha}`, stage, files: files.map((f) => ({ path: `engineering/${f}`, content: readFile(f) })) };
}

export function formatSpec(spec) {
  const out = [`policy_ref=${spec.policyRef}`, `stage=${spec.stage}`, `files=${spec.files.map((f) => f.path).join(',')}`];
  for (const f of spec.files) out.push('', `===== ${f.path} =====`, f.content.trimEnd());
  return out.join('\n');
}
