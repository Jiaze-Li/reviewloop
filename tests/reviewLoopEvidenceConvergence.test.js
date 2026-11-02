import test from 'node:test';
import assert from 'node:assert/strict';

import { evidenceBlockerRequirementIds } from '../src/reviewloop/evidenceConvergence.js';
import { decideConvergence, REVIEW_VERDICTS } from '../src/reviewloop/reviewPolicy.js';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';

const scope = { type: 'task', id: 'task', fingerprint: '' };
const required = (id, gate = 'final', required = true) => ({
  id, gate, type: 'runtime', description: 'Demonstrate ' + id, required,
});
const proof = (id) => ({
  requirementId: id,
  summary: 'Executed deterministic checks for ' + id + ': 5 passed, 0 failed, exit code 0.',
});
const issue = (title, file = 'tests/smoke.js', line = 1) => ({ severity: 'P2', file, line, title });
const review = (...titles) => ({ blockingFindings: titles.map((title) => issue(title)) });

test('evidence identity requires exact frozen, in-scope, required obligation IDs and evidence-deficit wording', () => {
  const objective = {
    evidenceRequirements: [
      required('ui-proof'), required('ui-proof-extended'), required('later-proof', 'p2'),
      required('optional-proof', 'final', false),
    ],
  };
  const classify = (...titles) => evidenceBlockerRequirementIds({ review: review(...titles), objective, reviewScope: scope });
  assert.deepEqual(classify('Missing verification evidence for ui-proof-extended'), ['ui-proof-extended']);
  assert.deepEqual(classify('Insufficient runtime proof for ui-proof'), ['ui-proof']);
  assert.deepEqual(classify('Insufficient evidence for ui-proof', 'Missing proof for ui-proof-extended'),
    ['ui-proof', 'ui-proof-extended']);
  assert.deepEqual(classify('Missing proof for later-proof'), []);
  assert.deepEqual(classify('Missing proof for optional-proof'), []);
  assert.deepEqual(classify('Missing proof for unknown-proof'), []);
  assert.deepEqual(classify('Missing proof for ui-proof and ui-proof-extended'), []);
  assert.deepEqual(classify('Unrelated code defect involving ui-proof'), []);
  assert.deepEqual(classify('Missing proof for ui-proof', 'Broken code in validator'), []);
  assert.deepEqual(classify('Missing proof for ui-proof', 'Insufficient evidence for ui-proof'), []);
  assert.deepEqual(evidenceBlockerRequirementIds({ review: review('Missing proof for ui-proof'), objective }), [],
    'missing review scope must not invent a category');
});

test('same unsatisfied frozen evidence obligation triggers Supervisor after two genuinely changed rounds', async () => {
  const { controller, persistence, calls } = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: '+first' }, { fingerprint: 'd2', diff: '+second' }],
    reviews: [
      { findings: [issue('Missing runtime evidence for ui-proof', 'tests/ui.js', 10)] },
      { findings: [issue('Insufficient verification proof for ui-proof', 'tests/ui.js', 42)] },
    ],
    supervisorReplies: [{ guidance: 'Regenerate the actual proof, not a pointer.', recommendation: 'REWORK' }],
  });
  const { loopId } = await controller.begin({
    goal: 'Implement and independently verify the UI interaction', cwd: '/r',
    evidenceRequirements: [required('ui-proof')],
  });
  const first = await controller.review({ loopId, evidence: [proof('ui-proof')] });
  assert.equal(first.status, 'REWORK');
  assert.equal(calls.supervisor, 0);

  const second = await controller.review({ loopId, evidence: [proof('ui-proof')] });
  assert.equal(second.status, 'REWORK');
  assert.equal(calls.reviewer, 2);
  assert.equal(calls.supervisor, 1);
  assert.equal(second.convergenceEpoch, 1);
  const state = (await persistence.readWorkflowState(loopId)).reviewLoop;
  assert.equal(state.findingSignatureHistory.length, 2);
  assert.notDeepEqual(state.findingSignatureHistory[0].signatures, state.findingSignatureHistory[1].signatures);
  assert.deepEqual(state.findingSignatureHistory[0].evidenceBlockerRequirementIds, ['ui-proof']);
  assert.deepEqual(state.findingSignatureHistory[1].evidenceBlockerRequirementIds, ['ui-proof']);
  assert.equal(state.findingSignatureHistory[1].blockingCount, 1);
});

test('a reduction in blocker count is progress, even if some frozen evidence IDs persist', async () => {
  const { controller, calls } = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: '+first' }, { fingerprint: 'd2', diff: '+second' }],
    reviews: [
      { findings: [issue('Missing evidence for ui-proof'), issue('Missing proof for smoke-proof')] },
      { findings: [issue('Insufficient verification evidence for ui-proof')] },
    ],
  });
  const { loopId } = await controller.begin({
    goal: 'Demonstrate both obligations', cwd: '/r',
    evidenceRequirements: [required('ui-proof'), required('smoke-proof')],
  });
  await controller.review({ loopId, evidence: [proof('ui-proof'), proof('smoke-proof')] });
  const second = await controller.review({ loopId, evidence: [proof('ui-proof'), proof('smoke-proof')] });
  assert.equal(second.status, 'REWORK');
  assert.equal(calls.supervisor, 0);
  assert.equal(second.convergenceEpoch, 0);
});

test('mixed code/evidence problems cannot accelerate escalation; ordinary epoch limits still apply', async () => {
  const { controller, calls } = makeHarness({
    deltas: [{ fingerprint: 'd1', diff: '+first' }, { fingerprint: 'd2', diff: '+second' }],
    reviews: [
      { findings: [issue('Missing evidence for ui-proof'), issue('Authentication check wrongly accepts expired token')] },
      { findings: [issue('Insufficient proof for ui-proof'), issue('Authentication check bypasses authorization')] },
    ],
  });
  const { loopId } = await controller.begin({
    goal: 'Both verification and code correctness', cwd: '/r',
    evidenceRequirements: [required('ui-proof')],
  });
  await controller.review({ loopId, evidence: [proof('ui-proof')] });
  const second = await controller.review({ loopId, evidence: [proof('ui-proof')] });
  assert.equal(second.status, 'REWORK');
  assert.equal(calls.supervisor, 0);
});

test('legacy history without category metadata does not fabricate stagnation', () => {
  const loopState = {
    objective: { maxReviewRounds: 3, evidenceRequirements: [required('ui-proof')] },
    round: 2, gateRound: 2, epochReviewRound: 2,
    convergenceEpoch: 0, supervisorEscalationCount: 0,
    findingSignatureHistory: [{ epoch: 0, signatures: ['P2:tests/ui.js:missing ui proof'] }],
  };
  const latest = {
    status: 'ACTIONABLE',
    blockingFindings: [issue('Insufficient evidence for ui-proof')],
    findingSignatures: ['P2:tests/ui.js:insufficient evidence for ui-proof'],
  };
  const decision = decideConvergence({ loopState, review: latest, reviewScope: scope });
  assert.equal(decision.verdict, REVIEW_VERDICTS.REWORK);
  assert.equal(decision.invokeSupervisor, false);

  const passed = decideConvergence({
    loopState,
    review: { status: 'CLEAN', blockingFindings: [], findingSignatures: [] },
    reviewScope: scope,
  });
  assert.equal(passed.verdict, REVIEW_VERDICTS.PASS);
  assert.equal(passed.invokeSupervisor, false);
});

test('new evidence identity never survives an epoch boundary as an early escalation signal', () => {
  const loopState = {
    objective: { maxReviewRounds: 3, evidenceRequirements: [required('ui-proof')] },
    round: 4, gateRound: 4, epochReviewRound: 1,
    convergenceEpoch: 1, supervisorEscalationCount: 1,
    findingSignatureHistory: [{
      epoch: 0, blockingCount: 1,
      signatures: ['old-signature'],
      evidenceBlockerRequirementIds: ['ui-proof'],
    }],
  };
  const decision = decideConvergence({
    loopState,
    review: {
      status: 'ACTIONABLE', blockingFindings: [issue('Insufficient evidence for ui-proof')],
      findingSignatures: ['new-signature'],
    },
    reviewScope: scope,
  });
  assert.equal(decision.verdict, REVIEW_VERDICTS.REWORK);
  assert.equal(decision.invokeSupervisor, false);
});
