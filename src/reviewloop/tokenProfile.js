// Read-only, zero-model-token diagnostics over ReviewLoop's durable physical spend
// ledger. Does not infer unseen calls, mutate workflow state or reconstruct spend.
// Raw cache token fields are diagnostics, NOT additive to usageVolume: providers
// account for cache differently (see usageAccounting.js).
//
// Character counts are exact measurements of composed prompts (where reported);
// contextOverheadTokens and estimatedPayloadTokens are chars/4-derived proxies,
// NOT provider-reported token allocations.

export const PROFILE_COMPONENTS = Object.freeze([
  'goalChars',
  'contractChars',
  'constraintsChars',
  'scopeChars',
  'diffScopeChars',
  'changedFilesChars',
  'gateChars',
  'evidenceChars',
  'supervisorChars',
  'previousFindingsChars',
  'diffChars',
  'instructionsChars',
]);

export const PROFILE_USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reportedTotalTokens',
]);

const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const index = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const named = (value) => typeof value === 'string' && value.trim() ? value : null;

function callFromRecord(record, ordinal) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('invalid durable spend record at index ' + ordinal);
  }
  const b = record.usageBreakdown ?? {};
  const meta = record.payloadMeta ?? {};
  const stats = meta.promptComponentStats ?? {};
  const components = {};
  for (const field of PROFILE_COMPONENTS) {
    const n = finite(stats[field]);
    if (n != null) components[field] = n;
  }
  const breakdown = {};
  for (const field of PROFILE_USAGE_FIELDS) breakdown[field] = finite(b[field]);

  const costUsd = finite(record.costUsd);
  const costKnown = record.costKnown !== false && costUsd != null;
  const semantics = record.usageAccounting?.semanticsKnown;
  return {
    ordinal: ordinal + 1,
    role: named(record.role) ?? 'unknown',
    round: index(record.round),
    chunkIndex: index(record.chunkIndex),
    chunkTotal: index(record.chunkTotal),
    family: named(record.family),
    provider: named(record.provider),
    model: named(record.model),
    outcome: named(record.businessOutcome),
    usageVolume: finite(record.usageVolume),
    usageKnown: record.usageKnown === true,
    accountingMethod: named(record.usageAccounting?.method),
    semanticsKnown: semantics === true ? true : (semantics === false ? false : null),
    costUsd: costKnown ? costUsd : null,
    costKnown,
    breakdown,
    prompt: {
      promptChars: finite(meta.promptChars),
      diffChars: finite(meta.diffChars),
      estimatedPayloadTokens: finite(meta.estimatedPayloadTokens),
      estimatedContextOverheadTokens: finite(record.contextOverheadTokens),
      components,
      contractSha256: typeof stats.contractSha256 === 'string' && /^[a-f0-9]{64}$/i.test(stats.contractSha256)
        ? stats.contractSha256.toLowerCase()
        : null,
    },
  };
}

function aggregateCalls(calls) {
  const out = {
    physicalCalls: calls.length,
    reviewerCalls: 0,
    supervisorCalls: 0,
    ledgerUsageVolume: 0,
    missingVolumeRecords: 0,
    unknownUsageCalls: 0,
    unknownSemanticsCalls: 0,
    knownCostUsd: 0,
    unknownCostCalls: 0,
  };
  for (const call of calls) {
    if (call.role === 'reviewer') out.reviewerCalls += 1;
    if (call.role === 'supervisor') out.supervisorCalls += 1;
    if (call.usageVolume == null) out.missingVolumeRecords += 1;
    else out.ledgerUsageVolume += call.usageVolume;
    if (!call.usageKnown) out.unknownUsageCalls += 1;
    if (call.semanticsKnown === false) out.unknownSemanticsCalls += 1;
    if (call.costKnown) out.knownCostUsd += call.costUsd;
    else out.unknownCostCalls += 1;
  }
  return out;
}

// Pure projection over a workflow snapshot. No persistence or model calls.
// The input may include prompt text in unrelated workflow fields; only
// whitelisted numeric metadata and identifiers are returned.
export function buildTokenProfile({ loopId, workflow } = {}) {
  if (typeof loopId !== 'string' || !loopId.trim()) throw new Error('token profile requires a loopId');
  if (!workflow || !workflow.reviewLoop) throw new Error('unknown ReviewLoop session ' + loopId);

  const ledgerAvailable = Array.isArray(workflow.reviewLoopSpend?.records);
  const records = ledgerAvailable ? workflow.reviewLoopSpend.records : [];
  const calls = records.map(callFromRecord);
  const rawUsage = {};
  for (const field of PROFILE_USAGE_FIELDS) {
    const values = calls.map((c) => c.breakdown[field]).filter((v) => v != null);
    rawUsage[field] = {
      reportedCalls: values.length,
      sum: values.reduce((a, b) => a + b, 0),
    };
  }

  const components = {};
  for (const field of PROFILE_COMPONENTS) {
    const values = calls.map((c) => c.prompt.components[field]).filter((v) => v != null);
    components[field] = {
      reportedCalls: values.length,
      chars: values.reduce((a, b) => a + b, 0),
    };
  }

  let verifiedRepeatedContractChars = 0;
  const seenContractHashes = new Set();
  for (const call of calls) {
    const hash = call.prompt.contractSha256;
    const chars = call.prompt.components.contractChars;
    if (!hash || !Number.isFinite(chars) || chars <= 0) continue;
    if (seenContractHashes.has(hash)) verifiedRepeatedContractChars += chars;
    else seenContractHashes.add(hash);
  }

  const byRound = new Map();
  for (const call of calls) {
    const key = call.round == null ? 'unattributed' : String(call.round);
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(call);
  }
  const rounds = [...byRound.entries()].map(([key, entries]) => ({
    round: key === 'unattributed' ? null : Number(key),
    summary: aggregateCalls(entries),
    calls: entries,
  }));

  return {
    version: 1,
    loopId,
    ledgerAvailable,
    summary: aggregateCalls(calls),
    rawUsage,
    prompt: {
      components,
      verifiedRepeatedContractChars,
      promptChars: {
        reportedCalls: calls.filter((c) => c.prompt.promptChars != null).length,
        chars: calls.reduce((a, c) => a + (c.prompt.promptChars ?? 0), 0),
      },
      estimatedContextOverheadTokens: {
        reportedCalls: calls.filter((c) => c.prompt.estimatedContextOverheadTokens != null).length,
        estimatedTokens: calls.reduce((a, c) => a + (c.prompt.estimatedContextOverheadTokens ?? 0), 0),
      },
    },
    rounds,
    notes: [
      'ledgerUsageVolume is the recorded safety-budget volume, not a cache-adjusted bill. Unknown usage is not assumed to be zero.',
      'Raw input, output, thinking and cache fields may overlap; do not add them to ledgerUsageVolume.',
      'Prompt components are character counts, not exact tokens. Estimated transport overhead is a chars/4-derived proxy.',
      'Verified repeated contract characters have identical content hashes, but are not a proven avoidable cost.',
      'Only persisted physical call records are included; missing legacy records cannot be reconstructed here.',
    ],
  };
}

const fmt = (n) => n == null ? '?' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const money = (n) => n == null ? '?' : '$' + Number(n).toFixed(4);

export function formatTokenProfile(profile) {
  const s = profile.summary;
  const lines = [
    'ReviewLoop Token Profile (read-only, no model calls)',
    'Loop: ' + profile.loopId,
    'Durable spend ledger: ' + (profile.ledgerAvailable ? 'available' : 'MISSING (cannot infer zero usage)'),
    'Physical calls: ' + s.physicalCalls + ' (reviewer ' + s.reviewerCalls
      + ', supervisor ' + s.supervisorCalls + ')',
    'Ledger usageVolume: ' + fmt(s.ledgerUsageVolume)
      + ' | unknown usage calls: ' + s.unknownUsageCalls
      + ' | missing numeric volumes: ' + s.missingVolumeRecords
      + ' | conservative/unknown semantics: ' + s.unknownSemanticsCalls,
    'Known cost subtotal: ' + money(s.knownCostUsd)
      + ' | unknown-cost calls: ' + s.unknownCostCalls,
    '',
    'Raw provider token fields (separate diagnostics; NOT additive):',
  ];
  for (const field of PROFILE_USAGE_FIELDS) {
    const m = profile.rawUsage[field];
    lines.push('  ' + field + ': ' + fmt(m.sum) + ' (reported ' + m.reportedCalls
      + '/' + s.physicalCalls + ' calls)');
  }
  lines.push('', 'Prompt components (CHARACTERS, not tokens):');
  for (const [field, info] of Object.entries(profile.prompt.components)
    .filter(([, info]) => info.reportedCalls)
    .sort((a, b) => b[1].chars - a[1].chars)) {
    lines.push('  ' + field + ': ' + fmt(info.chars) + ' chars ('
      + info.reportedCalls + '/' + s.physicalCalls + ' calls)');
  }
  lines.push('  Verified resubmitted frozen contract: ' + fmt(profile.prompt.verifiedRepeatedContractChars)
    + ' chars (identical hash; not necessarily avoidable)');
  lines.push('  Estimated transport context overhead: '
    + fmt(profile.prompt.estimatedContextOverheadTokens.estimatedTokens)
    + ' tokens (proxy, ' + profile.prompt.estimatedContextOverheadTokens.reportedCalls + ' calls)');
  lines.push('', 'Physical calls by review round:');
  for (const group of profile.rounds) {
    lines.push('  Round ' + (group.round ?? '?') + ': '
      + group.summary.physicalCalls + ' calls, usageVolume '
      + fmt(group.summary.ledgerUsageVolume));
    for (const c of group.calls) {
      const chunk = c.chunkIndex == null
        ? '-'
        : String(c.chunkIndex) + '/' + (c.chunkTotal ?? '?');
      lines.push('    #' + c.ordinal + ' ' + c.role + ' chunk=' + chunk
        + ' model=' + (c.model ?? c.family ?? '?')
        + ' volume=' + fmt(c.usageVolume)
        + ' input=' + fmt(c.breakdown.inputTokens)
        + ' output=' + fmt(c.breakdown.outputTokens)
        + ' cacheRead=' + fmt(c.breakdown.cacheReadTokens)
        + ' cost=' + money(c.costUsd)
        + ' promptChars=' + fmt(c.prompt.promptChars));
    }
  }
  if (!profile.rounds.length) lines.push('  No durable physical calls recorded.');
  lines.push('', 'Accounting limitations:');
  for (const note of profile.notes) lines.push('  - ' + note);
  return lines.join('\n');
}
