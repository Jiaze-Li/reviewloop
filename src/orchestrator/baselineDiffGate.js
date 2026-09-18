// BASELINE-DIFF GATE.
//
// A Task Card's verification_commands are run TWICE:
//
//   1. baseline  — in the isolated workspace, with the Task baseline fixed,
//                  BEFORE the Executor's first modification.
//   2. current   — by the Gate, after the Executor finished.
//
// Pre-existing / out-of-scope repository failures (red tests that were already
// failing before this Task touched anything) must not be attributed to the
// current Task and must not trigger an Executor REWORK. Only failures the
// current Task actually introduced —
//
//   newFailures = currentFailures - baselineFailures
//
// — are the current Task's responsibility.
//
// The comparison is on NORMALIZED FAILURE IDENTITY (failing test / assertion
// names), never on bare exit codes. When a failing command produced no
// parseable failure identity on either side, the comparison is not reliable
// and this module refuses to suppress anything: the original Gate FAIL
// behaviour stands.

import { collectFailureIdentities } from './gateFailureIdentity.js';

export const BASELINE_DIFF_VERDICTS = Object.freeze({
  // The current run has no failing verification commands at all.
  PASS: 'PASS',
  // The current run has failures, every one is a pre-existing baseline
  // failure, and the Task introduced none -> treat as PASS for this Task.
  PASS_WITH_BASELINE_FAILURES: 'PASS_WITH_BASELINE_FAILURES',
  // The current run has failures the baseline did NOT have -> FAIL, but only
  // the new failures are attributed to this Task.
  NEW_FAILURES: 'NEW_FAILURES',
  // A failing command could not be reliably compared (no parseable failure
  // identity on one/both sides). Conservative: keep the original Gate FAIL.
  UNRELIABLE: 'UNRELIABLE',
});

// diffBaselineFailures(baselineEvidence, currentEvidence) -> {
//   verdict,
//   baselineFailures: string[],
//   currentFailures: string[],
//   newFailures: string[],
//   ignoredBaselineFailures: string[],   // baseline failures still present now
//   unreliableCommands: string[],
//   comparable: boolean,
// }
//
// `baselineEvidence` may be null/absent (baseline never captured, or a resume
// on an already-modified worktree): the result is then UNRELIABLE unless the
// current run passed outright.
export function diffBaselineFailures(baselineEvidence, currentEvidence) {
  const currentPass = currentEvidence?.pass === true
    || !(Array.isArray(currentEvidence?.results) ? currentEvidence.results : []).some((r) => r && r.pass !== true);

  if (currentPass) {
    return {
      verdict: BASELINE_DIFF_VERDICTS.PASS,
      baselineFailures: [],
      currentFailures: [],
      newFailures: [],
      ignoredBaselineFailures: [],
      unreliableCommands: [],
      comparable: true,
    };
  }

  const current = collectFailureIdentities(currentEvidence);

  // No baseline to compare against -> cannot prove anything is pre-existing.
  if (!baselineEvidence || !Array.isArray(baselineEvidence.results)) {
    return {
      verdict: BASELINE_DIFF_VERDICTS.UNRELIABLE,
      baselineFailures: [],
      currentFailures: current.identities,
      newFailures: current.identities,
      ignoredBaselineFailures: [],
      unreliableCommands: current.unreliableCommands,
      comparable: false,
    };
  }

  const baseline = collectFailureIdentities(baselineEvidence);

  // A failing current command with no parseable identity — OR a current
  // command whose matching baseline command also failed unreliably — cannot
  // be diffed. Refuse to suppress; the caller keeps the original Gate FAIL.
  let comparable = current.reliable;
  for (const [command, info] of current.byCommand) {
    if (!info.reliable) { comparable = false; continue; }
    const baseInfo = baseline.byCommand.get(command);
    if (baseInfo && !baseInfo.reliable) comparable = false;
  }

  if (!comparable) {
    return {
      verdict: BASELINE_DIFF_VERDICTS.UNRELIABLE,
      baselineFailures: baseline.identities,
      currentFailures: current.identities,
      newFailures: current.identities.filter((id) => !baseline.identities.includes(id)),
      ignoredBaselineFailures: [],
      unreliableCommands: [...new Set([...current.unreliableCommands, ...baseline.unreliableCommands])].sort(),
      comparable: false,
    };
  }

  // Baseline suppression is COMMAND-LOCAL, never a union across the
  // whole Gate. A current failing command that did not itself fail at baseline
  // is new by definition, even if another baseline command happened to emit
  // the same test/assertion identity. This matters for phase-local verification:
  // those commands are appended only at phase review time and therefore have
  // no begin-time baseline execution to suppress against.
  const newFailureSet = new Set();
  const ignoredBaselineFailureSet = new Set();
  for (const [command, info] of current.byCommand) {
    const baseInfo = baseline.byCommand.get(command);
    if (!baseInfo) {
      for (const id of info.identities) newFailureSet.add(id);
      continue;
    }
    const baseIds = new Set(baseInfo.identities);
    for (const id of info.identities) {
      if (baseIds.has(id)) ignoredBaselineFailureSet.add(id);
      else newFailureSet.add(id);
    }
  }

  const newFailures = [...newFailureSet].sort();
  const ignoredBaselineFailures = [...ignoredBaselineFailureSet].sort();

  return {
    verdict: newFailures.length === 0
      ? BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES
      : BASELINE_DIFF_VERDICTS.NEW_FAILURES,
    baselineFailures: baseline.identities,
    currentFailures: current.identities,
    newFailures,
    ignoredBaselineFailures,
    unreliableCommands: [],
    comparable: true,
  };
}

// Trim a gate-evidence-shaped object down to what the baseline diff needs, so
// a captured baseline can be persisted into workflow state / a checkpoint
// without carrying megabytes of command output. Failing-command output is
// kept (capped) because that is where the failure identities live; passing
// commands keep only their shape.
export function summarizeBaselineEvidence(evidence, { maxFailingOutput = 20000 } = {}) {
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  return {
    pass: evidence?.pass === true,
    results: results.map((r) => {
      const failing = r && r.pass !== true;
      const output = typeof r?.output === 'string' ? r.output : '';
      return {
        command: typeof r?.command === 'string' ? r.command : '',
        pass: r?.pass === true,
        ...(Number.isFinite(r?.exitCode) ? { exitCode: r.exitCode }
          : Number.isFinite(r?.exit_code) ? { exitCode: r.exit_code }
            : Number.isFinite(r?.code) ? { exitCode: r.code } : {}),
        output: failing ? output.slice(0, maxFailingOutput) : '',
      };
    }),
  };
}
