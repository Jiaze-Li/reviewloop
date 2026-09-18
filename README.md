# ReviewLoop (gpt-dev-loop)

ReviewLoop adds an autonomous review/fix loop around the coding agent you are
already using. It does not replace or spawn that coding agent.

> ReviewLoop is a post-execution review and repair controller for coding
> agents. The user's current coding agent (the **Worker**) owns execution;
> ReviewLoop owns independent verification, review, non-convergence detection,
> and exception guidance. It has ONE review engine — the same deterministic
> Gate, internal Reviewer routing, Supervisor and 3-round convergence policy
> judge a LOCAL target (baseline → Worker delta) and a PR target (PR base →
> exact PR HEAD).

## Model

```
USER
  ↓
WORKER  (Claude Code / Codex / Gemini / any coding agent)
  ↓  implements, tests, lints, builds directly in its current session
ReviewLoop
  ├─ deterministic Gate      (0 model tokens)
  ├─ Reviewer                (independent; metered by Token Safety)
  └─ Supervisor              (exception-only, on non-convergence)
```

ReviewLoop does **not**: write application code, commit, push, merge,
force-push, choose the Worker's model, spawn or restart the Worker, or budget
the Worker.

## Worker usage

The Worker calls two MCP tools:

| tool | when | cost |
|---|---|---|
| `reviewloop_begin({ goal, cwd, prNumber?, constraints?, contractText?, phases?, evidenceRequirements?, verificationCommands?, blockingSeverities?, maxReviewRounds? })` | before the first edit | 0 model calls |
| `reviewloop_review({ loopId, evidence? })` | when the current gate is ready | Gate (0) + Reviewer if justified |

`reviewloop_review` returns one of: `PHASE_PASS` (non-terminal; continue the
next frozen phase in the same loop), `PASS` (final whole-task certification),
`REWORK` (fix the findings in the same session, call again), `HUMAN_REQUIRED`,
`WAITING_FOR_REVIEW` (transient — call again once state settles),
`NO_PROGRESS`, `PUSH_REQUIRED`.

Full Worker contract: [`agent-policy/COMMON.md`](agent-policy/COMMON.md).


## Phase-aware large tasks

Large task contracts may supply an ordered frozen phase plan at
`reviewloop_begin`. ReviewLoop keeps **one loopId, one original baseline and
one immutable task objective** for the entire task:

```
Phase 1 work
  -> deterministic Gate (0 model tokens)
  -> Reviewer
  -> PHASE_PASS
Phase 2 work
  -> same engine
  -> PHASE_PASS
Final whole-task gate
  -> same engine
  -> PASS
```

Each gate has its own convergence counter and Supervisor escalation opportunity.
A clearly phased contract cannot silently fall back to a single gate: ReviewLoop
rejects begin-time handoffs that declare multiple phases but omit the structured
`phases` plan. When a full user-facing contract exists, `contractText` freezes
that self-contained contract for the independent Reviewer instead of relying on
chat history.

Non-command runtime/artifact/manual proof can be frozen in
`evidenceRequirements`. Required evidence is a deterministic precondition for
the relevant gate: missing evidence returns REWORK with zero Reviewer spend, and
submitted evidence is bound to the exact code fingerprint and review scope before
the Reviewer judges whether the proof is actually sufficient.

After `PHASE_PASS`, ReviewLoop returns a durable `resumePacket` containing the
next phase, inherited invariants, repository identity and evidence summary. A
Worker may use that packet as a safe context-compaction/refresh boundary while
continuing the same `loopId`; ReviewLoop still does not spawn or replace the
Worker.
A `PHASE_PASS` resets only gate-local convergence state; it does **not** reset
task-wide Reviewer/Supervisor spend, the Token Sentinel, provider accounting,
the original baseline, or the immutable objective. The final `PASS` is the only
successful terminal state.

Top-level `verificationCommands` are the **global/whole-task** mechanical
checks: they are frozen at `reviewloop_begin` and remain part of every phase
gate and the final gate. A phase's own `phases[].verificationCommands` are
**phase-local only** and are not replayed at the final gate, because later
phases may intentionally replace intermediate implementations. Any mechanical
requirement that must still hold at final completion belongs in the top-level
global verification plan; semantic requirements that later phases must preserve
belong in `carryForwardInvariants`.

For one-command machine setup after pulling the repository:

```
npm run setup
```

This installs/refreshes the global MCP + Worker policy and then runs the
zero-model `doctor` checks.

## PR target

Pass `prNumber` to review an open PR. `reviewloop_begin` freezes the exact PR
snapshot — repository, `prNumber`, base SHA, HEAD SHA — and every review round
runs the **same** engine as a LOCAL target over the PR's `base → HEAD` diff:
deterministic Gate → internal Reviewer routing (`agy:opus` first) → convergence
policy → Supervisor only on non-convergence. Before a PR `PASS`, ReviewLoop
re-reads the live PR HEAD and refuses to certify a stale review if it moved.
Each round writes a durable, tamper-evident audit record. ReviewLoop never
pushes, merges, force-pushes, or posts a third-party review trigger.

## CLI

```
reviewloop doctor        zero-token prerequisite + repo-invariant check
reviewloop status        list local ReviewLoop sessions
npm run install-global   install/refresh the global policy + MCP for present agents
npm run doctor
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current source of truth
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architectural decisions
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/GLOBAL_INSTALL.md`](docs/GLOBAL_INSTALL.md)
- [`docs/history/SUPERGPT_V1_V2_LESSONS.md`](docs/history/SUPERGPT_V1_V2_LESSONS.md) — why ReviewLoop replaced SuperGPT V1/V2

## Certification status

Three distinct certification events on `v2-routing`. They are **not**
interchangeable — each covers a different implementation snapshot and a
different part of the engine; read them separately, not as one running total.

### 1. Historical LOCAL real-provider certification — `ce02f1e`

Certified implementation snapshot: **`ce02f1e83276d7349ac6dfec332f75c7b972fd32`**
— the frozen implementation head this certification was run against.

- Deterministic bar at `ce02f1e`: **PASS** — `npm test` **573/573**,
  `npm run doctor` PASS, `npm run benchmark:transports` PASS (0 real spawns),
  `git diff --check` clean.
- A full `reviewloop_begin` → Gate → Reviewer → verdict loop was carried to a
  controller **PASS** over the `ce02f1e` snapshot against the byte-exact
  frozen delta `bb0c36e → ce02f1e`: Reviewer **`agy:opus`** (first choice),
  live-resolved model `claude-opus-4-6-thinking`, quota pool
  `agy-claude-gpt`; Supervisor first choice `agy:gemini-supervisor` not
  invoked (converged round 1); 1 physical Reviewer call, 0 Supervisor calls;
  `usageVolume` **8960**; AGY isolation / effective-loading verification
  **PASS**; no blocking P1/P2 findings.
- Scope: **LOCAL mode only**, first-choice Reviewer only. Does not cover PR
  mode or multi-provider failover.

### 2. PR-target real-provider certification — PR #5

Implementation freeze: **`787a4070336d9839590d437ce95ec8a898519d11`**.
Certification PR: **#5**, reviewed head
**`755c1e53cdcf113e2c85aa901e4e43ed21836d1d`**.

- Physical Reviewer: **`codex:default`**. 1 Reviewer call, 0 Supervisor calls.
- Controller verdict: **PASS**, round 1, "no P1/P2 findings".
- `usageVolume` **16759**, `contextOverheadTokens` **16460** — Token Sentinel
  **not tripped** (threshold 40000 single-call / 30000 context-overhead).
- Exercises the real PR-target production path end to end: repository
  identity, exact base/head SHA binding, Gate on the exact reviewed HEAD, one
  real Reviewer call.

### 3. Final routing-hardening implementation — `928f79f`

Implementation head: **`928f79fdbc342ad1ca0f22f2357c4ed78dc88a6e`**.

- Deterministic local suite / `npm run doctor` / `npm run benchmark:transports`:
  **PASS**.
- Independent manual GitHub code review: **PASS**.
- **No extra real-provider certification was performed against this head.**
  One real-provider certification attempt over the routing-hardening change
  hit the post-settlement Token Sentinel (a `codex:default` Reviewer call,
  `usageVolume` 79256 / `contextOverheadTokens` 69297, both over threshold) —
  this is a **safety trip, not a code finding**: the anomalous call was fully
  accounted, the loop latched to `HUMAN_REQUIRED`, and no further automatic
  provider spend occurred. The Sentinel thresholds were **not** raised or
  bypassed to get past it.

`claude:opus` uses the stable provider alias `opus`; `codex:default` follows
the provider default. No concrete release is pinned by default.

Historical SuperGPT V1/V2 measured numbers are labelled historical in
`docs/history/` and are not ReviewLoop certification.
