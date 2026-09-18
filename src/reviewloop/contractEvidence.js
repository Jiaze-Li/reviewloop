import { createHash } from 'node:crypto';

// Frozen task-contract handoff, evidence obligations, and phase resume packets.
//
// This module is deliberately provider-agnostic. It turns user-facing task
// contracts into durable machine-checkable boundaries without trying to parse
// arbitrary prose beyond a narrow fail-closed guard for clearly-declared phase
// plans or references to missing prior conversation.

const EVIDENCE_TYPES = new Set(['runtime', 'artifact', 'manual', 'other']);

const list = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value]))
  .map((v) => String(v).trim())
  .filter(Boolean);

export function normalizeContractText(value) {
  return value == null ? '' : String(value).trim();
}

export function clearlyDeclaresPhasePlan(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (/\b(?:full\s+spec\s+has|including\s+the)\s+\d+[- ]phase\b/i.test(s)) return true;
  if (/\b\d+[- ]phase\s+(?:execution\s+)?plan\b/i.test(s)) return true;
  const ids = [...s.matchAll(/\bphase\s+([1-9]\d*)\b/ig)].map((m) => Number(m[1]));
  return new Set(ids).size >= 2;
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
  if (clearlyDeclaresPhasePlan(combined) && (!Array.isArray(phases) || phases.length === 0)) {
    throw new Error(
      'reviewloop_begin: task clearly declares a multi-phase execution plan but phases[] is empty; refusing to silently downgrade it to a single gate',
    );
  }
  return frozen;
}

export function normalizeEvidenceRequirements(raw = [], phaseIds = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('createReviewObjective: evidenceRequirements must be an array');
  const phases = new Set(phaseIds);
  const seen = new Set();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`createReviewObjective: evidence requirement ${index + 1} must be an object`);
    }
    const id = String(entry.id ?? '').trim();
    if (!id) throw new Error(`createReviewObjective: evidence requirement ${index + 1} requires an id`);
    if (seen.has(id)) throw new Error(`createReviewObjective: duplicate evidence requirement id "${id}"`);
    seen.add(id);
    const description = String(entry.description ?? '').trim();
    if (!description) throw new Error(`createReviewObjective: evidence requirement "${id}" requires a description`);
    const type = String(entry.type ?? 'other').trim().toLowerCase();
    if (!EVIDENCE_TYPES.has(type)) {
      throw new Error(`createReviewObjective: evidence requirement "${id}" has unsupported type "${type}"`);
    }
    const gate = String(entry.gate ?? 'final').trim();
    if (gate !== 'final' && gate !== 'task' && !phases.has(gate)) {
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
  if (!Array.isArray(raw)) throw new Error('reviewloop_review: evidence must be an array');
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`reviewloop_review: evidence item ${index + 1} must be an object`);
    }
    const requirementId = String(entry.requirementId ?? '').trim();
    const summary = String(entry.summary ?? '').trim();
    if (!requirementId) throw new Error(`reviewloop_review: evidence item ${index + 1} requires requirementId`);
    if (!summary) throw new Error(`reviewloop_review: evidence item "${requirementId}" requires a summary`);
    return {
      requirementId,
      summary,
      artifactRef: entry.artifactRef == null ? null : String(entry.artifactRef),
    };
  });
}

function gateMatches(requirement, reviewScope) {
  const id = reviewScope?.id ?? 'task';
  if (requirement.gate === 'final') return reviewScope?.type === 'final' || reviewScope?.type === 'task';
  if (requirement.gate === 'task') return reviewScope?.type === 'task';
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
  for (const item of normalized) {
    const requirement = requirements.get(item.requirementId);
    if (!requirement) {
      throw new Error(`reviewloop_review: evidence references unknown requirement "${item.requirementId}"`);
    }
    if (!gateMatches(requirement, reviewScope)) {
      throw new Error(
        `reviewloop_review: evidence "${item.requirementId}" does not belong to current gate "${reviewScope?.id ?? 'task'}"`,
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
    loopState.evidenceRecords = [
      ...(loopState.evidenceRecords ?? []).filter((r) =>
        !(r.requirementId === item.requirementId
          && r.reviewScopeFingerprint === record.reviewScopeFingerprint
          && r.evidenceFingerprint === evidenceFingerprint)),
      record,
    ];
  }
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
  return {
    requirements,
    submissions: status.records.map((r) => ({
      requirementId: r.requirementId,
      type: r.type,
      summary: r.summary,
      artifactRef: r.artifactRef,
      recordedAt: r.recordedAt,
    })),
  };
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
  return {
    schemaVersion: 1,
    loopId: loopState.loopId,
    objectiveFingerprint: objective?.fingerprint ?? null,
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
        verificationCommands: nextScope.verificationCommands ?? [],
        verificationEvidence: nextScope.verificationEvidence ?? [],
      }
      : null,
    finalGatePending: nextScope?.type === 'final',
    globalConstraints: objective?.constraints ?? [],
    evidenceRecords: (loopState?.evidenceRecords ?? []).map((r) => ({
      requirementId: r.requirementId,
      gate: r.gate,
      summary: r.summary,
      artifactRef: r.artifactRef,
      evidenceFingerprint: r.evidenceFingerprint,
    })),
  };
}
