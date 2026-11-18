// Agent wake adapter for PR Task (`taskType: 'pr'`).
//
// Zero LLM calls. Builds controlled resume commands for supported local agent
// CLIs (`claude`, `codex`) when `autoWake` is authorized and an `agentSessionId`
// is present; otherwise degrades explicitly to `MANUAL_REQUIRED`.

import { spawn } from 'node:child_process';

export const SUPPORTED_WAKE_AGENTS = Object.freeze(['claude', 'codex']);

export function buildPrWakeContextPrompt({ loopId, prTask }) {
  const session = prTask?.latestBotSession ?? {};
  const openFindings = Array.isArray(session.openFindings) ? session.openFindings : [];
  const postedCount = (prTask?.reviewTriggers ?? []).filter((t) => t.status === 'POSTED').length;
  const findingSummary = openFindings.length
    ? openFindings.slice(0, 10).map((f) => `${f.id} (${f.severity}) ${f.title}`.trim()).join('; ')
    : '(none)';

  return [
    `ReviewLoop PR Task update for loopId=${loopId}.`,
    `Repo: ${prTask?.repoFullName ?? 'unknown'} PR #${prTask?.prNumber ?? '?'}`,
    `Bound HEAD: ${prTask?.boundHeadSha ?? 'unknown'}`,
    `Bot status: ${session.sessionStatus ?? 'UNKNOWN'} (lastReviewedHead=${session.lastReviewedHead ?? 'none'})`,
    `Open findings (${openFindings.length}): ${findingSummary}`,
    `Review triggers used: ${postedCount}/3`,
    `Call reviewloop_review({ loopId: "${loopId}" }) and handle findings within your authorized permissions.`,
  ].join('\n');
}

export function buildWakePlan({
  loopId,
  prTask,
  agentType = null,
  agentSessionId = null,
  autoWakeAuthorized = false,
  canSpawn = true,
} = {}) {
  const manualResumeCommand = `reviewloop pr resume --loop ${loopId}`;
  const prompt = buildPrWakeContextPrompt({ loopId, prTask });
  const normalizedAgent = String(agentType ?? '').trim().toLowerCase();
  const sessionId = String(agentSessionId ?? '').trim();

  if (autoWakeAuthorized !== true) {
    return {
      wakeStatus: 'MANUAL_REQUIRED',
      autoWake: 'UNAUTHORIZED',
      reason: 'AUTO_WAKE_NOT_AUTHORIZED',
      command: null,
      args: [],
      cwd: prTask?.repoRoot ?? null,
      manualResumeCommand,
      prompt,
    };
  }

  if (!canSpawn) {
    return {
      wakeStatus: 'MANUAL_REQUIRED',
      autoWake: 'UNAVAILABLE',
      reason: 'SPAWN_NOT_PERMITTED',
      command: null,
      args: [],
      cwd: prTask?.repoRoot ?? null,
      manualResumeCommand,
      prompt,
    };
  }

  if (!normalizedAgent || normalizedAgent === 'agy' || !SUPPORTED_WAKE_AGENTS.includes(normalizedAgent)) {
    return {
      wakeStatus: 'MANUAL_REQUIRED',
      autoWake: 'UNAVAILABLE',
      reason: normalizedAgent === 'agy' ? 'AGY_AUTO_WAKE_UNSUPPORTED' : 'UNSUPPORTED_AGENT_TYPE',
      command: null,
      args: [],
      cwd: prTask?.repoRoot ?? null,
      manualResumeCommand,
      prompt,
    };
  }

  if (!sessionId) {
    return {
      wakeStatus: 'MANUAL_REQUIRED',
      autoWake: 'UNAVAILABLE',
      reason: 'MISSING_AGENT_SESSION_ID',
      command: null,
      args: [],
      cwd: prTask?.repoRoot ?? null,
      manualResumeCommand,
      prompt,
    };
  }

  if (normalizedAgent === 'claude') {
    return {
      wakeStatus: 'READY_TO_WAKE',
      autoWake: 'AVAILABLE',
      reason: 'OK',
      command: 'claude',
      args: ['--resume', sessionId, '-p', prompt],
      cwd: prTask?.repoRoot ?? process.cwd(),
      manualResumeCommand,
      prompt,
    };
  }

  return {
    wakeStatus: 'READY_TO_WAKE',
    autoWake: 'AVAILABLE',
    reason: 'OK',
    command: 'codex',
    args: ['exec', 'resume', sessionId, prompt],
    cwd: prTask?.repoRoot ?? process.cwd(),
    manualResumeCommand,
    prompt,
  };
}

export async function executeWake({
  loopId,
  prTask,
  agentType = prTask?.watcher?.agentType ?? null,
  agentSessionId = prTask?.watcher?.agentSessionId ?? null,
  autoWakeAuthorized = prTask?.permissions?.autoWake === true,
  canSpawn = true,
  spawnFn = spawn,
} = {}) {
  const plan = buildWakePlan({
    loopId,
    prTask,
    agentType,
    agentSessionId,
    autoWakeAuthorized,
    canSpawn,
  });

  if (plan.wakeStatus !== 'READY_TO_WAKE') {
    return { ...plan, woken: false };
  }

  try {
    const child = spawnFn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
    });
    if (typeof child?.unref === 'function') child.unref();
    return {
      ...plan,
      woken: true,
      wakeStatus: 'WOKEN',
      pid: child?.pid ?? null,
    };
  } catch (err) {
    return {
      ...plan,
      woken: false,
      wakeStatus: 'MANUAL_REQUIRED',
      autoWake: 'UNAVAILABLE',
      reason: 'WAKE_SPAWN_FAILED',
      error: String(err?.message ?? err),
    };
  }
}
