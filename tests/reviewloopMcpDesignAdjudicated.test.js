// A real MCP client (Ajv over the advertised outputSchema) must accept a Design
// review result that carries `adjudicatedDesignSha256`, on every adjudicated
// outcome, and the field must be declared by the schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';
import { designContentSha256 } from '../src/reviewloop/designTarget.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const PLAN = '# Plan\n- Goal: ship a thing';
const DESIGN = '# Design\n\n## Options\n- A: reuse\n\n## Assumptions\nNone\n';
const adj = (over = {}) => ({
  comparison: { verdict: 'ALIGNED', reason: 'same', workerSummary: 'w', planConcern: null },
  blockingFindings: over.blockingFindings ?? [],
  nonBlockingFindings: [],
  humanQuestions: over.humanQuestions ?? [],
  designPassComment: 'designPassComment' in over ? over.designPassComment : 'Builds the thing.',
});

function gitRepo() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rl-mcp-design-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@e.x'); g('config', 'user.name', 't');
  writeFileSync(path.join(cwd, 'README.md'), 'x');
  g('add', '.'); g('commit', '-qm', 'init');
  return cwd;
}

async function connect(cwd, supervisor) {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      const text = (await import('node:fs')).readFileSync(path.join(cwd, 'Prompt.md'), 'utf8');
      return {
        baselineHead: 'B', currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['Prompt.md'],
        fingerprint: designContentSha256(text), diff: `--- Worker untracked file Prompt.md (${Buffer.byteLength(text)} bytes) ---\n${text}`,
      };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['true'], manifestFingerprint: 'f' }),
    designReviewerFn: async (a) => ({
      value: a.stage === 'files' ? { requestedFiles: [] } : { proposals: [{ title: 'Reuse', summary: 's', tradeoffs: 't' }], confidenceNote: '' },
      usage: { input_tokens: 1, output_tokens: 1 }, model: 'm',
    }),
    designSupervisorFn: async () => ({ value: supervisor(), usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
    reviewerFn: async () => { throw new Error('single-pass reviewer must not run'); },
  });
  const server = createReviewLoopMcpServer({ controller });
  const client = new Client({ name: 'strict-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

for (const [label, supervisor, status] of [
  ['REWORK', () => adj({ blockingFindings: [{ severity: 'P2', title: 'missing AC' }], designPassComment: null }), 'REWORK'],
  ['PASS', () => adj(), 'PASS'],
  ['HUMAN_REQUIRED (needs human)', () => ({ ...adj({ humanQuestions: ['Which user?'], designPassComment: null }), comparison: { verdict: 'NEEDS_HUMAN', reason: 'r', workerSummary: 'w', planConcern: null } }), 'HUMAN_REQUIRED'],
]) {
  test(`real MCP client: Design ${label} result with adjudicatedDesignSha256 validates against outputSchema`, async () => {
    const cwd = gitRepo();
    const client = await connect(cwd, supervisor);
    const begun = await client.callTool({ name: 'reviewloop_begin', arguments: { goal: 'g', cwd, taskType: 'design', contractText: PLAN, reviewTarget: 'Prompt.md' } });
    assert.notEqual(begun.isError, true, JSON.stringify(begun.content));
    writeFileSync(path.join(cwd, 'Prompt.md'), DESIGN);
    const res = await client.callTool({ name: 'reviewloop_review', arguments: { loopId: begun.structuredContent.loopId } });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const out = res.structuredContent;
    assert.equal(out.status, status);
    assert.equal(out.adjudicatedDesignSha256, designContentSha256(DESIGN));
    const { tools } = await client.listTools();
    const keys = Object.keys(tools.find((t) => t.name === 'reviewloop_review').outputSchema.properties);
    assert.ok(keys.includes('adjudicatedDesignSha256'), 'schema declares the field');
    await client.close();
    rmSync(cwd, { recursive: true, force: true });
  });
}
