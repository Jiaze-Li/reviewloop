// Implements docs/workflow/PERSISTENCE.md §1-4 (state.json, events.jsonl,
// artifact store), one directory per (workflow_id, task_id).

import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export class Persistence {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  taskDir(workflowId, taskId) {
    return path.join(this.baseDir, workflowId, taskId);
  }

  async ensureTaskDir(workflowId, taskId) {
    const dir = this.taskDir(workflowId, taskId);
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    return dir;
  }

  // PERSISTENCE.md §1 — snapshot, overwritten on every transition.
  async writeState(state) {
    const dir = await this.ensureTaskDir(state.workflow_id, state.task_id);
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  async readState(workflowId, taskId) {
    const dir = this.taskDir(workflowId, taskId);
    const raw = await readFile(path.join(dir, 'state.json'), 'utf8');
    return JSON.parse(raw);
  }

  // Workflow-scoped state (one level above a task): persistent role
  // conversation ownership for the whole workflow — the Supervisor's single
  // conversation id and the Reviewer's per-task conversation ids. Written by
  // src/orchestrator/agyProviderSessions.js as those ids are captured, read
  // back on resume so the same agy conversations are continued rather than
  // recreated. Snapshot, overwritten on every update.
  workflowDir(workflowId) {
    return path.join(this.baseDir, workflowId);
  }

  async writeWorkflowState(workflowId, state) {
    if (typeof workflowId !== 'string' || workflowId === '') {
      throw new Error('writeWorkflowState requires a non-empty workflowId');
    }
    const dir = this.workflowDir(workflowId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'workflow.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  // Shallow read-modify-write merge of the workflow-scoped snapshot. Used to
  // persist partial workflow progress without clobbering unrelated workflow
  // state.
  async updateWorkflowState(workflowId, patch) {
    if (typeof workflowId !== 'string' || workflowId === '') {
      throw new Error('updateWorkflowState requires a non-empty workflowId');
    }
    const current = (await this.readWorkflowState(workflowId)) ?? {};
    const next = { ...current, ...(patch ?? {}) };
    await this.writeWorkflowState(workflowId, next);
    return next;
  }

  async readWorkflowState(workflowId) {
    try {
      const raw = await readFile(path.join(this.workflowDir(workflowId), 'workflow.json'), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Immutable acceptance version chain (src/orchestrator/taskCard.js). Stored
  // inside the workflow-scoped snapshot so every consumer on resume reads the
  // same current active acceptance version. The chain itself is append-only;
  // this only ever replaces the pointer/history wholesale with a superset.
  // `taskId` (optional) namespaces the chain per task inside the same workflow
  // snapshot (`acceptanceChains[taskId]`), so a multi-task workflow keeps one
  // independent, append-only chain per Task Card. Omitting it keeps the legacy
  // single workflow-scoped `acceptanceChain` pointer.
  async writeAcceptanceChain(workflowId, chain, taskId = null) {
    if (!chain || !Array.isArray(chain.versions) || chain.versions.length === 0) {
      throw new Error('writeAcceptanceChain requires a non-empty acceptance chain');
    }
    const current = await this.readAcceptanceChain(workflowId, taskId);
    if (current && chain.versions.length < current.versions.length) {
      throw new Error('writeAcceptanceChain refused: acceptance history must not shrink');
    }
    if (taskId) {
      const state = (await this.readWorkflowState(workflowId)) ?? {};
      const chains = { ...(state.acceptanceChains ?? {}), [taskId]: chain };
      await this.updateWorkflowState(workflowId, { acceptanceChains: chains });
    } else {
      await this.updateWorkflowState(workflowId, { acceptanceChain: chain });
    }
    return chain;
  }

  async readAcceptanceChain(workflowId, taskId = null) {
    const state = await this.readWorkflowState(workflowId);
    if (taskId) return state?.acceptanceChains?.[taskId] ?? null;
    return state?.acceptanceChain ?? null;
  }

  // PERSISTENCE.md §2 — append-only event log, one JSON object per line.
  async appendEvent(event) {
    const dir = await this.ensureTaskDir(event.workflow_id, event.task_id);
    await appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(workflowId, taskId) {
    const dir = this.taskDir(workflowId, taskId);
    try {
      const raw = await readFile(path.join(dir, 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // PERSISTENCE.md §4 — artifact store: Task Card, Execution Reports,
  // Review Results, gate test_results. Immutable once written.
  async saveArtifact(workflowId, taskId, name, content) {
    const dir = await this.ensureTaskDir(workflowId, taskId);
    const filePath = path.join(dir, 'artifacts', name);
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await writeFile(filePath, body, 'utf8');
    return filePath;
  }
}
