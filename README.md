# ReviewLoop

ReviewLoop verifies **LOCAL coding-agent work**. The Worker writes code;
ReviewLoop freezes the task contract and pre-edit baseline, runs the
mechanical Gate, and controls independent Reviewer/Supervisor and bounded repair.

**GitHub PR review is owned by [claude-review-bot](https://github.com/Jiaze-Li/claude-review-bot).**
ReviewLoop's PR mode is retired under [decision D37](docs/DECISIONS.md). Saved
PR sessions remain on disk but cannot be resumed as LOCAL; start a new PR review
through the bot.
GitHub CI remains responsible for tests on pushed code.

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
| `reviewloop_begin({ goal, cwd, constraints?, contractText?, phases?, evidenceRequirements?, verificationCommands?, blockingSeverities?, maxReviewRounds? })` | before the first edit | 0 model calls |
| `reviewloop_review({ loopId, evidence? })` | when the current gate is ready | Gate (0) + Reviewer if justified |

`reviewloop_review` returns one of: `PHASE_PASS` (non-terminal; continue the
next frozen phase in the same loop), `PASS` (final whole-task certification),
`REWORK` (fix the findings in the same session, call again), `HUMAN_REQUIRED`,
`WAITING_FOR_REVIEW` (transient — call again once state settles),
`NO_PROGRESS`.

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
criterion intact. Invalid submitted evidence is rejected with `gate.verdict:
NOT_RUN` and no model spend.
A Gate FAIL (including repeated-failure `NO_PROGRESS`) returns an explicit
`evidenceSubmission.status: NOT_ACCEPTED` receipt with reason `GATE_FAILED`:
proof was not saved and must be re-submitted after repairing the Gate.
When LOCAL Gate stabilization changes the tree, current-scope proof is invalidated
and pre-Gate submissions return `REWORK`/`CODE_CHANGED`; re-collect proof on the
stabilized code. Only the latest record per frozen requirement is retained
(including on reload), with its original code/scope binding. Completed phase
proof hashes and task-wide budgets are not pruned or reset.

A LOCAL phase gate reviews only what changed since the previous `PHASE_PASS`
(`nextDiffScope: "phase-delta"`), so Reviewer cost stays flat as a long task
grows. The first phase, the final whole-task gate, and any boundary
that cannot be trusted (untracked files, incomplete attribution, an empty phase
delta) review the cumulative diff from `reviewloop_begin` instead. Stage or
commit new files before ending a phase to keep the phase-delta path.

If the cumulative diff is too large for one final review, the final gate
reviews every file changed in more than one phase plus everything changed since
the last `PHASE_PASS`; each remaining file was changed in exactly one phase and
fully reviewed at that gate (`diffScope: final-cross-phase`); some recent-phase
files are kept in view so the Reviewer never gets an empty diff, and interactions
between omitted files are covered by the Gate, not jointly reviewed. Any doubt keeps the
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

## GitHub PR handoff

The Worker pushes code and creates the PR using ordinary GitHub operations.
The independent [claude-review-bot](https://github.com/Jiaze-Li/claude-review-bot)
then owns PR discovery, finding validation, post-push verification, final audit
and GitHub review state. ReviewLoop has no GH PR transport or merge operation.

The Worker follows the PR through the bot's result:

1. A non-draft PR opening, **Ready for review**, or a repair push triggers the
   bot automatically when its App and deployed webhook Worker are configured.
   Draft PRs do not start automatic review. If a run stops, the manual retry is
   `@jiaze-claude-review-bot review`; check the run before retrying.
2. Read the latest **Independent Review Session** comment authored by the
   configured review App (`<app-slug>[bot]`), identified by
   `<!-- jiaze-review-session:v1 -->`. Use the PR conversation or
   `gh api --paginate 'repos/OWNER/REPO/issues/PR/comments?per_page=100'` and select
   that author's session comment with the highest comment ID. Other authors'
   copies and the separate **Independent review** run-status comment are not
   review decisions.
3. Read the comment's status, open finding IDs and next action. Its
   `<!-- jiaze-review-state:... -->` payload is base64url-encoded JSON; decode it
   to read `lastReviewedHead` and compare it with the current PR `.head.sha`
   (`gh api repos/OWNER/REPO/pulls/PR --jq .head.sha`). Re-read HEAD before acting
   on a result. `HUMAN_REQUIRED` remains a stop even if another commit was pushed.

| Session result | Worker action |
|---|---|
| `REWORK` on current HEAD | Fix the open finding IDs, run project checks, commit and push. Read the updated session after targeted verification; keep the same bot session. |
| `AUDIT_PENDING` on current HEAD | Wait for the automatic final audit. If the run stops, inspect it and use the normal retry command. |
| `HUMAN_REQUIRED` | Stop and ask the user to decide the remaining findings or escalation. Do not reset or override the session to bypass its budget. |
| `READY` on current HEAD | PR review is complete for that commit. Merge still requires passing CI and the user's merge authorization. A new push requires another bot result. |
| Missing, stale, unreadable or unknown session | Review is incomplete. Check the bot run/configuration and retry or report the blocker; do not treat it as approval. |

A LOCAL `PASS` and a successful workflow run do not substitute for bot `READY`.
Before relying on this handoff in a target repository, verify the App is installed,
subscribed to **Pull request** events, and its current webhook Worker is deployed;
confirm an actual non-draft PR event produces a bot session for the matching HEAD.
`npm run doctor` checks the local runtime, not this GitHub deployment.

Supplying the retired `prNumber` input deliberately errors instead of
accidentally starting a LOCAL session. Older PR-mode loop state is retained
for inspection; it is neither deleted nor reinterpreted.

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
