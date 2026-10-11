// Human-facing resume helper: turn a durable loop into a prompt that a FRESH
// Worker session can be given to continue the SAME loop. ReviewLoop never
// restarts or spawns a Worker (D1); this only tells the next one exactly where
// the loop stands. Pure functions - the CLI does the I/O.

const FINISHED = new Set(['PASS', 'FAILED', 'STOPPED']);
const retiredPr = (loop) => loop?.objective?.mode === 'PR';

export function isResumable(loop) {
  if (!loop || typeof loop !== 'object' || !loop.loopId || !loop.state || retiredPr(loop)) return false;
  if (FINISHED.has(loop.state)) return false;
  // A spent convergence budget is a human decision (reopen-gate), not a resume.
  return !(loop.state === 'HUMAN_REQUIRED' && loop.budgetExhausted === true);
}

export function needsReopen(loop) {
  return !retiredPr(loop) && loop?.state === 'HUMAN_REQUIRED' && loop?.budgetExhausted === true;
}

// Every unfinished loop of one repository that the CLI should mention: ones a
// fresh Worker can continue AND ones that first need a human reopen-gate.
export function unfinishedLoopsFor(loops, repositoryRoot) {
  return loops
    .filter((loop) => (isResumable(loop) || needsReopen(loop)) && loop.objective?.repository?.root === repositoryRoot)
    .sort((a, b) => String(b.loopId).localeCompare(String(a.loopId)));
}

// Loops for one repository, newest first (loop ids embed their creation time).
export function resumableLoopsFor(loops, repositoryRoot) {
  return loops
    .filter((loop) => isResumable(loop) && loop.objective?.repository?.root === repositoryRoot)
    .sort((a, b) => String(b.loopId).localeCompare(String(a.loopId)));
}

function bullets(items, indent = '  ') {
  return (items ?? []).filter(Boolean).map((v) => `${indent}- ${v}`);
}

export function buildResumePrompt(loop) {
  if (retiredPr(loop)) throw new Error('ReviewLoop PR session retired; use claude-review-bot.');
  const objective = loop.objective ?? {};
  const phases = Array.isArray(objective.phases) ? objective.phases : [];
  const done = (loop.completedPhases ?? []).map((p) => p.id);
  const index = Number.isInteger(loop.currentPhaseIndex) ? loop.currentPhaseIndex : null;
  const current = index != null && index < phases.length ? phases[index] : null;
  const atFinal = phases.length > 0 && index != null && index >= phases.length;

  const lines = [
    `Continue the existing ReviewLoop task. Do NOT call reviewloop_begin and do NOT start a new loop.`,
    '',
    `loopId: ${loop.loopId}`,
    `repository: ${objective.repository?.root ?? '(unknown)'}`,
    `goal: ${String(objective.goal ?? '').slice(0, 400)}`,
    `loop state: ${loop.state}`,
  ];

  if (phases.length) {
    lines.push(`phases completed: ${done.length ? done.join(', ') : '(none)'} of ${phases.map((p) => p.id).join(', ')}`);
  }
  if (current) {
    lines.push('', `CURRENT PHASE: ${current.id}${current.title ? ` - ${current.title}` : ''}`, `objective: ${current.objective}`, 'exit criteria:');
    lines.push(...bullets(current.exitCriteria));
    if ((current.verificationCommands ?? []).length) {
      lines.push('verification commands:', ...bullets(current.verificationCommands));
    }
    const inherited = phases.slice(0, index).flatMap((p) => p.carryForwardInvariants ?? []);
    if (inherited.length) lines.push('invariants from completed phases that must still hold:', ...bullets(inherited));
  } else if (atFinal) {
    lines.push('', 'All phases passed. The next step is the FINAL whole-task gate: call reviewloop_review once more; do not report completion before it returns PASS.');
  }

  const findings = loop.lastReview?.blockingFindings ?? [];
  if (loop.state === 'REWORK' && findings.length) {
    lines.push('', 'The last review returned these blocking findings; fix them first:');
    lines.push(...bullets(findings.map((f) => `${f.severity ?? '?'} ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title ?? ''}`.trim())));
  }
  if (loop.supervisorInvoked && loop.lastSupervisorGuidance) {
    lines.push('', `Supervisor guidance for this gate: ${String(loop.lastSupervisorGuidance).slice(0, 1500)}`);
  }
  if ((objective.constraints ?? []).length) lines.push('', 'global constraints:', ...bullets(objective.constraints, ''));

  // Never truncated: contractText is already bounded at begin (64 KiB), and a
  // fresh Worker has no other way to retrieve the acceptance criteria.
  const contract = String(objective.contractText ?? '');
  if (contract) lines.push('', 'FROZEN CONTRACT (authoritative, complete):', contract);

  lines.push(
    '',
    'First inspect the repository (git status / git diff) to see what is already done. Then continue the current phase,',
    'run its verification commands yourself, `git add` any new files (staging only; do not commit unless authorized),',
    `and call reviewloop_review with loopId ${loop.loopId}. Report each result as: status, nextDiffScope, usageVolume.`,
  );
  return lines.join('\n');
}
