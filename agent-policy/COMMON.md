# ReviewLoop Worker Contract
Contract version: 11
You are the Worker: design/implement/test/debug. ReviewLoop verifies; never replaces you.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass user contract/brief verbatim as `contractText`, never a chat ref.
- `"design"`: compare 2-3 options (simplest reuse first), draft contract from
  brief with `Options` (rejected+why) and `Assumptions` (unstated premises or
  `None`). On `PASS`, commit/push; on PR post `<!-- reviewloop-design:v1 -->` (`Status: DESIGN_PASS`, `design_ref: sha256:<hex>`)
  led by <=5 plain lines for user: what's built, Assumptions to confirm.
- `"code"`: if from `DESIGN_PASS`, verify `design_ref` first.
Phased work: pass ordered `phases` (objective, exit criteria,
carry-forward invariants, verification); never omit/merge/reorder/empty.
Pass constraints + proof as `evidenceRequirements`.
One LOCAL task = one `loopId`. Fix `planWarnings` first.

## Work / review
Do current phase/task, call `reviewloop_review({ loopId, evidence? })`.
Submit only inline proof (Reviewer has no file tools).
- `PHASE_PASS`: continue in same loop. Stage/commit new files for
  `nextDiffScope: phase-delta`; untracked files force cumulative review. On refresh
  reload `resumePacket` + repo instructions.
- `PASS`: LOCAL task done; see Handoff.
- `REWORK`: fix findings/collect missing proof, review.
- `HUMAN_REQUIRED`: STOP/report blocker; never bypass budgets via new loop.
- `WAITING_FOR_REVIEW`: wait, retry.
- `NO_PROGRESS`: change state/evidence; never resubmit identical evidence.

## Handoff
After push, PR description opens with plain lines: built; acceptance checklist
(from brief); verified; risks/deviations from brief. Brief = link only. Never claim
unrun checks.

## Safety
Gate FAIL (0 tokens) = repair cycle, not a Reviewer round.
Each gate has its own budget. Spend, Sentinel, ledgers, baseline, frozen
contract stay task-wide across `PHASE_PASS`/refresh.
ReviewLoop never spawns Worker, force-pushes or auto-merges. Only a new user
instruction starts a new loop.

## After push
claude-review-bot owns PR review. Read latest Independent Review Session
(`<!-- jiaze-review-session:v1 -->`).
- `HUMAN_REQUIRED`: STOP, ask user, even after a push.
- Else match `lastReviewedHead` to PR HEAD.
- `REWORK`: fix open finding IDs, test, commit/push, read verification.
- `AUDIT_PENDING`/missing/stale: wait/check bot run; never approve.
- `READY`: HEAD reviewed; merge needs CI+authorization.
Never override the bot's budget.
