// Frozen task initialization. Dependencies are injected from the controller boundary.
import { randomUUID } from 'node:crypto';
import { createReviewObjective, normalizePhasePlan, assertResumeTaskDefinitionBound, REVIEW_MODES } from './objective.js';
import { initialLoopState } from './state.js';
import { assertContractHandoff, normalizeEvidenceRequirements } from './contractEvidence.js';
import { sha256Hex, phasesOf, currentReviewScope } from './phaseState.js';

function compactBaselineSummary(baseline) {
  return {
    head: baseline.head,
    dirtyFileCount: baseline.dirtyFiles?.length ?? 0,
    evidenceComplete: baseline.evidenceComplete !== false,
  };
}

export function createBeginTask({ clock, captureBaselineFn, discoverVerificationCommandsFn, runGateFn, gateRunner, env, store, onEvent }) {
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

  return begin;
}
