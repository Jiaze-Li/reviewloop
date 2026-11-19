// Consistency check between engineering/ method docs, Worker policy
// (agent-policy/COMMON.md) and the code they describe. Zero model calls.
//   node scripts/check-engineering-consistency.js [--root <dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Doc-only vocabulary that is not a runtime literal.
const DOC_ONLY_TOKENS = new Set([
  'LEGACY_POLICY_UNKNOWN', 'NOT_ENFORCED', 'NOT_RUN', 'STATIC', 'AUTOMATED', 'REAL',
  'AUDIT_PENDING', 'PARTIAL', 'READY', 'PASS', 'FAIL', 'BLOCKED',
]);
const REMOVED_PATTERNS = [
  [/taskType\s*[:=]\s*["'`]?pr\b/i, 'removed task type taskType=pr'],
  [/\bprContext\b/, 'removed field prContext'],
  [/\bpr-(watch|push|trigger|bind-agent|stop)\b/, 'removed PR task CLI'],
];
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(js|md)$/.test(name)) out.push(p);
  }
  return out;
}

export function checkEngineeringConsistency({ root = DEFAULT_ROOT } = {}) {
  const issues = [];
  const engDir = path.join(root, 'engineering');
  const read = (p) => readFileSync(p, 'utf8');
  if (!existsSync(path.join(engDir, 'README.md'))) {
    return { ok: false, issues: ['engineering/README.md missing'] };
  }
  const docs = readdirSync(engDir).filter((f) => f.endsWith('.md')).sort();
  const commonPath = path.join(root, 'agent-policy', 'COMMON.md');
  const texts = Object.fromEntries(docs.map((f) => [`engineering/${f}`, read(path.join(engDir, f))]));
  if (existsSync(commonPath)) texts['agent-policy/COMMON.md'] = read(commonPath);

  const codeText = ['src', 'bin', 'scripts']
    .flatMap((d) => walk(path.join(root, d)))
    .filter((p) => !p.endsWith('check-engineering-consistency.js'))
    .map(read).join('\n');

  for (const [file, text] of Object.entries(texts)) {
    // 1. identifiers named in backticks must exist in code (or be doc-only vocabulary)
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim();
      if (/^[A-Z]+(_[A-Z]+)+$/.test(tok) || /^(REWORK|PASS)$/.test(tok)) {
        if (!DOC_ONLY_TOKENS.has(tok) && !codeText.includes(`'${tok}'`) && !codeText.includes(`"${tok}"`) && !codeText.includes(`${tok}:`)) {
          issues.push(`${file}: state name \`${tok}\` not found in code`);
        }
      } else if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(tok) && !/\./.test(tok)) {
        if (!new RegExp(`\\b${tok}\\b`).test(codeText)) issues.push(`${file}: identifier \`${tok}\` not found in code`);
      }
    }
    // 2. removed vocabulary and stale personal-skills references
    for (const [re, label] of REMOVED_PATTERNS) {
      if (re.test(text)) issues.push(`${file}: contains ${label}`);
    }
    text.split('\n').forEach((line, i) => {
      if (/personal-skills/.test(line) && !/(旧|legacy|裸|Legacy)/.test(line)) {
        issues.push(`${file}:${i + 1}: current reference to personal-skills (only legacy-task mentions are allowed)`);
      }
    });
    // 3. relative links resolve
    if (file.startsWith('engineering/')) {
      for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/.test(target)) continue;
        if (!existsSync(path.resolve(engDir, target))) issues.push(`${file}: broken link ${target}`);
      }
    }
  }

  // stage table
  const readme = texts['engineering/README.md'];
  const tableStart = readme.indexOf('## 阶段必读文件');
  if (tableStart < 0) issues.push('engineering/README.md: stage table missing');
  else {
    for (const m of readme.slice(tableStart).split('\n').slice(1).join('\n').split(/\n## /)[0].matchAll(/^\|\s*[a-z]+\s*\|\s*([^|]+?)\s*\|$/gm)) {
      for (const f of m[1].split(',').map((s) => s.trim())) {
        if (!existsSync(path.join(engDir, f))) issues.push(`engineering/README.md: stage table lists missing file ${f}`);
      }
    }
  }
  // boundary doc referenced and present
  if (!existsSync(path.join(root, 'docs', 'BOUNDARY.md'))) issues.push('docs/BOUNDARY.md missing');
  if (!/docs\/BOUNDARY\.md/.test(readme)) issues.push('engineering/README.md does not reference docs/BOUNDARY.md');
  if (texts['agent-policy/COMMON.md'] && !/docs\/BOUNDARY\.md/.test(texts['agent-policy/COMMON.md'])) {
    issues.push('agent-policy/COMMON.md does not reference docs/BOUNDARY.md');
  }
  // 4. one version across engineering docs
  const vm = /^#[^\n]*?v(\d+\.\d+\.\d+)/m.exec(readme);
  if (!vm) issues.push('engineering/README.md: no version in title');
  else {
    for (const f of docs) {
      const head = /^#[^\n]*/m.exec(texts[`engineering/${f}`])?.[0] ?? '';
      if (!head.includes(`v${vm[1]}`)) issues.push(`engineering/${f}: title version differs from README v${vm[1]}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const res = checkEngineeringConsistency({ root: i >= 0 ? path.resolve(process.argv[i + 1]) : DEFAULT_ROOT });
  if (res.ok) console.log('engineering consistency: ok');
  else { for (const s of res.issues) console.error(`FAIL  ${s}`); process.exit(1); }
}
