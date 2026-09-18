import { createHash } from 'node:crypto';

// Frozen task-contract handoff, evidence obligations, and phase resume packets.
//
// This module is deliberately provider-agnostic. It turns user-facing task
// contracts into durable machine-checkable boundaries without trying to parse
// arbitrary prose beyond a narrow fail-closed guard for clearly-declared phase
// plans or references to missing prior conversation.

const EVIDENCE_TYPES = new Set(['runtime', 'artifact', 'manual', 'other']);

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
  if (optional && value == null) return;
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
  normalizeEvidenceSubmissions(evidence?.submissions);
  const lines = [
    evidence?.requirements?.length
      ? `EVIDENCE REQUIREMENTS / CONTEXT FOR THIS GATE:
${evidence.requirements.map((r) => `- ${r.id} [${r.type}; ${r.required === false ? 'optional' : 'required'}]: ${r.description}${r.covers?.length ? ` (covers ${r.covers.join(', ')})` : ''}`).join('\n')}`
      : '',
    evidence?.submissions?.length
      ? `SUBMITTED EVIDENCE:
${evidence.submissions.map((e) => `- ${e.requirementId}: ${e.summary}${e.artifactRef ? ` [${e.artifactRef}]` : ''}`).join('\n')}`
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
  return value == null ? '' : String(value).trim();
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
    ...[...s.matchAll(/\b(?:full\s+spec\s+has|including\s+the)\s+([2-9]\d*)\s*(?:-\s*)?phases?\b/ig)]
      .map((m) => Number(m[1])),
    ...[...s.matchAll(/\b([2-9]\d*)\s*(?:-\s*)?phases?\s+(?:execution\s+)?plan\b/ig)]
      .map((m) => Number(m[1])),
    ...[...s.matchAll(/\b(?:execution\s+)?plan\s+(?:has|with|contains)\s+([2-9]\d*)\s*(?:-\s*)?phases?\b/ig)]
      .map((m) => Number(m[1])),
  ];

  const headingNumbers = [...new Set(
    [...s.matchAll(/^\s{0,3}(?:#{1,6}\s*)?(?:[-*]\s*)?phase\s+([1-9]\d*)\b/gim)]
      .map((m) => Number(m[1])),
  )].sort((a, b) => a - b);

  let scopedNumbers = headingNumbers;
  let source = headingNumbers.length >= 2 ? 'phase headings' : null;
  if (scopedNumbers.length < 2) {
    const planIndex = s.search(/\bexecution\s+plan\b/i);
    if (planIndex >= 0) {
      scopedNumbers = uniqueSortedPhaseNumbers(s.slice(planIndex));
      if (scopedNumbers.length >= 2) source = 'execution plan';
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
  return /\b(?:full|complete|original)\s+(?:spec|specification|contract).*\b(?:provided|given|stated).*\b(?:earlier|previous|original task message|conversation)\b/i.test(s)
    || /\b(?:see|refer to)\s+(?:the\s+)?(?:earlier|previous|original)\s+(?:message|conversation|spec|contract)\b/i.test(s);
}

export function assertContractHandoff({ goal, contractText, phases } = {}) {
  const frozen = normalizeContractText(contractText);
  const combined = [goal, frozen].filter(Boolean).join('\n');
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
  const declaration = declaredPhasePlan(combined);
  if (declaration.invalid) {
    throw new Error(
      `reviewloop_begin: phase plan declaration is inconsistent; ${declaration.invalid}`,
    );
  }
  if (declaration.count != null) {
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error(
        'reviewloop_begin: task clearly declares a multi-phase execution plan but phases[] is empty; refusing to silently downgrade it to a single gate',
      );
    }
    if (phases.length !== declaration.count) {
      throw new Error(
        `reviewloop_begin: task declares ${declaration.count} phases but structured phases[] contains ${phases.length}; refusing to freeze a truncated or expanded phase plan`,
      );
    }

    const canonicalIds = phases.map((phase) => {
      const m = String(phase?.id ?? '').trim().match(/^phase[-_ ]?([1-9]\d*)$/i);
      return m ? Number(m[1]) : null;
    });
    if (canonicalIds.every((n) => n != null)) {
      const expected = Array.from({ length: declaration.count }, (_, i) => i + 1);
      if (JSON.stringify(canonicalIds) !== JSON.stringify(expected)) {
        throw new Error(
          `reviewloop_begin: canonical structured phase ids must be phase-1..phase-${declaration.count} in order; got ${canonicalIds.join(', ')}`,
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
      artifactRef: entry.artifactRef == null ? null : entry.artifactRef.trim(),
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

export function bindEvidenceSubmissions({
  loopState,
  objective,
  reviewScope,
  submissions = [],
  evidenceFingerprint,
  head = null,
  now = new Date().toISOString(),
} = {}) {
  const normalized = normalizeEvidenceSubmissions(submissions);
  if (!normalized.length) return;
  const requirements = new Map((objective?.evidenceRequirements ?? []).map((r) => [r.id, r]));
  // Stage the complete batch. No accepted prefix or over-budget replacement
  // may leak into durable state when any later item fails validation.
  let nextRecords = [...(loopState.evidenceRecords ?? [])];
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
      ...nextRecords.filter((r) =>
        !(r.requirementId === item.requirementId
          && r.reviewScopeFingerprint === record.reviewScopeFingerprint
          && r.evidenceFingerprint === evidenceFingerprint)),
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
  const records = (loopState?.evidenceRecords ?? []).filter((r) =>
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
