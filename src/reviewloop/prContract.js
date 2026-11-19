// Default PR-comment contract lifecycle support (legacy file contracts remain supported):
//   - strict <details>/</summary>...</details> formatting, splitting (>60k chars), and extraction
//   - PR description contract index parsing and single-current updating
//   - fail-closed comment recovery with author, part-sequence, hash, and GraphQL edit-history checks
//   - 4-condition Design PASS anchor & untracked working-file cleanup verification
//   - final PR diff guard (task-level filenames + disguised content hash) and 3-state gate report
//
// Read-only by default: never auto-posts PR comments, never mutates GitHub settings,
// never touches `reviewloop_begin`/`reviewloop_review` write permissions.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DESIGN_TARGET_MAX_BYTES,
  designContentSha256,
  lstatNoSymlinks,
  normalizeReviewTargetPath,
} from './designTarget.js';
import { DEFAULT_TRUSTED_BOT_LOGINS } from './objective.js';
import { parseTrustedBotSession } from './botSession.js';
import { resolveReviewLoopRuntimeRoot } from './runtimeDir.js';

const execFileAsync = promisify(execFile);

export const PR_CONTRACT_COMMENT_MAX_CHARS = 60_000;
export const PR_CONTRACT_DESIGN_MAX_BYTES = DESIGN_TARGET_MAX_BYTES; // 64 KiB
export const PR_CONTRACT_PLAN_MAX_BYTES = 1024 * 1024; // 1 MiB safety cap
export const PR_CONTRACT_MCP_MAX_BYTES = 64 * 1024; // 65,536 bytes MCP contractText cap
export const PR_CONTRACT_MAX_PARTS = 25;

const CONTRACT_TYPES = new Set(['plan', 'design']);
const INDEX_STATUSES = new Set(['current', 'superseded']);
const TASK_CONTRACT_FILE_RE = /(?:^|\/)(?:Plan|Design)(?:\.[^/]+)?\.md$/i;
const GH_TIMEOUT_MS = 15_000;

export const contractContentSha256 = designContentSha256;

export class PrContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PrContractError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PrContractError(code, message, details);
}

function normalizeType(type) {
  const normalized = String(type ?? '').trim().toLowerCase();
  if (!CONTRACT_TYPES.has(normalized)) {
    fail('PR_CONTRACT_INVALID_TYPE', `contract type must be "plan" or "design", got ${JSON.stringify(type)}`);
  }
  return normalized;
}

function requireNonEmpty(value, field) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) fail('PR_CONTRACT_INVALID_ARG', `${field} must be a non-empty string`);
  return s;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitContractText(trimmed, maxCharsPerPart) {
  if (trimmed.length <= maxCharsPerPart) return [trimmed];
  const chunks = [];
  let offset = 0;
  while (offset < trimmed.length) {
    if (trimmed.length - offset <= maxCharsPerPart) {
      chunks.push(trimmed.slice(offset));
      break;
    }
    const windowEnd = offset + maxCharsPerPart;
    // Prefer a clean newline boundary inside the second half of the window so
    // Markdown lines stay readable across parts without losing exact characters.
    const minSearch = offset + Math.floor(maxCharsPerPart / 2);
    const nl = trimmed.lastIndexOf('\n', windowEnd - 1);
    const splitAt = nl >= minSearch ? nl + 1 : windowEnd;
    chunks.push(trimmed.slice(offset, splitAt));
    offset = splitAt;
  }
  if (chunks.length > PR_CONTRACT_MAX_PARTS) {
    fail(
      'PR_CONTRACT_SIZE_EXCEEDED',
      `contract requires ${chunks.length} comment parts, exceeding safety cap of ${PR_CONTRACT_MAX_PARTS}`,
    );
  }
  return chunks;
}

function checkByteBudget(trimmed, type, { requireMcpLimit = false } = {}) {
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  const maxBytes = type === 'design' ? PR_CONTRACT_DESIGN_MAX_BYTES : PR_CONTRACT_PLAN_MAX_BYTES;
  if (bytes > maxBytes) {
    fail(
      'PR_CONTRACT_SIZE_EXCEEDED',
      `${type} contract is ${bytes} UTF-8 bytes, exceeding ${maxBytes}-byte limit`,
    );
  }
  if (requireMcpLimit && bytes > PR_CONTRACT_MCP_MAX_BYTES) {
    fail(
      'PR_CONTRACT_SIZE_EXCEEDED',
      `contract is ${bytes} UTF-8 bytes, exceeding 65,536-byte MCP contractText limit (cannot truncate)`,
    );
  }
  return bytes;
}

/**
 * Formats a Plan or Design contract into one or more PR comment bodies
 * following `personal-skills @305d9c0` collapsible block & part conventions.
 */
export function formatContractComments({
  taskId,
  type,
  version,
  content,
  summaryPrefix,
  maxCharsPerPart = PR_CONTRACT_COMMENT_MAX_CHARS,
  designSha256 = null,
}) {
  const id = requireNonEmpty(taskId, 'taskId');
  const kind = normalizeType(type);
  const ver = requireNonEmpty(version, 'version');
  if (typeof content !== 'string' || !content.trim()) {
    fail('PR_CONTRACT_EMPTY', 'contract content must be non-empty');
  }
  if (!Number.isInteger(maxCharsPerPart) || maxCharsPerPart < 1) {
    fail('PR_CONTRACT_INVALID_ARG', 'maxCharsPerPart must be a positive integer');
  }
  const trimmed = content.trim();
  checkByteBudget(trimmed, kind);
  const sha256 = contractContentSha256(trimmed);
  if (kind === 'design' && designSha256 && sha256 !== String(designSha256).toLowerCase()) {
    fail(
      'PR_CONTRACT_DESIGN_ANCHOR_MISMATCH',
      `design content SHA-256 (${sha256}) does not match designSha256 (${designSha256})`,
    );
  }

  const chunks = splitContractText(trimmed, maxCharsPerPart);
  const total = chunks.length;
  const label = kind === 'plan' ? 'Plan' : 'Design';
  const comments = chunks.map((chunk, idx) => {
    const part = idx + 1;
    const partTag = total > 1 ? `:part=${part}/${total}` : '';
    const partLabel = total > 1 ? ` · 分段 ${part}/${total}` : '';
    const summaryText = summaryPrefix
      ? `${summaryPrefix}${partLabel}`
      : `展开 ${label} ${ver} 全文${partLabel}`;
    const beginMarker = `<!-- reviewloop-${kind}:${id}:${ver}${partTag}:begin -->`;
    const endMarker = `<!-- reviewloop-${kind}:${id}:${ver}${partTag}:end -->`;
    const lines = [
      `**${id} · ${label} ${ver}${partLabel} · 完整${kind === 'plan' ? '需求' : '设计'}**`,
      '',
      beginMarker,
      '<details>',
      `<summary>${summaryText}</summary>`,
      '',
      chunk,
      '',
      '</details>',
      endMarker,
    ];
    if (kind === 'design' && designSha256 && part === total) {
      lines.push('', `designSha256: ${sha256}`);
    }
    return { part, total, body: lines.join('\n') };
  });

  return { taskId: id, type: kind, version: ver, sha256, totalParts: total, comments };
}

/**
 * Extracts one contract comment's inner body between the first `<details>/<summary>`
 * after its `begin` marker and the LAST `</details>` before its `end` marker.
 * Prevents literal `</details>` inside contract prose from truncating extraction.
 */
export function extractContractCommentPart(
  body,
  expected = {},
  { maxCharsPerPart = PR_CONTRACT_COMMENT_MAX_CHARS } = {},
) {
  if (typeof body !== 'string' || !body.trim()) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'comment body is empty');
  }
  const beginRe = /<!--\s*reviewloop-(plan|design):([^:\s]+):([^:\s]+?)(?::part=(\d+)\/(\d+))?:begin\s*-->/;
  const beginMatch = beginRe.exec(body);
  if (!beginMatch) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'missing reviewloop begin marker in comment');
  }
  const [, rawType, taskId, version, partStr, totalStr] = beginMatch;
  const type = normalizeType(rawType);
  const part = partStr ? Number(partStr) : 1;
  const total = totalStr ? Number(totalStr) : 1;
  if (!Number.isInteger(part) || !Number.isInteger(total) || part < 1 || total < 1 || part > total) {
    fail('PR_CONTRACT_FORMAT_INVALID', `invalid part range ${partStr}/${totalStr}`);
  }

  if (expected.taskId && taskId !== expected.taskId) {
    fail('PR_CONTRACT_METADATA_CONFLICT', `comment taskId ${taskId} conflicts with expected ${expected.taskId}`);
  }
  if (expected.type && type !== normalizeType(expected.type)) {
    fail('PR_CONTRACT_METADATA_CONFLICT', `comment type ${type} conflicts with expected ${expected.type}`);
  }
  if (expected.version && version !== expected.version) {
    fail('PR_CONTRACT_VERSION_CONFLICT', `comment version ${version} conflicts with expected ${expected.version}`);
  }

  const afterBegin = beginMatch.index + beginMatch[0].length;
  const partSuffix = partStr ? `:part=${partStr}/${totalStr}` : '';
  const endRe = new RegExp(
    `<!--\\s*reviewloop-${escapeRegExp(type)}:${escapeRegExp(taskId)}:${escapeRegExp(version)}${escapeRegExp(partSuffix)}:end\\s*-->`,
  );
  const endMatch = endRe.exec(body.slice(afterBegin));
  if (!endMatch) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'missing matching reviewloop end marker in comment');
  }
  const endIndex = afterBegin + endMatch.index;
  const region = body.slice(afterBegin, endIndex);

  const detailsOpen = region.indexOf('<details>');
  if (detailsOpen < 0) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'missing <details> after begin marker');
  }
  const summaryClose = region.indexOf('</summary>', detailsOpen);
  if (summaryClose < 0) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'missing </summary> inside <details>');
  }
  const contentStart = summaryClose + '</summary>'.length;
  const lastDetailsClose = region.lastIndexOf('</details>');
  if (lastDetailsClose < contentStart) {
    fail('PR_CONTRACT_FORMAT_INVALID', 'missing closing </details> before end marker');
  }

  let rawContent = region.slice(contentStart, lastDetailsClose);
  if (total > 1) {
    // Strip only the formatting wrapper newlines around the chunk so multi-part
    // joins preserve exact interior whitespace.
    rawContent = rawContent.replace(/^\r?\n(?:\r?\n)?/, '').replace(/(?:\r?\n)?\r?\n$/, '');
  }
  if (rawContent.trim().length > maxCharsPerPart) {
    fail(
      'PR_CONTRACT_SIZE_EXCEEDED',
      `comment part ${part}/${total} exceeds ${maxCharsPerPart}-character per-comment safety limit`,
    );
  }
  return { taskId, type, version, part, total, rawContent };
}

function parseCommentIdsCell(cell) {
  const ids = [];
  // Match either markdown link `[12345](url)` or bare numeric comment IDs.
  const linkRe = /\[(\d+)\]\([^)]+\)/g;
  let m;
  while ((m = linkRe.exec(cell)) !== null) {
    ids.push(m[1]);
  }
  if (ids.length === 0) {
    const bareRe = /\b(\d+)\b/g;
    while ((m = bareRe.exec(cell)) !== null) {
      ids.push(m[1]);
    }
  }
  return ids;
}

function parsePartsCell(cell) {
  const cleaned = cell.trim();
  const slashMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(cleaned);
  if (slashMatch) {
    const num = Number(slashMatch[1]);
    const total = Number(slashMatch[2]);
    if (total < 1 || num < 1 || num > total) {
      fail('PR_CONTRACT_INDEX_INVALID', `invalid parts cell ${JSON.stringify(cleaned)}`);
    }
    return total;
  }
  const singleMatch = /^(\d+)$/.exec(cleaned);
  if (singleMatch) {
    const total = Number(singleMatch[1]);
    if (total < 1) fail('PR_CONTRACT_INDEX_INVALID', `invalid parts cell ${JSON.stringify(cleaned)}`);
    return total;
  }
  fail('PR_CONTRACT_INDEX_INVALID', `unrecognized parts cell ${JSON.stringify(cleaned)}`);
}

/**
 * Parses the `### 合同索引` Markdown table from a PR description.
 * Rejects multiple `current` entries for the same `(taskId, type)`.
 */
export function parseContractIndex(prBody) {
  const body = typeof prBody === 'string' ? prBody : '';
  const headingMatch = /^#{2,3}\s+合同索引\s*$/m.exec(body);
  if (!headingMatch) return [];

  const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
  const lines = afterHeading.split(/\r?\n/);
  const rows = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inTable) break;
      continue;
    }
    if (!trimmed.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    // Skip header and separator rows.
    if (/^\|\s*任务\s*\|/.test(trimmed) || /^\|\s*[-:|\s]+\|$/.test(trimmed)) continue;

    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 7) {
      fail('PR_CONTRACT_INDEX_INVALID', `contract index row must have 7 columns: ${trimmed}`);
    }
    const [taskId, rawType, version, commentCell, shaCell, partsCell, statusCell] = cells;
    const type = normalizeType(rawType);
    const commentIds = parseCommentIdsCell(commentCell);
    const sha256 = shaCell.replace(/^`+|`+$/g, '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      fail('PR_CONTRACT_INDEX_INVALID', `invalid SHA-256 in contract index: ${shaCell}`);
    }
    const totalParts = parsePartsCell(partsCell);
    if (commentIds.length === 0 || (totalParts > 1 && commentIds.length !== totalParts)) {
      fail(
        'PR_CONTRACT_INDEX_INVALID',
        `commentIds count (${commentIds.length}) does not match totalParts (${totalParts}) for ${taskId} ${type} ${version}`,
      );
    }
    const status = statusCell.trim().toLowerCase();
    if (!INDEX_STATUSES.has(status)) {
      fail('PR_CONTRACT_INDEX_INVALID', `invalid status ${JSON.stringify(statusCell)} in contract index`);
    }
    rows.push({
      taskId: requireNonEmpty(taskId, 'taskId'),
      type,
      version: requireNonEmpty(version, 'version'),
      commentIds,
      sha256,
      totalParts,
      status,
    });
  }

  const currentKeys = new Set();
  for (const row of rows) {
    if (row.status === 'current') {
      const key = `${row.taskId}:${row.type}`;
      if (currentKeys.has(key)) {
        fail('PR_CONTRACT_MULTIPLE_CURRENT', `multiple current entries in contract index for ${key}`);
      }
      currentKeys.add(key);
    }
  }
  return rows;
}

/**
 * Pure helper to add/update an entry in the PR description contract index,
 * automatically marking any previous `current` entry of the same `(taskId, type)`
 * as `superseded`.
 */
export function upsertContractIndex(prBody, entry, { repoUrl = null, prNumber = null } = {}) {
  const existing = parseContractIndex(prBody);
  const kind = normalizeType(entry.type);
  const taskId = requireNonEmpty(entry.taskId, 'taskId');
  const version = requireNonEmpty(entry.version, 'version');
  const sha256 = String(entry.sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    fail('PR_CONTRACT_INDEX_INVALID', `invalid SHA-256 for index entry: ${entry.sha256}`);
  }
  const commentIds = Array.isArray(entry.commentIds) ? entry.commentIds.map(String) : [];
  const totalParts = entry.totalParts ?? commentIds.length;
  if (commentIds.length === 0 || commentIds.length !== totalParts) {
    fail('PR_CONTRACT_INDEX_INVALID', 'commentIds must match totalParts');
  }

  const updated = existing.map((row) => (
    row.taskId === taskId && row.type === kind && row.status === 'current'
      ? { ...row, status: 'superseded' }
      : row
  ));
  updated.push({
    taskId,
    type: kind,
    version,
    commentIds,
    sha256,
    totalParts,
    status: 'current',
  });

  const formatIds = (ids) => ids
    .map((id) => (repoUrl && prNumber ? `[${id}](${repoUrl}/pull/${prNumber}#issuecomment-${id})` : id))
    .join(', ');

  const tableLines = [
    '### 合同索引',
    '',
    '| 任务 | 类型 | 版本 | 评论 ID | SHA-256 | 分段 | 状态 |',
    '|---|---|---|---|---|---|---|',
    ...updated.map((r) => `| ${r.taskId} | ${r.type === 'plan' ? 'Plan' : 'Design'} | ${r.version} | ${formatIds(r.commentIds)} | \`${r.sha256}\` | ${r.totalParts}/${r.totalParts} | ${r.status} |`),
  ];

  const body = typeof prBody === 'string' ? prBody : '';
  const tableRe = /^#{2,3}\s+合同索引\s*\r?\n(?:\s*\r?\n)?(?:\|[^\r\n]*\r?\n?)*/m;
  if (tableRe.test(body)) {
    return body.replace(tableRe, `${tableLines.join('\n')}\n`);
  }
  return `${body.trimEnd()}\n\n${tableLines.join('\n')}\n`;
}

export async function defaultRunGh(args, { timeoutMs = GH_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const msg = err?.stderr || err?.message || String(err);
    const code = /403|forbidden|permission/i.test(msg)
      ? 'PR_CONTRACT_GH_FORBIDDEN'
      : /404|not found/i.test(msg)
        ? 'PR_CONTRACT_NOT_FOUND'
        : 'PR_CONTRACT_GH_FAILED';
    fail(code, `gh ${args.slice(0, 3).join(' ')} failed: ${msg.trim()}`);
  }
}

function splitRepoSlug(repo) {
  const s = requireNonEmpty(repo, 'repo');
  const parts = s.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail('PR_CONTRACT_INVALID_ARG', `repo must be "owner/name", got ${JSON.stringify(repo)}`);
  }
  return { owner: parts[0], name: parts[1] };
}

export async function fetchPrMetadata({ repo, prNumber, runGh = defaultRunGh }) {
  const pr = String(prNumber ?? '').trim();
  if (!/^\d+$/.test(pr)) fail('PR_CONTRACT_INVALID_ARG', `invalid prNumber: ${prNumber}`);
  const raw = await runGh([
    'pr', 'view', pr,
    '--repo', repo,
    '--json', 'body,headRefOid,baseRefName,headRefName,url',
  ]);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    fail('PR_CONTRACT_GH_FAILED', 'empty PR metadata from gh pr view');
  }
  return parsed;
}

export async function fetchCommentWithEditHistory({
  repo,
  prNumber = null,
  commentId,
  runGh = defaultRunGh,
}) {
  const { owner, name } = splitRepoSlug(repo);
  const raw = await runGh(['api', `repos/${owner}/${name}/issues/comments/${commentId}`]);
  const comment = JSON.parse(raw);
  if (!comment || typeof comment !== 'object' || typeof comment.body !== 'string') {
    fail('PR_CONTRACT_NOT_FOUND', `comment ${commentId} returned invalid payload`);
  }
  if (prNumber != null) {
    const expectedSuffix = `/repos/${owner}/${name}/issues/${Number(prNumber)}`.toLowerCase();
    const issueUrl = typeof comment.issue_url === 'string' ? comment.issue_url.trim().toLowerCase() : '';
    if (!issueUrl || !issueUrl.endsWith(expectedSuffix)) {
      fail(
        'PR_CONTRACT_COMMENT_PR_MISMATCH',
        `comment ${commentId} issue_url (${comment.issue_url ?? 'missing'}) does not belong to ${repo}#${prNumber}`,
      );
    }
  }

  let editHistoryVerified = false;
  let edited = null;
  let editCount = null;
  let lastEditedAt = null;

  if (comment.node_id) {
    try {
      const gqlRaw = await runGh([
        'api', 'graphql',
        '-f', 'query=query($id: ID!) { node(id: $id) { ... on IssueComment { lastEditedAt userContentEdits(first: 5) { totalCount } } } }',
        '-F', `id=${comment.node_id}`,
      ]);
      const gql = JSON.parse(gqlRaw);
      const node = gql?.data?.node;
      if (node && typeof node === 'object') {
        editHistoryVerified = true;
        lastEditedAt = node.lastEditedAt ?? null;
        editCount = node.userContentEdits?.totalCount ?? 0;
        edited = Boolean(lastEditedAt || editCount > 0);
      }
    } catch {
      // Degrade gracefully when GraphQL edit history is unreadable; caller
      // must surface `编辑历史未核验` warning while still enforcing hash check.
      editHistoryVerified = false;
    }
  }

  return {
    id: String(comment.id ?? commentId),
    nodeId: comment.node_id ?? null,
    author: comment.user?.login ?? null,
    body: comment.body,
    createdAt: comment.created_at ?? null,
    updatedAt: comment.updated_at ?? null,
    editHistoryVerified,
    edited,
    editCount,
    lastEditedAt,
  };
}

/**
 * Fail-closed contract recovery from PR description index + direct comment IDs.
 */
export async function recoverPrContract({
  repo,
  prNumber,
  taskId,
  type,
  version = null,
  allowedAuthors = null,
  expectedDesignSha256 = null,
  requireMcpLimit = false,
  runGh = defaultRunGh,
}) {
  const { owner } = splitRepoSlug(repo);
  const kind = normalizeType(type);
  const id = requireNonEmpty(taskId, 'taskId');
  const trustedAuthors = new Set(
    Array.isArray(allowedAuthors) && allowedAuthors.length > 0 ? allowedAuthors : [owner],
  );

  const prMeta = await fetchPrMetadata({ repo, prNumber, runGh });
  const indexRows = parseContractIndex(prMeta.body);
  const currentRows = indexRows.filter(
    (r) => r.taskId === id && r.type === kind && r.status === 'current',
  );
  if (currentRows.length === 0) {
    fail('PR_CONTRACT_NOT_FOUND', `no current ${kind} entry in PR #${prNumber} contract index for ${id}`);
  }
  if (currentRows.length > 1) {
    fail('PR_CONTRACT_MULTIPLE_CURRENT', `multiple current ${kind} entries found for ${id}`);
  }
  const entry = currentRows[0];
  if (version && entry.version !== version) {
    fail(
      'PR_CONTRACT_VERSION_CONFLICT',
      `requested version ${version}, but PR #${prNumber} index current is ${entry.version}`,
    );
  }

  const parts = [];
  const warnings = [];
  let anyEdited = false;
  let allHistoryVerified = true;

  for (let i = 0; i < entry.commentIds.length; i += 1) {
    const commentId = entry.commentIds[i];
    // eslint-disable-next-line no-await-in-loop
    const fetched = await fetchCommentWithEditHistory({ repo, prNumber, commentId, runGh });
    if (!fetched.author || !trustedAuthors.has(fetched.author)) {
      fail(
        'PR_CONTRACT_UNTRUSTED_AUTHOR',
        `comment ${commentId} author ${JSON.stringify(fetched.author)} is not in allowedAuthors (${[...trustedAuthors].join(', ')})`,
      );
    }
    const extracted = extractContractCommentPart(fetched.body, {
      taskId: id,
      type: kind,
      version: entry.version,
    });
    if (extracted.total !== entry.totalParts) {
      fail(
        'PR_CONTRACT_PART_MISMATCH',
        `comment ${commentId} declares totalParts=${extracted.total}, expected ${entry.totalParts}`,
      );
    }
    if (extracted.part !== i + 1) {
      fail(
        'PR_CONTRACT_PART_MISMATCH',
        `comment ${commentId} is part ${extracted.part}/${extracted.total}, expected part ${i + 1}/${entry.totalParts}`,
      );
    }
    if (!fetched.editHistoryVerified) {
      allHistoryVerified = false;
    } else if (fetched.edited) {
      anyEdited = true;
    }
    parts.push(extracted.rawContent);
  }

  const content = parts.join('').trim();
  if (!content) {
    fail('PR_CONTRACT_EMPTY', `recovered ${kind} contract for ${id} is empty`);
  }
  checkByteBudget(content, kind, { requireMcpLimit });
  const actualSha256 = contractContentSha256(content);
  if (actualSha256 !== entry.sha256) {
    fail(
      'PR_CONTRACT_HASH_MISMATCH',
      `${kind} contract SHA-256 mismatch: comment content is ${actualSha256}, index expects ${entry.sha256}`,
    );
  }
  if (kind === 'design' && expectedDesignSha256) {
    const expected = String(expectedDesignSha256).trim().toLowerCase();
    if (actualSha256 !== expected) {
      fail(
        'PR_CONTRACT_DESIGN_ANCHOR_MISMATCH',
        `Design comment SHA-256 (${actualSha256}) does not match independent Design PASS anchor (${expected})`,
      );
    }
  }

  if (!allHistoryVerified) warnings.push('编辑历史未核验（GraphQL 不可读，已按正文哈希核验）');
  if (anyEdited) warnings.push('警告：合同评论存在编辑记录（editHistory=true），但正文哈希与索引一致');

  const trustNote = kind === 'plan'
    ? 'Plan 仅校验「PR 描述索引 ↔ 评论」一致性（无 PR 外部独立锚点，高风险请由所有者确认）。'
    : expectedDesignSha256
      ? 'Design 已核对「PR 描述索引 ↔ 评论 ↔ 独立 designSha256 锚点」三方一致。'
      : '警告：本次未提供 PR 外部 designSha256 独立锚点，仅校验了 PR 内部索引与评论一致。';

  return {
    taskId: id,
    type: kind,
    version: entry.version,
    sha256: actualSha256,
    content,
    commentIds: entry.commentIds,
    totalParts: entry.totalParts,
    edited: anyEdited,
    editHistoryVerified: allHistoryVerified,
    warnings,
    trustNote,
    headRefOid: prMeta.headRefOid ?? null,
    baseRefName: prMeta.baseRefName ?? null,
    headRefName: prMeta.headRefName ?? null,
    url: prMeta.url ?? null,
  };
}

/**
 * Finds a local ReviewLoop Design PASS record from `~/.reviewloop` (or custom runtimeDir).
 */
export async function findLocalDesignPassAnchor({
  loopId = null,
  designSha256 = null,
  runtimeDir = resolveReviewLoopRuntimeRoot(),
} = {}) {
  const candidates = [];
  if (loopId) {
    candidates.push(loopId);
  } else {
    let entries = [];
    try {
      entries = await fsp.readdir(runtimeDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name.startsWith('rl-')) candidates.push(ent.name);
    }
    candidates.sort().reverse();
  }

  const targetSha = designSha256 ? String(designSha256).trim().toLowerCase() : null;
  for (const id of candidates) {
    const wfPath = path.join(runtimeDir, id, 'workflow.json');
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await fsp.readFile(wfPath, 'utf8');
      const parsed = JSON.parse(raw);
      const rl = parsed?.reviewLoop;
      if (!rl || rl.state !== 'PASS' || !rl.designReview?.designSha256) continue;
      const sha = String(rl.designReview.designSha256).toLowerCase();
      if (targetSha && sha !== targetSha) continue;
      return {
        loopId: id,
        reviewTarget: rl.designReview.reviewTarget,
        designSha256: sha,
        round: rl.designReview.round ?? null,
        reviewedAt: rl.designReview.reviewedAt ?? null,
      };
    } catch {
      // Ignore unreadable or non-JSON entries while scanning.
    }
  }
  return null;
}

async function defaultRunGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Verifies all 5 safety checks before allowing (optional) cleanup of
 * an untracked local Design working file:
 *   1. PR comment recovered Design matches PR description index SHA-256
 *   2. Independent local ReviewLoop Design PASS anchor exists for that SHA-256
 *   3. Local target file exists and is a regular non-symlink file
 *   4. Local target file is untracked in Git
 *   5. Local target file trimmed SHA-256 matches Design PASS anchor
 *
 * Read-only unless `clean: true` is explicitly passed.
 */
export async function verifyDesignArchiveAndCleanupReady({
  cwd,
  repo,
  prNumber,
  taskId,
  version = null,
  loopId = null,
  reviewTarget = null,
  allowedAuthors = null,
  runtimeDir = resolveReviewLoopRuntimeRoot(),
  clean = false,
  runGh = defaultRunGh,
  runGit = defaultRunGit,
}) {
  // 1 & 2. Recover Design from PR comment + index first so the local anchor
  // lookup is bound to this task's exact recovered Design SHA-256 (even when
  // `--loop` is omitted).
  const recovered = await recoverPrContract({
    repo,
    prNumber,
    taskId,
    type: 'design',
    version,
    allowedAuthors,
    runGh,
  });

  // 3. Independent local Design PASS anchor matching recovered.sha256
  const anchor = await findLocalDesignPassAnchor({
    loopId,
    designSha256: recovered.sha256,
    runtimeDir,
  });
  if (!anchor) {
    fail(
      'PR_CONTRACT_NO_DESIGN_PASS',
      loopId
        ? `no Design PASS record found in ReviewLoop store for loopId=${loopId} matching sha256=${recovered.sha256}`
        : `no Design PASS record found in local ReviewLoop store matching sha256=${recovered.sha256}`,
    );
  }

  // 4. Verify local untracked working file exists (walking every path component
  // to refuse symlinks), is not tracked in Git, and matches SHA-256.
  const relPath = normalizeReviewTargetPath(reviewTarget ?? anchor.reviewTarget);
  if (anchor.reviewTarget && relPath !== normalizeReviewTargetPath(anchor.reviewTarget)) {
    fail(
      'PR_CONTRACT_TARGET_MISMATCH',
      `requested reviewTarget ${relPath} does not match Design PASS reviewTarget ${anchor.reviewTarget}`,
    );
  }
  const absPath = path.join(cwd, relPath);

  let found;
  try {
    found = await lstatNoSymlinks(cwd, relPath);
  } catch (err) {
    fail('PR_CONTRACT_LOCAL_FILE_INVALID', `local design file ${relPath} failed symlink/stat check: ${err?.message ?? err}`);
  }
  if (found.missing) {
    fail('PR_CONTRACT_LOCAL_FILE_MISSING', `local design file ${relPath} does not exist`);
  }
  if (!found.stat.isFile()) {
    fail('PR_CONTRACT_LOCAL_FILE_INVALID', `local design file ${relPath} must be a regular non-symlink file`);
  }

  // Ensure the file is untracked in Git (never delete tracked/historical files).
  let isTracked = false;
  try {
    const trackedOut = await runGit(cwd, ['ls-files', '--', relPath]);
    isTracked = trackedOut.trim().length > 0;
  } catch (err) {
    fail('PR_CONTRACT_GIT_FAILED', `git ls-files failed for ${relPath}: ${err?.message ?? err}`);
  }
  if (isTracked) {
    fail(
      'PR_CONTRACT_TRACKED_FILE_REFUSED',
      `refusing to clean ${relPath}: file is tracked by Git (only untracked Design working files may be cleaned)`,
    );
  }

  const localContent = await fsp.readFile(absPath, 'utf8');
  const localSha = contractContentSha256(localContent);
  if (localSha !== anchor.designSha256) {
    fail(
      'PR_CONTRACT_LOCAL_DRIFT',
      `local ${relPath} SHA-256 (${localSha}) differs from Design PASS (${anchor.designSha256}); refusing cleanup`,
    );
  }

  let cleaned = false;
  if (clean) {
    await fsp.unlink(absPath);
    cleaned = true;
  }

  return {
    readyToClean: true,
    cleaned,
    reviewTarget: relPath,
    loopId: anchor.loopId,
    designSha256: anchor.designSha256,
    commentIds: recovered.commentIds,
    version: recovered.version,
    warnings: recovered.warnings,
  };
}

/**
 * Inspects `git diff --name-status <baseRef>...HEAD` for newly added or modified
 * task-level `Plan*.md` / `Design*.md` files (or renamed files matching archived
 * contract hashes), while allowing `approvedAssets` and untouched historical files.
 */
export async function checkFinalPrDiff({
  cwd,
  baseRef = 'main',
  approvedAssets = [],
  archivedContractHashes = [],
  runGit = defaultRunGit,
}) {
  const approvedSet = new Set(approvedAssets.map((p) => normalizeReviewTargetPath(p)));
  const archivedHashSet = new Set(
    archivedContractHashes.map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean),
  );

  let rawDiff;
  try {
    rawDiff = await runGit(cwd, ['diff', '--name-status', '-z', `${baseRef}...HEAD`]);
  } catch (err) {
    fail('PR_CONTRACT_GIT_FAILED', `git diff against ${baseRef} failed: ${err?.message ?? err}`);
  }

  const checkedFiles = [];
  const violations = [];
  const tokens = rawDiff.split('\0');

  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    const code = status[0];
    let rawFile;
    if (code === 'R' || code === 'C') {
      rawFile = tokens[i + 2];
      i += 2;
    } else {
      rawFile = tokens[i + 1];
      i += 1;
    }
    // Only inspect Added / Modified / Renamed / Copied destination files; ignore Deleted.
    if (code !== 'A' && code !== 'M' && code !== 'R' && code !== 'C') continue;
    if (!rawFile) continue;
    const relPath = rawFile.replace(/\\/g, '/');
    checkedFiles.push({ status: code, path: relPath });

    if (approvedSet.has(relPath)) continue;

    if (TASK_CONTRACT_FILE_RE.test(relPath)) {
      violations.push({
        path: relPath,
        status: code,
        reason: 'TASK_CONTRACT_FILENAME',
        message: `新增/修改了未豁免的任务级文档 ${relPath}`,
      });
      continue;
    }

    if (archivedHashSet.size > 0) {
      const abs = path.join(cwd, relPath);
      if (fs.existsSync(abs)) {
        try {
          const st = fs.statSync(abs);
          if (st.isFile() && st.size <= PR_CONTRACT_PLAN_MAX_BYTES) {
            const content = fs.readFileSync(abs, 'utf8');
            const sha = contractContentSha256(content);
            if (archivedHashSet.has(sha)) {
              violations.push({
                path: relPath,
                status: code,
                reason: 'ARCHIVED_CONTRACT_CONTENT_MATCH',
                sha256: sha,
                message: `文件 ${relPath} 内容与已归档合同哈希 (${sha.slice(0, 12)}) 一致，疑似改名混入`,
              });
            }
          }
        } catch {
          // Ignore binary/unreadable edge files during hash check.
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    baseRef,
    checkedFiles,
    violations,
  };
}

export async function inspectRemoteProtection({ repo, baseRef, runGh = defaultRunGh }) {
  const { owner, name } = splitRepoSlug(repo);
  try {
    await runGh(['api', `repos/${owner}/${name}/branches/${encodeURIComponent(baseRef)}/protection`]);
    return { status: 'ENFORCED', detail: `分支 ${baseRef} 已启用远端分支保护` };
  } catch (err) {
    if (err instanceof PrContractError && err.code === 'PR_CONTRACT_NOT_FOUND') {
      return { status: 'NOT_ENFORCED', detail: `分支 ${baseRef} 远端无强制合并门禁（Branch Protection 未启用）` };
    }
    return { status: 'UNKNOWN', detail: err?.message ?? '无法查询远端分支保护状态' };
  }
}

export async function inspectPrBotStatus({
  repo,
  prNumber,
  headRefOid,
  trustedBotLogins,
  runGh = defaultRunGh,
}) {
  const { owner, name } = splitRepoSlug(repo);
  try {
    const raw = await runGh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
    ]);
    const parsed = JSON.parse(raw);
    // `--paginate --slurp` returns an array of pages (or a single array in unit stubs).
    const comments = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed.flat() : parsed;
    if (!Array.isArray(comments)) {
      return { status: 'UNKNOWN', detail: 'PR 评论列表格式异常' };
    }
    const allowed = new Set(
      (trustedBotLogins?.length ? trustedBotLogins : DEFAULT_TRUSTED_BOT_LOGINS)
        .map((l) => String(l ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
    const trusted = comments
      .map((c) => ({
        id: Number(c?.id ?? 0),
        authorLogin: String(c?.user?.login ?? c?.author?.login ?? c?.authorLogin ?? '').trim(),
        createdAt: c?.created_at ?? c?.createdAt ?? null,
        updatedAt: c?.updated_at ?? c?.updatedAt ?? null,
        body: typeof c?.body === 'string' ? c.body : '',
      }))
      .filter((c) => allowed.has(c.authorLogin.toLowerCase()) && c.body.includes('jiaze-review-session:v1'))
      .sort((a, b) => a.id - b.id);

    if (!trusted.length) {
      return { status: 'MISSING', detail: '未找到受信任的 claude-review-bot 审查会话评论' };
    }
    // Select the configured review App's session comment with the highest ID
    // (README spec), rather than sorting by updatedAt.
    const latestById = trusted[trusted.length - 1];
    const session = parseTrustedBotSession({
      comments: [latestById],
      ...(trustedBotLogins ? { trustedBotLogins } : {}),
    });
    if (!session.found) {
      return { status: 'MISSING', detail: '未找到受信任的 claude-review-bot 审查会话评论' };
    }
    if (!session.parseable) {
      return { status: 'UNKNOWN', detail: 'PR bot 审查会话格式无法解析' };
    }

    const headLower = headRefOid ? String(headRefOid).trim().toLowerCase() : null;
    if (headLower) {
      const headMatches = session.lastReviewedHead
        && (session.lastReviewedHead.length === 40
          ? headLower === session.lastReviewedHead
          : headLower.startsWith(session.lastReviewedHead));
      if (!headMatches || session.staleFor === headLower) {
        return {
          status: 'PENDING',
          detail: session.lastReviewedHead
            ? `PR bot 最近审查基线 (${session.lastReviewedHead.slice(0, 7)}) 落后于当前 HEAD (${headLower.slice(0, 7)})`
            : `PR bot 尚未记录当前 HEAD (${headLower.slice(0, 7)}) 的审查基线`,
        };
      }
    }

    const rawStatus = session.sessionStatus;
    if (rawStatus === 'AUDIT_PENDING' || rawStatus === 'PARTIAL' || rawStatus === 'REVIEW_IN_PROGRESS') {
      return { status: 'PENDING', detail: `PR bot 状态为 ${rawStatus}` };
    }
    return { status: rawStatus, detail: `PR bot 状态为 ${rawStatus}` };
  } catch (err) {
    return { status: 'UNKNOWN', detail: err?.message ?? '无法读取 PR bot 状态' };
  }
}

/**
 * Produces the 3-state independent gate report separating local checks,
 * remote branch protection, and PR bot status (R10 / AC-08).
 */
export async function runFinalPrGateReport({
  cwd,
  repo,
  prNumber,
  baseRef = null,
  approvedAssets = [],
  runGh = defaultRunGh,
  runGit = defaultRunGit,
}) {
  let prMeta = null;
  let effectiveBase = baseRef;
  let archivedHashes = [];
  const localErrors = [];

  try {
    prMeta = await fetchPrMetadata({ repo, prNumber, runGh });
    if (!effectiveBase) effectiveBase = prMeta.baseRefName || 'main';
    const indexRows = parseContractIndex(prMeta.body);
    archivedHashes = indexRows.map((r) => r.sha256);
  } catch (err) {
    localErrors.push(err?.message ?? String(err));
    if (!effectiveBase) effectiveBase = 'main';
  }

  let diffResult = null;
  try {
    diffResult = await checkFinalPrDiff({
      cwd,
      baseRef: effectiveBase,
      approvedAssets,
      archivedContractHashes: archivedHashes,
      runGit,
    });
    if (!diffResult.ok) {
      for (const v of diffResult.violations) localErrors.push(v.message);
    }
  } catch (err) {
    localErrors.push(err?.message ?? String(err));
  }

  const localCheck = {
    status: localErrors.length === 0 ? 'PASS' : 'FAIL',
    errors: localErrors,
    diff: diffResult,
  };
  const remoteProtection = await inspectRemoteProtection({ repo, baseRef: effectiveBase, runGh });
  const prBotStatus = await inspectPrBotStatus({
    repo,
    prNumber,
    headRefOid: prMeta?.headRefOid ?? null,
    runGh,
  });

  return {
    localCheck,
    remoteProtection,
    prBotStatus,
    baseRef: effectiveBase,
    headRefOid: prMeta?.headRefOid ?? null,
  };
}
