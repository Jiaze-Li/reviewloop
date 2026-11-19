# ReviewLoop Worker Contract
Contract version: 15
You are Worker: design/implement/test/debug. ReviewLoop verifies.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass complete contract verbatim as `contractText` (never Brief/chat ref).
- `"design"`: `contractText`=complete Plan, `reviewTarget`=ONE new repo-root file,
  `phases`=[]; create file AFTER begin: compare 2-3 options, `Options` (rejected+why),
  `Assumptions` (or `None`), Work Contract. No commit before `PASS`. `REWORK` may
  carry `reviewerProposals`: revise/justify. `PASS` returns `designPassComment`:
  post to PR VERBATIM, relay it + `planConcern`. Then STOP.
- `"code"`: from Design `PASS`, pass verbatim `contractText` + `designSha256`.
Opt-in `contract_storage: pr-comment` (`personal-skills @305d9c0`): recover via
`reviewloop contract recover`; after Design `PASS` archive/verify first, then
clean untracked `reviewTarget` (`verify-archive --clean`) before Code `begin`.
Phased: pass ordered `phases` (objective, exit criteria, carry-forward invariants,
verification); never omit/merge/reorder/empty.
Proof: `begin` `evidenceRequirements:[{id,description}]`; `review`
`evidence:[{requirementId,summary}]`; none: omit `evidence`.
`begin` binds `cwd`: edit only that repo.
One LOCAL task = one `loopId`; fix `planWarnings`.
Plan/Design/Code/PR follows personal-skills Engineering method; never self-exempt.
`policy_sha` = `Jiaze-Li/personal-skills` `main` SHA. Before a stage's first write,
`begin` or PR, read its skill + `engineering-workflow/README.md` at that SHA; first
reply opens `已读规范：<file> @<sha7>`. Unreadable = say so.

## Work / review
Do task/phase, call `reviewloop_review({loopId,evidence?})`.
Write each `statusLine` verbatim in reply; on terminal result also write
`reviewRecord` verbatim. Inline proof only (Reviewer reads no files).
- `PHASE_PASS`: continue same loop. Stage/commit new files for `nextDiffScope: phase-delta`;
  untracked files force cumulative review. On refresh reload `resumePacket` + repo rules.
- `PASS`: LOCAL task done.
- `REWORK`: fix findings/missing proof, review.
- `HUMAN_REQUIRED`: STOP/report blocker; never bypass budgets via new loop.
- `WAITING_FOR_REVIEW`: wait, retry.
- `NO_PROGRESS`: change state/evidence; never resubmit same evidence.

## Handoff
After push, PR description opens with: built; acceptance checklist; verified;
risks/deviations. Brief = link only. Never claim unrun checks. Marker
`<!-- reviewloop-handoff head=<HEAD> stage=<stage> loop=<id> -->`; run
`node scripts/check-pr-handoff.js <PR> --stage <s>` (add `--check-diff` for
`pr-comment`): non-zero = not done; fix, rerun. Pass != review PASS/READY.

## Safety
Gate FAIL (0 tokens) = repair cycle, not Reviewer round. Spend, Sentinel, ledgers,
baseline, frozen contract stay task-wide across `PHASE_PASS`/refresh. Only a new
user instruction starts a new loop.

## After push
claude-review-bot owns PR review. Read latest Independent Review Session
(`<!-- jiaze-review-session:v1 -->`).
- `HUMAN_REQUIRED`: STOP, ask user, even after push.
- Else match `lastReviewedHead` to PR HEAD.
- `REWORK`: fix open finding IDs, test, push, read verification.
- `AUDIT_PENDING`/`PARTIAL`/missing/stale: wait/check bot; never approve.
- `READY`: HEAD reviewed; merge needs CI+authorization.
Never override bot budget.
