// agyClient: non-interactive transport to the locally installed Antigravity
// CLI (`agy`, /Users/jack/.local/bin/agy, v1.1.22). It is used by production
// Planner/Supervisor/Reviewer role routes as well as deterministic smoke tests.
//
// Confirmed against the installed binary (`agy --help`, `agy models`):
//   - executable:        `agy` on PATH -> /Users/jack/.local/bin/agy
//   - non-interactive:   `agy --print=<prompt>` (the prompt MUST be attached
//                        to the flag; a detached `agy --print <prompt>` lets
//                        the very next token be swallowed as the prompt)
//   - machine-readable:  `--output-format json` (also: text, stream-json)
//   - structured output: `--json-schema <string|path>` enforces a schema
//   - model selection:   `--model <id>` e.g. gemini-3.7-flash-low
//   - slash expansion:   `--disable-slash-commands` keeps the prompt literal
//   - errors:            non-zero exit status; ENOENT if the binary is absent
//
// Auth: none is read, exported, or managed here. `agy` uses whatever Google
// account is already authenticated on this machine.
//
// Privacy: prompt text and any reply text are never logged by this module.
// The prompt is passed as a single `--print=<prompt>` argv entry (never a
// shell command string, so no quoting/escaping/injection surface); only
// callers decide what to do with the returned text.

import { spawn as nodeSpawn } from 'node:child_process';
import { extractSafeAgyEnvelopeMetadata } from './agyErrorEnvelope.js';
import { agyStderrCarriesUsageEvidence } from './agyUsageEvidence.js';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../orchestrator/processTree.js';

export const DEFAULT_AGY_MODEL = 'gemini-3.7-flash-low';
export const DEFAULT_AGY_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_000_000;

export class AgyError extends Error {
  constructor(message, { code = 'AGY_ERROR', exitCode = 1 } = {}) {
    super(message);
    this.name = 'AgyError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class AgyExecutableNotFoundError extends AgyError {
  constructor(executable) {
    super(`agy executable not found: ${executable}`, { code: 'AGY_ENOENT', exitCode: 127 });
    this.name = 'AgyExecutableNotFoundError';
  }
}

export class AgyTimeoutError extends AgyError {
  constructor(timeoutMs) {
    super(`agy did not respond within ${timeoutMs}ms`, { code: 'AGY_TIMEOUT', exitCode: 124 });
    this.name = 'AgyTimeoutError';
  }
}

export class AgyExitError extends AgyError {
  constructor(exitCode, stderr, { durationMs, stdout } = {}) {
    super(`agy exited with status ${exitCode}`, { code: 'AGY_NONZERO_EXIT', exitCode: exitCode || 1 });
    this.name = 'AgyExitError';
    // Inspect FULL captured diagnostics before any lossy truncation. This
    // boolean/state is content-free and lets upper layers distinguish
    // mechanically-proven zero from reported/unknown token activity.
    const stderrUsagePresent = agyStderrCarriesUsageEvidence(stderr);
    if (Number.isFinite(durationMs)) this.durationMs = durationMs;
    // agy sometimes prints a structured error envelope to stdout before
    // exiting non-zero. Pull ONLY whitelisted operational metadata out of it
    // (status / error_code / model / token usage …) — never generated text.
    // See src/agy/agyErrorEnvelope.js. Absent/non-JSON stdout -> no envelope.
    const envelope = extractSafeAgyEnvelopeMetadata(typeof stdout === 'string' ? stdout : '');
    this.usageEvidenceState = stderrUsagePresent
      ? 'present'
      : envelope.usageEvidenceState;
    this.usageEvidencePresent = this.usageEvidenceState === 'present';

    // stderr from agy is diagnostic (auth / rate-limit / usage), not prompt
    // content — safe to surface, but bounded for error propagation.
    this.stderr = truncate(stderr);
    if (envelope.jsonObject && Object.keys(envelope.fields).length > 0) {
      this.envelope = envelope.fields;
    }
  }
}

export class AgyOutputError extends AgyError {
  constructor(message) {
    super(message, { code: 'AGY_MALFORMED_OUTPUT', exitCode: 65 });
    this.name = 'AgyOutputError';
  }
}

// Raised when a conversation resume was requested (`conversationId`) but `agy`
// could not resume it, or resumed a *different* conversation. ReviewLoop needs
// explicit turn-to-turn continuity, so any ambiguity here fails closed.
export class AgyConversationResumeError extends AgyError {
  constructor(message) {
    super(message, { code: 'AGY_CONVERSATION_RESUME_FAILED', exitCode: 69 });
    this.name = 'AgyConversationResumeError';
  }
}

// stderr wording that means "the conversation id you asked me to resume does
// not exist". agy's exact phrasing is version-dependent; match loosely.
const CONVERSATION_NOT_FOUND_RE = /conversation\b[^\n]*\b(not\s*found|does\s*not\s*exist|unknown|no\s*such|invalid)/i;

// Pull the conversation id out of the json envelope, tolerant of field naming.
function extractConversationId(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.conversation_id,
    json.conversationId,
    json.conversation && json.conversation.id,
    json.session_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

function truncate(text) {
  if (typeof text !== 'string') return '';
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

// Pull the assistant text out of whatever envelope `agy --output-format
// json` produced. Tolerant of field naming since the exact envelope is
// version-dependent; the deterministic tests pin the shapes we handle.
function extractText(json) {
  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') return null;
  const candidates = [json.result, json.text, json.response, json.message, json.output, json.content];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

// Recover the concrete model id from the agy json envelope when the caller
// omitted --model (dynamic provider-default resolution). Tolerant of field
// naming; returns null when the envelope does not report one.
function extractModel(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [json.model, json.model_id, json.modelId, json.usage?.model, json.meta?.model];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return null;
}

/**
 * Run one non-interactive `agy` prompt and return a normalized result.
 *
 * @param {object} opts
 * @param {string} opts.prompt              prompt text (required, non-empty)
 * @param {string} [opts.model]             model id (see `agy models`)
 * @param {number} [opts.timeoutMs]         hard wall-clock cap
 * @param {string} [opts.executable]        binary name/path (default "agy")
 * @param {string} [opts.jsonSchema]        value for --json-schema
 * @param {string} [opts.conversationId]    resume this conversation (fail-closed)
 * @param {boolean} [opts.disableSlashCommands] disable agy slash/skill expansion
 * @param {string} [opts.agent]             optional dedicated agy agent name
 * @param {string} [opts.geminiDir]         optional isolated gemini dir
 *   (passed as `--gemini_dir=<path>`). Used by ReviewLoop to point agy at a
 *   redirected config tree that holds ONLY the `reviewloop-minimal` agent and
 *   never touches the user's real `~/.gemini`.
 * @param {string} [opts.logFile]           optional agy `--log-file` path, so
 *   the caller can verify which agent agy actually activated for the run.
 * @param {string} [opts.cwd]               working dir for the child
 * @param {Function} [opts.spawn]           injectable spawn (for tests)
 * @param {AbortSignal} [opts.signal]       stops the owned agy process group and waits for teardown
 * @returns {Promise<{model:string, exitCode:number, text:string|null,
 *                     json:any, stdout:string, durationMs:number,
 *                     conversationId:string|null}>}
 */
export async function callAgy({
  prompt,
  model = DEFAULT_AGY_MODEL,
  timeoutMs = DEFAULT_AGY_TIMEOUT_MS,
  executable = 'agy',
  jsonSchema,
  conversationId,
  disableSlashCommands = true,
  agent,
  geminiDir,
  logFile,
  cwd,
  spawn = nodeSpawn,
  signal,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AgyError('callAgy requires a non-empty prompt string', { code: 'AGY_BAD_INPUT' });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgyError('callAgy requires a positive timeoutMs', { code: 'AGY_BAD_INPUT' });
  }
  if (signal?.aborted) {
    throw new AgyError('agy call cancelled', { code: 'AGY_ABORTED' });
  }
  const resumeConversationId =
    typeof conversationId === 'string' && conversationId.trim() !== '' ? conversationId.trim() : null;
  if (conversationId !== undefined && resumeConversationId === null) {
    throw new AgyError('callAgy conversationId must be a non-empty string when provided', {
      code: 'AGY_BAD_INPUT',
    });
  }

  // agy v1.1.22: the prompt MUST be attached to the flag as `--print=<prompt>`.
  // With a detached `--print <prompt>` the parser takes the *next token*
  // (e.g. `--output-format`) as the prompt and silently ignores the real one.
  // Attaching it also means every other flag is an ordinary flag that cannot
  // be consumed as the prompt, regardless of ordering.
  // `model` null / '' -> omit --model entirely so `agy` picks its own current
  // default (dynamic family resolution's provider-default path). A concrete id
  // is passed through verbatim.
  const args = [
    `--print=${prompt}`,
    '--output-format', 'json',
  ];
  if (typeof model === 'string' && model.trim() !== '') args.push('--model', model.trim());
  if (disableSlashCommands) args.push('--disable-slash-commands');
  if (typeof agent === 'string' && agent.trim() !== '') args.push('--agent', agent.trim());
  // Attached form so the path can never be misparsed as a following flag.
  if (typeof geminiDir === 'string' && geminiDir.trim() !== '') args.push(`--gemini_dir=${geminiDir.trim()}`);
  if (typeof logFile === 'string' && logFile.trim() !== '') args.push('--log-file', logFile.trim());
  if (typeof jsonSchema === 'string' && jsonSchema.length > 0) {
    args.push('--json-schema', jsonSchema);
  }
  // Attached form (`--conversation=<id>`) for the same reason as --print: the
  // id can never be misparsed as a following flag regardless of ordering.
  if (resumeConversationId !== null) {
    args.push(`--conversation=${resumeConversationId}`);
  }

  const startedAt = Date.now();

  const { code, stdout, stderr, timedOut, spawnError, aborted } = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // AGY_CLI_DISABLE_AUTO_UPDATE: agy ships a background self-updater
        // (google3/third_party/jetski/cli/updater). Under ReviewLoop's
        // concurrent/rapid invocation pattern (many short-lived agy calls in
        // a pool), independent processes can each race to spawn their own
        // updater child at ~the same time; a historical agy changelog entry
        // ("Fixed a background auto-updater double-spawn race ...") shows
        // this exact race existed for two concurrent processes and was only
        // partially addressed. Under N-way concurrency it can still cascade
        // into an unbounded fork storm (observed: CPU pegged, PID space
        // wrapping within minutes, Mac overheating to 90+C). agy has no use
        // for self-updating when invoked non-interactively by ReviewLoop, so
        // disable it unconditionally for every spawn.
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
        ...PROCESS_GROUP_SPAWN_OPTS,
      });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timer;
    let aborted = false;
    let timedOut = false;
    let treeTermination = null;

    const tearDownTree = () => {
      if (!treeTermination) treeTermination = terminateProcessTree(child);
      return treeTermination;
    };

    const finish = async (result, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (awaitTree && treeTermination) await treeTermination.done;
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      try { tearDownTree(); } catch {}
      void finish({ aborted: true }, { awaitTree: true });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try { tearDownTree(); } catch {}
      void finish({ timedOut: true }, { awaitTree: true });
    }, timeoutMs);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      void finish({ spawnError: err, aborted, timedOut }, { awaitTree: aborted || timedOut });
    });
    child.stdout?.on('data', (chunk) => {
      if (outBytes < MAX_CAPTURE_BYTES) { outChunks.push(chunk); outBytes += chunk.length; }
    });
    child.stderr?.on('data', (chunk) => {
      if (errBytes < MAX_CAPTURE_BYTES) { errChunks.push(chunk); errBytes += chunk.length; }
    });
    child.on('close', (closeCode) => {
      void finish({
        code: closeCode,
        aborted,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      }, { awaitTree: aborted || timedOut });
    });
  });

  if (spawnError) {
    if (spawnError && spawnError.code === 'ENOENT') {
      throw new AgyExecutableNotFoundError(executable);
    }
    throw new AgyError(`failed to spawn agy: ${spawnError.message}`, { code: 'AGY_SPAWN_FAILED' });
  }
  if (timedOut) {
    throw new AgyTimeoutError(timeoutMs);
  }
  if (aborted || signal?.aborted) {
    throw new AgyError('agy call cancelled', { code: 'AGY_ABORTED' });
  }
  if (code !== 0) {
    // A resume that failed because the id is unknown must surface as a
    // resume failure, not a generic non-zero exit.
    if (resumeConversationId !== null && CONVERSATION_NOT_FOUND_RE.test(stderr || '')) {
      throw new AgyConversationResumeError(
        `agy could not resume conversation ${resumeConversationId}: ${truncate(stderr)}`,
      );
    }
    throw new AgyExitError(code, stderr, { durationMs: Date.now() - startedAt, stdout });
  }

  const trimmed = (stdout || '').trim();
  if (trimmed === '') {
    throw new AgyOutputError('agy produced no stdout');
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new AgyOutputError('agy stdout was not valid JSON');
  }

  const returnedConversationId = extractConversationId(json);

  if (resumeConversationId !== null) {
    if (returnedConversationId === null) {
      throw new AgyConversationResumeError(
        `agy resumed conversation ${resumeConversationId} but returned no conversation_id`,
      );
    }
    if (returnedConversationId !== resumeConversationId) {
      throw new AgyConversationResumeError(
        `agy resumed a different conversation: expected ${resumeConversationId}, got ${returnedConversationId}`,
      );
    }
  }

  const usage = json && typeof json === 'object' && json.usage && typeof json.usage === 'object' ? json.usage : null;

  return {
    // The concrete model actually used: the explicit id when one was passed,
    // otherwise whatever the provider envelope reports it resolved to.
    model: (typeof model === 'string' && model.trim() !== '' ? model.trim() : null) ?? extractModel(json),
    requestedModel: (typeof model === 'string' && model.trim() !== '' ? model.trim() : null),
    exitCode: code,
    text: extractText(json),
    json,
    stdout: trimmed,
    durationMs: Date.now() - startedAt,
    conversationId: returnedConversationId,
    usage,
  };
}
