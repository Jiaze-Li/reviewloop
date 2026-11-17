// Production Reviewer / Supervisor transports for the Codex and Claude
// families.
//
// Both are NARROW, stateless, single-turn inference — never a second coding
// Worker:
//   - run from an isolated empty scratch dir (no repo / AGENTS.md / CLAUDE.md /
//     project / session history to preload)
//   - user config, project rules and MCP servers explicitly disabled
//   - read-only / no tool use, no conversation continuation
//   - bounded wall-clock via runBoundedCli (terminates the process group)
//   - output goes through the SAME strict structured normalization as the agy
//     transport (providerWiring parseJsonish + validate*Payload); malformed ->
//     HUMAN_REQUIRED, never CLEAN/PASS
//
// Authentication has a strict two-boundary treatment:
//   - zero-token LOCAL preflight (`codex login status`, `claude auth status`)
//     decides whether a CLI family is eligible before any model dispatch;
//   - an auth-looking failure AFTER a prompt-bearing invocation starts is
//     AUTH_REJECTED and is NOT proof of zero spend. Token Safety fails closed.
//
// No second retry/failover state machine: one physical attempt per call. The
// controller's meteredWithFailover owns bounded failover; every physical
// attempt is still metered through ModelSpendAuthority upstream.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { narrowReviewTransportCwd } from './scratchCwd.js';
import { runBoundedCli, classifyCliFailure, CliTransportError, CLI_FAILURE, probeCli } from './boundedCli.js';
import {
  MANAGED_SETTINGS_KEYS,
  parseBoundedNumber,
  resolveReviewCallTimeoutMs,
} from '../settingsFile.js';

// Unified wall-clock bound for the zero-token local auth preflight across all
// CLI executables (codex, claude). The 25s value covers Claude Code's heavy
// Node cold start + `claude auth status`, without ever waiting unbounded.
export const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 25_000;
export const MAX_AUTH_PROBE_TIMEOUT_MS = 60_000;
export const AUTH_PROBE_TIMEOUT_ENV = MANAGED_SETTINGS_KEYS.AUTH_PROBE_TIMEOUT_MS;

export function resolveAuthProbeTimeoutMs(env = process.env) {
  return parseBoundedNumber(
    env?.[AUTH_PROBE_TIMEOUT_ENV],
    DEFAULT_AUTH_PROBE_TIMEOUT_MS,
    MAX_AUTH_PROBE_TIMEOUT_MS,
  );
}

async function probeAuthenticatedCli(executable, authArgs, { spawn, env = process.env, timeoutMs } = {}) {
  const bound = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : resolveAuthProbeTimeoutMs(env);
  const version = await probeCli(executable, { spawn, timeoutMs: bound });
  if (!version.available) return version;

  const auth = await runBoundedCli({ executable, args: authArgs, timeoutMs: bound, spawn, env });
  if (auth.spawnErrorCode === 'ENOENT') return { available: false, reason: 'CLI not installed' };
  if (auth.spawnErrorCode) return { available: false, reason: `auth probe failed: ${auth.spawnErrorCode}` };
  if (auth.timedOut) return { available: false, reason: `auth probe timed out after ${bound}ms` };
  if (auth.code !== 0) {
    return { available: false, reason: 'not authenticated', version: version.version, authChecked: true };
  }
  return { available: true, reason: 'ok', version: version.version, authChecked: true };
}

// Zero-token runtime + authentication preflight for the CLI-backed families.
// `codex login status` and `claude auth status` are local account-status
// commands; they do not carry a review prompt or start model inference.
export async function probeReviewTransportRuntime({ spawn, env = process.env } = {}) {
  const [codex, claude] = await Promise.all([
    probeAuthenticatedCli('codex', ['login', 'status'], { spawn, env }),
    probeAuthenticatedCli('claude', ['auth', 'status'], { spawn, env }),
  ]);
  return { 'codex:default': codex, 'claude:opus': claude };
}

function firstNumber(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return undefined;
}

// ---- Codex --------------------------------------------------------------
//
// `codex exec` narrow-mode flags:
//   --ephemeral            no session files persisted
//   --ignore-user-config   do not load $CODEX_HOME/config.toml (instructions)
//   --ignore-rules         do not load user/project execpolicy .rules
//   --skip-git-repo-check  run outside a git repo (scratch cwd)
//   -s read-only           model-generated shell commands cannot write
//   -C <dir>               working root
//   --json                 JSONL event stream (used for token usage)
//   -o <file>              final agent message written here (used for the reply)

export function makeCodexReviewTransport({
  model = null, spawn = nodeSpawn, env = process.env, timeoutMs = resolveReviewCallTimeoutMs(env),
} = {}) {
  return async (prompt, { signal } = {}) => {
    const cwd = narrowReviewTransportCwd();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-codex-'));
    const outFile = path.join(tmp, 'last-message.txt');
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '-s', 'read-only', '-C', cwd,
      '--color', 'never', '--json', '-o', outFile,
    ];
    if (typeof model === 'string' && model.trim() !== '') args.push('-m', model.trim());
    args.push(String(prompt));

    const res = await runBoundedCli({ executable: 'codex', args, cwd, timeoutMs, spawn, env, signal });

    if (res.spawnErrorCode === 'ABORTED') {
      rmSync(tmp, { recursive: true, force: true });
      throw new CliTransportError('codex exec was cancelled', 'REVIEW_CANCELLED', { stderr: res.stderr });
    }
    if (res.timedOut) {
      rmSync(tmp, { recursive: true, force: true });
      throw new CliTransportError(`codex exec exceeded ${timeoutMs}ms`, CLI_FAILURE.TIMEOUT, { stderr: res.stderr });
    }
    if (res.spawnErrorCode || res.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      const code = classifyCliFailure({ code: res.code, stderr: res.stderr, spawnErrorCode: res.spawnErrorCode });
      throw new CliTransportError(`codex exec failed (exit ${res.code ?? res.spawnErrorCode})`, code, { stderr: res.stderr });
    }

    let text = '';
    try { text = readFileSync(outFile, 'utf8'); } catch { text = ''; }
    rmSync(tmp, { recursive: true, force: true });

    // Best-effort token usage from the JSONL event stream. UNKNOWN -> null.
    let usage = null;
    let resolvedModel = model || null;
    for (const line of res.stdout.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const u = ev.usage ?? ev.token_usage ?? ev.total_token_usage ?? ev.msg?.usage ?? ev.info?.total_token_usage;
      if (u && typeof u === 'object') {
        usage = {
          input_tokens: firstNumber(u.input_tokens, u.prompt_tokens, u.input),
          output_tokens: firstNumber(u.output_tokens, u.completion_tokens, u.output),
          cache_read_input_tokens: firstNumber(u.cached_input_tokens, u.cache_read_input_tokens),
        };
      }
      const m = ev.model ?? ev.msg?.model ?? ev.info?.model;
      if (typeof m === 'string' && m) resolvedModel = m;
    }
    if (!text.trim() && !res.stdout.trim()) {
      throw new CliTransportError('codex exec produced no output', CLI_FAILURE.PROTOCOL_ERROR);
    }

    return {
      model: resolvedModel,
      requestedModel: model || null,
      exitCode: 0,
      text: text.trim(),
      json: null,
      usage,
      durationMs: res.durationMs,
      meta: { promptChars: String(prompt ?? '').length },
    };
  };
}

// ---- Claude ------------------------------------------------------------
//
// `claude -p` narrow-mode flags (all verified against the installed CLI's
// `claude --help`, Claude Code 2.1.x):
//   --output-format json                       machine-readable envelope
//   --setting-sources ''                       load NO user/project/local
//                                              settings: no hooks, custom
//                                              agents, output styles, statusline
//   --strict-mcp-config --mcp-config           no MCP servers. The value MUST
//     '{"mcpServers":{}}'                       be an object WITH an mcpServers
//                                              key — a bare "{}" is rejected
//                                              ("Invalid MCP configuration:
//                                              mcpServers: Invalid input",
//                                              exit 1 in ~0.5s). This was the
//                                              root cause of the claude:opus
//                                              PROVIDER_PROTOCOL_ERROR.
//   --tools ''                                 disable ALL built-in tools ->
//                                              strictly read-only, no shell /
//                                              file / web tool schemas loaded
//   --disable-slash-commands                   no skills / slash expansion
//   --no-session-persistence                   never write or resume a session
//   --exclude-dynamic-system-prompt-sections   trims per-machine system-prompt
//                                              sections (cwd/env/memory/git)
//   (run from scratch cwd -> no CLAUDE.md / project context)
//
// Isolation the installed CLI does NOT provide per-call: admin/managed (policy)
// settings still apply, and the built-in `claude -p` base system prompt cannot
// be zeroed without --system-prompt (which would also disable the
// dynamic-section trim). `--bare` would remove more but forces API-key-only
// auth (OAuth / subscription creds are never read), so it is not usable here.
// The `claude` shell alias adds --dangerously-skip-permissions; spawning the
// binary directly (argv, not a shell) never sees that alias.

export function makeClaudeReviewTransport({
  model = null, spawn = nodeSpawn, env = process.env, timeoutMs = resolveReviewCallTimeoutMs(env),
} = {}) {
  return async (prompt, { signal } = {}) => {
    const cwd = narrowReviewTransportCwd();
    const args = [
      '-p', String(prompt),
      '--output-format', 'json',
      '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections',
    ];
    if (typeof model === 'string' && model.trim() !== '') args.push('--model', model.trim());

    const res = await runBoundedCli({ executable: 'claude', args, cwd, timeoutMs, spawn, env, signal });

    if (res.spawnErrorCode === 'ABORTED') {
      throw new CliTransportError('claude -p was cancelled', 'REVIEW_CANCELLED', { stderr: res.stderr });
    }
    if (res.timedOut) {
      throw new CliTransportError(`claude -p exceeded ${timeoutMs}ms`, CLI_FAILURE.TIMEOUT, { stderr: res.stderr });
    }
    if (res.spawnErrorCode) {
      const code = classifyCliFailure({ spawnErrorCode: res.spawnErrorCode });
      throw new CliTransportError(`claude -p failed to spawn (${res.spawnErrorCode})`, code, { stderr: res.stderr });
    }

    let envelope = null;
    const trimmed = res.stdout.trim();
    if (trimmed) { try { envelope = JSON.parse(trimmed); } catch { envelope = null; } }

    if (res.code !== 0 || envelope?.is_error === true || String(envelope?.subtype ?? '').startsWith('error')) {
      const stderrLike = res.stderr || (typeof envelope?.result === 'string' ? envelope.result : trimmed);
      const code = classifyCliFailure({ code: res.code, stderr: stderrLike });
      throw new CliTransportError(`claude -p failed (exit ${res.code}${envelope?.subtype ? `, ${envelope.subtype}` : ''})`, code, { stderr: stderrLike });
    }
    if (!envelope) {
      throw new CliTransportError('claude -p output was not valid JSON', CLI_FAILURE.PROTOCOL_ERROR, { stderr: res.stderr });
    }

    const u = envelope.usage ?? null;
    const usage = u && typeof u === 'object' ? {
      input_tokens: firstNumber(u.input_tokens),
      output_tokens: firstNumber(u.output_tokens),
      cache_read_input_tokens: firstNumber(u.cache_read_input_tokens),
      cache_creation_input_tokens: firstNumber(u.cache_creation_input_tokens),
    } : null;

    return {
      model: envelope.model ?? model ?? null,
      requestedModel: model || null,
      exitCode: 0,
      text: typeof envelope.result === 'string' ? envelope.result : '',
      json: envelope,
      usage,
      costUsd: firstNumber(envelope.total_cost_usd, envelope.cost_usd),
      durationMs: res.durationMs,
      meta: { promptChars: String(prompt ?? '').length },
    };
  };
}
