// Final-gate diff reduction for phased LOCAL tasks.
//
// Invariant preserved: a PASS means every changed line was covered by an
// independent Reviewer call. A cumulative diff too large for one final review
// used to stop the loop outright. A file changed in exactly ONE phase had all
// of its changes reviewed at that phase's gate, so the final gate may omit it,
// provided nothing touched it afterwards. The final gate still reviews, in full:
//   - every file changed in two or more phases (cross-phase interaction),
//   - every file changed since the last PHASE_PASS boundary,
//   - every changed file no phase gate recorded.
// The reduction is all-or-nothing: if the diff cannot be split into exactly one
// unit per changed file it returns null and the caller keeps the old behaviour.

const UNTRACKED = /^--- Worker untracked file (.+) \(\d+ bytes\) ---$/;
const DELETED = /^--- Worker deleted pre-existing untracked file (.+) ---$/;

function splitUnits(diff) {
  return String(diff ?? '').split(/(?=^diff --git |^--- Worker (?:untracked|deleted pre-existing untracked) file )/m).filter(Boolean);
}

// The changed file a unit belongs to, or null when it cannot be determined.
function unitFile(unit, changedFiles) {
  const first = unit.slice(0, unit.indexOf('\n') === -1 ? undefined : unit.indexOf('\n'));
  const untracked = UNTRACKED.exec(first) ?? DELETED.exec(first);
  if (untracked) return changedFiles.has(untracked[1]) ? untracked[1] : null;
  if (!first.startsWith('diff --git ')) return null;
  // A non-rename header names the same path twice: match it exactly, so a path
  // that is a suffix of another (bar.js vs foo/bar.js) or itself contains " b/"
  // is never ambiguous. Only a rename (a/<old> b/<new>) needs the suffix match.
  const exact = [...changedFiles].filter((f) => first === `diff --git a/${f} b/${f}`);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const matches = [...changedFiles].filter((f) => first.endsWith(` b/${f}`));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @param {object} p
 * @param {string} p.diff cumulative Worker diff
 * @param {string[]} p.changedFiles files in the cumulative diff
 * @param {Array<{reviewedFiles?: string[]}>} p.completedPhases
 * @param {string[]} p.postBoundaryFiles files changed since the last PHASE_PASS
 * @returns {{ diff: string, omittedFiles: string[] } | null}
 */
export function reduceFinalDiff({
  diff, changedFiles, completedPhases, postBoundaryFiles,
}) {
  if (!Array.isArray(changedFiles) || !changedFiles.length || !Array.isArray(postBoundaryFiles)) return null;
  if (!Array.isArray(completedPhases) || !completedPhases.length) return null;
  if (!completedPhases.every((p) => Array.isArray(p?.reviewedFiles))) return null;

  const files = new Set(changedFiles);
  const phaseCount = new Map();
  for (const p of completedPhases) {
    for (const f of new Set(p.reviewedFiles)) phaseCount.set(f, (phaseCount.get(f) ?? 0) + 1);
  }
  const post = new Set(postBoundaryFiles);
  const mustReview = (f) => (phaseCount.get(f) ?? 0) !== 1 || post.has(f);

  // Exactly one unit per changed file, every unit attributable; otherwise the
  // split cannot be trusted and nothing is omitted.
  const units = splitUnits(diff);
  const seen = new Map();
  const labelled = [];
  for (const unit of units) {
    const file = unitFile(unit, files);
    if (!file) return null;
    seen.set(file, (seen.get(file) ?? 0) + 1);
    labelled.push({ file, unit });
  }
  if (labelled.map((u) => u.unit).join('') !== String(diff)) return null;
  for (const f of files) if (seen.get(f) !== 1) return null;

  const kept = labelled.filter((u) => mustReview(u.file));
  const omittedFiles = labelled.filter((u) => !mustReview(u.file)).map((u) => u.file).sort();
  if (!omittedFiles.length) return null;
  const note = '# NOTE: omitted from this diff because each file was changed in exactly one phase, '
    + `fully reviewed at that phase gate, and untouched since: ${omittedFiles.join(', ')}\n`;
  return { diff: note + kept.map((u) => u.unit).join(''), omittedFiles };
}
