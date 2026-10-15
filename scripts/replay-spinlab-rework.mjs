// Offline replay only. Captures prompts; never calls a provider or modifies a loop.
// Usage: node scripts/replay-spinlab-rework.mjs WORKFLOW REPO REPAIRED_HEAD OUT
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { buildReviewerInvoke } from '../src/reviewloop/providerWiring.js';
import { currentReviewScope } from '../src/reviewloop/phaseState.js';
import { chunkDiffForReview } from '../src/reviewloop/diffChunker.js';

const [workflow,repo,repairedHead,out]=process.argv.slice(2);
if (!out) throw new Error('Expected WORKFLOW REPO REPAIRED_HEAD OUT');
const source=readFileSync(workflow,'utf8');
const persisted=JSON.parse(source),state=persisted.reviewLoop,objective=state.objective;
assert.equal(state.loopId,'rl-20261015044936-4bc2bfe8','This fixture replays only the documented SpinLab session');
const reviewedHead=state.lastReview?.reviewedHead;
const baseline=state.completedPhases?.at(-1)?.phaseBaseline?.baselineRef;
if (!reviewedHead || !baseline || !state.lastReview.blockingFindings.length) throw new Error('Need a real blocked review and its phase baseline');
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:32*1024*1024});
git('merge-base','--is-ancestor',reviewedHead,repairedHead);
const repaired=git('rev-parse',repairedHead).trim();
if(repaired===reviewedHead) throw new Error('Need a changed repair snapshot');
const changes=(from,to)=>({diff:git('diff','--no-ext-diff','--no-textconv',from,to),changedFiles:git('diff','--name-only','-z',from,to).split('\0').filter(Boolean)});
const prior=changes(baseline,reviewedHead),full=changes(baseline,repaired),repair=changes(reviewedHead,repaired);
const scope=currentReviewScope(state,objective);
if(state.evidenceRecords?.length) throw new Error('This replay fixture requires no evidence records; do not silently omit them');
const input={objective,reviewScope:scope,gate:{verdict:'PASS'},diffScope:'phase-delta',evidence:null};
// Pinned pre-fix implementation, so historical prompt reconstruction can be checked.
const beforeRef='061a1a9634714d0d340d36c72efc7e998f057f4b';
// Fail rather than silently replay old wiring against changed source dependencies.
assert.equal(execFileSync('git',['diff',beforeRef,'--','src',':!src/reviewloop/providerWiring.js','package.json','package-lock.json'],{encoding:'utf8'}),'','Replay dependencies must match the pre-fix revision');
const modulePath=resolve('src/reviewloop/providerWiring.js');
const code=execFileSync('git',['show',`${beforeRef}:src/reviewloop/providerWiring.js`],{encoding:'utf8'})
 .replace(/from '([.][^']+)'/g,(_,spec)=>`from '${pathToFileURL(resolve(dirname(modulePath),spec)).href}'`);
const oldInvoke=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).buildReviewerInvoke();
const newInvoke=buildReviewerInvoke();
mkdirSync(out,{recursive:true});
async function capture(label,delta,invoke,previousFindings=[],repairOnly=false){
 const plan=chunkDiffForReview(delta.diff,{env:{}});
 if(plan.oversized)throw new Error(plan.reason);
 const rows=[];
 for(const chunk of plan.chunks){
  let text;
  await invoke({...input,...delta,diff:chunk.text,previousFindings,transport:async prompt=>{
   text=prompt;
   if(repairOnly) text='OFFLINE REPAIR-VERIFICATION CANDIDATE: inspect this repair and the prior findings only. This is NOT full acceptance and cannot authorize task or phase PASS. A separate full independent review of the complete current diff is mandatory.\n'+text;
   return {text:'{"findings":[]}'};
  }});
  assert.ok(text.includes(chunk.text));
  assert.ok(text.includes(objective.contractText.trim()));
  writeFileSync(resolve(out,`${label}.${chunk.index}.txt`),text);
  rows.push({chunk:chunk.index,promptChars:text.length,diffChars:chunk.text.length});
 }
 assert.equal(plan.chunks.map(c=>c.text).join(''),delta.diff);
 return {chunks:rows.length,promptChars:rows.reduce((n,r)=>n+r.promptChars,0),diffChars:delta.diff.length,rows};
}
const historical=await capture('historical-full',prior,oldInvoke);
const fullBeforeFix=await capture('repaired-full-before-fix',full,oldInvoke);
const fullAfterFix=await capture('repaired-full-after-fix',full,newInvoke,state.lastReview.blockingFindings);
// Keep the task-wide file inventory even for the restricted repair candidate.
const repairOnly=await capture('repair-only-candidate',{...repair,changedFiles:full.changedFiles},newInvoke,state.lastReview.blockingFindings,true);
// Final acceptance is byte-for-byte the complete post-fix review above, NOT a findings union.
const finalAcceptance=fullAfterFix;
const historicalRecords=persisted.reviewLoopSpend.records.filter(r=>r.role==='reviewer'&&r.round===10&&r.payloadMeta);
assert.equal(historicalRecords.length,historical.rows.length,'Unexpected historical call layout');
for(const row of historical.rows){
 const record=historicalRecords.find(r=>r.chunkIndex===row.chunk);
 assert.equal(row.diffChars,record.payloadMeta.diffChars,'Historical diff length differs');
 assert.equal(row.promptChars,record.payloadMeta.promptChars,'Historical prompt length differs');
}
assert.equal(readFileSync(workflow,'utf8'),source,'Original workflow changed during read-only replay');
const summary={kind:'offline input reconstruction, no provider calls and no semantic acceptance',beforeRef,loopId:state.loopId,baseline,reviewedHead,repairedHead:repaired,scope:scope.id,
 historicalLedgerMatched:true,historical,fullBeforeFix,fullAfterFix,repairOnly,finalAcceptance,
 comparison:{baselineFullChars:fullAfterFix.promptChars,repairPlusFullChars:repairOnly.promptChars+finalAcceptance.promptChars,savedChars:-repairOnly.promptChars,additionalChars:repairOnly.promptChars,estimateMethod:'characters / 4; use tokenizer counts separately',estimatedAdditionalTokens:repairOnly.promptChars/4},
 coverage:{completeDiffPreserved:true,finalInputIdenticalToFullReview:true,repairCanAuthorizePass:false,independentCrossChunkSemanticCoverageProven:false,productionModeEnabled:false},
 limitations:['Only one repair transition has attributable reviewed HEAD, findings and repaired Git snapshot.','Phase-1 per-round working trees and prior findings are not all retained; nine rounds cannot be replayed exactly.','Round 11 did not finish in the historical run; its complete input here is reconstructed, not historical billed usage.','No independent model evaluated the candidate; no evidence that it would reduce repair rounds or preserve detection quality.','Existing chunk isolation does not itself prove joint cross-file review; do not enable a new acceptance path based on this input comparison.'],
 verdict:'For this single available repair transition, repair verification followed by the same full review costs more input. No safe net savings established.'};
writeFileSync(resolve(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
