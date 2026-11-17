// Deterministic, read-only review record built ONLY from the persisted
// loopState.history (Design RL-STATUS-HANDOFF-01, invariants I1-I4).
// Pure formatting: no state writes, no model calls, never throws, never
// invents a result that history does not contain.

const TERMINAL = new Set(['PASS', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED']);
const RESULT_TO = new Set(['REWORK', 'PASS', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED']);
const INCOMPLETE = '记录不完整';

function entryLabel(e) {
  if (e.from === 'REVIEWING' && e.to === 'READY_FOR_WORK') return 'PHASE_PASS';
  if (RESULT_TO.has(e.to)) return e.to;
  return null;
}

export function buildReviewRecord(loopState, result) {
  const head = (taskType, loopId) => `[ReviewLoop 记录 | ${taskType ?? 'code'} | loopId=${loopId ?? '?'}`;
  try {
    const taskType = loopState?.objective?.taskType ?? 'code';
    const loopId = loopState?.loopId ?? result?.loopId;
    const history = loopState?.history;
    if (!Array.isArray(history)) return `${head(taskType, loopId)} | ${INCOMPLETE}: 历史不可读]`;

    const steps = [];
    let malformed = false;
    for (const e of history) {
      if (!e || typeof e !== 'object' || typeof e.to !== 'string') { malformed = true; continue; }
      const label = entryLabel(e);
      if (!label) continue;
      const r = Number.isInteger(e.round) && e.round > 0 ? e.round : 0;
      steps.push(`第${r}轮 ${label}`);
    }

    const parts = [head(taskType, loopId)];
    parts.push(steps.length ? steps.join(' → ') : '尚无已记录的审查结果');

    const state = loopState.state;
    parts.push(TERMINAL.has(state) ? `终态 ${state}` : `当前 ${state ?? '未知'}（未结束）`);

    // The reported status must be traceable to history; otherwise say so
    // rather than letting a reader assume it was recorded.
    const status = result?.status;
    const lastLabel = steps.length ? steps[steps.length - 1].split(' ')[1] : null;
    if (typeof status === 'string' && status && lastLabel !== status) {
      parts.push(`本次结果 ${status} 未写入历史（如 Gate 修复循环、等待或无进展），未逐条列出`);
    }
    if (malformed) parts.push(`${INCOMPLETE}: 有损坏的历史条目被跳过`);
    return `${parts.join(' | ')}]`;
  } catch {
    return `${head(null, result?.loopId)} | ${INCOMPLETE}: 生成失败]`;
  }
}
