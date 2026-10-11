// Read AGY's zero-model-turn /usage command before Reviewer/Supervisor routing.
// This is only an optional quota hint: unsupported CLI versions, malformed replies,
// and unreachable quota services NEVER imply zero usage or available quota.
import { execFileSync } from 'node:child_process';
import { narrowReviewTransportCwd, narrowAgyGeminiDir } from '../reviewloop/adapters/scratchCwd.js';

const DEFAULT_TTL_MS = 90_000;
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_MAX_BYTES = 256 * 1024;

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

/** Recognize ONLY the supported structured CLI command reply, never free text. */
export function parseAgyQuotaUsage(stdout, nowMs = Date.now()) {
  let payload;
  try { payload = JSON.parse(String(stdout)); } catch { return null; }
  if (!payload || payload.status !== 'SUCCESS' || payload.num_turns !== 0
    || payload.usage?.total_tokens !== 0
    || !/^(?:\/)?(?:usage|quota)$/.test(String(payload.command?.name ?? '').toLowerCase())
    || !Array.isArray(payload.command?.data?.groups)) return null;

  const records = [];
  for (const group of payload.command.data.groups) {
    const poolId = poolForGroup(group?.name ?? group?.label ?? group?.title);
    if (!poolId || !Array.isArray(group.buckets)) continue;
    const exhausted = group.buckets.filter((bucket) => (
      bucket && typeof bucket.remaining_fraction === 'number'
      && Number.isFinite(bucket.remaining_fraction) && bucket.remaining_fraction === 0
    ));
    if (exhausted.length === 0) continue;
    const resets = exhausted.map((bucket) => Date.parse(bucket.reset_time ?? ''))
      .filter((value) => Number.isFinite(value) && value > nowMs && value <= nowMs + 8 * 86_400_000);
    // Every exhausted window must reset before the group becomes usable.
    const resetAt = resets.length === exhausted.length ? new Date(Math.max(...resets)).toISOString() : null;
    records.push({ poolId, resetAt });
  }
  return records;
}

/**
 * Called immediately before choosing the first physical model for a logical
 * review. The version guard is critical: older AGY builds treated /usage as
 * a normal prompt, which would accidentally spend tokens during a "probe".
 */
export function createAgyQuotaPreflight({
  quotaRegistry,
  exec = execFileSync,
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
    // Throttle both successful and failed queries; never hammer the auth service.
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
      if (!supportsHeadlessUsage(exec(executable, ['--version'], options))) {
        return { checked: false, reason: 'unsupported_version' };
      }
      // Attached --print form: do not pass --disable-slash-commands here.
      const output = exec(executable, [
        '--print=/usage', '--output-format', 'json', `--gemini_dir=${geminiDir}`,
      ], options);
      const exhausted = parseAgyQuotaUsage(output, t);
      if (!exhausted) return { checked: false, reason: 'unknown_response' };
      for (const { poolId, resetAt } of exhausted) {
        quotaRegistry.recordCooldown(poolId, { reason: 'quota_exhausted', resetAt, source: 'agy_usage_preflight' });
      }
      return { checked: true, exhaustedPools: exhausted.map((entry) => entry.poolId) };
    } catch {
      // A failed read is NOT permission to bypass unresolved-spend protection.
      return { checked: false, reason: 'probe_unavailable' };
    }
  };
}
