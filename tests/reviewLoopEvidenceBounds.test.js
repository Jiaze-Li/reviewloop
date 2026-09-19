import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_LIMITS, EvidenceValidationError, normalizeEvidenceRequirements,
  normalizeEvidenceSubmissions, bindEvidenceSubmissions, reviewerEvidenceBundle,
  evidencePromptLines, evidenceBundleFingerprint, buildResumePacket,
} from '../src/reviewloop/contractEvidence.js';

const scope = { type: 'task', id: 'task', fingerprint: '' };
const requirement = (id, extra = {}) => ({
  id, type: 'runtime', description: `Prove ${id}.`, gate: 'final', required: true, covers: ['AC1'], ...extra,
});
const proof = (requirementId, summary = 'Observed the production state transition.') => ({ requirementId, summary });
const bind = (state, requirements, submissions, extra = {}) => bindEvidenceSubmissions({
  loopState: state, objective: { evidenceRequirements: requirements }, reviewScope: scope,
  evidenceFingerprint: 'code-1', submissions, ...extra,
});
const bundle = (state, requirements, extra = {}) => reviewerEvidenceBundle({
  loopState: state, objective: { evidenceRequirements: requirements }, reviewScope: scope,
  evidenceFingerprint: 'code-1', ...extra,
});

test('evidence batch binding is atomic for unknown, wrong-gate, malformed and duplicate items', () => {
  const requirements = [requirement('runtime'), requirement('later', { gate: 'phase-2' })];
  const state = { evidenceRecords: [] };
  bind(state, requirements, [proof('runtime', 'Existing accepted proof.')]);
  const before = structuredClone(state);
  const invalidTails = [proof('typo'), proof('later'), {}, null, proof('runtime')];
  for (const tail of invalidTails) {
    assert.throws(() => bind(state, requirements, [proof('runtime', 'Replacement.'), tail]), EvidenceValidationError);
    assert.deepEqual(state, before, 'a valid prefix must not replace previously accepted evidence');
  }
  assert.throws(() => bind(state, requirements, { bad: true }), EvidenceValidationError);
  assert.deepEqual(state, before);
});

test('evidence limits use UTF-8 bytes and reject instead of silently truncating', () => {
  const accepted = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes);
  assert.equal(normalizeEvidenceSubmissions([proof('r', accepted)])[0].summary, accepted);
  for (const entry of [
    proof('r', accepted + 'e'),
    proof('r', '界'.repeat(Math.floor(EVIDENCE_LIMITS.summaryBytes / 3) + 1)),
    { ...proof('r'), artifactRef: 'a'.repeat(EVIDENCE_LIMITS.artifactRefBytes + 1) },
    proof('r'.repeat(EVIDENCE_LIMITS.idBytes + 1)),
    proof('r', 42),
    proof('r', ' '),
  ]) {
    assert.throws(() => normalizeEvidenceSubmissions([entry]), (error) => {
      assert.ok(error instanceof EvidenceValidationError);
      assert.ok(error.message.length < 300, 'raw evidence must not be echoed in diagnostics');
      return true;
    });
  }
  assert.throws(() => normalizeEvidenceSubmissions(
    Array.from({ length: EVIDENCE_LIMITS.items + 1 }, (_, i) => proof(`r${i}`)),
  ), /item limit/);
});

test('aggregate budget includes evidence accumulated across separate submissions', () => {
  const requirements = Array.from({ length: 6 }, (_, i) => requirement(`r${i}`));
  const state = { evidenceRecords: [] };
  const large = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes);
  for (let i = 0; i < 5; i += 1) bind(state, requirements, [proof(`r${i}`, large)]);
  const before = structuredClone(state);
  assert.throws(() => bind(state, requirements, [proof('r5', large)]), /combined evidence prompt/);
  assert.deepEqual(state, before, 'aggregate rejection must not persist the final item');
  bind(state, requirements, [proof('r5')]);
  const accepted = bundle(state, requirements);
  assert.equal(accepted.submissions.length, 6);
  assert.ok(Buffer.byteLength(evidencePromptLines(accepted).join('\n')) <= EVIDENCE_LIMITS.promptBytes);
});

test('oversized persisted evidence is blocked after reload and can be replaced', () => {
  const requirements = [requirement('r')];
  const state = { evidenceRecords: [] };
  bind(state, requirements, [proof('r')]);
  state.evidenceRecords[0].summary = 'e'.repeat(EVIDENCE_LIMITS.summaryBytes + 1);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.throws(() => bundle(reloaded, requirements), EvidenceValidationError);
  bind(reloaded, requirements, [proof('r', 'Corrected bounded proof.')]);
  assert.equal(bundle(reloaded, requirements).submissions[0].summary, 'Corrected bounded proof.');
});

test('frozen evidence metadata is bounded and optional context counts toward prompt budget', () => {
  assert.throws(() => normalizeEvidenceRequirements([
    requirement('r', { description: 'd'.repeat(EVIDENCE_LIMITS.requirementsBytes) }),
  ]), /evidenceRequirements exceed/);
  const optional = requirement('optional', { required: false, description: 'Optional diagnostic context.' });
  const state = { evidenceRecords: [] };
  bind(state, [optional], [proof('optional')]);
  assert.match(evidencePromptLines(bundle(state, [optional])).join('\n'), /optional.*Optional diagnostic context/);
  const excessive = requirement('optional', { required: false, description: 'd'.repeat(EVIDENCE_LIMITS.promptBytes) });
  assert.throws(() => bundle(state, [excessive]), /combined evidence prompt/);
  assert.throws(() => evidencePromptLines({
    requirements: [requirement('r', { covers: ['c'.repeat(EVIDENCE_LIMITS.promptBytes)] })],
    submissions: [proof('r')],
  }), /combined evidence prompt/);
});

test('evidence content, not timestamps, is new information; code and scope remain binding', () => {
  const requirements = [requirement('r')];
  const state = { evidenceRecords: [] };
  bind(state, requirements, [proof('r')], { now: 't1' });
  const first = evidenceBundleFingerprint(bundle(state, requirements));
  bind(state, requirements, [proof('r')], { now: 't2' });
  assert.equal(evidenceBundleFingerprint(bundle(state, requirements)), first);
  bind(state, requirements, [proof('r', 'Additional verified observations.')]);
  assert.notEqual(evidenceBundleFingerprint(bundle(state, requirements)), first);
  assert.equal(bundle(state, requirements, { evidenceFingerprint: 'code-2' }).submissions.length, 0);
  assert.equal(bundle(state, requirements, { reviewScope: { type: 'final', id: 'final', fingerprint: 'another-scope' } }).submissions.length, 0);
});

test('resume retains final acceptance criteria without contractText and never raw proof history', () => {
  const phase = { id: 'p1', title: 'Work', objective: 'Implement behavior.', exitCriteria: ['AC1'], carryForwardInvariants: ['Keep AC1.'] };
  const objective = {
    goal: 'Actual success definition.', fingerprint: 'frozen-fingerprint', phases: [phase],
    verificationPlan: { commands: ['npm test'] }, evidenceRequirements: [requirement('final-proof')],
  };
  const state = {
    loopId: 'same-loop', completedPhases: [{ id: 'p1', title: 'Work', proof: 'phase-proof' }],
    evidenceRecords: [{ requirementId: 'final-proof', summary: 'RAW-LOG'.repeat(1000) }],
  };
  const packet = buildResumePacket({ loopState: state, objective, completedScope: phase, nextScope: { type: 'final', id: 'final' } });
  assert.equal(packet.goal, objective.goal);
  assert.equal(packet.contractText, null);
  assert.deepEqual(packet.phasePlan, [phase]);
  assert.deepEqual(packet.verificationPlan, objective.verificationPlan);
  assert.deepEqual(packet.pendingEvidenceRequirements, objective.evidenceRequirements);
  assert.equal(packet.nextPhase, null);
  assert.equal(packet.finalGatePending, true);
  assert.equal(packet.evidenceRecordCount, 1);
  assert.equal(JSON.stringify(packet).includes('RAW-LOG'), false);
});
