// Pure provider-aware token accounting; no durable state or provider dispatch.
// ---- provider/family-aware token accounting --------------------------------
//
// `usageVolume` is the HARD safety ceiling (REVIEWLOOP_MAX_USAGE_VOLUME), so it
// MUST NOT double-count. Cache semantics differ per provider family:
//
//   OpenAI / Codex : `cached` (a.k.a. cache_read) tokens are a SUBSET of the
//                    input/prompt tokens, and reasoning tokens are a subset of
//                    output. `input + output + cache_read` bills the cached
//                    prefix twice. Codex live evidence: input 16922
//                    (cache_read 10624 of it) + output 9 -> volume 16931.
//   Anthropic      : cache_creation and cache_read are SEPARATE billing
//                    categories from uncached input; thinking is already inside
//                    output. All three input categories add.
//   AGY (Gemini /  : the CLI surfaces a provider-reported authoritative total
//   gpt-oss)         that is the source of truth (Gemini live: input 6713 +
//                    output 539 == reported total 7252; cache_read 8128 is NOT
//                    additive and is not even mechanically a subset of input).
//
// Precedence for every family:
//   1. an authoritative provider-reported total, ONLY from a token-total field
//      mechanically confirmed for THIS provider/family schema -> use it verbatim
//   2. else a family-specific deterministic fallback (semantics confirmed) —
//      reported semanticsKnown:true ONLY when every field that fallback
//      mechanically requires is actually present. A required field that is
//      absent is UNKNOWN, never 0: the accounting is marked volumeResolved:false
//      and the caller routes it into the existing UNRESOLVED / fail-closed
//      spend path (it must not settle as precise known spend).
//   3. else a conservative additive sum, FLAGGED semanticsKnown:false —
//      UNKNOWN != ZERO: never under-count a safety ceiling, never pretend the
//      number is an exact provider figure. This is the accepted floor-safe
//      posture for AGY-without-total / unknown providers (volumeResolved:true,
//      but explicitly not exact).
//
// The raw per-field breakdown is ALWAYS preserved for telemetry regardless of
// which method produced the volume.

const ACCOUNTING_CLASS_BY_FAMILY = Object.freeze({
  'codex:default': 'openai',
  'claude:opus': 'anthropic',
  'agy:gemini-reviewer': 'agy',
  'agy:gemini-supervisor': 'agy',
  'agy:gpt-oss': 'agy',
  'agy:sonnet': 'agy',
  'agy:opus': 'agy',
});

const ACCOUNTING_CLASS_BY_PROVIDER = Object.freeze({
  codex: 'openai',
  openai: 'openai',
  claude: 'anthropic',
  anthropic: 'anthropic',
  'agy-gemini': 'agy',
  'agy-gpt-oss': 'agy',
  'agy-claude-gpt': 'agy',
  agy: 'agy',
});

// Token-total field names that are MECHANICALLY CONFIRMED to be an authoritative
// aggregate token total for a given accounting class. A bare `total` is never
// trusted; an unknown provider has no trusted total field at all.
//   - openai   : OpenAI usage envelopes / Codex `token_count` events -> total_tokens
//   - anthropic: the Anthropic Messages API returns NO aggregate token total
//                (only input/output/cache_* categories) -> always fall through
//   - agy      : the AGY CLI envelope surfaces a provider total (Gemini live:
//                input 6713 + output 539 == 7252); Gemini-native is
//                totalTokenCount
const AUTHORITATIVE_TOTAL_ALIASES = Object.freeze({
  openai: ['total_tokens', 'totalTokens'],
  anthropic: [],
  agy: ['total_tokens', 'totalTokens', 'total_token_count', 'totalTokenCount'],
  unknown: [],
});

function pickFinite(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Deterministic accounting class from the ACTUAL family/provider bound into the
// CallIntent — never guessed from a model-name string.
export function accountingClassOf({ family = null, provider = null } = {}) {
  if (typeof family === 'string' && ACCOUNTING_CLASS_BY_FAMILY[family]) {
    return ACCOUNTING_CLASS_BY_FAMILY[family];
  }
  if (typeof provider === 'string') {
    const p = provider.toLowerCase();
    if (ACCOUNTING_CLASS_BY_PROVIDER[p]) return ACCOUNTING_CLASS_BY_PROVIDER[p];
    if (p.startsWith('agy')) return 'agy';
    if (p.startsWith('codex') || p.startsWith('openai')) return 'openai';
    if (p.startsWith('claude') || p.startsWith('anthropic')) return 'anthropic';
  }
  return 'unknown';
}

// Raw provider usage fields, null (never 0) when unreported.
function rawUsageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: null, outputTokens: null, thinkingTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, reportedTotalTokens: null,
    };
  }
  const g = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  return {
    inputTokens: g('input_tokens', 'inputTokens', 'prompt_tokens'),
    outputTokens: g('output_tokens', 'outputTokens', 'completion_tokens'),
    thinkingTokens: g(
      'thinking_tokens', 'thinkingTokens', 'reasoning_tokens', 'reasoningTokens',
      'thoughts_token_count', 'thoughtsTokenCount',
    ),
    cacheReadTokens: g(
      'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_input', 'cache_read_tokens',
      'cached_input_tokens', 'cached_content_token_count', 'cachedContentTokenCount',
    ),
    cacheCreationTokens: g(
      'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_creation_input', 'cache_creation_tokens',
    ),
    reportedTotalTokens: g(
      'total_tokens', 'totalTokens', 'total', 'total_token_count', 'totalTokenCount',
    ),
  };
}

const tok = (v) => (Number.isFinite(v) ? v : 0);

// Provider/family-aware deterministic accounting. Returns the budget
// `usageVolume`, the method used to derive it, whether the cache semantics are
// mechanically confirmed for this family (`semanticsKnown`), whether a
// mechanically-precise volume could actually be computed from the reported
// fields (`volumeResolved` — false means a required field was absent and the
// caller must fail closed, NOT treat the gap as 0), the authoritative provider
// total actually trusted (or null), and the raw breakdown. Callers MUST pass
// the real family + provider bound into the CallIntent.
export function usageAccountingOf({ usage = null, family = null, provider = null } = {}) {
  const cls = accountingClassOf({ family, provider });
  const b = rawUsageFields(usage);
  const has = usage != null && typeof usage === 'object';
  const build = (usageVolume, method, semanticsKnown, volumeResolved, trustedTotal = null) => ({
    usageVolume,
    usageAccountingMethod: method,
    semanticsKnown,
    volumeResolved,
    accountingClass: cls,
    // the total actually TRUSTED for the volume (null unless method is
    // provider_total from a confirmed alias)
    reportedTotalTokens: Number.isFinite(trustedTotal) ? trustedTotal : null,
    // raw diagnostic: any total-ish field the envelope carried, trusted or not
    rawReportedTotalField: b.reportedTotalTokens,
    breakdown: b,
  });

  if (!has) return build(0, 'no_usage_reported', false, false);

  // 1. authoritative provider-reported total — ONLY from a token-total field
  //    mechanically confirmed for this provider/family schema. An unknown
  //    provider (or a bare `total`) never reaches this branch.
  const trustedTotal = pickFinite(usage, AUTHORITATIVE_TOTAL_ALIASES[cls] ?? []);
  if (Number.isFinite(trustedTotal)) {
    return build(trustedTotal, 'provider_total', true, true, trustedTotal);
  }

  // 2. family-specific deterministic fallback. `semanticsKnown` / `volumeResolved`
  //    are true ONLY when every field the fallback mechanically requires is
  //    actually present — an absent required field is UNKNOWN, never 0.
  if (cls === 'openai') {
    // OpenAI/Codex: cache_read ⊂ input, reasoning ⊂ output — add neither.
    // Required: input_tokens AND output_tokens.
    const resolved = Number.isFinite(b.inputTokens) && Number.isFinite(b.outputTokens);
    return build(
      tok(b.inputTokens) + tok(b.outputTokens),
      'openai_input_plus_output', resolved, resolved,
    );
  }
  if (cls === 'anthropic') {
    // Anthropic: uncached input + output + the two SEPARATE cache categories.
    // The Messages API always emits input_tokens + output_tokens; the two
    // cache_* categories appear iff prompt caching was used and their absence
    // is a schema-defined 0 (not "unknown"). A missing input/output means the
    // envelope is incomplete.
    const resolved = Number.isFinite(b.inputTokens) && Number.isFinite(b.outputTokens);
    return build(
      tok(b.inputTokens) + tok(b.outputTokens) + tok(b.cacheCreationTokens) + tok(b.cacheReadTokens),
      'anthropic_cache_additive', resolved, resolved,
    );
  }

  // 3. AGY without a confirmed total, or a fully unknown provider: we cannot
  //    prove whether cache_read is a subset or a separate category. Sum every
  //    reported field (conservative — never under-count a safety ceiling) and
  //    flag the semantics UNKNOWN. This is the ACCEPTED floor-safe posture for
  //    these families, so volumeResolved stays true (the number is usable as a
  //    ceiling input, just never asserted as exact).
  return build(
    tok(b.inputTokens) + tok(b.outputTokens) + tok(b.thinkingTokens)
      + tok(b.cacheCreationTokens) + tok(b.cacheReadTokens),
    'conservative_additive_unknown', false, true,
  );
}

// True when a post-dispatch usage object IS present but the confirmed accounting
// method for this family cannot derive a mechanically-known volume from it
// (a required field is absent). UNKNOWN != ZERO: such a call must settle
// UNRESOLVED, exactly like a missing usage object.
export function usagePresentButUnresolved({ usage, family, provider }) {
  if (usage == null || typeof usage !== 'object') return false;
  return usageAccountingOf({ usage, family, provider }).volumeResolved === false;
}

// Back-compat helper: the budget volume alone. Pass { family, provider } for
// provider-aware accounting; without them the conservative additive path is
// used (UNKNOWN != ZERO, may over-count — never silently under-count).
export function usageVolumeOf(usage, { family = null, provider = null } = {}) {
  return usageAccountingOf({ usage, family, provider }).usageVolume;
}

// Compact provenance persisted on every durable spend record: given a later
// `usageVolume`, this says exactly how it was derived.
export function accountingProvenanceOf(accounting) {
  return {
    method: accounting.usageAccountingMethod,
    semanticsKnown: accounting.semanticsKnown === true,
    volumeResolved: accounting.volumeResolved === true,
    accountingClass: accounting.accountingClass,
    // the token total actually TRUSTED for usageVolume (null unless method is
    // provider_total from a confirmed alias for this family)
    reportedTotalTokens: Number.isFinite(accounting.reportedTotalTokens)
      ? accounting.reportedTotalTokens
      : null,
  };
}

// Provider-reported usage broken out per field. UNKNOWN != ZERO: a field the
// provider did not report is `null`, never 0. Persisted per physical call so
// transport-context overhead ("diff 20k chars, yet input 120k tokens") is
// diagnosable after the fact — never estimated into a hard number.
//   - `reportedTotalTokens` : STRICTLY a total-ish field the provider put in the
//                             envelope (null if none). NOT necessarily the
//                             authoritative total for this family (see
//                             usageAccountingOf / AUTHORITATIVE_TOTAL_ALIASES),
//                             and NOT necessarily equal to usageVolume.
//   - `rawFieldSumTokens`   : a DIAGNOSTIC arithmetic sum of the raw numeric
//                             usage fields. It is NOT a token-accounting total,
//                             double-counts cache for subset-semantics
//                             providers, and must never be read as usageVolume.
export function usageBreakdownOf(usage) {
  const b = rawUsageFields(usage);
  const parts = [b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheCreationTokens]
    .filter((v) => Number.isFinite(v));
  return {
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    thinkingTokens: b.thinkingTokens,
    cacheReadTokens: b.cacheReadTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    reportedTotalTokens: b.reportedTotalTokens,
    rawFieldSumTokens: parts.length ? parts.reduce((a, c) => a + c, 0) : null,
  };
}

// Mechanical payload-size metadata for a review/supervise physical call. Only
// lengths and machine metadata — never prompt text. `estimatedPayloadTokens`
// is a deliberately coarse chars/4 proxy so a caller can compare it to the
// provider's reported input token count and see transport context tax.
export function payloadMetaOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  const promptChars = n(meta.promptChars);
  const out = {
    promptChars,
    diffChars: n(meta.diffChars),
    reviewPayloadChars: n(meta.reviewPayloadChars ?? meta.promptChars),
    estimatedPayloadTokens: Number.isFinite(promptChars) ? Math.round(promptChars / 4) : null,
    ...(meta.promptComponentStats && typeof meta.promptComponentStats === 'object'
      ? { promptComponentStats: meta.promptComponentStats }
      : {}),
  };
  return out;
}

// The provider-billed INPUT token count that a payload-size proxy should be
// compared against — provider/accounting-aware, because "input" is not the same
// quantity across families:
//   - Anthropic : the Messages API bills uncached input + cache_creation +
//                 cache_read as three SEPARATE input categories. `input_tokens`
//                 alone is only the uncached slice, so a call with input=2 and
//                 cache_creation=31000 has ~31k of real input context. The two
//                 cache_* categories are a schema-defined 0 when absent.
//   - OpenAI/Codex : cache_read ⊂ input_tokens already — never add it.
//   - AGY / unknown : only the confirmed semantics. AGY's cache_read is NOT
//                 mechanically a subset of input and NOT confirmed additive —
//                 do not guess a cache relationship; use input_tokens as-is.
// null when input_tokens itself is UNKNOWN (never treated as 0).
export function effectiveContextInputTokens(breakdown, { family = null, provider = null } = {}) {
  const input = breakdown?.inputTokens;
  if (!Number.isFinite(input)) return null;
  const cls = accountingClassOf({ family, provider });
  if (cls === 'anthropic') {
    return input + tok(breakdown.cacheCreationTokens) + tok(breakdown.cacheReadTokens);
  }
  return input;
}

// input tokens the provider billed that are NOT explained by the payload we
// sent — the transport context tax (system prompt, tools, workspace preload).
// null when either side is UNKNOWN; never negative. Provider-aware on the input
// side (see effectiveContextInputTokens) so an Anthropic cached-context call
// cannot report ~0 overhead while carrying tens of thousands of cache tokens.
export function contextOverheadTokens(breakdown, payloadMeta, { family = null, provider = null } = {}) {
  const input = effectiveContextInputTokens(breakdown, { family, provider });
  const est = payloadMeta?.estimatedPayloadTokens;
  if (!Number.isFinite(input) || !Number.isFinite(est)) return null;
  return Math.max(0, input - est);
}

