// ReviewLoop controller — the two re-entrant operations behind the MCP tools.
//
//   reviewloop_begin  -> register the immutable objective + capture the exact
//     pre-Worker baseline (LOCAL) or freeze the exact PR snapshot —
//     repository, prNumber, base SHA, HEAD SHA (PR). Also captures
//     baseline Gate evidence when trusted verification is deterministically
//     discoverable. ZERO model calls.
//
//   reviewloop_review -> the one re-entrant operation: attribute the Worker's
//     delta -> deterministic Gate -> independent Reviewer over the FULL
//     attributed evidence (bounded or deterministically chunked) -> convergence
//     policy -> Supervisor (exception-only) -> PASS | REWORK | HUMAN_REQUIRED |
//     WAITING_FOR_REVIEW | NO_PROGRESS | PUSH_REQUIRED.
//
// The SAME Worker handles REWORK and calls reviewloop_review again. ReviewLoop
// never writes application code, never commits, pushes, merges, or force-pushes.

import { randomUUID, createHash } from 'node:crypto';
import { Persistence } from '../orchestrator/persistence.js';
import { isAuthorizationFailure } from '../orchestrator/errors.js';
import { DEFAULT_ROLE_POLICY } from '../orchestrator/roleRouting.js';
import { REVIEWLOOP_RUNTIME_ROOT } from './runtimeDir.js';
import {
  createReviewObjective,
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
import { collectPrDelta } from './prEvidence.js';
import {
  withPrSnapshotWorktree, PrSnapshotError, worktreeSnapshotFingerprint, worktreeSnapshotMutated,
} from './prWorktree.js';
import { assertPrRepositoryIdentity } from './prIdentity.js';
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
import { chunkDiffForReview } from './diffChunker.js';

const RUNTIME_ROOT = REVIEWLOOP_RUNTIME_ROOT;

// Absolute ceiling on physical provider attempts for one metered operation —
// purely a runaway guard. The EFFECTIVE bound is the role's own candidate count
// (see providerAttemptBudget): every DEFAULT_ROLE_POLICY candidate must be
// mechanically reachable when each earlier candidate fails safely, so a role
// with N candidates gets up to N attempts. The `tried` set already stops a
// family being re-attempted and `!selection` stops the loop when the pool is
// exhausted; this ceiling only exists so a pathological policy can never spin.
const PROVIDER_ATTEMPT_HARD_CEILING = 16;

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

function providerAttemptBudget(role) {
  const n = DEFAULT_ROLE_POLICY[role]?.length ?? 0;
  return Math.min(Math.max(n, 1), PROVIDER_ATTEMPT_HARD_CEILING);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function phasesOf(objective) {
  return Array.isArray(objective?.phases) ? objective.phases : [];
}

function currentReviewScope(loopState, objective = loopState?.objective) {
  const phases = phasesOf(objective);
  if (!phases.length) {
    const scope = { type: 'task', id: 'task', title: 'Full task' };
    return { ...scope, fingerprint: sha256Hex(JSON.stringify(scope)) };
  }

  const rawIndex = Number.isInteger(loopState?.currentPhaseIndex) ? loopState.currentPhaseIndex : 0;
  const index = Math.max(0, Math.min(rawIndex, phases.length));
  if (index < phases.length) {
    const phase = phases[index];
    const preserveInvariants = phases
      .slice(0, index)
      .flatMap((p) => p.carryForwardInvariants ?? []);
    const scope = {
      type: 'phase',
      id: phase.id,
      title: phase.title,
      objective: phase.objective,
      exitCriteria: phase.exitCriteria ?? [],
      carryForwardInvariants: phase.carryForwardInvariants ?? [],
      preserveInvariants,
      verificationCommands: phase.verificationCommands ?? [],
      phaseIndex: index,
      phaseCount: phases.length,
    };
    return { ...scope, fingerprint: sha256Hex(JSON.stringify(scope)) };
  }

  const scope = {
    type: 'final',
    id: 'final',
    title: 'Final whole-task gate',
    completedPhaseSummaries: phases.map((p) => ({
      id: p.id,
      title: p.title,
      objective: p.objective,
      exitCriteria: p.exitCriteria ?? [],
      carryForwardInvariants: p.carryForwardInvariants ?? [],
      verificationCommands: p.verificationCommands ?? [],
    })),
    phaseCount: phases.length,
    verificationCommands: phases.flatMap((p) => p.verificationCommands ?? []),
  };
  return { ...scope, fingerprint: sha256Hex(JSON.stringify(scope)) };
}

function reviewGateCount(objective) {
  const n = phasesOf(objective).length;
  return n ? n + 1 : 1; // one gate per phase + one final whole-task gate
}

function mergeScopedGateCommands(commands, reviewScope) {
  const base = Array.isArray(commands) ? commands : [];
  const scoped = (reviewScope?.type === 'phase' || reviewScope?.type === 'final')
    && Array.isArray(reviewScope.verificationCommands)
    ? reviewScope.verificationCommands
    : [];
  return [...new Set([...base, ...scoped].map(String).filter(Boolean))];
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

// Provider-failure codes that a bounded failover attempt may follow. All are
// either "the call never reached the provider" (pre-send: unavailable, ENOENT,
// spawn failure, CLI not authenticated) or "reached it but produced no usable
// result and no unresolved spend" (rate limit, quota, protocol error, timeout
// classified as mechanically bounded). A mid-flight failure with unknown usage
// never lands here — dispatch() has already turned it into a spend-blocking
// AuthorizationError.
//
// PROVIDER_AUTH_FAILED is retryable-via-failover on purpose: an unauthenticated
// CLI transport (`codex` / `claude` not logged in) is a pre-send failure with
// no spend, and RoleRouter.recordFailure already treats it as health-affecting
// (family removed, AUTH_FAILED). Trying the next eligible family is exactly the
// intended recovery; if every family is unauthenticated the loop still
// exhausts and rethrows.
const RETRYABLE = new Set([
  'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_PROTOCOL_ERROR', 'PROVIDER_AUTH_FAILED',
  'EXECUTOR_TIMEOUT', 'AGY_ENOENT', 'AGY_SPAWN_FAILED',
]);

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
  prBackend = null,
  // PR-target snapshot correctness. Real implementations by default; tests
  // inject deterministic fakes so no real git/gh call is ever made.
  resolvePrRepositoryIdentityFn = assertPrRepositoryIdentity,
  buildPrSnapshotFn = withPrSnapshotWorktree,
  collectPrDeltaFn = collectPrDelta,
  // Proves (or disproves) that the deterministic PR Gate left the exact
  // reviewed snapshot byte-identical. Real implementation by default; tests
  // inject a deterministic fake (the fake worktree is never a real checkout).
  captureWorktreeSnapshotFn = worktreeSnapshotFingerprint,
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
  // PUSH_REQUIRED / terminal) so those results never understate spend that
  // earlier rounds already incurred.
  async function durableTelemetry(loopId) {
    try {
      return await spendFor(loopId).telemetry();
    } catch {
      return emptyTelemetry();
    }
  }

  async function begin({
    goal, cwd, prNumber = null, reviewer = null,
    verificationCommands = null, blockingSeverities, maxReviewRounds,
    constraints = [], phases = [], signal = null,
  } = {}) {
    if (!goal || !String(goal).trim()) throw new Error('reviewloop_begin: goal is required');
    if (!cwd) throw new Error('reviewloop_begin: cwd is required');
    if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the baseline was captured');
    const loopId = `rl-${new Date(clock()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const mode = prNumber != null ? REVIEW_MODES.PR : REVIEW_MODES.LOCAL;

    let baseline = null;
    let prHead = null;
    let prBaseSha = null;
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
      return {
        source: String(discovered.source ?? 'unknown'),
        commands: (discovered.commands ?? []).map(String),
        manifestFingerprint: discovered.manifestFingerprint
          ?? sha256Hex(`fallback::${JSON.stringify(discovered.commands ?? [])}`),
        frozenAt: new Date(clock()).toISOString(),
      };
    };

    if (mode === REVIEW_MODES.LOCAL) {
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
    } else {
      // PR target. Resolve + FREEZE the PR snapshot identity: repository,
      // prNumber, base SHA, exact HEAD. Fail closed on anything unresolvable —
      // a review that cannot prove which snapshot it covers is worthless.
      if (!prBackend) throw new Error('reviewloop_begin: PR mode requires a PR backend');
      if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller');
      // Repository identity is NOT best-effort metadata: cwd's own repository
      // must be PROVEN identical to the PR's repository before any PR loop is
      // registered. GitHub commands are always scoped by cwd, never by the
      // MCP process's own (accidental) working directory.
      const repoIdentity = await resolvePrRepositoryIdentityFn({ cwd, prBackend, prNumber });
      if (!repoIdentity?.ok) {
        throw new Error(`reviewloop_begin: repository identity check failed — ${repoIdentity?.reason ?? 'unknown reason'}`);
      }
      repository.name = repoIdentity.nameWithOwner;
      prHead = await prBackend.getPrHead({ prNumber, cwd });
      if (!prHead) throw new Error(`reviewloop_begin: cannot resolve HEAD for PR #${prNumber}`);
      prBaseSha = typeof prBackend.getPrBaseSha === 'function'
        ? await prBackend.getPrBaseSha({ prNumber, cwd })
        : null;
      if (!prBaseSha) throw new Error(`reviewloop_begin: cannot resolve the base SHA for PR #${prNumber}`);

      // The PR Gate runs the same frozen verification plan as a LOCAL target
      // — but discovered from INSIDE the exact PR HEAD snapshot, never the
      // ambient user cwd (which may be on a different branch, dirty, or
      // simply carry a different .reviewloop.json / package.json entirely).
      // Build the same disposable worktree the review-time Gate itself uses,
      // discover verification commands inside it, then tear it down — the
      // frozen plan is bound to the PR's own snapshot from the start.
      if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the PR verification plan was frozen');
      try {
        verificationPlan = await buildPrSnapshotFn(
          { cwd, baseSha: prBaseSha, headSha: prHead, prNumber },
          async ({ worktreeDir }) => freezeVerificationPlan(worktreeDir),
        );
      } catch (err) {
        if (err instanceof PrSnapshotError) {
          throw new Error(`reviewloop_begin: cannot build the exact PR HEAD snapshot to freeze the verification plan: ${err.message}`);
        }
        throw err;
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
      loopId, goal, repository, mode, prNumber, reviewer, baseline, prHead,
      prBaseSha, reviewedHeadSha: prHead,
      constraints, phases, blockingSeverities, maxReviewRounds: resolvedMaxRounds,
      verificationPlan,
      baselineGateEvidence: baselineGate,
    });

    const loopState = initialLoopState(objective);
    loopState.verificationCommands = verificationCommands ?? null;
    loopState.baselineGateEvidence = baselineGate;
    if (mode === REVIEW_MODES.PR) loopState.lastReviewedPrHead = null;
    await store.save(loopId, loopState);
    onEvent?.({ type: 'REVIEWLOOP_BEGIN', loopId, mode });

    return {
      loopId,
      mode,
      status: 'READY',
      baseline: baseline ? compactBaselineSummary(baseline) : null,
      prHead: prHead ?? null,
      prBaseSha: prBaseSha ?? null,
      repository: repository.name ?? null,
      reviewer: objective.reviewer,
      phaseCount: phasesOf(objective).length,
      currentPhase: currentReviewScope(loopState, objective).id,
      objectiveFingerprint: objective.fingerprint,
      reviewScope: {
        type: reviewScope?.type ?? 'task',
        id: reviewScope?.id ?? 'task',
        fingerprint: reviewScope?.fingerprint ?? null,
      },
    };
  }

  async function loadLoop(loopId) {
    const raw = await store.load(loopId);
    if (!raw) throw new Error(`reviewloop_review: unknown loopId ${loopId}`);
    assertNotLegacyWorkflow(raw);
    const objective = rehydrateObjective(raw.objective);
    assertObjectiveNotWeakened(objective, raw.objective);
    raw.objective = objective;
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

  function completeCurrentPhase(loopState, review, telemetry, { head = null } = {}) {
    const scope = currentReviewScope(loopState);
    if (scope.type !== 'phase') return null;

    loopState.completedPhases = [
      ...(loopState.completedPhases ?? []),
      {
        id: scope.id,
        title: scope.title,
        completedAt: new Date(clock()).toISOString(),
        round: loopState.round,
        head,
      },
    ];
    loopState.currentPhaseIndex = scope.phaseIndex + 1;

    // Reset only gate-local convergence/no-progress state. Task-wide audit,
    // provider spend, token sentinel, baseline and objective stay intact.
    loopState.gateRound = 0;
    loopState.gateRepairCount = 0;
    loopState.findingSignatureHistory = [];
    loopState.supervisorInvoked = false;
    loopState.lastSupervisorGuidance = null;
    loopState.lastReviewedFingerprint = null;
    loopState.lastReviewedPrHead = null;
    loopState.lastGateFingerprint = null;
    loopState.lastReview = null;
    loopState.chunkReviewCheckpoint = null;

    const nextScope = currentReviewScope(loopState);
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

  // One metered provider call with bounded failover. Each physical attempt
  // re-routes (excluding failed families), re-authorizes (fresh permit), and
  // re-binds the CallIntent to the actually-selected family. A provider
  // failure is not New Information: every attempt supplies the SAME single
  // composite evidenceId, and attempt 1 durably CONSUMES it. Attempts 2..N
  // (attempt > 1) are authorized by that same prior claim — one logical
  // (diff + gate) state authorizes exactly one dispatch SEQUENCE, bounded by
  // the role's candidate count — never a fresh consumption per attempt, and never
  // a fresh dispatch on identical evidence for a first attempt (crash/resume
  // re-call included).
  async function meteredWithFailover({
    spend, role, routeFn, defaultFamily, defaultProvider, operationId, evidenceIds, invoke, workflowId = null,
    // Durable physical-call-audit identity forwarded verbatim into the spend
    // record (round / chunkIndex / chunkTotal; quotaPools is filled in below
    // from the resolved routing selection) — see reviewSpend.js meteredCall.
    auditContext = null,
    // Fired once per PHYSICAL failover attempt that actually reached (or tried
    // to reach) a provider — never for an authorization/spend denial, which
    // never dispatches. Lets the caller build a durable audit trail of every
    // physical attempt (family/provider/quotaPool/outcome), not just the last
    // one that happened to succeed. Success itself is recorded by the caller
    // (it alone sees the raw provider envelope's resolvedModel/usage before
    // meteredCall reduces it to a bare business value).
    onAttempt = null,
  }) {
    const tried = new Set();
    // Effective attempt bound = this role's candidate count, so every
    // DEFAULT_ROLE_POLICY candidate is reachable when each earlier one fails
    // safely. `tried` + a null selection still stop the loop early.
    const maxAttempts = providerAttemptBudget(role);
    let lastErr = null;
    // Resume/continuation: if this exact (role, operationId) already durably
    // CONSUMED its evidence in a prior (crashed) session, this call is not a
    // fresh first attempt — it continues that one authorized dispatch SEQUENCE.
    // Start the bounded attempt counter past 1 so authorize() takes the
    // failover-reuse path, which STILL refuses if any earlier attempt actually
    // reached the provider (non-zero settled usage / open DISPATCHING).
    let startAttempt = 1;
    try {
      const priorClaim = await spend.informationLedger?.findConsumedBy?.({
        workflowId, role, operationId, evidenceIds,
      });
      if (priorClaim) startAttempt = 2;
    } catch { /* treat as a first attempt; authorize() re-checks deterministically */ }
    for (let attempt = startAttempt; attempt < startAttempt + maxAttempts; attempt += 1) {
      let selection = null;
      if (routeFn) {
        // Per-call audit attribution — passed fresh on every call, never
        // stored on the (long-lived, shared-across-loops) router. Built from
        // whatever this specific physical attempt already carries.
        const requestContext = {
          loopId: workflowId ?? null,
          operationId: operationId ?? null,
          attempt,
          round: auditContext?.round ?? null,
          chunkIndex: auditContext?.chunkIndex ?? null,
          chunkTotal: auditContext?.chunkTotal ?? null,
        };
        selection = routeFn({ reworkCycles: attempt - startAttempt }, requestContext);
        if (!selection) break;
        if (tried.has(selection.family)) break;
        tried.add(selection.family);
      }
      const family = selection?.family ?? defaultFamily;
      const provider = selection?.provider ?? defaultProvider;
      try {
        // Fail closed if we no longer hold the loop lease: never start a new
        // paid provider attempt on behalf of a review another owner has taken
        // over. (LeaseLostError is not retryable — it propagates to review().)
        // eslint-disable-next-line no-await-in-loop
        await assertLeaseHeld(workflowId);
        // eslint-disable-next-line no-await-in-loop
        return await spend.meteredCall({
          role, family, provider, model: selection?.model ?? null,
          operationId, attempt, evidenceIds,
          auditContext: auditContext ? { ...auditContext, quotaPools: selection?.quotaPools ?? null } : null,
          call: () => invoke({
            selection, attempt, family, provider,
          }),
        });
      } catch (err) {
        lastErr = err;
        if (isAuthorizationFailure(err)) throw err; // spend/objective denial — never dispatched, never retried
        const code = err?.code ?? err?.providerFailure ?? '';
        onAttempt?.({
          attempt, family, provider, quotaPools: selection?.quotaPools ?? null, outcome: 'FAILURE', code,
        });
        if (!RETRYABLE.has(code)) throw err;
        if (selection && recordProviderFailure) recordProviderFailure(selection, { code });
        // loop -> next attempt re-routes
      }
    }
    throw lastErr ?? new Error(`ReviewLoop: no eligible ${role} provider`);
  }

  async function review({ loopId, signal, onHeartbeat } = {}) {
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
        return await reviewInner({ loopId, signal });
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

  async function reviewInner({ loopId, signal }) {
    // Per-invocation safety-event isolation: start this call with a clean list.
    safetyEvents = [];
    const loopState = await loadLoop(loopId);
    const objective = loopState.objective;

    // Each review GATE gets its own convergence budget (default 3 Reviewer
    // rounds). A phase PHASE_PASS resets gate-local convergence state and keeps
    // the same loop/baseline/task-wide token budget. If any gate exhausts its
    // convergence budget, the whole task stops at HUMAN_REQUIRED.
    if (isTerminal(loopState.state)
      && (loopState.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED || loopState.budgetExhausted)) {
      return terminalResult(loopState);
    }

    if (objective.mode === REVIEW_MODES.PR) return reviewPr({ loopState, signal });
    return reviewLocal({ loopState, signal });
  }

  // ---- Reviewer over full attributed evidence (bounded or chunked) --------
  async function runReviewerOverEvidence({
    spend, loopState, objective, delta, gate, reviewScope = currentReviewScope(loopState, objective), signal,
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
    const deltaGateKey = sha256Hex(`${delta.fingerprint}::${gate.fingerprint}::${reviewScope.fingerprint}`);
    const chunkLayoutHash = sha256Hex(`${chunks.length}::${chunks.map((c) => c.hash).join('::')}`);
    const checkpointKey = sha256Hex(`${deltaGateKey}::${chunkLayoutHash}`);
    const resumeCheckpoint = loopState.chunkReviewCheckpoint;
    if (resumeCheckpoint && resumeCheckpoint.deltaGateKey === deltaGateKey
      && Number.isInteger(resumeCheckpoint.round)) {
      loopState.round = resumeCheckpoint.round;
      loopState.gateRound = Number.isInteger(resumeCheckpoint.gateRound)
        ? resumeCheckpoint.gateRound
        : (loopState.gateRound ?? 0);
    } else {
      loopState.round += 1;
      loopState.gateRound = (loopState.gateRound ?? 0) + 1;
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
        diffHash: sha256Hex(`${chunk.hash}::${gate.fingerprint}::${reviewScope.fingerprint}`),
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
          round: loopState.round,
          chunk: { index: chunk.index, total: chunk.total },
          previousFindings: loopState.lastReview?.blockingFindings ?? [],
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

  // ---- LOCAL mode --------------------------------------------------------
  async function reviewLocal({ loopState, signal }) {
    const objective = loopState.objective;
    const reviewScope = currentReviewScope(loopState, objective);
    const cwd = objective.repository?.root;
    const baseline = objective.baseline;

    let delta = await collectWorkerDeltaFn({ cwd, baseline });

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

    // The verification plan was FROZEN at reviewloop_begin. Use exactly those
    // commands — never re-derive from the (possibly Worker-edited) on-disk
    // config. Only fall back to fresh discovery for a legacy loop persisted
    // before the plan was frozen.
    const frozenPlan = objective.verificationPlan;
    let gateCommands;
    let commandSource;
    if (frozenPlan?.commands?.length) {
      gateCommands = frozenPlan.commands;
      commandSource = `${frozenPlan.source} (frozen at begin)`;
      // A Worker that rewrote `.reviewloop.json` / the `package.json` test
      // script after begin cannot weaken the Gate. Running the frozen command
      // array already defeats a `.reviewloop.json` edit; but a `package.json`
      // plan is the indirection `npm test`, so a rewritten test script would
      // still run. Any manifest drift therefore fails the review closed rather
      // than trusting the Gate: the Worker must revert the config or start a
      // fresh reviewloop_begin.
      try {
        const current = discoverVerificationCommandsFn({ cwd, configured: loopState.verificationCommands });
        if (current?.manifestFingerprint && frozenPlan.manifestFingerprint
          && current.manifestFingerprint !== frozenPlan.manifestFingerprint) {
          collectSafetyEvent({
            code: 'VERIFICATION_PLAN_DRIFT',
            severity: 'BLOCKING',
            role: 'gate',
            taskId: loopState.loopId,
            reason: `the verification config (${frozenPlan.source}) was modified after reviewloop_begin`,
            actionTaken: 'review blocked; frozen Gate cannot be trusted',
          });
          loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
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
      } catch { /* discovery is best-effort here */ }
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
    let gate = await runGateFn({
      cwd, commands: gateCommands, runner: gateRunner, env, signal,
      baselineGateEvidence: trustedBaselineGateEvidence,
    });
      gate.commandSource = commandSource;
      gate.executedCommands = [...gateCommands];
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
    if (postGateFn && !signal?.aborted && gate.verdict !== GATE_VERDICTS.FAIL) {
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
        if (signal?.aborted || gate.verdict === GATE_VERDICTS.FAIL) break; // handled downstream

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

    const fp = reviewFingerprint({
      deltaFingerprint: delta.fingerprint,
      gateFingerprint: gate.fingerprint,
      reviewScopeFingerprint: reviewScope.fingerprint,
    });

    if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === fp) {
      await saveLoop(loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'submitted state is identical to the last review; no Reviewer/Supervisor call made',
        lastReview: compactLastReview(loopState),
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    if (gate.verdict === GATE_VERDICTS.FAIL) {
      // A deterministic Gate FAIL is a repair cycle, NOT a fresh Reviewer
      // round: it never consumes one of the objective's max review rounds and
      // the independent Reviewer has not run. An identical failing (diff+gate)
      // resubmission still deterministically returns NO_PROGRESS (above).
      loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
      loopState.lastReviewedFingerprint = fp;
      loopState.lastGateFingerprint = gate.fingerprint;
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate regression');
      await saveLoop(loopState);
      return {
        ...compactReworkPayload({ loopState, review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 }, gate }),
        reason: 'deterministic Gate failed with a new regression; fix it before Reviewer runs',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    const spend = spendFor(loopState.loopId, objective);
    // The fresh-round increment now lives in runReviewerOverEvidence, bound to
    // the logical (delta + gate) review state so a crash/resume of the same
    // review never consumes an extra round.

    let reviewOut;
    try {
      reviewOut = await runReviewerOverEvidence({
        spend, loopState, objective, delta, gate, reviewScope, signal,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) throw err; // read-only exit in review()
      return spendDenialResult(loopState, err, await spend.telemetry());
    }
    const review = reviewOut.review;
    review.reviewedFingerprint = fp;
    loopState.lastReviewedFingerprint = fp;
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

    const decision = decideConvergence({ loopState, review });
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      { round: loopState.round, gateRound: loopState.gateRound, signatures: review.findingSignatures },
    ];

    let supervisorGuidance = null;
    if (decision.verdict === REVIEW_VERDICTS.REWORK && decision.invokeSupervisor && !loopState.supervisorInvoked) {
      const sup = await runSupervisor({
        spend, loopState, objective, review, gate, reviewScope, signal,
      });
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      const outcome = await applySupervisorOutcome({
        sup, loopState, review, spend, escalationReason: 'non-convergence escalation',
      });
      if (outcome.result) return outcome.result;
      supervisorGuidance = outcome.guidance;
    }

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      const telemetry = await spend.telemetry();
      const phaseResult = completeCurrentPhase(loopState, review, telemetry);
      if (phaseResult) {
        await saveLoop(loopState);
        return phaseResult;
      }
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await saveLoop(loopState);
      return passResult(loopState, review, telemetry);
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      loopState.budgetExhausted = true; // 3 rounds spent, still blocking — terminal
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
    spend, loopState, objective, review, gate, reviewScope = currentReviewScope(loopState, objective), signal,
  }) {
    const physicalCalls = [];
    if (signal?.aborted) {
      return { humanRequired: true, reason: 'the review was cancelled by the caller before the Supervisor ran', physicalCalls };
    }
    const findingsEvidence = await spend.registerEvidence({
      kind: 'findings',
      taskId: `${loopState.loopId}:${reviewScope.id}`,
      signature: review.findingSignatures.join('|') || 'none',
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
        auditContext: { round: loopState.round, chunkIndex: null, chunkTotal: null },
        onAttempt: (a) => physicalCalls.push({
          role: 'supervisor', round: loopState.round, chunkIndex: null, chunkTotal: null,
          attempt: a.attempt, family: a.family, provider: a.provider, quotaPools: a.quotaPools,
          resolvedModel: null, usage: null, outcome: a.outcome, code: a.code,
        }),
        invoke: ({
          selection, attempt, family, provider,
        }) => Promise.resolve(supervisorFn({
          objective, blockingFindings: review.blockingFindings, gate, reviewScope,
          round: loopState.round, priorSignatures: loopState.findingSignatureHistory, selection, signal,
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
    return { guidance: raw.guidance, physicalCalls };
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
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, sup.reason);
      await saveLoop(loopState);
      return { result: humanRequiredResult(loopState, review, await spend.telemetry(), sup.guidance) };
    }
    if (sup.humanRequired) {
      loopState.supervisorInvoked = false; // transient — let a later round retry
      collectSafetyEvent({
        code: 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE', severity: 'NON_BLOCKING', role: 'supervisor',
        taskId: loopState.loopId, reason: sup.reason,
        actionTaken: 'Supervisor guidance skipped; proceeding as a plain REWORK round',
      });
      return { guidance: null };
    }
    recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
    loopState.lastSupervisorGuidance = sup.guidance;
    return { guidance: sup.guidance };
  }

  // One physical provider attempt, shaped for the durable audit. `usage` is
  // the raw provider envelope (never re-derived/estimated) — null on a
  // failed/pre-dispatch attempt, present on a settled success.
  function physicalCallAuditEntry(pc) {
    return {
      role: pc.role ?? null,
      family: pc.family ?? null,
      provider: pc.provider ?? null,
      quotaPools: pc.quotaPools ?? null,
      resolvedModel: pc.resolvedModel ?? null,
      attempt: pc.attempt ?? null,
      round: pc.round ?? null,
      chunkIndex: pc.chunkIndex ?? null,
      chunkTotal: pc.chunkTotal ?? null,
      outcome: pc.outcome ?? null,
      code: pc.code ?? null,
      usage: pc.usage ?? null,
    };
  }

  // ---- durable audit record ------------------------------------------
  // One recoverable, tamper-evident entry per PR review round. Its fingerprint
  // covers every load-bearing identity for "which PR snapshot did this round
  // review": repository, prNumber, baseSha, reviewedHeadSha.
  function appendAuditRecord({
    loopState, objective, delta, gate, review, decision, telemetry,
    observedHeadSha, finalObservedHeadSha, headStillCurrent, result,
    supervisorPhysicalCalls = [],
    reviewScope = currentReviewScope(loopState, objective),
  }) {
    const target = {
      type: 'PR',
      repository: objective.repository?.name ?? null,
      prNumber: objective.prNumber,
      baseSha: objective.prBaseSha ?? null,
      mergeBase: delta?.mergeBase ?? null,
      reviewedHeadSha: observedHeadSha ?? null,
      finalObservedHeadSha: finalObservedHeadSha ?? null,
      headStillCurrent: headStillCurrent === true,
      // Structural proof the Gate ran against the SAME exact snapshot the
      // Reviewer's evidence was bound to (prWorktree.js tags this on the
      // gate result right after it runs inside the isolated worktree).
      gateRanOnReviewedHead: gate?.reviewedSnapshotHeadSha != null
        && gate.reviewedSnapshotHeadSha === observedHeadSha,
    };
    const record = {
      loopId: loopState.loopId,
      round: loopState.round,
      startedAt: loopState.updatedAt ?? loopState.createdAt ?? null,
      completedAt: new Date().toISOString(),
      target,
      targetFingerprint: sha256Hex(JSON.stringify({
        repository: target.repository,
        prNumber: target.prNumber,
        baseSha: target.baseSha,
        reviewedHeadSha: target.reviewedHeadSha,
      })),
      reviewScope: {
        type: reviewScope?.type ?? 'task',
        id: reviewScope?.id ?? 'task',
        fingerprint: reviewScope?.fingerprint ?? null,
      },
      objective: {
        goal: objective.goal,
        constraints: objective.constraints ?? [],
        blockingSeverities: objective.blockingSeverities ?? [],
        maxReviewRounds: objective.maxReviewRounds,
        fingerprint: objective.fingerprint,
      },
      gate: gate ? {
        commands: gate.executedCommands ?? objective.verificationPlan?.commands ?? [],
        commandSource: gate.commandSource ?? null,
        fingerprint: gate.fingerprint ?? null,
        verdict: gate.verdict ?? null,
      } : null,
      review: review ? {
        // Logical pool identity — the Worker-facing abstraction never changes.
        reviewer: 'internal pool',
        status: review.status,
        blockingFindings: review.blockingFindings?.length ?? 0,
        findingSignatures: review.findingSignatures ?? [],
        // Every PHYSICAL Reviewer attempt bound to this exact reviewedHeadSha:
        // role, family, provider, quotaPool, resolvedModel, attempt, round,
        // chunk index/total, outcome, usage. Never collapsed to one abstract
        // "internal" entry — a failover/chunked round keeps every attempt.
        physicalCalls: (review.physicalCalls ?? []).map((pc) => physicalCallAuditEntry(pc)),
      } : null,
      supervisor: {
        invoked: loopState.supervisorInvoked === true,
        guidance: loopState.lastSupervisorGuidance ?? null,
        physicalCalls: (supervisorPhysicalCalls ?? []).map((pc) => physicalCallAuditEntry(pc)),
      },
      spend: telemetry ?? null,
      convergence: decision ? { verdict: decision.verdict, reason: decision.reason } : null,
      result,
    };
    loopState.audit = [...(loopState.audit ?? []), record];
    return record;
  }

  // Optional audit publication back to the PR. Opt-in via
  // REVIEWLOOP_PUBLISH_PR_RESULT=1. NEVER changes the verdict — a publication
  // failure is recorded as a safety event and nothing else.
  async function maybePublishPrResult({
    loopState, objective, result, review, headSha, telemetry,
  }) {
    if (String(env?.REVIEWLOOP_PUBLISH_PR_RESULT ?? '') !== '1') return;
    if (!prBackend || typeof prBackend.publishResult !== 'function') return;
    const body = [
      `ReviewLoop ${result}`,
      '',
      `PR: #${objective.prNumber}`,
      `Reviewed base: ${objective.prBaseSha ?? '(unknown)'}`,
      `Reviewed head: ${headSha}`,
      `Final HEAD check: ${result === 'PASS' ? 'MATCH' : 'see loop state'}`,
      '',
      'Reviewer: internal Reviewer pool',
      `Rounds: ${loopState.round}`,
      `Blocking findings: ${review?.blockingFindings?.length ?? 0}`,
      `usageVolume: ${telemetry?.usageVolume ?? 'n/a'}`,
      '',
      `ReviewLoop ID: ${loopState.loopId}`,
    ].join('\n');
    try {
      await prBackend.publishResult({ prNumber: objective.prNumber, body });
    } catch (err) {
      collectSafetyEvent({
        code: 'REVIEWLOOP_PR_RESULT_PUBLICATION_FAILED', severity: 'NON_BLOCKING', role: 'pr-target',
        taskId: loopState.loopId, reason: String(err?.message ?? err),
        actionTaken: 'result verdict unchanged; publication failure recorded only',
      });
    }
  }

  async function prHumanRequired(loopState, reason) {
    recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, reason);
    await saveLoop(loopState);
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      gateRound: loopState.gateRound ?? loopState.round,
      reason,
      blockingFindings: loopState.lastReview?.blockingFindings ?? [],
      telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
    };
  }

  // ---- PR mode: ONE unified review engine over the PR base->HEAD delta ----
  // Snapshot-correctness invariant, asserted right before a PR round is
  // allowed to PASS. Every one of these must be POSITIVELY known-true; any
  // UNKNOWN/mismatch refuses PASS (never certifies on a best-effort basis):
  //   - repository identity was proven at reviewloop_begin
  //   - the Reviewer's evidence is bound to this exact reviewedHeadSha
  //   - the Gate ran inside the isolated worktree for this exact HEAD
  //   - the live PR HEAD, re-read just now, is still this exact HEAD
  function prPassInvariantFailure({
    objective, delta, gate, observedHead, finalHead,
  }) {
    if (!objective.repository?.name) return 'repository identity is not known (reviewloop_begin should have refused to register this loop)';
    if (!delta || delta.reviewedHeadSha !== observedHead) return 'Reviewer evidence is not bound to the exact reviewed HEAD';
    if (!gate || gate.reviewedSnapshotHeadSha !== observedHead) return 'the deterministic Gate did not run inside the exact-HEAD snapshot worktree';
    if (!finalHead || finalHead !== observedHead) return 'the live PR HEAD does not match the reviewed HEAD';
    return null;
  }

  // Build the exact PR snapshot for ONE round and run the Gate + collect the
  // Reviewer's evidence INSIDE it — Gate execution, the verification-manifest
  // drift check, and the diff identity all run against the SAME isolated
  // worktree checked out at `headSha`, never the user's own ambient cwd. The
  // worktree is guaranteed torn down (success or failure) before this
  // resolves — see prWorktree.js.
  async function buildPrRoundEvidence({
    loopState, objective, cwd, prNumber, headSha, signal,
  }) {
    return buildPrSnapshotFn({
      cwd, baseSha: objective.prBaseSha, headSha, prNumber,
    }, async ({ worktreeDir, mergeBase }) => {
      const delta = await collectPrDeltaFn({ cwd: worktreeDir, mergeBase, headSha });
      if (delta.evidenceComplete === false) {
        return { kind: 'HUMAN_REQUIRED', reason: `cannot construct a trustworthy PR delta: ${(delta.incompleteReasons ?? []).join('; ')}` };
      }
      if (delta.noWorkerChangeYet) return { kind: 'NO_PROGRESS' };

      // The FROZEN deterministic Gate (same plan as a LOCAL target) — but the
      // drift check compares against THIS worktree, the exact snapshot being
      // reviewed, never the user's ambient cwd (which may be on another
      // branch, dirty, or simply irrelevant to this PR).
      const frozenPlan = objective.verificationPlan;
      let gateCommands;
      let commandSource;
      if (frozenPlan?.commands?.length) {
        gateCommands = frozenPlan.commands;
        commandSource = `${frozenPlan.source} (frozen at begin)`;
        try {
          const current = discoverVerificationCommandsFn({ cwd: worktreeDir, configured: loopState.verificationCommands });
          if (current?.manifestFingerprint && frozenPlan.manifestFingerprint
            && current.manifestFingerprint !== frozenPlan.manifestFingerprint) {
            return { kind: 'DRIFT' };
          }
        } catch { /* discovery is best-effort here */ }
      } else {
        const discovered = discoverVerificationCommandsFn({ cwd: worktreeDir, configured: loopState.verificationCommands });
        gateCommands = discovered.commands;
        commandSource = discovered.source;
      }
      const prReviewScope = currentReviewScope(loopState, objective);
      const baseGateCommandCount = gateCommands?.length ?? 0;
      gateCommands = mergeScopedGateCommands(gateCommands, prReviewScope);
      if (gateCommands.length > baseGateCommandCount) {
        commandSource = `${commandSource} + frozen ${prReviewScope.id} verification`;
      }

      // Capture the exact worktree state BEFORE the Gate runs. PR evidence
      // must correspond to the exact commit already pushed — unlike LOCAL,
      // there is no "adopt the Gate's own edits and re-run until it
      // stabilises" option here (that would mean certifying bytes that were
      // never pushed to the PR). If the Gate cannot be proven not to have
      // mutated this snapshot, the snapshot is not certifiable, full stop.
      const preGateState = await captureWorktreeSnapshotFn({ worktreeDir });
      if (!preGateState.ok) {
        return { kind: 'HUMAN_REQUIRED', reason: `cannot capture the PR snapshot's pre-Gate state: ${preGateState.reason}` };
      }

      const gate = await runGateFn({
        cwd: worktreeDir, commands: gateCommands, runner: gateRunner, env, signal,
      });
      gate.commandSource = commandSource;

      const postGateState = await captureWorktreeSnapshotFn({ worktreeDir });
      if (!postGateState.ok) {
        return { kind: 'HUMAN_REQUIRED', reason: `cannot verify the PR snapshot's post-Gate state: ${postGateState.reason}` };
      }
      if (worktreeSnapshotMutated(preGateState, postGateState)) {
        // Gate mutated snapshot => snapshot not certifiable. Never set
        // reviewedSnapshotHeadSha here — it is NOT proven — and never let the
        // Reviewer see evidence collected against a tree the Gate then
        // changed underneath it.
        return { kind: 'GATE_MUTATED_SNAPSHOT', delta, gate };
      }

      // Structural proof this Gate ran inside the exact-HEAD snapshot AND
      // left it byte-identical to that HEAD — asserted ONLY once cleanliness
      // is proven. The pre-PASS invariant check and the durable audit both
      // key off this.
      gate.reviewedSnapshotHeadSha = headSha;

      if (gate.verdict === GATE_VERDICTS.FAIL) return { kind: 'GATE_FAIL', delta, gate };
      return {
        kind: 'READY', delta, gate,
      };
    });
  }

  async function reviewPr({ loopState, signal }) {
    const objective = loopState.objective;
    const reviewScope = currentReviewScope(loopState, objective);
    const cwd = objective.repository?.root;
    const prNumber = objective.prNumber;
    const MAX_HEAD_REBIND = 4;

    for (let rebind = 0; rebind < MAX_HEAD_REBIND; rebind += 1) {
      await assertLeaseHeld(loopState.loopId);

      // 1. Live PR HEAD. FAIL CLOSED — an inability to prove which commit is
      //    currently HEAD must never fall back to a cached SHA.
      let observedHead;
      try {
        observedHead = await prBackend.getPrHead({ prNumber, cwd });
      } catch (err) {
        return prHumanRequired(loopState, `cannot resolve the live PR HEAD: ${err?.message ?? err}`);
      }
      if (!observedHead) return prHumanRequired(loopState, `cannot resolve the live HEAD for PR #${prNumber}`);

      // 2. Local fix not pushed: HEAD unchanged since a prior actionable review.
      if (loopState.lastReviewedPrHead === observedHead
        && loopState.lastReview?.status === 'ACTIONABLE') {
        await saveLoop(loopState);
        return {
          status: 'PUSH_REQUIRED', loopId: loopState.loopId, head: observedHead,
          reason: 'PR HEAD unchanged since the last review; push your fix, then call reviewloop_review',
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }

      recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'PR review requested');

      // 3+4. Exact PR snapshot: the Reviewer's diff identity AND the
      // deterministic Gate both run inside ONE isolated worktree checked out
      // at `observedHead`, torn down before this resolves.
      let snap;
      try {
        snap = await buildPrRoundEvidence({
          loopState, objective, cwd, prNumber, headSha: observedHead, signal,
        });
      } catch (err) {
        if (err instanceof PrSnapshotError) {
          return prHumanRequired(loopState, `cannot build an exact PR snapshot worktree: ${err.message}`);
        }
        throw err;
      }

      if (snap.kind === 'HUMAN_REQUIRED') return prHumanRequired(loopState, snap.reason);
      if (snap.kind === 'NO_PROGRESS') {
        await saveLoop(loopState);
        return {
          status: 'NO_PROGRESS', loopId: loopState.loopId, round: loopState.round,
          head: observedHead,
          reason: 'the PR has no reviewable base->HEAD change',
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }
      if (snap.kind === 'DRIFT') {
        collectSafetyEvent({
          code: 'VERIFICATION_PLAN_DRIFT', severity: 'BLOCKING', role: 'gate',
          taskId: loopState.loopId,
          reason: `the verification config (${objective.verificationPlan?.source}) drifted from the frozen plan in the reviewed PR snapshot`,
          actionTaken: 'review blocked; frozen Gate cannot be trusted',
        });
        loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
        recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'verification plan drift');
        await saveLoop(loopState);
        return {
          ...compactReworkPayload({
            loopState,
            review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 },
            gate: { verdict: 'FAIL', failureIdentities: ['verification-plan-drift'] },
          }),
          head: observedHead,
          reason: 'the verification configuration in the reviewed PR snapshot no longer matches the plan frozen at reviewloop_begin; revert it or start a new reviewloop_begin',
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }
      if (snap.kind === 'GATE_MUTATED_SNAPSHOT') {
        collectSafetyEvent({
          code: 'GATE_MUTATED_PR_SNAPSHOT', severity: 'BLOCKING', role: 'gate',
          taskId: loopState.loopId,
          reason: 'the deterministic Gate modified tracked or untracked files inside the exact reviewed PR '
            + 'HEAD snapshot (a formatter, codegen step, or snapshot updater ran)',
          actionTaken: 'review blocked; Reviewer not invoked; reviewedSnapshotHeadSha not asserted for this HEAD',
        });
        loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
        recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate mutated pr snapshot');
        await saveLoop(loopState);
        return {
          ...compactReworkPayload({
            loopState,
            review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 },
            gate: { verdict: 'FAIL', failureIdentities: ['gate-mutated-pr-snapshot'] },
          }),
          head: observedHead,
          reason: 'the deterministic Gate modified files inside the exact reviewed PR snapshot (formatter / '
            + 'codegen / snapshot updater); run that step yourself, commit its output, and push before '
            + 'calling reviewloop_review again — a snapshot the Gate itself changed can never be certified',
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }

      const { delta } = snap;
      let { gate } = snap;

      if (signal?.aborted) {
        return prHumanRequired(loopState, 'the review was cancelled by the caller before the Reviewer ran');
      }

      const fp = reviewFingerprint({
        deltaFingerprint: delta.fingerprint,
        gateFingerprint: gate.fingerprint,
        reviewScopeFingerprint: reviewScope.fingerprint,
      });
      if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === fp) {
        await saveLoop(loopState);
        return {
          status: 'NO_PROGRESS', loopId: loopState.loopId, round: loopState.round,
          head: observedHead,
          reason: 'submitted PR state is identical to the last review; no Reviewer/Supervisor call made',
          lastReview: compactLastReview(loopState),
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }

      if (snap.kind === 'GATE_FAIL') {
        loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
        loopState.lastReviewedFingerprint = fp;
        loopState.lastGateFingerprint = gate.fingerprint;
        loopState.lastReviewedPrHead = observedHead;
        recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate regression');
        await saveLoop(loopState);
        return {
          ...compactReworkPayload({ loopState, review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 }, gate }),
          head: observedHead,
          reason: 'deterministic Gate failed with a regression; fix it before the Reviewer runs',
          telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
        };
      }

      const spend = spendFor(loopState.loopId, objective);
      let reviewOut;
      try {
        reviewOut = await runReviewerOverEvidence({
          spend, loopState, objective, delta, gate, reviewScope, signal,
        });
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        return spendDenialResult(loopState, err, await spend.telemetry());
      }
      const review = reviewOut.review;
      review.reviewedFingerprint = fp;
      review.reviewedHead = observedHead;
      loopState.lastReviewedFingerprint = fp;
      loopState.lastGateFingerprint = gate.fingerprint;
      loopState.lastReviewedPrHead = observedHead;
      loopState.lastReview = review;
      loopState.chunkReviewCheckpoint = null;

      if (review.status === 'FAILED') {
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, review.error?.reason ?? 'pr review failed');
        await saveLoop(loopState);
        return {
          status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round, head: observedHead,
          reason: `Reviewer did not produce a usable result (${review.error?.reason}): ${review.error?.message ?? ''}`,
          telemetry: await spend.telemetry(), safetyEvents,
        };
      }

      const decision = decideConvergence({ loopState, review });
      loopState.findingSignatureHistory = [
        ...(loopState.findingSignatureHistory ?? []),
        { round: loopState.round, gateRound: loopState.gateRound, signatures: review.findingSignatures },
      ];

      let supervisorGuidance = null;
      let supervisorPhysicalCalls = [];
      if (decision.verdict === REVIEW_VERDICTS.REWORK && decision.invokeSupervisor && !loopState.supervisorInvoked) {
        const sup = await runSupervisor({
          spend, loopState, objective, review, gate, reviewScope, signal,
        });
        supervisorPhysicalCalls = sup.physicalCalls ?? [];
        if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
        const outcome = await applySupervisorOutcome({
          sup, loopState, review, spend, escalationReason: 'PR non-convergence escalation',
        });
        if (outcome.result) return outcome.result;
        supervisorGuidance = outcome.guidance;
      }

      const telemetry = await spend.telemetry();

      if (decision.verdict === REVIEW_VERDICTS.PASS) {
        // 5. Exact-HEAD recheck. Re-read the live PR HEAD; only PASS when it is
        //    still the exact SHA this round reviewed. A moved HEAD is never
        //    certified by a stale review — rebind and re-review it (bounded).
        let finalHead;
        try {
          finalHead = await prBackend.getPrHead({ prNumber, cwd });
        } catch (err) {
          return prHumanRequired(loopState, `could not re-confirm the live PR HEAD before PASS: ${err?.message ?? err}`);
        }
        if (!finalHead) return prHumanRequired(loopState, 'could not re-confirm the live PR HEAD before PASS');
        if (finalHead !== observedHead) {
          collectSafetyEvent({
            code: 'REVIEWLOOP_PR_HEAD_MOVED_DURING_REVIEW', severity: 'NON_BLOCKING', role: 'pr-target',
            taskId: loopState.loopId,
            reason: `PR HEAD moved from ${observedHead} to ${finalHead} during the review`,
            actionTaken: 'stale review not certified; re-reviewing the new HEAD',
          });
          appendAuditRecord({
            loopState, objective, delta, gate, review, decision, telemetry, supervisorPhysicalCalls,
            observedHeadSha: observedHead, finalObservedHeadSha: finalHead,
            headStillCurrent: false, result: 'REWORK',
          });
          loopState.lastReviewedFingerprint = null; // allow a fresh review of the new HEAD
          await saveLoop(loopState);
          continue;
        }
        // Explicit correctness invariant — every load-bearing fact must be
        // POSITIVELY known-true, never assumed, right before certifying PASS.
        const invariantFailure = prPassInvariantFailure({
          objective, delta, gate, observedHead, finalHead,
        });
        if (invariantFailure) {
          return prHumanRequired(loopState, `PR PASS invariant not satisfied: ${invariantFailure}`);
        }
        const isPhasePass = reviewScope.type === 'phase';
        appendAuditRecord({
          loopState, objective, delta, gate, review, decision, telemetry, supervisorPhysicalCalls,
          observedHeadSha: observedHead, finalObservedHeadSha: finalHead,
          headStillCurrent: true, result: isPhasePass ? 'PHASE_PASS' : 'PASS',
          reviewScope,
        });
        if (isPhasePass) {
          const phaseResult = completeCurrentPhase(loopState, review, telemetry, { head: observedHead });
          await saveLoop(loopState);
          return phaseResult;
        }
        recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
        await saveLoop(loopState);
        await maybePublishPrResult({
          loopState, objective, result: 'PASS', review, headSha: observedHead, telemetry,
        });
        return passResult(loopState, review, telemetry);
      }

      if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
        loopState.budgetExhausted = true;
        appendAuditRecord({
          loopState, objective, delta, gate, review, decision, telemetry, supervisorPhysicalCalls,
          observedHeadSha: observedHead, finalObservedHeadSha: observedHead,
          headStillCurrent: true, result: 'HUMAN_REQUIRED',
        });
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
        await saveLoop(loopState);
        await maybePublishPrResult({
          loopState, objective, result: 'HUMAN_REQUIRED', review, headSha: observedHead, telemetry,
        });
        return humanRequiredResult(loopState, review, telemetry, supervisorGuidance);
      }

      appendAuditRecord({
        loopState, objective, delta, gate, review, decision, telemetry, supervisorPhysicalCalls,
        observedHeadSha: observedHead, finalObservedHeadSha: observedHead,
        headStillCurrent: true, result: 'REWORK',
      });
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
      await saveLoop(loopState);
      await maybePublishPrResult({
        loopState, objective, result: 'REWORK', review, headSha: observedHead, telemetry,
      });
      return {
        ...compactReworkPayload({ loopState, review, gate, supervisorGuidance }),
        head: observedHead,
        reason: `${decision.reason}; push your fix so ReviewLoop reviews the new HEAD`,
        telemetry, safetyEvents,
      };
    }

    // The PR HEAD kept moving faster than one review round.
    recordTransition(loopState, REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, 'PR HEAD kept moving');
    await saveLoop(loopState);
    return {
      status: 'WAITING_FOR_REVIEW', loopId: loopState.loopId, round: loopState.round,
      reason: 'the PR HEAD kept changing during the review; let it settle, then call reviewloop_review again',
      telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
    };
  }

  // ---- result shaping ------------------------------------------------
  function passResult(loopState, review, telemetry) {
    return {
      status: 'PASS', loopId: loopState.loopId, round: loopState.round, gateRound: loopState.gateRound,
      reviewer: review.reviewer,
      nonBlockingFindings: review.nonBlockingFindings, nonBlockingOmitted: review.nonBlockingOmitted ?? 0,
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  function humanRequiredResult(loopState, review, telemetry, supervisorGuidance) {
    const budgetExhausted = loopState.budgetExhausted === true;
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      // This HUMAN_REQUIRED is TERMINAL — the loop's review-round budget is
      // spent. The Worker must report to the user and stop: not another
      // reviewloop_review on this loop, not a fresh reviewloop_begin in the
      // same task. A new user instruction starts a new task and a new budget.
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
