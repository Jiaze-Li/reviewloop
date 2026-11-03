import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectSpend, formatSpendInspection } from '../src/reviewloop/spendInspect.js';
import { Persistence } from '../src/orchestrator/persistence.js';

const ID = 'rl-20261102074142-9c4ea0a3';
const OP = ID + ':round-9:chunk-1';
const RESP = 'provider returned extra data / SECRET MUST NOT LEAK';

function fakeState() {
  return {
    reviewLoop: { loopId: ID, state: 'HUMAN_REQUIRED', round: 9 },
    modelSpendReservations: {
      res1: {
        reservationId: 'res1', taskId: OP, role: 'reviewer', family: 'agy:opus',
        provider: 'agy', physicalAttempt: 1, status: 'UNRESOLVED',
        createdAt: '2026-11-02T08:00:00Z', dispatchStartedAt: '2026-11-02T08:00:01Z',
        settledAt: '2026-11-02T08:03:01Z', settlementReason: 'AGY_TIMEOUT',
        usageCallId: null, usageReference: null,
        failureDiagnostics: { code: 'AGY_TIMEOUT', exitCode: 124, durationMs: 180000,
          stderrExcerpt: RESP, envelope: { rawPrompt: RESP }, usageEvidenceState: 'absent', stdoutWasEmpty: true },
      },
    },
    reviewLoopSpend: { records: [] },
    unrelated: { raw: RESP },
  };
}

test('inspect-spend is strictly read-only and never exposes raw provider diagnostic text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-p0-inspect-'));
  try {
    const p = new Persistence(dir);
    await p.writeWorkflowState(ID, fakeState());
    const stateFile = path.join(dir, ID, 'workflow.json');
    const original = await readFile(stateFile, 'utf8');
    const result = await inspectSpend({ persistence: p, loopId: ID, operationId: OP });
    assert.equal(result.readOnly, true);
    assert.equal(result.reservationCount, 1);
    assert.equal(result.reservations[0].status, 'UNRESOLVED');
    assert.deepEqual(result.reservations[0].flags, ['UNRESOLVED_UNKNOWN_USAGE']);
    assert.equal(result.reservations[0].diagnostic.code, 'AGY_TIMEOUT');
    assert.equal(result.reservations[0].spendRecords.length, 0);
    assert.equal(JSON.stringify(result).includes(RESP), false, 'no stderr or provider response leakage');
    assert.equal(formatSpendInspection(result).includes(RESP), false);
    assert.equal(await readFile(stateFile, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inspector flags settled-without-spend and duplicate references without fabricating accounting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-p0-inspect-'));
  try {
    const p = new Persistence(dir);
    const state = fakeState();
    state.modelSpendReservations.res1.status = 'SETTLED_KNOWN';
    state.modelSpendReservations.res1.settlementReason = 'PROVIDER_CALL_SUCCEEDED';
    await p.writeWorkflowState(ID, state);
    const first = await inspectSpend({ persistence: p, loopId: ID, reservationId: 'res1' });
    assert.deepEqual(first.reservations[0].flags, ['SETTLED_WITHOUT_SPEND_RECORD']);
    assert.equal(first.reservations[0].spendRecords.length, 0);
    state.reviewLoopSpend.records = [
      { reservationId: 'res1', usageKnown: true, usageVolume: 1432, costKnown: false,
        usageBreakdown: { inputTokens: 1400, outputTokens: 32 }, rawUsage: { raw: RESP } },
      { reservationId: 'res1', usageKnown: true, usageVolume: 1432, costKnown: false,
        rawUsage: { raw: RESP } },
    ];
    await p.writeWorkflowState(ID, state);
    const duplicates = await inspectSpend({ persistence: p, loopId: ID, reservationId: 'res1' });
    assert.deepEqual(duplicates.reservations[0].flags, ['DUPLICATE_SPEND_RECORDS']);
    assert.equal(duplicates.reservations[0].spendRecords.length, 2);
    assert.equal(duplicates.reservations[0].spendRecords[0].usageVolume, 1432);
    assert.equal(duplicates.reservations[0].spendRecords[0].costUsd, null);
    assert.equal(JSON.stringify(duplicates).includes(RESP), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual CLI inspect-spend operates on an isolated workflow file and changes no bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-p0-inspect-cli-'));
  try {
    const p = new Persistence(dir);
    await p.writeWorkflowState(ID, fakeState());
    const file = path.join(dir, ID, 'workflow.json');
    const before = await readFile(file, 'utf8');
    const cli = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
    const run = (...args) => spawnSync(process.execPath,
      [cli, 'inspect-spend', '--loop', ID, ...args, '--json'], {
        env: { ...process.env, REVIEWLOOP_RUNTIME_DIR: dir },
        encoding: 'utf8', timeout: 15000,
      });
    const ok = run('--operation', OP);
    assert.equal(ok.status, 0, ok.stderr);
    const result = JSON.parse(ok.stdout);
    assert.equal(result.reservations[0].status, 'UNRESOLVED');
    assert.equal(JSON.stringify(result).includes(RESP), false);
    assert.equal(await readFile(file, 'utf8'), before);
    const denied = run('--reservation', 'res1', '--operation', OP);
    assert.notEqual(denied.status, 0);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
