import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { changedFilesPrompt, buildReviewerInvoke, buildSupervisorInvoke } from '../src/reviewloop/providerWiring.js';

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


test('reviewer and supervisor preserve frozen-contract internal whitespace verbatim', async () => {
  const contract = [
    'Frozen requirements',
    'Markdown hard break  ',
    '',
    '',
    '',
    '    indented literal with trailing spaces   ',
    'Final requirement',
  ].join('\n');
  const contractSection = 'FROZEN TASK CONTRACT (also binding; self-contained; must not weaken the goal):\n' + contract;
  const objective = { goal: 'Keep obligations intact', contractText: contract };
  let reviewerPrompt;
  let supervisorPrompt;

  const reviewer = await buildReviewerInvoke()({
    objective,
    diff: 'diff --git a/file b/file\n+change',
    changedFiles: ['file'],
    gate: { verdict: 'PASS' },
    transport: async (prompt) => {
      reviewerPrompt = prompt;
      return { text: '{"findings":[]}' };
    },
  });
  const supervisor = await buildSupervisorInvoke()({
    objective,
    blockingFindings: [{ severity: 'P2', file: 'file', line: 1, title: 'example' }],
    transport: async (prompt) => {
      supervisorPrompt = prompt;
      return { text: '{"guidance":"recheck","recommendation":"REWORK"}' };
    },
  });

  for (const prompt of [reviewerPrompt, supervisorPrompt]) {
    assert.ok(prompt.includes(contractSection), 'Frozen contract bytes were modified or omitted');
    assert.equal(prompt.split(contractSection).length, 2, 'Frozen contract must appear exactly once');
  }
  assert.equal(reviewer.meta.promptComponentStats.contractChars, contractSection.length);
  assert.equal(
    reviewer.meta.promptComponentStats.contractSha256,
    createHash('sha256').update(contractSection).digest('hex'),
  );
  assert.equal(reviewer.meta.promptChars, reviewerPrompt.length);
  assert.equal(supervisor.meta.promptChars, supervisorPrompt.length);
});

test('reviewer preserves diff whitespace and reports the actual transmitted lengths', async () => {
  const diff = [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1 +1 @@',
    '-old line   ',
    '+new line  \t',
    '',
    '',
    ' ',
  ].join('\n');
  let prompt;
  const result = await buildReviewerInvoke()({
    objective: { goal: 'Preserve diff evidence' },
    diff,
    changedFiles: ['file.txt'],
    gate: { verdict: 'PASS' },
    transport: async (text) => {
      prompt = text;
      return { text: '{"findings":[]}' };
    },
  });

  assert.ok(
    prompt.includes('GIT DIFF (primary evidence):\n' + diff + '\nReturn JSON:'),
    'Diff must be transmitted byte-for-byte, including trailing whitespace and blank lines',
  );
  assert.equal(result.meta.diffChars, diff.length);
  assert.equal(result.meta.promptComponentStats.diffChars, diff.length);
  assert.equal(result.meta.promptChars, prompt.length);
  assert.equal(result.meta.reviewPayloadChars, prompt.length);
});
