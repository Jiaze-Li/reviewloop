// Quota preflight uses only the read-only /usage command, never a model turn.
// Every test injects a fake CLI; no real AGY process or provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyQuotaUsage, createAgyQuotaPreflight } from '../src/agy/agyQuotaProbe.js';
import { QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';

const NOW = Date.parse('2026-10-10T09:00:00Z');
const reset = (hours) => new Date(NOW + hours * 3600_000).toISOString();
const usage = (groups) => JSON.stringify({
  status: 'SUCCESS', num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: { name: 'usage', data: { groups } },
});
const group = (name, buckets) => ({ name, buckets });

test('structured /usage: a depleted Claude/GPT window cools that pool, not Gemini', async () => {
  const calls = [];
  const fakeExec = (_command, args, options) => {
    calls.push({ args, options });
    return args.includes('--version') ? 'agy version 1.2.6' : usage([
      group('Claude and GPT models', [
        { window: '5h', remaining_fraction: 0.6, reset_time: reset(5) },
        { window: 'weekly', remaining_fraction: 0, reset_time: reset(72) },
      ]),
      group('Gemini Models', [
        { window: '5h', remaining_fraction: 0.4, reset_time: reset(5) },
        { window: 'weekly', remaining_fraction: 0.8, reset_time: reset(72) },
      ]),
    ]);
  };
  const registry = new QuotaPoolRegistry({ filePath: null, now: () => NOW });
  const preflight = createAgyQuotaPreflight({
    quotaRegistry: registry, exec: fakeExec, now: () => NOW, cwd: '/tmp/empty',
    geminiDir: '/tmp/isolated-gemini', ttlMs: 90_000,
  });
  assert.deepEqual(await preflight(), { checked: true, exhaustedPools: ['agy-claude-gpt'] });
  assert.equal(registry.usable('agy:opus'), false);
  assert.equal(registry.usable('agy:sonnet'), false);
  assert.equal(registry.usable('agy:gpt-oss'), false);
  assert.equal(registry.usable('agy:gemini-reviewer'), true);
  assert.equal(registry.get('agy-claude-gpt').resetAt, reset(72));
  assert.equal(registry.get('agy-claude-gpt').source, 'agy_usage_preflight');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [
    '--print=/usage', '--output-format', 'json', '--gemini_dir=/tmp/isolated-gemini',
  ]);
  assert.equal(calls[1].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(calls[1].options.cwd, '/tmp/empty');
  assert.ok(!calls[1].args.includes('--disable-slash-commands'));
  assert.deepEqual(await preflight(), { checked: false, reason: 'cached' });
  assert.equal(calls.length, 2, '90-second TTL avoids hammering /usage');
});

test('async AGY quota CLI responses keep the same cooldown without repeated ledger writes', async () => {
  let current = NOW;
  let calls = 0;
  const registry = new QuotaPoolRegistry({ filePath: null, now: () => current });
  const preflight = createAgyQuotaPreflight({
    quotaRegistry: registry, now: () => current, ttlMs: 90_000,
    exec: async (_cmd, args) => {
      calls += 1;
      return { stdout: args.includes('--version') ? 'agy version 1.2.6' : usage([
        group('Claude and GPT models', [{ remaining_fraction: 0, reset_time: reset(72) }]),
      ]) };
    },
  });
  assert.equal((await preflight()).checked, true);
  const original = registry.get('agy-claude-gpt');
  assert.equal(original.failures, 1);
  current += 90_001;
  assert.equal((await preflight()).checked, true);
  assert.equal(registry.get('agy-claude-gpt').failures, 1);
  assert.equal(registry.get('agy-claude-gpt').resetAt, reset(72));
  assert.equal(calls, 4, 'two version checks and two quota reads; no model calls');
});

test('all exhausted windows must recover before a shared quota pool becomes eligible', () => {
  const entries = parseAgyQuotaUsage(usage([
    group('Gemini Models', [
      { window: '5h', remaining_fraction: 0, reset_time: reset(5) },
      { window: 'weekly', remaining_fraction: 0, reset_time: reset(72) },
    ]),
  ]), NOW);
  assert.deepEqual(entries, [{ poolId: 'agy-gemini', resetAt: reset(72) }]);
});

test('malformed /usage, paid-turn envelope, and unrelated groups never suppress routing', async () => {
  const snapshots = [
    'not json', JSON.stringify({ status: 'ERROR', num_turns: 0, usage: { total_tokens: 0 } }),
    JSON.stringify({ status: 'SUCCESS', num_turns: 1, usage: { total_tokens: 30 }, command: { name: 'usage', data: { groups: [] } } }),
    JSON.stringify({ status: 'SUCCESS', num_turns: 0, usage: { total_tokens: 0 }, command: { name: 'unknown', data: { groups: [] } } }),
  ];
  for (const payload of snapshots) assert.equal(parseAgyQuotaUsage(payload, NOW), null);
  assert.deepEqual(parseAgyQuotaUsage(usage([
    group('Unrelated pool', [{ remaining_fraction: 0, reset_time: reset(12) }]),
    group('Claude and GPT models', [{ remaining_fraction: 0.1, reset_time: reset(12) }]),
  ]), NOW), []);
});

test('unsupported AGY builds never run /usage (older versions treated slash text as a paid prompt)', async () => {
  const calls = [];
  const preflight = createAgyQuotaPreflight({
    quotaRegistry: new QuotaPoolRegistry({ filePath: null, now: () => NOW }),
    exec: (_cmd, args) => { calls.push(args); return 'agy version 1.1.10'; }, now: () => NOW,
  });
  assert.deepEqual(await preflight(), { checked: false, reason: 'unsupported_version' });
  assert.deepEqual(calls, [['--version']]);
});

test('quota probe failures preserve the original routing state, not an invented availability verdict', async () => {
  const registry = new QuotaPoolRegistry({ filePath: null, now: () => NOW });
  const result = await createAgyQuotaPreflight({
    quotaRegistry: registry, now: () => NOW,
    exec: (_cmd, args) => {
      if (args.includes('--version')) return '1.2.6';
      throw new Error('offline');
    },
  })();
  assert.deepEqual(result, { checked: false, reason: 'probe_unavailable' });
  assert.equal(registry.usable('agy:opus'), true);
});
