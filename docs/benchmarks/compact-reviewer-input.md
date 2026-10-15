# Lossless changed-files prefix factoring

## Scope and safety

Every Reviewer call still gets the full frozen contract, goal, global constraints,
phase/final scope, inherited invariants, evidence, supervisor guidance, original
chunk diff and complete global changed-files list. Only the list's representation
changes: consecutive paths with the same directory become JSON tuples of
`[directory prefix, basenames]`. Concatenate each prefix with each basename.
Order, duplicate paths, and unusual characters round-trip exactly. Use the old
format whenever factoring would not reduce characters.

This does not remove requirements, introduce cached reviews, change chunking,
checkpoints, routing, severities, Sentinel, settlement or budgets. Cumulative
REWORK review remains unchanged: another file's repair can invalidate a previously
clean consumer. Final findings aggregation is unchanged, not substituted for any
independent review. Tests prove preservation of input and controller coverage;
they do not prove an LLM will never miss a defect.

## Relationship to PR #22

At investigation time main was `061a1a9`, and open PR #22 contained one commit,
`a051099`, adding component/accounting telemetry and a cross-chunk safety test.
This branch starts from main and does not copy its statistics or tests. The shared
changed-files construction line will need to call `changedFilesPrompt` when #22's
`changedFilesText` is integrated; its component sizes should measure that actual
rendered text. No accounting logic needs modification.

## Actual input replay

See the adjacent JSON for pinned SpinLab baseline/head and exact sizes. The
benchmark reads the original SpinLab frozen objective and uses its phase-1 scope,
actual 74-file diff and default five-chunk layout. Both sides receive the SAME
input (PASS gate, no submitted evidence); this is a read-only replay, not an exact
historical transport capture or a provider bill. It asserts all text outside the
changed-files section is identical. Full before/after prompt files are delivered
separately rather than putting another project's full contract/code in this repo.

262,298 -> 250,808 characters: 11,490 fewer (4.38%), or 2,298 per call.
The existing characters/4 proxy estimates 65,574.5 -> 62,702 input tokens
(2,872.5 fewer). Actual tokenizer/provider savings are not measured or guaranteed.
Small lists can save zero. This is a modest measurable reduction, not the earlier
50,000–75,000-token estimate. It saves no calls, output tokens or work already
billed to SpinLab.

Reproduce from this repository root:

```
node scripts/benchmark-compact-reviewer-input.mjs WORKFLOW_JSON SPINLAB_REPO cab41f16df70271c8790706d760bb2c70a451ebc OUT_DIR
```

The original workflow is read only. The script dispatches no model calls. Output
contains source/contract text; choose an appropriate local output directory.

## Larger reductions deferred

Each chunk is an independent invocation, so dropping its contract or replacing it
with a hash loses review obligations. Routing only selected requirements requires
an independently verified coverage mechanism. Reducing cumulative REWORK scope
requires evidence that interactions outside the repair diff are still reviewed.
Neither is established by the current architecture. Those changes are excluded
instead of claiming hypothetical savings.

## Verification

`tests/reviewerPromptCompact.test.js` verifies exact reconstruction including
unusual names/duplicates; small-list fallback; full scope/contract/evidence
preservation; and an actual controller REWORK cycle where a shared dependency
changes, the unchanged consumer is called again, and a new P2 still blocks PASS.
Existing chunk/checkpoint and spend/Sentinel tests run in the full suite.

Use `REVIEWLOOP_RUNTIME_DIR="$PWD/work/test-runtime" npm test` in a sandbox:
the doctor tests check runtime-directory writability, so the production runtime
must not be used by this isolated checkout. This changes only the test process
environment, not app configuration or the original SpinLab task.
