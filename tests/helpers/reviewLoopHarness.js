// Deterministic in-memory harness for ReviewLoop controller tests.
// Zero real provider calls, zero git, zero filesystem.

import { createHash } from 'node:crypto';
import { createReviewLoopController } from '../../src/reviewloop/controller.js';

function sha256(v) { return createHash('sha256').update(String(v)).digest('hex'); }

export class MemoryPersistence {
  constructor() { this._state = new Map(); }
  async readWorkflowState(id) { return this._state.get(id) ? JSON.parse(JSON.stringify(this._state.get(id))) : null; }
  async writeWorkflowState(id, s) { this._state.set(id, JSON.parse(JSON.stringify(s))); }
  async updateWorkflowState(id, patch) {
    const cur = (await this.readWorkflowState(id)) ?? {};
    const next = { ...cur, ...patch };
    this._state.set(id, JSON.parse(JSON.stringify(next)));
    return next;
  }
}

// A scripted world the tests drive.
export function makeHarness({
  baseline = { head: 'BASE', capturedAt: 't0', dirtyFiles: [], evidenceComplete: true, baselineDiffText: '' },
  deltas = [],           // one per review() call: { fingerprint, diff, changedFiles }
  gates = [],            // one per review() call: { verdict, fingerprint, failureIdentities }
  reviews = [],          // one per reviewer call: { findings: [...] }
  supervisorReplies = [],// one per supervisor call
} = {}) {
  const calls = { reviewer: 0, supervisor: 0, gate: 0, delta: 0, baseline: 0 };
  const persistence = new MemoryPersistence();

  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => { calls.baseline += 1; return baseline; },
    collectWorkerDeltaFn: async () => {
      const d = deltas[calls.delta] ?? deltas[deltas.length - 1] ?? { fingerprint: `fp${calls.delta}`, diff: 'diff', changedFiles: ['a.js'] };
      calls.delta += 1;
      return { baselineHead: baseline.head, currentHead: baseline.head, evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false, ...d };
    },
    runGateFn: async () => {
      const g = gates[calls.gate] ?? gates[gates.length - 1] ?? { verdict: 'PASS', fingerprint: `gate${calls.gate}`, failureIdentities: [] };
      calls.gate += 1;
      return { pass: g.verdict === 'PASS', results: [], baselineDiff: null, ...g };
    },
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo test'] }),
    reviewerFn: async () => {
      const r = reviews[calls.reviewer] ?? reviews[reviews.length - 1] ?? { findings: [] };
      calls.reviewer += 1;
      return { value: r, usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => {
      const s = supervisorReplies[calls.supervisor] ?? { guidance: 'try X', recommendation: 'REWORK' };
      calls.supervisor += 1;
      return { value: s, usage: { input_tokens: 8, output_tokens: 4 }, model: 'test-supervisor' };
    },
  });

  return { controller, persistence, calls };
}

export const finding = (severity, file = 'a.js', title = 't') => ({ severity, file, line: 1, title });
