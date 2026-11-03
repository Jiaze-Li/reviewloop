import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, readFile, readdir, open, rename, unlink, stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicReplaceUtf8 } from '../src/orchestrator/atomicSnapshot.js';
import { Persistence } from '../src/orchestrator/persistence.js';

async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-p0-atomic-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const fsOps = { open, rename, unlink };

test('crash-safe workflow snapshot replacement publishes complete old or new JSON', async () => {
  await fixture(async root => {
    const p = new Persistence(root);
    const wf = 'rl-p0-atomic';
    const first = { reviewLoop: { state: 'REVIEWING' }, modelSpendReservations: { r1: { status: 'DISPATCHING' } } };
    await p.writeWorkflowState(wf, first);
    const file = path.join(root, wf, 'workflow.json');
    const old = await readFile(file, 'utf8');

    const io = {
      ...fsOps,
      rename: async () => { throw new Error('injected crash before atomic promotion'); },
    };
    await assert.rejects(
      () => atomicReplaceUtf8(file, JSON.stringify({ modelSpendReservations: {} }), { io }),
      /injected crash/,
    );
    assert.equal(await readFile(file, 'utf8'), old,
      'the original reservation must not be truncated on pre-rename crash');
    assert.deepEqual(await readdir(path.dirname(file)), ['workflow.json'],
      'failed staging must not leave an incomplete temp snapshot');

    const next = { ...first, modelSpendReservations: { r1: { status: 'SETTLED_KNOWN' } } };
    await p.writeWorkflowState(wf, next);
    assert.deepEqual(await p.readWorkflowState(wf), next);
    assert.equal((await stat(file)).isFile(), true);
    assert.deepEqual(await readdir(path.dirname(file)), ['workflow.json']);
  });
});

test('failed temp-file fsync never changes the existing durable workflow', async () => {
  await fixture(async root => {
    const dir = path.join(root, 'loop');
    const p = new Persistence(root);
    await p.writeWorkflowState('loop', { reviewLoop: { state: 'REWORK' } });
    const file = path.join(dir, 'workflow.json');
    const original = await readFile(file, 'utf8');

    const io = {
      ...fsOps,
      open: async (target, flags, mode) => {
        const fh = await open(target, flags, mode);
        if (String(target).endsWith('.tmp')) {
          return {
            writeFile: (...args) => fh.writeFile(...args),
            sync: async () => { throw new Error('injected temp fsync failure'); },
            close: (...args) => fh.close(...args),
          };
        }
        return fh;
      },
    };
    await assert.rejects(
      () => atomicReplaceUtf8(file, JSON.stringify({ reviewLoop: { state: 'PASS' } }), { io }),
      /injected temp fsync failure/,
    );
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(dir), ['workflow.json']);
  });
});

test('directory fsync failure is surfaced as an ambiguous commit, never silently ignored', async () => {
  await fixture(async root => {
    const p = new Persistence(root);
    await p.writeWorkflowState('loop', { original: true });
    const dir = path.join(root, 'loop');
    const file = path.join(dir, 'workflow.json');
    const io = {
      ...fsOps,
      open: async (target, flags, mode) => {
        const fh = await open(target, flags, mode);
        if (target === dir && flags === 'r') {
          return {
            sync: async () => { throw new Error('injected directory fsync failure'); },
            close: (...args) => fh.close(...args),
          };
        }
        return fh;
      },
    };
    await assert.rejects(
      () => atomicReplaceUtf8(file, JSON.stringify({ original: false }), { io }),
      /injected directory fsync failure/,
    );
    // Rename may already have happened. Caller MUST observe an error instead
    // of trusting a success and dispatching a new paid call.
    assert.deepEqual(await p.readWorkflowState('loop'), { original: false });
    assert.deepEqual(await readdir(dir), ['workflow.json']);
  });
});
