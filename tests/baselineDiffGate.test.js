import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffBaselineFailures,
  summarizeBaselineEvidence,
  BASELINE_DIFF_VERDICTS,
} from '../src/orchestrator/baselineDiffGate.js';
import {
  extractFailingTestIds,
  collectFailureIdentities,
} from '../src/orchestrator/gateFailureIdentity.js';

// ── failure identity extraction (shared parser) ──────────────────────────

test('extractFailingTestIds: node:test spec reporter, durations stripped', () => {
  const out = [
    '✔ passing one (0.5ms)',
    '✖ A. Timeline shows newest-first (1.9ms)',
    '✖ B. resume transitions (12ms)',
  ].join('\n');
  assert.deepEqual(extractFailingTestIds(out), ['A. Timeline shows newest-first', 'B. resume transitions']);
});

test('extractFailingTestIds: TAP not ok lines', () => {
  const out = 'ok 1 - alpha\nnot ok 2 - beta broke\nnot ok 3 gamma broke\n';
  assert.deepEqual(extractFailingTestIds(out), ['beta broke', 'gamma broke']);
});

test('collectFailureIdentities: unparseable failing command is not reliable', () => {
  const ev = {
    pass: false,
    results: [
      { command: 'npm test', pass: false, exitCode: 1, output: 'Segmentation fault\nmake: *** [test] Error 139' },
    ],
  };
  const info = collectFailureIdentities(ev);
  assert.equal(info.reliable, false);
  assert.deepEqual(info.unreliableCommands, ['npm test']);
  assert.deepEqual(info.identities, []);
});

// ── diffBaselineFailures ────────────────────────────────────────────────

function ev(pass, resultsOutputs) {
  // resultsOutputs: [{ command, pass, exitCode, output }]
  return { pass, results: resultsOutputs };
}
function failing(output, command = 'npm test', exitCode = 1) {
  return { command, pass: false, exitCode, output };
}
const DASH_ABC = '✖ dashboard A\n✖ dashboard B\n✖ dashboard C';

test('A. identical baseline & current failure set -> PASS_WITH_BASELINE_FAILURES, no new failures', () => {
  const baseline = ev(false, [failing(DASH_ABC)]);
  const current = ev(false, [failing(DASH_ABC)]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES);
  assert.deepEqual(r.newFailures, []);
  assert.deepEqual(r.ignoredBaselineFailures, ['dashboard A', 'dashboard B', 'dashboard C']);
});

test('B. current adds a new failing test -> NEW_FAILURES = [D] only', () => {
  const baseline = ev(false, [failing(DASH_ABC)]);
  const current = ev(false, [failing(`${DASH_ABC}\n✖ graph test D`)]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.NEW_FAILURES);
  assert.deepEqual(r.newFailures, ['graph test D']);
  assert.deepEqual(r.ignoredBaselineFailures, ['dashboard A', 'dashboard B', 'dashboard C']);
});

test('C. current is a strict subset of baseline -> PASS_WITH_BASELINE_FAILURES', () => {
  const baseline = ev(false, [failing(DASH_ABC)]);
  const current = ev(false, [failing('✖ dashboard A\n✖ dashboard B')]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES);
  assert.deepEqual(r.newFailures, []);
});

test('D. baseline PASS, current fails D -> NEW_FAILURES = [D] (normal FAIL)', () => {
  const baseline = ev(true, [{ command: 'npm test', pass: true, exitCode: 0, output: 'all good' }]);
  const current = ev(false, [failing('✖ graph test D')]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.NEW_FAILURES);
  assert.deepEqual(r.newFailures, ['graph test D']);
});


test('D2. identical failure identity from a different command is still NEW_FAILURES', () => {
  const baseline = ev(false, [
    failing('✖ shared identity', 'npm test'),
  ]);
  const current = ev(false, [
    failing('✖ shared identity', 'npm test'),
    failing('✖ shared identity', 'npm run phase-check'),
  ]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.NEW_FAILURES);
  assert.deepEqual(r.newFailures, ['shared identity']);
  assert.deepEqual(r.ignoredBaselineFailures, ['shared identity']);
});

test('E. unparseable identity on both sides, both exit 1 -> UNRELIABLE (never assume equal)', () => {
  const baseline = ev(false, [failing('Segmentation fault (core dumped)')]);
  const current = ev(false, [failing('Segmentation fault (core dumped)')]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.UNRELIABLE);
  assert.equal(r.comparable, false);
});

test('E2. current has a parseable failure but the same command failed unparseably at baseline -> UNRELIABLE', () => {
  const baseline = ev(false, [failing('build broke: TS2304')]);
  const current = ev(false, [failing('✖ graph test D')]);
  const r = diffBaselineFailures(baseline, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.UNRELIABLE);
});

test('missing baseline entirely -> UNRELIABLE, every current failure treated as new', () => {
  const current = ev(false, [failing('✖ graph test D')]);
  const r = diffBaselineFailures(null, current);
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.UNRELIABLE);
  assert.deepEqual(r.newFailures, ['graph test D']);
  assert.equal(r.comparable, false);
});

test('current PASS -> verdict PASS regardless of baseline', () => {
  const r = diffBaselineFailures(ev(false, [failing(DASH_ABC)]), ev(true, []));
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.PASS);
});

test('summarizeBaselineEvidence: drops passing-command output, caps failing-command output', () => {
  const big = 'x'.repeat(50000);
  const s = summarizeBaselineEvidence(ev(false, [
    { command: 'lint', pass: true, exitCode: 0, output: 'clean '.repeat(1000) },
    { command: 'npm test', pass: false, exitCode: 1, output: `✖ t\n${big}` },
  ]));
  assert.equal(s.results[0].output, '');
  assert.ok(s.results[1].output.length <= 20000);
  assert.equal(s.results[1].exitCode, 1);
  // identities still recoverable from the capped output
  assert.deepEqual(extractFailingTestIds(s.results[1].output), ['t']);
});

test('wf-agy-9a3583e5 shape: 7 identical dashboard failures on both sides -> suppressed', () => {
  const seven = [
    'D. Timeline shows newest-first',
    'M. /api/workflows returns Attention workflows by default',
    'M2. Default selector shows ONLY active/unresolved workflows',
    'Scenario A: Starting unrelated USER workflow C does NOT supersede',
    'Scenario B: Explicit replacement B marks A as SUPERSEDED',
    'Scenario D: Workflow A in HUMAN_REQUIRED resume transitions',
    'Q. API /api/focus and /api/workflows return active focus',
  ];
  const body = seven.map((n, i) => `✖ ${n} (${i + 1}.1ms)`).join('\n');
  const r = diffBaselineFailures(ev(false, [failing(body)]), ev(false, [failing(body)]));
  assert.equal(r.verdict, BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES);
  assert.equal(r.ignoredBaselineFailures.length, 7);
  assert.equal(r.newFailures.length, 0);
});
