import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Persistence } from '../src/orchestrator/persistence.js';

async function withPersistence(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'persistence-test-'));
  try {
    await fn(new Persistence(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readWorkflowState returns null before anything is written', async () => {
  await withPersistence(async (p) => {
    assert.equal(await p.readWorkflowState('wf-1'), null);
  });
});

test('writeWorkflowState -> readWorkflowState round-trips the snapshot', async () => {
  await withPersistence(async (p) => {
    const state = {
      workflow_id: 'wf-1',
      supervisor: { conversation_id: 'sup-conv-1' },
      reviewer: { conversations: { 'task-a': 'rev-conv-a', 'task-b': 'rev-conv-b' } },
    };
    await p.writeWorkflowState('wf-1', state);
    assert.deepEqual(await p.readWorkflowState('wf-1'), state);
  });
});

test('writeWorkflowState overwrites the previous snapshot', async () => {
  await withPersistence(async (p) => {
    await p.writeWorkflowState('wf-1', { supervisor: { conversation_id: 'a' }, reviewer: { conversations: {} } });
    await p.writeWorkflowState('wf-1', {
      supervisor: { conversation_id: 'a' },
      reviewer: { conversations: { 'task-a': 'rev-conv-a' } },
    });
    const back = await p.readWorkflowState('wf-1');
    assert.equal(back.supervisor.conversation_id, 'a');
    assert.deepEqual(back.reviewer.conversations, { 'task-a': 'rev-conv-a' });
  });
});

test('workflow state is keyed per workflow id', async () => {
  await withPersistence(async (p) => {
    await p.writeWorkflowState('wf-1', { supervisor: { conversation_id: 'one' } });
    await p.writeWorkflowState('wf-2', { supervisor: { conversation_id: 'two' } });
    assert.equal((await p.readWorkflowState('wf-1')).supervisor.conversation_id, 'one');
    assert.equal((await p.readWorkflowState('wf-2')).supervisor.conversation_id, 'two');
  });
});

test('writeWorkflowState fails closed on a missing workflow id', async () => {
  await withPersistence(async (p) => {
    await assert.rejects(() => p.writeWorkflowState('', { a: 1 }), /non-empty workflowId/);
  });
});

test('updateWorkflowState merges a patch without clobbering siblings', async () => {
  await withPersistence(async (p) => {
    await p.writeWorkflowState('wf-1', { supervisor: { conversation_id: 'sup-1' } });
    const merged = await p.updateWorkflowState('wf-1', { acceptanceChain: { id: 'c1' } });
    assert.equal(merged.supervisor.conversation_id, 'sup-1');
    assert.deepEqual(merged.acceptanceChain, { id: 'c1' });
    assert.deepEqual(await p.readWorkflowState('wf-1'), merged);
  });
});

test('updateWorkflowState fails closed on a missing workflow id', async () => {
  await withPersistence(async (p) => {
    await assert.rejects(() => p.updateWorkflowState('', { a: 1 }), /non-empty workflowId/);
  });
});

test('workflow state and task state live side by side without collision', async () => {
  await withPersistence(async (p) => {
    await p.writeState({ workflow_id: 'wf-1', task_id: 'task-a', last_error: 'x' });
    await p.writeWorkflowState('wf-1', { supervisor: { conversation_id: 'sup-1' } });
    assert.equal((await p.readState('wf-1', 'task-a')).last_error, 'x');
    assert.equal((await p.readWorkflowState('wf-1')).supervisor.conversation_id, 'sup-1');
  });
});
