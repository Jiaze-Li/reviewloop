# ReviewLoop Worker Contract
Contract version: 18
You are Worker: design/implement/test/debug. ReviewLoop verifies.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass complete contract verbatim as `contractText` (never Brief/chat ref).
- `"design"`: `contractText`=complete Plan, `reviewTarget`=ONE new repo-root file,
  `phases`=[]; create file AFTER begin: compare 2-3 options; `Options` (rejected+why),
  `Assumptions` (or `None`), Work Contract. No commit before `PASS`. `REWORK` may
  carry `reviewerProposals`: revise/justify. `PASS` returns `designPassComment`:
  post to PR VERBATIM, relay it + `planConcern`. Then STOP.
- `"code"`: from Design `PASS`, pass verbatim `contractText` + `designSha256`.
New tasks keep Plan/Design in PR comments (legacy: old paths): recover via
`reviewloop contract recover`; after Design `PASS` archive/verify, then
`verify-archive --clean` untracked target before Code `begin`.
Phased: pass ordered `phases` (objective, exit criteria, carry-forward
invariants, verification); never omit/merge/reorder.
Proof: `begin` `evidenceRequirements:[{id,description}]`; `review`
`evidence:[{requirementId,summary}]`; none: omit `evidence`.
`begin` binds `cwd`: edit only there.
One LOCAL task = one `loopId`; fix `planWarnings`.
Plan/Design/Code/PR follow `engineering/` (`docs/BOUNDARY.md`).
`policy_sha`=`reviewloop@<sha>`. Before a stage's first write/`begin`/PR:
`reviewloop spec <plan|design|code|review|pr> [--at <sha>]`; first reply opens
`已读规范：<file> @<sha7>`. Bare 40-hex = legacy personal-skills task: frozen contract. Unreadable: say so.

## Work / review
Do task/phase, call `reviewloop_review({loopId,evidence?})`.
Write each `statusLine` verbatim; on terminal result also `reviewRecord`.
Inline proof only (Reviewer reads no files).
- `PHASE_PASS`: continue same loop. Stage/commit new files for
  `nextDiffScope: phase-delta` (untracked = cumulative). On refresh reload
  `resumePacket` + repo rules.
- `PASS`: LOCAL task done.
- `REWORK`: fix findings/missing proof, review.
- `HUMAN_REQUIRED`: show `reportText` verbatim; STOP; no new loop.
- `WAITING_FOR_REVIEW`: wait, retry.
- `NO_PROGRESS`: change state/evidence; never resend same evidence.

## Handoff
After push, PR description opens with: built; acceptance checklist; verified;
risks/deviations. Brief = link only. Never claim unrun checks. Marker
`<!-- reviewloop-handoff head=<HEAD> stage=<stage> loop=<id> -->`; run
`node scripts/check-pr-handoff.js <PR> --stage <s> --check-diff` (omit
`--check-diff` legacy only): non-zero = not done; fix, rerun. Pass != PASS/READY.

## Safety
Gate FAIL (0 tokens) = repair cycle, not a round. Spend, Sentinel, ledgers,
baseline, frozen contract stay task-wide across `PHASE_PASS`/refresh. Only a new
user instruction starts a loop.

## After push
Bot owns PR review. On "处理 PR <n>" read latest
`<!-- jiaze-review-session:v1 -->`; match `lastReviewedHead` to HEAD.
- `HUMAN_REQUIRED`: STOP, ask user.
- `REWORK`: fix open IDs, test, push, comment `@gemini review` ONCE (not if posted
  after HEAD); report, STOP. Never click Resolve.
- `AUDIT_PENDING`/`PARTIAL`/missing/stale: wait/check bot; never approve.
- `READY`: merge needs CI+authorization; not before re-review lands.
Never override bot budget. After ReviewLoop PR merges: update main, tell user
to open new session.
