// ReviewLoop deterministic Gate.
//
//   Gate model tokens = 0
//
// The Gate is independent verification evidence. It does NOT tell the Worker
// which commands the Worker may run — the Worker uses its host's normal
// permissions. The Gate only runs a small, trusted, deterministic command set
// and reports PASS / FAIL with a fingerprint.
//
// Verification discovery priority (§9):
//   1. explicit trusted/user configuration (objective.verificationCommands)
//   2. ReviewLoop repo config (.reviewloop.json "verify")
//   3. deterministic manifest discovery (package.json "test" script)
//   4. minimal mechanical checks (git diff --check)

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { collectFailureIdentities } from '../orchestrator/gateFailureIdentity.js';
import { diffBaselineFailures, BASELINE_DIFF_VERDICTS } from '../orchestrator/baselineDiffGate.js';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../orchestrator/processTree.js';
import { parsePositiveNumber } from './settingsFile.js';

export const GATE_VERDICTS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN' });

// A hung Gate command must terminate deterministically rather than block the
// review forever. Configured via GATE_TIMEOUT_MS in reviewloop.settings.json.
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;
export const GATE_TIMEOUT_EXIT_CODE = 124;

function resolveGateTimeoutMs(env) {
  return parsePositiveNumber(env?.REVIEWLOOP_GATE_TIMEOUT_MS, DEFAULT_GATE_TIMEOUT_MS);
}

// `manifestFingerprint` digests exactly the bytes/values the plan was derived
// from, so reviewloop_begin can FREEZE the plan and a later reviewloop_review
// can detect that the Worker rewrote `.reviewloop.json` / the `test` script.
function planFp(discriminator) {
  return createHash('sha256').update(discriminator).digest('hex').slice(0, 32);
}

export function discoverVerificationCommands({ cwd, configured = null } = {}) {
  if (Array.isArray(configured) && configured.length) {
    const commands = configured.map(String);
    return { source: 'configured', commands, manifestFingerprint: planFp(`configured::${JSON.stringify(commands)}`) };
  }
  const repoConfig = path.join(cwd, '.reviewloop.json');
  if (existsSync(repoConfig)) {
    try {
      const rawText = readFileSync(repoConfig, 'utf8');
      const parsed = JSON.parse(rawText);
      const verify = parsed?.verify ?? parsed?.verification_commands;
      if (Array.isArray(verify) && verify.length) {
        return { source: 'repo-config', commands: verify.map(String), manifestFingerprint: planFp(`repo-config::${rawText}`) };
      }
    } catch {
      /* fall through to manifest discovery */
    }
  }
  const pkgPath = path.join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg?.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
        return { source: 'package.json', commands: ['npm test'], manifestFingerprint: planFp(`package.json::test::${pkg.scripts.test}`) };
      }
    } catch {
      /* fall through */
    }
  }
  // Minimal mechanical check — never invents a dangerous command.
  return { source: 'mechanical', commands: ['git diff --check'], manifestFingerprint: planFp('mechanical') };
}

function runCommand(command, cwd, spawn, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ command, exitCode: GATE_TIMEOUT_EXIT_CODE, aborted: true, stdout: '', stderr: 'ReviewLoop Gate: aborted before start' });
      return;
    }
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], ...PROCESS_GROUP_SPAWN_OPTS,
      });
    } catch (e) {
      resolve({ command, exitCode: 127, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    // Cap stdout/stderr AS chunks arrive — not only when slicing the joined
    // string at the end. A verification command that streams hundreds of MB
    // (a runaway test loop, a progress spinner) would otherwise pin all of it
    // in memory until the process exits and could OOM the MCP host before the
    // Gate timeout fires. 400_000 bytes per stream is 2x the 200_000-char
    // result cap — enough headroom for multi-byte UTF-8 — and no more.
    const STREAM_CAP_BYTES = 400_000;
    const out = [];
    const err = [];
    const outRun = { n: 0 };
    const errRun = { n: 0 };
    const capture = (buckets, running, chunk) => {
      if (running.n >= STREAM_CAP_BYTES) return;
      const room = STREAM_CAP_BYTES - running.n;
      buckets.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      running.n += chunk.length;
    };
    let settled = false;
    let timer = null;
    let teardown = null;
    let timedOut = false;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (teardown) await teardown.done;
      resolve(result);
    };

    // Keep the Gate's teardown bound tight: a hung/zombie descendant must not
    // stretch a short Gate timeout into a many-second wait (the Gate contract is
    // deterministic + fast). graceMs + hardBoundMs stays well under the review's
    // own timeout budget and the test's <5s expectation.
    const GATE_TEARDOWN = { graceMs: 1000, hardBoundMs: 1500 };

    const onAbort = () => {
      if (settled) return;
      teardown = terminateProcessTree(child, GATE_TEARDOWN);
      void finish({
        command,
        exitCode: GATE_TIMEOUT_EXIT_CODE,
        aborted: true,
        stdout: Buffer.concat(out).toString('utf8').slice(0, 200_000),
        stderr: `${Buffer.concat(err).toString('utf8').slice(0, 200_000)}\nReviewLoop Gate: review was cancelled; command terminated`,
      });
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      // Whole-process-tree teardown: a Gate shell may itself have spawned a
      // long-running verification subprocess. Signalling only the direct child
      // leaves that descendant running.
      teardown = terminateProcessTree(child, GATE_TEARDOWN);
      void finish({
        command,
        exitCode: GATE_TIMEOUT_EXIT_CODE,
        timedOut: true,
        stdout: Buffer.concat(out).toString('utf8').slice(0, 200_000),
        stderr: `${Buffer.concat(err).toString('utf8').slice(0, 200_000)}\nReviewLoop Gate: command exceeded ${timeoutMs}ms and was terminated`,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (d) => capture(out, outRun, d));
    child.stderr?.on('data', (d) => capture(err, errRun, d));
    child.on('error', (e) => finish({ command, exitCode: 127, stdout: '', stderr: String(e?.message ?? e), timedOut }));
    child.on('close', (code) => finish({
      command,
      exitCode: timedOut ? GATE_TIMEOUT_EXIT_CODE : (code ?? 0),
      timedOut,
      stdout: Buffer.concat(out).toString('utf8').slice(0, 200_000),
      stderr: Buffer.concat(err).toString('utf8').slice(0, 200_000),
    }));
  });
}

// Run the discovered commands. `runner` is injectable for deterministic tests.
export async function runGate({
  cwd,
  commands,
  spawn = nodeSpawn,
  runner = null,
  baselineGateEvidence = null,
  env = process.env,
  timeoutMs = null,
  signal = null,
} = {}) {
  const gateTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : resolveGateTimeoutMs(env);
  const exec = runner
    ? (cmd) => runner(cmd, cwd, { signal })
    : (cmd) => runCommand(cmd, cwd, spawn, gateTimeoutMs, signal);

  const results = [];
  for (const command of commands) {
    if (signal?.aborted) {
      // The MCP client cancelled the review. Stop launching further Gate
      // commands and fail closed — a cancelled Gate never reports PASS.
      results.push({ command, exitCode: GATE_TIMEOUT_EXIT_CODE, aborted: true, stdout: '', stderr: 'ReviewLoop Gate: review cancelled' });
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await exec(command);
    results.push({
      ...r,
      pass: (r.exitCode ?? 0) === 0,
      timedOut: r.timedOut === true,
      // gateFailureIdentity.js reads `output`.
      output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    });
  }
  const rawPass = results.every((r) => r.pass);
  const evidence = { results, pass: rawPass };
  const failureIdentities = collectFailureIdentities(evidence).identities;
  const fingerprint = failureIdentities.length
    ? failureIdentities.slice().sort().join('|')
    : `pass:${commands.join(',')}`;

  let verdict = rawPass ? GATE_VERDICTS.PASS : GATE_VERDICTS.FAIL;
  let baselineDiff = null;
  if (!rawPass && baselineGateEvidence) {
    baselineDiff = diffBaselineFailures(baselineGateEvidence, evidence);
    // Only newly-introduced failures are a real regression; a run that is red
    // ONLY because of failures the baseline already had degrades FAIL -> WARN
    // (V2 baseline-diff gate lesson). An unparseable / uncomparable failure
    // stays FAIL (conservative).
    if (baselineDiff.verdict === BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES
      || baselineDiff.verdict === BASELINE_DIFF_VERDICTS.PASS) {
      verdict = GATE_VERDICTS.WARN;
    }
  }

  return {
    verdict,
    pass: verdict === GATE_VERDICTS.PASS,
    fingerprint,
    failureIdentities,
    // Full evidence (with complete stdout/stderr) — used ONLY for baseline
    // capture / baseline-diff, never echoed wholesale to the Worker.
    evidence,
    results: results.map((r) => ({
      command: r.command,
      exitCode: r.exitCode,
      pass: r.pass,
      timedOut: r.timedOut === true,
      stdoutTail: String(r.stdout ?? '').slice(-2000),
      stderrTail: String(r.stderr ?? '').slice(-2000),
    })),
    baselineDiff,
    commandSource: null,
  };
}
