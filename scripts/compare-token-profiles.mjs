#!/usr/bin/env node
// Human/offline A/B: compare two explicitly supplied durable workflow.json
// snapshots. Read-only. ZERO Reviewer/Supervisor calls and ZERO state writes.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { evaluatePairedTokenProfiles, formatPairedTokenEvaluation } from '../src/reviewloop/tokenExperiment.js';

const [beforePath, afterPath, ...rest] = process.argv.slice(2);
if (!beforePath || !afterPath || rest.some((x) => x !== '--json')) {
  console.error('Usage: node scripts/compare-token-profiles.mjs BEFORE_WORKFLOW.json AFTER_WORKFLOW.json [--json]');
  process.exitCode = 1;
} else {
  try {
    const read = async (name) => {
      // An explicit human argument is the only path this command can open.
      // For additional safety, refuse arbitrarily large/corrupt snapshots.
      const p = path.resolve(name);
      const f = await stat(p);
      if (!f.isFile() || f.size > 8 * 1024 * 1024) throw new Error('workflow file missing or too large');
      return JSON.parse(await readFile(p, 'utf8'));
    };
    const [beforeWorkflow, afterWorkflow] = await Promise.all([read(beforePath), read(afterPath)]);
    const result = evaluatePairedTokenProfiles({ beforeWorkflow, afterWorkflow });
    console.log(rest.includes('--json')
      ? JSON.stringify(result, null, 2)
      : formatPairedTokenEvaluation(result));
    if (!result.comparable) process.exitCode = 2;
  } catch (error) {
    console.error('Token evaluation failed: ' + (error?.message ?? error));
    process.exitCode = 1;
  }
}
