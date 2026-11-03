# RL-P0-01: Crash-safe model spend settlement

## Scope / status

Reliability/security maintenance for the existing ReviewLoop model-spend
reservation lifecycle. This design is driven by the reported SpinLab operation
`rl-20261102074142-9c4ea0a3:round-9:chunk-1`. **No actual SpinLab
workflow.json, AGY logs or provider billing records were read or edited in
this PR**. The particular incident's upstream cause, true usage and bill are
not established from source code alone. This change does not retroactively
reconcile its UNRESOLVED reservation.

## The repaired crash window

Previous path for a known-usage call:

1. `RESERVED` → durable `DISPATCHING`
2. Provider returns, usage becomes known
3. `SETTLED_KNOWN` in `modelSpendReservations` (**first write**)
4. Physical usage/cost in `reviewLoopSpend.records` (**second write**)
5. Save Reviewer chunk checkpoint (**later write**)

A crash between 3 and 4 left a settled reservation without a spend entry.
The old code detected it and blocked future spending conservatively; it could
not reconstruct the complete cost from the reservation.

This PR changes step 3/4 for *new known-usage ReviewLoop metered calls*:

- The Controller's durable spend path builds a full usage record from the
  provider result (or failure carrying reliable usage). No prompt or review
  text is needed to construct the accounting record.
- `ReservationLedger.settleKnownWithSpend()` stores the reservation state,
  exact spend record and optional Token Sentinel latch in **one workflow
  snapshot write**. The cache becomes SETTLED only after the write succeeds.
- The Controller never receives a successful review or a retryable provider
  failure until that write returns. No matching pair can be half-committed by
  an ordinary process crash; a fault before commit stays DISPATCHING (blocked).
- A repeated or contradictory record under the same reservation ID is
  rejected; duplicate spend is never appended by this path.
- If the provider's usage is missing or inadequate for mechanical accounting,
  the reservation remains UNRESOLVED and automatic spend is blocked. No
  guessed token total or fake zero settlement is permitted.
- The existing in-memory/test-only generic ModelSpendAuthority API remains
  backward compatible.

The full `workflow.json` now uses same-directory exclusive staging,
`fsync` on staged bytes, atomic `rename`, and directory `fsync`.
If storage durability cannot be established, the writer throws (fail closed).
This does not turn the file into a general database transaction across
uncoordinated processes: the existing loop lease remains mandatory.

## Operator: READ-ONLY investigation

Use the new CLI. The operation is the *logical* Chunk ID, not the UUID:

```sh
node bin/reviewloop.js inspect-spend \
  --loop rl-20261102074142-9c4ea0a3 \
  --operation rl-20261102074142-9c4ea0a3:round-9:chunk-1 \
  --json
```

Or target the reservation UUID from the output:

```sh
node bin/reviewloop.js inspect-spend \
  --loop <loopId> --reservation <reservation-uuid> --json
```

This command reads one workflow snapshot without modifying the reservation,
without `reconcileOnResume`, and without model calls. It reports only
bounded operational metadata: state, timestamps, family/provider, local IDs,
failure code, usage-availability, known token breakdown, cost-completeness and
inconsistency flags. It never prints prompt text, model responses, raw stderr
or secrets. If the current file is corrupted or missing, inspection errors
rather than inventing a clean state.

### Operator decision matrix

| Persisted status | Safe unattended action | Explanation |
|---|---|---|
| RESERVED | Cancel before dispatch, if positively verified | No physical call boundary was crossed |
| CANCELLED_PRE_DISPATCH | No model spend to reconcile | Proven pre-send |
| DISPATCHING | Block; investigate; reconciliation may promote to UNRESOLVED | Call MAY have been sent |
| UNRESOLVED | Human investigation and explicit acknowledgement if irrecoverable | UNKNOWN usage/cost must remain unknown |
| SETTLED_KNOWN + matching spend | Normal continuation subject to all budgets | Usage is durably accounted |
| Legacy SETTLED_KNOWN without spend | Block; manual investigation | No trustworthy complete receipt to restore |

The existing `acknowledge-spend` command is a human risk acceptance path:
it records an UNKNOWN entry and a single-use retry grant without rewriting
history. **Do not run it simply because a client timed out.** Confirm provider
evidence first, and do not run it as part of automated recovery. No task
should start a fresh loop to bypass the unresolved reservation.

## Provider-native identity / reconciliation decisions

The local `reservationId` and `operationId` are NOT provider request IDs
and cannot make an external model invocation idempotent. The existing
`usageCallId` is displayed only if returned in the settlement record;
the tool does not claim it is a verified provider billing lookup key.

No `reconcile-spend --input-tokens <number> --output-tokens <number>` write
command is introduced here. Manual numbers, `envelope.id`, or unverified
session IDs are **not sufficient evidence** that a bill belongs to a specific
physical dispatch. A future reconciliation CLI must first have a
provider-specific, verifiable receipt/query contract including immutable
provider request identity, exact token/cost semantics and duplicate-safe
comparison; if the provider cannot supply it, the existing UNKNOWN
acknowledgement is the honest recovery path.

## Failure-mode verification

The new tests inject failures at temp write/fsync, rename and directory fsync;
assert old-or-new snapshots with no accepted truncated file; exercise atomic
settlement on known success and on provider failure; verify no in-flight
double-counting, Sentinel preservation, and fail-closed UNKNOWN usage;
and assert the inspect CLI makes zero state writes or model calls.

Remaining integration evidence required before release: a native macOS/APFS
smoke running `npm test` and `npm run doctor` against an isolated test
runtime. Do not point fault-injection tests at `~/.reviewloop`.

## Engineering Task Spec / non-goals

Acceptance requires zero unauthorized provider retries, no successful
`SETTLED_KNOWN` without a matching spend record in the new path, no
invented settlement, exact durable usage/cost and a complete CI + independent
audit. **Out of scope:** provider-billing API integrations, external request
idempotency, automatic retry after an ambiguous timeout, rewriting any
historical user reservation, or broad caching/Prompt optimization.
