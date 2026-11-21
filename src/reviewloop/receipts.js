// Dense interval receipts for adjudication prompts (Plan R02, AC-02).
//
// Goal: DETECT unintended truncation / loss of a stretch of the prompt. NOT to
// prove the model read or understood anything.
//
// Every block (plan, design, proposals, each source, tree) is cut at line
// boundaries every >= RECEIPT_INTERVAL_BYTES, and one receipt line
// `⟦RL:<n>:<hex8>⟧` is inserted between slices; a final receipt always closes
// the block. hex8 derives from a per-call random salt, so neither the Worker nor
// the model can know it beforehand. The reply must echo ALL receipts in order.
//
// What this can prove: if the echoed sequence is complete, no continuous loss
// that spans at least one receipt line happened (incl. tail truncation and
// mid-block loss of >= one interval). The longest loss that can go undetected is
// therefore strictly shorter than RECEIPT_INTERVAL_BYTES plus one line, and only
// when it contains no receipt line.
// What it cannot prove: a loss shorter than that containing no receipt; that the
// model understood the text; that the server did not alter text between
// receipts; that a model did not just echo receipts without reading (NOT_VERIFIED
// model behaviour). Passing receipts is a necessary condition, never a basis for
// approval.

import { createHash, randomBytes } from 'node:crypto';

export const RECEIPT_INTERVAL_BYTES = 4096;
const RECEIPT_RE = /^⟦RL:(\d+):([0-9a-f]{8})⟧$/;

export function newReceiptSession(salt = randomBytes(16).toString('hex')) {
  return { salt, expected: [], blocks: [] };
}

const receiptLine = (salt, n) => `⟦RL:${n}:${createHash('sha256').update(`${salt}|${n}`).digest('hex').slice(0, 8)}⟧`;

// Wrap one block. Records the receipts it created on `session` (in prompt order).
export function wrapWithReceipts(text, session, { interval = RECEIPT_INTERVAL_BYTES } = {}) {
  const src = String(text ?? '');
  const segments = src.length === 0 ? [] : (src.match(/[^\n]*\n|[^\n]+$/g) ?? []);
  const made = [];
  let out = '';
  let since = 0;
  segments.forEach((seg, i) => {
    out += seg;
    since += Buffer.byteLength(seg, 'utf8');
    const isLast = i === segments.length - 1;
    if (!isLast && seg.endsWith('\n') && since >= interval) {
      const r = receiptLine(session.salt, session.expected.length + made.length + 1);
      made.push(r);
      out += `${r}\n`;
      since = 0;
    }
  });
  const trailingNewline = src.length === 0 || src.endsWith('\n');
  const end = receiptLine(session.salt, session.expected.length + made.length + 1);
  made.push(end);
  out += `${trailingNewline ? '' : '\n'}${end}\n`;
  session.expected.push(...made);
  session.blocks.push({ receipts: made, trailingNewline });
  return out;
}

// Inverse of wrapWithReceipts for one block (used by tests and diagnostics).
export function unwrapReceipts(wrapped, block) {
  let t = String(wrapped);
  for (const r of block.receipts) {
    const needle = `${r}\n`;
    const i = t.indexOf(needle);
    if (i < 0) throw new Error('receipt line missing from wrapped text');
    t = t.slice(0, i) + t.slice(i + needle.length);
  }
  return block.trailingNewline ? t : t.slice(0, -1);
}

export const RECEIPT_INSTRUCTION = 'TRANSPORT RECEIPTS: lines of the exact form ⟦RL:<n>:<hex>⟧ are delivery receipts inserted by the controller, NOT content and NOT part of any file (ignore them when counting lines). Your reply JSON MUST contain a field "receipts": an array holding the exact text of EVERY receipt line in the order they appear in this message. A missing, reordered or altered receipt makes the whole reply unusable.';

// Compare the echoed list with the expected one. Returns { ok, class, expectedCount,
// echoedCount, firstMissingIndex }. class: OK | MISSING_FIELD | MISSING | EXTRA | ORDER_OR_VALUE.
export function verifyReceipts(echoed, expected) {
  const expectedCount = expected.length;
  if (!Array.isArray(echoed)) {
    return { ok: false, class: 'MISSING_FIELD', expectedCount, echoedCount: 0, firstMissingIndex: 0 };
  }
  const list = echoed.map((x) => (typeof x === 'string' ? x.trim() : ''));
  const echoedCount = list.length;
  let firstBad = -1;
  for (let i = 0; i < Math.min(expectedCount, echoedCount); i += 1) {
    if (list[i] !== expected[i]) { firstBad = i; break; }
  }
  if (firstBad >= 0) {
    return { ok: false, class: 'ORDER_OR_VALUE', expectedCount, echoedCount, firstMissingIndex: firstBad };
  }
  if (echoedCount < expectedCount) return { ok: false, class: 'MISSING', expectedCount, echoedCount, firstMissingIndex: echoedCount };
  if (echoedCount > expectedCount) return { ok: false, class: 'EXTRA', expectedCount, echoedCount, firstMissingIndex: expectedCount };
  return { ok: true, class: 'OK', expectedCount, echoedCount, firstMissingIndex: -1 };
}

export const isReceiptLine = (line) => RECEIPT_RE.test(String(line ?? ''));
