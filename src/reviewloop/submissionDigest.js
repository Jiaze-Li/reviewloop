// Content identity of "what the Worker is submitting for review right now".
// Zero model calls, zero Gate, zero writes: only a read of the Worker's delta
// (git evidence the review path already collects). Binding a human re-review
// grant to this value means an authorization covers exactly ONE submission and
// can never silently extend to later, different content. The review tool's own
// version is deliberately NOT part of it, so upgrading the tool never changes a
// digest and never triggers or invalidates anything.

import { createHash } from 'node:crypto';

export async function computeSubmissionDigest({ loop, collectWorkerDeltaFn }) {
  const objective = loop?.objective ?? {};
  const cwd = objective.repository?.root;
  if (!cwd || !objective.baseline) return { ok: false, reason: 'the task does not record its repository or baseline' };
  let delta;
  try {
    delta = await collectWorkerDeltaFn({ cwd, baseline: objective.baseline });
  } catch (err) {
    return { ok: false, reason: `the current submission could not be read (${String(err?.message ?? err).slice(0, 120)})` };
  }
  if (!delta || !delta.fingerprint || delta.evidenceComplete === false) {
    return { ok: false, reason: 'the current submission could not be identified reliably' };
  }
  const material = JSON.stringify({
    v: 1, loopId: loop.loopId, taskType: objective.taskType ?? 'code', head: delta.currentHead ?? null, fingerprint: delta.fingerprint,
  });
  return { ok: true, digest: createHash('sha256').update(material).digest('hex') };
}
