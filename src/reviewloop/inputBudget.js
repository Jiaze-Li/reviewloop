// Pre-dispatch input budget for Design review prompts (Plan R02, AC-01/03).
//
// The whole final prompt string is measured BEFORE any evidence registration,
// spend reservation or physical call. Over budget => zero calls and a structured
// INPUT_TOO_LARGE stop. Nothing is ever truncated to fit.
//
// The budget is the smaller of two independent bounds:
//   1. a spend-side bound: estimated input tokens (ceil(utf8 bytes / 3), a
//      conservative estimate even for CJK text) must stay within 80% of the
//      effective single-call usage threshold. That threshold is the existing
//      Token Sentinel limit and is NOT changed here; being post-settlement, it is
//      only one conservative upper bound, never a statement of transport capacity.
//   2. a transport bound: every adapter passes the whole prompt as ONE argv entry.
//      The local operating-system limit for such an entry is measured with a
//      zero-cost, no-model probe (half of the largest accepted size). This proves
//      only that the local process can hand the bytes over, NOT that any provider
//      server receives and processes them: provider limits are NOT_VERIFIED.
//
// Pure functions except `probeArgvEnvelope`, which spawns the current Node
// binary (no model, no network).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const TOKEN_BUDGET_FRACTION = 0.8;
export const BYTES_PER_TOKEN_ESTIMATE = 3;
// Used when the local probe could not run: deliberately small, labelled unverified.
export const DEFAULT_UNVERIFIED_INPUT_LIMIT = 100_000;
const PROBE_LOW = 4 * 1024;
const PROBE_HIGH = 8 * 1024 * 1024;

export const utf8Bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
export const estimateInputTokens = (bytes) => Math.ceil(Number(bytes) / BYTES_PER_TOKEN_ESTIMATE);
export const sha256Hex = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');

let probeCache = null;

// Largest single argv entry the OS accepts for a child process, halved. Binary
// search over spawnSync of the current Node binary running an empty program.
export function probeArgvEnvelope({ spawnFn = spawnSync, execPath = process.execPath, force = false } = {}) {
  if (probeCache && !force) return probeCache;
  const accepts = (n) => {
    const r = spawnFn(execPath, ['-e', '0', 'x'.repeat(n)], { stdio: 'ignore', timeout: 10_000 });
    return !r.error && r.status === 0;
  };
  let result;
  try {
    if (!accepts(PROBE_LOW)) throw new Error('baseline argv size refused');
    let lo = PROBE_LOW;
    let hi = PROBE_HIGH;
    if (accepts(hi)) lo = hi;
    else {
      while (hi - lo > 16 * 1024) {
        const mid = Math.floor((lo + hi) / 2);
        if (accepts(mid)) lo = mid; else hi = mid;
      }
    }
    result = { value: Math.floor(lo / 2), source: 'MEASURED_LOCAL', measuredMax: lo, probedExecutable: 'node' };
  } catch {
    result = { value: DEFAULT_UNVERIFIED_INPUT_LIMIT, source: 'DEFAULT_UNVERIFIED', measuredMax: null, probedExecutable: null };
  }
  probeCache = result;
  return result;
}

export function resetArgvProbeForTests() { probeCache = null; }

// `maxSingleCallUsage`: the effective Token Sentinel single-call threshold in
// force for this loop (from the spend telemetry limits). `candidateLimits`:
// optional `[{family, value, source}]` per-family transport limits; the STRICTEST
// one across the whole candidate chain wins, so a failover candidate is never
// sent more than the tightest candidate accepts.
export function resolveInputBudget({ maxSingleCallUsage, localEnvelope = null, candidateLimits = [] }) {
  const parts = [];
  if (Number.isFinite(maxSingleCallUsage) && maxSingleCallUsage > 0) {
    parts.push({
      limit: Math.floor(TOKEN_BUDGET_FRACTION * maxSingleCallUsage) * BYTES_PER_TOKEN_ESTIMATE,
      source: 'TOKEN_BUDGET',
    });
  }
  const local = localEnvelope ?? { value: DEFAULT_UNVERIFIED_INPUT_LIMIT, source: 'DEFAULT_UNVERIFIED' };
  parts.push({ limit: local.value, source: `TRANSPORT_${local.source}` });
  for (const c of candidateLimits) {
    const value = Number.isFinite(c?.value) ? c.value : DEFAULT_UNVERIFIED_INPUT_LIMIT;
    parts.push({ limit: value, source: `CANDIDATE_${c?.source ?? 'DEFAULT_UNVERIFIED'}${c?.family ? `:${c.family}` : ''}` });
  }
  const tightest = parts.reduce((a, b) => (b.limit < a.limit ? b : a));
  return { limitBytes: tightest.limit, source: tightest.source, bounds: parts };
}

// Component byte sizes of one prompt. Callers pass the labelled parts they used;
// everything else (instructions, framing) is the remainder.
export function measurePrompt(prompt, components = {}) {
  const bytes = utf8Bytes(prompt);
  const sizes = {};
  let named = 0;
  for (const [k, v] of Object.entries(components)) {
    const n = typeof v === 'number' ? v : utf8Bytes(v);
    sizes[k] = n;
    named += n;
  }
  sizes.instructions = Math.max(0, bytes - named);
  return { bytes, estimatedTokens: estimateInputTokens(bytes), components: sizes };
}

export class InputBudgetError extends Error {
  constructor(detail) {
    super(`input too large: ${detail.bytes} bytes exceeds the ${detail.limitBytes}-byte budget (${detail.source})`);
    this.name = 'InputBudgetError';
    this.code = 'INPUT_TOO_LARGE';
    this.detail = detail;
  }
}

// Throws InputBudgetError when the prompt exceeds the budget. Never trims.
export function assertPromptWithinBudget(prompt, components, budget) {
  const m = measurePrompt(prompt, components);
  if (m.bytes > budget.limitBytes) {
    const fixed = (m.components.plan ?? 0) + (m.components.design ?? 0) + (m.components.proposals ?? 0) + m.components.instructions;
    throw new InputBudgetError({
      bytes: m.bytes,
      limitBytes: budget.limitBytes,
      source: budget.source,
      components: m.components,
      // Which side caused the overflow: the fixed material (plan/design/proposals/
      // instructions) alone, or the selected source evidence on top of it.
      overflowCause: fixed > budget.limitBytes ? 'FIXED_MATERIAL' : 'EVIDENCE',
    });
  }
  return m;
}
