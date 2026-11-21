// P1 (RL-REVIEW-RELIABILITY): structured, trustworthy stop causes; legacy replay;
// restore-hold. Zero model calls; in-memory state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { buildStopCause, resolveStopCause, STOP_KINDS, STOP_SOURCES } from '../src/reviewloop/stopCause.js';
import { buildHumanRequiredReport, classify } from '../src/reviewloop/humanRequiredReport.js';
import { restoreHold, holdRestoreFindings } from '../src/reviewloop/holdRestore.js';
import { DESIGN_SOURCE_LIMIT_REASON } from '../src/reviewloop/designExceptionState.js';

const T0 = '2026-11-20T01:00:00.000Z';
const T1 = '2026-11-20T02:00:00.000Z';
const noBlockers = { list: [], unreadable: false };
const designObjective = { mode: 'LOCAL', taskType: 'design', reviewTarget: 'Design.md' };

function loopOf(history, extra = {}) {
  return { loopId: 'rl-x', state: 'HUMAN_REQUIRED', round: 2, objective: designObjective, history, ...extra };
}
const hr = (reason, over = {}) => ({ from: 'REVIEWING', to: 'HUMAN_REQUIRED', reason, round: 2, at: T0, ...over });
const engineCause = (kind = STOP_KINDS.REVIEW_TOOL_FAILED) => buildStopCause({ kind });
const reportFor = (loop, workflow = {}) => buildHumanRequiredReport({
  loopId: 'rl-x', loop, workflow: { reviewLoop: loop, ...workflow }, env: {},
});

// ---- AC-04: text can never change the category ---------------------------------

test('an engine-written tool failure stays REVIEW_FAILED whatever the model text says', () => {
  for (const text of [
    'Supervisor adjudication unusable (model output began: the Supervisor says UNRESOLVED token anomaly)',
    'token anomaly unaccounted UNRESOLVED supervisor reviewer call ceiling SPEND_DENIED',
  ]) {
    const loop = loopOf([hr(text, { cause: engineCause() })]);
    const wf = { reviewLoop: loop };
    assert.equal(classify({ loop, workflow: wf, reason: text }).category, 'REVIEW_FAILED', text);
    assert.equal(reportFor(loop).category, 'REVIEW_FAILED');
  }
});

test('free text alone (no engine cause, no closed template) is OTHER and never a tool failure', () => {
  for (const text of ['reviewer transport timeout', 'the Supervisor said no', 'provider quota output schema parse', 'review failed: provider timeout']) {
    const loop = loopOf([hr(text)]);
    assert.equal(classify({ loop, workflow: { reviewLoop: loop }, reason: text }).category, 'OTHER', text);
  }
});

test('a real supervisor stop is still the human-governance category, ahead of a tool failure', () => {
  const loop = loopOf([hr('the adjudicator needs a decision', { from: 'SUPERVISING', cause: engineCause() })]);
  assert.equal(classify({ loop, workflow: { reviewLoop: loop }, reason: 'x' }).category, 'SUPERVISOR_ESCALATION');
});

test('the live, restart (read-only) and exception views resolve the same category', () => {
  const loop = loopOf([hr('Reviewer file request unusable (model output began: Supervisor)', { cause: engineCause() })]);
  const wf = { reviewLoop: JSON.parse(JSON.stringify(loop)) };
  const live = classify({ loop, workflow: wf, reason: 'Design review did not produce a usable result: ...' }).category;
  const restarted = classify({ loop: JSON.parse(JSON.stringify(loop)), workflow: wf, reason: '' }).category;
  const exception = classify({ loop, workflow: wf, reason: 'x'.repeat(200) }).category;
  assert.deepEqual([live, restarted, exception], ['REVIEW_FAILED', 'REVIEW_FAILED', 'REVIEW_FAILED']);
});

// ---- AC-07: #65-style legacy records ----------------------------------------------

test('legacy: closed engine label + durable-state corroboration is a LEGACY_TEMPLATE tool failure', () => {
  const legacy = 'Supervisor adjudication unusable (Supervisor fact adjudication reply was not JSON; model output began: x)';
  const loop = loopOf([hr(legacy)]);
  const before = JSON.stringify(loop);
  const r = resolveStopCause({ loop, blockers: noBlockers });
  assert.equal(r.source, STOP_SOURCES.LEGACY_TEMPLATE);
  assert.equal(r.kind, STOP_KINDS.REVIEW_TOOL_FAILED);
  assert.equal(classify({ loop, workflow: { reviewLoop: loop }, reason: legacy }).category, 'REVIEW_FAILED');
  assert.equal(JSON.stringify(loop), before, 'the old record is read, never rewritten');
});

test('legacy: missing corroboration or a lookalike prefix is UNKNOWN with no exception category', () => {
  const legacy = 'Supervisor adjudication unusable (x)';
  // an independent active blocker
  assert.equal(resolveStopCause({ loop: loopOf([hr(legacy)]), blockers: { list: ['CALL_CEILING'], unreadable: false } }).source, STOP_SOURCES.UNKNOWN);
  // blockers unreadable
  assert.equal(resolveStopCause({ loop: loopOf([hr(legacy)]), blockers: { list: [], unreadable: true } }).source, STOP_SOURCES.UNKNOWN);
  // not stopped from REVIEWING
  assert.equal(resolveStopCause({ loop: loopOf([hr(legacy, { from: 'SUPERVISING' })]), blockers: noBlockers }).source, STOP_SOURCES.UNKNOWN);
  // supervisor recommended a human decision
  assert.equal(resolveStopCause({ loop: loopOf([hr(legacy)], { lastSupervisorRecommendation: 'HUMAN_REQUIRED' }), blockers: noBlockers }).source, STOP_SOURCES.UNKNOWN);
  // a reviewer/transport-sounding text that is not a closed template
  assert.equal(resolveStopCause({ loop: loopOf([hr('Reviewer transport failure: Supervisor')]), blockers: noBlockers }).source, STOP_SOURCES.UNKNOWN);
  // model text placed BEFORE the label does not match (prefix only)
  assert.equal(resolveStopCause({ loop: loopOf([hr(`note: ${legacy}`)]), blockers: noBlockers }).source, STOP_SOURCES.UNKNOWN);
});

test('legacy: the exact source-limit constant keeps its category', () => {
  const loop = loopOf([hr(DESIGN_SOURCE_LIMIT_REASON)]);
  assert.equal(classify({ loop, workflow: { reviewLoop: loop }, reason: DESIGN_SOURCE_LIMIT_REASON }).category, 'DESIGN_SOURCE_LIMIT');
});

// ---- AMBIGUOUS + restore-hold (five histories) ---------------------------------------

const staleHistory = () => [
  hr('Supervisor adjudication unusable (x)'),
  { from: 'HUMAN_REQUIRED', to: 'REVIEWING', reason: 'review requested', round: 2, at: T1 },
];
const reviewingLoop = (extra = {}) => ({ ...loopOf(staleHistory(), { state: 'REVIEWING' }), ...extra });

async function seed(loop, workflowExtra = {}) {
  const persistence = new MemoryPersistence();
  await persistence.writeWorkflowState('rl-x', { reviewLoop: loop, ...workflowExtra });
  return persistence;
}

test('AMBIGUOUS: HUMAN_REQUIRED -> REVIEWING with no outcome is never inferred, has no exception category', () => {
  const loop = reviewingLoop();
  assert.equal(resolveStopCause({ loop, blockers: noBlockers }).source, STOP_SOURCES.AMBIGUOUS);
});

test('restore-hold (stale): appends one entry, leaves every old entry byte-identical', async () => {
  const loop = reviewingLoop();
  const oldHistory = JSON.stringify(loop.history);
  const persistence = await seed(loop);
  await restoreHold({ persistence, loopId: 'rl-x', reason: 'the earlier stop was never answered' });
  const after = (await persistence.readWorkflowState('rl-x')).reviewLoop;
  assert.equal(after.state, 'HUMAN_REQUIRED');
  assert.equal(after.history.length, 3);
  assert.equal(JSON.stringify(after.history.slice(0, 2)), oldHistory, 'old history bytes unchanged');
  assert.equal(after.history[2].cause.kind, STOP_KINDS.HOLD_RESTORED);
  // the category of the restored stop is the ORIGINAL stop's (a closed legacy template here)
  const r = resolveStopCause({ loop: after, blockers: noBlockers });
  assert.equal(r.source, STOP_SOURCES.LEGACY_TEMPLATE);
  assert.equal(r.kind, STOP_KINDS.REVIEW_TOOL_FAILED);
  assert.equal(r.restored, true);
});

test('restore-hold (real Gate-stage interruption, same shape, no progress): also safe, hard stop returns', async () => {
  // Identical persistent shape by design (F7): restoring the hard stop loses nothing.
  const persistence = await seed(reviewingLoop());
  await restoreHold({ persistence, loopId: 'rl-x', reason: 'interrupted before any model call' });
  assert.equal((await persistence.readWorkflowState('rl-x')).reviewLoop.state, 'HUMAN_REQUIRED');
});

test('restore-hold refuses when any progress evidence exists, and writes nothing', async () => {
  const cases = {
    inFlight: [reviewingLoop({ designTwoStage: { inFlight: { key: 'k', round: 2 } } }), {}],
    roundMoved: [reviewingLoop({ round: 3 }), {}],
    lastReview: [reviewingLoop({ lastReview: { status: 'REWORK', at: '2026-11-20T03:00:00.000Z' } }), {}],
    reservationAfter: [reviewingLoop(), { modelSpendReservations: { r1: { status: 'DISPATCHING', reservedAt: '2026-11-20T03:00:00.000Z' } } }],
    reservationNoTime: [reviewingLoop(), { modelSpendReservations: { r1: { status: 'SETTLED' } } }],
    spendRecordAfter: [reviewingLoop(), { reviewLoopSpend: { records: [{ role: 'reviewer', at: '2026-11-20T03:00:00.000Z' }] } }],
  };
  for (const [name, [loop, extra]] of Object.entries(cases)) {
    const persistence = await seed(loop, extra);
    const before = JSON.stringify(await persistence.readWorkflowState('rl-x'));
    await assert.rejects(() => restoreHold({ persistence, loopId: 'rl-x', reason: 'try' }), /restore-hold refused/, name);
    assert.equal(JSON.stringify(await persistence.readWorkflowState('rl-x')), before, `${name}: state untouched`);
  }
});

test('an older, already-settled reservation does not count as progress', () => {
  const found = holdRestoreFindings({
    loop: reviewingLoop(),
    workflow: { modelSpendReservations: { r0: { status: 'SETTLED', reservedAt: '2026-11-20T00:10:00.000Z' } } },
  });
  assert.equal(found.eligible, true, found.blocking.join(';'));
});

test('a review record at/after the transition makes it a real outcome, not AMBIGUOUS', () => {
  const loop = reviewingLoop({ lastReview: { status: 'REWORK', at: '2026-11-20T03:00:00.000Z' } });
  assert.notEqual(resolveStopCause({ loop, blockers: noBlockers }).source, STOP_SOURCES.AMBIGUOUS);
});

test('AMBIGUOUS cannot obtain a Design exception; restore-hold refuses a non-ambiguous loop', async () => {
  const persistence = await seed(loopOf([hr('Supervisor adjudication unusable (x)')]));
  await assert.rejects(() => restoreHold({ persistence, loopId: 'rl-x', reason: 'r' }), /restore-hold refused/);
  const rep = reportFor(reviewingLoop());
  assert.notEqual(rep.category, 'REVIEW_FAILED');
});

test('buildStopCause rejects unknown kinds and keeps detail short', () => {
  assert.throws(() => buildStopCause({ kind: 'ANYTHING' }), /unknown stop cause/);
  assert.ok(buildStopCause({ kind: STOP_KINDS.REVIEW_TOOL_FAILED, detail: 'x'.repeat(5000) }).detail.length <= 200);
});

test('a tool failure whose text mentions round budgets or New Information is still REVIEW_FAILED', () => {
  for (const text of ['design review round budget (3) is spent', 'NO_NEW_INFORMATION New Information model spend']) {
    const loop = loopOf([hr(text, { cause: engineCause() })]);
    assert.equal(classify({ loop, workflow: { reviewLoop: loop }, reason: text }).category, 'REVIEW_FAILED', text);
  }
});
