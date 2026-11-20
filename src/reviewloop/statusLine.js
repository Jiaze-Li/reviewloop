// Deterministic one-line status shown to the user by the Worker (Design 5.3).
// Pure formatting: no state, no model calls.

export function beginStatusLine({ taskType, loopId }) {
  return `[ReviewLoop | ${taskType ?? 'code'} | 启动] loopId=${loopId}`;
}

export function reviewStatusLine({ taskType, loopId, round, status, headline = null }) {
  const r = Number.isInteger(round) && round > 0 ? round : 0;
  const base = `[ReviewLoop | ${taskType ?? 'code'} | 第 ${r} 轮 → ${status}] loopId=${loopId}`;
  // HUMAN_REQUIRED only: one single-line key cause so the first screen never hides it.
  const cause = typeof headline === 'string' ? headline.replace(/\s+/g, ' ').trim() : '';
  return cause ? `${base}｜${cause}` : base;
}
