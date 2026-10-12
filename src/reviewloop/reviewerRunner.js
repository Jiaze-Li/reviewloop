// Bounded Reviewer execution: chunking, accounting, checkpointing and aggregation.
import { reconstructPhysicalCalls } from './reviewSpend.js';
import { chunkDiffForReview } from './diffChunker.js';
import { sha256Hex, scopeBoundFingerprint, currentReviewScope } from './phaseState.js';
import { normalizeReview } from './reviewPolicy.js';

export function createReviewerRunner({ persistence, env, reviewerFn, routeReviewerFn, meteredWithFailover, saveLoop }) {
  async function runReviewerOverEvidence({
    spend, loopState, objective, delta, gate, reviewScope = currentReviewScope(loopState, objective),
    evidenceBundle = null, evidenceProofFingerprint = '', signal,
  }) {
    // Every PHYSICAL Reviewer attempt for this call — one entry per failover
    // retry AND per chunk, success or failure. Never collapsed into a single
    // abstract "internal" — the durable PR audit (appendAuditRecord) needs to
    // answer "which physical model reviewed this SHA", including every
    // attempt a failover/chunking round made along the way.
    const physicalCalls = [];
    // Crash/resume durability: reconcile the in-memory `physicalCalls` built
    // by THIS process against the durable spend log for the round actually
    // being reviewed. The durable log is a strict superset whenever it has
    // anything at all — every physical attempt (this process's or an earlier,
    // crashed one's) settles its accounting record durably BEFORE meteredCall
    // returns (reviewSpend.js), tagged with the same round/chunkIndex/attempt
    // identity. A chunk served from `loopState.chunkReviewCheckpoint` (a
    // prior, possibly crashed, process reviewed it) has NOTHING in this
    // process's `physicalCalls` array, so without this reconciliation its
    // physical attempts would silently vanish from the durable audit record.
    // Falls back to the in-memory list on a durable-read failure or an empty
    // result (e.g. a persistence-less unit test) — never throws the review
    // closed over an audit-trail nicety.
    const withDurablePhysicalCalls = async (inMemory) => {
      try {
        const durable = await reconstructPhysicalCalls({
          persistence, loopId: loopState.loopId, role: 'reviewer', round: loopState.round,
        });
        return durable.length ? durable : inMemory;
      } catch { return inMemory; }
    };
    // Global round + gateRound are bound to the LOGICAL review state
    // (delta + gate fingerprint + review-scope fingerprint),
    // NOT to how many times reviewloop_review was invoked. A crash/resume that
    // re-enters with the SAME logical review state — its durable per-chunk
    // checkpoint is still on record — reuses the round it already assigned and
    // never consumes another of the objective's max review rounds.
    const { chunks, oversized, reason } = chunkDiffForReview(delta.diff, { env });
    if (oversized) {
      return {
        review: {
          status: 'FAILED', reviewer: 'internal', provider: 'internal',
          blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
          findingSignatures: [], error: { reason: 'REVIEW_TOO_LARGE', message: reason }, physicalCalls,
        },
        chunkCount: chunks.length,
      };
    }

    // The per-chunk checkpoint identity MUST cover the actual chunk layout, not
    // just the (delta + gate) fingerprints. `chunkDiffForReview` depends on
    // REVIEWLOOP_MAX_REVIEW_DIFF_CHARS; a crash/resume under a larger value
    // re-chunks the same diff into different boundaries. Without the layout in
    // that key, the stored result for old chunk 0 would be reused for the new,
    // larger chunk 0 and its added portion never reviewed — yet aggregation
    // could still return CLEAN/PASS. Any layout change now yields a new
    // checkpoint key and a full re-review of every chunk.
    //
    // The ROUND, however, is bound to the LOGICAL review state alone — the
    // (delta + gate) fingerprint pair — never to the chunk layout on top of
    // it. A crash/resume under a different REVIEWLOOP_MAX_REVIEW_DIFF_CHARS
    // re-chunks the SAME (delta + gate) state; that must invalidate the
    // per-chunk results (a layout change) but must NOT consume another of the
    // objective's max review rounds — the Reviewer has not been asked to
    // reconsider new evidence, only re-chunked old evidence. `deltaGateKey` is
    // tracked separately from the layout-inclusive `checkpointKey` so round
    // reuse survives a re-chunk.
    const reviewStateParts = evidenceProofFingerprint
      ? [delta.fingerprint, gate.fingerprint, evidenceProofFingerprint]
      : [delta.fingerprint, gate.fingerprint];
    const deltaGateKey = scopeBoundFingerprint(reviewStateParts, reviewScope);
    const chunkLayoutHash = sha256Hex(`${chunks.length}::${chunks.map((c) => c.hash).join('::')}`);
    const checkpointKey = sha256Hex(`${deltaGateKey}::${chunkLayoutHash}`);
    const resumeCheckpoint = loopState.chunkReviewCheckpoint;
    if (resumeCheckpoint && resumeCheckpoint.deltaGateKey === deltaGateKey
      && Number.isInteger(resumeCheckpoint.round)) {
      loopState.round = resumeCheckpoint.round;
      // Backward compatibility: persisted loops/checkpoints from before
      // gate-local/epoch convergence existed fall back to their paid round
      // counters instead of silently resetting allowance.
      loopState.gateRound = Number.isInteger(resumeCheckpoint.gateRound)
        ? resumeCheckpoint.gateRound
        : (Number.isInteger(loopState.gateRound)
          ? loopState.gateRound
          : resumeCheckpoint.round);
      loopState.convergenceEpoch = Number.isInteger(resumeCheckpoint.convergenceEpoch)
        ? resumeCheckpoint.convergenceEpoch
        : (Number.isInteger(loopState.convergenceEpoch) ? loopState.convergenceEpoch : 0);
      loopState.epochReviewRound = Number.isInteger(resumeCheckpoint.epochReviewRound)
        ? resumeCheckpoint.epochReviewRound
        : (Number.isInteger(loopState.epochReviewRound)
          ? loopState.epochReviewRound
          : loopState.gateRound);
    } else {
      const priorGateRound = Number.isInteger(loopState.gateRound)
        ? loopState.gateRound
        : loopState.round;
      const priorEpochRound = Number.isInteger(loopState.epochReviewRound)
        ? loopState.epochReviewRound
        : priorGateRound;
      if (!Number.isInteger(loopState.convergenceEpoch)) loopState.convergenceEpoch = 0;
      loopState.round += 1;
      loopState.gateRound = priorGateRound + 1;
      loopState.epochReviewRound = priorEpochRound + 1;
    }

    // Durable per-chunk checkpoint. Keyed to the exact review state INCLUDING
    // chunk layout (`checkpointKey`); a changed diff OR a changed chunk layout
    // invalidates the stored per-chunk results, so a re-chunked round always
    // re-sends every chunk to the model under the new boundaries — but
    // `deltaGateKey` alone (above) governs round assignment, so that re-chunk
    // reuses this logical state's already-assigned round instead of consuming
    // a fresh one.
    let checkpoint = loopState.chunkReviewCheckpoint;
    if (!checkpoint || checkpoint.key !== checkpointKey || checkpoint.chunkTotal !== chunks.length) {
      checkpoint = {
        key: checkpointKey,
        deltaGateKey,
        chunkTotal: chunks.length,
        chunks: {},
        round: loopState.round,
        gateRound: loopState.gateRound,
        convergenceEpoch: loopState.convergenceEpoch ?? 0,
        epochReviewRound: loopState.epochReviewRound ?? loopState.gateRound,
        reviewScopeFingerprint: reviewScope.fingerprint,
      };
      loopState.chunkReviewCheckpoint = checkpoint;
    } else if (!Number.isInteger(checkpoint.round)) {
      checkpoint.round = loopState.round;
    }

    const perChunk = [];
    for (const chunk of chunks) {
      if (signal?.aborted) {
        // The MCP client cancelled the review. Do NOT start another paid model
        // dispatch — fail the review closed (never CLEAN/PASS on a cancel).
        return {
          review: {
            status: 'FAILED', reviewer: 'internal', provider: 'internal',
            blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
            findingSignatures: [], error: { reason: 'REVIEW_CANCELLED', message: 'the review was cancelled by the caller' },
            physicalCalls: await withDurablePhysicalCalls(physicalCalls),
          },
          chunkCount: chunks.length,
        };
      }
      const done = checkpoint.chunks[chunk.index];
      if (done) {
        // Resume: this chunk was already reviewed in a prior (crashed) attempt.
        if (done.status === 'FAILED') {
          return {
            review: { ...done, physicalCalls: await withDurablePhysicalCalls(physicalCalls) },
            chunkCount: chunks.length,
            failedChunk: chunk.index,
          };
        }
        perChunk.push(done);
        continue;
      }
      const chunkId = `${loopState.loopId}:round-${loopState.round}:chunk-${chunk.index}`;
      // ONE composite logical review-state evidence per chunk: the diff chunk
      // AND the gate fingerprint together. A single logical (diff + gate) state
      // authorizes exactly ONE physical Reviewer dispatch SEQUENCE — bounded
      // failover retries of that same operation reuse this one claim, and it is
      // never re-earned by a re-call on identical evidence (crash/resume
      // included). Multiple evidenceIds no longer multiply dispatch eligibility.
      // eslint-disable-next-line no-await-in-loop
      const reviewStateEvidence = await spend.registerEvidence({
        kind: 'reviewstate',
        taskId: chunkId,
        diffHash: scopeBoundFingerprint(
          evidenceProofFingerprint
            ? [chunk.hash, gate.fingerprint, evidenceProofFingerprint]
            : [chunk.hash, gate.fingerprint],
          reviewScope,
        ),
      });
      // eslint-disable-next-line no-await-in-loop
      const raw = await meteredWithFailover({
        spend,
        role: 'reviewer',
        routeFn: routeReviewerFn,
        defaultFamily: 'agy:gpt-oss',
        defaultProvider: 'agy',
        operationId: chunkId,
        workflowId: loopState.loopId,
        evidenceIds: [reviewStateEvidence.evidenceId],
        signal,
        auditContext: { round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total },
        onAttempt: (a) => physicalCalls.push({
          role: 'reviewer', round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total,
          attempt: a.attempt, family: a.family, provider: a.provider, quotaPools: a.quotaPools,
          resolvedModel: null, usage: null, outcome: a.outcome, code: a.code,
        }),
        invoke: ({
          selection, attempt, family, provider,
        }) => Promise.resolve(reviewerFn({
          objective,
          diff: chunk.text,
          changedFiles: delta.changedFiles,
          gate,
          reviewScope,
          diffScope: delta.diffScope ?? 'cumulative',
          round: loopState.round,
          chunk: { index: chunk.index, total: chunk.total },
          previousFindings: loopState.lastReview?.blockingFindings ?? [],
          supervisorGuidance: loopState.pendingReviewerReconsideration?.guidance ?? null,
          evidence: evidenceBundle,
          selection,
          signal,
        })).then((out) => {
          // Captured HERE, before meteredCall reduces the result to a bare
          // business value: the ONE place the actually-resolved model and raw
          // provider usage for THIS physical attempt are still visible.
          physicalCalls.push({
            role: 'reviewer', round: loopState.round, chunkIndex: chunk.index, chunkTotal: chunk.total,
            attempt, family: selection?.family ?? family ?? null, provider: selection?.provider ?? provider ?? null,
            quotaPools: selection?.quotaPools ?? null, resolvedModel: out?.model ?? selection?.model ?? null,
            usage: out?.usage ?? null, outcome: 'SUCCESS', code: null,
          });
          return {
            value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
          };
        }),
      });
      loopState.reviewerCalls += 1;
      const normalized = normalizeReview({ raw, reviewer: 'internal', provider: 'internal' });
      // Durable-before-next-chunk: persist this chunk's result so a crash before
      // the round completes does not re-call the model for it on resume.
      checkpoint.chunks[chunk.index] = normalized;
      // eslint-disable-next-line no-await-in-loop
      await saveLoop(loopState);
      // Any chunk we could not review successfully fails the whole review closed.
      if (normalized.status === 'FAILED') {
        return {
          review: { ...normalized, physicalCalls: await withDurablePhysicalCalls(physicalCalls) },
          chunkCount: chunks.length,
          failedChunk: chunk.index,
        };
      }
      perChunk.push(normalized);
    }

    // Aggregate: union of findings across every successfully-reviewed chunk.
    const bySig = new Map();
    for (const r of perChunk) {
      for (const f of [...r.blockingFindings, ...r.nonBlockingFindings.map((n) => ({ ...n, signature: `${n.severity}:${n.file ?? ''}:${n.title ?? ''}` }))]) {
        if (f.signature && !bySig.has(f.signature)) bySig.set(f.signature, f);
      }
    }
    const findings = [...bySig.values()];
    const blocking = findings.filter((f) => objective.blockingSeverities.includes(f.severity));
    return {
      review: {
        status: blocking.length ? 'ACTIONABLE' : 'CLEAN',
        reviewer: 'internal',
        provider: 'internal',
        reviewedHead: delta.currentHead,
        blockingFindings: blocking,
        nonBlockingFindings: findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).slice(0, 8),
        nonBlockingOmitted: Math.max(0, findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).length - 8),
        findingSignatures: [...new Set(blocking.map((f) => f.signature).filter(Boolean))].sort(),
        error: null,
        physicalCalls: await withDurablePhysicalCalls(physicalCalls),
      },
      chunkCount: chunks.length,
    };
  }

  return runReviewerOverEvidence;
}
