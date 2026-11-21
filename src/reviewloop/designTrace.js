// Minimal PR trace of the Design review process (Design RL-DESIGN-PR-TRACE-20261121 v1.1).
//
// Two record kinds live in PR comments, in their OWN marker namespaces so the
// formal contract tooling in prContract.js never recognises them:
//   reviewloop-draft:<task>:<ver>[:part=i/n]   full, UNREVIEWED Design text
//   reviewloop-review:<task>:<ver>[:part=i/n]   one review milestone / failure / external report
// The comments are the evidence; the PR-description progress block is a
// derived view that can always be rebuilt from them. Nothing here writes to
// GitHub: the Worker posts with `gh`, this module only formats, scans,
// verifies and renders. It never produces a PASS, an exception or a Code
// authorization.

import {
  PR_CONTRACT_COMMENT_MAX_CHARS,
  PR_CONTRACT_DESIGN_MAX_BYTES,
  PrContractError,
  contractContentSha256,
  defaultRunGh,
  parseContractIndex,
  splitContractText,
} from './prContract.js';

export const TRACE_KINDS = ['draft', 'review'];
export const TRACE_BLOCK_BEGIN = '<!-- reviewloop-trace:begin -->';
export const TRACE_BLOCK_END = '<!-- reviewloop-trace:end -->';
const KIND_TITLE = { draft: '设计草稿', review: '审查记录' };
const DRAFT_BANNER = 'UNREVIEWED · NOT DESIGN PASS';
const REVIEW_BANNER = '过程记录 · 非授权 · 非 Design PASS';
const SHA_RE = /^[0-9a-f]{64}$/;
const BEGIN_RE = /<!--\s*reviewloop-(draft|review):([^:\s]+):([^:\s]+?)(?::part=(\d+)\/(\d+))?:begin\s*-->/;

function fail(code, message, details) {
  throw new PrContractError(code, message, details);
}

// ---------------------------------------------------------------- scanning

const SENSITIVE_PATTERNS = [
  ['credential', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  ['credential', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['credential', /\bAKIA[0-9A-Z]{16}\b/],
  ['credential', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential', /\bAuthorization:\s*(?:Bearer|Basic)\s+\S{8,}/i],
  ['credential', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i],
  ['local-path', /\/Users\/[A-Za-z0-9._-]+\//],
  ['local-path', /\/home\/[A-Za-z0-9._-]+\//],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];

/** Conservative, heuristic scan. A clean result is NOT a proof of public safety. */
export function scanSensitive(text) {
  const hits = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [kind, re] of SENSITIVE_PATTERNS) {
      if (re.test(line)) hits.push({ kind, line: i + 1 });
    }
  });
  return hits;
}

function assertPublicSafe(text, what) {
  const hits = scanSensitive(text);
  if (hits.length) {
    fail(
      'TRACE_SENSITIVE_CONTENT',
      `${what} contains possible sensitive content (${hits.map((h) => `${h.kind}@line${h.line}`).join(', ')}); `
      + 'redact it or ask the user to decide — there is no bypass flag',
      { hits },
    );
  }
}

// -------------------------------------------------------------- versioning

export function versionKey(version) {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(String(version ?? ''));
  return m ? m[1].split('.').map(Number) : [];
}
export function compareVersions(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// -------------------------------------------------------------- formatting

function req(value, field) {
  const v = String(value ?? '').trim();
  if (!v) fail('TRACE_INVALID_ARG', `${field} is required`);
  return v;
}

function wrap({ kind, taskId, version, content, header, trailerLabel, maxCharsPerPart, onlyParts = null }) {
  const trimmed = content.trim();
  const sha256 = contractContentSha256(trimmed);
  const chunks = splitContractText(trimmed, maxCharsPerPart);
  const total = chunks.length;
  const banner = kind === 'draft' ? DRAFT_BANNER : REVIEW_BANNER;
  const comments = chunks.map((chunk, idx) => {
    const part = idx + 1;
    const tag = total > 1 ? `:part=${part}/${total}` : '';
    const partLabel = total > 1 ? ` · 分段 ${part}/${total}` : '';
    const lines = [
      `**${taskId} · ${KIND_TITLE[kind]} ${version}${partLabel} · ${banner}**`,
      '',
      ...header.map((l) => `> ${l}`),
      '',
      `<!-- reviewloop-${kind}:${taskId}:${version}${tag}:begin -->`,
      '<details>',
      `<summary>展开${KIND_TITLE[kind]} ${version} 全文${partLabel}</summary>`,
      '',
      chunk,
      '',
      '</details>',
      `<!-- reviewloop-${kind}:${taskId}:${version}${tag}:end -->`,
    ];
    if (part === total) lines.push('', `${trailerLabel}: ${sha256}`);
    return { part, total, body: lines.join('\n') };
  });
  return {
    kind, taskId, version, sha256, totalParts: total,
    comments: onlyParts ? comments.filter((c) => onlyParts.includes(c.part)) : comments,
  };
}

/** Full Design text as an UNREVIEWED draft snapshot. Hash = designSha256 algorithm. */
export function formatDraft({
  taskId, version, content, policySha, planVersion, planSha256, baseline = null,
  changeNote = null, findingResponses = null, onlyParts = null,
  maxCharsPerPart = PR_CONTRACT_COMMENT_MAX_CHARS,
}) {
  const id = req(taskId, 'taskId');
  const ver = req(version, 'version');
  if (typeof content !== 'string' || !content.trim()) fail('TRACE_INVALID_ARG', 'draft content must be non-empty');
  if (Buffer.byteLength(content.trim(), 'utf8') > PR_CONTRACT_DESIGN_MAX_BYTES) {
    fail('PR_CONTRACT_SIZE_EXCEEDED', 'draft exceeds the 64 KiB Design limit');
  }
  assertPublicSafe(content, 'draft');
  const header = [
    '未经独立审查的设计草稿快照；不是 Design PASS、不是人工例外，也不授权进入 Code。',
    `policy_sha: ${req(policySha, 'policySha')} · Plan ${req(planVersion, 'planVersion')} (sha256 ${req(planSha256, 'planSha256')})`,
    ...(baseline ? [`核查基线：${baseline}`] : []),
    ...(changeNote ? [`变更说明：${changeNote}`] : []),
    ...(findingResponses ? ['对上一轮 finding 的处理（Worker 声明，未经审查确认）：', ...findingResponses.map((r) => `- ${r}`)] : []),
  ];
  header.forEach((l) => assertPublicSafe(l, 'draft header'));
  return wrap({
    kind: 'draft', taskId: id, version: ver, content, header,
    trailerLabel: 'draftSha256 (UNREVIEWED; content integrity only, not PASS)', maxCharsPerPart, onlyParts,
  });
}

function findingLine(f) {
  const sev = f?.severity ?? '?';
  const rule = f?.rule ? ` [${f.rule}]` : '';
  const detail = f?.detail ? `\n  ${String(f.detail).replace(/\n/g, '\n  ')}` : '';
  return `- ${sev}: ${f?.title ?? '(无标题)'}${rule}${detail}`;
}

const REVIEW_STATUSES = new Set(['PASS', 'REWORK', 'HUMAN_REQUIRED', 'NO_PROGRESS', 'WAITING_FOR_REVIEW', 'NO_RESULT']);

/**
 * One review milestone. `result` is the raw reviewloop_review result (or null
 * for "no usable result"). `adjudicatedDesignSha256` is taken ONLY from the
 * tool result, never recomputed by the Worker: without it the record is
 * explicitly "not bound" and proves nothing about any version.
 */
export function formatReview({
  taskId, designVersion, round, result = null, errorNote = null, maxCharsPerPart = PR_CONTRACT_COMMENT_MAX_CHARS,
  external = null, version = null,
}) {
  const id = req(taskId, 'taskId');
  const dv = req(designVersion, 'designVersion');
  let meta;
  const body = [];
  if (external) {
    meta = {
      source: 'EXTERNAL_REPORT',
      designVersion: dv,
      reviewer: req(external.reviewer, 'reviewer'),
      independence: `转贴者声明：${req(external.independence, 'independence')}（系统未验证）`,
      conclusion: req(external.conclusion, 'conclusion'),
      reviewedDesignSha256: external.reviewedDesignSha256 ?? null,
      relayedBy: req(external.relayedBy, 'relayedBy'),
    };
    if (meta.reviewedDesignSha256 && !SHA_RE.test(meta.reviewedDesignSha256)) {
      fail('TRACE_INVALID_ARG', 'external reviewedDesignSha256 must be 64 hex chars');
    }
    body.push(
      `# 外部独立审查报告（转贴）· ${dv}`, '',
      `审查者：${meta.reviewer}`, meta.independence, `结论：${meta.conclusion}`,
      '本记录不改变 ReviewLoop 状态，不构成 Design PASS、人工例外或 Code 授权。', '',
      String(external.report ?? '').trim() || '(无正文)',
    );
  } else {
    const status = result?.status ?? 'NO_RESULT';
    if (!REVIEW_STATUSES.has(status)) fail('TRACE_INVALID_ARG', `unsupported review status ${status}`);
    const adj = typeof result?.adjudicatedDesignSha256 === 'string' && SHA_RE.test(result.adjudicatedDesignSha256)
      ? result.adjudicatedDesignSha256 : (status === 'PASS' && SHA_RE.test(result?.designSha256 ?? '') ? result.designSha256 : null);
    meta = {
      source: adj ? 'REVIEWLOOP_ADJUDICATED' : 'REVIEWLOOP_NO_ADJUDICATION',
      designVersion: dv,
      status,
      loopId: result?.loopId ?? null,
      round: Number.isInteger(result?.round) ? result.round : (Number.isInteger(round) ? round : null),
      adjudicatedDesignSha256: adj,
    };
    const blocking = Array.isArray(result?.blockingFindings) ? result.blockingFindings : [];
    body.push(`# ReviewLoop 审查记录 · ${dv} · ${status}`, '');
    if (!adj) {
      body.push(
        '**本记录未绑定任何设计版本的内容哈希：没有可用的独立审查裁决，不能据此认为任何版本已被审查或合格。**',
        errorNote ? `故障说明：${errorNote}` : '',
        result?.reason ? `工具返回原因：${String(result.reason).slice(0, 600)}` : '', '',
      );
    } else {
      body.push(`被审设计哈希（工具返回）：${adj}`, '');
    }
    if (blocking.length) body.push(`阻断问题（完整批次，共 ${blocking.length} 项）：`, ...blocking.map(findingLine), '');
    else if (adj) body.push('阻断问题：无。', '');
    if (Array.isArray(result?.nonBlockingFindings) && result.nonBlockingFindings.length) {
      body.push(`非阻断问题：${result.nonBlockingFindings.length} 项（未逐条列出）`, '');
    }
    if (result?.reviewRecord) body.push(`历史摘要：${result.reviewRecord}`, '');
    if (status === 'PASS') {
      body.push('ReviewLoop 返回 PASS；正式授权与归档仍以合同索引中的 Design 归档、designSha256 锚点和本地核验为准，本记录不是授权。');
    }
  }
  const content = `meta: ${JSON.stringify(meta)}\n\n${body.filter((l) => l !== undefined).join('\n')}`;
  assertPublicSafe(content, 'review record');
  const ver = version ?? `${dv}.${external ? 'x' : 'r'}${meta.round ?? external?.seq ?? 0}`;
  return wrap({
    kind: 'review', taskId: id, version: ver, content,
    header: ['里程碑记录，不是授权；被审哈希只来自工具返回。'],
    trailerLabel: 'reviewSha256 (record integrity only)', maxCharsPerPart,
  });
}

// ----------------------------------------------------------------- parsing

function parseCommentBody(body) {
  const m = BEGIN_RE.exec(String(body ?? ''));
  if (!m) return null;
  const [, kind, taskId, version, partStr, totalStr] = m;
  const part = partStr ? Number(partStr) : 1;
  const total = totalStr ? Number(totalStr) : 1;
  if (!(part >= 1 && total >= 1 && part <= total)) return { error: 'bad part range', kind, taskId, version };
  const tag = partStr ? `:part=${partStr}/${totalStr}` : '';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const endRe = new RegExp(`<!--\\s*reviewloop-${kind}:${esc(taskId)}:${esc(version)}${esc(tag)}:end\\s*-->`);
  const after = body.slice(m.index + m[0].length);
  const e = endRe.exec(after);
  if (!e) return { error: 'missing end marker', kind, taskId, version };
  const region = after.slice(0, e.index);
  const sumClose = region.indexOf('</summary>');
  const lastClose = region.lastIndexOf('</details>');
  if (region.indexOf('<details>') < 0 || sumClose < 0 || lastClose < sumClose) {
    return { error: 'malformed details block', kind, taskId, version };
  }
  let raw = region.slice(sumClose + '</summary>'.length, lastClose);
  raw = raw.replace(/^\r?\n(?:\r?\n)?/, '').replace(/(?:\r?\n)?\r?\n$/, '');
  const trailer = /^(?:draftSha256|reviewSha256)[^:\n]*:\s*([0-9a-f]{64})\s*$/m.exec(after.slice(e.index + e[0].length));
  return { kind, taskId, version, part, total, raw, trailerSha: trailer ? trailer[1] : null };
}

function parseMeta(content) {
  const m = /^meta:\s*(\{.*\})\s*$/m.exec(content);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// -------------------------------------------------------------- inspection

/** Pure: classify a list of PR issue comments into verified trace records. */
export function analyzeComments(comments, { taskId, owner, localDraft = null }) {
  const problems = [];
  const groups = new Map();
  for (const c of comments) {
    const parsed = parseCommentBody(c.body);
    if (!parsed) continue;
    if (parsed.taskId !== taskId) continue;
    const who = c.user?.login ?? c.author ?? null;
    if (parsed.error) { problems.push({ code: 'TRACE_COMMENT_MALFORMED', commentId: String(c.id), message: parsed.error }); continue; }
    if (!who || who.toLowerCase() !== String(owner).toLowerCase()) {
      problems.push({ code: 'TRACE_UNTRUSTED_AUTHOR', commentId: String(c.id), message: `author ${JSON.stringify(who)} is not the repository owner` });
      continue;
    }
    const key = `${parsed.kind}\u0000${parsed.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...parsed, commentId: String(c.id), createdAt: c.created_at ?? null, edited: Boolean(c.updated_at && c.created_at && c.updated_at !== c.created_at) });
  }

  const records = [];
  for (const [, items] of groups) {
    const { kind, version } = items[0];
    const totals = new Set(items.map((i) => i.total));
    if (totals.size !== 1) { problems.push({ code: 'TRACE_CONFLICT', kind, version, message: 'conflicting part totals' }); continue; }
    const total = [...totals][0];
    // Complete candidates: every part 1..total present; duplicates grouped by content.
    const byPart = new Map();
    for (const it of items) {
      if (!byPart.has(it.part)) byPart.set(it.part, []);
      byPart.get(it.part).push(it);
    }
    const missing = [];
    for (let p = 1; p <= total; p += 1) if (!byPart.has(p)) missing.push(p);
    for (const list of byPart.values()) list.sort((a, b) => Number(a.commentId) - Number(b.commentId));
    const canonicalParts = [];
    const dupes = [];
    for (let p = 1; p <= total; p += 1) {
      const list = byPart.get(p);
      if (!list) continue;
      const distinct = new Set(list.map((l) => l.raw.trim()));
      if (distinct.size > 1) { problems.push({ code: 'TRACE_CONFLICT', kind, version, message: `part ${p} has conflicting duplicate contents` }); canonicalParts.length = 0; missing.push(-p); break; }
      canonicalParts.push(list[0]);
      dupes.push(...list.slice(1).map((l) => l.commentId));
    }
    if (missing.length) {
      const real = missing.filter((m) => m > 0);
      if (real.length) problems.push({ code: 'TRACE_PARTIAL', kind, version, missingParts: real, message: `parts ${real.join(',')} of ${total} are missing` });
      records.push({ kind, version, valid: false, reason: missing.some((m) => m < 0) ? 'conflict' : 'partial', missingParts: real });
      continue;
    }
    const content = canonicalParts.map((c) => c.raw).join('').trim();
    const sha256 = contractContentSha256(content);
    const trailerSha = canonicalParts[canonicalParts.length - 1].trailerSha;
    if (!trailerSha || trailerSha !== sha256) {
      problems.push({ code: 'TRACE_HASH_MISMATCH', kind, version, message: `content sha ${sha256} != trailer ${trailerSha ?? 'missing'}` });
      records.push({ kind, version, valid: false, reason: 'hash-mismatch' });
      continue;
    }
    const rec = {
      kind, version, valid: true, sha256, totalParts: total,
      commentIds: canonicalParts.map((c) => c.commentId), duplicateCommentIds: dupes,
      edited: canonicalParts.some((c) => c.edited), content,
      meta: kind === 'review' ? parseMeta(content) : null,
    };
    if (kind === 'review' && !rec.meta) { rec.valid = false; rec.reason = 'no-meta'; problems.push({ code: 'TRACE_COMMENT_MALFORMED', kind, version, message: 'review record has no meta line' }); }
    records.push(rec);
  }

  const drafts = records.filter((r) => r.kind === 'draft' && r.valid).sort((a, b) => compareVersions(a.version, b.version));
  const latestDraft = drafts[drafts.length - 1] ?? null;
  const local = localDraft == null ? null : contractContentSha256(localDraft);
  const localState = local == null ? 'UNKNOWN'
    : drafts.some((d) => d.sha256 === local) ? 'ARCHIVED'
      : records.some((r) => r.kind === 'draft' && !r.valid) ? 'PARTIAL_OR_INVALID' : 'NOT_ARCHIVED';
  return { records, problems, latestDraft, localSha256: local, localState, ok: problems.length === 0 };
}

export async function inspectTrace({ repo, prNumber, taskId, localDraft = null, runGh = defaultRunGh }) {
  const [owner, name] = String(repo ?? '').split('/');
  if (!owner || !name) fail('PR_CONTRACT_INVALID_ARG', 'repo must be owner/name');
  const pr = String(prNumber ?? '').trim();
  if (!/^\d+$/.test(pr)) fail('PR_CONTRACT_INVALID_ARG', `invalid prNumber: ${prNumber}`);
  const raw = await runGh(['api', '--paginate', '--slurp', `repos/${owner}/${name}/issues/${pr}/comments?per_page=100`]);
  const pages = JSON.parse(raw);
  const comments = Array.isArray(pages) ? pages.flat() : [];
  const prRaw = await runGh(['pr', 'view', pr, '--repo', repo, '--json', 'body,headRefOid']);
  const meta = JSON.parse(prRaw);
  const analysis = analyzeComments(comments, { taskId, owner, localDraft });
  let contractRows = [];
  try { contractRows = parseContractIndex(meta.body).filter((r) => r.taskId === taskId); } catch { /* index problems belong to the contract tools */ }
  return { ...analysis, prBody: meta.body ?? '', headRefOid: meta.headRefOid ?? null, contractRows, repo, prNumber: Number(pr) };
}

// ---------------------------------------------------------------- rendering

function link(repo, pr, id) { return `[${id}](https://github.com/${repo}/pull/${pr}#issuecomment-${id})`; }

/** Pure derived view. Never states PASS / authorization on its own authority. */
export function renderProgressBlock(analysis, { repo, prNumber, taskId }) {
  const L = (id) => link(repo, prNumber, id);
  const drafts = analysis.records.filter((r) => r.kind === 'draft' && r.valid).sort((a, b) => compareVersions(a.version, b.version));
  const reviews = analysis.records.filter((r) => r.kind === 'review' && r.valid).sort((a, b) => compareVersions(a.version, b.version));
  const latest = analysis.latestDraft;
  const rows = [];
  const lastReview = reviews[reviews.length - 1] ?? null;
  const contractDesign = (analysis.contractRows ?? []).find((r) => r.type === 'design' && r.status === 'current');
  const contractException = (analysis.contractRows ?? []).find((r) => r.type === 'exception' && r.status === 'current');
  const plan = (analysis.contractRows ?? []).find((r) => r.type === 'plan' && r.status === 'current');

  let reviewLine = '尚无审查记录';
  let blockers = '—';
  if (lastReview) {
    const m = lastReview.meta;
    const boundDraft = m.adjudicatedDesignSha256 ? drafts.find((d) => d.sha256 === m.adjudicatedDesignSha256) : null;
    const currentness = !m.adjudicatedDesignSha256 ? '未绑定任何设计版本'
      : !boundDraft ? '被审哈希不对应任何已归档草稿'
        : boundDraft.sha256 === latest?.sha256 ? `针对当前草稿 ${boundDraft.version}` : `针对 ${boundDraft.version}，已过期（当前为 ${latest?.version}）`;
    reviewLine = `${m.source} · ${m.status ?? m.conclusion} · ${currentness} · ${L(lastReview.commentIds[0])}`;
    if (boundDraft && boundDraft.sha256 === latest?.sha256 && m.status === 'REWORK') blockers = '有未解决阻断，见该记录';
    if (m.source === 'REVIEWLOOP_NO_ADJUDICATION') blockers = '审查未完成（无裁决）';
  }
  rows.push(
    ['Plan', plan ? `已归档 ${plan.version} · ${L(plan.commentIds[0])}` : '未在合同索引中找到'],
    ['当前草稿', latest ? `${latest.version} · UNREVIEWED · sha256 ${latest.sha256.slice(0, 12)} · ${L(latest.commentIds[0])}` : '尚无已校验草稿'],
    ['最近审查', reviewLine],
    ['未解决阻断', blockers],
    ['正式 Design 归档', contractDesign ? `合同索引登记 ${contractDesign.version}（PR 内报告，NOT_VERIFIED；用 verify-archive 在本机核验）` : '无'],
    ['人工例外', contractException ? `合同索引登记 ${contractException.version}（NOT_VERIFIED；须由用户本人运行并核验）` : '无'],
    ['Code 授权', '未授权 — 由用户另行明确决定，本区块永不据评论推断'],
  );
  const next = !latest ? '发布设计草稿后再送审'
    : !lastReview ? '等待独立审查'
      : lastReview.meta.source === 'REVIEWLOOP_NO_ADJUDICATION' ? '审查未完成：缩小送审内容后由用户授权重新审查，或由用户决定替代方案'
        : '按最近审查结论处理；任何进入 Code 的前提仍是合法 Design PASS 或用户本人的人工例外';
  rows.push(['下一动作', next]);
  const hist = [
    ...drafts.map((d) => `| 草稿 | ${d.version} | ${d.sha256.slice(0, 12)} | ${L(d.commentIds[0])} | ${d === latest ? 'current' : 'superseded'}${d.duplicateCommentIds.length ? ' (有重复评论)' : ''}${d.edited ? ' (已编辑)' : ''} |`),
    ...reviews.map((r) => `| 审查 | ${r.version} | ${(r.meta.adjudicatedDesignSha256 ?? '未绑定').slice(0, 12)} | ${L(r.commentIds[0])} | ${r.meta.status ?? r.meta.conclusion} |`),
  ];
  const invalid = analysis.records.filter((r) => !r.valid).map((r) => `| ${r.kind === 'draft' ? '草稿' : '审查'} | ${r.version} | — | — | invalid (${r.reason}) |`);
  return [
    TRACE_BLOCK_BEGIN,
    '### 设计过程',
    '',
    `任务 ${taskId} · 由评论派生的进度视图，不是审查或授权的权威（权威为本地 ReviewLoop 与合同索引）。`,
    '',
    '| 项目 | 状态 |', '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| 类别 | 版本/轮次 | 被审/草稿哈希 | 评论 | 状态 |', '|---|---|---|---|---|',
    ...hist, ...invalid,
    TRACE_BLOCK_END,
  ].join('\n');
}

/** Replace only the marked block; append (after a blank line) when absent. */
export function applyProgressBlock(prBody, block) {
  const body = typeof prBody === 'string' ? prBody : '';
  const b = body.indexOf(TRACE_BLOCK_BEGIN);
  const e = body.indexOf(TRACE_BLOCK_END);
  if (b >= 0 && e > b) return `${body.slice(0, b)}${block}${body.slice(e + TRACE_BLOCK_END.length)}`;
  if (b >= 0 || e >= 0) fail('TRACE_BLOCK_CORRUPT', 'PR description has an unpaired reviewloop-trace marker; fix it by hand');
  return `${body.trimEnd()}\n\n${block}\n`;
}
