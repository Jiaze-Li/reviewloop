// Read-only replay of a real task/diff through both prompt builders. No model calls.
// node scripts/benchmark-compact-reviewer-input.mjs WORKFLOW REPO HEAD OUT_DIR
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReviewerInvoke } from '../src/reviewloop/providerWiring.js';
import { chunkDiffForReview } from '../src/reviewloop/diffChunker.js';
import { currentReviewScope } from '../src/reviewloop/phaseState.js';
const [workflow, repo, head, out] = process.argv.slice(2);
if (!out) throw new Error('Expected WORKFLOW REPO HEAD OUT_DIR');
const state = JSON.parse(readFileSync(workflow, 'utf8')).reviewLoop;
const objective = state.objective;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding:'utf8', maxBuffer:32*1024*1024 });
const baseline = objective.baseline.baselineRef;
const diff = git('diff', baseline, head);
const changedFiles = git('diff', '--name-only', '-z', baseline, head).split('\0').filter(Boolean);
// Pin the pre-optimization main implementation, independent of local edits.
const beforeRef = '061a1a9634714d0d340d36c72efc7e998f057f4b';
const modulePath = resolve('src/reviewloop/providerWiring.js');
const beforeSource = execFileSync('git', ['show', `${beforeRef}:src/reviewloop/providerWiring.js`], {encoding:'utf8'})
  .replace(/from '([.][^']+)'/g, (_, spec) => `from '${pathToFileURL(resolve(dirname(modulePath), spec)).href}'`);
const beforeInvoke = (await import('data:text/javascript;base64,' + Buffer.from(beforeSource).toString('base64'))).buildReviewerInvoke();
const afterInvoke = buildReviewerInvoke();
const chunked = chunkDiffForReview(diff, {env:{}});
if (chunked.oversized) throw new Error(chunked.reason);
mkdirSync(out, {recursive:true});
const rows=[];
for (const chunk of chunked.chunks) {
  const input = {objective, diff:chunk.text, changedFiles, gate:{verdict:'PASS'},
    reviewScope:currentReviewScope({...state,currentPhaseIndex:0,completedPhases:[]},objective)};
  const prompts={};
  for (const [label,invoke] of [['before',beforeInvoke],['after',afterInvoke]]) {
    await invoke({...input, transport:async prompt => {prompts[label]=prompt;return {text:'{"findings":[]}'}}});
    writeFileSync(resolve(out,`chunk-${chunk.index}.${label}.txt`),prompts[label]);
  }
  // The only change must be the complete changed-files representation.
  const strip = text => text.replace(/^CHANGED FILES[^\n]*\n(?:\[.*\]\n)?/m,'');
  if (strip(prompts.before)!==strip(prompts.after)) throw new Error('Unexpected prompt difference');
  rows.push({chunk:chunk.index,beforeChars:prompts.before.length,afterChars:prompts.after.length,savedChars:prompts.before.length-prompts.after.length});
}
const beforeChars=rows.reduce((n,r)=>n+r.beforeChars,0), afterChars=rows.reduce((n,r)=>n+r.afterChars,0);
const summary={sample:'Read-only replay: real SpinLab phase-1 contract and Git diff, PASS gate, no submitted evidence; not a historical provider bill',beforeRef,baseline,head:git('rev-parse',head).trim(),files:changedFiles.length,chunks:rows.length,beforeChars,afterChars,savedChars:beforeChars-afterChars,savedPercent:100*(beforeChars-afterChars)/beforeChars,estimatedTokens:{method:'characters / 4 proxy, not tokenizer or provider usage',before:beforeChars/4,after:afterChars/4,saved:(beforeChars-afterChars)/4},rows};
writeFileSync(resolve(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
