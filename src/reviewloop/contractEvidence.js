import { createHash } from 'node:crypto';

// Frozen task-contract handoff, evidence obligations, and phase resume packets.
//
// This module is deliberately provider-agnostic. It turns user-facing task
// contracts into durable machine-checkable boundaries without trying to parse
// arbitrary prose beyond a narrow fail-closed guard for clearly-declared phase
// plans or references to missing prior conversation.

const EVIDENCE_TYPES = new Set(['runtime', 'artifact', 'manual', 'other']);

export const CONTRACT_TEXT_MAX_BYTES = 64 * 1024;
export class ContractValidationError extends Error {
  constructor() {
    super(`reviewloop_begin: contractText exceeds the ${CONTRACT_TEXT_MAX_BYTES}-byte UTF-8 limit; supply a concise self-contained contract preserving all acceptance criteria, never a truncated contract or a reference to chat history`);
    this.name = 'ContractValidationError';
  }
}

// UTF-8 byte limits, enforced before binding/persisting or spending model tokens.
// Reject rather than truncate proof: the Reviewer must see everything accepted.
export const EVIDENCE_LIMITS = Object.freeze({
  items: 64,
  idBytes: 128,
  summaryBytes: 4096,
  artifactRefBytes: 1024,
  requirementsBytes: 16 * 1024,
  promptBytes: 24 * 1024,
});

export class EvidenceValidationError extends Error {
  constructor(message) {
    super(`reviewloop_review: ${message}`);
    this.name = 'EvidenceValidationError';
    this.code = 'INVALID_EVIDENCE';
  }
}

const bytes = (value) => Buffer.byteLength(String(value), 'utf8');

function assertEvidenceText(value, label, limit, { optional = false } = {}) {
  if (optional && (value == null || (typeof value === 'string' && !value.trim()))) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new EvidenceValidationError(`${label} must be a nonempty string`);
  }
  if (bytes(value) > limit) {
    throw new EvidenceValidationError(`${label} exceeds the ${limit}-byte limit; submit a concise factual summary and an artifact reference instead of raw logs`);
  }
}

// This is also the provider's exact evidence rendering. The aggregate limit
// therefore covers optional descriptions, covers, refs and formatting, not just
// summaries, and cannot diverge from what every diff chunk actually receives.
export function evidencePromptLines(evidence) {
  const normalizedSubmissions = normalizeEvidenceSubmissions(evidence?.submissions);
  const lines = [
    evidence?.requirements?.length
      ? `EVIDENCE REQUIREMENTS / CONTEXT FOR THIS GATE:
${evidence.requirements.map((r) => `- ${r.id} [${r.type}; ${r.required === false ? 'optional' : 'required'}]: ${r.description}${r.covers?.length ? ` (covers ${r.covers.join(', ')})` : ''}`).join('\n')}`
      : '',
    normalizedSubmissions.length
      ? `SUBMITTED EVIDENCE:
${normalizedSubmissions.map((e) => `- ${e.requirementId}: ${e.summary}${e.artifactRef ? ` [${e.artifactRef}]` : ''}`).join('\n')}`
      : '',
    evidence?.requirements?.length
      ? 'Judge whether submitted evidence proves the behavior its requirement describes. Required evidence must be sufficient to pass; optional evidence may inform review but does not itself block when absent. Do not treat mere presence as proof.'
      : '',
  ];
  if (bytes(lines.join('\n')) > EVIDENCE_LIMITS.promptBytes) {
    throw new EvidenceValidationError(`combined evidence prompt exceeds the ${EVIDENCE_LIMITS.promptBytes}-byte limit; shorten submitted summaries or artifact references without omitting required proof`);
  }
  return lines;
}

const list = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value]))
  .map((v) => String(v).trim())
  .filter(Boolean);

export function normalizeContractText(value) {
  const text = value == null ? '' : String(value);
  // Check the raw input too: whitespace padding is not a budget escape hatch.
  if (bytes(text) > CONTRACT_TEXT_MAX_BYTES) throw new ContractValidationError();
  return text.trim();
}

function uniqueSortedPhaseNumbers(text) {
  return [...new Set(
    [...String(text ?? '').matchAll(/\bphase\s+([1-9]\d*)\b/ig)]
      .map((m) => Number(m[1])),
  )].sort((a, b) => a - b);
}

function contiguousPhaseCount(numbers) {
  if (!Array.isArray(numbers) || numbers.length < 2 || numbers[0] !== 1) return null;
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) return null;
  }
  return numbers.length;
}

export function declaredPhasePlan(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { count: null, numbers: [], source: null, invalid: null };

  const explicitCounts = [
    ...[...s.matchAll(/\b(?:full|complete)\s+(?:spec|specification|contract)\s+(?:has|consists\s+of)\s+([2-9]|[1-9]\d+)\s*(?:-\s*)?phases?\b/ig)]
      .map((m) => Number(m[1])),
    ...[...s.matchAll(/\b([2-9]|[1-9]\d+)\s*(?:-\s*)?phases?\s+execution\s+plan\b/ig)]
      .map((m) => Number(m[1])),
    ...[...s.matchAll(/\bexecution\s+plan\s+(?:(?:has|with|contains|includes|including)\s+(?:the\s+)?|consists\s+of\s+)([2-9]|[1-9]\d+)\s*(?:-\s*)?phases?\b/ig)]
      .map((m) => Number(m[1])),
    ...[...s.matchAll(/\b(?:this|the)\s+(?:task|work|implementation)\s+(?:(?:has|contains|includes)\s+(?:the\s+)?|consists\s+of\s+)([2-9]|[1-9]\d+)\s*(?:-\s*)?phases?\b/ig)]
      .map((m) => Number(m[1])),
  ];

  // Phase headings are declarations only inside strong task-plan context.
  // Generic prose/documents often contain "Phase 1"/"Phase 2" headings that
  // describe historical protocols rather than this task. An explicit count
  // already declares a plan; otherwise require an Execution Plan heading.
  const planHeading = /^\s{0,3}(?:#{1,6}\s*)?(?:the[ \t]+)?execution[ \t]+plan[ \t]*:?/im.exec(s);
  const leadingColonPlan = /^\s{0,3}(?:#{1,6}\s*)?(?:(?:[-*]|\d+[.)])\s*)?phase\s+1\s*:/i.test(s);
  const headingText = explicitCounts.length
    ? ''
    : (planHeading
      ? s.slice(planHeading.index + planHeading[0].length)
      : (leadingColonPlan ? s : ''));
  const headingPattern = leadingColonPlan && !planHeading
    ? /(?:^|[.;,\n][ \t]*)\s{0,3}(?:#{1,6}\s*)?(?:(?:[-*]|\d+[.)])\s*)?phase\s+([1-9]\d*)\s*:/gim
    : /(?:^|[.;,][ \t]*)\s{0,3}(?:#{1,6}\s*)?(?:(?:[-*]|\d+[.)])\s*)?phase\s+([1-9]\d*)\b/gim;
  const headingNumbers = explicitCounts.length ? [] : [...new Set(
    [...headingText.matchAll(headingPattern)].map((m) => Number(m[1])),
  )].sort((a, b) => a - b);

  let scopedNumbers = headingNumbers;
  let source = headingNumbers.length >= 2
    ? (leadingColonPlan && !planHeading ? 'leading phase clauses' : 'execution-plan phase headings')
    : null;
  if (scopedNumbers.length < 2 && explicitCounts.length === 0) {
    // An execution-plan mention is not a delimiter for all later prose.
    // Accept an inline enumeration only when the heading is immediately
    // followed by phase clauses. Historical references elsewhere stay prose.
    for (const match of s.matchAll(/\b(?:the[ \t]+)?execution[ \t]+plan[ \t]*:[ \t]*([^\r\n]*)/ig)) {
      const clauses = match[1].split(/[.;,]/).map((part) => part.trim()).filter(Boolean);
      const labels = [];
      for (const clause of clauses) {
        if (!/^phase[ \t]+[1-9]\d*\b/i.test(clause)) break;
        labels.push(clause);
      }
      const numbers = uniqueSortedPhaseNumbers(labels.map((clause) => clause.match(/^phase[ \t]+[1-9]\d*\b/i)[0]).join('\n'));
      if (labels.length >= 2 && numbers.length >= 2) {
        scopedNumbers = numbers;
        source = 'inline phase clauses';
        break;
      }
    }
  }

  let inferredCount = null;
  if (scopedNumbers.length >= 2) {
    inferredCount = contiguousPhaseCount(scopedNumbers);
    if (inferredCount == null) {
      return {
        count: null,
        numbers: scopedNumbers,
        source,
        invalid: `declared phase numbers are not a contiguous 1..N sequence: ${scopedNumbers.join(', ')}`,
      };
    }
  }

  const distinctCounts = [...new Set([
    ...explicitCounts,
    ...(inferredCount == null ? [] : [inferredCount]),
  ])];
  if (distinctCounts.length > 1) {
    return {
      count: null,
      numbers: scopedNumbers,
      source: source ?? 'explicit phase count',
      invalid: `conflicting declared phase counts: ${distinctCounts.join(', ')}`,
    };
  }

  return {
    count: distinctCounts[0] ?? null,
    numbers: scopedNumbers,
    source: source ?? (explicitCounts.length ? 'explicit phase count' : null),
    invalid: null,
  };
}

export function clearlyDeclaresPhasePlan(text) {
  const declaration = declaredPhasePlan(text);
  return declaration.invalid != null || declaration.count != null;
}

export function referencesMissingPriorContract(text) {
  const s = String(text ?? '');
  return /\b(?:full|complete|original)\s+(?:spec|specification|contract|acceptance\s+criteria|task\s+requirements)\b[\s\S]{0,500}?\b(?:provided|given|stated|is|was)\b[\s\S]{0,160}?\b(?:in\s+)?(?:the\s+)?(?:earlier|previous|original\s+task\s+message|conversation)\b/i.test(s)
    || /\b(?:see|refer\s+to)\s+(?:the\s+)?(?:earlier|previous|original)\s+(?:spec|specification|contract|task\s+message)\b/i.test(s)
    || /\b(?:see|refer\s+to)\s+(?:the\s+)?(?:earlier|previous|original)\s+(?:message|conversation)\b[\s\S]{0,200}?\b(?:for|containing|with)\s+(?:the\s+)?(?:full|complete|original)?\s*(?:spec|specification|contract|acceptance\s+criteria|requirements)\b/i.test(s)
    || /\b(?:acceptance\s+criteria|success\s+criteria|task\s+requirements|requirements)\s+(?:are|were|is|was)\s+(?:in|from)\s+(?:the\s+)?(?:earlier|previous|original)\s+(?:message|conversation)\b/i.test(s);
}

export function assertContractHandoff({ goal, contractText, phases } = {}) {
  const frozen = normalizeContractText(contractText);
  if (referencesMissingPriorContract(goal) && !frozen) {
    throw new Error(
      'reviewloop_begin: task refers to a spec/contract in prior conversation but no self-contained contractText was supplied',
    );
  }
  if (referencesMissingPriorContract(frozen)) {
    throw new Error(
      'reviewloop_begin: contractText is not self-contained; replace references to earlier conversation with the actual frozen contract',
    );
  }
  // Parse goal and frozen contract independently. Joining them before parsing
  // can manufacture a fake phase sequence from one unrelated heading in each
  // source. Counts may corroborate across sources, but headings never cross the
  // source boundary.
  const declarations = [goal, frozen].filter(Boolean).map((text) => declaredPhasePlan(text));
  const invalidDeclaration = declarations.find((item) => item.invalid);
  if (invalidDeclaration) {
    throw new Error(
      `reviewloop_begin: phase plan declaration is inconsistent; ${invalidDeclaration.invalid}`,
    );
  }
  const declaredCounts = [...new Set(declarations.map((item) => item.count).filter((count) => count != null))];
  if (declaredCounts.length > 1) {
    throw new Error(
      `reviewloop_begin: phase plan declaration is inconsistent; conflicting declared phase counts: ${declaredCounts.join(', ')}`,
    );
  }
  const declaredCount = declaredCounts[0] ?? null;
  if (declaredCount != null) {
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error(
        'reviewloop_begin: task clearly declares a multi-phase execution plan but phases[] is empty; refusing to silently downgrade it to a single gate',
      );
    }
    if (phases.length !== declaredCount) {
      throw new Error(
        `reviewloop_begin: task declares ${declaredCount} phases but structured phases[] contains ${phases.length}; refusing to freeze a truncated or expanded phase plan`,
      );
    }

    const canonicalIds = phases.map((phase) => {
      const m = String(phase?.id ?? '').trim().match(/^phase[-_ ]?([1-9]\d*)$/i);
      return m ? Number(m[1]) : null;
    });
    const canonicalCount = canonicalIds.filter((n) => n != null).length;
    const rawPhaseIds = phases.map((phase) => String(phase?.id ?? '').trim());
    const reservedScopeIds = rawPhaseIds.filter((id) => id.toLowerCase() === 'final' || id.toLowerCase() === 'task');
    const mixedIds = canonicalCount > 0 && canonicalCount < canonicalIds.length;
    if (reservedScopeIds.length) {
      throw new Error(
        `reviewloop_begin: phase id "${reservedScopeIds[0]}" is reserved for ReviewLoop scope state`
        + (mixedIds ? '; the declared plan also mixes canonical phase-N ids with custom ids' : ''),
      );
    }
    if (mixedIds) {
      throw new Error(
        'reviewloop_begin: declared phase plan mixes canonical phase-N ids with custom ids; use either a complete canonical phase-1..phase-N sequence or consistently custom ids',
      );
    }
    if (canonicalCount === canonicalIds.length) {
      const expected = Array.from({ length: declaredCount }, (_, i) => i + 1);
      if (JSON.stringify(canonicalIds) !== JSON.stringify(expected)) {
        throw new Error(
          `reviewloop_begin: canonical structured phase ids must be phase-1..phase-${declaredCount} in order; got ${canonicalIds.join(', ')}`,
        );
      }
    }
  }
  return frozen;
}

export function normalizeEvidenceRequirements(raw = [], phaseIds = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('createReviewObjective: evidenceRequirements must be an array');
  if (raw.length > EVIDENCE_LIMITS.items || bytes(JSON.stringify(raw)) > EVIDENCE_LIMITS.requirementsBytes) {
    throw new Error(`createReviewObjective: evidenceRequirements exceed ${EVIDENCE_LIMITS.items} items or ${EVIDENCE_LIMITS.requirementsBytes} bytes; keep requirement metadata concise`);
  }
  const phases = new Set(phaseIds);
  const seen = new Set();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`createReviewObjective: evidence requirement ${index + 1} must be an object`);
    }
    const id = String(entry.id ?? '').trim();
    if (!id) throw new Error(`createReviewObjective: evidence requirement ${index + 1} requires an id`);
    if (bytes(id) > EVIDENCE_LIMITS.idBytes) {
      throw new Error(`createReviewObjective: evidence requirement ${index + 1} id exceeds ${EVIDENCE_LIMITS.idBytes} bytes`);
    }
    if (seen.has(id)) throw new Error(`createReviewObjective: duplicate evidence requirement id "${id}"`);
    seen.add(id);
    const description = String(entry.description ?? '').trim();
    if (!description) throw new Error(`createReviewObjective: evidence requirement "${id}" requires a description`);
    const type = String(entry.type ?? 'other').trim().toLowerCase();
    if (!EVIDENCE_TYPES.has(type)) {
      throw new Error(`createReviewObjective: evidence requirement "${id}" has unsupported type "${type}"`);
    }
    const gate = String(entry.gate ?? 'final').trim();
    if (gate !== 'final' && !phases.has(gate)) {
      throw new Error(
        `createReviewObjective: evidence requirement "${id}" targets unknown gate "${gate}"`,
      );
    }
    return {
      id,
      type,
      description,
      gate,
      required: entry.required !== false,
      covers: list(entry.covers),
    };
  });
}

export function normalizeEvidenceSubmissions(raw = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new EvidenceValidationError('evidence must be an array');
  if (raw.length > EVIDENCE_LIMITS.items) {
    throw new EvidenceValidationError(`evidence exceeds the ${EVIDENCE_LIMITS.items}-item limit`);
  }
  const seen = new Set();
  return raw.map((entry, index) => {
    const label = `evidence item ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EvidenceValidationError(`${label} must be an object`);
    }
    assertEvidenceText(entry.requirementId, `${label} requirementId`, EVIDENCE_LIMITS.idBytes);
    assertEvidenceText(entry.summary, `${label} summary`, EVIDENCE_LIMITS.summaryBytes);
    assertEvidenceText(entry.artifactRef, `${label} artifactRef`, EVIDENCE_LIMITS.artifactRefBytes, { optional: true });
    const requirementId = entry.requirementId.trim();
    if (seen.has(requirementId)) throw new EvidenceValidationError(`${label} duplicates a requirementId in this batch`);
    seen.add(requirementId);
    return {
      requirementId,
      summary: entry.summary.trim(),
      artifactRef: entry.artifactRef == null || !entry.artifactRef.trim() ? null : entry.artifactRef.trim(),
    };
  });
}

function gateMatches(requirement, reviewScope) {
  const id = reviewScope?.id ?? 'task';
  // final is the task-completion gate for both unphased (task) and phased
  // (final) loops. Phase-specific proof must name that exact phase id.
  if (requirement.gate === 'final') {
    return reviewScope?.type === 'final' || reviewScope?.type === 'task';
  }
  return requirement.gate === id;
}

function evidenceRequirementsForScope(objective, reviewScope) {
  return (objective?.evidenceRequirements ?? []).filter((r) => gateMatches(r, reviewScope));
}

export function requiredEvidenceForScope(objective, reviewScope) {
  return evidenceRequirementsForScope(objective, reviewScope)
    .filter((r) => r.required !== false);
}

// This validates intent, not code binding. Never persist proof at preflight:
// the exact reviewed code fingerprint is only known after snapshot/Gate checks.
export function validateEvidenceSubmissions({ objective, reviewScope, submissions = [] } = {}) {
  const normalized = normalizeEvidenceSubmissions(submissions);
  const requirements = new Map((objective?.evidenceRequirements ?? []).map((r) => [r.id, r]));
  for (const item of normalized) {
    const requirement = requirements.get(item.requirementId);
    if (!requirement) {
      throw new EvidenceValidationError(`evidence references unknown requirement "${item.requirementId}"`);
    }
    if (!gateMatches(requirement, reviewScope)) {
      throw new EvidenceValidationError(`evidence "${item.requirementId}" does not belong to the current gate`);
    }
  }
  const ids = new Set(normalized.map((item) => item.requirementId));
  evidencePromptLines({
    requirements: evidenceRequirementsForScope(objective, reviewScope)
      .filter((r) => r.required !== false || ids.has(r.id)),
    submissions: normalized,
  });
  return normalized;
}

// A requirement is frozen to one gate, so only its latest proof is useful.
// Use append order, not caller timestamps. Never resurrect an older proof when
// code reverts. Completed-phase hashes/audits remain separate and unchanged.
export function latestEvidenceRecords(records, objective) {
  const knownIds = new Set((objective?.evidenceRequirements ?? []).map((r) => r.id));
  const latest = new Map();
  for (const record of records ?? []) {
    if (knownIds.has(record?.requirementId)) latest.set(record.requirementId, record);
  }
  return [...latest.values()];
}

export function bindEvidenceSubmissions({
  loopState,
  objective,
  reviewScope,
  submissions = [],
  evidenceFingerprint,
  head = null,
  now = new Date().toISOString(),
} = {}) {
  const normalized = validateEvidenceSubmissions({ objective, reviewScope, submissions });
  if (!normalized.length) return;
  const requirements = new Map((objective?.evidenceRequirements ?? []).map((r) => [r.id, r]));
  // Stage the complete batch. No accepted prefix or over-budget replacement
  // may leak into durable state when any later item fails validation.
  let nextRecords = latestEvidenceRecords(loopState.evidenceRecords, objective);
  for (const item of normalized) {
    const requirement = requirements.get(item.requirementId);
    if (!requirement) {
      throw new EvidenceValidationError(`evidence references unknown requirement "${item.requirementId}"`);
    }
    if (!gateMatches(requirement, reviewScope)) {
      throw new EvidenceValidationError(
        `evidence "${item.requirementId}" does not belong to the current gate`,
      );
    }
    const record = {
      ...item,
      type: requirement.type,
      gate: reviewScope?.id ?? 'task',
      reviewScopeFingerprint: reviewScope?.fingerprint ?? '',
      evidenceFingerprint,
      head,
      recordedAt: now,
    };
    nextRecords = [
      ...nextRecords.filter((r) => r.requirementId !== item.requirementId),
      record,
    ];
  }
  reviewerEvidenceBundle({
    loopState: { evidenceRecords: nextRecords }, objective, reviewScope, evidenceFingerprint,
  });
  loopState.evidenceRecords = nextRecords;
}

export function evidenceStatusForScope({ loopState, objective, reviewScope, evidenceFingerprint } = {}) {
  const required = requiredEvidenceForScope(objective, reviewScope);
  const records = latestEvidenceRecords(loopState?.evidenceRecords, objective).filter((r) =>
    r.reviewScopeFingerprint === (reviewScope?.fingerprint ?? '')
      && r.evidenceFingerprint === evidenceFingerprint);
  const byId = new Map(records.map((r) => [r.requirementId, r]));
  return {
    required,
    records,
    missing: required.filter((r) => !byId.has(r.id)),
  };
}

export function reviewerEvidenceBundle({ loopState, objective, reviewScope, evidenceFingerprint } = {}) {
  const status = evidenceStatusForScope({ loopState, objective, reviewScope, evidenceFingerprint });
  const submittedIds = new Set(status.records.map((r) => r.requirementId));
  // Required obligations are always shown. Optional obligations are shown only
  // when the Worker actually submitted evidence for them, so the Reviewer gets
  // the description needed to judge that claim without prompt clutter.
  const requirements = evidenceRequirementsForScope(objective, reviewScope)
    .filter((r) => r.required !== false || submittedIds.has(r.id));
  const bundle = {
    requirements,
    submissions: status.records.map((r) => ({
      requirementId: r.requirementId,
      type: r.type,
      summary: r.summary,
      artifactRef: r.artifactRef,
      recordedAt: r.recordedAt,
    })),
  };
  // Re-check persisted evidence too; an upgraded/reloaded loop must not bypass
  // the new bounds merely because its oversized records were accepted earlier.
  evidencePromptLines(bundle);
  return bundle;
}

export function evidenceBundleFingerprint(bundle) {
  const requirements = [...(bundle?.requirements ?? [])]
    .map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      gate: r.gate,
      required: r.required !== false,
      covers: [...(r.covers ?? [])].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!requirements.length) return '';
  const submissions = [...(bundle?.submissions ?? [])]
    .map((e) => ({
      requirementId: e.requirementId,
      type: e.type,
      summary: e.summary,
      artifactRef: e.artifactRef ?? null,
    }))
    .sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return createHash('sha256')
    .update(JSON.stringify({ requirements, submissions }))
    .digest('hex');
}

export function buildResumePacket({ loopState, objective, completedScope, nextScope, head = null } = {}) {
  const completed = loopState?.completedPhases ?? [];
  const inherited = completed
    .map((entry) => (objective?.phases ?? []).find((p) => p.id === entry.id))
    .filter(Boolean)
    .flatMap((p) => p.carryForwardInvariants ?? []);
  const pendingPhaseIds = new Set((objective?.phases ?? [])
    .slice(completed.length).map((phase) => phase.id));
  const pendingEvidenceRequirements = (objective?.evidenceRequirements ?? [])
    .filter((requirement) => requirement.gate === 'final' || pendingPhaseIds.has(requirement.gate));
  return {
    schemaVersion: 2,
    loopId: loopState.loopId,
    objectiveFingerprint: objective?.fingerprint ?? null,
    // Task definitions are not evidence logs. Preserve their exact semantics,
    // including when contractText is absent and the structured plan is the
    // only source of the final whole-task acceptance criteria.
    goal: objective?.goal ?? '',
    contractText: objective?.contractText ?? null,
    phasePlan: objective?.phases ?? [],
    verificationPlan: objective?.verificationPlan ?? null,
    pendingEvidenceRequirements,
    repository: objective?.repository ?? null,
    head,
    completedPhases: completed.map((p) => ({ id: p.id, title: p.title, proof: p.proof })),
    completedGate: completedScope ? { id: completedScope.id, title: completedScope.title } : null,
    carryForwardInvariants: inherited,
    nextPhase: nextScope?.type === 'phase'
      ? {
        id: nextScope.id,
        title: nextScope.title,
        objective: nextScope.objective,
        exitCriteria: nextScope.exitCriteria ?? [],
        carryForwardInvariants: nextScope.carryForwardInvariants ?? [],
        verificationCommands: nextScope.verificationCommands ?? [],
        verificationEvidence: nextScope.verificationEvidence ?? [],
      }
      : null,
    finalGatePending: nextScope?.type === 'final',
    globalConstraints: objective?.constraints ?? [],
    // Keep the Worker handoff bounded. Full evidence remains durable in loop
    // state and available to ReviewLoop; raw summaries do not belong in the
    // context-refresh packet.
    evidenceRecordCount: (loopState?.evidenceRecords ?? []).length,
    evidenceSummary: (objective?.evidenceRequirements ?? []).map((requirement) => ({
      requirementId: requirement.id,
      gate: requirement.gate,
      recordCount: (loopState?.evidenceRecords ?? [])
        .filter((record) => record.requirementId === requirement.id).length,
    })),
  };
}
