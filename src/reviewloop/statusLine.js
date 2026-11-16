// Deterministic one-line status shown to the user by the Worker (Design 5.3).
// Pure formatting: no state, no model calls.

export function beginStatusLine({ taskType, loopId }) {
  return `[ReviewLoop | ${taskType ?? 'code'} | 启动] loopId=${loopId}`;
}

export function reviewStatusLine({ taskType, loopId, round, status }) {
  const r = Number.isInteger(round) && round > 0 ? round : 0;
  return `[ReviewLoop | ${taskType ?? 'code'} | 第 ${r} 轮 → ${status}] loopId=${loopId}`;
}
