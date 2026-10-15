import test from 'node:test';
import assert from 'node:assert/strict';
import { changedFilesPrompt, buildReviewerInvoke } from '../src/reviewloop/providerWiring.js';

function decode(text) {
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
    .flatMap(([prefix, names]) => names.map(name => prefix + name));
}
test('prefix factoring round-trips every global path including duplicates and unusual names', () => {
  const dir = 'Sources/SpinLabApp/Workbench/Modules/PlotSystem/Controls/';
  const files = ['a', ...['a.swift', 'b.swift', 'b.swift', 'comma, quote" newline\n雪.swift', '../relative.swift'].map(f => dir + f), 'root'];
  const text = changedFilesPrompt(files);
  assert.ok(text.length < `CHANGED FILES: ${files.join(', ')}`.length);
  assert.deepEqual(decode(text), files);
});
test('short or ungroupable lists retain the original representation', () => {
  for (const files of [[], ['a'], ['a/x', 'b/y'], ['a', 'a']]) {
    assert.equal(changedFilesPrompt(files), `CHANGED FILES: ${files.join(', ') || '(none)'}`);
  }
});
test('each chunk/rework retains full contract, scope, invariants, evidence and files outside its diff', async () => {
  const files = Array.from({length: 12}, (_, i) => `Sources/Shared/Deep/Dependency/Module/file${i}.swift`);
  const invoke = buildReviewerInvoke();
  for (const diff of ['diff --git a/local b/local\n+first', 'diff --git a/other b/other\n+dependency changed']) {
    let sent;
    const result = await invoke({ objective: {goal:'GOAL', contractText:'FULL CONTRACT\nNEVER DROP THIS',constraints:['GLOBAL']},
      changedFiles:files,diff,gate:{verdict:'PASS'},
      reviewScope:{type:'phase',id:'one',objective:'SCOPE',exitCriteria:['EXIT'],preserveInvariants:['INHERITED'],carryForwardInvariants:['CARRY']},
      evidence:{requirements:[{id:'proof',type:'runtime',description:'PROVE',required:true}],submissions:[{requirementId:'proof',summary:'OBSERVED'}]},
      supervisorGuidance:'RECONSIDER',
      transport:async prompt => { sent=prompt;return {text:'{"findings":[{"severity":"P2","file":"local","line":1,"title":"blocker"}]}'} }
    });
    for (const marker of ['FULL CONTRACT\nNEVER DROP THIS','GOAL','GLOBAL','SCOPE','EXIT','INHERITED','CARRY','PROVE','OBSERVED','RECONSIDER',diff,'P1/P2 block']) assert.ok(sent.includes(marker),marker);
    const line = sent.split('\n').findIndex(l => l.startsWith('CHANGED FILES'));
    assert.deepEqual(decode(sent.split('\n').slice(line,line+2).join('\n')),files);
    assert.equal(result.value.findings[0].severity,'P2');
    assert.equal(result.meta.promptChars,sent.length);
  }
});

test('changed dependency forces re-review of unchanged consumer through compact prompt; new P2 still blocks', async () => {
  const { createReviewLoopController } = await import('../src/reviewloop/controller.js');
  const { MemoryPersistence } = await import('./helpers/reviewLoopHarness.js');
  const files = ['consumer.swift','shared.swift',...Array.from({length:8},(_,i)=>`extra${i}.swift`)].map(f=>'Sources/Deep/Shared/Dependency/Module/'+f);
  let revision=1;
  const seen=[];
  const invoke=buildReviewerInvoke();
  const makeDiff = () => files.map((f,i)=>`diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n+${i===1?revision:0}\n`).join('');
  const ctl=createReviewLoopController({persistence:new MemoryPersistence(),
    env:{REVIEWLOOP_MAX_REVIEW_DIFF_CHARS:'300',REVIEWLOOP_MAX_REVIEW_CHUNKS:'12'},
    captureBaselineFn:async()=>({head:'BASE',dirtyFiles:[],evidenceComplete:true}),
    collectWorkerDeltaFn:async()=>({baselineHead:'BASE',currentHead:`HEAD${revision}`,evidenceComplete:true,noWorkerChangeYet:false,changedFiles:files,fingerprint:`DELTA${revision}`,diff:makeDiff()}),
    runGateFn:async()=>({verdict:'PASS',pass:true,fingerprint:'GATE',failureIdentities:[],results:[]}),
    discoverVerificationCommandsFn:()=>({source:'test',commands:['echo']}),
    reviewerFn:async args=>invoke({...args,transport:async prompt=>{
      seen.push({revision,index:args.chunk.index,diff:args.diff,prompt});
      const label=prompt.split('\n').findIndex(l=>l.startsWith('CHANGED FILES'));
      assert.deepEqual(decode(prompt.split('\n').slice(label,label+2).join('\n')),files);
      const defect=revision===1?args.diff.includes('b/'+files[1]):args.diff.includes('b/'+files[0]);
      return {text:JSON.stringify({findings:defect?[{severity:'P2',file:files[revision===1?1:0],line:1,title:'dependency defect'}]:[]}),usage:{input_tokens:10,output_tokens:5}};
    }}),
  });
  const {loopId}=await ctl.begin({goal:'Preserve cross-file review coverage',cwd:'/r'});
  const first=await ctl.review({loopId}); assert.equal(first.status,'REWORK',JSON.stringify(first));
  revision=2;
  const second=await ctl.review({loopId});
  assert.equal(second.status,'REWORK');
  assert.ok(second.blockingFindings.some(f=>f.file===files[0]));
  const firstConsumer=seen.find(c=>c.revision===1&&c.diff.includes('b/'+files[0]));
  const secondConsumer=seen.find(c=>c.revision===2&&c.diff.includes('b/'+files[0]));
  assert.ok(firstConsumer&&secondConsumer);
  assert.equal(firstConsumer.diff,secondConsumer.diff);
});

test('assembleCompactPrompt strips trailing line whitespace and collapses blank line bursts', async () => {
  const { assembleCompactPrompt } = await import('../src/reviewloop/providerWiring.js');
  const input = [
    'Header:  \t',
    'Line with trailing spaces   ',
    '',
    '\n\nSubline after blank burst   ',
    'Footer',
  ];
  const output = assembleCompactPrompt(input);
  assert.equal(output.includes('   '), false);
  assert.equal(/\n{3,}/.test(output), false);
  assert.equal(output, 'Header:\nLine with trailing spaces\n\nSubline after blank burst\nFooter');
});
