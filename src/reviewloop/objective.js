// Immutable ReviewObjective.
//
// The original success definition for one ReviewLoop session. It is captured
// once by reviewloop_begin and can NEVER be weakened by the Worker, the
// Reviewer, the Supervisor, or a later REWORK round. Every review validates
// against this original objective — a small repair passing does not let
// ReviewLoop declare a larger original task complete.

import { createHash } from 'node:crypto';
import { normalizeContractText, normalizeEvidenceRequirements } from './contractEvidence.js';

export const REVIEW_MODES = Object.freeze({ LOCAL: 'LOCAL', PR: 'PR' });

export const DEFAULT_BLOCKING_SEVERITIES = Object.freeze(['P1', 'P2']);
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
// ReviewLoop has ONE review engine. Both LOCAL and PR targets are judged by the
// same internal Reviewer pool (`reviewer: 'internal'`). PR is a review TARGET
// (PR base -> exact PR HEAD), never a reviewer transport — no third-party
// review-trigger engine exists any more.

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// The stable identity of the begin-time baseline Gate evidence — the exact
// input to FAIL->WARN baseline-diff suppression at review time. `capturedAt` is
// volatile and excluded; the failure evidence is hashed rather than embedded so
// a large results payload never bloats the objective fingerprint. Returns null
// when no baseline Gate ran (PR mode, or no discoverable verification), which
// keeps a pre-existing objective's fingerprint unchanged.
export function baselineGateEvidenceIdentity(bg) {
  if (!bg || typeof bg !== 'object') return null;
  const hasEvidence = bg.evidence && typeof bg.evidence === 'object';
  const hasCoverage = typeof bg.coverage === 'string';
  if (!hasEvidence && !hasCoverage) return null;
  return {
    pass: bg.pass ?? null,
    source: bg.source ?? null,
    coverage: bg.coverage ?? null,
    evidenceHash: hasEvidence ? sha256(JSON.stringify(bg.evidence)) : null,
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

// Normalize an optional phase plan supplied by the Worker. The plan is frozen
// into the immutable ReviewObjective so a later review round cannot skip,
// reorder, weaken, or rewrite phase acceptance boundaries.
const RESERVED_PHASE_IDS = new Set(['task', 'final']);
export const PHASE_VERIFICATION_EVIDENCE_LIMITS = Object.freeze({
  items: 32,
  itemBytes: 4096,
  totalBytes: 16 * 1024,
});
export const PHASE_PLAN_MAX_BYTES = 32 * 1024;
export const RESUME_TASK_DEFINITION_MAX_BYTES = 96 * 1024;
const utf8Bytes = (value) => Buffer.byteLength(String(value), 'utf8');

export function assertResumeTaskDefinitionBound({
  goal = '', constraints = [], phases = [], contractText = '', verificationPlan = null, evidenceRequirements = [],
} = {}) {
  const payload = { goal: String(goal), constraints, phases, contractText, verificationPlan, evidenceRequirements };
  if (utf8Bytes(JSON.stringify(payload)) > RESUME_TASK_DEFINITION_MAX_BYTES) {
    throw new Error(
      `createReviewObjective: task definition copied into resume packets exceeds the ${RESUME_TASK_DEFINITION_MAX_BYTES}-byte UTF-8 limit; keep goal, constraints, phase metadata, verification commands, contract, and evidence requirements concise without truncating acceptance criteria`,
    );
  }
}

export function normalizePhasePlan(phases = []) {
  if (phases == null) return [];
  if (!Array.isArray(phases)) throw new Error('createReviewObjective: phases must be an array');

  const seen = new Set();
  const normalized = phases.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`createReviewObjective: phase ${index + 1} must be an object`);
    }
    const id = String(raw.id ?? `phase-${index + 1}`).trim();
    if (!id) throw new Error(`createReviewObjective: phase ${index + 1} has an empty id`);
    if (RESERVED_PHASE_IDS.has(id.toLowerCase())) {
      throw new Error(`createReviewObjective: phase id "${id}" is reserved for ReviewLoop scope state`);
    }
    if (seen.has(id)) throw new Error(`createReviewObjective: duplicate phase id "${id}"`);
    seen.add(id);

    const objective = String(raw.objective ?? '').trim();
    if (!objective) throw new Error(`createReviewObjective: phase "${id}" requires an objective`);

    const list = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value]))
      .map((v) => String(v).trim())
      .filter(Boolean);
    const exitCriteria = list(raw.exitCriteria);
    if (!exitCriteria.length) {
      throw new Error(`createReviewObjective: phase "${id}" requires at least one exit criterion`);
    }
    const verificationEvidence = list(raw.verificationEvidence);
    if (verificationEvidence.length > PHASE_VERIFICATION_EVIDENCE_LIMITS.items
      || verificationEvidence.some((item) => utf8Bytes(item) > PHASE_VERIFICATION_EVIDENCE_LIMITS.itemBytes)
      || utf8Bytes(verificationEvidence.join('\n')) > PHASE_VERIFICATION_EVIDENCE_LIMITS.totalBytes) {
      throw new Error(
        `createReviewObjective: phase "${id}" verificationEvidence exceeds `
        + `${PHASE_VERIFICATION_EVIDENCE_LIMITS.items} items, `
        + `${PHASE_VERIFICATION_EVIDENCE_LIMITS.itemBytes} bytes per item, or `
        + `${PHASE_VERIFICATION_EVIDENCE_LIMITS.totalBytes} bytes total; keep descriptive proof requirements concise`,
      );
    }

    return {
      id,
      title: String(raw.title ?? id).trim() || id,
      objective,
      exitCriteria,
      carryForwardInvariants: list(raw.carryForwardInvariants),
      // Only exact executable commands belong here. Descriptive verification
      // prose stays in the phase objective / exit criteria for the Reviewer.
      verificationCommands: list(raw.verificationCommands),
      // Descriptive/non-command evidence required to prove this phase. These
      // survive structured handoff even when they are not shell commands.
      verificationEvidence,
    };
  });
  if (utf8Bytes(JSON.stringify(normalized)) > PHASE_PLAN_MAX_BYTES) {
    throw new Error(
      `createReviewObjective: complete structured phase plan exceeds the ${PHASE_PLAN_MAX_BYTES}-byte UTF-8 limit; keep objectives, exit criteria, invariants, commands, and evidence descriptions concise without truncating acceptance criteria`,
    );
  }
  return normalized;
}

// Build the immutable objective record. `mode` is LOCAL unless a PR number is
// supplied. Every mode uses the internal Reviewer pool.
export function createReviewObjective({
  loopId,
  goal,
  repository,
  mode,
  prNumber = null,
  reviewer = null,
  baseline = null,
  prHead = null,
  // PR target identity, frozen at reviewloop_begin. `prBaseSha` is the PR's
  // merge-base with its target branch; `reviewedHeadSha` is the exact PR HEAD
  // bound at begin. Both are folded into the objective fingerprint so persisted
  // state cannot be edited to swap the review onto a different PR snapshot.
  prBaseSha = null,
  reviewedHeadSha = null,
  constraints = [],
  phases = [],
  contractText = '',
  evidenceRequirements = [],
  blockingSeverities = DEFAULT_BLOCKING_SEVERITIES,
  // In phase-aware mode this is the convergence budget PER review gate
  // (each phase gate and the final whole-task gate), not one budget shared
  // across the entire task.
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
  verificationPlan = null,
  baselineGateEvidence = null,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!loopId) throw new Error('createReviewObjective: loopId is required');
  if (!goal || !String(goal).trim()) throw new Error('createReviewObjective: goal is required');

  const resolvedMode = mode
    || (prNumber != null ? REVIEW_MODES.PR : REVIEW_MODES.LOCAL);
  if (!Object.values(REVIEW_MODES).includes(resolvedMode)) {
    throw new Error(`createReviewObjective: unknown mode "${resolvedMode}"`);
  }

  const normalizedConstraints = Array.isArray(constraints)
    ? constraints.map((c) => String(c)).filter(Boolean)
    : (constraints ? [String(constraints)] : []);

  const blocking = Array.isArray(blockingSeverities) && blockingSeverities.length
    ? [...new Set(blockingSeverities.map((s) => String(s).toUpperCase()))]
    : [...DEFAULT_BLOCKING_SEVERITIES];

  const rounds = Number.isInteger(maxReviewRounds) && maxReviewRounds > 0
    ? maxReviewRounds
    : DEFAULT_MAX_REVIEW_ROUNDS;
  const normalizedPhases = normalizePhasePlan(phases);
  const normalizedContractText = normalizeContractText(contractText);
  const normalizedEvidenceRequirements = normalizeEvidenceRequirements(
    evidenceRequirements,
    normalizedPhases.map((p) => p.id),
  );
  assertResumeTaskDefinitionBound({
    goal,
    constraints: normalizedConstraints,
    phases: normalizedPhases,
    contractText: normalizedContractText,
    verificationPlan,
    evidenceRequirements: normalizedEvidenceRequirements,
  });

  const objective = {
    loopId: String(loopId),
    goal: String(goal),
    repository: repository
      ? {
        root: repository.root ?? null,
        name: repository.name ?? null,
        url: repository.url ?? null,
      }
      : null,
    mode: resolvedMode,
    prNumber: resolvedMode === REVIEW_MODES.PR ? (prNumber ?? null) : null,
    // ONE review engine: the internal Reviewer pool judges every target.
    reviewer: 'internal',
    baseline: baseline ?? null,
    prBaseSha: resolvedMode === REVIEW_MODES.PR ? (prBaseSha ?? null) : null,
    // The exact PR HEAD this objective is bound to review (PR base -> this SHA).
    reviewedHeadSha: resolvedMode === REVIEW_MODES.PR
      ? (reviewedHeadSha ?? prHead ?? null)
      : null,
    constraints: normalizedConstraints,
    phases: normalizedPhases,
    // Optional complete user-facing task contract. When supplied it is the
    // self-contained source the independent Reviewer receives; it must never
    // be replaced by a reference to earlier chat history.
    contractText: normalizedContractText || null,
    // Non-command evidence obligations (runtime/artifact/manual) frozen with
    // the objective so a later round cannot silently waive them.
    evidenceRequirements: normalizedEvidenceRequirements,
    blockingSeverities: blocking,
    maxReviewRounds: rounds,
    // The deterministic Gate's verification plan, FROZEN at reviewloop_begin.
    // reviewloop_review always runs these exact commands; a later edit to
    // .reviewloop.json / package.json's test script cannot weaken the Gate.
    verificationPlan: verificationPlan
      ? {
        source: String(verificationPlan.source ?? 'unknown'),
        commands: Array.isArray(verificationPlan.commands) ? verificationPlan.commands.map(String) : [],
        manifestFingerprint: verificationPlan.manifestFingerprint ?? null,
        frozenAt: verificationPlan.frozenAt ?? createdAt,
      }
      : null,
    // The begin-time baseline Gate evidence identity. Folded into the
    // fingerprint so a state editor cannot rewrite loopState.baselineGateEvidence
    // to make a newly-introduced test failure compare as pre-existing (FAIL ->
    // WARN -> PASS). Only stored when a baseline Gate actually ran.
    baselineGateEvidence: baselineGateEvidenceIdentity(baselineGateEvidence),
    createdAt,
  };

  objective.fingerprint = fingerprintFields(objective);

  return freezeDeep(objective);
}

// The load-bearing fields, hashed for tamper-detection. `verificationPlan` is
// only folded in when present, so an objective created before this field
// existed keeps its original fingerprint and still rehydrates.
function fingerprintFields(o) {
  const base = {
    goal: o.goal,
    repository: o.repository ?? null,
    mode: o.mode,
    prNumber: o.prNumber ?? null,
    reviewer: o.reviewer,
    constraints: o.constraints ?? [],
    blockingSeverities: o.blockingSeverities ?? [],
    maxReviewRounds: o.maxReviewRounds,
  };
  // Backward compatibility: legacy objectives had no phase plan, so an empty
  // plan is intentionally omitted from the fingerprint.
  if (Array.isArray(o.phases) && o.phases.length) base.phases = o.phases;
  if (o.contractText) base.contractText = o.contractText;
  if (Array.isArray(o.evidenceRequirements) && o.evidenceRequirements.length) {
    base.evidenceRequirements = o.evidenceRequirements;
  }
  if (o.verificationPlan) base.verificationPlan = o.verificationPlan;
  // PR target identity — load-bearing for "which PR snapshot is under review".
  // Only folded in when present, so a LOCAL / pre-existing objective keeps its
  // original hash.
  if (o.prBaseSha) base.prBaseSha = o.prBaseSha;
  if (o.reviewedHeadSha) base.reviewedHeadSha = o.reviewedHeadSha;
  // The captured pre-Worker baseline is load-bearing: a state editor that swaps
  // it could hide or misattribute the Worker's delta. Fold its stable identity
  // (never the volatile capturedAt / dirtyFiles listing) into the fingerprint.
  // Only when present, so a pre-baseline objective keeps its original hash.
  if (o.baseline && typeof o.baseline === 'object') {
    base.baseline = {
      head: o.baseline.head ?? null,
      baselineRef: o.baseline.baselineRef ?? null,
      untrackedHashes: o.baseline.untrackedHashes ?? {},
      evidenceComplete: o.baseline.evidenceComplete !== false,
    };
  }
  // Baseline Gate evidence identity — load-bearing for FAIL->WARN suppression.
  // Only folded in when present, so a pre-baselineGate objective keeps its hash.
  if (o.baselineGateEvidence && typeof o.baselineGateEvidence === 'object') {
    base.baselineGateEvidence = o.baselineGateEvidence;
  }
  return sha256(JSON.stringify(base));
}

function computeObjectiveFingerprint(o) {
  return fingerprintFields(o);
}

// A serialized objective read back from durable state is re-frozen so nothing
// downstream can mutate it. Its stored fingerprint is re-verified: any tamper
// with a load-bearing field (goal, blocking severities, rounds, constraints,
// mode, prNumber, repository) is detected as corruption.
export function rehydrateObjective(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(raw));
  const expected = computeObjectiveFingerprint(copy);
  // Every objective produced by createReviewObjective carries a fingerprint. A
  // persisted objective with the field REMOVED must NOT be treated as valid —
  // that would let a state editor strip the fingerprint and then also drop P2
  // from blockingSeverities / weaken constraints / rounds undetected (the
  // second check in loadLoop compares the rehydrated copy against the same raw
  // object and so cannot catch it either). Require it, fail closed.
  if (!copy.fingerprint || copy.fingerprint !== expected) {
    throw new Error(
      copy.fingerprint
        ? 'ReviewObjective weakened: persisted objective fingerprint does not match its fields'
        : 'ReviewObjective invalid: persisted objective has no integrity fingerprint',
    );
  }
  return freezeDeep(copy);
}

// Deterministic check that a candidate objective did not weaken the original.
// A weakening is: fewer blocking severities, fewer review rounds, dropped
// constraints, or any change to goal / repository / mode / prNumber.
export function assertObjectiveNotWeakened(original, candidate) {
  if (!original) return true;
  if (!candidate) throw new Error('ReviewObjective missing on resume');
  const problems = [];
  if (candidate.goal !== original.goal) problems.push('goal changed');
  if (candidate.mode !== original.mode) problems.push('mode changed');
  if ((candidate.prNumber ?? null) !== (original.prNumber ?? null)) problems.push('prNumber changed');
  if ((candidate.prBaseSha ?? null) !== (original.prBaseSha ?? null)) problems.push('PR base SHA changed');
  if ((candidate.reviewedHeadSha ?? null) !== (original.reviewedHeadSha ?? null)) problems.push('reviewed PR HEAD changed');
  if (JSON.stringify(candidate.repository ?? null) !== JSON.stringify(original.repository ?? null)) {
    problems.push('repository changed');
  }
  const baselineIdentity = (b) => (b && typeof b === 'object'
    ? JSON.stringify({
      head: b.head ?? null,
      baselineRef: b.baselineRef ?? null,
      untrackedHashes: b.untrackedHashes ?? {},
      evidenceComplete: b.evidenceComplete !== false,
    })
    : 'null');
  if (baselineIdentity(candidate.baseline) !== baselineIdentity(original.baseline)) {
    problems.push('baseline changed');
  }
  if (JSON.stringify(candidate.baselineGateEvidence ?? null)
    !== JSON.stringify(original.baselineGateEvidence ?? null)) {
    problems.push('baseline Gate evidence identity changed');
  }
  const origBlocking = new Set(original.blockingSeverities ?? []);
  for (const sev of origBlocking) {
    if (!(candidate.blockingSeverities ?? []).includes(sev)) problems.push(`blocking severity ${sev} dropped`);
  }
  if ((candidate.maxReviewRounds ?? 0) < (original.maxReviewRounds ?? 0)) {
    problems.push('maxReviewRounds reduced');
  }
  const candConstraints = new Set(candidate.constraints ?? []);
  for (const c of original.constraints ?? []) {
    if (!candConstraints.has(c)) problems.push(`constraint dropped: ${c}`);
  }
  if (JSON.stringify(candidate.phases ?? []) !== JSON.stringify(original.phases ?? [])) {
    problems.push('phase plan changed');
  }
  if ((candidate.contractText ?? null) !== (original.contractText ?? null)) {
    problems.push('frozen contract text changed');
  }
  if (JSON.stringify(candidate.evidenceRequirements ?? []) !== JSON.stringify(original.evidenceRequirements ?? [])) {
    problems.push('evidence requirements changed');
  }
  if (original.verificationPlan) {
    if (!candidate.verificationPlan) {
      problems.push('verification plan dropped');
    } else if (JSON.stringify(candidate.verificationPlan) !== JSON.stringify(original.verificationPlan)) {
      problems.push('frozen verification plan changed');
    }
  }
  if (problems.length) {
    throw new Error(`ReviewObjective weakened: ${problems.join('; ')}`);
  }
  return true;
}
