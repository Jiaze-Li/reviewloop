// ReviewLoop LOCAL controller. A single Worker-facing review engine verifies
// a frozen local baseline, runs the Gate, then Reviewer / Supervisor as needed.
// GitHub PR review is owned by claude-review-bot.

import { randomUUID } from 'node:crypto';
import { Persistence } from '../orchestrator/persistence.js';
import { isAuthorizationFailure } from '../orchestrator/errors.js';
import { REVIEWLOOP_RUNTIME_ROOT } from './runtimeDir.js';
import {
  createReviewObjective,
  normalizePhasePlan,
  assertResumeTaskDefinitionBound,
  rehydrateObjective,
  assertObjectiveNotWeakened,
  baselineGateEvidenceIdentity,
  REVIEW_MODES,
} from './objective.js';
import {
  REVIEW_LOOP_STATES,
  initialLoopState,
  recordTransition,
  ReviewLoopStore,
  assertNotLegacyWorkflow,
  isTerminal,
} from './state.js';
import { captureBaseline, collectWorkerDelta } from './gitEvidence.js';
import { withInProcessLoopLock, acquireLoopFileLease } from './loopLease.js';
import { discoverVerificationCommands, runGate, GATE_VERDICTS } from './gatePolicy.js';
import {
  normalizeReview,
  decideConvergence,
  compactReworkPayload,
  reviewFingerprint,
  REVIEW_VERDICTS,
} from './reviewPolicy.js';
import { createReviewLoopSpend, reconstructPhysicalCalls } from './reviewSpend.js';
import { reduceFinalDiff } from './finalDiffReducer.js';
import {
  DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS,
  normalizeTransientAuthRetryDelays,
  defaultRetrySleep,
  createMeteredWithFailover,
} from './providerFailover.js';
export { DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS };
import {
  sha256Hex,
  logicalEvidenceFingerprint,
  normalizeSupervisorStrategyText,
  migrateConvergenceState,
  phasesOf,
  currentReviewScope,
  scopeBoundFingerprint,
  phaseCompletionEvidenceHash,
  baselineFromPhaseEntry,
  phaseScopedBaseline,
  phaseCompletionRoot,
  assertPhaseProgressionValid,
  reviewGateCount,
  mergeScopedGateCommands,
} from './phaseState.js';
import { chunkDiffForReview, reviewDiffBudget } from './diffChunker.js';
import {
  assertContractHandoff,
  EvidenceValidationError,
  normalizeContractText,
  normalizeEvidenceRequirements,
  validateEvidenceSubmissions,
  latestEvidenceRecords,
  requiredEvidenceForScope,
  bindEvidenceSubmissions,
  evidenceStatusForScope,
  reviewerEvidenceBundle,
  evidenceBundleFingerprint,
  buildResumePacket,
} from './contractEvidence.js';

const RUNTIME_ROOT = REVIEWLOOP_RUNTIME_ROOT;

// Thrown when this process resumes a review after its cross-host lease was
// reclaimed by another owner. Caught in review() and converted to a read-only
// "wait and re-call" result — never surfaced as a failure that writes state.
class LeaseLostError extends Error {
  constructor(loopId) {
    super(`ReviewLoop lease for ${loopId} was reclaimed by another owner; this call must not dispatch or persist`);
    this.name = 'LeaseLostError';
    this.code = 'REVIEWLOOP_LEASE_LOST';
  }
}

function compactBaselineSummary(baseline) {
  return {
    head: baseline.head,
    dirtyFileCount: baseline.dirtyFiles?.length ?? 0,
    evidenceComplete: baseline.evidenceComplete !== false,
  };
}

function requireProvider(name) {
  return async () => {
    throw new Error(`ReviewLoop: no ${name} provider wired (real provider calls are not made in this context)`);
  };
}

export function createReviewLoopController({
  persistence: injectedPersistence = null,
  runtimeRoot = RUNTIME_ROOT,
  env = process.env,
  onEvent,
  recordSafetyEvent = null,
  reviewerFn = requireProvider('Reviewer'),
  supervisorFn = requireProvider('Supervisor'),
  // optional pool routing (production wiring). Return { family, provider,
  // model, transport } or null. When present, the controller binds the real
  // selected family into the CallIntent and drives bounded failover.
  routeReviewerFn = null,
  routeSupervisorFn = null,
  recordProviderFailure = null,
  // Optional zero-model-turn AGY quota preflight; never spends Reviewer tokens.
  preflightQuotaFn = null,
  transientAuthRetryDelaysMs = DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS,
  sleepFn = defaultRetrySleep,
  captureBaselineFn = captureBaseline,
  collectWorkerDeltaFn = collectWorkerDelta,
  // Re-collect the Worker delta AFTER the review-time Gate (a snapshot / codegen
  // / format check can mutate tracked files). Defaults to the real collector
  // only when the delta collector itself is the real one — an injected test
  // fake is a fixed script that cannot observe Gate mutation, so re-invoking it
  // there would only drift the harness. Pass explicitly to exercise this path.
  collectPostGateDeltaFn = null,
  runGateFn = runGate,
  discoverVerificationCommandsFn = discoverVerificationCommands,
  gateRunner = null,
  clock = () => Date.now(),
} = {}) {
  const persistence = injectedPersistence ?? new Persistence(runtimeRoot);
  const store = new ReviewLoopStore(persistence);
  // The cross-process lock file lives under the real runtime dir. Only a
  // filesystem-backed persistence has one; an in-memory test persistence does
  // not, and there the in-process lock chain is the whole guarantee.
  const fileLeaseRoot = typeof persistence?.workflowDir === 'function' ? runtimeRoot : null;
  const transientAuthRetryDelays = normalizeTransientAuthRetryDelays(transientAuthRetryDelaysMs);

  // Cross-host lease safety: while a reviewloop_review runs, its loopId maps to
  // a "do I still hold the lease?" probe. If a remote contender reclaims the
  // (apparently expired) lease mid-review, the displaced owner must fail closed
  // — no further paid model dispatch, no further durable ReviewLoop state
  // write. `assertLeaseHeld` is called at exactly those two boundaries; a lost
  // lease throws LeaseLostError, which review() turns into a strictly read-only
  // result (the new owner is the one entitled to reconcile state).
  const activeLeaseGuards = new Map(); // loopId -> async () => boolean (still held)
  async function assertLeaseHeld(loopId) {
    const probe = activeLeaseGuards.get(loopId);
    if (probe && !(await probe())) throw new LeaseLostError(loopId);
  }
  const meteredWithFailover = createMeteredWithFailover({
    transientAuthRetryDelays, sleepFn, recordProviderFailure, onEvent, preflightQuotaFn, assertLeaseHeld,
  });
  async function saveLoop(loopState) {
    await assertLeaseHeld(loopState.loopId);
    return store.save(loopState.loopId, loopState);
  }
  // Safety events are scoped to ONE reviewloop_review invocation. The array is
  // replaced (never appended-to across calls) at the top of review() so a
  // long-lived controller (one per MCP process, shared by every loopId) never
  // leaks one loop's safety events into another loop's result, and never grows
  // unbounded. Durable cumulative spend still comes from spend.telemetry(),
  // which reads the durable per-loop ledger.
  let safetyEvents = [];
  const collectSafetyEvent = (e) => {
    safetyEvents.push(e);
    recordSafetyEvent?.(e);
  };

  // Cumulative, durable per-loop spend telemetry with zero model calls — used
  // on every early-return path (NO_PROGRESS / WAITING_FOR_REVIEW /
  // terminal) so those results never understate spend that
  // earlier rounds already incurred.
  async function durableTelemetry(loopId) {
    try {
      return await spendFor(loopId).telemetry();
    } catch {
      return emptyTelemetry();
    }
  }

  function unacceptedEvidence(evidence, reason) {
    return {
      status: 'NOT_ACCEPTED',
      reason,
      submittedCount: Array.isArray(evidence) ? evidence.length : null,
      retryRequired: reason === 'CODE_CHANGED' || (Array.isArray(evidence) ? evidence.length > 0 : evidence != null),
    };
  }

  async function evidenceRework({ loopState, gate, head = null, reason, missing = [], receipt = null }) {
    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, reason);
    await saveLoop(loopState);
    return {
      ...compactReworkPayload({
        loopState,
        review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 },
        gate,
      }),
      head,
      reason,
      missingEvidenceRequirements: missing,
      ...(receipt ? { evidenceSubmission: receipt } : {}),
      nextAction: 'Correct or produce the evidence for this gate, then call reviewloop_review again in this same loop. Submit concise factual summaries and artifact references, not raw logs.',
      telemetry: await durableTelemetry(loopState.loopId),
      safetyEvents,
    };
  }

  async function enforceEvidenceObligations({
    loopState, objective, reviewScope, delta, gate, submissions = [], head = null,
  }) {
    const evidenceFingerprint = delta?.fingerprint ?? head ?? 'unknown';
    const rework = async (reason, missing = [], receipt = null) => ({
      blocked: true,
      result: await evidenceRework({ loopState, gate, head, reason, missing, receipt }),
    });
    try {
      // Binding validates the whole batch and prospective aggregate before
      // changing records. Invalid input cannot persist an accepted prefix.
      bindEvidenceSubmissions({
        loopState,
        objective,
        reviewScope,
        submissions,
        evidenceFingerprint,
        head,
        now: new Date(clock()).toISOString(),
      });
      // Includes persisted records: upgrading/reloading cannot bypass limits.
      const bundle = reviewerEvidenceBundle({
        loopState, objective, reviewScope, evidenceFingerprint,
      });
      const status = evidenceStatusForScope({
        loopState, objective, reviewScope, evidenceFingerprint,
      });
      if (status.missing.length) {
        const ids = status.missing.map((r) => r.id);
        return rework(`required evidence missing for ${reviewScope.id}: ${ids.join(', ')}`, status.missing);
      }
      return {
        blocked: false,
        bundle,
        proofFingerprint: evidenceBundleFingerprint(bundle),
      };
    } catch (err) {
      if (!(err instanceof EvidenceValidationError)) throw err;
      // Deterministic input rejection consumes no Reviewer/Supervisor round,
      // does not latch no-progress, and never echoes the rejected raw proof.
      return rework(err.message, [], unacceptedEvidence(submissions, 'INVALID_EVIDENCE'));
    }
  }

  async function begin({
    goal, cwd, prNumber = null, reviewer = null,
    verificationCommands = null, blockingSeverities, maxReviewRounds,
    constraints = [], phases = [], contractText = '', evidenceRequirements = [], signal = null,
  } = {}) {
    if (prNumber != null) throw new Error('reviewloop_begin: PR mode has been retired; use claude-review-bot for GitHub PR review.');
    if (!goal || !String(goal).trim()) throw new Error('reviewloop_begin: goal is required');
    if (!cwd) throw new Error('reviewloop_begin: cwd is required');
    const frozenContractText = assertContractHandoff({
      goal, contractText, constraints, phases, evidenceRequirements,
    });
    // Validate bounded structured phase metadata before baseline/Gate work.
    // createReviewObjective normalizes again when freezing the objective; this
    // early pass is deliberately side-effect free and prevents invalid
    // verificationEvidence from spending repository work first.
    const preflightPhases = normalizePhasePlan(phases);
    const preflightEvidenceRequirements = normalizeEvidenceRequirements(
      evidenceRequirements,
      preflightPhases.map((phase) => phase.id),
    );
    // Verification commands are also copied into resumePacket. The configured
    // commands are the only part known before repository discovery; validate
    // the full discovered plan again immediately after discovery below.
    assertResumeTaskDefinitionBound({
      goal,
      constraints,
      phases: preflightPhases,
      contractText: frozenContractText,
      verificationPlan: verificationCommands == null ? null : {
        source: 'configured-preflight',
        commands: Array.isArray(verificationCommands) ? verificationCommands.map(String) : [String(verificationCommands)],
      },
      evidenceRequirements: preflightEvidenceRequirements,
    });
    if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the baseline was captured');
    const loopId = `rl-${new Date(clock()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const mode = REVIEW_MODES.LOCAL;

    let baseline = null;
    const repository = { root: cwd, name: null, url: null };
    let baselineGate = null;
    let verificationPlan = null;

    // The frozen verification plan is discovered the same way for every
    // target, but from an explicit `discoverCwd` — LOCAL freezes from the
    // ambient cwd (there is no other snapshot); PR freezes from inside the
    // exact-HEAD disposable worktree so the ambient cwd's own branch/config
    // (which may differ from the PR entirely) can never leak into the frozen
    // PR Gate plan.
    const freezeVerificationPlan = (discoverCwd) => {
      const discovered = discoverVerificationCommandsFn({ cwd: discoverCwd, configured: verificationCommands });
      const plan = {
        source: String(discovered.source ?? 'unknown'),
        commands: (discovered.commands ?? []).map(String),
        manifestFingerprint: discovered.manifestFingerprint
          ?? sha256Hex(`fallback::${JSON.stringify(discovered.commands ?? [])}`),
        frozenAt: new Date(clock()).toISOString(),
      };
      assertResumeTaskDefinitionBound({
        goal,
        constraints,
        phases: preflightPhases,
        contractText: frozenContractText,
        verificationPlan: plan,
        evidenceRequirements: preflightEvidenceRequirements,
      });
      return plan;
    };

    baseline = await captureBaselineFn({ cwd });

    // Freeze the verification plan NOW. reviewloop_review always runs these
    // exact commands; a later edit to .reviewloop.json / package.json's test
    // script cannot weaken the Gate.
    verificationPlan = freezeVerificationPlan(cwd);

    // B8 — baseline Gate evidence, 0 model tokens, over the FROZEN plan. Only
    // when trusted/discoverable verification exists; a failure to run it is
    // recorded as incomplete coverage, never faked as PASS.
    if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the baseline Gate ran');
    let baselineGateRan = false;
    try {
      if (verificationPlan.source !== 'mechanical' && verificationPlan.commands.length) {
        const g = await runGateFn({
          cwd, commands: verificationPlan.commands, runner: gateRunner, env, signal,
        });
        baselineGateRan = true;
        baselineGate = {
          evidence: g.evidence ?? { results: g.results ?? [], pass: g.pass },
          pass: g.pass,
          capturedAt: new Date().toISOString(),
          source: verificationPlan.source,
        };
      }
    } catch (err) {
      // A caller cancellation is NOT "incomplete Gate coverage" — it aborts
      // reviewloop_begin so no loop is registered for an abandoned request.
      if (signal?.aborted) {
        throw new Error(`reviewloop_begin: cancelled by the caller during the baseline Gate (${String(err?.message ?? err)})`);
      }
      baselineGate = { coverage: 'INCOMPLETE', reason: String(err?.message ?? err) };
    }
    if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller after the baseline Gate ran');
    // The baseline Gate may itself mutate tracked files (a snapshot test, a
    // codegen/format check). Re-capture the baseline AFTER it runs so those
    // Gate-caused edits are part of the baseline and are never later
    // attributed to the Worker's delta. If this recapture FAILS we must NOT
    // fall back to the pre-Gate baseline — that reintroduces the exact
    // misattribution the recapture prevents. Abort reviewloop_begin instead.
    if (baselineGateRan) {
      try {
        baseline = await captureBaselineFn({ cwd });
      } catch (err) {
        throw new Error(
          `reviewloop_begin: the baseline Gate ran but the post-Gate baseline could not be re-captured (${err?.message ?? err}); `
          + 'refusing to start a loop whose baseline would misattribute the Gate\'s own edits to the Worker',
        );
      }
    }

    // REVIEWLOOP_MAX_REVIEW_ROUNDS is a public tuning knob: an explicit begin
    // argument wins, otherwise the env value feeds the frozen objective (which
    // is the value decideConvergence() actually enforces), otherwise the
    // objective default. Never left resolved-but-ignored.
    const envMaxRounds = Number(env?.REVIEWLOOP_MAX_REVIEW_ROUNDS);
    const resolvedMaxRounds = Number.isInteger(maxReviewRounds) && maxReviewRounds > 0
      ? maxReviewRounds
      : (Number.isInteger(envMaxRounds) && envMaxRounds > 0 ? envMaxRounds : undefined);

    const objective = createReviewObjective({
      loopId, goal, repository, mode, reviewer, baseline,
      constraints, phases, contractText: frozenContractText, evidenceRequirements,
      blockingSeverities, maxReviewRounds: resolvedMaxRounds,
      verificationPlan,
      baselineGateEvidence: baselineGate,
    });

    // Zero-model plan check. Advisory only: a docs-only task legitimately has
    // nothing to run, but a phase that only a model can judge is costly and weak.
    const planWarnings = [];
    if (!(verificationPlan?.commands?.length)) {
      for (const phase of preflightPhases) {
        if (!phase.verificationCommands?.length && !phase.verificationEvidence?.length) {
          planWarnings.push(`phase ${phase.id} has no verification commands or evidence and no global verification commands are frozen; only the Reviewer can judge it`);
        }
      }
    }
    // Phases registered without the user's contract: the Reviewer would judge
    // from the goal and phase bullets only, never seeing the acceptance criteria,
    // allowed/forbidden changes or evidence rules that live in the contract.
    if (preflightPhases.length && !frozenContractText) {
      planWarnings.push(
        'phases were registered without contractText: the Reviewer will not see the full acceptance criteria and constraints. '
        + 'Pass the user\'s contract verbatim as contractText and call reviewloop_begin again BEFORE editing.',
      );
    }
    // LOCAL attribution check, while it is still free to fix: files untracked at
    // begin make every brand-new Worker file unattributable (D25), so the first
    // review would stop at HUMAN_REQUIRED and the loop could not be recovered.
    if (baseline) {
      const untracked = Object.keys(baseline.untrackedHashes ?? {});
      if (untracked.length) {
        const shown = untracked.slice(0, 5).join(', ');
        planWarnings.push(
          `${untracked.length} untracked file(s) at begin (${shown}${untracked.length > 5 ? ', …' : ''}): `
          + 'any new file you create will make review stop at HUMAN_REQUIRED. '
          + 'Commit, delete or .gitignore them (or git stash -u), then call reviewloop_begin again BEFORE editing.',
        );
      }
      if (baseline.evidenceComplete === false) {
        planWarnings.push(
          `baseline attribution is already incomplete (${(baseline.incompleteReasons ?? []).slice(0, 2).join('; ')}); `
          + 'fix the working tree and call reviewloop_begin again BEFORE editing.',
        );
      }
    }
    if (preflightPhases.length > 8) {
      planWarnings.push(`${preflightPhases.length} phases: every phase costs at least one Reviewer call; consider fewer, larger phases`);
    }

    const loopState = initialLoopState(objective);
    loopState.verificationCommands = verificationCommands ?? null;
    loopState.baselineGateEvidence = baselineGate;
    await store.save(loopId, loopState);
    onEvent?.({ type: 'REVIEWLOOP_BEGIN', loopId, mode });

    return {
      loopId,
      mode,
      status: 'READY',
      baseline: baseline ? compactBaselineSummary(baseline) : null,
      reviewer: objective.reviewer,
      phaseCount: phasesOf(objective).length,
      currentPhase: currentReviewScope(loopState, objective).id,
      objectiveFingerprint: objective.fingerprint,
      ...(planWarnings.length ? { planWarnings } : {}),
    };
  }

  async function loadLoop(loopId) {
    const raw = await store.load(loopId);
    if (!raw) throw new Error(`reviewloop_review: unknown loopId ${loopId}`);
    assertNotLegacyWorkflow(raw);
    // Old PR sessions are archived in-place, never repurposed as LOCAL.
    if (raw.objective?.mode === 'PR') throw new Error('ReviewLoop PR session retired; use claude-review-bot. Existing session left unchanged.');
    const objective = rehydrateObjective(raw.objective);
    assertObjectiveNotWeakened(objective, raw.objective);
    raw.objective = objective;
    assertPhaseProgressionValid(raw, objective);
    migrateConvergenceState(raw);
    return raw;
  }

  function spendFor(loopId, objective = null) {
    return createReviewLoopSpend({
      loopId,
      persistence,
      env,
      gateCount: reviewGateCount(objective),
      onEvent,
      recordSafetyEvent: collectSafetyEvent,
    });
  }

  function completeCurrentPhase(
    loopState,
    review,
    telemetry,
    {
      head = null, gate = null, reviewScope = null, auditRecord = null, evidenceFingerprint = null,
      phaseBaseline = null, reviewedFiles = null,
    } = {},
  ) {
    const scope = reviewScope ?? currentReviewScope(loopState);
    if (scope.type !== 'phase') return null;

    const previous = (loopState.completedPhases ?? []).slice(-1)[0];
    const completion = {
      id: scope.id,
      title: scope.title,
      phaseIndex: scope.phaseIndex,
      completedAt: new Date(clock()).toISOString(),
      round: loopState.round,
      head,
      reviewScopeFingerprint: scope.fingerprint,
      gateFingerprint: gate?.fingerprint ?? loopState.lastGateFingerprint ?? null,
      reviewFingerprint: review?.reviewedFingerprint ?? loopState.lastReviewedFingerprint ?? null,
      previousProof: previous?.proof ?? phaseCompletionRoot(loopState.objective),
      auditTargetFingerprint: auditRecord?.targetFingerprint ?? null,
      ...(phaseBaseline ? { phaseBaseline: { head: phaseBaseline.head, baselineRef: phaseBaseline.baselineRef } } : {}),
      ...(Array.isArray(reviewedFiles) ? { reviewedFiles } : {}),
    };
    completion.proof = phaseCompletionEvidenceHash(completion);

    loopState.completedPhases = [
      ...(loopState.completedPhases ?? []),
      completion,
    ];
    loopState.currentPhaseIndex = scope.phaseIndex + 1;

    // Reset only gate-local convergence/no-progress state. Task-wide audit,
    // provider spend, token sentinel, baseline and objective stay intact.
    loopState.gateRound = 0;
    loopState.gateRepairCount = 0;
    loopState.convergenceEpoch = 0;
    loopState.epochReviewRound = 0;
    loopState.supervisorEscalationCount = 0;
    loopState.findingSignatureHistory = [];
    loopState.supervisorInvoked = false;
    loopState.pendingReviewerReconsideration = null;
    loopState.lastSupervisorGuidance = null;
    loopState.lastSupervisorRecommendation = null;
    loopState.lastReviewedFingerprint = null;
    loopState.lastGateFingerprint = null;
    loopState.lastReview = null;
    loopState.chunkReviewCheckpoint = null;

    const nextScope = currentReviewScope(loopState);
    loopState.resumePacket = buildResumePacket({
      loopState,
      objective: loopState.objective,
      completedScope: scope,
      nextScope,
      head,
      evidenceFingerprint,
    });
    recordTransition(
      loopState,
      REVIEW_LOOP_STATES.READY_FOR_WORK,
      `phase ${scope.id} passed; continue to ${nextScope.type === 'final' ? 'final whole-task gate' : `phase ${nextScope.id}`}`,
    );

    return {
      status: 'PHASE_PASS',
      loopId: loopState.loopId,
      round: loopState.round,
      gateRound: 0,
      completedPhase: { id: scope.id, title: scope.title, index: scope.phaseIndex },
      nextPhase: nextScope.type === 'phase'
        ? { id: nextScope.id, title: nextScope.title, index: nextScope.phaseIndex }
        : null,
      finalGatePending: nextScope.type === 'final',
      // 'phase-delta': the next phase gate reviews only changes made after this
      // PHASE_PASS. 'cumulative': it reviews everything since reviewloop_begin.
      nextDiffScope: nextScope.type === 'phase' && phaseBaseline ? 'phase-delta' : 'cumulative',
      resumePacket: loopState.resumePacket,
      contextRefreshSafe: true,
      reviewer: review?.reviewer ?? null,
      nonBlockingFindings: review?.nonBlockingFindings ?? [],
      nonBlockingOmitted: review?.nonBlockingOmitted ?? 0,
      nextAction: nextScope.type === 'final'
        ? 'All implementation phases passed. Do not report task completion yet; call reviewloop_review again for the final whole-task gate.'
        : `Continue with ${nextScope.id}${nextScope.title ? ` (${nextScope.title}` + ')' : ''}; when that phase is ready, call reviewloop_review again. Do not start a new ReviewLoop.`,
      telemetry: telemetry ?? emptyTelemetry(),
      safetyEvents,
    };
  }

  async function review({ loopId, evidence = [], signal, onHeartbeat } = {}) {
    if (!loopId) throw new Error('reviewloop_review: loopId is required');
    // Serialize every reviewloop_review for this loopId. In-process: overlapping
    // calls run one after another (the second then hits the deterministic
    // NO_PROGRESS guard — one dispatch, no lost update). Cross-process: a live
    // foreign holder makes this call return BUSY without touching any state.
    return withInProcessLoopLock(loopId, async () => {
      const lease = await acquireLoopFileLease({ runtimeRoot: fileLeaseRoot, loopId });
      if (!lease.ok) {
        // Another reviewloop_review is already running for this loop (another
        // process). Report the in-contract "call again later" state — never run
        // a concurrent Reviewer or clobber the in-flight call's durable state.
        safetyEvents = [];
        // BUSY is a strictly READ-ONLY outcome: another process owns this loop
        // and is the one entitled to reconcile/settle its reservations. This
        // path must not call durableTelemetry() (it runs reconcileOnResume and
        // can rewrite RESERVED/DISPATCHING reservations under the live owner) —
        // it touches no durable state at all. The owning call reports accurate
        // telemetry when it finishes.
        return {
          status: 'WAITING_FOR_REVIEW',
          loopId,
          reason: 'another reviewloop_review is already running for this loop'
            + (lease.heldBy?.pid ? ` (holder pid ${lease.heldBy.pid} on ${lease.heldBy.host ?? '?'})` : '')
            + '; wait for it to finish, then call reviewloop_review again',
          nextAction: 'Wait for the in-flight review of this loop to finish, then call reviewloop_review again.',
          telemetry: { ...emptyTelemetry(), note: 'another process owns this loop; telemetry not read to keep this path side-effect-free' },
          safetyEvents: [],
        };
      }
      activeLeaseGuards.set(loopId, lease.verifyHeld ?? (async () => true));
      try {
        return await reviewInner({ loopId, evidence, signal });
      } catch (err) {
        if (err instanceof LeaseLostError) {
          // The lease was reclaimed by another owner while this call ran. We
          // stopped before any further paid dispatch or durable write. Return a
          // strictly read-only result — the new owner reconciles state.
          safetyEvents = [];
          return {
            status: 'WAITING_FOR_REVIEW',
            loopId,
            reason: `${err.message}; wait for the current owner to finish, then call reviewloop_review again`,
            nextAction: 'Wait for the in-flight review of this loop to finish, then call reviewloop_review again.',
            telemetry: { ...emptyTelemetry(), note: 'lease lost to another owner mid-review; state left for the new owner' },
            safetyEvents: [],
          };
        }
        throw err;
      } finally {
        activeLeaseGuards.delete(loopId);
        await lease.release();
      }
    });
  }

  async function reviewInner({ loopId, evidence, signal }) {
    // Per-invocation safety-event isolation: start this call with a clean list.
    safetyEvents = [];
    const loopState = await loadLoop(loopId);
    const objective = loopState.objective;

    // Each review gate owns bounded convergence epochs. Epoch 0 uses the
    // frozen maxReviewRounds budget; valid Supervisor strategy may open bounded
    // follow-up epochs without resetting task-wide round/spend/audit. Only the
    // full automatic convergence strategy (or explicit Supervisor adjudication)
    // can make HUMAN_REQUIRED terminal.
    if (isTerminal(loopState.state)
      && (loopState.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED || loopState.budgetExhausted)) {
      return terminalResult(loopState);
    }

    try {
      // Upgrade-safe task-definition preflight. New begins enforce these bounds
      // before repository work, but an in-flight objective frozen by an older
      // ReviewLoop may legitimately carry a prior-version fingerprint and
      // oversized metadata. Never let PHASE_PASS turn that legacy state into an
      // unbounded contextRefreshSafe resume packet.
      const boundedPhases = normalizePhasePlan(objective.phases ?? []);
      const boundedEvidenceRequirements = normalizeEvidenceRequirements(
        objective.evidenceRequirements ?? [],
        boundedPhases.map((phase) => phase.id),
      );
      const boundedContractText = normalizeContractText(objective.contractText);
      assertResumeTaskDefinitionBound({
        goal: objective.goal,
        constraints: objective.constraints ?? [],
        phases: boundedPhases,
        contractText: boundedContractText,
        verificationPlan: objective.verificationPlan ?? null,
        evidenceRequirements: boundedEvidenceRequirements,
      });
    } catch (err) {
      // Preflight is a review operation even when it does not run the Gate.
      // Preserve the frozen objective verbatim; fail closed instead of
      // truncating or rewriting a fingerprint-valid legacy task definition.
      recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'frozen task-definition preflight');
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, err?.message ?? String(err));
      await saveLoop(loopState);
      return humanRequiredResult(loopState, null, await durableTelemetry(loopId));
    }
    // Migrate old multi-version histories without changing any proof binding,
    // completed phase, objective or task-wide spend counter.
    loopState.evidenceRecords = latestEvidenceRecords(loopState.evidenceRecords, objective);

    return reviewLocal({ loopState, evidence, signal });
  }

  // ---- Reviewer over full attributed evidence (bounded or chunked) --------
  async function runReviewerOverEvidence({
    spend, loopState, objective, delta, gate, reviewScope = currentReviewScope(loopState, objective),
    evidenceBundle = null, evidenceProofFingerprint = '', signal,
  }) {
    // Every PHYSICAL Reviewer attempt for this call — one entry per failover
    // retry AND per chunk, success or failure. Never collapsed into a single
    // abstract "internal" — the durable PR audit (appendAuditRecord) needs to
    // answer "which physical model reviewed this SHA", including every
    // attempt a failover/chunking round made along the way.
    const physicalCalls = [];
    // Crash/resume durability: reconcile the in-memory `physicalCalls` built
    // by THIS process against the durable spend log for the round actually
    // being reviewed. The durable log is a strict superset whenever it has
    // anything at all — every physical attempt (this process's or an earlier,
    // crashed one's) settles its accounting record durably BEFORE meteredCall
    // returns (reviewSpend.js), tagged with the same round/chunkIndex/attempt
    // identity. A chunk served from `loopState.chunkReviewCheckpoint` (a
    // prior, possibly crashed, process reviewed it) has NOTHING in this
    // process's `physicalCalls` array, so without this reconciliation its
    // physical attempts would silently vanish from the durable audit record.
    // Falls back to the in-memory list on a durable-read failure or an empty
    // result (e.g. a persistence-less unit test) — never throws the review
    // closed over an audit-trail nicety.
    const withDurablePhysicalCalls = async (inMemory) => {
      try {
        const durable = await reconstructPhysicalCalls({
          persistence, loopId: loopState.loopId, role: 'reviewer', round: loopState.round,
        });
        return durable.length ? durable : inMemory;
      } catch { return inMemory; }
    };
    // Global round + gateRound are bound to the LOGICAL review state
    // (delta + gate fingerprint + review-scope fingerprint),
    // NOT to how many times reviewloop_review was invoked. A crash/resume that
    // re-enters with the SAME logical review state — its durable per-chunk
    // checkpoint is still on record — reuses the round it already assigned and
    // never consumes another of the objective's max review rounds.
    const { chunks, oversized, reason } = chunkDiffForReview(delta.diff, { env });
    if (oversized) {
      return {
        review: {
          status: 'FAILED', reviewer: 'internal', provider: 'internal',
          blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
          findingSignatures: [], error: { reason: 'REVIEW_TOO_LARGE', message: reason }, physicalCalls,
        },
        chunkCount: chunks.length,
      };
    }

    // The per-chunk checkpoint identity MUST cover the actual chunk layout, not
    // just the (delta + gate) fingerprints. `chunkDiffForReview` depends on
    // REVIEWLOOP_MAX_REVIEW_DIFF_CHARS; a crash/resume under a larger value
    // re-chunks the same diff into different boundaries. Without the layout in
    // that key, the stored result for old chunk 0 would be reused for the new,
    // larger chunk 0 and its added portion never reviewed — yet aggregation
    // could still return CLEAN/PASS. Any layout change now yields a new
    // checkpoint key and a full re-review of every chunk.
    //
    // The ROUND, however, is bound to the LOGICAL review state alone — the
    // (delta + gate) fingerprint pair — never to the chunk layout on top of
    // it. A crash/resume under a different REVIEWLOOP_MAX_REVIEW_DIFF_CHARS
    // re-chunks the SAME (delta + gate) state; that must invalidate the
    // per-chunk results (a layout change) but must NOT consume another of the
    // objective's max review rounds — the Reviewer has not been asked to
    // reconsider new evidence, only re-chunked old evidence. `deltaGateKey` is
    // tracked separately from the layout-inclusive `checkpointKey` so round
    // reuse survives a re-chunk.
    const reviewStateParts = evidenceProofFingerprint
      ? [delta.fingerprint, gate.fingerprint, evidenceProofFingerprint]
      : [delta.fingerprint, gate.fingerprint];
    const deltaGateKey = scopeBoundFingerprint(reviewStateParts, reviewScope);
    const chunkLayoutHash = sha256Hex(`${chunks.length}::${chunks.map((c) => c.hash).join('::')}`);
    const checkpointKey = sha256Hex(`${deltaGateKey}::${chunkLayoutHash}`);
    const resumeCheckpoint = loopState.chunkReviewCheckpoint;
    if (resumeCheckpoint && resumeCheckpoint.deltaGateKey === deltaGateKey
      && Number.isInteger(resumeCheckpoint.round)) {
      loopState.round = resumeCheckpoint.round;
      // Backward compatibility: persisted loops/checkpoints from before
      // gate-local/epoch convergence existed fall back to their paid round
      // counters instead of silently resetting allowance.
      loopState.gateRound = Number.isInteger(resumeCheckpoint.gateRound)
        ? resumeCheckpoint.gateRound
        : (Number.isInteger(loopState.gateRound)
          ? loopState.gateRound
          : resumeCheckpoint.round);
      loopState.convergenceEpoch = Number.isInteger(resumeCheckpoint.convergenceEpoch)
        ? resumeCheckpoint.convergenceEpoch
        : (Number.isInteger(loopState.convergenceEpoch) ? loopState.convergenceEpoch : 0);
      loopState.epochReviewRound = Number.isInteger(resumeCheckpoint.epochReviewRound)
        ? resumeCheckpoint.epochReviewRound
        : (Number.isInteger(loopState.epochReviewRound)
          ? loopState.epochReviewRound
          : loopState.gateRound);
    } else {
      const priorGateRound = Number.isInteger(loopState.gateRound)
        ? loopState.gateRound
        : loopState.round;
      const priorEpochRound = Number.isInteger(loopState.epochReviewRound)
        ? loopState.epochReviewRound
        : priorGateRound;
      if (!Number.isInteger(loopState.convergenceEpoch)) loopState.convergenceEpoch = 0;
      loopState.round += 1;
      loopState.gateRound = priorGateRound + 1;
      loopState.epochReviewRound = priorEpochRound + 1;
    }

    // Durable per-chunk checkpoint. Keyed to the exact review state INCLUDING
    // chunk layout (`checkpointKey`); a changed diff OR a changed chunk layout
    // invalidates the stored per-chunk results, so a re-chunked round always
    // re-sends every chunk to the model under the new boundaries — but
    // `deltaGateKey` alone (above) governs round assignment, so that re-chunk
    // reuses this logical state's already-assigned round instead of consuming
    // a fresh one.
    let checkpoint = loopState.chunkReviewCheckpoint;
    if (!checkpoint || checkpoint.key !== checkpointKey || checkpoint.chunkTotal !== chunks.length) {
      checkpoint = {
        key: checkpointKey,
        deltaGateKey,
        chunkTotal: chunks.length,
        chunks: {},
        round: loopState.round,
        gateRound: loopState.gateRound,
        convergenceEpoch: loopState.convergenceEpoch ?? 0,
        epochReviewRound: loopState.epochReviewRound ?? loopState.gateRound,
        reviewScopeFingerprint: reviewScope.fingerprint,
      };
      loopState.chunkReviewCheckpoint = checkpoint;
    } else if (!Number.isInteger(checkpoint.round)) {
      checkpoint.round = loopState.round;
    }

    const perChunk = [];
    for (const chunk of chunks) {
      if (signal?.aborted) {
        // The MCP client cancelled the review. Do NOT start another paid model
        // dispatch — fail the review closed (never CLEAN/PASS on a cancel).
        return {
          review: {
            status: 'FAILED', reviewer: 'internal', provider: 'internal',
            blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
            findingSignatures: [], error: { reason: 'REVIEW_CANCELLED', message: 'the review was cancelled by the caller' },
            physicalCalls: await withDurablePhysicalCalls(physicalCalls),
          },
          chunkCount: chunks.length,
        };
      }
      const done = checkpoint.chunks[chunk.index];
      if (done) {
        // Resume: this chunk was already reviewed in a prior (crashed) attempt.
        if (done.status === 'FAILED') {
          return {
            review: { ...done, physicalCalls: await withDurablePhysicalCalls(physicalCalls) },
            chunkCount: chunks.length,
            failedChunk: chunk.index,
          };
        }
        perChunk.push(done);
        continue;
      }
      const chunkId = `${loopState.loopId}:round-${loopState.round}:chunk-${chunk.index}`;
      // ONE composite logical review-state evidence per chunk: the diff chunk
      // AND the gate fingerprint together. A single logical (diff + gate) state
      // authorizes exactly ONE physical Reviewer dispatch SEQUENCE — bounded
      // failover retries of that same operation reuse this one claim, and it is
      // never re-earned by a re-call on identical evidence (crash/resume
      // included). Multiple evidenceIds no longer multiply dispatch eligibility.
      // eslint-disable-next-line no-await-in-loop
      const reviewStateEvidence = await spend.registerEvidence({
        kind: 'reviewstate',
        taskId: chunkId,
        diffHash: scopeBoundFingerprint(
          evidenceProofFingerprint
            ? [chunk.hash, gate.fingerprint, evidenceProofFingerprint]
            : [chunk.hash, gate.fingerprint],
          reviewScope,
        ),
      });
      // eslint-disable-next-line no-await-in-loop
      const raw = await meteredWithFailover({
        spend,
        role: 'reviewer',
        routeFn: routeReviewerFn,
        defaultFamily: 'agy:gpt-oss',
        defaultProvider: 'agy',
        operationId: chunkId,
        workflowId: loopState.loopId,
        evidenceIds: [reviewStateEvidence.evidenceId],
        signal,
        auditContext: { round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total },
        onAttempt: (a) => physicalCalls.push({
          role: 'reviewer', round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total,
          attempt: a.attempt, family: a.family, provider: a.provider, quotaPools: a.quotaPools,
          resolvedModel: null, usage: null, outcome: a.outcome, code: a.code,
        }),
        invoke: ({
          selection, attempt, family, provider,
        }) => Promise.resolve(reviewerFn({
          objective,
          diff: chunk.text,
          changedFiles: delta.changedFiles,
          gate,
          reviewScope,
          diffScope: delta.diffScope ?? 'cumulative',
          round: loopState.round,
          chunk: { index: chunk.index, total: chunk.total },
          previousFindings: loopState.lastReview?.blockingFindings ?? [],
          supervisorGuidance: loopState.pendingReviewerReconsideration?.guidance ?? null,
          evidence: evidenceBundle,
          selection,
          signal,
        })).then((out) => {
          // Captured HERE, before meteredCall reduces the result to a bare
          // business value: the ONE place the actually-resolved model and raw
          // provider usage for THIS physical attempt are still visible.
          physicalCalls.push({
            role: 'reviewer', round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total,
            attempt, family: selection?.family ?? family ?? null, provider: selection?.provider ?? provider ?? null,
            quotaPools: selection?.quotaPools ?? null, resolvedModel: out?.model ?? selection?.model ?? null,
            usage: out?.usage ?? null, outcome: 'SUCCESS', code: null,
          });
          return {
            value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
          };
        }),
      });
      loopState.reviewerCalls += 1;
      const normalized = normalizeReview({ raw, reviewer: 'internal', provider: 'internal' });
      // Durable-before-next-chunk: persist this chunk's result so a crash before
      // the round completes does not re-call the model for it on resume.
      checkpoint.chunks[chunk.index] = normalized;
      // eslint-disable-next-line no-await-in-loop
      await saveLoop(loopState);
      // Any chunk we could not review successfully fails the whole review closed.
      if (normalized.status === 'FAILED') {
        return {
          review: { ...normalized, physicalCalls: await withDurablePhysicalCalls(physicalCalls) },
          chunkCount: chunks.length,
          failedChunk: chunk.index,
        };
      }
      perChunk.push(normalized);
    }

    // Aggregate: union of findings across every successfully-reviewed chunk.
    const bySig = new Map();
    for (const r of perChunk) {
      for (const f of [...r.blockingFindings, ...r.nonBlockingFindings.map((n) => ({ ...n, signature: `${n.severity}:${n.file ?? ''}:${n.title ?? ''}` }))]) {
        if (f.signature && !bySig.has(f.signature)) bySig.set(f.signature, f);
      }
    }
    const findings = [...bySig.values()];
    const blocking = findings.filter((f) => objective.blockingSeverities.includes(f.severity));
    return {
      review: {
        status: blocking.length ? 'ACTIONABLE' : 'CLEAN',
        reviewer: 'internal',
        provider: 'internal',
        reviewedHead: delta.currentHead,
        blockingFindings: blocking,
        nonBlockingFindings: findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).slice(0, 8),
        nonBlockingOmitted: Math.max(0, findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).length - 8),
        findingSignatures: [...new Set(blocking.map((f) => f.signature).filter(Boolean))].sort(),
        error: null,
        physicalCalls: await withDurablePhysicalCalls(physicalCalls),
      },
      chunkCount: chunks.length,
    };
  }

  // Gate commands for one review gate, shared by LOCAL and PR. Uses exactly the
  // plan frozen at begin (never the possibly Worker-edited on-disk config) plus
  // the current scope's own commands. `drift` means the verification manifest
  // under `cwd` no longer matches the frozen plan, so the Gate cannot be trusted.
  function resolveGateCommands({ cwd, loopState, objective, reviewScope }) {
    const frozenPlan = objective.verificationPlan;
    let gateCommands;
    let commandSource;
    if (frozenPlan?.commands?.length) {
      gateCommands = frozenPlan.commands;
      commandSource = `${frozenPlan.source} (frozen at begin)`;
      let current = null;
      try {
        current = discoverVerificationCommandsFn({ cwd, configured: loopState.verificationCommands });
      } catch { /* discovery is best-effort here */ }
      if (current?.manifestFingerprint && frozenPlan.manifestFingerprint
        && current.manifestFingerprint !== frozenPlan.manifestFingerprint) {
        return { drift: true };
      }
    } else {
      const discovered = discoverVerificationCommandsFn({ cwd, configured: loopState.verificationCommands });
      gateCommands = discovered.commands;
      commandSource = discovered.source;
    }
    const baseGateCommandCount = gateCommands?.length ?? 0;
    gateCommands = mergeScopedGateCommands(gateCommands, reviewScope);
    if (gateCommands.length > baseGateCommandCount) {
      commandSource = `${commandSource} + frozen ${reviewScope.id} verification`;
    }
    return { drift: false, gateCommands, commandSource };
  }

  // Fingerprints that decide "is this new information?" for one review round.
  function reviewRoundFingerprints({ loopState, delta, gate, reviewScope, evidenceCheck }) {
    const reconsiderationPending = Boolean(loopState.pendingReviewerReconsideration);
    const canonicalFp = reviewFingerprint({
      deltaFingerprint: delta.fingerprint,
      gateFingerprint: gate.fingerprint,
      reviewScopeFingerprint: reviewScope.fingerprint,
      evidenceFingerprint: evidenceCheck.proofFingerprint,
    });
    const effectiveEvidenceFingerprint = logicalEvidenceFingerprint(loopState, evidenceCheck.proofFingerprint);
    const fp = reviewFingerprint({
      deltaFingerprint: delta.fingerprint,
      gateFingerprint: gate.fingerprint,
      reviewScopeFingerprint: reviewScope.fingerprint,
      evidenceFingerprint: effectiveEvidenceFingerprint,
    });
    return { reconsiderationPending, canonicalFp, effectiveEvidenceFingerprint, fp };
  }

  function recordFindingSignatures(loopState, review) {
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      {
        round: loopState.round,
        gateRound: loopState.gateRound,
        epoch: loopState.convergenceEpoch ?? 0,
        epochReviewRound: loopState.epochReviewRound ?? loopState.gateRound,
        signatures: review.findingSignatures,
      },
    ];
  }

  // A cumulative diff that no longer fits one final review would stop the loop
  // outright. When every phase recorded what it reviewed and the tree since the
  // last boundary is attributable, review the cross-phase and post-boundary
  // files instead (see finalDiffReducer.js). Any doubt returns null and the old
  // behaviour stands.
  async function reduceOversizedFinalDiff({ loopState, cwd, delta }) {
    try {
      if (!chunkDiffForReview(delta.diff, { env }).oversized) return null;
      const completed = loopState.completedPhases ?? [];
      const lastBoundary = baselineFromPhaseEntry(completed[completed.length - 1]);
      if (!lastBoundary) return null;
      const post = await collectWorkerDeltaFn({ cwd, baseline: lastBoundary });
      if (!post || post.evidenceComplete === false) return null;
      const { limit, maxChunks } = reviewDiffBudget(env);
      const reduced = reduceFinalDiff({
        diff: delta.diff,
        changedFiles: delta.changedFiles,
        completedPhases: completed,
        postBoundaryFiles: post.changedFiles ?? [],
        // Never hand the final Reviewer an empty diff: keep real code in view
        // (most recent phases first) up to one chunk, within the whole budget.
        fillChars: limit,
        maxChars: limit * maxChunks,
      });
      if (!reduced || chunkDiffForReview(reduced.diff, { env }).oversized) return null;
      return reduced;
    } catch {
      return null;
    }
  }

  // Deterministic Gate failures cost no Reviewer tokens, but a Worker can keep
  // "repairing" a Gate that fails for a different reason every time (a flaky
  // test, a wrong verification command) indefinitely. After this many Gate
  // failures in one gate the loop stops for a human; reopen-gate resets it.
  const DEFAULT_MAX_GATE_REPAIRS = 15;
  async function stopIfGateRepairsExhausted(loopState) {
    const configured = Number(env?.REVIEWLOOP_MAX_GATE_REPAIRS);
    const limit = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_GATE_REPAIRS;
    if ((loopState.gateRepairCount ?? 0) <= limit) return null;
    loopState.budgetExhausted = true;
    recordTransition(
      loopState,
      REVIEW_LOOP_STATES.HUMAN_REQUIRED,
      `the deterministic Gate failed ${loopState.gateRepairCount} times in this gate (limit ${limit}); `
      + 'check for a flaky test or a wrong verification command',
    );
    await saveLoop(loopState);
    return humanRequiredResult(loopState, null, await durableTelemetry(loopState.loopId));
  }

  // Snapshot of the just-certified tree, used as the diff start for the NEXT
  // LOCAL phase gate (and, after the last phase, to find what changed since).
  // Skipped (-> cumulative diff, never worse) when the snapshot cannot be trusted: untracked
  // files at the boundary would make every new Worker file unattributable
  // (D25), so the Worker must stage or commit new files before the phase ends.
  async function captureNextPhaseBoundary(loopState, objective, reviewScope, cwd) {
    if (reviewScope?.type !== 'phase') return null;
    try {
      const b = await captureBaselineFn({ cwd });
      if (!b?.head || b.evidenceComplete === false) return null;
      if (Object.keys(b.untrackedHashes ?? {}).length) return null;
      return { head: b.head, baselineRef: b.baselineRef ?? b.head };
    } catch {
      return null;
    }
  }

  // ---- LOCAL mode --------------------------------------------------------
  async function reviewLocal({ loopState, evidence, signal }) {
    const objective = loopState.objective;
    const reviewScope = currentReviewScope(loopState, objective);
    const cwd = objective.repository?.root;
    let baseline = phaseScopedBaseline(loopState, objective, reviewScope) ?? objective.baseline;
    let diffScope = baseline === objective.baseline ? 'cumulative' : 'phase-delta';

    let delta = await collectWorkerDeltaFn({ cwd, baseline });
    // A phase boundary that cannot be used (nothing changed this phase, or the
    // delta cannot be attributed) falls back to the original baseline, so the
    // result is never worse than a cumulative review.
    if (diffScope === 'phase-delta' && (delta.noWorkerChangeYet || delta.evidenceComplete === false)) {
      baseline = objective.baseline;
      diffScope = 'cumulative';
      delta = await collectWorkerDeltaFn({ cwd, baseline });
    }

    // B7 — no Worker change since begin -> deterministic NO_PROGRESS, 0 Reviewer.
    if (delta.noWorkerChangeYet) {
      await saveLoop(loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'no Worker change has been made since reviewloop_begin; do the work, then call reviewloop_review',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'review requested');

    // Validate shape/requirement/current-scope membership before the LOCAL Gate
    // can spend time or mutate the worktree. Exact-code binding still happens
    // only after Gate stabilization below.
    try {
      validateEvidenceSubmissions({ objective, reviewScope, submissions: evidence });
    } catch (err) {
      if (!(err instanceof EvidenceValidationError)) throw err;
      const status = evidenceStatusForScope({
        loopState, objective, reviewScope, evidenceFingerprint: delta.fingerprint,
      });
      return evidenceRework({
        loopState,
        gate: { verdict: 'NOT_RUN', failureIdentities: [] },
        head: delta.currentHead ?? null,
        reason: err.message,
        missing: status.missing,
        receipt: unacceptedEvidence(evidence, 'INVALID_EVIDENCE'),
      });
    }

    // B7 — a pre-existing change that cannot be attributed away from the Worker
    // must not be sent to the Reviewer as Worker output.
    if (delta.evidenceComplete === false) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'baseline attribution incomplete');
      await saveLoop(loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: `cannot reliably separate Worker changes from pre-existing work: ${(delta.incompleteReasons ?? []).join('; ')}`,
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    // The verification plan was FROZEN at reviewloop_begin; resolveGateCommands
    // never re-derives it from the (possibly Worker-edited) on-disk config. Any
    // manifest drift fails the review closed rather than trusting the Gate: the
    // Worker must revert the config or start a fresh reviewloop_begin.
    const resolved = resolveGateCommands({ cwd, loopState, objective, reviewScope });
    if (resolved.drift) {
      collectSafetyEvent({
        code: 'VERIFICATION_PLAN_DRIFT',
        severity: 'BLOCKING',
        role: 'gate',
        taskId: loopState.loopId,
        reason: `the verification config (${objective.verificationPlan.source}) was modified after reviewloop_begin`,
        actionTaken: 'review blocked; frozen Gate cannot be trusted',
      });
      loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
      const driftStop = await stopIfGateRepairsExhausted(loopState);
      if (driftStop) return driftStop;
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'verification plan drift');
      await saveLoop(loopState);
      return {
        ...compactReworkPayload({
          loopState,
          review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 },
          gate: { verdict: 'FAIL', failureIdentities: ['verification-plan-drift'] },
        }),
        reason: 'the verification configuration was changed after reviewloop_begin; revert '
          + '.reviewloop.json / the package.json test script to what it was, or start a new '
          + 'reviewloop_begin — ReviewLoop will not run a Gate the Worker can edit mid-loop',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }
    const { gateCommands, commandSource } = resolved;
    // The baseline Gate evidence can downgrade a review-time FAIL to WARN by
    // treating shared failures as pre-existing. It lives in workflow.json,
    // OUTSIDE the tamper-checked objective — so a state editor could inject the
    // CURRENT failures into it and mask a real regression. Use it ONLY when its
    // identity still matches the objective-bound fingerprint captured at begin;
    // otherwise ignore it (no suppression → a real regression stays FAIL).
    let trustedBaselineGateEvidence = null;
    const persistedBaselineGate = loopState.baselineGateEvidence ?? null;
    if (persistedBaselineGate?.evidence) {
      const boundIdentity = objective.baselineGateEvidence ?? null;
      const currentIdentity = baselineGateEvidenceIdentity(persistedBaselineGate);
      if (boundIdentity && JSON.stringify(boundIdentity) === JSON.stringify(currentIdentity)) {
        trustedBaselineGateEvidence = persistedBaselineGate.evidence;
      } else {
        collectSafetyEvent({
          code: 'REVIEWLOOP_BASELINE_GATE_EVIDENCE_UNVERIFIED',
          severity: 'NON_BLOCKING',
          role: 'gate',
          taskId: loopState.loopId,
          reason: boundIdentity
            ? 'baseline Gate evidence no longer matches the objective-bound identity captured at reviewloop_begin'
            : 'objective carries no baseline Gate evidence binding (legacy loop)',
          actionTaken: 'ignoring baseline Gate evidence for FAIL->WARN suppression this review',
        });
      }
    }
    let gateMutatedTree = false;
    let gate = await runGateFn({
      cwd, commands: gateCommands, runner: gateRunner, env, signal,
      baselineGateEvidence: trustedBaselineGateEvidence,
    });
    gate.commandSource = commandSource;
    gate.executedCommands = [...gateCommands];

    // The review-time Gate may itself have mutated tracked files (a formatter, a
    // snapshot writer, a codegen step). The delta was collected BEFORE it ran,
    // so re-collect. If the Gate DID change the tree, adopt the post-Gate tree
    // AND re-run the frozen Gate over it, repeating until the tree stops
    // changing — otherwise a later PASS could pair test evidence from the
    // pre-mutation tree with Reviewer evidence from the post-mutation tree,
    // leaving the actual final code unverified. A Gate that never converges, or
    // whose post-Gate delta cannot be re-collected safely, fails closed.
    // (begin-time recapture already covers the baseline Gate; this is the
    // review path.)
    const postGateFn = collectPostGateDeltaFn
      ?? (collectWorkerDeltaFn === collectWorkerDelta ? collectWorkerDelta : null);
    if (postGateFn && !signal?.aborted) {
      // Collect + validate the post-Gate Worker delta. Fail closed on EVERY
      // failure — a throw, a missing result, a missing fingerprint, or
      // incomplete attribution. The fingerprint excludes completeness metadata,
      // so a Gate that creates an untracked file while this recollection fails
      // would otherwise send stale evidence to the Reviewer and reach PASS
      // without that file being reviewed.
      const collectPostGate = async () => {
        let d = null;
        let e = null;
        try { d = await postGateFn({ cwd, baseline }); } catch (err) { e = err; }
        if (!d || !d.fingerprint || d.evidenceComplete === false) {
          const why = e
            ? `post-Gate delta collection threw: ${e?.message ?? e}`
            : !d
              ? 'post-Gate delta collection returned no result'
              : !d.fingerprint
                ? 'post-Gate delta collection returned no fingerprint'
                : (d.incompleteReasons ?? ['post-Gate Worker delta could not be attributed']).join('; ');
          return { ok: false, why };
        }
        return { ok: true, delta: d };
      };

      const humanRequired = async (reason, transitionLabel = 'post-Gate attribution incomplete') => {
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, transitionLabel);
        await saveLoop(loopState);
        return {
          status: 'HUMAN_REQUIRED',
          loopId: loopState.loopId,
          round: loopState.round,
          reason,
          telemetry: await durableTelemetry(loopState.loopId),
          safetyEvents,
        };
      };

      let pg = await collectPostGate();
      if (!pg.ok) {
        return humanRequired(`the deterministic Gate ran and the post-Gate Worker delta could not be re-collected safely: ${pg.why}`);
      }

      const MAX_GATE_STABILISE = 3;
      let stabiliseRuns = 0;
      while (pg.delta.fingerprint !== delta.fingerprint) {
        gateMutatedTree = true;
        // No proof for this scope survives a code change made during review.
        // In particular, do not re-label the caller's pre-Gate evidence with
        // the post-Gate fingerprint, or reuse history if the Gate later reverts.
        loopState.evidenceRecords = (loopState.evidenceRecords ?? [])
          .filter((record) => record.reviewScopeFingerprint !== reviewScope.fingerprint);
        collectSafetyEvent({
          code: 'GATE_MUTATED_TRACKED_FILES',
          severity: 'NON_BLOCKING',
          role: 'gate',
          taskId: loopState.loopId,
          reason: 'the review-time Gate modified tracked files; re-running the frozen Gate over the post-Gate tree',
          actionTaken: 'review proceeds only once the Gate and the tree agree',
        });
        delta = pg.delta;

        // A mutating Gate may have reverted the Worker's only changes back to
        // the captured baseline — the Reviewer would then be called with an
        // empty diff and a clean response would PASS, certifying work that no
        // longer exists in the tree.
        if (delta.noWorkerChangeYet) {
          await saveLoop(loopState);
          return {
            status: 'NO_PROGRESS',
            loopId: loopState.loopId,
            round: loopState.round,
            reason: 'the deterministic Gate reverted the Worker delta back to the reviewloop_begin baseline; '
              + 'no Worker change remains to review',
            telemetry: await durableTelemetry(loopState.loopId),
            safetyEvents,
          };
        }

        // A failing Gate is already sufficient for REWORK. We still had to
        // recollect and invalidate proof if it changed the tree, but must not
        // run the failing mutator again in this round.
        if (gate.verdict === GATE_VERDICTS.FAIL) break;

        stabiliseRuns += 1;
        if (stabiliseRuns > MAX_GATE_STABILISE) {
          return humanRequired(
            `the deterministic Gate keeps modifying tracked files and never converged after ${MAX_GATE_STABILISE} re-runs; `
            + 'run the mutating verification step (formatter / codegen / snapshot writer) yourself, commit its output, then re-review',
            'review-time Gate never stabilised',
          );
        }

        // eslint-disable-next-line no-await-in-loop
        gate = await runGateFn({
          cwd, commands: gateCommands, runner: gateRunner, env, signal,
          baselineGateEvidence: trustedBaselineGateEvidence,
        });
        gate.commandSource = commandSource;
        gate.executedCommands = [...gateCommands];
        if (signal?.aborted) break;

        // Recollect even after a FAIL: a failing formatter/codegen Gate may
        // still have changed bytes, and stale exact-code evidence must be
        // invalidated before returning the Gate failure.
        // eslint-disable-next-line no-await-in-loop
        pg = await collectPostGate();
        if (!pg.ok) {
          return humanRequired(`the frozen Gate was re-run over the post-Gate tree and the delta could not be re-collected safely: ${pg.why}`);
        }
      }
    }

    if (signal?.aborted) {
      // Cancelled during the Gate — never proceed to a paid Reviewer dispatch.
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'review cancelled by caller');
      await saveLoop(loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'the review was cancelled by the caller before the Reviewer ran',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    if (gate.verdict === GATE_VERDICTS.FAIL) {
      // Gate failure needs no runtime/manual evidence. Keep the legacy
      // diff+gate progress identity so an identical deterministic failure does
      // not become "new information" merely because evidence text changed.
      const gateFp = reviewFingerprint({
        deltaFingerprint: delta.fingerprint,
        gateFingerprint: gate.fingerprint,
        reviewScopeFingerprint: reviewScope.fingerprint,
      });
      if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === gateFp) {
        await saveLoop(loopState);
        return {
          status: 'NO_PROGRESS',
          loopId: loopState.loopId,
          round: loopState.round,
          reason: 'submitted state is identical to the last review; no Reviewer/Supervisor call made',
          evidenceSubmission: unacceptedEvidence(evidence, 'GATE_FAILED'),
          lastReview: compactLastReview(loopState),
          telemetry: await durableTelemetry(loopState.loopId),
          safetyEvents,
        };
      }
      loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
      const gateStop = await stopIfGateRepairsExhausted(loopState);
      if (gateStop) return gateStop;
      loopState.lastReviewedFingerprint = gateFp;
      loopState.lastGateFingerprint = gate.fingerprint;
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate regression');
      await saveLoop(loopState);
      return {
        ...compactReworkPayload({ loopState, review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 }, gate }),
        reason: 'deterministic Gate failed with a new regression; fix it before Reviewer runs',
        evidenceSubmission: unacceptedEvidence(evidence, 'GATE_FAILED'),
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    if (gateMutatedTree && (Array.isArray(evidence) ? evidence.length > 0 : evidence != null)) {
      return evidenceRework({
        loopState, gate, head: delta.currentHead ?? null,
        reason: 'the deterministic Gate changed the code during review; pre-Gate evidence was not accepted. Produce fresh evidence against the stabilized tree and retry in this loop',
        missing: requiredEvidenceForScope(objective, reviewScope),
        receipt: unacceptedEvidence(evidence, 'CODE_CHANGED'),
      });
    }

    // Runtime/artifact/manual proof is part of the logical review state.
    // Process it BEFORE the no-progress guard so improved evidence can be
    // independently re-reviewed without requiring an unrelated code change.
    const evidenceCheck = await enforceEvidenceObligations({
      loopState,
      objective,
      reviewScope,
      delta,
      gate,
      submissions: evidence,
      head: delta.currentHead ?? null,
    });
    if (evidenceCheck.blocked) return evidenceCheck.result;

    const {
      reconsiderationPending, canonicalFp, effectiveEvidenceFingerprint, fp,
    } = reviewRoundFingerprints({ loopState, delta, gate, reviewScope, evidenceCheck });
    if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === fp) {
      await saveLoop(loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'submitted code/gate/evidence state is identical to the last review; no Reviewer/Supervisor call made',
        lastReview: compactLastReview(loopState),
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    delta.diffScope = diffScope;
    if (reviewScope.type === 'final') {
      const reduced = await reduceOversizedFinalDiff({ loopState, cwd, delta });
      if (reduced) {
        delta.diff = reduced.diff;
        delta.diffScope = 'final-cross-phase';
      }
    }
    const spend = spendFor(loopState.loopId, objective);
    // The fresh-round increment now lives in runReviewerOverEvidence, bound to
    // the logical (delta + gate) review state so a crash/resume of the same
    // review never consumes an extra round.

    let reviewOut;
    try {
      reviewOut = await runReviewerOverEvidence({
        spend, loopState, objective, delta, gate, reviewScope,
        evidenceBundle: evidenceCheck.bundle,
        evidenceProofFingerprint: effectiveEvidenceFingerprint,
        signal,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) throw err; // read-only exit in review()
      return spendDenialResult(loopState, err, await spend.telemetry());
    }
    const review = reviewOut.review;
    review.reviewedFingerprint = fp;
    // The Reviewer audit identity includes one-shot Supervisor adjudication,
    // but once that adjudication is consumed, future NO_PROGRESS checks must
    // compare the canonical code/gate/runtime-evidence state. Otherwise the
    // disappearing adjudication hash itself looks like fresh information.
    loopState.lastReviewedFingerprint = reconsiderationPending ? canonicalFp : fp;
    loopState.lastGateFingerprint = gate.fingerprint;
    loopState.lastReview = review;
    // The round's chunks are all reviewed (or it failed closed) — the
    // checkpoint has served its purpose.
    loopState.chunkReviewCheckpoint = null;

    if (review.status === 'FAILED') {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, review.error?.reason ?? 'review failed');
      await saveLoop(loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: `Reviewer did not produce a usable result (${review.error?.reason}): ${review.error?.message ?? ''}`,
        telemetry: await spend.telemetry(),
        safetyEvents,
      };
    }

    // A valid reconsideration has now been consumed by this Reviewer result.
    // Failed/cancelled reviews above leave it pending for safe retry.
    loopState.pendingReviewerReconsideration = null;
    const decision = decideConvergence({ loopState, review });
    recordFindingSignatures(loopState, review);

    let supervisorGuidance = null;
    if (decision.verdict === REVIEW_VERDICTS.REWORK && decision.invokeSupervisor) {
      const sup = await runSupervisor({
        spend, loopState, objective, review, gate, reviewScope, evidenceBundle: evidenceCheck.bundle, signal,
      });
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      const outcome = await applySupervisorOutcome({
        sup, loopState, review, spend, escalationReason: decision.reason,
      });
      if (outcome.result) return outcome.result;
      supervisorGuidance = outcome.guidance;
    }

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      const telemetry = await spend.telemetry();
      const phaseResult = completeCurrentPhase(loopState, review, telemetry, {
        head: delta.currentHead ?? null,
        gate,
        reviewScope,
        evidenceFingerprint: delta.fingerprint,
        phaseBaseline: await captureNextPhaseBoundary(loopState, objective, reviewScope, cwd),
        // Bounded: beyond this the final gate simply keeps reviewing the full diff.
        reviewedFiles: (delta.changedFiles ?? []).length <= 2000 ? [...(delta.changedFiles ?? [])] : null,
      });
      if (phaseResult) {
        await saveLoop(loopState);
        return phaseResult;
      }
      loopState.resumePacket = null;
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await saveLoop(loopState);
      return passResult(loopState, review, telemetry);
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      loopState.budgetExhausted = true; // all automatic convergence epochs/escalations spent
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await saveLoop(loopState);
      return humanRequiredResult(loopState, review, await spend.telemetry(), supervisorGuidance);
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
    await saveLoop(loopState);
    return {
      ...compactReworkPayload({ loopState, review, gate, supervisorGuidance }),
      reason: decision.reason,
      telemetry: await spend.telemetry(),
      safetyEvents,
    };
  }

  // See withDurablePhysicalCalls in runReviewerOverEvidence for the rationale.
  async function withDurableSupervisorCalls(loopState, inMemory) {
    try {
      const durable = await reconstructPhysicalCalls({
        persistence, loopId: loopState.loopId, role: 'supervisor', round: loopState.round,
      });
      return durable.length ? durable : inMemory;
    } catch { return inMemory; }
  }

  // Supervisor, exception-only. Returns { guidance } | { humanRequired, reason }
  // | { denied, error }.
  async function runSupervisor({
    spend, loopState, objective, review, gate, reviewScope = currentReviewScope(loopState, objective),
    evidenceBundle = null, signal,
  }) {
    const physicalCalls = [];
    if (signal?.aborted) {
      return { humanRequired: true, reason: 'the review was cancelled by the caller before the Supervisor ran', physicalCalls };
    }
    const findingsEvidence = await spend.registerEvidence({
      kind: 'findings',
      taskId: `${loopState.loopId}:${reviewScope.id}`,
      // A later Supervisor call is justified by a fresh independently reviewed
      // state, never by incrementing an escalation counter over identical data.
      signature: `${review.reviewedFingerprint ?? 'unknown'}::${review.findingSignatures.join('|') || 'none'}`,
    });
    let raw;
    try {
      raw = await meteredWithFailover({
        spend,
        role: 'supervisor',
        routeFn: routeSupervisorFn,
        defaultFamily: 'agy:gemini-supervisor',
        defaultProvider: 'agy',
        operationId: `${loopState.loopId}:supervise:${reviewScope.id}:round-${loopState.round}`,
        workflowId: loopState.loopId,
        evidenceIds: [findingsEvidence.evidenceId],
        signal,
        auditContext: { round: loopState.round, chunkIndex: null, chunkTotal: null },
        onAttempt: (a) => physicalCalls.push({
          role: 'supervisor', round: loopState.round, chunkIndex: null, chunkTotal: null,
          attempt: a.attempt, family: a.family, provider: a.provider, quotaPools: a.quotaPools,
          resolvedModel: null, usage: null, outcome: a.outcome, code: a.code,
        }),
        invoke: ({
          selection, attempt, family, provider,
        }) => Promise.resolve(supervisorFn({
          objective, blockingFindings: review.blockingFindings, gate, reviewScope, evidence: evidenceBundle,
          round: loopState.round,
          convergenceEpoch: loopState.convergenceEpoch ?? 0,
          supervisorEscalationCount: loopState.supervisorEscalationCount ?? 0,
          priorSignatures: loopState.findingSignatureHistory,
          priorSupervisorGuidance: loopState.lastSupervisorGuidance,
          selection, signal,
        })).then((out) => {
          physicalCalls.push({
            role: 'supervisor', round: loopState.round, chunkIndex: null, chunkTotal: null,
            attempt, family: selection?.family ?? family ?? null, provider: selection?.provider ?? provider ?? null,
            quotaPools: selection?.quotaPools ?? null, resolvedModel: out?.model ?? selection?.model ?? null,
            usage: out?.usage ?? null, outcome: 'SUCCESS', code: null,
          });
          return {
            value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
          };
        }),
      });
    } catch (err) {
      // A spend/authorization denial (SPEND_DENIED, MODEL_SPEND_USAGE_UNRESOLVED
      // — a call was dispatched but its usage could not be settled, UNKNOWN !=
      // ZERO) is a deliberate fail-closed stop, NOT a degradable transient: it
      // returns `denied` and the caller surfaces it as-is. Any other error
      // (provider pool exhausted with settled accounting, non-auth non-retryable
      // failure) is a degradable transient.
      if (err instanceof LeaseLostError) throw err; // read-only exit in review()
      const denialCalls = await withDurableSupervisorCalls(loopState, physicalCalls);
      if (isAuthorizationFailure(err)) return { denied: true, error: err, physicalCalls: denialCalls };
      return { humanRequired: true, reason: `Supervisor call failed: ${err?.message ?? err}`, physicalCalls: denialCalls };
    }
    loopState.supervisorCalls += 1;
    loopState.supervisorInvoked = true;
    // Crash/resume durability, same reconciliation as the reviewer's chunk
    // loop above: every physical Supervisor attempt (this process's or an
    // earlier crashed one's, via the failover-reuse resume path) settled its
    // accounting record durably before meteredCall returned.
    physicalCalls.splice(0, physicalCalls.length, ...(await withDurableSupervisorCalls(loopState, physicalCalls)));
    // B1 — malformed Supervisor output is never treated as valid REWORK guidance.
    if (!raw || raw.malformed === true || typeof raw.guidance !== 'string' || !raw.guidance.trim()) {
      return {
        humanRequired: true,
        reason: `Supervisor produced no usable repair guidance${raw?.reason ? ` (${raw.reason})` : ''}`,
        physicalCalls,
      };
    }
    if (String(raw.recommendation).toUpperCase() === 'HUMAN_REQUIRED') {
      // The Supervisor actually adjudicated the loop non-convergent. Only this
      // path is terminal — a cancellation, transport throw, or malformed
      // response above returns `humanRequired` WITHOUT `terminal`, so the round
      // stays resumable.
      return {
        humanRequired: true, terminal: true, reason: 'Supervisor recommends human involvement', guidance: raw.guidance, physicalCalls,
      };
    }
    return {
      guidance: raw.guidance,
      recommendation: String(raw.recommendation ?? 'REWORK').toUpperCase(),
      physicalCalls,
    };
  }

  // Apply a Supervisor result to the loop. Returns:
  //   { result }   — ready to return from the caller (terminal HUMAN_REQUIRED)
  //   { guidance } — continue the in-line REWORK path with this guidance
  // A `terminal` "Supervisor recommends human involvement" spends the budget. A
  // degradable TRANSIENT failure (`humanRequired` WITHOUT `terminal`: caller
  // cancelled before dispatch, provider pool exhausted with settled accounting,
  // output unusable but the call settled) does NOT stall the loop: it degrades
  // to a plain REWORK round (guidance: null). The Worker still has the finding,
  // the round cap is still the stagnation circuit-breaker, and a later
  // persistent-finding round can retry the Supervisor (supervisorInvoked reset).
  // NOTE: a dispatched call whose usage cannot be settled
  // (MODEL_SPEND_USAGE_UNRESOLVED) never reaches here — runSupervisor returns
  // `denied` and the caller fails closed, by design (UNKNOWN != ZERO).
  async function applySupervisorOutcome({
    sup, loopState, review, spend, escalationReason,
  }) {
    if (sup.humanRequired && sup.terminal) {
      loopState.budgetExhausted = true;
      loopState.supervisorEscalationCount = (loopState.supervisorEscalationCount ?? 0) + 1;
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, sup.reason);
      await saveLoop(loopState);
      return { result: humanRequiredResult(loopState, review, await spend.telemetry(), sup.guidance) };
    }
    if (sup.humanRequired) {
      // A settled-but-unusable/transient Supervisor attempt is not a valid
      // escalation. Preserve the old observable meaning of supervisorInvoked:
      // it only latches when usable strategy/adjudication was produced.
      loopState.supervisorInvoked = (loopState.supervisorEscalationCount ?? 0) > 0;
      // Transient Supervisor failure creates no strategy and no new epoch.
      collectSafetyEvent({
        code: 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE', severity: 'NON_BLOCKING', role: 'supervisor',
        taskId: loopState.loopId, reason: sup.reason,
        actionTaken: 'Supervisor guidance skipped; proceeding as a plain REWORK round',
      });
      return { guidance: null };
    }

    const recommendation = String(sup.recommendation ?? 'REWORK').toUpperCase();
    const previousRecommendation = String(loopState.lastSupervisorRecommendation ?? '').toUpperCase();
    const previousGuidance = normalizeSupervisorStrategyText(loopState.lastSupervisorGuidance);
    const currentGuidance = normalizeSupervisorStrategyText(sup.guidance);
    const repeatsPriorStrategy = Boolean(
      previousGuidance
      && previousRecommendation === recommendation
      && previousGuidance === currentGuidance
    );

    if (repeatsPriorStrategy) {
      // A repeated strategy is not New Information. Do not consume another
      // escalation slot or manufacture a new epoch around already-failed advice.
      loopState.budgetExhausted = true;
      collectSafetyEvent({
        code: 'REVIEWLOOP_SUPERVISOR_NO_NEW_STRATEGY',
        severity: 'BLOCKING',
        role: 'supervisor',
        taskId: loopState.loopId,
        reason: 'Supervisor repeated the prior strategy without material change',
        actionTaken: 'automatic convergence stopped; human adjudication required',
      });
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
      recordTransition(
        loopState,
        REVIEW_LOOP_STATES.HUMAN_REQUIRED,
        'Supervisor produced no materially new convergence strategy',
      );
      await saveLoop(loopState);
      return {
        result: humanRequiredResult(
          loopState,
          review,
          await spend.telemetry(),
          sup.guidance,
        ),
      };
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
    loopState.supervisorInvoked = true;
    loopState.lastSupervisorGuidance = sup.guidance;
    loopState.lastSupervisorRecommendation = recommendation;
    loopState.supervisorEscalationCount += 1;
    loopState.convergenceEpoch += 1;
    loopState.epochReviewRound = 0;

    if (recommendation === 'REVIEWER_RECONSIDER') {
      const escalation = loopState.supervisorEscalationCount;
      loopState.pendingReviewerReconsideration = {
        recommendation,
        guidance: sup.guidance,
        escalation,
        fingerprint: sha256Hex(
          `${loopState.loopId}::${loopState.convergenceEpoch}::${escalation}::${sup.guidance}`,
        ),
        createdAt: new Date(clock()).toISOString(),
      };
    } else {
      loopState.pendingReviewerReconsideration = null;
    }
    return { guidance: sup.guidance, reconsideration: recommendation === 'REVIEWER_RECONSIDER' };
  }
  // ---- result shaping ------------------------------------------------
  function passResult(loopState, review, telemetry) {
    return {
      status: 'PASS', loopId: loopState.loopId, round: loopState.round, gateRound: loopState.gateRound,
      convergenceEpoch: loopState.convergenceEpoch ?? 0,
      supervisorEscalationCount: loopState.supervisorEscalationCount ?? 0,
      reviewer: review.reviewer,
      nonBlockingFindings: review.nonBlockingFindings, nonBlockingOmitted: review.nonBlockingOmitted ?? 0,
      evidenceRecordCount: (loopState.evidenceRecords ?? []).length,
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  function humanRequiredResult(loopState, review, telemetry, supervisorGuidance) {
    const budgetExhausted = loopState.budgetExhausted === true;
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      gateRound: loopState.gateRound ?? loopState.round,
      convergenceEpoch: loopState.convergenceEpoch ?? 0,
      epochReviewRound: loopState.epochReviewRound ?? 0,
      supervisorEscalationCount: loopState.supervisorEscalationCount ?? 0,
      // budgetExhausted means the FULL automatic convergence strategy is spent
      // (Reviewer epochs plus Supervisor escalations), not merely three reviews.
      // The Worker must report to the user and stop: not another reviewloop_review
      // on this loop, not a fresh reviewloop_begin in the same task.
      terminal: budgetExhausted || undefined,
      budgetExhausted: budgetExhausted || undefined,
      blockingFindings: review?.blockingFindings ?? [],
      supervisorGuidance: supervisorGuidance ?? loopState.lastSupervisorGuidance ?? null,
      reason: (loopState.history?.slice(-1)[0]?.reason ?? 'review did not converge')
        + (budgetExhausted ? ' — this ReviewLoop budget is spent; report to the user and stop, do not start another loop for this task' : ''),
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  // A provider/spend failure that surfaces as HUMAN_REQUIRED MUST also latch the
  // durable loop state to HUMAN_REQUIRED — the returned status and the persisted
  // state can never disagree. (Before this, the caller was told HUMAN_REQUIRED
  // while the loop stayed at REVIEWING on disk.)
  async function spendDenialResult(loopState, err, telemetry) {
    recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, `model spend blocked: ${err?.code ?? err?.message ?? err}`);
    try { await saveLoop(loopState); } catch { /* best effort; the returned status still reflects intent */ }
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      reason: `ReviewLoop model spend blocked: ${err?.message ?? err}`,
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  async function terminalResult(loopState) {
    const budgetExhausted = loopState.state === REVIEW_LOOP_STATES.HUMAN_REQUIRED
      && loopState.budgetExhausted === true;
    return {
      status: loopState.state, loopId: loopState.loopId, round: loopState.round,
      terminal: true,
      budgetExhausted: budgetExhausted || undefined,
      reason: budgetExhausted
        ? 'this loop already reached HUMAN_REQUIRED — its review-round budget is spent. Report to the '
          + 'user and stop; do NOT reviewloop_begin again in this task. A new user instruction starts a fresh loop.'
        : 'loop already terminal',
      lastReview: compactLastReview(loopState),
      telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
    };
  }
  function compactLastReview(loopState) {
    const r = loopState.lastReview;
    if (!r) return null;
    return { status: r.status, blockingFindings: r.blockingFindings, findingSignatures: r.findingSignatures };
  }
  function emptyTelemetry() {
    return { reviewerCalls: 0, supervisorCalls: 0, workerUsage: 'external / not observable by ReviewLoop' };
  }

  return { begin, review, _store: store, _persistence: persistence };
}
