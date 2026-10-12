// LOCAL correctness/liveness regression tests. Zero real provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { terminateProcessTree } from '../src/orchestrator/processTree.js';
import { runGate, GATE_VERDICTS } from '../src/reviewloop/gatePolicy.js';
import { checkMcpServerBinding } from '../scripts/doctor.js';
import { installGlobal } from '../bin/install-plugin.js';


// ---------------------------------------------------------------------------
// 8. A cancelled LOCAL review does not continue into paid Gate / Reviewer spend.
// ---------------------------------------------------------------------------
test('cancelling a LOCAL reviewloop_review stops it before the Reviewer is dispatched', async () => {
  const ac = new AbortController();
  let reviewerCalls = 0;
  let gateCalls = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'FP', diff: 'diff',
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    runGateFn: async ({ signal }) => {
      gateCalls += 1;
      // The Gate observes the cancellation and fails closed.
      ac.abort();
      return { verdict: signal?.aborted ? 'FAIL' : 'PASS', pass: false, fingerprint: 'G', failureIdentities: ['cancelled'], results: [], evidence: { results: [], pass: false } };
    },
    reviewerFn: async () => { reviewerCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId, signal: ac.signal });
  assert.ok(gateCalls >= 1);
  assert.equal(reviewerCalls, 0, 'no Reviewer dispatch after cancellation');
  assert.equal(r.status, 'HUMAN_REQUIRED');
  const st = await controller._persistence.readWorkflowState(loopId);
  const spend = st.reviewLoopSpend?.records ?? [];
  assert.equal(spend.filter((x) => x.role === 'reviewer').length, 0, 'zero paid Reviewer spend records');
});

test('baseline Gate evidence is bound to the objective; a tampered copy is ignored for FAIL->WARN suppression', async () => {
  const realEvidence = { results: [{ command: 'npm test', exitCode: 1, pass: false }], pass: false };
  let seenAtReview;
  const mk = (persistence) => createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'FP', diff: 'diff',
    }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm test'], manifestFingerprint: 'mf' }),
    runGateFn: async ({ baselineGateEvidence }) => {
      seenAtReview = baselineGateEvidence;
      return { verdict: 'FAIL', pass: false, fingerprint: 'G', failureIdentities: ['npm-test'], results: [], evidence: realEvidence };
    },
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });

  const persistence = new MemoryPersistence();
  const controller = mk(persistence);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  // Untampered: the objective-bound identity matches, so the real evidence flows.
  await controller.review({ loopId });
  assert.deepEqual(seenAtReview, realEvidence, 'genuine baseline Gate evidence is passed through');

  // Tamper the persisted evidence (a state editor injecting the current failure).
  const st = await persistence.readWorkflowState(loopId);
  st.reviewLoop.baselineGateEvidence.evidence = {
    results: [{ command: 'npm test', exitCode: 1, pass: false, injected: true }], pass: false,
  };
  await persistence.writeWorkflowState(loopId, st);

  seenAtReview = 'unset';
  const r = await mk(persistence).review({ loopId });
  assert.equal(seenAtReview, null, 'tampered baseline Gate evidence is NOT used for suppression');
  assert.ok(
    (r.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_BASELINE_GATE_EVIDENCE_UNVERIFIED'),
    JSON.stringify(r.safetyEvents),
  );
});

// ---------------------------------------------------------------------------
// 9. Gate zombie teardown is hard-bounded (never an unbounded await).
// ---------------------------------------------------------------------------
test('terminateProcessTree resolves done() even if the process group never reports gone', async () => {
  // A fake child whose "group" (pid) always looks alive: processGroupExists
  // would poll true forever without the hard bound.
  const fakeChild = { pid: 2_000_000_123, killed: false, exitCode: null, kill() {} };
  const started = Date.now();
  const tree = terminateProcessTree(fakeChild, {
    graceMs: 5, pollMs: 2, hardBoundMs: 40, probeGroup: () => true,
  });
  const res = await tree.done;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `done resolved in ${elapsed}ms (bounded)`);
  assert.equal(res?.confirmed, false, 'teardown reported as unconfirmed (fail closed), not silently ok');
});

// ---------------------------------------------------------------------------
// Round-2 Codex findings on this change.
// ---------------------------------------------------------------------------
// PR targets are retired and cannot be silently reinterpreted as LOCAL.
test('retired PR begin fails before baseline/Gate/model work', async () => {
  let baselines = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => { baselines += 1; throw new Error('unexpected baseline'); },
  });
  await assert.rejects(() => controller.begin({ goal: 'g', cwd: '/r', prNumber: 5 }), /PR mode has been retired/);
  assert.equal(baselines, 0);
});

test('retired persisted PR loop refuses review without changing its durable state', async () => {
  const persistence = new MemoryPersistence();
  const saved = { reviewLoop: { loopId: 'old-pr', state: 'READY_FOR_WORK', objective: { mode: 'PR' } } };
  await persistence.writeWorkflowState('old-pr', saved);
  const controller = createReviewLoopController({ persistence });
  await assert.rejects(() => controller.review({ loopId: 'old-pr' }), /PR session retired/);
  assert.deepEqual(await persistence.readWorkflowState('old-pr'), saved);
});

test('an ancient orphan .reclaim guard never permanently blocks lease acquisition', async () => {
  const { acquireLoopFileLease } = await import('../src/reviewloop/loopLease.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-orphan-guard-'));
  try {
    const dir = path.join(root, 'L');
    fs.mkdirSync(dir, { recursive: true });
    // Stale lock (dead pid, this host) + an ANCIENT orphan reclaim guard.
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'stale', pid: 999_999_999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(),
    }));
    const guard = path.join(dir, 'reviewloop.lock.reclaim');
    fs.writeFileSync(guard, '');
    fs.utimesSync(guard, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'L' });
    assert.equal(lease.ok, true, 'the ancient orphan guard was cleared and the stale lock reclaimed');
    await lease.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Gate teardown bound keeps a short timed-out Gate well under 5s even with a stuck group', async () => {
  // A runner-injected fake cannot exercise the real spawn path; assert the
  // bound directly: graceMs(1000) + hardBoundMs(1500) < 5000.
  const started = Date.now();
  const tree = terminateProcessTree(
    { pid: 2_000_000_999, killed: false, exitCode: null, kill() {} },
    { graceMs: 1000, hardBoundMs: 1500, pollMs: 20, probeGroup: () => true },
  );
  await tree.done;
  assert.ok(Date.now() - started < 4000, 'bounded teardown resolved well under the 5s Gate contract');
});

test('a persisted objective with its fingerprint field removed is rejected (not treated as valid)', async () => {
  const { createReviewObjective, rehydrateObjective } = await import('../src/reviewloop/objective.js');
  const obj = createReviewObjective({ loopId: 'L', goal: 'do the thing', mode: 'LOCAL' });
  const tampered = JSON.parse(JSON.stringify(obj));
  delete tampered.fingerprint;
  tampered.blockingSeverities = ['P1']; // silently drop P2
  assert.throws(() => rehydrateObjective(tampered), /no integrity fingerprint|weakened/);
});

test('an untracked file swapped for a symlink between lstat and read fails closed', async () => {
  const { collectWorkerDelta } = await import('../src/reviewloop/gitEvidence.js');
  const regular = {
    isSymbolicLink: () => false, isFile: () => true, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isDirectory: () => false,
    ino: 111, dev: 1, size: 5,
  };
  const symlinked = { ...regular, isSymbolicLink: () => true, isFile: () => false, ino: 222 };
  let lstatCall = 0;
  let readCalls = 0;
  // Drive collectWorkerDelta with a scripted git that reports exactly one
  // untracked path, then a lstat that flips regular -> symlink across the read.
  const { default: events } = await import('node:events');
  const scripted = (_cmd, cmdArgs) => {
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    const key = cmdArgs.join(' ');
    queueMicrotask(() => {
      if (key.includes('ls-files --others')) child.stdout.emit('data', Buffer.from('leak\0'));
      if (key.includes('rev-parse')) child.stdout.emit('data', Buffer.from('HEADSHA\n'));
      if (key.includes('diff')) child.stdout.emit('data', Buffer.from(''));
      if (key.includes('status')) child.stdout.emit('data', Buffer.from(''));
      child.emit('close', 0);
    });
    return child;
  };
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'HEADSHA', baselineRef: 'HEADSHA', untrackedHashes: {}, evidenceComplete: true },
    spawn: scripted,
    lstat: async () => { lstatCall += 1; return lstatCall === 1 ? regular : symlinked; },
    readFile: async () => { readCalls += 1; return Buffer.from('12345'); },
    // The path passed the by-name pre-check as a regular file, then a symlink
    // was swapped in before the authoritative open: O_NOFOLLOW makes open fail
    // with ELOOP and the bytes are never read.
    open: async () => { const e = new Error('ELOOP: too many symbolic links'); e.code = 'ELOOP'; throw e; },
    realpath: async (p) => p,
  });
  assert.equal(delta.evidenceComplete, false, 'a mid-read swap fails the evidence closed');
  assert.equal(readCalls, 0, 'the swapped-in symlink target was never read');
  assert.ok((delta.incompleteReasons ?? []).some((r) => /changed during read|symlink/i.test(r)), JSON.stringify(delta.incompleteReasons));
});

// ---------------------------------------------------------------------------
// 10. baseline Gate mutation is NOT attributed to the Worker delta.
// ---------------------------------------------------------------------------
test('a baseline Gate that mutates a tracked file re-captures the baseline (no Worker mis-attribution)', async () => {
  let gateRuns = 0;
  const baselines = [
    { head: 'H', capturedAt: 't0', dirtyFiles: [], evidenceComplete: true },
    { head: 'H', capturedAt: 't1', dirtyFiles: ['snapshot.json'], evidenceComplete: true },
  ];
  let capIdx = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => baselines[Math.min(capIdx++, baselines.length - 1)],
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run snapshot'], manifestFingerprint: 'mf' }),
    runGateFn: async () => { gateRuns += 1; return { verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal(gateRuns, 1, 'baseline Gate ran at begin');
  assert.equal(capIdx, 2, 'baseline was captured a second time AFTER the baseline Gate');
  const st = await controller._persistence.readWorkflowState(loopId);
  assert.deepEqual(st.reviewLoop.objective.baseline.dirtyFiles, ['snapshot.json'],
    'the objective baseline reflects the post-Gate tree');
});

// ---------------------------------------------------------------------------
// 12. doctor detects a stale MCP path and accepts the current one.
// ---------------------------------------------------------------------------
test('checkMcpServerBinding warns on a stale gpt-dev-loop MCP path and passes the current one', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-doctor-home-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-doctor-cfg-'));
  try {
    const expected = path.resolve(new URL('../bin/reviewloop-mcp.js', import.meta.url).pathname);

    const staleExec = (cmd) => {
      if (/^claude mcp get/.test(cmd)) return `reviewloop:\n  Command: node\n  Args: /old/gpt-dev-loop/bin/reviewloop-mcp.js\n`;
      throw new Error('not registered');
    };
    fs.mkdirSync(path.join(cfgDir), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { reviewloop: { command: 'node', args: ['/old/gpt-dev-loop/bin/reviewloop-mcp.js'] } },
    }));
    const stale = checkMcpServerBinding({ execSync: staleExec, homeDir: home, configDir: cfgDir });
    assert.equal(stale.ok, false);
    assert.ok(stale.issues.some((i) => /claude/.test(i) && /install-global/.test(i)));
    assert.ok(stale.issues.some((i) => /agy/.test(i)));

    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { reviewloop: { command: 'node', args: [expected] } },
    }));
    const currentExec = (cmd) => {
      if (/^claude mcp get/.test(cmd)) return `reviewloop:\n  Command: node\n  Args: ${expected}\n`;
      throw new Error('not registered');
    };
    const good = checkMcpServerBinding({ execSync: currentExec, homeDir: home, configDir: cfgDir });
    assert.equal(good.ok, true, JSON.stringify(good.issues));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. install rollback must not lose the user's legacy skill.
// ---------------------------------------------------------------------------
test('a failing install rolls back without deleting the legacy SuperGPT skill', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-inst-home-'));
  const cfgDir = path.join(home, '.gemini', 'config');
  const legacySkillDir = path.join(cfgDir, 'skills', 'supergpt');
  try {
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(path.join(legacySkillDir, 'SKILL.md'), 'the user legacy skill');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'user gemini rules\n');

    // Force a failure AFTER the legacy-skill deletion point used to run: make
    // the claude policy path unwritable by pointing it at a directory.
    const claudeDir = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(claudeDir, { recursive: true });

    let threw = false;
    try {
      await installGlobal({
        configDir: cfgDir,
        homeDir: home,
        execFileSync: (command, args = []) => {
          if (args[0] === '--version') return `${command} test\n`;
          if (args.includes('mcp')) return 'ok\n';
          return '';
        },
      });
    } catch { threw = true; }

    assert.equal(threw, true, 'install failed as engineered');
    assert.equal(fs.existsSync(path.join(legacySkillDir, 'SKILL.md')), true,
      'the legacy skill survived the rolled-back install');
    assert.equal(fs.readFileSync(path.join(legacySkillDir, 'SKILL.md'), 'utf8'), 'the user legacy skill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
