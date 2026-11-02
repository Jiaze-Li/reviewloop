// Conservative, deterministic identity for repeatedly insufficient frozen
// evidence obligations. Used only to decide whether to ask the Supervisor for
// a different repair strategy; never to PASS, suppress or resolve a finding.
//
// Evidence obligation identity is taken from the FROZEN contract, not inferred
// from a changing line number, free-form title hash or generated category.
// Ambiguous prose, code defects, missing requirement IDs and older history
// produce no early-escalation signal. The ordinary signature / epoch policy
// remains the default.

const DEFICIT = /\b(?:missing|absent|insufficient|inadequate|unverified|unproven|unsubstantiated|not provided|not supplied|not shown|not demonstrated|cannot verify)\b/i;
const PROOF = /\b(?:evidence|proof|verification|test results?|artifacts?)\b/i;

function namesId(text, id) {
  let start = 0;
  while (start <= text.length - id.length) {
    const at = text.indexOf(id, start);
    if (at < 0) return false;
    const end = at + id.length;
    const beforeOk = at === 0 || !/[a-zA-Z0-9_-]/.test(text[at - 1]);
    const afterOk = end === text.length || !/[a-zA-Z0-9_-]/.test(text[end]);
    if (beforeOk && afterOk) return true;
    start = at + 1;
  }
  return false;
}

function relevantIds(objective, reviewScope) {
  if (!reviewScope || !Array.isArray(objective?.evidenceRequirements)) return [];
  const matchesGate = (r) => r.gate === 'final'
    ? reviewScope.type === 'task' || reviewScope.type === 'final'
    : r.gate === reviewScope.id;
  return [...new Set(objective.evidenceRequirements
    .filter((r) => r?.required !== false && typeof r?.id === 'string' && r.id.trim() && matchesGate(r))
    .map((r) => r.id))];
}

// All current blocking findings must clearly concern missing/insufficient
// proof for EXACTLY one unique frozen requirement apiece. Partial/mixed
// classifications are intentionally refused; reducing or replacing blockers
// is progress and must never trigger this faster path.
export function evidenceBlockerRequirementIds({ review, objective, reviewScope } = {}) {
  const findings = review?.blockingFindings;
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const ids = relevantIds(objective, reviewScope);
  if (!ids.length) return [];
  const found = [];
  for (const f of findings) {
    const title = typeof f?.title === 'string' ? f.title : '';
    if (!DEFICIT.test(title) || !PROOF.test(title)) return [];
    const matchingIds = ids.filter((id) => namesId(title, id));
    if (matchingIds.length !== 1) return [];
    found.push(matchingIds[0]);
  }
  if (new Set(found).size !== found.length) return [];
  return found.sort();
}
