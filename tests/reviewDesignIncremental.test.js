// Incremental (route C) Design review wired through the REAL controller and
// runner with zero-paid mock providers. This is mock integration evidence for the
// production code path; it says nothing about real provider quality or cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { INCREMENTAL_LIMITS, segmentText, validateStepReply, applyStepReply, mergeOpenFindings, loadCheckpoint, newStageCheckpoint } from '../src/reviewloop/designIncremental.js';
import { DESIGN_LIMITS } from '../src/reviewloop/designTwoStage.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const BUDGET = 58 * 1024;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const lines = (tag, n, width = 60) => Array.from({ length: n }, (_, i) => `${tag} ${String(i).padStart(5, '0')} ${'x'.repeat(width - 12)}`).join('\n') + '\n';
const bytesOf = (tag, bytes, width = 60) => lines(tag, Math.ceil(bytes / (width + 1)), width).slice(0, bytes - 1) + '\n';
const PLAN_HEAD = '# Plan\n- Goal: ship a thing\n- Non-goals: nothing else\n';
const bigPlan = (bytes = 40_000, width = 60) => PLAN_HEAD + bytesOf('PLAN-BODY', bytes - PLAN_HEAD.length, width);
const bigDesign = (bytes = 60_000, width = 60) => `# Design\n\nSECRET-DESIGN-MARKER\n\n## Options\n- A\n\n## Assumptions\nNone\n` + bytesOf('DESIGN-BODY', bytes - 60, width);

const adj = (over = {}) => ({
  comparison: { verdict: 'ALIGNED', reason: 'same', workerSummary: 'worker approach', planConcern: null },
  blockingFindings: [], nonBlockingFindings: [], humanQuestions: [], factChecks: [],
  designPassComment: 'Builds the thing.', ...over,
});
const PROPOSALS = { proposals: [{ title: 'Reuse', summary: 'reuse engine', tradeoffs: 'rigid' }], confidenceNote: '' };
const step = (over = {}) => ({ digest: 'digest', findings: [], resolved: [], crossRefs: [], searches: [], requestedFiles: [], ...over });

function repoWithSources({ files = 4, bytes = 24_000 } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rl-inc-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@e.x'); g('config', 'user.name', 't');
  mkdirSync(path.join(cwd, 'src'));
  for (let i = 0; i < files; i += 1) writeFileSync(path.join(cwd, `src/m${i}.js`), bytesOf(`SRC${i}`, bytes));
  writeFileSync(path.join(cwd, 'README.md'), 'README');
  g('add', '.'); g('commit', '-qm', 'init');
  return cwd;
}
const stageOf = (a) => a.stage; // inc-s1-r1 / inc-s2-t ...
const isTerminal = (a) => /-t$/.test(stageOf(a));

// A process kill: when a write matching `crashWhen` is about to happen, the durable
// state at that instant is captured; "restart" = a new persistence seeded with it.
class CrashingPersistence extends MemoryPersistence {
  constructor(seed = null) {
    super();
    this.crashWhen = null; this.snapshot = null;
    if (seed) for (const [k, v] of seed) this._state.set(k, JSON.parse(JSON.stringify(v)));
  }
  _maybe(text) { if (this.crashWhen && !this.snapshot && this.crashWhen(text)) this.snapshot = new Map([...this._state].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])); }
  async updateWorkflowState(id, patch) { this._maybe(JSON.stringify(patch)); return super.updateWorkflowState(id, patch); }
  async writeWorkflowState(id, st) { this._maybe(JSON.stringify(st)); return super.writeWorkflowState(id, st); }
}

function makeCtl({ cwd, persistence = new MemoryPersistence(), reviewer, supervisor, limitBytes = BUDGET }) {
  const log = { reviewer: [], supervisor: [] };
  const ctl = createReviewLoopController({
    persistence,
    designInputBudgetFn: async () => ({ limitBytes, source: 'TEST_58KIB' }),
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      let text = '';
      try { text = readFileSync(path.join(cwd, 'Prompt.md'), 'utf8'); } catch { text = ''; }
      return { baselineHead: 'B', currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['Prompt.md'], fingerprint: sha(text || 'none'), diff: `--- Worker untracked file Prompt.md ---\n${text}` };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: ({ configured }) => ({ source: 'configured', commands: configured ?? ['true'], manifestFingerprint: 'f' }),
    designReviewerFn: async (a) => {
      log.reviewer.push(a);
      const v = reviewer ? reviewer(a, log) : (isTerminal(a) ? PROPOSALS : step());
      return { value: v, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
    designSupervisorFn: async (a) => {
      log.supervisor.push(a);
      const v = supervisor ? supervisor(a, log) : (isTerminal(a) ? adj() : step());
      return { value: v, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    },
    reviewerFn: async () => { throw new Error('single-pass reviewer must not run'); },
  });
  return { ctl, log, persistence };
}
const begin = (ctl, cwd, plan, extra = {}) => ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: plan, reviewTarget: 'Prompt.md', designInputRoute: 'incremental', ...extra });
const write = (cwd, t) => writeFileSync(path.join(cwd, 'Prompt.md'), t);
const loopOf = async (persistence, id) => (await persistence.readWorkflowState(id)).reviewLoop;
const cleanup = (cwd) => rmSync(cwd, { recursive: true, force: true });

// ----------------------------------------------------------------- units

test('limits mirror the existing source limits; segments never cut or reorder text', () => {
  assert.equal(INCREMENTAL_LIMITS.segmentBytes, DESIGN_LIMITS.maxFileBytes);
  assert.equal(INCREMENTAL_LIMITS.segmentLines, DESIGN_LIMITS.maxExcerptLines);
  assert.equal(INCREMENTAL_LIMITS.sourceBytes, DESIGN_LIMITS.maxTotalFileBytes);
  const text = bigPlan(70_000, 30);
  const segs = segmentText('plan', text);
  assert.equal(segs.map((s) => s.text).join(''), text);
  for (const s of segs) { assert.ok(s.bytes <= INCREMENTAL_LIMITS.segmentBytes); assert.ok(s.endLine - s.startLine + 1 <= INCREMENTAL_LIMITS.segmentLines); assert.equal(s.sha256, sha(s.text)); }
  assert.ok(segmentText('plan', 'x'.repeat(30_000)).error, 'a single over-long line is refused, never cut');
});

test('step reply validation, finding ownership: a summary cannot delete a finding; closing needs a segment shown in that call', () => {
  assert.equal(validateStepReply({}).malformed, true);
  assert.equal(validateStepReply(step({ findings: [{ severity: 'P3', title: 't' }] })).malformed, true);
  assert.equal(validateStepReply(step({ requestedFiles: [1] })).malformed, true);
  const st = newStageCheckpoint();
  applyStepReply(st, validateStepReply(step({ findings: [{ severity: 'P1', title: 'AC missing', refs: ['plan#L1-L5'] }] })), ['plan#L1-L5']);
  applyStepReply(st, validateStepReply(step()), []);                                                             // summary silently omits it
  applyStepReply(st, validateStepReply(step({ resolved: [{ signature: 'P1::AC missing', refs: [] }] })), []);          // no evidence
  applyStepReply(st, validateStepReply(step({ resolved: [{ signature: 'P1::AC missing', refs: ['design#L1-L9'] }] })), ['plan#L1-L5']); // not shown now
  assert.equal(st.findings['P1::AC missing'].open, true);
  const merged = mergeOpenFindings(adj(), st);
  assert.equal(merged.blockingFindings.length, 1, 'the final adjudication cannot drop an open finding');
  applyStepReply(st, validateStepReply(step({ resolved: [{ signature: 'P1::AC missing', refs: ['design#L1-L9'] }] })), ['design#L1-L9']);
  assert.equal(st.findings['P1::AC missing'].open, false);
  st.findings['P2::CTRL::x'] = { severity: 'P2', title: 'CTRL::x', detail: '', refs: [], open: true };
  applyStepReply(st, validateStepReply(step({ resolved: [{ signature: 'P2::CTRL::x', refs: ['plan#L1-L5'] }] })), ['plan#L1-L5']);
  assert.equal(st.findings['P2::CTRL::x'].open, true, 'controller-owned findings are not closable by a model');
});

test('a checkpoint is reused only for the same round and bound inputs', () => {
  const ds = {};
  const a = loadCheckpoint(ds, { stage: 'round-1:ex-0', binding: 'b1' });
  a.s1.digest = 'kept';
  assert.equal(loadCheckpoint(ds, { stage: 'round-1:ex-0', binding: 'b1' }).s1.digest, 'kept');
  assert.equal(loadCheckpoint(ds, { stage: 'round-1:ex-0', binding: 'b2-new-commit-or-design' }).s1.digest, '');
  assert.equal(loadCheckpoint(ds, { stage: 'round-2:ex-0', binding: 'b2-new-commit-or-design' }).s1.digest, '');
});

test('begin: designInputRoute is validated and frozen; the default objective is unchanged', async () => {
  const cwd = repoWithSources();
  const { ctl } = makeCtl({ cwd });
  await assert.rejects(() => ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: bigPlan(2000), designInputRoute: 'incremental' }), /designInputRoute/);
  await assert.rejects(() => begin(ctl, cwd, bigPlan(2000), { designInputRoute: 'bogus' }), /designInputRoute/);
  const a = await begin(ctl, cwd, bigPlan(2000));
  const b = await ctl.begin({ goal: 'g', cwd, taskType: 'design', contractText: bigPlan(2000), reviewTarget: 'Prompt2.md' });
  assert.notEqual(a.objectiveFingerprint, b.objectiveFingerprint);
  assert.equal(a.designInputRoute, 'incremental');
  assert.equal(b.designInputRoute, undefined);
  cleanup(cwd);
});

// ------------------------------------------------------ real controller e2e

test('E2E: ~210k-char Plan+Design+96 KiB source at a 58 KiB budget PASSes; every real prompt is bounded; all segments reach the model; stage 1 never sees the design', async () => {
  const cwd = repoWithSources();
  const plan = bigPlan(40_000); const design = bigDesign(60_000);
  const wanted = ['src/m0.js', 'src/m1.js', 'src/m2.js', 'src/m3.js'];
  const { ctl, log, persistence } = makeCtl({
    cwd,
    reviewer: (a) => (isTerminal(a) ? PROPOSALS : step({ searches: ['SRC0 00003'], requestedFiles: ['Prompt.md', 'src/m0.js'] })),
    supervisor: (a) => (isTerminal(a) ? adj() : (a.stage === 'inc-s2-r1' ? step({ requestedFiles: wanted, searches: ['SRC1 00002'] }) : step())),
  });
  const b = await begin(ctl, cwd, plan);
  write(cwd, design);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS', JSON.stringify(r).slice(0, 1500));
  const all = [...log.reviewer, ...log.supervisor].map((a) => String(a.prompt));
  for (const p of all) assert.ok(Buffer.byteLength(p) <= BUDGET, `prompt of ${Buffer.byteLength(p)} bytes exceeds the budget`);
  // nothing was silently dropped: every plan/design segment's exact text was in some supervisor prompt
  const sup = log.supervisor.map((a) => String(a.prompt)).join('\n');
  for (const s of [...segmentText('plan', plan), ...segmentText('design', design)]) assert.ok(sup.includes(s.text), `segment ${s.id} missing`);
  for (const f of wanted) assert.ok(sup.includes(`SRC${f.at(-4)} 00000`), `${f} not shown to the Supervisor`);
  // isolation: no reviewer prompt contains the design text, its marker or its hash, nor the design file path
  for (const a of log.reviewer) {
    const p = String(a.prompt);
    assert.ok(!p.includes('SECRET-DESIGN-MARKER') && !p.includes('DESIGN-BODY') && !p.includes(sha(design.trim())) && !p.includes('Prompt.md'));
  }
  const rec = (await loopOf(persistence, b.loopId)).lastReview.factVerification.incremental;
  assert.equal(rec.stage2.covered, rec.stage2.required);
  assert.ok(rec.stage2.sourceBytes > 90_000 && rec.stage2.sourceBytes <= INCREMENTAL_LIMITS.sourceBytes, `source bytes ${rec.stage2.sourceBytes}`);
  assert.ok(rec.peakPromptBytes <= BUDGET);
  assert.ok(log.supervisor.length <= 8, 'inside the default Supervisor call ceiling');
  console.log(`# C large fixture: calls=${all.length} (reviewer ${log.reviewer.length}, supervisor ${log.supervisor.length}) peak=${rec.peakPromptBytes} total=${rec.totalSentBytes} s2steps=${rec.stage2.steps} searches=${rec.stage2.searches} sourceBytes=${rec.stage2.sourceBytes} covered=${rec.stage2.covered}/${rec.stage2.required}`);
  cleanup(cwd);
});

test('E2E: an open P2 raised in a read step blocks PASS even if the terminal call says ALIGNED with no findings', async () => {
  const cwd = repoWithSources();
  const { ctl, persistence } = makeCtl({ cwd, supervisor: (a) => (isTerminal(a) ? adj() : (a.stage === 'inc-s2-r1' ? step({ findings: [{ severity: 'P2', title: 'AC-3 is not covered by the design', refs: [] }] }) : step())) });
  const b = await begin(ctl, cwd, bigPlan(30_000)); write(cwd, bigDesign(30_000));
  const r = await ctl.review({ loopId: b.loopId });
  assert.notEqual(r.status, 'PASS');
  assert.ok((await loopOf(persistence, b.loopId)).lastReview.blockingFindings.some((f) => /AC-3/.test(f.title)));
  cleanup(cwd);
});

test('E2E: a cross-section contradiction is re-shown with BOTH originals in one call and blocks PASS', async () => {
  const cwd = repoWithSources();
  const plan = bigPlan(30_000); const design = bigDesign(30_000);
  const a = segmentText('plan', plan)[0].id; const bId = segmentText('design', design)[0].id;
  const { ctl, log, persistence } = makeCtl({
    cwd,
    supervisor: (x) => {
      if (isTerminal(x)) return adj();
      if (x.stage === 'inc-s2-r1') return step({ crossRefs: [{ a, b: bId, concern: 'budget in plan vs retry in design' }] });
      if (/-j\d+$/.test(x.stage)) return step({ findings: [{ severity: 'P2', title: 'Plan budget contradicts design retry', refs: [a, bId] }] });
      return step();
    },
  });
  const b = await begin(ctl, cwd, plan); write(cwd, design);
  const r = await ctl.review({ loopId: b.loopId });
  const joint = log.supervisor.find((x) => /-j\d+$/.test(x.stage));
  assert.ok(joint, 'a joint step ran');
  const jp = String(joint.prompt);
  assert.ok(jp.includes(segmentText('plan', plan)[0].text) && jp.includes(segmentText('design', design)[0].text));
  assert.notEqual(r.status, 'PASS');
  assert.ok((await loopOf(persistence, b.loopId)).lastReview.blockingFindings.some((f) => /contradicts/.test(f.title)));
  cleanup(cwd);
});

test('E2E: related evidence that cannot fit one call stops the review; no terminal call, no PASS', async () => {
  const cwd = repoWithSources();
  const plan = bigPlan(30_000); const design = bigDesign(30_000);
  const a = segmentText('plan', plan)[0].id; const bId = segmentText('design', design)[0].id;
  const { ctl, log } = makeCtl({
    cwd, limitBytes: 38_000,
    supervisor: (x) => (x.stage === 'inc-s2-r1' ? step({ crossRefs: [{ a, b: bId, concern: 'c' }] }) : isTerminal(x) ? adj() : step()),
  });
  const b = await begin(ctl, cwd, plan); write(cwd, design);
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /cannot be shown together/);
  assert.ok(!log.supervisor.some(isTerminal));
  cleanup(cwd);
});

test('E2E: when the required Plan/Design cannot be read within the step bound the review fails closed (no terminal call, nothing trimmed)', async () => {
  const cwd = repoWithSources();
  const { ctl, log } = makeCtl({ cwd, limitBytes: 24_000 });
  const b = await begin(ctl, cwd, bigPlan(64_000, 40)); write(cwd, bigDesign(64_000, 40));   // 8 segments of ~16 KiB, one per 30 KB call > 7 reading calls
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED', `${log.supervisor.map((x) => `${x.stage}:${Buffer.byteLength(String(x.prompt))}`)}`);
  assert.match(r.reason, /could not be fully read/);
  assert.ok(!log.supervisor.some(isTerminal));
  assert.ok(log.supervisor.length + log.reviewer.length <= 16);
  cleanup(cwd);
});

test('E2E: a SUPPORTED fact check citing a source never provided is rejected; a dirty source cannot PASS as clean HEAD', async () => {
  const cwd = repoWithSources();
  const base = { cwd, supervisor: (a) => (isTerminal(a) ? adj({ factChecks: [{ claim: 'caller is safe', critical: true, status: 'SUPPORTED', evidenceSources: ['src/never-read.js'], reason: 'r' }] }) : step()) };
  const one = makeCtl(base);
  const b1 = await begin(one.ctl, cwd, bigPlan(8000)); write(cwd, bigDesign(8000));
  const r1 = await one.ctl.review({ loopId: b1.loopId });
  assert.equal(r1.status, 'HUMAN_REQUIRED', JSON.stringify(r1).slice(0, 500));
  assert.equal(one.log.supervisor.filter(isTerminal).length, 2, 'exactly one corrective retry');
  cleanup(cwd);
});

test('E2E: a critical claim supported only by a dirty source cannot PASS as clean HEAD (existing identity rule, new route)', async () => {
  const cwd = repoWithSources();
  writeFileSync(path.join(cwd, 'src/m0.js'), `${readFileSync(path.join(cwd, 'src/m0.js'), 'utf8')}// dirty\n`);
  const two = makeCtl({ cwd, supervisor: (a) => (isTerminal(a) ? adj({ factChecks: [{ claim: 'x', critical: true, status: 'SUPPORTED', evidenceSources: ['src/m0.js'], reason: 'r' }] }) : (a.stage === 'inc-s2-r1' ? step({ requestedFiles: ['src/m0.js'] }) : step())) });
  const b2 = await begin(two.ctl, cwd, bigPlan(8000)); write(cwd, bigDesign(8000));
  const r2 = await two.ctl.review({ loopId: b2.loopId });
  assert.notEqual(r2.status, 'PASS');
  cleanup(cwd);
});

test('E2E: repeated identical requests make no progress: duplicate reads are not re-served and the stage still terminates inside its bounds', async () => {
  const cwd = repoWithSources();
  const { ctl, log, persistence } = makeCtl({
    cwd, supervisor: (a) => (isTerminal(a) ? adj() : step({ searches: ['SRC0'], requestedFiles: ['src/m0.js'] })),
  });
  const b = await begin(ctl, cwd, bigPlan(20_000)); write(cwd, bigDesign(20_000));
  const r = await ctl.review({ loopId: b.loopId });
  assert.equal(r.status, 'PASS');
  const rec = (await loopOf(persistence, b.loopId)).lastReview.factVerification.incremental;
  assert.equal(rec.stage2.sourceReads, 1, 'the same file was read once');
  assert.ok(log.supervisor.length <= INCREMENTAL_LIMITS.maxStepsPerStage);
  assert.ok(rec.stage2.searches <= INCREMENTAL_LIMITS.maxSearches);
  cleanup(cwd);
});

test('E2E crash/recovery: a restart after a kill does not pay for settled steps; findings and coverage survive; the verdict still blocks', async () => {
  const cwd = repoWithSources();
  const persistence = new CrashingPersistence();
  const plan = bigPlan(40_000); const design = bigDesign(40_000);
  const first = makeCtl({
    cwd, persistence, limitBytes: 30_000,
    supervisor: (a) => (isTerminal(a) ? adj() : (a.stage === 'inc-s2-r1' ? step({ findings: [{ severity: 'P1', title: 'Plan AC dropped', refs: [] }] }) : step())),
  });
  const b = await begin(first.ctl, cwd, plan); write(cwd, design);
  // kill the process just before step r3 is marked dispatched: r1/r2 and all of stage 1 are settled on disk
  persistence.crashWhen = (t) => t.includes('"r3":{"status":"DISPATCHED"}');
  await first.ctl.review({ loopId: b.loopId });
  assert.ok(persistence.snapshot, 'the kill point was reached');
  const durable = (await persistence.snapshot.get(b.loopId)).reviewLoop.designTwoStage.incremental;
  assert.equal(durable.s1.terminal !== null, true);
  assert.deepEqual(Object.keys(durable.s2.steps).sort(), ['r1', 'r2']);
  // restart: a NEW controller (and a different "model") on the durable state captured at the kill
  const second = makeCtl({ cwd, persistence: new CrashingPersistence(persistence.snapshot), limitBytes: 30_000, supervisor: (a) => (isTerminal(a) ? adj() : step()) });
  const r = await second.ctl.review({ loopId: b.loopId });
  const stages = second.log.supervisor.map((a) => a.stage);
  assert.equal(second.log.reviewer.length, 0, 'the settled Reviewer stage is not repeated');
  assert.ok(!stages.includes('inc-s2-r1') && !stages.includes('inc-s2-r2'), `settled steps were paid again: ${stages}`);
  assert.ok(stages.includes('inc-s2-r3') && stages.includes('inc-s2-t'), `the resumed run continued: ${stages}`);
  assert.equal(r.status, 'REWORK', JSON.stringify(r).slice(0, 600));
  assert.ok((await loopOf(second.persistence, b.loopId)).lastReview.blockingFindings.some((f) => /Plan AC dropped/.test(f.title)), 'the P1 from before the kill still blocks');
  cleanup(cwd);
});

test('E2E UNKNOWN spend: a step dispatched but never settled before a kill is not re-sent on restart and is not assumed free', async () => {
  const cwd = repoWithSources();
  const persistence = new CrashingPersistence();
  const first = makeCtl({ cwd, persistence, limitBytes: 30_000 });
  const b = await begin(first.ctl, cwd, bigPlan(40_000)); write(cwd, bigDesign(40_000));
  // the kill happens after r2 was durably marked DISPATCHED (its call was in flight)
  persistence.crashWhen = (t) => { const i = t.indexOf('"s2":'); return i >= 0 && t.indexOf('"r2":{"status":"SETTLED"', i) > i; };
  await first.ctl.review({ loopId: b.loopId });
  const snap = persistence.snapshot;
  assert.ok(snap);
  const st = (await snap.get(b.loopId)).reviewLoop.designTwoStage.incremental.s2.steps;
  assert.equal(st.r2.status, 'DISPATCHED', 'the snapshot is mid-flight');
  const second = makeCtl({ cwd, persistence: new CrashingPersistence(snap), limitBytes: 30_000, supervisor: () => { throw new Error('must not be called'); }, reviewer: () => { throw new Error('must not be called'); } });
  const res = await second.ctl.review({ loopId: b.loopId });
  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.equal(second.log.supervisor.length + second.log.reviewer.length, 0, 'no model call for an unsettled step');
  cleanup(cwd);
});
