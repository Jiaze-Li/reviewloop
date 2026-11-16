// The statusLine must reach the person even when the Worker does not repeat it,
// and progress must use the client's own token with increasing values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createReviewLoopMcpServer, progressNotifier, toolResultContent } from '../src/mcp/reviewloopMcpServer.js';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';

test('statusLine is the first content block of begin and review results', async () => {
  const { controller } = makeHarness({ reviews: [{ findings: [finding('P1')] }] });
  const server = createReviewLoopMcpServer({ controller });
  const client = new Client({ name: 'status-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const begin = await client.callTool({ name: 'reviewloop_begin', arguments: { goal: 'g', cwd: process.cwd() } });
  assert.match(begin.content[0].text, /^\[ReviewLoop \| code \| 启动\] loopId=/);
  assert.equal(JSON.parse(begin.content[1].text).loopId, begin.structuredContent.loopId);

  const progress = [];
  const review = await client.callTool(
    { name: 'reviewloop_review', arguments: { loopId: begin.structuredContent.loopId } },
    undefined,
    { onprogress: (p) => progress.push(p) },
  );
  assert.match(review.content[0].text, /^\[ReviewLoop \| code \| 第 1 轮 → REWORK\] loopId=/);
  assert.equal(JSON.parse(review.content[1].text).status, 'REWORK');
  assert.ok(progress.some((p) => /gate_running/.test(p.message)), JSON.stringify(progress));
  assert.ok(progress.some((p) => /reviewer_running chunk 1\/1/.test(p.message)), JSON.stringify(progress));
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i].progress > progress[i - 1].progress);
  await client.close();
});

test('no progress is sent when the client supplied no progressToken', async () => {
  const sent = [];
  assert.equal(progressNotifier({ sendNotification: async (n) => sent.push(n) }, 'rl-x'), undefined);
  const notify = progressNotifier({ _meta: { progressToken: 7 }, sendNotification: async (n) => sent.push(n) }, 'rl-x');
  await notify('a'); await notify('b');
  assert.deepEqual(sent.map((n) => [n.params.progressToken, n.params.progress]), [[7, 1], [7, 2]]);
});

test('a result without statusLine keeps the single JSON block', () => {
  assert.equal(toolResultContent({ status: 'X' }).length, 1);
});
