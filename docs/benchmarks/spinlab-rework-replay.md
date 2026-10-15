# Previous-findings repair and real REWORK replay

The Reviewer runner already passed `previousFindings`, but the prompt builder
ignored it. The builder now sends the persisted historical findings to every
chunk, explicitly as untrusted observations. It requires independent rechecking,
allows stale locations, prohibits treating absent code as resolved or as a new
finding by itself, and keeps the obligation to find new defects. The response
schema is unchanged. A resolved old blocker is not copied into current findings.
The first review is byte-identical when no prior findings exist.

All original goal/contract/constraints/invariants, scope, evidence, guidance,
changed files and chunk diff are preserved. No production repair-only mode is
introduced. Routing, P1/P2/P3, checkpoint keys, Sentinel, settlement and the
400,000-token limit are unchanged. The original SpinLab state is read only.
This branch starts at main `061a1a9`; open PRs #22 (telemetry) and #23 (path
prefixes) are not copied or overwritten. Their prompt-assembly edits may need
ordinary merge resolution while retaining this historical-findings section.

## What could actually be reconstructed

The original session is `rl-20261015044936-4bc2bfe8`. Its retained state has the
phase-2 baseline snapshot `1b2f978c800996a4f5e117d03b81dbb4c5c9d7dd`, the last
reviewed HEAD `5ad03a35b552c5fbcf3c46ee1248f203939ba4b7`, three blocking findings,
and a corresponding repair commit `cab41f16df70271c8790706d760bb2c70a451ebc`.
The intended repair changes ten files, including negative fixtures, for three blockers.
Git ancestry and input reconstruction do not certify that the repair is correct
or free of other changes; no semantic acceptance is inferred from the commit.

The replay reconstructs round 10 from Git and the frozen objective. It requires
all source dependencies and package manifests outside the changed wiring file to
match the pre-fix revision, failing if they drift. Every one of
its four chunk diff lengths AND prompt lengths matches the historical spend
ledger: total 142,811 diff characters and 211,823 prompt characters. Matching
lengths support reconstruction, but the ledger has no raw historical prompt
hashes; this is not a claim of byte-proven historical transport identity.

Round 11 did not complete historically. Its full repaired review is reconstructed,
not billed usage. There are no evidence records in this fixture; the script
refuses a fixture with evidence records rather than silently omitting them.

The available state does not retain all nine phase-1 working-tree snapshots and
prior finding sets with round mappings. Therefore it cannot establish how many
of those nine reviews a repair-only design would have avoided. We do not treat
all later full reviews as unnecessary or invent a reduced round count.

## Like-for-like comparison

Both candidate plans use the same repaired phase-2 snapshot, complete frozen
contract, scope and inherited invariants. The full acceptance input in the new
plan is identical to the baseline full review, including every cumulative diff
chunk and the historical findings. The repair-only candidate also carries the
complete contract and global file inventory. It explicitly cannot authorize
phase/task PASS. The initial review is shared by both plans and cancels out.
This is current phase-gate acceptance, not completion of future task phases.

| Input after the real repair | Characters | cl100k_base | o200k_base |
|---|---:|---:|---:|
| Full review before this bug fix | 218,851 | 68,813 | 63,033 |
| Full review including prior findings | 231,803 | 71,601 | 65,817 |
| Additional repair-only verification | 31,257 | 11,232 | 9,799 |
| Repair-only plus the same full acceptance | 263,060 | 82,833 | 75,616 |

For this single attributable repair transition, the proposed two-step flow
**adds 9,799–11,232 tokenizer tokens**. There is no intermediate failed repair
snapshot available here on which to demonstrate avoided full re-reviews.
The previous-findings fix itself adds 2,784–2,788 tokenizer tokens across four
chunks; it fixes information loss, not per-call token cost. A future claim of
net benefit requires observed reduction in rounds exceeding this added cost.
Tokenizer counts are not selected-model or provider billing. The character/4
proxy is also retained in the JSON and is explicitly only an estimate.

## Coverage and decision

Input-preservation assertions check that every original diff character reaches
the full review and the complete frozen contract remains in each prompt. The
controller regression test goes through the real prompt builder and metered
review path: an old P2 is repaired, a different file develops a new P2, every
chunk receives the historical blockers, and the new P2 still prevents PASS.
A later clean/P3-only round may pass. These deterministic fixtures test plumbing
and controller policy; they do not prove model detection quality or lower false
negative rates.

No model calls were made for the cost replay. A real independent semantic replay
of the proposed repair flow has not been established. Also, existing isolated
chunks and the oversized final-diff reducer do not prove joint cross-file
semantic coverage. Consequently this PR enables no new acceptance or caching
path. The final-review cost must never be replaced with a cheap findings union.

**Decision:** ship the missing-context fix. Keep repair-only + full-acceptance
as an unenabled design candidate. The available real transition costs more;
there is no demonstrated safe net saving to advertise. A worthwhile next
experiment would need recorded successive repairs, full per-round inputs and
findings, and independent detection/coverage evaluation before production use.

## Reproduction and validation

From the repository root, with access to the original local inputs:

```
node scripts/replay-spinlab-rework.mjs WORKFLOW_JSON SPINLAB_REPO cab41f16df70271c8790706d760bb2c70a451ebc OUT_DIR
python3 scripts/count-rework-replay-tokens.py OUT_DIR
```

The tokenizer script requires `tiktoken`; it is an optional analysis dependency,
not a new runtime/test dependency. Encoding assets may need fetching on first
use. Prompt construction itself performs no provider calls. Output contains
another project's source and contract, so full prompt files are delivered locally
rather than committed here. Adjacent JSON files hold reproducible aggregate data.

Full suite: 717 tests passed with
`REVIEWLOOP_RUNTIME_DIR="$PWD/work/test-runtime" npm test`. The sandbox doctor
requires a writable isolated runtime directory; this leaves production state
untouched. Targeted tests are in `tests/reviewerPreviousFindings.test.js`.
