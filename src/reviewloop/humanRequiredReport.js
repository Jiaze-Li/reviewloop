// Standard HUMAN_REQUIRED report (Plan R04/R05, Design d1 §4.1-4.2).
//
// PURE and read-only: builds the report from a loop snapshot + workflow state.
// No model call, no write, no filesystem access. It never throws to its caller
// (`safeBuildHumanRequiredReport` degrades to a minimal report).
//
// Honesty rules (Plan D04/D05): the trigger is not the root cause; confirmed
// facts carry a source, probable causes carry their basis and an explicit
// "estimate" marker, and everything not observable is listed as a gap.
// Privacy (AC09): only numbers, identifiers, counts and <=200-char reason text
// are emitted - never prompts, diffs, contract text or credentials.

import { buildTokenProfile } from './tokenProfile.js';
import { TOKEN_ANOMALY_KEY, TOKEN_ANOMALY_ACKS_KEY } from './tokenAnomalyAck.js';
import { effectiveCallLimits } from './callAllowance.js';
import { STANDARD_HUMAN_REOPENS } from './gateReopen.js';
import { isBlockingReservationStatus, isHumanAcknowledgedUnresolved } from '../orchestrator/modelSpendReservation.js';
import {
  CALL_ALLOWANCE_KEY, TOKEN_ACK_STANDARD_LIMIT, usedCalls,
} from './humanActionGuard.js';
import { DESIGN_SOURCE_LIMIT_REASON, evaluateDesignException } from './designExceptionState.js';
import { resolveStopCause, isTrustedToolFailure, STOP_KINDS } from './stopCause.js';

export const REPORT_VERSION = 1;
export const HEADLINE_MAX = 120;
const TEXT_MAX = 200;

export const CATEGORIES = Object.freeze([
  'TOKEN_SENTINEL', 'UNACCOUNTED_SPEND', 'SPEND_CEILING', 'CALL_CEILING', 'CONVERGENCE_EXHAUSTED',
  'NO_NEW_INFORMATION', 'ATTRIBUTION_INCOMPLETE', 'REVIEW_FAILED', 'TASK_DEFINITION', 'SUPERVISOR_ESCALATION',
  'CANCELLED', 'DESIGN_ROUNDS', 'RESUME_PENDING', 'STATE_UNREADABLE', 'DESIGN_SOURCE_LIMIT', 'OTHER',
]);

const LABEL = {
  TOKEN_SENTINEL: 'Token 安全哨兵',
  UNACCOUNTED_SPEND: '未结算的模型消耗',
  SPEND_CEILING: '预算上限',
  CALL_CEILING: '调用次数上限',
  CONVERGENCE_EXHAUSTED: '审查未能收敛',
  NO_NEW_INFORMATION: '送审内容没有变化',
  ATTRIBUTION_INCOMPLETE: '无法区分本次改动与已有改动',
  REVIEW_FAILED: '独立审查未能完成',
  TASK_DEFINITION: '任务合同检查未通过',
  SUPERVISOR_ESCALATION: '监督者要求人工决定',
  CANCELLED: '审查被中断',
  DESIGN_ROUNDS: '设计审查轮数用尽',
  RESUME_PENDING: '已由人工确认，待继续审查',
  STATE_UNREADABLE: '任务状态记录无法读取',
  DESIGN_SOURCE_LIMIT: '设计审查工具读不到关键源码',
  OTHER: '需要人工处理',
};

const clip = (v, n = TEXT_MAX) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const num = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : '未记录');
const fin = (n) => (Number.isFinite(n) ? n : null);

function lastHumanRequiredReason(loop, result) {
  const fromResult = clip(result?.reason);
  if (fromResult) return fromResult;
  const hit = [...(loop?.history ?? [])].reverse().find((h) => h?.to === 'HUMAN_REQUIRED');
  return clip(hit?.reason ?? loop?.reason ?? '');
}

const ms = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

// Everything a human already did on this loop (audit trail), newest data wins.
// `after` (ms) keeps only actions made after the last stop.
export function humanActions(workflow, after = null) {
  const out = [];
  const acks = Array.isArray(workflow?.[TOKEN_ANOMALY_ACKS_KEY]) ? workflow[TOKEN_ANOMALY_ACKS_KEY] : [];
  acks.forEach((a, i) => out.push({
    kind: 'TOKEN_ACK', at: a?.at ?? null, latchAt: a?.latchAt ?? null,
    text: `Token 哨兵异常已由人工确认（第 ${i + 1} 次，档位 ${a?.tier ?? 'STANDARD'}）`,
  }));
  const overrides = Array.isArray(workflow?.budgetOverrides?.history) ? workflow.budgetOverrides.history : [];
  overrides.forEach((o) => out.push({ kind: 'BUDGET', at: o?.at ?? null, text: '预算上限已由人工提高' }));
  const grants = Array.isArray(workflow?.[CALL_ALLOWANCE_KEY]?.history) ? workflow[CALL_ALLOWANCE_KEY].history : [];
  grants.forEach((g) => out.push({
    kind: 'CALLS', at: g?.at ?? null,
    text: `本任务的${g?.role === 'supervisor' ? '监督者' : '审查'}调用上限已由人工设为 ${g?.newCeiling ?? '?'}（${g?.tier ?? ''}）`,
  }));
  const reservations = workflow?.modelSpendReservations && typeof workflow.modelSpendReservations === 'object'
    ? Object.values(workflow.modelSpendReservations) : [];
  reservations.forEach((rv) => {
    const ack = rv?.humanAcknowledgement;
    if (ack?.accepted === true) out.push({ kind: 'SPEND_ACK', at: ack.acknowledgedAt ?? null, text: '未结算的调用已由人工登记为用量未知' });
  });
  return out
    .filter((a) => after == null || (ms(a.at) != null && ms(a.at) >= after))
    .sort((x, y) => (ms(x.at) ?? 0) - (ms(y.at) ?? 0));
}

// Independent, state-based stops that are still in force right now. A human
// action on one of them must never hide another (Plan R11b / AC06).
// `unreadable` = a needed fact could not be read, so "nothing is blocking"
// cannot be claimed.
export function activeBlockers({ loop, workflow, fromSupervisor, env = process.env }) {
  const list = [];
  let unreadable = false;
  if (workflow?.[TOKEN_ANOMALY_KEY]?.tripped === true) list.push('TOKEN_SENTINEL');
  const reservations = workflow?.modelSpendReservations && typeof workflow.modelSpendReservations === 'object'
    ? Object.values(workflow.modelSpendReservations) : [];
  // Exactly the spend authority's rule: a call that crossed the dispatch boundary
  // (DISPATCHING) or is UNRESOLVED blocks all further spend, unless a human
  // acknowledged AND recorded an UNRESOLVED one. Never a narrower reading.
  if (reservations.some((rv) => isBlockingReservationStatus(rv?.status) && !isHumanAcknowledgedUnresolved(rv))) list.push('UNACCOUNTED_SPEND');
  try {
    const limits = effectiveCallLimits({ workflow, env });
    const used = usedCalls(workflow);
    if (used.reviewer >= limits.maxReviewerCalls || used.supervisor >= limits.maxSupervisorCalls) list.push('CALL_CEILING');
    const records = Array.isArray(workflow?.reviewLoopSpend?.records) ? workflow.reviewLoopSpend.records : [];
    const usage = records.reduce((a, rec) => a + (Number.isFinite(rec?.usageVolume) ? rec.usageVolume : 0), 0);
    const cost = records.reduce((a, rec) => a + (Number.isFinite(rec?.costUsd) ? rec.costUsd : 0), 0);
    if (usage >= limits.maxUsageVolume || cost >= limits.maxCostUsd) list.push('SPEND_CEILING');
  } catch {
    unreadable = true;
  }
  if (loop?.budgetExhausted === true) list.push(fromSupervisor ? 'SUPERVISOR_ESCALATION' : 'CONVERGENCE_EXHAUSTED');
  return { list, unreadable };
}

export function classify({ loop, workflow, reason, result = null, env = process.env }) {
  const checked = [];
  if (result?.stateUnreadable) {
    return { category: 'STATE_UNREADABLE', checked: ['任务状态记录能否读取：不能'], ctx: {} };
  }
  const lastHr = [...(loop?.history ?? [])].reverse().find((h) => h?.to === 'HUMAN_REQUIRED') ?? null;
  const fromSupervisor = lastHr?.from === 'SUPERVISING';
  const ctx = { fromSupervisor, actions: [], active: [] };
  const latch = workflow?.[TOKEN_ANOMALY_KEY];
  checked.push(`Token 哨兵记录：${latch?.tripped === true ? '已触发' : '未触发'}`);
  const acks = Array.isArray(workflow?.[TOKEN_ANOMALY_ACKS_KEY]) ? workflow[TOKEN_ANOMALY_ACKS_KEY] : [];
  // Trusted structured cause (engine-written or closed legacy template with state
  // corroboration). Model/label text never decides a privileged category.
  const stopCause = resolveStopCause({ loop, blockers: activeBlockers({ loop, workflow, fromSupervisor, env }) });
  const trustedToolFailure = isTrustedToolFailure(stopCause);
  const tokenText = !trustedToolFailure && /TOKEN_ANOMALY|token anomaly/i.test(reason);
  const ackedLatch = Boolean(latch) && latch.tripped !== true && acks.some((a) => String(a?.latchAt) === String(latch.at));
  if (latch?.tripped === true || (tokenText && !ackedLatch)) return { category: 'TOKEN_SENTINEL', checked, ctx };
  checked.push('停止原因文本匹配');

  // The stop this loop reported, by its text. Token text on an already
  // confirmed latch is the "confirmed" variant, resolved below.
  let textCat = null;
  if (trustedToolFailure) textCat = null;
  else if (tokenText && ackedLatch) textCat = 'TOKEN_ACKED';
  else if (/MODEL_SPEND_USAGE_UNRESOLVED|unaccounted|UNRESOLVED/i.test(reason)) textCat = 'UNACCOUNTED_SPEND';
  else if (/(reviewer|supervisor)\s+call\s+ceiling/i.test(reason)) textCat = 'CALL_CEILING';
  else if (/SPEND_DENIED|usage[- ]volume|cost\s*ceiling|usage.*ceiling/i.test(reason)) textCat = 'SPEND_CEILING';

  // A stop a human can have already acted on. Re-derive what is STILL blocking
  // from durable state instead of trusting the old stop text.
  if (textCat) {
    const after = ms(lastHr?.at);
    ctx.actions = textCat === 'TOKEN_ACKED'
      ? humanActions(workflow).filter((a) => a.kind === 'TOKEN_ACK' && String(a.latchAt) === String(latch.at))
      : humanActions(workflow, after);
    if (ctx.actions.length > 0) {
      checked.push('停止之后的人工处理记录');
      const act = activeBlockers({ loop, workflow, fromSupervisor, env });
      ctx.active = act.list;
      if (act.unreadable) return { category: 'OTHER', checked: [...checked, '仍在生效的独立阻断（读取失败）'], ctx };
      checked.push(`仍在生效的独立阻断：${act.list.length ? act.list.join('、') : '无'}`);
      return { category: act.list[0] ?? 'RESUME_PENDING', checked, ctx };
    }
    if (textCat !== 'TOKEN_ACKED') return { category: textCat, checked, ctx };
  }
  // Exact match only: the two-stage Design review's tool-boundary stop (a review
  // TOOL limit, not a design defect). Never a fuzzy pattern.
  if (reason === DESIGN_SOURCE_LIMIT_REASON || (stopCause.kind === STOP_KINDS.DESIGN_SOURCE_LIMIT && stopCause.source === 'ENGINE')) return { category: 'DESIGN_SOURCE_LIMIT', checked, ctx };
  // A trusted (engine-written / closed-template) tool failure is decided BEFORE any
  // free-text pattern: its reason can only carry fixed engine text, and no phrase in
  // it may select another category. The supervisor and spent-budget signals keep
  // their own priority (handled below), so they are excluded here.
  if (trustedToolFailure && !fromSupervisor && loop?.budgetExhausted !== true) {
    return { category: 'REVIEW_FAILED', checked: [...checked, `停止来源：${stopCause.source === 'ENGINE' ? '引擎记录' : '旧记录（固定模板 + 状态佐证）'}`], ctx };
  }
  if (/design review round budget/i.test(reason)) return { category: 'DESIGN_ROUNDS', checked, ctx };
  if (/New Information|NO_NEW_INFORMATION/i.test(reason)) return { category: 'NO_NEW_INFORMATION', checked, ctx };
  checked.push(`收敛预算：${loop?.budgetExhausted === true ? '已用尽' : '未用尽'}；停止来自监督者：${fromSupervisor ? '是' : '否'}`);
  if (fromSupervisor) return { category: 'SUPERVISOR_ESCALATION', checked, ctx };
  if (loop?.budgetExhausted === true) return { category: 'CONVERGENCE_EXHAUSTED', checked, ctx };
  // A trusted tool failure is decided here, before any free-text pattern below.
  if (trustedToolFailure) return { category: 'REVIEW_FAILED', checked: [...checked, `停止来源：${stopCause.source === 'ENGINE' ? '引擎记录' : '旧记录（固定模板 + 状态佐证）'}`], ctx };
  if (/attribution|cannot reliably separate|Worker delta/i.test(reason)) return { category: 'ATTRIBUTION_INCOMPLETE', checked, ctx };
  if (/cancelled/i.test(reason)) return { category: 'CANCELLED', checked, ctx };
  if (/task[- ]definition|phase plan|contract.*(exceed|bound)|fingerprint|objective/i.test(reason)) return { category: 'TASK_DEFINITION', checked, ctx };
  // Free-text "supervisor"/"reviewer"/"provider" patterns are deliberately gone:
  // an unrecognised reason is OTHER and carries no Design-exception eligibility.
  return { category: 'OTHER', checked, ctx };
}

// ---- Token Sentinel diagnosis (design 4.2) --------------------------------

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function diagnoseTokenAnomaly({ loopId, workflow }) {
  const latch = workflow?.[TOKEN_ANOMALY_KEY] ?? null;
  const out = {
    anomaly: null, confirmed: [], probable: [], unknown: [], gaps: [], checked: [],
  };
  if (!latch) {
    out.gaps.push('没有读到哨兵触发记录');
    out.unknown.push('触发数值、阈值与触发调用（哨兵记录缺失，无法分析）');
    return out;
  }
  const kind = latch.trigger === 'SINGLE_CALL_USAGE' ? '单次调用的模型用量' : '上下文传输开销';
  const value = latch.trigger === 'SINGLE_CALL_USAGE' ? fin(latch.usageVolume) : fin(latch.contextOverheadTokens);
  const threshold = fin(latch.threshold);
  out.anomaly = {
    what: `${kind}超过安全阈值`,
    kind: latch.trigger ?? null,
    value,
    threshold,
    excess: value != null && threshold != null ? value - threshold : null,
    at: latch.at ?? null,
    reinferredFromSpendLog: latch.reinferredFromSpendLog === true,
  };
  out.confirmed.push(`${kind} ${num(value)}，阈值 ${num(threshold)}，超出 ${num(out.anomaly.excess)}（来源：哨兵触发记录）`);
  if (latch.trigger === 'CONTEXT_OVERHEAD') {
    out.confirmed.push('检测方式：模型报告的输入量减去按字符数/4 估出的发送量；这是代理指标，不是对隐藏上下文的直接测量');
  }
  const who = [latch.role, latch.family, latch.provider, latch.resolvedModel].filter(Boolean).map((x) => clip(x, 60));
  if (who.length) out.confirmed.push(`触发调用的角色/模型：${who.join(' / ')}（仅为背景，不等于根因）`);
  if (latch.reinferredFromSpendLog === true) out.confirmed.push('该锁定由重启后根据消费记录重新推断得到');

  let calls = [];
  try {
    calls = buildTokenProfile({ loopId, workflow }).rounds.flatMap((r) => r.calls);
    out.checked.push(`已读取 ${calls.length} 条持久调用记录`);
  } catch (e) {
    out.gaps.push(`无法读取调用记录：${clip(e?.message, 80)}`);
    out.unknown.push('触发调用的输入/缓存/Prompt 构成');
    return out;
  }
  const matches = calls.filter((c) => (latch.trigger === 'SINGLE_CALL_USAGE'
    ? c.usageVolume === latch.usageVolume
    : c.prompt.estimatedContextOverheadTokens === latch.contextOverheadTokens));
  const trig = matches.at(-1) ?? null;
  if (!trig) {
    out.gaps.push('无法把哨兵记录对应到具体的调用记录（记录缺失或数值不一致）');
    out.unknown.push('触发调用的输入/缓存/Prompt 构成');
    return out;
  }
  out.checked.push(`触发调用定位为第 ${trig.ordinal} 条记录${trig.round != null ? `（第 ${trig.round} 轮）` : ''}`);

  const b = trig.breakdown;
  const parts = [['输入', b.inputTokens], ['缓存读取', b.cacheReadTokens], ['缓存写入', b.cacheCreationTokens], ['输出', b.outputTokens]];
  const known = parts.filter(([, v]) => v != null).map(([k, v]) => `${k} ${num(v)}`);
  const missing = parts.filter(([, v]) => v == null).map(([k]) => k);
  if (known.length) out.confirmed.push(`模型报告的用量：${known.join('，')}（缓存项与总用量不可直接相加）`);
  if (missing.length) out.gaps.push(`提供商未报告：${missing.join('、')}`);

  const comps = Object.entries(trig.prompt.components ?? {}).sort((a, c) => c[1] - a[1]).slice(0, 3);
  if (comps.length) {
    out.confirmed.push(`ReviewLoop 发送内容中最大的 3 个组成（字符数，非 Token）：${comps.map(([k, v]) => `${k.replace(/Chars$/, '')} ${num(v)}`).join('，')}`);
  } else {
    out.gaps.push('该调用没有 Prompt 组成统计（旧记录或未记录）');
  }
  const est = trig.prompt.estimatedPayloadTokens;
  if (est != null) out.confirmed.push(`发送内容的估计量约 ${num(est)} Token（估计值，按字符数/4）`);
  else out.gaps.push('没有发送内容的估计量');
  const repeated = fin(workflow?.reviewLoopSpend && buildRepeated(loopId, workflow));
  if (repeated) out.confirmed.push(`其中重复提交的冻结合同约 ${num(repeated)} 字符（内容相同，不一定可避免）`);

  const key = latch.trigger === 'SINGLE_CALL_USAGE' ? 'usageVolume' : 'overhead';
  const peers = calls.filter((c) => c !== trig && c.role === trig.role)
    .map((c) => (key === 'usageVolume' ? c.usageVolume : c.prompt.estimatedContextOverheadTokens))
    .filter(Number.isFinite);
  if (peers.length >= 2) {
    const m = median(peers);
    const mine = key === 'usageVolume' ? trig.usageVolume : trig.prompt.estimatedContextOverheadTokens;
    if (m > 0 && Number.isFinite(mine)) out.confirmed.push(`同一任务其他同类调用的中位数为 ${num(m)}，本次约为其 ${(mine / m).toFixed(1)} 倍`);
  } else {
    out.gaps.push('同一任务内可对比的相邻调用不足 2 条，无法判断是否偏离常态');
  }

  const input = b.inputTokens;
  const cacheKnown = b.cacheReadTokens != null && b.cacheCreationTokens != null;
  if (input != null && est != null && Math.max(input, est) > 0
    && Math.abs(input - est) / Math.max(input, est) < 0.2) {
    out.probable.push({
      text: '用量主要来自 ReviewLoop 发送的内容（估计）',
      basis: `模型报告的输入 ${num(input)} 与发送内容估计量 ${num(est)} 相差不到 20%`,
      uncertainty: '估计量按字符数/4，实际分词可能不同',
    });
  } else if (input != null && est != null && cacheKnown && latch.trigger === 'CONTEXT_OVERHEAD') {
    out.probable.push({
      text: '差额出现在传输或缓存环节，而不是发送内容本身（估计）',
      basis: `模型报告的输入 ${num(input)} 与发送内容估计量 ${num(est)} 相差较大，且缓存用量已记录`,
      uncertainty: '具体是哪段上游内容无法从现有记录观测',
    });
  } else {
    out.gaps.push('记录不足，无法判断差额主要出现在哪个环节');
  }
  out.unknown.push('提供商内部的系统提示或缓存内容的来源（现有记录无法观测，不能由此证明）');
  return out;
}

function buildRepeated(loopId, workflow) {
  try { return buildTokenProfile({ loopId, workflow }).prompt.verifiedRepeatedContractChars; } catch { return null; }
}

// ---- per-category static knowledge ----------------------------------------

function categoryPlan(category, { loopId, workflow, loop = null, stateDir = null }) {
  const latchAt = workflow?.[TOKEN_ANOMALY_KEY]?.at ?? '<报告中的触发时间>';
  const profile = `reviewloop profile --loop ${loopId}`;
  const retry = '修复原因后，让 Worker 用同一个任务再次发起审查';
  const acksDone = Array.isArray(workflow?.[TOKEN_ANOMALY_ACKS_KEY]) ? workflow[TOKEN_ANOMALY_ACKS_KEY].length : 0;
  const reopensDone = Array.isArray(loop?.humanReopens) ? loop.humanReopens.length : 0;
  // Past the standard count a confirmation is still possible, but it must state a
  // numeric number of further Reviewer calls, which the system then enforces.
  const ackExtra = acksDone >= TOKEN_ACK_STANDARD_LIMIT ? ' --max-reviewer-calls <本次最多允许的审查调用数>' : '';
  const reopenExtra = reopensDone >= STANDARD_HUMAN_REOPENS ? ' --max-reviewer-calls <本次最多允许的审查调用数>' : '';
  const extendedNote = (done) => (done >= TOKEN_ACK_STANDARD_LIMIT
    ? [`已超过常规 ${TOKEN_ACK_STANDARD_LIMIT} 次：仍可继续，但需要写明本次尝试最多再用几次审查调用，系统会按这个数字强制执行（文字理由只用于记录）`] : []);
  const isNewDesignLoop = loop?.objective?.taskType === 'design' && Boolean(loop?.objective?.reviewTarget);
  const exceptionCommand = `reviewloop accept-design-exception --loop ${loopId} --repo <owner/name> --pr <PR号> --task-id <任务ID> --design-version <设计版本> --design-sha <设计内容SHA-256> --review-report <外部独立审查报告.json> --reason "<为什么采用替代独立审查>"`;
  const exceptionChoice = '采用另一个独立上下文的替代审查，并由你本人授权这份设计进入 Code（记录为人工授权例外，不是 ReviewLoop 审查通过）';
  const plans = {
    DESIGN_SOURCE_LIMIT: {
      paused: ['设计审查已暂停：审查工具读不到设计所依赖的关键源码，无法独立核实这些事实（这是审查工具的限制，本轮没有发现设计缺陷不等于审查通过）'],
      fixOptions: [
        '让另一个独立上下文按设计全文与相关源码做替代审查，产出结构化报告（结论、已核实的源码行段、未核实的风险）',
        '或先修好审查工具的读取能力，再由你明确下达重新审查这份设计的指令',
        '如果设计确实依赖读不到的内容且不愿承担风险，可以终止该任务',
      ],
      recommended: '如果替代审查报告没有阻断问题，由你本人运行下方命令授权进入 Code；原审查记录保持“未通过”，不会被改写',
      choices: [exceptionChoice, '先修复审查工具后重新审查（需要你明确指令）', '终止该任务'],
      command: exceptionCommand,
    },
    TOKEN_SENTINEL: {
      paused: ['该任务后续所有模型审查调用已被暂停'],
      fixOptions: ['缩小或拆分送审内容，降低单次发送量', '确认传输方式没有附带多余上下文', '核对上方 Prompt 组成，看是否有重复大段内容'],
      recommended: '先按上面的证据确认这次超限可以接受或已修复，再确认继续；确认后需要 Worker 对送审内容做出实质修改，完全相同的内容不会被重复送审',
      choices: ['确认这次异常并在原任务中继续', '先修复送审内容后再继续', '终止该任务'],
      command: `reviewloop acknowledge-token-anomaly --loop ${loopId} --latch ${latchAt} --reason "<为什么可以继续>"${ackExtra}`,
      extraFix: extendedNote(acksDone),
    },
    UNACCOUNTED_SPEND: {
      paused: ['后续模型调用已暂停，因为有调用的用量/费用无法找回'],
      fixOptions: [`先查看该次调用的记录（reviewloop inspect-spend --loop ${loopId} --reservation <编号>）`, '确认后按“用量未知”登记，并可排除有问题的模型'],
      recommended: '先查看记录再决定；登记不会把未知伪造成 0',
      choices: ['登记为用量未知并授权一次重试', '先排查提供商后再继续', '终止该任务'],
      command: `reviewloop acknowledge-spend --loop ${loopId} --reservation <编号> --reason "<原因>"`,
    },
    SPEND_CEILING: {
      paused: ['后续模型调用已暂停，因为累计用量或费用达到上限'],
      fixOptions: ['在了解已花费用量后，提高本任务的上限', '或缩小任务范围后结束'],
      recommended: '先看已用量和剩余工作量，再决定是否提高上限',
      choices: ['提高本任务预算上限', '终止该任务'],
      command: `reviewloop override-budget --loop ${loopId} --max-usage <新上限> --reason "<原因>"`,
    },
    CALL_CEILING: {
      paused: ['后续模型调用已暂停，因为调用次数达到上限'],
      fixOptions: ['只为本任务增加有限的调用次数（任务级、有记录，不影响其他任务）', '想一次放宽所有任务，才去改配置文件里的全局上限（不推荐，没有任务级记录）', '或终止并缩小任务'],
      recommended: '如果任务确实需要更多轮，先给本任务增加一个有限的调用次数；否则缩小任务',
      choices: ['为本任务增加调用次数后继续', '终止该任务'],
      command: `reviewloop extend-calls --loop ${loopId} --reviewer-calls <再允许的审查调用数> --reason "<原因>"`,
    },
    CONVERGENCE_EXHAUSTED: {
      paused: ['自动审查策略已全部用尽，Worker 不能再自行继续'],
      fixOptions: ['人工查看未解决的问题，修复后重新开放当前关卡', '或调整需求后重新开始'],
      recommended: '先处理报告里的阻塞问题，再重新开放关卡',
      choices: ['重新开放关卡并再审一轮', '终止该任务'],
      command: `reviewloop reopen-gate --loop ${loopId} --reason "<已修复什么>"${reopenExtra}`,
      extraFix: reopensDone >= STANDARD_HUMAN_REOPENS ? [`已重新开放过 ${reopensDone} 次（常规 ${STANDARD_HUMAN_REOPENS} 次）：仍可再开，但需要写明本次最多允许的审查调用数，系统会强制执行`] : [],
    },
    DESIGN_ROUNDS: {
      paused: ['设计审查轮数已用尽'],
      fixOptions: ['人工确认设计方向后重新开放关卡', '或回到需求阶段澄清'],
      recommended: '先确认是需求不清还是设计分歧',
      choices: ['重新开放关卡', '回到 Plan 澄清需求', '终止该任务'],
      command: `reviewloop reopen-gate --loop ${loopId} --reason "<原因>"${reopenExtra}`,
    },
    NO_NEW_INFORMATION: {
      paused: ['本次审查没有发送：送审内容与已审查过的完全相同，重复发送不会得到新信息，只会消耗额度'],
      fixOptions: ['让 Worker 对代码或证据做出实质修改（例如缩小送审内容、修复已知问题）后再审', '重复、重试、切换提供商都不算新信息，不会被放行'],
      recommended: '先改动内容再审；这道关卡独立于其他人工确认，不会因为确认过其他异常而解除',
      choices: ['让 Worker 修改后再审', '终止该任务'],
      command: null,
    },
    ATTRIBUTION_INCOMPLETE: {
      paused: ['审查已暂停，因为无法可靠区分本次改动与之前已有的改动'],
      fixOptions: ['让工作区状态保持清晰（提交或暂存无关改动）', retry],
      recommended: retry,
      choices: ['整理工作区后继续', '终止该任务'],
      command: null,
    },
    REVIEW_FAILED: {
      paused: ['本轮独立审查没有完成，没有得出任何通过结论'],
      fixOptions: ['查看下方原因，如是临时的提供商/网络问题，稍后重试', '如是输出格式问题，检查送审内容是否过大'],
      recommended: retry,
      choices: isNewDesignLoop ? ['稍后重试审查', exceptionChoice, '终止该任务'] : ['稍后重试审查', '终止该任务'],
      command: null,
      extraFix: isNewDesignLoop ? [`如果审查工具持续无法完成，可改用替代独立审查，由你本人授权（人工授权例外，不是审查通过）：${exceptionCommand}`] : [],
    },
    TASK_DEFINITION: {
      paused: ['审查已暂停，因为冻结的任务合同没有通过完整性检查'],
      fixOptions: ['任务合同不能被改写；需要由你决定是否按原合同继续或重新开任务'],
      recommended: '把原因交给你判断：这是需求层面的决定',
      choices: ['按原合同继续', '终止并重新开始新任务（需要你明确指令）'],
      command: null,
    },
    SUPERVISOR_ESCALATION: {
      paused: ['监督者判断自动方案已无法安全推进，自动审查已停止'],
      fixOptions: ['阅读监督者的结论，作出产品/范围层面的决定', '把你的决定写进重新开放的原因里，让 Worker 按它继续'],
      recommended: '先回答监督者提出的问题、作出产品或范围决定；之后才重新开放关卡，并在原因里写明你的决定（单纯重开不会改变结果）',
      choices: ['作出决定后重新开放关卡', '缩小范围后重新开始', '终止该任务'],
      command: `reviewloop reopen-gate --loop ${loopId} --reason "<你的产品/范围决定>"${reopenExtra}`,
      extraFix: reopensDone >= STANDARD_HUMAN_REOPENS ? [`已重新开放过 ${reopensDone} 次（常规 ${STANDARD_HUMAN_REOPENS} 次）：仍可再开，但需要写明本次最多允许的审查调用数，系统会强制执行`] : [],
    },
    CANCELLED: {
      paused: ['本轮审查被中断，没有得出结论'],
      fixOptions: [retry],
      recommended: retry,
      choices: ['继续审查', '终止该任务'],
      command: null,
    },
    RESUME_PENDING: {
      paused: ['无（此前的阻断已由人工处理，该事件不再阻断）'],
      fixOptions: ['让 Worker 对代码或证据做出实质修改后再审（送审内容与上次完全相同会被信息增量规则拦住）', '其他独立关卡（预算、调用次数、未结算消耗、审查本身）在下次审查时仍会检查，不会因此放行'],
      recommended: '让 Worker 先修复报告指出的问题，再用同一个任务继续审查',
      choices: ['让 Worker 修改后再审', '终止该任务'],
      command: null,
    },
    STATE_UNREADABLE: {
      paused: ['该任务无法继续审查，也无法写入终止记录（读不出的状态不能安全写入）'],
      fixOptions: [
        stateDir
          ? `先把任务的记录目录整体复制到安全位置，保留证据（不要编辑原文件）：cp -R "${stateDir}" "<安全位置>/${loopId}-evidence"`
          : '先把该任务的记录目录整体复制到安全位置，保留证据（不要编辑原文件）',
        '记录文件本身不会被本工具自动修复，也不承诺能在原位恢复',
        '之后如需继续同一项工作，由你明确下达新任务指令；旧记录保持原样，可供人工核对或迁移',
      ],
      recommended: '先复制保存原记录，再决定是否开新任务；不要手工改动原记录',
      choices: ['保存证据后开新任务（需要你明确指令）', '保留原记录，暂不处理'],
      command: null,
    },
    OTHER: {
      paused: ['任务已暂停，等待人工处理'],
      fixOptions: [`查看任务的调用记录（${profile}）`, '根据原因文本判断是临时问题还是需要改变做法'],
      recommended: '先查看下面列出的已检查项与最小下一步，再决定',
      choices: ['处理后继续', '终止该任务'],
      command: null,
    },
  };
  return plans[category] ?? plans.OTHER;
}

// ---- builder ---------------------------------------------------------------

export function buildHumanRequiredReport({ loopId, loop, workflow, result = null, env = process.env }) {
  const reason = lastHumanRequiredReason(loop, result);
  const { category, checked, ctx } = classify({ loop, workflow, reason, result, env });
  const stateDir = clip(result?.stateUnreadable?.dir, 300) || null;
  const plan = categoryPlan(category, { loopId, workflow, loop, stateDir });

  const confirmed = [];
  const probable = [];
  const unknown = [];
  const gaps = [];
  const evidenceChecked = [...checked];
  let anomaly = { what: reason || '原因文本为空', kind: category, value: null, threshold: null };

  if (category === 'STATE_UNREADABLE') {
    const u = result?.stateUnreadable ?? {};
    confirmed.push(`无法读取该任务的状态记录（错误类别：${clip(u.errorClass, 60) || '未知'}；消息已截断：${clip(u.errorMessage, 120) || '无'}）`);
    unknown.push('记录损坏的原因与范围（工具不读取、也不输出记录内容）');
    gaps.push('记录无法解析，所以没有可用的调用/用量/审查证据可供汇总');
    evidenceChecked.push('任务状态记录的读取');
  } else if (category === 'TOKEN_SENTINEL') {
    const d = diagnoseTokenAnomaly({ loopId, workflow });
    if (d.anomaly) anomaly = d.anomaly;
    confirmed.push(...d.confirmed);
    probable.push(...d.probable);
    unknown.push(...d.unknown);
    gaps.push(...d.gaps);
    evidenceChecked.push(...d.checked);
  } else {
    if (ctx?.actions?.length) {
      for (const a of ctx.actions) confirmed.push(`此前已由人工处理：${a.text}（时间：${a.at ?? '未记录'}）`);
    }
    if (category === 'RESUME_PENDING') confirmed.push('已检查：Token 哨兵、未结算消耗、预算、调用次数与收敛状态，当前均没有仍在生效的独立阻断');
    if (category === 'SUPERVISOR_ESCALATION') {
      const g = result?.supervisorGuidance ?? loop?.lastSupervisorGuidance;
      const text = typeof g === 'string' ? g : (g ? JSON.stringify(g) : '');
      if (text) confirmed.push(`监督者的结论（节选）：${clip(text, 200)}`);
      else gaps.push('没有读到监督者的结论文字');
    }
    if (reason) confirmed.push(`停止原因（原文，已截断）：${reason}（来源：任务历史记录）`);
    else gaps.push('任务历史中没有记录停止原因的文字');
    if (category === 'OTHER') {
      evidenceChecked.push('任务历史中的最后一次停止记录', '结果中的原因字段');
      gaps.push('停止原因没有匹配任何已知类别，无法进一步归因');
      unknown.push('具体根因：现有记录只给出上面的原文');
    }
  }

  const spendRecords = Array.isArray(workflow?.reviewLoopSpend?.records) ? workflow.reviewLoopSpend.records : [];
  const acks = Array.isArray(workflow?.[TOKEN_ANOMALY_ACKS_KEY]) ? workflow[TOKEN_ANOMALY_ACKS_KEY] : [];
  const volume = spendRecords.reduce((a, r) => a + (Number.isFinite(r?.usageVolume) ? r.usageVolume : 0), 0);
  const impact = {
    paused: plan.paused,
    preserved: ['冻结的任务合同、基线、已完成阶段、审查证据', '全部消费记录与异常记录（不会被改写）'],
    spend: `已有 ${spendRecords.length} 次模型调用记录，累计用量约 ${num(volume)}（部分调用的用量/费用可能未知，未知不当作 0）`,
  };
  if (category === 'STATE_UNREADABLE') {
    impact.preserved = ['原状态记录没有被本工具修改或删除'];
    impact.spend = '无法读取，未汇总';
  }
  if (category === 'TOKEN_SENTINEL' && acks.length > 0) {
    impact.preserved.push(`此前已有 ${acks.length} 次人工确认记录（常规 ${TOKEN_ACK_STANDARD_LIMIT} 次，超过后仍可确认，但需写明本次最多允许的审查调用数）`);
  }

  if (category !== 'STATE_UNREADABLE') {
    const exc = evaluateDesignException(workflow);
    if (exc.valid) {
      confirmed.push(`已由人工授权例外：设计 ${exc.active.designSha256.slice(0, 12)}… 可以进入 Code（来源：人工裁决记录 ${exc.active.id}）；这不是 ReviewLoop 审查通过，原审查仍未通过`);
      impact.preserved.push('人工授权例外记录（单独保存，没有改动原审查状态）');
    } else if (exc.status === 'INVALID') {
      gaps.push(`存在人工授权例外记录，但已失效：${clip(exc.reason, 120)}`);
    }
  }
  const fixOptions = [...plan.fixOptions, ...(plan.extraFix ?? [])];
  // Every category ends with the same real exit: end the task, keep every record.
  // (Not offered when the record cannot be read: nothing can be written to it.)
  const terminate = category === 'STATE_UNREADABLE'
    ? null
    : `reviewloop stop-loop --loop ${loopId} --reason "<为什么终止>"`;
  const humanDecision = { choices: plan.choices, command: plan.command, terminate };

  if (category === 'RESUME_PENDING') anomaly = { what: '此前的停止已由人工处理，任务等待继续审查', kind: category, value: null, threshold: null };
  if (category === 'STATE_UNREADABLE') anomaly = { what: '任务的状态记录无法读取', kind: category, value: null, threshold: null };
  const headline = clip(`${LABEL[category]}：${headlineDetail(category, anomaly, reason)}`, HEADLINE_MAX);
  const report = {
    version: REPORT_VERSION,
    category,
    headline,
    status: {
      loopId,
      taskType: loop?.objective?.taskType ?? 'code',
      phase: loop?.currentPhaseIndex ?? null,
      round: loop?.round ?? null,
      state: 'HUMAN_REQUIRED',
    },
    anomaly,
    causes: { confirmed, probable, unknown },
    evidenceChecked,
    evidenceGaps: gaps,
    impact,
    fixOptions,
    recommended: plan.recommended,
    humanDecision,
  };
  report.reportText = renderReportText(report);
  return report;
}

function headlineDetail(category, anomaly, reason) {
  if (category === 'RESUME_PENDING') return '无仍在生效的阻断，修改后可继续审查';
  if (category === 'STATE_UNREADABLE') return '请先保存原记录，不要手工改动';
  if (category === 'TOKEN_SENTINEL' && anomaly?.value != null) {
    return `${anomaly.what.replace('超过安全阈值', '')} ${num(anomaly.value)} 超过阈值 ${num(anomaly.threshold)}`;
  }
  return reason ? clip(reason, 80) : '原因记录缺失，见报告';
}

export function renderReportText(r) {
  const L = [];
  L.push(`【需要你决定】${r.headline}`);
  L.push(`状态：已暂停，等待人工（任务 ${r.status.loopId}，${r.status.taskType === 'design' ? '设计' : '代码'}阶段，第 ${r.status.round ?? '?'} 轮）`);
  L.push('', '一、发生了什么', `  ${r.anomaly?.what ?? ''}`);
  L.push('', '二、原因与证据');
  L.push('  已证实：');
  if (r.causes.confirmed.length) r.causes.confirmed.forEach((x) => L.push(`   - ${x}`)); else L.push('   - （无）');
  if (r.causes.probable.length) {
    L.push('  可能（推测）：');
    r.causes.probable.forEach((p) => L.push(`   - ${p.text}｜依据：${p.basis}｜不确定：${p.uncertainty}`));
  }
  L.push('  仍未知：');
  if (r.causes.unknown.length) r.causes.unknown.forEach((x) => L.push(`   - ${x}`)); else L.push('   - （无）');
  L.push('  已检查：');
  r.evidenceChecked.forEach((x) => L.push(`   - ${x}`));
  if (r.evidenceGaps.length) {
    L.push('  证据缺口：');
    r.evidenceGaps.forEach((x) => L.push(`   - ${x}`));
  }
  L.push('', '三、影响范围');
  r.impact.paused.forEach((x) => L.push(`  - 已暂停：${x}`));
  r.impact.preserved.forEach((x) => L.push(`  - 已保留：${x}`));
  L.push(`  - 消耗：${r.impact.spend}`);
  L.push('', '四、修复方案');
  r.fixOptions.forEach((x) => L.push(`  - ${x}`));
  L.push('', `五、推荐：${r.recommended}`);
  L.push('', '六、需要你决定');
  r.humanDecision.choices.forEach((x) => L.push(`  - ${x}`));
  if (r.humanDecision.command) L.push('  可复制的操作命令（由你本人执行）：', `    ${r.humanDecision.command}`);
  if (r.humanDecision.terminate) {
    L.push('  终止任务（保留全部记录，不可撤销，由你本人执行）：', `    ${r.humanDecision.terminate}`);
  }
  L.push('', '说明：这份报告只读取已有记录，没有调用任何模型；未确认的内容已标明为推测或未知。');
  return L.join('\n');
}

// Never throws. On any failure returns a minimal, still-actionable report.
export function safeBuildHumanRequiredReport({ loopId, loop, workflow, result = null, env = process.env }) {
  try {
    return buildHumanRequiredReport({ loopId, loop, workflow, result, env });
  } catch (err) {
    const reason = clip(result?.reason, TEXT_MAX) || '原因记录缺失';
    const minimal = {
      version: REPORT_VERSION,
      category: 'OTHER',
      headline: clip(`${LABEL.OTHER}：${reason}`, HEADLINE_MAX),
      status: { loopId, taskType: loop?.objective?.taskType ?? 'code', phase: null, round: result?.round ?? null, state: 'HUMAN_REQUIRED' },
      anomaly: { what: reason, kind: 'OTHER', value: null, threshold: null },
      causes: { confirmed: [`停止原因（原文，已截断）：${reason}`], probable: [], unknown: ['诊断生成失败，根因未能分析'] },
      evidenceChecked: ['停止结果中的原因字段'],
      evidenceGaps: [`诊断生成失败：${clip(err?.message, 100)}`],
      impact: { paused: ['任务已暂停，等待人工处理'], preserved: ['任务合同、消费记录与证据均未改动'], spend: '未能汇总' },
      fixOptions: [`运行 reviewloop profile --loop ${loopId} 查看调用记录`],
      recommended: '先运行上面的只读命令确认状态，再决定',
      humanDecision: { choices: ['处理后继续', '终止该任务'], command: null, terminate: `reviewloop stop-loop --loop ${loopId} --reason "<为什么终止>"` },
    };
    minimal.reportText = renderReportText(minimal);
    return minimal;
  }
}
