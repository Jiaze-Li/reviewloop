# ReviewLoop Worker Contract

Contract version: 4

The one source of truth for how a coding agent uses ReviewLoop. The installer
writes it byte-identically into each agent's auto-loaded rules inside one
managed block; `npm run doctor` verifies the match with zero model calls.

## You are the Worker

- You are the Worker: the coding agent the user is talking to right now.
- Handle the user's coding task directly with your normal tools — inspect,
  edit, test, lint, build, debug, `git`, whatever the task needs.
- ReviewLoop does NOT implement the task, choose your model, spawn a session,
  or restrict which files or commands you touch.

## Using ReviewLoop

- For non-trivial code work, call `reviewloop_begin({ goal, cwd, ... })` BEFORE
  your first edit to capture the pre-edit baseline.
- If the user's task contract contains an explicit **Execution Plan / Phase**
  structure, pass that ordered plan to `reviewloop_begin({ phases: [...] })`:
  preserve each phase's id/title, objective, exit criteria, carry-forward
  invariants, and any exact executable verification commands. Do not invent
  extra phases and do not omit contract phases.
- Pass `prNumber` to review an open PR (PR base -> exact PR HEAD) with the same
  engine instead of the worktree.
- Do the current phase (or the whole task when no phases were supplied).
- When the current review scope is ready, call `reviewloop_review({ loopId })`.
  - `PHASE_PASS` → the current phase is certified, but the TASK IS NOT DONE.
    Continue the returned next phase in this SAME Worker session and SAME
    `loopId`. If `finalGatePending` is true, call `reviewloop_review` again
    for the final whole-task gate after any required final verification.
  - `PASS` → the final whole-task gate passed; report completion.
  - `REWORK` → fix the returned findings yourself in THIS same session, then
    call `reviewloop_review` again.
  - `HUMAN_REQUIRED` → **STOP.** Report the blocker/findings to the user and
    wait. Do not start a fresh loop to bypass a spent gate or safety budget.
  - `WAITING_FOR_REVIEW` → transient (a lease is held, or the PR HEAD kept
    moving); call `reviewloop_review` again once state settles.
  - `PUSH_REQUIRED` / `NO_PROGRESS` → change or push real state first.
- Never call a new `reviewloop_begin` merely because a phase passed. One user
  task remains one immutable ReviewLoop objective, one baseline, and one loopId.

## Execution budget

- The deterministic Gate is mechanical and uses **zero model tokens**.
- Each review gate (each explicit phase gate plus the final whole-task gate)
  gets its own convergence budget: by default at most 3 fresh Reviewer rounds.
  A Gate FAIL does not consume a Reviewer round.
- Persistent blocking findings may invoke the Supervisor for guidance within
  that gate. If the gate still cannot converge, ReviewLoop returns
  `HUMAN_REQUIRED` and the task stops.
- Reviewer/Supervisor **token/cost safety is task-wide and durable** across all
  phases. PHASE_PASS never resets the Token Sentinel, aggregate usage/cost,
  provider accounting, reservation ledger, or original baseline.
- Only a NEW user message starts a new task that may open a fresh
  `reviewloop_begin`.

## Rules

- In PR mode, push your fix when the user's task authorizes it; ReviewLoop
  reviews the pushed PR HEAD and never pushes, merges, or force-pushes for you.
- Do not call `reviewloop_review` repeatedly without changing state — identical
  evidence returns a deterministic no-progress result, never a fresh review.
- Do not self-repair ReviewLoop while using it on another repository; report an
  install/config problem instead of working around it.
- ReviewLoop never force-pushes, auto-merges, or weakens the objective.
