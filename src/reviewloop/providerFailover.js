// Bounded provider failover for ONE metered Reviewer/Supervisor call.
//
// Each physical attempt re-routes (excluding failed families), re-authorizes
// (fresh permit) and re-binds the CallIntent to the family actually selected.
// Safe transient failures (an auth-refresh race, a pre-send network loss) get
// bounded same-family retries before normal pool failover takes over. All
// sequencing state is rebuilt from durable attempt records, so a crash cannot
// reset a retry budget or grant an extra physical call. Behaviour is unchanged
// from when this lived inside controller.js.

import { isAuthorizationFailure } from '../orchestrator/errors.js';
import { DEFAULT_ROLE_POLICY } from '../orchestrator/roleRouting.js';

// Absolute ceiling on physical provider attempts for one metered operation —
// purely a runaway guard. The EFFECTIVE bound is the role's own candidate count
// (see providerAttemptBudget): every DEFAULT_ROLE_POLICY candidate must be
// mechanically reachable when each earlier candidate fails safely, so a role
// with N candidates gets up to N attempts. The `tried` set already stops a
// family being re-attempted and `!selection` stops the loop when the pool is
// exhausted; this ceiling only exists so a pathological policy can never spin.
const PROVIDER_ATTEMPT_HARD_CEILING = 16;

export function providerAttemptBudget(role) {
  const n = DEFAULT_ROLE_POLICY[role]?.length ?? 0;
  return Math.min(Math.max(n, 1), PROVIDER_ATTEMPT_HARD_CEILING);
}

// Provider-failure codes that a bounded failover attempt may follow. All are
// either "the call never reached the provider" (pre-send: unavailable, ENOENT,
// spawn failure, CLI not authenticated) or "reached it but produced no usable
// result and no unresolved spend" (rate limit, quota, protocol error, timeout
// classified as mechanically bounded). A mid-flight failure with unknown usage
// never lands here — dispatch() has already turned it into a spend-blocking
// AuthorizationError.
//
// PROVIDER_AUTH_FAILED is retryable-via-failover on purpose: an unauthenticated
// CLI transport (`codex` / `claude` not logged in) is a pre-send failure with
// no spend, and RoleRouter.recordFailure already treats it as health-affecting
// (family removed, AUTH_FAILED). Trying the next eligible family is exactly the
// intended recovery; if every family is unauthenticated the loop still
// exhausts and rethrows.
export const RETRYABLE = new Set([
  'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_PROTOCOL_ERROR', 'PROVIDER_AUTH_FAILED',
  'EXECUTOR_TIMEOUT', 'AGY_ENOENT', 'AGY_SPAWN_FAILED', 'AGY_NETWORK_UNAVAILABLE',
]);

// A failure the transport itself proved safe to retry on the same family:
// 'auth' (credential-refresh race, nothing billed) or 'network' (path lost
// before any request reached the provider). Transports opt in by setting
// transientAuth / transientNetwork on the error; the controller deliberately
// does not care which provider produced it, so a new transport only needs a
// classifier that sets the flag.
export function transientKindOf(code, flags) {
  if (code === 'PROVIDER_AUTH_FAILED' && flags?.transientAuth === true) return 'auth';
  if (code === 'AGY_NETWORK_UNAVAILABLE' && flags?.transientNetwork === true) return 'network';
  return null;
}

// One logical review dispatch may absorb two mechanically-proven transient AGY
// failures before the family is marked failed and normal pool failover takes
// over. This covers the existing canonical 401/OAuth refresh race AND the
// narrow pre-send network-path failures normalized as AGY_NETWORK_UNAVAILABLE.
//
// Each retry is a brand-new physical AGY process/connection, but it replays the
// same logical review request. This mirrors the operator behavior of re-running
// "continue" after a stuck terminal session without inventing a new prompt.
//
// These are PHYSICAL attempts: each still goes through a fresh
// ModelSpendAuthority permit/reservation and is durably recorded. They do not
// consume an extra review/fix round.
export const DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);

export function normalizeTransientAuthRetryDelays(delays) {
  if (!Array.isArray(delays)) return [...DEFAULT_TRANSIENT_AUTH_RETRY_DELAYS_MS];
  return delays
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(0, 4)
    .map((v) => Math.floor(v));
}

function retryCancelledError() {
  return Object.assign(new Error('ReviewLoop: cancelled during transient-auth retry backoff'), {
    code: 'REVIEW_CANCELLED',
    cancelled: true,
  });
}

export function defaultRetrySleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) {
    if (signal?.aborted) return Promise.reject(retryCancelledError());
    return Promise.resolve();
  }
  if (signal?.aborted) return Promise.reject(retryCancelledError());

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(retryCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function createMeteredWithFailover({
  transientAuthRetryDelays, sleepFn, recordProviderFailure, onEvent, preflightQuotaFn, assertLeaseHeld,
}) {
    // One metered provider call with bounded failover. Each physical attempt
    // re-routes (excluding failed families), re-authorizes (fresh permit), and
    // re-binds the CallIntent to the actually-selected family. A provider
    // failure is not New Information: every attempt supplies the SAME single
    // composite evidenceId, and attempt 1 durably CONSUMES it. Attempts 2..N
    // (attempt > 1) are authorized by that same prior claim — one logical
    // (diff + gate) state authorizes exactly one dispatch SEQUENCE, bounded by
    // the role's candidate count — never a fresh consumption per attempt, and never
    // a fresh dispatch on identical evidence for a first attempt (crash/resume
    // re-call included).
    return async function meteredWithFailover({
      spend, role, routeFn, defaultFamily, defaultProvider, operationId, evidenceIds, invoke, workflowId = null, signal = null,
      // Durable physical-call-audit identity forwarded verbatim into the spend
      // record (round / chunkIndex / chunkTotal; quotaPools is filled in below
      // from the resolved routing selection) — see reviewSpend.js meteredCall.
      auditContext = null,
      // Fired once per PHYSICAL failover attempt that actually reached (or tried
      // to reach) a provider — never for an authorization/spend denial, which
      // never dispatches. Lets the caller build a durable audit trail of every
      // physical attempt (family/provider/quotaPool/outcome), not just the last
      // one that happened to succeed. Success itself is recorded by the caller
      // (it alone sees the raw provider envelope's resolvedModel/usage before
      // meteredCall reduces it to a bare business value).
      onAttempt = null,
    }) {
      const tried = new Set();
      // Effective attempt bound = role candidate count PLUS the bounded AGY
      // same-family transient retry allowance. The two extra slots are shared by
      // canonical auth-refresh races and mechanically-proven pre-send network
      // failures. Ordinary provider failures still traverse each policy
      // candidate at most once.
      const maxAttempts = providerAttemptBudget(role) + transientAuthRetryDelays.length;
      let transientRetriesUsed = 0;
      let lastErr = null;
      let priorAttempts = [];
      // Resume/continuation is derived from DURABLE physical-attempt records, not
      // process-local counters. A crash during the 2s/5s backoff therefore cannot
      // reset either the physical attempt number or the two-retry auth budget.
      // The New Information ledger remains the authorization authority; these
      // records only restore bounded sequencing state.
      let startAttempt = 1;
      // Durable human exclusions (fail closed: if the ledger cannot be read, no
      // physical attempt is made — authorize() would reject anyway).
      const humanExcluded = typeof spend.excludedFamilies === 'function'
        ? await spend.excludedFamilies()
        : new Set();
      try {
        priorAttempts = typeof spend.attemptRecords === 'function'
          ? await spend.attemptRecords({ role, operationId })
          : [];
        const attemptNumbers = priorAttempts
          .map((r) => Number(r.attempt))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (attemptNumbers.length > 0) {
          startAttempt = Math.max(...attemptNumbers) + 1;
        }
        // Retry history comes from the durable attempt records, so a process
        // restart cannot reset the same-family transient retry budget.
        transientRetriesUsed = priorAttempts.filter((r) => transientKindOf(r.failureCode, r)).length;

        // Backward-compatible fallback for a consumed claim written by an older
        // build that has no spend-attempt projection. Starting at 2 preserves the
        // existing failover-reuse safety rule; authorize() still re-checks the
        // durable reservation ledger before any physical call.
        if (startAttempt === 1) {
          const priorClaim = await spend.informationLedger?.findConsumedBy?.({
            workflowId, role, operationId, evidenceIds,
          });
          if (priorClaim) startAttempt = 2;
        }
      } catch {
        // Fail closed on the actual call path: authorize() independently checks
        // durable information/reservations. We only lose resume convenience here,
        // never bypass spend safety.
      }

      // Crash window hardening: the third same-family safe transient failure is
      // durably appended BEFORE recordProviderFailure() runs. If the process dies
      // in that tiny window, a fresh router would otherwise consider the family
      // healthy and grant an unintended fourth AGY call. Reconstruct exhausted
      // families from the durable spend log and restore the missing health
      // transition BEFORE routing any new physical attempt.
      const exhaustedTransientFamilies = new Map();
      const exhaustedFamilies = new Set();
      for (const record of priorAttempts) {
        if (typeof record?.family !== 'string') continue;
        if (!transientKindOf(record?.failureCode, record)) continue;

        const entry = exhaustedTransientFamilies.get(record.family) ?? {
          family: record.family,
          provider: record.provider,
          failures: 0,
          lastAttempt: -1,
          lastFailureCode: null,
          lastTransientAuth: false,
          lastTransientNetwork: false,
        };
        entry.failures += 1;

        // Mixed transient sequences share one retry budget, but the LAST
        // physical failure is what exhausted that budget. Never let an earlier
        // auth-refresh race poison provider health when a later network outage is
        // the actual exhausting condition (or vice versa).
        const physicalAttempt = Number(record?.attempt);
        const ordering = Number.isInteger(physicalAttempt) && physicalAttempt > 0
          ? physicalAttempt
          : entry.lastAttempt + 1;
        if (ordering >= entry.lastAttempt) {
          entry.lastAttempt = ordering;
          entry.provider = record.provider ?? entry.provider;
          entry.lastFailureCode = record.failureCode ?? null;
          entry.lastTransientAuth = record?.transientAuth === true;
          entry.lastTransientNetwork = record?.transientNetwork === true;
        }
        exhaustedTransientFamilies.set(record.family, entry);
      }
      for (const entry of exhaustedTransientFamilies.values()) {
        if (entry.failures <= transientAuthRetryDelays.length) continue;
        // Keep exhaustion scoped to THIS logical operation. Network path loss is
        // attempt-local and must not poison provider health for future reviews.
        // Auth exhaustion still records AUTH_FAILED because credentials remain a
        // durable operator concern until corrected.
        exhaustedFamilies.add(entry.family);
        tried.add(entry.family);
        const exhaustedByAuth =
          entry.lastFailureCode === 'PROVIDER_AUTH_FAILED'
          && entry.lastTransientAuth === true;
        if (exhaustedByAuth && recordProviderFailure) {
          recordProviderFailure(
            { role, family: entry.family, provider: entry.provider },
            {
              code: 'PROVIDER_AUTH_FAILED',
              recoveredFromDurableTransientExhaustion: true,
              recoveredFromDurableAuthExhaustion: true,
            },
          );
        }
        onEvent?.({
          type: 'ROLE_PROVIDER_TRANSIENT_EXHAUSTION_RESTORED',
          role,
          family: entry.family,
          provider: entry.provider,
          failureCode: entry.lastFailureCode,
          exhaustedBy: exhaustedByAuth
            ? 'auth'
            : (entry.lastTransientNetwork === true ? 'network' : 'unknown'),
          failures: entry.failures,
        });
      }

      // Refresh a bounded, zero-model-turn quota snapshot before selecting the
      // first provider. A failed/unsupported probe is just UNKNOWN: ordinary
      // routing and its strict unknown-spend safety invariants remain intact.
      if (typeof preflightQuotaFn === 'function') {
        await assertLeaseHeld(workflowId);
        try {
          const quota = await preflightQuotaFn({ role, workflowId });
          if (quota?.checked && quota.exhaustedPools?.length) {
            onEvent?.({
              type: 'AGY_QUOTA_PREFLIGHT_EXHAUSTED',
              role, workflowId, pools: quota.exhaustedPools,
            });
          }
        } catch {
          // Never let a read-only quota service failure masquerade as a
          // provider failure, zero spend, or permission for another model call.
        }
      }

      for (let attempt = startAttempt; attempt < startAttempt + maxAttempts; attempt += 1) {
        let selection = null;
        if (routeFn) {
          // Per-call audit attribution — passed fresh on every call, never
          // stored on the (long-lived, shared-across-loops) router. Built from
          // whatever this specific physical attempt already carries.
          const requestContext = {
            loopId: workflowId ?? null,
            operationId: operationId ?? null,
            attempt,
            round: auditContext?.round ?? null,
            chunkIndex: auditContext?.chunkIndex ?? null,
            chunkTotal: auditContext?.chunkTotal ?? null,
          };
          selection = routeFn({
            reworkCycles: attempt - startAttempt,
            excludeFamilies: [...new Set([...exhaustedFamilies, ...humanExcluded])],
          }, requestContext);
          if (!selection) break;
          if (tried.has(selection.family)) break;
          tried.add(selection.family);
        }
        const family = selection?.family ?? defaultFamily;
        const provider = selection?.provider ?? defaultProvider;

        if (humanExcluded.has(family)) {
          lastErr ??= Object.assign(
            new Error('ReviewLoop: ' + family + ' was excluded by a human recovery and no other candidate is eligible'),
            { code: 'HUMAN_ROUTING_EXCLUDED', providerFailure: 'HUMAN_ROUTING_EXCLUDED' },
          );
          break;
        }

        // Exhaustion is a dispatch invariant, not a routing implementation
        // detail. A route-less controller has no selection to consult, so the
        // default family must be blocked here too once durable history proves
        // that its initial safe transient failure + both same-family retries were
        // spent.
        if (exhaustedFamilies.has(family)) {
          lastErr ??= Object.assign(
            new Error('ReviewLoop: transient retry budget exhausted for ' + family),
            {
              code: 'AGY_TRANSIENT_RETRY_EXHAUSTED',
              providerFailure: 'AGY_TRANSIENT_RETRY_EXHAUSTED',
            },
          );
          break;
        }

        try {
          // Fail closed if we no longer hold the loop lease: never start a new
          // paid provider attempt on behalf of a review another owner has taken
          // over. (LeaseLostError is not retryable — it propagates to review().)
          // eslint-disable-next-line no-await-in-loop
          await assertLeaseHeld(workflowId);
          // eslint-disable-next-line no-await-in-loop
          return await spend.meteredCall({
            role, family, provider, model: selection?.model ?? null,
            operationId, attempt, evidenceIds,
            auditContext: auditContext ? { ...auditContext, quotaPools: selection?.quotaPools ?? null } : null,
            call: () => invoke({
              selection, attempt, family, provider,
            }),
          });
        } catch (err) {
          lastErr = err;
          if (isAuthorizationFailure(err)) throw err; // spend/objective denial — never dispatched, never retried
          const code = err?.code ?? err?.providerFailure ?? '';
          const transientKind = transientKindOf(code, err);
          const transientAuth = transientKind === 'auth';
          const transientNetwork = transientKind === 'network';
          const transientSameFamily = transientKind !== null;

          onAttempt?.({
            attempt, family, provider, quotaPools: selection?.quotaPools ?? null, outcome: 'FAILURE', code,
          });
          if (!RETRYABLE.has(code)) throw err;

          if (transientSameFamily && transientRetriesUsed < transientAuthRetryDelays.length) {
            const delayMs = transientAuthRetryDelays[transientRetriesUsed];
            transientRetriesUsed += 1;

            // Do NOT poison provider health for a one-off OAuth refresh race or
            // transient VPN/socket path loss. Let the deterministic router select
            // the same healthy family again. The next physical call is a fresh
            // provider process/connection and still gets a fresh spend permit.
            if (selection) tried.delete(selection.family);
            onEvent?.({
              type: transientAuth
                ? 'ROLE_PROVIDER_TRANSIENT_AUTH_RETRY'
                : 'ROLE_PROVIDER_TRANSIENT_NETWORK_RETRY',
              role,
              family,
              provider,
              attempt,
              retry: transientRetriesUsed,
              delayMs,
            });

            // eslint-disable-next-line no-await-in-loop
            await sleepFn(delayMs, signal);
            // loop -> same family is eligible again
            continue;
          }

          // Either this was an ordinary retryable provider failure, or the AGY
          // safe-transient retry budget was exhausted. Exhaustion is a dispatch
          // invariant: record it immediately in THIS process too, not only on
          // restart reconstruction from durable history.
          if (transientSameFamily) {
            exhaustedFamilies.add(family);
          }

          // Auth exhaustion is durable health. A transient network outage is
          // only operation-local: exclude this family for the remainder of the
          // current dispatch, but let a future independent review try it again.
          if (selection && recordProviderFailure && !transientNetwork) {
            recordProviderFailure(selection, {
              code,
              ...(Number.isFinite(err?.retryAfter) ? { retryAfter: err.retryAfter } : {}),
              ...(typeof err?.resetAt === 'string' ? { resetAt: err.resetAt } : {}),
            });
          }

          // Routed calls may now fail over to a different family. Route-less
          // calls have no alternate selection, so once the default family is
          // exhausted they must stop here instead of entering a fourth physical
          // attempt in the same process.
          if (transientSameFamily && !selection) break;
          // loop -> next attempt re-routes (or ordinary retryable default failure)
        }
      }
      throw lastErr ?? new Error(`ReviewLoop: no eligible ${role} provider`);
    };
}
