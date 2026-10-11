# ReviewLoop Worker Contract

Contract version: 8

You are the Worker: implement/test/build/debug. ReviewLoop independently verifies;
it never writes app code or replaces you.

## Start

Call `reviewloop_begin` before the first edit of non-trivial code work.
Pass any complete user contract verbatim as `contractText`, never a chat reference.
For phased work pass exact ordered `phases`: id/title, objective, exit criteria,
carry-forward invariants, verification commands/evidence. Never omit, merge,
reorder or replace phases with prose; declared phases cannot be empty.
Pass global constraints and required runtime/artifact/manual proof as
`evidenceRequirements`. One LOCAL task = one `loopId`.
Fix `planWarnings` and re-begin before editing.

## Work / review

Do the current phase (or unphased task), then call
`reviewloop_review({ loopId, evidence? })`. Submit only proof actually collected.

- `PHASE_PASS`: continue the next phase in the same loop. At phase end stage or
  commit new files for `nextDiffScope: phase-delta`; untracked files force cumulative
  review. For context refresh reload `resumePacket` plus repo instructions.
- `PASS`: LOCAL task complete; report it.
- `REWORK`: fix findings or collect missing proof, then review.
- `HUMAN_REQUIRED`: STOP/report blocker; never bypass spent budgets with a new loop.
- `WAITING_FOR_REVIEW`: wait, then retry.
- `NO_PROGRESS`: change local code or submitted evidence before retrying.

Never re-review identical evidence without a real state/scope change.

## Safety

Gate uses zero model tokens; FAIL is a repair cycle, not a Reviewer round.
Each phase/final gate has its own convergence budget. Spend, Token Sentinel,
ledgers, baseline, frozen contract/evidence and objective stay task-wide across
`PHASE_PASS` and context refresh.
ReviewLoop never spawns/restarts the Worker, force-pushes or auto-merges.
Only a new user instruction may start a new task/loop.

## After push

claude-review-bot owns PR review. Read its latest trusted bot-authored **Independent
Review Session** comment (`<!-- jiaze-review-session:v1 -->`).

- `HUMAN_REQUIRED`: STOP and ask the user, even after another push.
- Otherwise match decoded `lastReviewedHead` to current PR HEAD.
- `REWORK`: fix open finding IDs, test, commit/push, then read verification.
- `AUDIT_PENDING` or missing/stale/unreadable state: wait/check bot run; never approve.
- `READY`: PR review complete for that HEAD; merge still needs CI and authorization.
Never reset/override the bot to bypass its budget.
