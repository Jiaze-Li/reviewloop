// Implements docs/workflow/ADAPTER_INTERFACE.md §5 error model.

export class AdapterError extends Error {
  // `details` carries safe, non-content diagnostics (exit code, stderr,
  // duration, model) for operator-facing logging. It never holds prompt or
  // model-reply text. Optional and free-form; consumers must treat every
  // field as possibly absent.
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'AdapterError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

// A cancellation is NOT a provider failure. When an in-flight provider call
// is aborted (AbortSignal, agy AGY_ABORTED, a killed child process), the
// runtime must propagate this immediately and perform ZERO failover — it
// must never be classified as PROVIDER_UNAVAILABLE, and it must never poison
// provider-health or quota state.
export class ProviderCancelledError extends Error {
  constructor(message = 'provider call cancelled', details) {
    super(message);
    this.name = 'ProviderCancelledError';
    this.code = 'PROVIDER_CANCELLED';
    this.cancelled = true;
    if (details && typeof details === 'object') this.details = details;
  }
}

// Recognises every cancellation shape that can reach the role runtime:
//   - an aborted AbortSignal handed to invoke()
//   - AbortError / ABORT_ERR from a native aborted operation
//   - AGY_ABORTED from src/agy/agyClient.js
//   - CancellationError from src/orchestrator/the removed orchestrator
//   - ProviderCancelledError (above), or any error tagged { cancelled: true }
//   - an AdapterError whose providerFailure is PROVIDER_CANCELLED
export function isCancellation(error, signal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  if (error.cancelled === true) return true;
  const names = new Set(['AbortError', 'CancellationError', 'ProviderCancelledError']);
  if (names.has(error.name)) return true;
  const codes = new Set(['ABORT_ERR', 'AGY_ABORTED', 'CANCELLED', 'PROVIDER_CANCELLED']);
  const code = error.code ?? error.details?.providerFailure ?? error.providerFailure ?? null;
  return codes.has(code);
}

// V2-C trusted PR-closeout trust-boundary failures. Every one of these is a
// fail-closed condition: the deterministic closeout loop must stop and surface
// the reason rather than guess when reviewer identity, PR head, write
// capability, or repair safety cannot be established.
export class PrCloseoutError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'PrCloseoutError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const PR_CLOSEOUT_ERROR_CODES = Object.freeze({
  UNTRUSTED_REVIEWER: 'UNTRUSTED_REVIEWER',
  STALE_REVIEW_HEAD: 'STALE_REVIEW_HEAD',
  MALFORMED_REVIEW: 'MALFORMED_REVIEW',
  UNSAFE_REPAIR_ACTION: 'UNSAFE_REPAIR_ACTION',
  FORK_WRITE_FORBIDDEN: 'FORK_WRITE_FORBIDDEN',
  REPAIR_GATE_NOT_PASSED: 'REPAIR_GATE_NOT_PASSED',
  THREAD_RESOLUTION_UNAVAILABLE: 'THREAD_RESOLUTION_UNAVAILABLE',
});

// Token-Safety authorization boundary. A permit / spend-authorization failure
// is an ORCHESTRATOR decision, never evidence that a provider is unavailable:
// the role runtime must propagate it immediately, perform ZERO failover, and
// must never mutate provider-health or quota state. It is deliberately NOT an
// AdapterError and is never classified through providerFailure().
export class AuthorizationError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'AuthorizationError';
    this.code = code;
    this.authorizationFailure = true;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const AUTHORIZATION_ERROR_CODES = Object.freeze({
  // authorize() rejected the CallIntent before any permit was issued
  SPEND_DENIED: 'SPEND_DENIED',
  INTENT_INCOMPLETE: 'INTENT_INCOMPLETE',
  // dispatch() refused to run without / with an invalid permit
  PERMIT_MISSING: 'PERMIT_MISSING',
  PERMIT_UNKNOWN: 'PERMIT_UNKNOWN',
  PERMIT_CONSUMED: 'PERMIT_CONSUMED',
  PERMIT_INTENT_MISMATCH: 'PERMIT_INTENT_MISMATCH',
  // authorize() rejected the CallIntent because the provider/family is not
  // declared executorEligible for this role (see providerCapabilities.js).
  PROVIDER_NOT_ELIGIBLE_FOR_ROLE: 'PROVIDER_NOT_ELIGIBLE_FOR_ROLE',
  // authorize() rejected the CallIntent because this workflow already has an
  // UNRESOLVED model spend reservation — a prior physical call may have
  // dispatched with usage that could not be reliably settled. See
  // modelSpendReservation.js. Blocks EVERY internal role, not only Executor.
  MODEL_SPEND_USAGE_UNRESOLVED: 'MODEL_SPEND_USAGE_UNRESOLVED',
  // authorize() could not durably persist the reservation required before a
  // permit may be issued. Fail closed: zero physical provider calls.
  RESERVATION_PERSIST_FAILED: 'RESERVATION_PERSIST_FAILED',
  // dispatch() ran the physical provider call (with reliably known usage,
  // success or failure) but the SETTLED_KNOWN write could not be durably
  // persisted. This is an orchestrator persistence failure, never provider
  // failure: it must never trigger failover or mark a provider unhealthy,
  // and it blocks every further internal model spend attempt in the same
  // workflow.
  MODEL_SPEND_SETTLEMENT_PERSIST_FAILED: 'MODEL_SPEND_SETTLEMENT_PERSIST_FAILED',
  // Resume could not reliably reconcile persisted Reservation state before
  // the first invoke() of this process. Reconciliation is safety-critical,
  // not best-effort — an unreconciled ledger is treated as unsafe.
  MODEL_SPEND_RECONCILIATION_FAILED: 'MODEL_SPEND_RECONCILIATION_FAILED',
  // dispatch() ran the physical provider call and usage could NOT be
  // reliably determined, but the durable UNRESOLVED write itself failed
  // (§ Phase 0B). This is an orchestrator persistence failure, never a
  // provider outcome: it must never be classified as provider unavailable/
  // timeout/protocol error, must never trigger failover, and must never
  // mutate provider health. The reservation's durable status remains
  // whatever it was before this write attempted (DISPATCHING in production
  // usage), which is itself already a blocking status.
  MODEL_SPEND_UNRESOLVED_PERSIST_FAILED: 'MODEL_SPEND_UNRESOLVED_PERSIST_FAILED',
  // A Global New Information denial (Phase 1-6): the CallIntent is otherwise
  // eligible (provider/budget/reservation all clear) but no fresh, unconsumed
  // evidence justifies this physical call for this role/operation.
  NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED: 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED',
  // The durable New Information ledger could not be read, or a claimed
  // evidence consumption could not be durably persisted. Fail closed: zero
  // physical provider calls.
  MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE: 'MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE',
  // Post-settlement single-call Token Sentinel (reviewSpend.js). A physical
  // Reviewer/Supervisor call's usage settled RELIABLY but a single call's
  // usageVolume (or its known transport context overhead) exceeded the
  // per-call ceiling. The anomalous call is fully, durably accounted; this is
  // then latched durably for the loop so every further internal model spend
  // fails closed across a process restart. It is an orchestrator safety stop,
  // never provider failure: zero auto-failover, no provider health/quota
  // mutation.
  MODEL_SPEND_TOKEN_ANOMALY_BLOCKED: 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  // The durable single-call Token Sentinel latch could not be READ, or a
  // detected anomaly could not be durably LATCHED. Fail closed: absence of a
  // latch cannot be established (or cannot be guaranteed to survive a restart),
  // so further internal model spend is refused. Never interpret unreadable
  // state as "no anomaly".
  // The selected family was explicitly excluded by a human while recovering an
  // unresolved reservation (spendRecovery.js). Routing normally never offers it;
  // this is the authorization-layer backstop so a known-bad entry can never be
  // dispatched again, whatever the router did.
  FAMILY_EXCLUDED_BY_HUMAN: 'FAMILY_EXCLUDED_BY_HUMAN',
  MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE: 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
});

export function isAuthorizationFailure(error) {
  return Boolean(error) && (error instanceof AuthorizationError || error.authorizationFailure === true);
}

export const ADAPTER_ERROR_CODES = Object.freeze({
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  EXECUTOR_TIMEOUT: 'EXECUTOR_TIMEOUT',
  // The local Executor budget is intentionally a terminal safety brake, not
  // an implementation failure that another model may silently retry.
  EXECUTOR_BUDGET_EXCEEDED: 'EXECUTOR_BUDGET_EXCEEDED',
  EXECUTOR_DUPLICATE_CALL_REJECTED: 'EXECUTOR_DUPLICATE_CALL_REJECTED',
  EXECUTOR_INVALID_OUTPUT: 'EXECUTOR_INVALID_OUTPUT',
  REVIEWER_UNAVAILABLE: 'REVIEWER_UNAVAILABLE',
  REVIEWER_TIMEOUT: 'REVIEWER_TIMEOUT',
  REVIEWER_INVALID_OUTPUT: 'REVIEWER_INVALID_OUTPUT',
  REVIEWER_CONTEXT_BUDGET_EXCEEDED: 'REVIEWER_CONTEXT_BUDGET_EXCEEDED',
  GATE_FAILED: 'GATE_FAILED',
  GATE_RUNNER_ERROR: 'GATE_RUNNER_ERROR',
  SUPERVISOR_INVALID_OUTPUT: 'SUPERVISOR_INVALID_OUTPUT',
  SUPERVISOR_ILLEGAL_TRANSITION: 'SUPERVISOR_ILLEGAL_TRANSITION',
  SUPERVISOR_UNAVAILABLE: 'SUPERVISOR_UNAVAILABLE',
  SUPERVISOR_TIMEOUT: 'SUPERVISOR_TIMEOUT',
  SUPERVISOR_CONTEXT_BUDGET_EXCEEDED: 'SUPERVISOR_CONTEXT_BUDGET_EXCEEDED',
});
