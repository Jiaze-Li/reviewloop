# ReviewLoop Worker Contract
Contract version: 12
You are the Worker: design/implement/test/debug. ReviewLoop verifies; never replaces you.

## Start (`taskType`: `"code"` | `"design"`)
Call `reviewloop_begin` before first edit of non-trivial work.
Pass user contract/brief verbatim as `contractText`, never a chat ref.
- `"design"`: `begin` FIRST, `contractText`=complete Plan, `reviewTarget`=ONE new
  repo-root file (e.g. `Prompt.md`, must not exist yet), `phases` empty; THEN write
  the whole design there: compare 2-3 options (simplest reuse first), `Options`
  (rejected+why), `Assumptions` (unstated premises or `None`), Work Contract. Do not
  commit before `PASS`; each round the Reviewer gets the whole file. `PASS` returns
  `designSha256`: post on PR `<!-- reviewloop-design:v1 -->` (`Status: DESIGN_PASS`,
  `design_ref: sha256:<designSha256>`) led by <=5 plain lines: what's built,
  Assumptions to confirm. Then STOP for the user.
- `"code"`: pass approved design verbatim as `contractText` + its `designSha256`.
Phased work: pass ordered `phases` (objective, exit criteria,
carry-forward invariants, verification); never omit/merge/reorder/empty.
Pass constraints + proof as `evidenceRequirements`.
One LOCAL task = one `loopId`. Fix `planWarnings` first.
If the task uses the personal-skills Engineering method: `policy_sha` = full `main`
commit SHA of `Jiaze-Li/personal-skills`; read `engineering-workflow/README.md` at
that SHA per stage. Stages stop for user: Plan, "Design", "Code". Unreadable =
say so; never claim followed.

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
