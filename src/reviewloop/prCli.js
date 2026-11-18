// CLI helpers for `reviewloop pr <status|resume|stop>`.
// Keeps retired `mode === 'PR'` sessions strictly isolated.

import { buildPrWakeContextPrompt } from './prWakeAdapter.js';
import { REVIEW_LOOP_STATES, ReviewLoopStore, recordTransition, isTerminal } from './state.js';

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
  killFn = (pid) => process.kill(pid, 'SIGTERM'),
}) {
  const store = new ReviewLoopStore(persistence);
  const loopState = await store.load(loopId);
  const prTask = await store.loadPrTask(loopId);
  if (!loopState || loopState.objective?.mode === 'PR' || loopState.objective?.taskType !== 'pr' || !prTask) {
    throw new Error(`unknown or non-PR-task loopId: ${loopId}`);
  }
  const watcherPid = prTask.watcher?.pid ?? null;
  if (Number.isInteger(watcherPid) && watcherPid > 0) {
    try { killFn(watcherPid); } catch { /* process may have already exited */ }
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
  return { loopId, state: loopState.state, watcherStopped: watcherPid, reason };
}
