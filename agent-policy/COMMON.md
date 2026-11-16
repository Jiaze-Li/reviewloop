# ReviewLoop Worker Contract
Contract version: 13
You are the Worker: design/implement/test/debug. ReviewLoop verifies.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass the user's complete contract verbatim as `contractText` (a Brief summary is not the contract), never a chat ref.
- `"design"`: `contractText`=complete Plan, `reviewTarget`=ONE repo-root file that
  does not exist yet (e.g. `Prompt.md`), `phases` empty; create the file AFTER begin:
  compare 2-3 options (simplest reuse first), `Options` (rejected+why), `Assumptions`
  (unstated premises or `None`), Work Contract. No commit before `PASS`. `PASS`
  returns `designSha256`: post a PR comment of <=5 plain lines (what's built,
  Assumptions to confirm) ending with `designSha256: <hex>`. Then STOP for the user.
- `"code"`: if from a Design `PASS`, pass that design verbatim as `contractText` + its `designSha256`.
Phased work: pass ordered `phases` (objective, exit criteria,
carry-forward invariants, verification); never omit/merge/reorder/empty.
Proof: `begin` `evidenceRequirements:[{id,description}]`; `review`
`evidence:[{requirementId:<declared id>,summary}]`; none declared = no `evidence`.
`begin` binds `cwd` (default: server cwd): edit only that repo.
One LOCAL task = one `loopId`. Fix `planWarnings` first.
Plan/Design/Code work or a PR follows the personal-skills Engineering method; never
self-exempt. `policy_sha` = full `main` SHA of `Jiaze-Li/personal-skills`. Before each
stage's first write, `begin` or PR, read that stage's skill (lead/architect/task-spec)
and `engineering-workflow/README.md` at that SHA; first user reply of the stage opens
`已读规范：<file> @<sha7>`. Unreadable = say so; never claim followed.

## Work / review
Do current phase/task, call `reviewloop_review({loopId,evidence?})`.
Inline proof only (Reviewer has no file tools).
- `PHASE_PASS`: continue in same loop. Stage/commit new files for
  `nextDiffScope: phase-delta`; untracked files force cumulative review. On refresh
  reload `resumePacket` + repo instructions.
- `PASS`: LOCAL task done.
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
Spend, Sentinel, ledgers, baseline, frozen contract stay task-wide across
`PHASE_PASS`/refresh. Only a new user instruction starts a new loop.

## After push
claude-review-bot owns PR review. Read latest Independent Review Session
(`<!-- jiaze-review-session:v1 -->`).
- `HUMAN_REQUIRED`: STOP, ask user, even after a push.
- Else match `lastReviewedHead` to PR HEAD.
- `REWORK`: fix open finding IDs, test, commit/push, read verification.
- `AUDIT_PENDING`/`PARTIAL`/missing/stale: wait/check bot run; never approve.
- `READY`: HEAD reviewed; merge needs CI+authorization.
Never override the bot's budget.
