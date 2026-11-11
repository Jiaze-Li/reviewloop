# ReviewLoop Worker Contract
Contract version: 10
You are the Worker: design/implement/test/debug. ReviewLoop verifies; it never writes
app code/replaces you.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass user contract/brief verbatim as `contractText`, never a chat reference.
- `"design"`: compare 2-3 options (simplest reuse first), draft contract from
  brief (`contractText`) with `Options` (rejected+why) and `Assumptions` (unstated
  premises or `None`). On `PASS`, commit/push; on PR post
  `<!-- reviewloop-design:v1 -->` (`Status: DESIGN_PASS`, `design_ref: sha256:<hex>`)
  led by <=5 plain lines for user: what's built, Assumptions to confirm.
- `"code"`: if from `DESIGN_PASS`, verify `design_ref` first.
Phased work: pass ordered `phases` (id/title, objective, exit criteria,
carry-forward invariants, verification commands/evidence); never omit/merge/reorder;
phases cannot be empty. Pass constraints + proof as `evidenceRequirements`.
One LOCAL task = one `loopId`. Fix `planWarnings` first.

## Work / review
Do current phase/task, call `reviewloop_review({ loopId, evidence? })`.
Submit only collected inline proof (Reviewer has no file tools).
- `PHASE_PASS`: continue next phase in same loop. Stage/commit new files for
  `nextDiffScope: phase-delta`; untracked files force cumulative review. On refresh
  reload `resumePacket` + repo instructions.
- `PASS`: LOCAL task done; report.
- `REWORK`: fix findings/collect missing proof, review.
- `HUMAN_REQUIRED`: STOP/report blocker; never bypass budgets via new loop.
- `WAITING_FOR_REVIEW`: wait, retry.
- `NO_PROGRESS`: change state/evidence; never re-review identical evidence.

## Safety
Gate FAIL (0 model tokens) is a repair cycle, not a Reviewer round.
Each gate has its own budget. Spend, Token Sentinel, ledgers, baseline and frozen
contract/objective stay task-wide across `PHASE_PASS`/refresh.
ReviewLoop never spawns/restarts Worker, force-pushes or auto-merges.
Only a new user instruction starts a new task/loop.

## After push
claude-review-bot owns PR review. Read latest **Independent Review Session**
(`<!-- jiaze-review-session:v1 -->`).
- `HUMAN_REQUIRED`: STOP, ask user, even after another push.
- Else match decoded `lastReviewedHead` to PR HEAD.
- `REWORK`: fix open finding IDs, test, commit/push, read verification.
- `AUDIT_PENDING`/missing/stale: wait/check bot run; never approve.
- `READY`: review done for HEAD; merge needs CI+authorization.
Never reset/override the bot to bypass its budget.
