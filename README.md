# ReviewLoop (gpt-dev-loop)

ReviewLoop adds an autonomous review/fix loop around the coding agent you are
already using. It does not replace or spawn that coding agent.

> ReviewLoop is a post-execution review and repair controller for coding
> agents. The user's current coding agent (the **Worker**) owns execution;
> ReviewLoop owns independent verification, review, non-convergence detection,
> and exception guidance. It has ONE review engine — the same deterministic
> Gate, internal Reviewer routing, Supervisor and epoch-based convergence policy
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
`phases` plan. The prose guard intentionally recognizes explicit phase/execution-plan
language; it is not a general natural-language classifier for arbitrary "stage",
"step", or rollout synonyms. Callers with a structured multi-stage task should pass
`phases[]` explicitly rather than relying on prose inference. When a full user-facing
contract exists, `contractText` freezes that self-contained contract for the
independent Reviewer instead of relying on chat history.

Non-command runtime/artifact/manual proof can be frozen in
`evidenceRequirements`. Required evidence is a deterministic precondition for
the relevant gate: missing evidence returns REWORK with zero Reviewer spend, and
submitted evidence is bound to the exact code fingerprint and review scope before
the Reviewer judges whether the proof is actually sufficient.

`contractText` is limited to 64 KiB of UTF-8 input and is rejected, never
silently truncated. Keep the contract self-contained with every acceptance
criterion intact. PR evidence input is validated before worktree/Gate execution;
invalid input returns `REWORK` with `gate.verdict: NOT_RUN` and no model spend.
A Gate FAIL (including repeated-failure `NO_PROGRESS`) returns an explicit
`evidenceSubmission.status: NOT_ACCEPTED` receipt with reason `GATE_FAILED`:
proof was not saved and must be re-submitted after repairing the Gate.
When LOCAL Gate stabilization changes the tree, current-scope proof is invalidated
and pre-Gate submissions return `REWORK`/`CODE_CHANGED`; re-collect proof on the
stabilized code. Only the latest record per frozen requirement is retained
(including on reload), with its original code/scope binding. Completed phase
proof hashes, audits and task-wide budgets are not pruned or reset.

A LOCAL phase gate reviews only what changed since the previous `PHASE_PASS`
(`nextDiffScope: "phase-delta"`), so Reviewer cost stays flat as a long task
grows. The first phase, the final whole-task gate, PR mode, and any boundary
that cannot be trusted (untracked files, incomplete attribution, an empty phase
delta) review the cumulative diff from `reviewloop_begin` instead. Stage or
commit new files before ending a phase to keep the phase-delta path.

If the cumulative diff is too large for one final review, the final gate
reviews every file changed in more than one phase plus everything changed since
the last `PHASE_PASS`; each remaining file was changed in exactly one phase and
fully reviewed at that gate (`diffScope: final-cross-phase`). Any doubt keeps the
old behaviour. `reviewloop_begin` also returns advisory `planWarnings`: phases
that only a model can judge, phases registered without `contractText` (the Reviewer would never see the acceptance criteria), and (LOCAL) untracked files at begin that would make
the first review stop at `HUMAN_REQUIRED` - fix those and re-begin before editing.

If a Worker session dies or its context is lost, run `reviewloop resume` in the
project directory and paste the printed prompt into a fresh `claude` / `agy`
session: it names the loop, the current phase, its exit criteria and
verification commands, any blocking findings and the frozen contract, and tells
the new Worker to continue the SAME loop. ReviewLoop still never starts a Worker.

A gate whose deterministic Gate fails more than `REVIEWLOOP_MAX_GATE_REPAIRS`
times (default 15) also stops for a human, so a flaky test or a wrong
verification command cannot loop forever.

A gate that exhausts its automatic convergence budget stops the Worker
(`HUMAN_REQUIRED`, `budgetExhausted`). A human can run
`reviewloop reopen-gate --loop <id> --reason "..."` to give that one gate a fresh
budget (max 3 times per loop) without losing completed phases or model-spend
accounting; the Token Sentinel stop cannot be reopened this way.

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
reviewloop reopen-gate    human override: fresh convergence budget for ONE stuck gate (--loop, --reason)
reviewloop resume         print a prompt that lets a FRESH Worker session continue the unfinished loop of this project directory (--loop to pick one)
npm run install-global   install/refresh the global policy + MCP for present agents
npm run doctor
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current source of truth
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architectural decisions
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/GLOBAL_INSTALL.md`](docs/GLOBAL_INSTALL.md)
- [`docs/CERTIFICATION.md`](docs/CERTIFICATION.md) — real-provider certification records
- [`docs/history/SUPERGPT_V1_V2_LESSONS.md`](docs/history/SUPERGPT_V1_V2_LESSONS.md) — why ReviewLoop replaced SuperGPT V1/V2

## Certification status

Real-provider certification records (which snapshot was certified, with which
Reviewer, and what they do and do not cover) live in
[`docs/CERTIFICATION.md`](docs/CERTIFICATION.md). They describe specific
historical snapshots, not the current head.
