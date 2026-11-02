import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { changedFilesPrompt, buildReviewerInvoke, buildSupervisorInvoke } from '../src/reviewloop/providerWiring.js';
import { buildTokenProfile } from '../src/reviewloop/tokenProfile.js';

function decodeChangedFiles(text) {
  const marker = '\n';
  const json = JSON.parse(text.slice(text.indexOf(marker) + 1));
  if (text.includes('ordered [directoryIndex, basename]')) {
    const [dirs, entries] = json;
    return entries.map(([i, name]) => dirs[i] + name);
  }
  return json.flatMap(([prefix, names]) => names.map((name) => prefix + name));
}

const prefixA = 'Sources/VeryLongSharedModule/Internals/TestingAndValidation/A/';
const prefixB = 'Sources/VeryLongSharedModule/Internals/TestingAndValidation/B/';
const alternatingFiles = Array.from({ length: 36 }, (_, i) => (
  (i % 2 ? prefixB : prefixA) + 'source-' + i + '.swift'
));
alternatingFiles.push(prefixA + 'punctuation, quote" newline\n雪.swift', prefixB + 'nested/../odd.swift', alternatingFiles[0]);

test('dictionary factoring losslessly preserves interleaved directory paths, order and duplicates', () => {
  const encoded = changedFilesPrompt(alternatingFiles);
  const plain = 'CHANGED FILES: ' + alternatingFiles.join(', ');
  assert.match(encoded, /ordered \[directoryIndex, basename\]/);
  assert.deepEqual(decodeChangedFiles(encoded), alternatingFiles);
  assert.ok(encoded.length < plain.length * 0.65, {
    encodedChars: encoded.length, originalChars: plain.length,
  });
  // Existing one-path/short-path prompts retain their cheap legacy encoding.
  assert.equal(changedFilesPrompt(['a.js']), 'CHANGED FILES: a.js');
  assert.equal(changedFilesPrompt(['a.js', 'b.js']), 'CHANGED FILES: a.js, b.js');
});

test('every Reviewer chunk still sees ALL changed files and full unmodified task material', async () => {
  const invoke = buildReviewerInvoke();
  const contract = 'DO NOT REMOVE\n\n\nIndented content:\n    frozen criterion\n  ';
  const scope = {
    type: 'phase', id: 'p', objective: 'Validate a local phase',
    exitCriteria: ['Must preserve behavior'],
    preserveInvariants: ['Keep already-certified behavior'],
    carryForwardInvariants: ['Continue to final'],
  };
  for (const diff of [
    'diff --git a/first b/first\n+first',
    'diff --git a/second b/second\n+second',
  ]) {
    let prompt;
    const reply = await invoke({
      objective: { goal: 'Do the full task', contractText: contract, constraints: ['Keep safety'] },
      changedFiles: alternatingFiles, diff, gate: { verdict: 'PASS' }, reviewScope: scope,
      evidence: { requirements: [{ id: 'runtime', type: 'runtime', description: 'Prove behavior' }],
        submissions: [{ requirementId: 'runtime', summary: 'Validated 20 cases without failures.' }] },
      previousFindings: [{ severity: 'P2', file: prefixB + 'source-1.swift', line: 2, title: 'Historical bug' }],
      transport: async (value) => { prompt = value; return { text: '{"findings":[]}' }; },
    });
    const line = prompt.split('\n').findIndex((s) => s.startsWith('CHANGED FILES'));
    const encoded = prompt.split('\n').slice(line, line + 2).join('\n');
    assert.deepEqual(decodeChangedFiles(encoded), alternatingFiles);
    for (const phrase of [
      'Do the full task', contract.trim(), 'Keep safety', 'Validate a local phase',
      'Must preserve behavior', 'Keep already-certified behavior', 'Continue to final',
      'Prove behavior', 'Validated 20 cases', 'Historical bug', diff,
      'Review ALL current evidence for new defects as well.',
    ]) assert.ok(prompt.includes(phrase), phrase);
    assert.equal(reply.meta.promptChars, prompt.length);
    assert.equal(reply.meta.promptComponentStats.changedFilesChars, encoded.length);
    assert.equal(reply.meta.diffChars, diff.length);
  }
});

test('Supervisor minification preserves exact previous findings/history and frozen contract', async () => {
  const prior = Array.from({ length: 6 }, (_, i) => ({
    round: i + 1, epoch: 0, signatures: [
      'P2:src/module/code.js:missing test coverage for validator ' + i,
      'P2:src/module/ui.js:runtime proof is insufficient for requirement ' + i,
    ],
  }));
  const blockers = Array.from({ length: 12 }, (_, i) => ({
    severity: 'P2', file: 'src/module/file-' + i + '.js',
    line: 4 + i, title: 'Missing verification coverage on branch ' + i,
    signature: 'P2:src/module/file-' + i + '.js:missing verification coverage',
  }));
  const contract = ['Frozen contract', '  indented clause  ', '', '', 'Final clause'].join('\n');
  let prompt;
  const result = await buildSupervisorInvoke()({
    objective: { goal: 'Preserve all acceptance criteria', contractText: contract },
    blockingFindings: blockers,
    reviewScope: { type: 'phase', id: 'p1', objective: 'Phase 1', exitCriteria: ['Exit A'] },
    evidence: { requirements: [{ id: 'required', type: 'runtime', description: 'Must be checked' }],
      submissions: [{ requirementId: 'required', summary: 'Verification: 8 passed, 0 failed.' }] },
    priorSignatures: prior,
    priorSupervisorGuidance: 'Try an independent invariant check.',
    transport: async (p) => {
      prompt = p;
      return { text: '{"guidance":"review the contract","recommendation":"REWORK"}' };
    },
  });
  const history = prompt.split('RECENT CONVERGENCE HISTORY (signatures only):\n')[1]
    .split('\nPRIOR SUPERVISOR GUIDANCE:')[0];
  const findings = prompt.split('CURRENT BLOCKING FINDINGS:\n')[1].split('\nDiagnose WHY')[0];
  assert.deepEqual(JSON.parse(history), prior);
  assert.deepEqual(JSON.parse(findings), blockers);
  assert.ok(!history.includes('\n'), 'history values are transmitted in compact JSON');
  assert.ok(!findings.includes('\n'), 'findings values are transmitted in compact JSON');
  assert.ok(prompt.includes('FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n' + contract));
  assert.ok(prompt.includes('Exit A') && prompt.includes('Must be checked') && prompt.includes('Verification: 8 passed'));
  const oldChars = JSON.stringify(prior, null, 2).length + JSON.stringify(blockers, null, 2).length;
  assert.ok(oldChars - history.length - findings.length > 400,
    'minification must demonstrably reduce actual transmitted characters');

  const stats = result.meta.promptComponentStats;
  assert.equal(result.meta.promptChars, prompt.length);
  assert.equal(stats.supervisorHistoryChars,
    'RECENT CONVERGENCE HISTORY (signatures only):\n'.length + history.length);
  assert.equal(stats.blockingFindingsChars, 'CURRENT BLOCKING FINDINGS:\n'.length + findings.length);
  assert.equal(stats.contractChars,
    'FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n'.length + contract.length);
  assert.equal(stats.contractSha256, createHash('sha256')
    .update('FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n' + contract)
    .digest('hex'));
  assert.equal(stats.priorSupervisorGuidanceChars,
    'PRIOR SUPERVISOR GUIDANCE:\nTry an independent invariant check.'.length);
  assert.ok(!('contractText' in stats) && !('priorSignatures' in stats));
  assert.ok(!('promptText' in result.meta));

  const profile = buildTokenProfile({
    loopId: 'profile-test',
    workflow: { reviewLoop: { loopId: 'profile-test' }, reviewLoopSpend: { records: [{
      role: 'supervisor', round: 3, usageVolume: 25, usageKnown: true,
      costUsd: 0, costKnown: false,
      usageBreakdown: { inputTokens: 20, outputTokens: 5 },
      payloadMeta: result.meta,
    }] } },
  });
  assert.equal(profile.prompt.components.supervisorHistoryChars.chars, stats.supervisorHistoryChars);
  assert.equal(profile.prompt.components.blockingFindingsChars.chars, stats.blockingFindingsChars);
  assert.equal(profile.summary.ledgerUsageVolume, 25);
});
