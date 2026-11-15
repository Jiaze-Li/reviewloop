// Deterministic, zero-provider static context-footprint metric. This is NOT a
// claim about real provider token billing — it is the always-loaded Worker
// context tax that the ReviewLoop design mechanically minimizes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';

function measure() {
  const server = createReviewLoopMcpServer({
    controller: { begin: async () => ({}), review: async () => ({}) },
  });
  const tools = server._registeredTools ?? server.registeredTools ?? {};
  const names = Object.keys(tools);
  let schemaBytes = 0;
  for (const name of names) {
    const t = tools[name];
    schemaBytes += Buffer.byteLength(JSON.stringify({
      description: t.description ?? '',
      inputSchema: t.inputSchema ? Object.keys(t.inputSchema) : [],
    }), 'utf8');
  }
  const commonBytes = Buffer.byteLength(readFileSync(new URL('../agent-policy/COMMON.md', import.meta.url), 'utf8'), 'utf8');
  const passPayload = Buffer.byteLength(JSON.stringify({
    status: 'PASS', loopId: 'rl-x', round: 1, reviewer: 'internal',
    nonBlockingFindings: [], nonBlockingOmitted: 0,
    telemetry: { reviewerCalls: 1, supervisorCalls: 0, workerUsage: 'external / not observable by ReviewLoop' },
  }), 'utf8');
  const reworkPayload = Buffer.byteLength(JSON.stringify({
    status: 'REWORK', loopId: 'rl-x', round: 1, maxRounds: 3,
    blockingFindings: [{ severity: 'P1', file: 'a.js', line: 1, title: 'bug', signature: 'P1:a.js:bug' }],
    nonBlockingCount: 0, gate: { verdict: 'PASS', failures: [] }, supervisorGuidance: null,
    nextAction: 'Fix the blocking findings in this same session, then call reviewloop_review again.',
  }), 'utf8');
  return {
    workerFacingTools: names, commonBytes, schemaBytes, passPayload, reworkPayload,
  };
}

test('exactly two Worker-facing MCP tools', () => {
  const m = measure();
  assert.deepEqual(m.workerFacingTools.sort(), ['reviewloop_begin', 'reviewloop_review']);
});

test('COMMON stays under the 3.2KB Worker-context target', () => {
  // Budget raised from 2560 to 3200 bytes, deliberately: the unified Design flow
  // (reviewTarget + designSha256) and the personal-skills method entry add ~560 bytes.
  assert.ok(measure().commonBytes <= 3200, `COMMON is ${measure().commonBytes} bytes`);
});

test('PASS / REWORK payloads stay compact (no raw evidence blobs)', () => {
  const m = measure();
  assert.ok(m.passPayload < 500, `PASS payload ${m.passPayload}B`);
  assert.ok(m.reworkPayload < 1200, `REWORK payload ${m.reworkPayload}B`);
});

test('footprint report is emitted for the record', () => {
  const m = measure();
  // eslint-disable-next-line no-console
  console.log('[context-footprint]', JSON.stringify({
    commonBytes: m.commonBytes,
    workerFacingMcpTools: m.workerFacingTools.length,
    combinedMcpSchemaBytes: m.schemaBytes,
    passPayloadBytes: m.passPayload,
    reworkPayloadBytes: m.reworkPayload,
  }));
  assert.ok(m.schemaBytes > 0);
});

// The Worker Policy's call shapes (issue #40) must keep matching the real MCP
// schema, so a rename cannot silently leave the policy teaching a wrong shape.
test('COMMON call shapes match the MCP input schema', () => {
  const common = readFileSync(new URL('../agent-policy/COMMON.md', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/mcp/reviewloopMcpServer.js', import.meta.url), 'utf8');
  for (const field of ['evidenceRequirements', 'requirementId', 'summary', 'cwd', 'contractText', 'reviewTarget', 'designSha256']) {
    assert.ok(common.includes(field), `COMMON should mention ${field}`);
    assert.ok(server.includes(`${field}:`) || server.includes(`${field},`), `MCP server should define ${field}`);
  }
});
