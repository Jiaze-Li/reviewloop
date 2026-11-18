// CLI helpers for `reviewloop pr <status|resume|stop>`.
// Keeps retired `mode === 'PR'` sessions strictly isolated.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPrWakeContextPrompt } from './prWakeAdapter.js';
import {
  fetchPrSnapshotViaGh,
  postPrCommentViaGh,
  pushPrHead,
  triggerGeminiReview,
} from './prTaskEngine.js';
import { REVIEW_LOOP_STATES, ReviewLoopStore, recordTransition, isTerminal } from './state.js';

const execFileAsync = promisify(execFile);

export async function isVerifiedWatcherPid(pid, loopId, execFn = execFileAsync) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const { stdout } = await execFn('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const cmd = String(stdout ?? '').trim();
    return cmd.includes('prWatcher.js') && cmd.includes(String(loopId));
  } catch {
    return false;
  }
}

export function formatPrStatusEntry({ loopState, prTask }) {
  const posted = (prTask.reviewTriggers ?? []).filter((t) => t.status === 'POSTED').length;
  const openFindings = prTask.latestBotSession?.openFindings ?? [];
  const botStatus = prTask.latestBotSession?.sessionStatus ?? 'MISSING';
  const perms = Object.entries(prTask.permissions ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  return {
    loopId: loopState.loopId,
    state: loopState.state,
    repoFullName: prTask.repoFullName,
    prNumber: prTask.prNumber,
    boundHeadSha: prTask.boundHeadSha,
    botStatus,
    openFindingsCount: openFindings.length,
    postedReviewTriggers: posted,
    maxReviewTriggers: 3,
    permissions: perms,
    watcherPid: prTask.watcher?.pid ?? null,
    wakeStatus: prTask.watcher?.wakeStatus ?? null,
    stopReason: prTask.stopReason ?? null,
  };
}

export function buildPrResumeText({ loopState, prTask }) {
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr' || !prTask) {
    throw new Error('Not a valid taskType="pr" session (retired mode="PR" cannot be resumed).');
  }
  const lines = [
    buildPrWakeContextPrompt({ loopId: loopState.loopId, prTask }),
    `Authorized permissions: ${Object.entries(prTask.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none)'}`,
  ];
  if (prTask.originContractText) {
    lines.push('', 'ORIGIN FROZEN CONTRACT:', String(prTask.originContractText));
  }
  return lines.join('\n');
}

export async function stopPrTask({
  persistence,
  loopId,
  reason = 'stopped by user',
  verifyWatcherPidFn = isVerifiedWatcherPid,
  killFn = (pid) => process.kill(pid, 'SIGTERM'),
}) {
  const store = new ReviewLoopStore(persistence);
  const loopState = await store.load(loopId);
  const prTask = await store.loadPrTask(loopId);
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr' || !prTask) {
    throw new Error(`unknown or non-PR-task loopId: ${loopId}`);
  }
  const watcherPid = prTask.watcher?.pid ?? null;
  let watcherStopped = null;
  if (Number.isInteger(watcherPid) && watcherPid > 0) {
    const verified = await verifyWatcherPidFn(watcherPid, loopId);
    if (verified) {
      try {
        killFn(watcherPid);
        watcherStopped = watcherPid;
      } catch { /* process may have already exited */ }
    }
  }
  prTask.watcher = {
    ...(prTask.watcher ?? {}),
    pid: null,
    stoppedAt: new Date().toISOString(),
  };
  prTask.stopReason = reason;
  if (!isTerminal(loopState.state)) {
    recordTransition(loopState, REVIEW_LOOP_STATES.STOPPED, reason);
  }
  await store.save(loopId, loopState);
  await store.savePrTask(loopId, prTask);
  return { loopId, state: loopState.state, watcherStopped, reason };
}

export async function bindPrAgent({
  persistence,
  loopId,
  agentType,
  agentSessionId = null,
}) {
  const store = new ReviewLoopStore(persistence);
  const loopState = await store.load(loopId);
  const prTask = await store.loadPrTask(loopId);
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr' || !prTask) {
    throw new Error(`unknown or non-PR-task loopId: ${loopId}`);
  }
  const normalizedAgent = String(agentType ?? '').trim().toLowerCase();
  if (!['claude', 'codex', 'agy'].includes(normalizedAgent)) {
    throw new Error(`unsupported agentType "${agentType}" (expected claude, codex, or agy)`);
  }
  const sessionId = agentSessionId == null ? null : (String(agentSessionId).trim() || null);
  prTask.watcher = {
    ...(prTask.watcher ?? {}),
    agentType: normalizedAgent,
    agentSessionId: sessionId,
  };
  prTask.updatedAt = new Date().toISOString();
  await store.savePrTask(loopId, prTask);
  return {
    loopId,
    agentType: normalizedAgent,
    agentSessionId: sessionId,
  };
}

export async function pushPrHeadCli({
  persistence,
  loopId,
  execFn,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  withLeaseFn = async (fn) => fn(),
}) {
  const store = new ReviewLoopStore(persistence);
  const loopState = await store.load(loopId);
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr') {
    throw new Error(`unknown or non-PR-task loopId: ${loopId}`);
  }
  return pushPrHead({
    loopId,
    store,
    ...(execFn ? { execFn } : {}),
    fetchPrSnapshotFn,
    withLeaseFn,
  });
}

export async function triggerPrReviewCli({
  persistence,
  loopId,
  fetchPrSnapshotFn = fetchPrSnapshotViaGh,
  postCommentFn = postPrCommentViaGh,
  withLeaseFn = async (fn) => fn(),
}) {
  const store = new ReviewLoopStore(persistence);
  const loopState = await store.load(loopId);
  const prTask = await store.loadPrTask(loopId);
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr' || !prTask) {
    throw new Error(`unknown or non-PR-task loopId: ${loopId}`);
  }
  const snapshot = await fetchPrSnapshotFn({
    repoFullName: prTask.repoFullName,
    prNumber: prTask.prNumber,
  });
  return triggerGeminiReview({
    loopId,
    prTask,
    prState: snapshot.prState,
    comments: snapshot.comments,
    store,
    postCommentFn,
    fetchPrSnapshotFn,
    withLeaseFn,
  });
}
