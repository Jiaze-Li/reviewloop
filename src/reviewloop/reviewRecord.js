// Deterministic, read-only review record built ONLY from the persisted
// loopState.history (Design RL-STATUS-HANDOFF-01, invariants I1-I4).
// Pure formatting: no state writes, no model calls, never throws, never
// invents a result that history does not contain.

// HUMAN_REQUIRED is final only once the convergence budget is spent
// (controller.js reviewInner); otherwise the same loop can be re-reviewed.
const TERMINAL = new Set(['PASS', 'FAILED', 'STOPPED']);
const RESULT_TO = new Set(['REWORK', 'PASS', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED']);
const INCOMPLETE = '记录不完整';

// Entries are listed as recorded, tagged with `round` = the number of
// Reviewer rounds COMPLETED when the transition was written. History also holds
// transitions that ran no Reviewer (Gate repairs, human reopen/override,
// preflight stops). Telling them apart would mean guessing from free-text
// reasons, so the record does NOT classify: it lists every outcome and states
// that entries are not a count of Reviewer rounds.
const NOT_ROUNDS_NOTE = '条目含 Gate 修复与人工操作，不等于审查轮数';

function entryLabel(e) {
  if (e.from === 'REVIEWING' && e.to === 'READY_FOR_WORK') return 'PHASE_PASS';
  return RESULT_TO.has(e.to) ? e.to : null;
}

export function buildReviewRecord(loopState, result) {
  const head = (taskType, loopId) => `[ReviewLoop 记录 | ${taskType ?? 'code'} | loopId=${loopId ?? '?'}`;
  try {
    const taskType = loopState?.objective?.taskType ?? 'code';
    const loopId = loopState?.loopId ?? result?.loopId;
    const history = loopState?.history;
    if (!Array.isArray(history)) return `${head(taskType, loopId)} | ${INCOMPLETE}: 历史不可读]`;

    const steps = [];
    let lastLabel = null;
    let malformed = false;
    for (const e of history) {
      if (!e || typeof e !== 'object' || typeof e.to !== 'string') { malformed = true; continue; }
      const label = entryLabel(e);
      if (!label) continue;
      const r = Number.isInteger(e.round) && e.round > 0 ? e.round : 0;
      steps.push(`${label}@已审${r}轮`);
      lastLabel = label;
    }

    const parts = [head(taskType, loopId)];
    parts.push(steps.length ? steps.join(' → ') : '尚无已记录的审查结果');

    const state = loopState.state;
    if (TERMINAL.has(state) || (state === 'HUMAN_REQUIRED' && loopState.budgetExhausted === true)) {
      parts.push(`终态 ${state}`);
    } else if (state === 'HUMAN_REQUIRED') {
      parts.push('当前 HUMAN_REQUIRED（需人工，可续审，未结束）');
    } else {
      parts.push(`当前 ${state ?? '未知'}（未结束）`);
    }

    // The reported status must be traceable to history; otherwise say so
    // rather than letting a reader assume it was recorded.
    const status = result?.status;
    if (typeof status === 'string' && status && lastLabel !== status) {
      parts.push(`本次结果 ${status} 未写入历史（如 Gate 修复循环、等待或无进展），未逐条列出`);
    }
    if (steps.length) parts.push(NOT_ROUNDS_NOTE);
    if (malformed) parts.push(`${INCOMPLETE}: 有损坏的历史条目被跳过`);
    return `${parts.join(' | ')}]`;
  } catch {
    return `${head(null, result?.loopId)} | ${INCOMPLETE}: 生成失败]`;
  }
}
