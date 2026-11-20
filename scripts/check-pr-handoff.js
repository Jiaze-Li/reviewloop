#!/usr/bin/env node
// Read-only PR handoff check (Design RL-STATUS-HANDOFF-01). Uses only
// `gh pr view --json headRefOid,body`; never writes GitHub, never calls a
// Reviewer. A pass means "description matches HEAD", NOT review PASS / READY.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  recoverPrContract,
  runFinalPrGateReport,
} from '../src/reviewloop/prContract.js';

const STAGES = ['plan', 'design', 'code'];
const MARKER = /<!--\s*reviewloop-handoff\s+head=([0-9a-fA-F]{40})\s+stage=(\w+)\s+loop=(\S+)\s*-->/;
// A section counts only when its name opens a line (optionally after #, ** or
// a list dash) outside fenced code, so words like "unverified" or a stray
// "risk" inside prose or the marker comment do not satisfy it.
const SECTIONS = [
  ['做了什么', ['做了什么', 'built']],
  ['验收清单', ['验收清单', 'acceptance']],
  ['已验证', ['已验证', 'verified']],
  ['风险', ['风险', 'risks?']],
];

function hasSection(text, names) {
  const body = text.replace(/```[\s\S]*?```/g, '');
  const alt = names.join('|');
  return new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]*|[-*][ \\t]+)?(?:\\*\\*|__)?[ \\t]*(?:${alt})(?![A-Za-z])`, 'im').test(body);
}

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
  for (const [name, names] of SECTIONS) {
    if (!hasSection(text, names)) problems.push(`缺少「${name}」部分`);
  }
  return problems;
}

function flagValue(args, name) {
  const eq = args.find((x) => x.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function flagValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1));
    else if (args[i] === name && i + 1 < args.length) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function inferRepoSlug() {
  try {
    const raw = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' });
    return JSON.parse(raw)?.nameWithOwner ?? null;
  } catch {
    return null;
  }
}

export async function runExtendedChecks(argv, ghRead = defaultGh, deps = {}) {
  const base = run(argv.filter((a) => !a.startsWith('--check-') && a !== '--json'), ghRead);
  // Note: base `run` handles `--stage` + PR view. If base failed on usage or gh, stop early.
  if (base.code !== 0) return base;

  const args = argv.slice(1);
  const checkContract = args.includes('--check-contract');
  const checkDiff = args.includes('--check-diff');
  const repo = flagValue(args, '--repo') || deps.repo || inferRepoSlug();
  if (!repo) {
    return { code: 2, out: '无法核实：缺少 --repo <owner/name> 且无法从 gh repo view 自动识别' };
  }
  const pr = argv[0];
  const lines = [base.out];
  let failed = false;

  if (checkContract) {
    const taskId = flagValue(args, '--task-id');
    const type = flagValue(args, '--type') || 'design';
    const expectedDesignSha256 = flagValue(args, '--design-sha');
    if (!taskId) {
      return { code: 2, out: '用法: --check-contract 需配合 --task-id <id> [--type plan|design|exception] [--design-sha <sha>]' };
    }
    try {
      const recovered = await recoverPrContract({
        repo,
        prNumber: Number(pr),
        taskId,
        type,
        expectedDesignSha256,
        runGh: deps.runGh,
      });
      lines.push(`合同核验 PASS (${recovered.type} ${recovered.version}, sha256=${recovered.sha256})`);
      for (const w of recovered.warnings) lines.push(`警告: ${w}`);
    } catch (err) {
      failed = true;
      lines.push(`合同核验 FAIL: ${err?.message ?? err}`);
    }
  }

  if (checkDiff) {
    const cwd = flagValue(args, '--cwd') || process.cwd();
    const baseRef = flagValue(args, '--base');
    const approvedAssets = flagValues(args, '--approved-asset');
    const report = await runFinalPrGateReport({
      cwd,
      repo,
      prNumber: Number(pr),
      baseRef,
      approvedAssets,
      runGh: deps.runGh,
      runGit: deps.runGit,
    });
    if (report.localCheck.status !== 'PASS') failed = true;
    lines.push(`localCheck: ${report.localCheck.status}${report.localCheck.errors.length ? ` (${report.localCheck.errors.join('; ')})` : ''}`);
    lines.push(`remoteProtection: ${report.remoteProtection.status} (${report.remoteProtection.detail})`);
    lines.push(`prBotStatus: ${report.prBotStatus.status} (${report.prBotStatus.detail})`);
  }

  return { code: failed ? 1 : 0, out: lines.join('\n') };
}

export function run(argv, ghRead = defaultGh) {
  const args = argv.slice();
  const pr = args.shift();
  let stage;
  const i = args.indexOf('--stage');
  // A present-but-valueless --stage must fail, never silently skip the check.
  const stageGiven = i >= 0;
  if (stageGiven) stage = args[i + 1];
  if (!pr || !/^\d+$/.test(pr) || (stageGiven && !STAGES.includes(stage))) {
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
  const argv = process.argv.slice(2);
  const useExtended = argv.includes('--check-contract') || argv.includes('--check-diff');
  const { code, out } = useExtended ? await runExtendedChecks(argv) : run(argv);
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
