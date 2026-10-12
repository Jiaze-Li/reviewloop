# ReviewLoop roadmap

**Current scope (2026-10-11): LOCAL-only.** GitHub PR review is delegated to
[claude-review-bot](https://github.com/Jiaze-Li/claude-review-bot).
The dated sections below are historical implementation and certification notes,
not current PR functionality. Deleted code is preserved in Git history.

## Shipped (this migration)

- Worker-owned execution architecture; Front Agent / Planner / Executor pool /
  Sonnet-only chain / Fast-Full / taskCohesion removed.
- Active model roles reduced to `reviewer` + `supervisor`.
- ReviewLoop local review loop: baseline capture → Gate → Reviewer →
  convergence policy → Supervisor (exception-only) → PASS / REWORK /
  HUMAN_REQUIRED.
- PR review controller: one `@codex/@claude review` per HEAD, zero-model local
  wait, durable `WAITING_FOR_REVIEW`, exact-HEAD binding, duplicate-trigger
  prevention. **Superseded by D28** — the external-review trigger engine
  (`prReviewController`, `ExternalModelTriggerAuthority`, `prTrust`,
  `threadResolution`, `trustedPrReview`, `prCloseoutPolicy`) was later removed
  entirely. PR is now a review TARGET of the ONE unified engine (same
  deterministic Gate → internal Reviewer routing → convergence → Supervisor as
  LOCAL), never a trigger for `@codex review` / `@claude review`.
- Token Safety migrated to `REVIEWLOOP_*` limits, scoped to Reviewer +
  Supervisor; `UNKNOWN != ZERO` and reservation-settlement invariants retained.
- MCP surface reduced to `reviewloop_begin` + `reviewloop_review`.
- CLI / MCP / package renamed to `reviewloop`.
- Global installer migrates a legacy SuperGPT install transactionally
  (managed block, MCP registration, AGY skill) with rollback; partial-agent
  installs supported.
- Deterministic/mock test suite for the new architecture.

## Independent-review blocker pass (this change)

- Malformed Reviewer/Supervisor output fails closed (never CLEAN, never valid
  REWORK guidance).
- Aggregate Token Safety is durable across rounds and restarts.
- Production PR backend wired via the `gh` CLI (read + one trigger comment). **Superseded by D28** — the backend is now a read-only target adapter with no trigger comment.
- Strict PR trust boundary (reviewer identity + explicit reviewed HEAD ==
  current HEAD), reusing the V2 trusted-review primitives. **Superseded by D28** — removed with the external-review engine; exact-HEAD binding is now enforced by the PR snapshot worktree.
- No silent diff truncation — bounded or deterministically chunked review.
- Reviewer/Supervisor pool routed through RoleRouter; the CallIntent binds the
  actually-selected family; bounded failover re-authorizes.
- Full baseline attribution via `git stash create`; unattributable state and
  "no Worker change yet" both fail safely.
- Baseline Gate evidence captured at `begin` (0 model tokens).
- PR reviewer default = `codex`; `internal` can never be a PR trigger identity. **Superseded by D28** — there is no PR reviewer identity; the internal Reviewer reviews every target.

## V2 pre-freeze token-safety pass (this change)

Deterministic/mock `npm test` + `npm run doctor` + `npm run
benchmark:transports` green. No real-provider calls.

- **Split-pool Reviewer primary (D27).** New `agy:opus` (AGY-hosted Claude
  Opus) is the Reviewer first choice, in the `agy-claude-gpt` quota pool —
  a different pool from the Supervisor first choice (`agy:gemini-supervisor`,
  `agy-gemini`), so a quota cooldown on one role's primary never disables the
  other's. `agy:opus` is Reviewer-role-only (Supervisor pool untouched),
  resolves its concrete Opus dynamically from the AGY runtime catalog
  (`catalogPrefix: 'claude-opus-'`, no pin), shares `agy-claude-gpt` with
  `agy:sonnet` + `agy:gpt-oss` (one cooldown skips all three), and reuses the
  existing `reviewloop-minimal` isolation / token accounting /
  ModelSpendAuthority / sentinel / bounded failover. Reviewer routing:
  `agy:opus → agy:gemini-reviewer → codex:default → agy:sonnet → agy:gpt-oss →
  claude:opus`. The live-cert main Reviewer path
  (`scripts/live-reviewloop-certify.mjs --mode reviewer`) now targets
  `agy:opus`; its resolvedModel must be a `claude-opus-*` id.

- `agy:gpt-oss` removed from the **Supervisor** production pool: its live
  Supervisor certification passed transport / accounting / isolation but its
  decision output violated the Supervisor decision schema
  (`recommendation = "REWORK|HUMAN_REQUIRED"`). The parser was **not** loosened.
  Final Supervisor pool: `agy:gemini-supervisor → codex:default → agy:sonnet →
  claude:opus`. It stays a Reviewer candidate; family/transport/accounting
  support is unchanged. Supervisor provider-attempt ceiling 5 → 4.
- **Role-specific Gemini effort (D24).** Gemini split into two role-scoped
  stable family identities with a FIXED per-role effort: `agy:gemini-reviewer`
  (`-low`) is now the Reviewer head, `agy:gemini-supervisor` (`-medium`) the
  Supervisor head. Both share the one `agy-gemini` quota pool. Reviewer routing:
  `agy:gemini-reviewer → codex:default → agy:sonnet → agy:gpt-oss →
  claude:opus`. The live-result table below predates the split; its
  `agy:gemini` Supervisor row is the same model/transport now labelled
  `agy:gemini-supervisor`.
- **Single-call Token Sentinel** (post-settlement circuit breaker): a physical
  Reviewer/Supervisor call whose usage settled reliably but whose
  `usageVolume > REVIEWLOOP_MAX_SINGLE_CALL_USAGE` (default 40 000) or whose
  known `contextOverheadTokens > REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS`
  (default 30 000) is fully accounted, raises a BLOCKING
  `MODEL_SPEND_TOKEN_ANOMALY` event, and durably latches the loop —
  `MODEL_SPEND_TOKEN_ANOMALY_BLOCKED` refuses all further model spend at the
  authorization stage, across a restart. No auto-failover, no provider
  health/quota mutation. Env overrides clamped to `(0, hard-cap]`; an illegal
  value can never disable the protection.

## V2 pre-freeze final pass (this change)

Deterministic/mock `npm test` + `npm run doctor` + `npm run
benchmark:transports` green. No real-provider calls.

- **Token Sentinel restart re-inference** (`reinferAnomalyFromSpendLog`) no
  longer treats a durable spend-log **read failure** as "no anomaly": it fails
  closed with `MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE` exactly like an
  unreadable latch — no permit, no dispatch, no failover, no health/quota
  mutation. `UNKNOWN != ZERO`; "cannot establish clean" is not "clean".
- Anomalous-call spend record + anomaly latch already write in one atomic
  workflow-state transition (prior pass); this pass closes the last read-path
  fail-open.
- AGY isolation / routing comments + `docs/ARCHITECTURE.md` + `docs/DECISIONS.md`
  D22 corrected to the real implementation: `reviewloop-minimal` at
  `<isolated gemini dir>/config/agents/reviewloop-minimal/agent.md` via
  `--gemini_dir` (not a workspace `.agents/` path), startup + per-call
  effective-loading verification, fail-closed, never a default-agent fallback.
  Stale ~6.7k / ~40k AGY numbers and the "`agy:gemini` excluded from routing
  due to high-context" framing removed; no production family is `highContext`.
- Definitive per-candidate live certification recorded (see Real-provider
  status): all 4 Reviewer + 3 Supervisor candidates PASS; `agy:gpt-oss` as
  Supervisor FAILs the decision schema only and is out of that pool.

## Release-hardening pass (this change)

Phased on top of the blocker passes; deterministic/mock `npm test` + `npm run
doctor` green. NOT real-provider E2E.

- Default reviewer allowlists are the exact REST bot logins
  (`chatgpt-codex-connector[bot]` / `claude[bot]`); bare slugs untrusted.
- PR review ingestion aggregates every trusted submission + inline comment per
  HEAD; `COMMENTED` / unstructured / inline / `DISMISSED` can no longer read as
  CLEAN; a later `APPROVED` cannot hide an earlier blocking finding.
- Active evidence path: `lstat` before reading any untracked path (symlink /
  special file fails closed); every baseline/diff/HEAD/ls-files git command
  fails closed on a non-zero exit.
- Verification plan frozen at `reviewloop_begin`; a post-`begin` edit to
  `.reviewloop.json` / the `package.json` test script blocks the review.
- One composite `(diff + gate)` evidenceId authorizes one physical dispatch
  sequence; bounded failover reuses the one claim; crash/resume re-call →
  exactly one dispatch.
- Per-`loopId` in-process + cross-process lease around `reviewloop_review`.
- Every settled physical attempt (success / known-usage failure /
  mechanically-zero pre-send failure) writes a `reservationId`-tagged durable
  accounting record; unified `AGY_ENOENT` / `AGY_SPAWN_FAILED` pre-send
  classification; a normal failover no longer produces a false unaccounted
  block.
- `callAgy` envelope parsing fixed (parse `res.text`, not the transport
  `res.json`); real `{json,text,usage}`-shape tests.
- Unknown provider dollar cost → `costKnown: false` (never a real `$0`); cost
  ceiling semantics adjusted.
- Deterministic Gate FAIL → `gateRepairCount`, not a fresh Reviewer round.
- All public `REVIEWLOOP_MAX_*` env knobs wired (`MAX_REVIEW_ROUNDS` →
  objective; `MAX_EXTERNAL_REVIEW_TRIGGERS` → trigger authority).
- Deterministic Gate command timeout + process-tree teardown.
- Durable per-chunk review checkpoint / crash-resume.
- `safetyEvents` isolated per invocation; early-return telemetry reports
  durable cumulative spend.

## Independent re-verification pass (this change)

Deterministic/mock `npm test` + `npm run doctor` green. Closes the
4 P1 + 3 P2 raised by the independent re-verification of the release-hardening
pass:

- Bounded failover may reuse the one New Information claim ONLY when every
  earlier physical attempt is mechanically proven pre-send zero. An attempt
  that reached the provider (known non-zero usage / open DISPATCHING) →
  "no new information" → no further physical call.
- The cross-process BUSY path is strictly read-only: it no longer runs
  resume reconciliation or touches any RESERVED / DISPATCHING reservation
  belonging to the live owner.
- Lease expiry is owner-aware: a same-host lock whose owner pid is still
  alive is never stolen on the fixed TTL alone; a held lease renews its own
  expiry on a heartbeat; only a provably-gone owner (dead same-host pid, or
  an expired remote lock) is reclaimed.
- A GitHub `CHANGES_REQUESTED` review verdict is unconditionally blocking —
  an empty / P3-only structured findings block can no longer downgrade it to
  CLEAN.
- A review round is bound to the logical (diff + gate) review state; a
  crash/resume of the same chunked review never consumes another round, and
  a resumed incomplete chunk continues the one authorized dispatch sequence
  instead of earning a fresh one.
- Every provider/spend failure that returns `HUMAN_REQUIRED` now also latches
  the durable loop state to `HUMAN_REQUIRED` (returned status == persisted
  state).

## Independent re-verification pass 2 (this change)

Deterministic/mock `npm test` + `npm run doctor` green. Closes the final
Token-Safety P1 from the independent re-verification:

- Failover reuse no longer infers "never reached the provider" from a zero
  token count. `SETTLED_KNOWN` + zero usage proves nothing about pre-send — a
  post-send `PROVIDER_PROTOCOL_ERROR` / `PROVIDER_RATE_LIMITED` can report
  usage `{0,0}` and still have spent. Reuse of the one New Information claim is
  now permitted ONLY when every earlier physical attempt carries a durable,
  unambiguous pre-send provenance: `RESERVED` / `CANCELLED_PRE_DISPATCH` (never
  crossed the durable `DISPATCHING` boundary), or `SETTLED_KNOWN` with
  `settlementReason === PROVEN_PRE_SEND_ZERO` — a reason written solely from an
  explicit orchestrator-set flag on a mechanically-classified spawn/transport
  abort (`AGY_ENOENT` / `AGY_SPAWN_FAILED` / …), never from a provider's own
  `{0,0}`. Missing / ambiguous provenance, an ordinary provider failure, or a
  success all deny the reuse. Durable across a restart.

## CLI transport implementation + safety rework

- Production `codex` + `claude` Reviewer/Supervisor transports are implemented
  as narrow, stateless, single-turn calls from an isolated scratch cwd with no
  repo/history preload, bounded wall-clock timeout, and whole-process-group
  teardown.
- Runtime eligibility is checked without model spend: `--version` plus local
  auth status (`codex login status`, `claude auth status`). Missing or locally
  unauthenticated CLIs are marked UNAVAILABLE before ReviewLoop authorizes a
  model dispatch, so routing can choose the next family safely.
- An authentication-looking failure after a prompt-bearing invocation has
  started is classified separately as `PROVIDER_AUTH_REJECTED`. It is NOT
  treated as mechanically-zero pre-send provenance; absent reliable provider
  usage, Token Safety fails closed and does not fail over on the same evidence.
- Stable family semantics are preserved without concrete release pins:
  `codex:default` delegates to the provider default; `claude:opus` passes the
  stable `opus` alias; `agy:*` families resolve from the runtime model catalog.
  Telemetry still records the concrete model returned by the provider.
- `npm run benchmark:transports` is a zero-provider harness with two layers:
  transport narrowness/overhead plus real ReviewLoop-controller state-machine
  paths E2E-A (one-round PASS), E2E-B (REWORK → changed implementation → PASS),
  and E2E-C (same blocker after a changed implementation → Supervisor exactly
  once → REWORK).

## LOCAL controller-level real-provider certification (this closeout)

Certified implementation snapshot:
`ce02f1e83276d7349ac6dfec332f75c7b972fd32` (`v2-routing`, PR #4) — the frozen
implementation head this certification was run against. Later closeout commits
on `v2-routing` change documentation only and do not alter the certified
implementation. Deterministic bar at `ce02f1e`: `npm test` **573/573**,
`npm run doctor` PASS, `npm run benchmark:transports` PASS (0 real spawns),
`git diff --check` clean.

A full `reviewloop_begin` → deterministic Gate → independent Reviewer → verdict
loop was run over the `ce02f1e` implementation snapshot, in a throwaway isolated
worktree, against the byte-exact frozen certification delta `bb0c36e → ce02f1e`:

- Selected Reviewer family **`agy:opus`** (first choice), live-resolved model
  **`claude-opus-4-6-thinking`** (`resolvedFrom: runtime_catalog`), quota pool
  **`agy-claude-gpt`**.
- Supervisor first choice **`agy:gemini-supervisor`** / Gemini medium — **not
  invoked** (loop converged in round 1).
- Physical Reviewer calls **1**; Supervisor calls **0**.
- Usage: input **6358**, output **2602**, thinking 0 (AGY transport does not
  itemise thinking), cache-read 0, cache-creation 0, `usageVolume` **8960** —
  no token anomaly, sentinel thresholds untouched, spend not blocked.
- AGY `reviewloop-minimal` isolation / effective-loading verification: **PASS**
  (startup capability probe `supported: true` + per-call log check, no
  `AGY_ISOLATION_UNVERIFIED`).
- Findings: **no blocking P1/P2**. Three non-blocking `OTHER` / cosmetic
  findings reported and deliberately **left unchanged** after the freeze.
- Controller final verdict: **PASS** (round 1, "no P1/P2 findings").

Scope of this certification: **LOCAL mode only**, first-choice Reviewer only.
It does **not** cover the PR target or the multi-provider failover chain (see
below).

## PR-target real-provider certification (PR #5)

Implementation freeze: `787a4070336d9839590d437ce95ec8a898519d11`.
Certification PR: #5 (branches `cert/pr-target-base` → `cert/pr-target-e2e`),
reviewed head `755c1e53cdcf113e2c85aa901e4e43ed21836d1d`.

Exercises the real ReviewLoop PR-target production path end to end:
repository identity proof, exact base/head SHA binding, Gate on the exact
reviewed HEAD inside an isolated worktree, one real Reviewer call.

- Physical Reviewer: `codex:default`. Reviewer calls **1**, Supervisor calls
  **0**.
- Controller verdict: **PASS**, round 1, "no P1/P2 findings".
- `usageVolume` **16759**, `contextOverheadTokens` **16460** — below both
  Token Sentinel thresholds (40000 single-call / 30000 context-overhead); not
  tripped.
- This closes the "PR external-review mode NOT CERTIFIED" gap recorded
  earlier in this document for the PR-target path specifically. The real
  multi-provider failover chain (see below) is still not run.

## Final routing-hardening implementation (`928f79f`)

`a1cfe2c` (durable route audit, primary-first invariant, stale-health
revalidation) → `928f79f` (reason-scoped stale-health revalidation, transport
gate, per-call audit attribution). See D30 in `docs/DECISIONS.md` for the
invariant set.

- Deterministic local suite / `npm run doctor` / `npm run benchmark:transports`:
  **PASS**.
- Independent manual GitHub code review: **PASS**.
- No extra real-provider certification was performed against this head. One
  real-provider certification attempt over the routing-hardening change
  tripped the post-settlement Token Sentinel: `codex:default` Reviewer call,
  `usageVolume` **79256**, `contextOverheadTokens` **69297** (both over
  threshold, `SINGLE_CALL_USAGE` trigger) — the loop latched to
  `HUMAN_REQUIRED`. This is a **safety trip, not a code finding**: the call
  was fully accounted, no auto-failover occurred, and the Sentinel thresholds
  were **not** raised or bypassed.

## Real-provider status (needs real providers / real GitHub)

Corrected against this machine's durable reservation + spend ledgers under
`~/.reviewloop/` (not from recollection):

- Deterministic/mock certification at the certified implementation snapshot
  `ce02f1e` = **PASS** — `npm test` 573/573, `npm run doctor` PASS,
  `npm run benchmark:transports` PASS (0 real spawns), `git diff --check` clean.
  Later `v2-routing` closeout commits are documentation-only.
- `npm run install-global` = **executed** against this machine's agent
  config / dotfiles (managed block + `reviewloop` MCP registration).
- Real ReviewLoop provider calls with a durable record on this machine =
  **2**, both in one loop (`rl-20260906075721-c674d31f`): `reviewer`,
  family `agy:gpt-oss`, model `gpt-oss-120b-medium`, a deterministically
  chunked review — `SETTLED_KNOWN` / `PROVIDER_CALL_SUCCEEDED`, ~122.8k and
  ~26.1k tokens; **dollar cost UNKNOWN** (provider reported none). Three
  older loops hold `reviewer` / `agy:gpt-oss` reservations with
  fixture-shaped usage (`{1,1}`, `{5,2,3}`) that cannot be mechanically
  distinguished from a stubbed Reviewer — **NOT COUNTED** as certified real
  calls.
- Any earlier `claude:sonnet` / Executor-era real call = **UNKNOWN** — no
  durable record survives in the current runtime dir; not asserted.
- **Per-candidate Reviewer/Supervisor certification (definitive)** — one
  controlled single-call live cert per candidate, transport + accounting +
  decision-schema + (AGY) isolation:

  | Role | Family | Result | resolvedModel | usageVolume | isolation |
  | --- | --- | --- | --- | --- | --- |
  | Reviewer | `agy:opus` (first choice) | PASS | `claude-opus-4-6-thinking` | 8960 | effectiveLoadingVerified + isolationVerified |
  | Reviewer | `codex:default` | PASS | — | 16535 | — |
  | Reviewer | `agy:sonnet` | PASS | `claude-sonnet-4-6` | 3191 | isolationVerified |
  | Reviewer | `agy:gpt-oss` | PASS | `gpt-oss-120b-medium` | 2427 | isolationVerified |
  | Reviewer | `claude:opus` | PASS | `opus` | 3449 | — |
  | Supervisor | `agy:gemini` | PASS | `gemini-3.8-flash-medium` | 2933 | effectiveLoadingVerified + isolationVerified |
  | Supervisor | `codex:default` | PASS | — | 16899 | — |
  | Supervisor | `agy:sonnet` | PASS | `claude-sonnet-4-6` | 3303 | isolationVerified |
  | Supervisor | `claude:opus` | PASS | `opus` | 3741 | — |
  | Supervisor | `agy:gpt-oss` | **FAIL (schema only)** | `gpt-oss-120b-medium` | 2427 | isolationVerified |

  `agy:gpt-oss` as Supervisor returned `recommendation = "REWORK|HUMAN_REQUIRED"`
  (a disjunction the schema forbids); transport / accounting / isolation all
  passed. The parser was **not** loosened — `agy:gpt-oss` is out of the
  Supervisor pool and stays a Reviewer candidate.
- `codex:default` and `claude:opus` Reviewer/Supervisor transports are now
  **live-certified** (the earlier `claude -p` `PROVIDER_PROTOCOL_ERROR` from
  `--mcp-config '{}'` was fixed with `'{"mcpServers":{}}'` plus
  `--setting-sources '' / --tools '' / --disable-slash-commands /
  --no-session-persistence`).
- Historical AGY figures are **not** a baseline: the earlier ~40k `gemini-*`
  Supervisor call ran the default agent (isolation not in effect); the ~6.7k
  "minimal" smoke predated effective-loading verification. The definitive
  isolated-agent result is `agy:gemini` Supervisor `usageVolume 2933,
  effectiveLoadingVerified`.
- ReviewLoop real-provider **controller-level** Reviewer E2E in **LOCAL** mode
  (a full loop carried to a certified controller `PASS`) = **CERTIFIED** —
  `agy:opus` / `claude-opus-4-6-thinking`, against the certified implementation
  snapshot `ce02f1e` and the frozen delta `bb0c36e → ce02f1e` (see the LOCAL
  controller-level certification section above).
- ReviewLoop real-provider **controller-level** PR-target E2E = **CERTIFIED**
  (PR #5, see "PR-target real-provider certification" above) — `codex:default`,
  round 1 `PASS`, against implementation freeze `787a407` / reviewed head
  `755c1e5`.
- Real multi-provider failover chain end-to-end = **NOT RUN** (structurally
  wired; per-candidate certs above are single-candidate).
- A controlled `Worker + ReviewLoop` vs `Worker alone` wrapper benchmark
  remains future work because ReviewLoop cannot observe Worker token usage
  through MCP.

## Later

- A real-provider LOCAL REWORK→PASS controller loop and a multi-provider
  failover chain (the per-candidate transports
  are each live-certified; the full chain is not).
- Optional read-only ReviewLoop dashboard (removed in this migration; re-add
  only if it can stay zero-token and simple).
