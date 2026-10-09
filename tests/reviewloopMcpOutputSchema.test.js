// Strict-client regression: every structuredContent the reviewloop MCP tools
// return must validate against the advertised outputSchema. The MCP SDK Client
// does exactly this (Ajv over the tool's JSON-Schema outputSchema) and throws on
// mismatch, so a real Client over an in-memory transport is the strict client.
// Zero model calls: the controller is the deterministic in-memory harness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';

async function connect(harnessOpts) {
  const { controller } = makeHarness(harnessOpts);
  const server = createReviewLoopMcpServer({ controller });
  const client = new Client({ name: 'strict-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

// Every top-level key of structuredContent must be declared by the schema.
async function declaredKeys(client, name) {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool?.outputSchema, `${name} advertises an outputSchema`);
  return new Set(Object.keys(tool.outputSchema.properties));
}

async function strictCall(client, name, args) {
  // Client.callTool validates structuredContent against outputSchema and throws
  // McpError on any violation (incl. undeclared fields when the schema is closed).
  const res = await client.callTool({ name, arguments: args });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  return res.structuredContent;
}

for (const [label, opts] of [
  ['REWORK with blocking finding', { reviews: [{ findings: [finding('P1')] }] }],
  ['PASS', { reviews: [{ findings: [] }] }],
]) {
  test(`strict client: reviewloop_begin + reviewloop_review (${label}) validate against outputSchema`, async () => {
    const { client } = await connect(opts);
    const begin = await strictCall(client, 'reviewloop_begin', { goal: 'g', cwd: process.cwd() });
    const beginKeys = await declaredKeys(client, 'reviewloop_begin');
    for (const k of Object.keys(begin)) assert.ok(beginKeys.has(k), `begin returned undeclared field ${k}`);

    const review = await strictCall(client, 'reviewloop_review', { loopId: begin.loopId });
    const reviewKeys = await declaredKeys(client, 'reviewloop_review');
    for (const k of Object.keys(review)) assert.ok(reviewKeys.has(k), `review returned undeclared field ${k}`);
    await client.close();
  });
}

test('strict client: multi-round REWORK -> HUMAN_REQUIRED -> terminal replay all validate, no fields dropped', async () => {
  const deltas = [1, 2, 3, 4, 5, 6].map((i) => ({ fingerprint: `fp${i}`, diff: `diff${i}`, changedFiles: ['a.js'] }));
  const { client } = await connect({ deltas, reviews: [{ findings: [finding('P1', 'a.js', 'bug')] }] });
  const { loopId } = await strictCall(client, 'reviewloop_begin', { goal: 'g', cwd: process.cwd() });
  const keys = await declaredKeys(client, 'reviewloop_review');
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const out = await strictCall(client, 'reviewloop_review', { loopId });
    seen.add(out.status);
    for (const k of Object.keys(out)) assert.ok(keys.has(k), `${out.status} returned undeclared field ${k}`);
    if (out.status === 'REWORK') {
      // diagnostics survive: round-budget counters and gate verdict are present
      assert.equal(typeof out.maxRounds, 'number');
      assert.ok(out.gate && typeof out.gate.verdict === 'string');
    }
  }
  assert.ok(seen.has('REWORK') && seen.has('HUMAN_REQUIRED'),`statuses seen: ${[...seen]}`);
});

test('strict client: PHASE_PASS and final PASS on a phased loop validate', async () => {
  const { client } = await connect({ reviews: [{ findings: [] }] });
  const { loopId } = await strictCall(client, 'reviewloop_begin', {
    goal: 'g', cwd: process.cwd(),
    phases: [{ id: 'p1', objective: 'o', exitCriteria: ['c'] }],
  });
  const keys = await declaredKeys(client, 'reviewloop_review');
  for (let i = 0; i < 2; i += 1) {
    const out = await strictCall(client, 'reviewloop_review', { loopId });
    for (const k of Object.keys(out)) assert.ok(keys.has(k), `${out.status} returned undeclared field ${k}`);
  }
});
