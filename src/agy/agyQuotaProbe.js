// Read AGY's zero-model-turn /usage command before Reviewer/Supervisor routing.
// This is only an optional quota hint: unsupported CLI versions, malformed replies,
// and unreachable quota services NEVER imply zero usage or available quota.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { narrowReviewTransportCwd, narrowAgyGeminiDir } from '../reviewloop/adapters/scratchCwd.js';

const DEFAULT_TTL_MS = 90_000; // Short retry throttle for unavailable/unsupported probes.
const SUCCESS_REFRESH_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_MAX_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

function supportsHeadlessUsage(version) {
  const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.exec(String(version));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

function poolForGroup(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (name === 'claude and gpt models') return 'agy-claude-gpt';
  if (name === 'gemini models') return 'agy-gemini';
  return null;
}

/** Recognize ONLY the supported zero-turn structured command envelope. */
function parseAgyQuotaSnapshot(stdout, nowMs = Date.now()) {
  let payload;
  try { payload = JSON.parse(String(stdout)); } catch { return null; }
  if (!payload || payload.status !== 'SUCCESS' || payload.num_turns !== 0
    || payload.usage?.total_tokens !== 0
    || !/^(?:\/)?(?:usage|quota)$/.test(String(payload.command?.name ?? '').toLowerCase())
    || !Array.isArray(payload.command?.data?.groups)) return null;

  const exhausted = [];
  const availablePools = new Set();
  const exhaustedPoolIds = new Set();
  let recognized = false;
  for (const group of payload.command.data.groups) {
    const poolId = poolForGroup(group?.name ?? group?.label ?? group?.title);
    if (!poolId || !Array.isArray(group.buckets) || group.buckets.length === 0) continue;
    const valid = group.buckets.filter((bucket) => (
      bucket && typeof bucket.remaining_fraction === 'number'
      && Number.isFinite(bucket.remaining_fraction)
      && bucket.remaining_fraction >= 0 && bucket.remaining_fraction <= 1
    ));
    const empty = valid.filter((bucket) => bucket.remaining_fraction === 0);
    if (empty.length === 0) {
      // Releasing a cooldown requires ALL windows to be explicitly nonzero.
      // A missing window must never be interpreted as quota recovery.
      if (valid.length === group.buckets.length) {
        recognized = true;
        availablePools.add(poolId);
      }
      continue;
    }
    // Any explicitly exhausted window is still useful even if another
    // bucket is malformed; preserve the former conservative quota detection.
    recognized = true;
    exhaustedPoolIds.add(poolId);
    const resets = empty.map((bucket) => Date.parse(bucket.reset_time ?? ''))
      .filter((value) => Number.isFinite(value) && value > nowMs && value <= nowMs + 8 * 86_400_000);
    // Every exhausted window must reset before this group becomes usable.
    const resetAt = resets.length === empty.length ? new Date(Math.max(...resets)).toISOString() : null;
    exhausted.push({ poolId, resetAt });
  }
  if (!recognized) return null;
  return { exhausted, availablePools: [...availablePools].filter((id) => !exhaustedPoolIds.has(id)) };
}

/** The historic parser interface returns only depleted pools. */
export function parseAgyQuotaUsage(stdout, nowMs = Date.now()) {
  return parseAgyQuotaSnapshot(stdout, nowMs)?.exhausted ?? null;
}

/**
 * Called immediately before choosing the first physical model for a logical
 * review. The version guard is critical: older AGY builds treated /usage as
 * a normal prompt, which would accidentally spend tokens during a "probe".
 */
export function createAgyQuotaPreflight({
  quotaRegistry,
  exec = execFileAsync,
  executable = 'agy',
  env = process.env,
  geminiDir = narrowAgyGeminiDir(),
  cwd = narrowReviewTransportCwd(),
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  let nextCheckAt = 0;
  return async function preflightQuota() {
    const t = now();
    if (t < nextCheckAt) return { checked: false, reason: 'cached' };
    const last = quotaRegistry.lastUsageCheck();
    const lastAt = Date.parse(last?.checkedAt ?? '');
    const resetAt = Date.parse(last?.nextResetAt ?? '');
    // The read-only snapshot is shared across MCP restarts. Check at least
    // every 24h, or as soon as a previously reported quota reset is due.
    const recent = Number.isFinite(lastAt) && t >= lastAt && t - lastAt < SUCCESS_REFRESH_MS;
    const resetDue = Number.isFinite(resetAt) && t >= resetAt
      && (!Number.isFinite(lastAt) || lastAt < resetAt);
    if (recent && !resetDue) return { checked: false, reason: 'cached' };
    // Failed queries are retried after a short throttle, without fabricating
    // a successful snapshot or interfering with the existing routing ledger.
    nextCheckAt = t + ttlMs;
    const options = {
      cwd,
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    try {
      // Async process execution keeps the MCP event loop responsive during the
      // quota API request; test fakes may return a plain string instead.
      const versionResult = await exec(executable, ['--version'], options);
      const version = typeof versionResult === 'string' ? versionResult : versionResult?.stdout;
      if (!supportsHeadlessUsage(version)) {
        return { checked: false, reason: 'unsupported_version' };
      }
      // Attached --print form: do not pass --disable-slash-commands here.
      const queryResult = await exec(executable, [
        '--print=/usage', '--output-format', 'json', `--gemini_dir=${geminiDir}`,
      ], options);
      const output = typeof queryResult === 'string' ? queryResult : queryResult?.stdout;
      const snapshot = parseAgyQuotaSnapshot(output, t);
      if (!snapshot) return { checked: false, reason: 'unknown_response' };
      const exhausted = snapshot.exhausted;
      // If a promotional quota reset occurred early, release ONLY a cooldown
      // previously established by /usage itself. A provider's model-specific
      // quota rejection remains authoritative and must not be cleared here.
      for (const poolId of snapshot.availablePools) {
        const current = quotaRegistry.get(poolId);
        if (current.source === 'agy_usage_preflight'
          && (current.status === 'COOLDOWN' || current.status === 'UNKNOWN')) {
          quotaRegistry.recordReady(poolId, { source: 'agy_usage_preflight', onlyIfSource: 'agy_usage_preflight' });
        }
      }
      for (const { poolId, resetAt } of exhausted) {
        const current = quotaRegistry.get(poolId);
        // Avoid a durable state rewrite and incrementing the failure counter
        // for an unchanged /usage quota window on every periodic refresh.
        if (current.status === 'COOLDOWN' && current.source === 'agy_usage_preflight'
          && (resetAt === null || current.resetAt === resetAt)) continue;
        quotaRegistry.recordCooldown(poolId, { reason: 'quota_exhausted', resetAt, source: 'agy_usage_preflight' });
      }
      const upcoming = exhausted.map(({ resetAt }) => Date.parse(resetAt ?? ''))
        .filter((value) => Number.isFinite(value) && value > t);
      quotaRegistry.recordUsageCheck({
        checkedAt: new Date(t).toISOString(),
        nextResetAt: upcoming.length ? new Date(Math.min(...upcoming)).toISOString() : null,
      });
      return { checked: true, exhaustedPools: exhausted.map((entry) => entry.poolId) };
    } catch {
      // A failed read is NOT permission to bypass unresolved-spend protection.
      return { checked: false, reason: 'probe_unavailable' };
    }
  };
}
