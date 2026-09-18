import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function grep(pattern, paths) {
  try {
    return execSync(`git grep -n -E ${JSON.stringify(pattern)} -- ${paths}`, { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('no active SuperGPT MCP tool / CLI / server names remain', () => {
  const hits = grep('supergpt_route|supergpt_start_and_wait|supergptMcpServer|bin/supergpt\\.js', 'src bin agent-policy package.json');
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('active source has no Planner / Executor role, no Fast/Full path, no taskCohesion', () => {
  const hits = grep("DEFAULT_ROLE_POLICY\\.planner|DEFAULT_ROLE_POLICY\\.executor|taskCohesion|pathSelection\\.js|createPathSelection|FAST_PATH|FULL_PATH", 'src bin agent-policy');
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('removed modules are gone from the tree', () => {
  for (const f of [
    'src/orchestrator/planner.js',
    'src/orchestrator/taskCohesion.js',
    'src/orchestrator/pathSelection.js',
    'src/orchestrator/automatedLoop.js',
    'src/orchestrator/supergpt.js',
    'src/orchestrator/workflowWorktree.js',
    'src/orchestrator/adapters/claudeSessionManager.js',
    'src/mcp/supergptMcpServer.js',
    // The external-review engine: PR is now a review TARGET for the ONE
    // internal Reviewer engine, never an `@codex review` / `@claude review`
    // transport.
    'src/reviewloop/prReviewController.js',
    'src/reviewloop/prTrust.js',
    'src/reviewloop/threadResolution.js',
    'src/orchestrator/externalModelTriggerAuthority.js',
    'src/orchestrator/prCloseoutPolicy.js',
    'src/orchestrator/trustedPrReview.js',
  ]) {
    assert.equal(existsSync(new URL(f, new URL('..', import.meta.url))), false, f);
  }
});

test('COMMON is the ReviewLoop Worker Contract and mentions no retired concepts', () => {
  const common = readFileSync(new URL('../agent-policy/COMMON.md', import.meta.url), 'utf8');
  assert.match(common, /ReviewLoop Worker Contract/);
  assert.doesNotMatch(common, /Front[- ]Agent|route-first|DIRECT \| SUPERGPT|Fast Path|Full Path|\bPlanner\b|\bExecutor\b|Task Card|start_and_wait/);
  assert.doesNotMatch(common, /@codex review|@claude review/);
});

test('no active source posts an external @codex/@claude review trigger', () => {
  const hits = grep('@codex review|@claude review', 'src bin');
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('any remaining "supergpt" occurrences in src/bin are migration/compat-only', () => {
  const hits = grep('supergpt|SuperGPT', 'src bin');
  for (const line of hits) {
    assert.match(
      line,
      /install-plugin\.js|LEGACY|legacy|migrat|SUPERGPT-GLOBAL-POLICY|\.supergpt|supergpt\.\*|recordedBaselines|old runtime|auxiliary|worktree paths|V2 SuperGPT|those were V2/i,
      `unexpected active SuperGPT reference: ${line}`,
    );
  }
});

test('no silent diff truncation and no unwired PR backend remain', () => {
  assert.deepEqual(grep('slice\\(0, ?12000|no GitHub backend wired', 'src'), []);
});

test('the PR target reuses the ONE review engine (no second Reviewer state machine)', async () => {
  const controller = readFileSync(new URL('../src/reviewloop/controller.js', import.meta.url), 'utf8');
  // Both targets flow through the same evidence -> Reviewer routing path.
  assert.match(
    controller,
    /runReviewerOverEvidence\(\{\s*spend, loopState, objective, delta, gate, reviewScope, signal,?\s*\}\)/,
  );
  assert.doesNotMatch(controller, /createPrReviewController|PR_REVIEW_OUTCOMES|ExternalModelTriggerAuthority/);
});

test('package.json is renamed to reviewloop with reviewloop bins', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'reviewloop');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['reviewloop', 'reviewloop-mcp']);
  assert.match(pkg.description, /ReviewLoop/);
});
