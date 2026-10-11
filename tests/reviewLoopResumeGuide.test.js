import test from 'node:test';
import assert from 'node:assert/strict';
import { isResumable, needsReopen, resumableLoopsFor, buildResumePrompt } from '../src/reviewloop/resumeGuide.js';

const phases = [
  { id: 'p1', title: 'Model', objective: 'build model', exitCriteria: ['model ok'], carryForwardInvariants: ['keep model pure'] },
  { id: 'p2', title: 'UI', objective: 'wire ui', exitCriteria: ['ui ok'], verificationCommands: ['npm test'] },
];
const loop = (over = {}) => ({
  loopId: 'rl-20261011-aaaa', state: 'READY_FOR_WORK', currentPhaseIndex: 1,
  completedPhases: [{ id: 'p1' }],
  objective: { goal: 'big task', repository: { root: '/proj' }, phases, constraints: ['no network'], contractText: 'FULL CONTRACT' },
  ...over,
});

test('resumability follows the loop state', () => {
  assert.equal(isResumable(loop()), true);
  assert.equal(isResumable(loop({ state: 'REWORK' })), true);
  assert.equal(isResumable(loop({ state: 'PASS' })), false);
  assert.equal(isResumable(loop({ state: 'HUMAN_REQUIRED', budgetExhausted: true })), false);
  assert.equal(needsReopen(loop({ state: 'HUMAN_REQUIRED', budgetExhausted: true })), true);
  assert.equal(isResumable(loop({ state: 'HUMAN_REQUIRED', budgetExhausted: false })), true);
});

test('only this repository\'s unfinished loops are offered, newest first', () => {
  const loops = [
    loop({ loopId: 'rl-1' }), loop({ loopId: 'rl-3' }), loop({ loopId: 'rl-2', state: 'PASS' }),
    loop({ loopId: 'rl-4', objective: { ...loop().objective, repository: { root: '/other' } } }),
  ];
  assert.deepEqual(resumableLoopsFor(loops, '/proj').map((l) => l.loopId), ['rl-3', 'rl-1']);
});

test('the prompt names the loop, the current phase, and forbids a new loop', () => {
  const text = buildResumePrompt(loop());
  assert.match(text, /Do NOT call reviewloop_begin/);
  assert.match(text, /loopId: rl-20261011-aaaa/);
  assert.match(text, /phases completed: p1 of p1, p2/);
  assert.match(text, /CURRENT PHASE: p2 - UI/);
  assert.match(text, /- npm test/);
  assert.match(text, /keep model pure/, 'invariants from completed phases are carried');
  assert.match(text, /FULL CONTRACT/);
  assert.match(text, /git add/);
});

test('REWORK shows the findings; after the last phase it points at the final gate', () => {
  const rework = buildResumePrompt(loop({
    state: 'REWORK',
    lastReview: { blockingFindings: [{ severity: 'P1', file: 'a.js', line: 3, title: 'wrong result' }] },
  }));
  assert.match(rework, /P1 a\.js:3 wrong result/);
  const final = buildResumePrompt(loop({ currentPhaseIndex: 2, completedPhases: [{ id: 'p1' }, { id: 'p2' }] }));
  assert.match(final, /FINAL whole-task gate/);
  assert.doesNotMatch(final, /CURRENT PHASE/);
});
