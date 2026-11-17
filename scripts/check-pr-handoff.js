#!/usr/bin/env node
// Read-only PR handoff check (Design RL-STATUS-HANDOFF-01). Uses only
// `gh pr view --json headRefOid,body`; never writes GitHub, never calls a
// Reviewer. A pass means "description matches HEAD", NOT review PASS / READY.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STAGES = ['plan', 'design', 'code'];
const MARKER = /<!--\s*reviewloop-handoff\s+head=([0-9a-fA-F]{40})\s+stage=(\w+)\s+loop=(\S+)\s*-->/;
const SECTIONS = [
  ['做了什么', /做了什么|built/i],
  ['验收清单', /验收清单|acceptance/i],
  ['已验证', /已验证|verified/i],
  ['风险', /风险|risk/i],
];

export function checkHandoff({ headRefOid, body }, { stage } = {}) {
  const problems = [];
  const text = typeof body === 'string' ? body : '';
  const m = MARKER.exec(text);
  if (!m) {
    problems.push('PR 描述缺少 reviewloop-handoff 标记');
  } else {
    if (m[1].toLowerCase() !== String(headRefOid ?? '').toLowerCase()) {
      problems.push(`标记的提交 ${m[1].slice(0, 7)} 不是 PR 当前 HEAD ${String(headRefOid).slice(0, 7)}`);
    }
    if (stage && m[2] !== stage) problems.push(`标记阶段 ${m[2]} 与要求的 ${stage} 不符`);
  }
  for (const [name, re] of SECTIONS) {
    if (!re.test(text)) problems.push(`缺少「${name}」部分`);
  }
  return problems;
}

export function run(argv, ghRead = defaultGh) {
  const args = argv.slice();
  const pr = args.shift();
  let stage;
  const i = args.indexOf('--stage');
  if (i >= 0) stage = args[i + 1];
  if (!pr || !/^\d+$/.test(pr) || (stage !== undefined && !STAGES.includes(stage))) {
    return { code: 2, out: '用法: check-pr-handoff.js <PR号> [--stage plan|design|code]' };
  }
  let data;
  try {
    data = ghRead(pr);
    if (!data || typeof data !== 'object') throw new Error('empty');
  } catch {
    return { code: 3, out: '无法核实：读取 PR 失败（gh 不可用或无权限）' };
  }
  const problems = checkHandoff(data, { stage });
  if (problems.length) return { code: 1, out: `交接未完成：${problems.join('；')}` };
  return { code: 0, out: '交接核对通过（只代表描述与 HEAD 一致，不代表审查 PASS / bot READY）' };
}

function defaultGh(pr) {
  return JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'headRefOid,body'], { encoding: 'utf8' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
