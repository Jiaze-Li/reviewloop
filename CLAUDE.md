# gpt-dev-loop

## Code review conventions

Label every review finding with a severity prefix and lead each inline comment with it.

- **P1** - blocking: wrong results, data loss or corruption, a fail-closed path failing silently, credential or security exposure, breaking an existing caller or a documented contract.
- **P2** - blocking: unhandled edge cases with bounded blast radius, error paths that swallow context, real but unlikely races, missing test coverage for new branching logic.
- **P3** - non-blocking nit: naming, structure, duplication, stale comments.

ReviewLoop completion policy: **no P1 and no P2 → eligible for PASS**. P3 is
reported (capped) but never blocks completion by default.

Review output rules:

- Begin every inline comment with the bare label, e.g. `P1: ...`.
- Report at most 8 P3 items; summarise any remainder as a count.
- Skip anything the test suite, `npm run benchmark` or `npm run doctor` already enforces.
- Cite `file:line` for any claim about behaviour. Never infer behaviour from a symbol name alone.
- Prefer silence over speculation: drop findings you cannot trace to concrete code.

## Project context

This repository is **ReviewLoop**: a post-execution review and repair
controller for coding agents. The Worker (the coding agent the user is talking
to) owns execution — it implements, tests, and pushes directly. ReviewLoop
owns the LOCAL deterministic Gate, an independent Reviewer, non-convergence
detection, and exception-only Supervisor guidance. GitHub PR review belongs to
claude-review-bot; the Worker follows its session result after push. ReviewLoop
never writes application code, commits, pushes, merges, or force-pushes.

`REWORK` loops back to the **same** Worker session, not a fresh one. The Worker
contract lives in `agent-policy/COMMON.md`; the architecture in
`docs/ARCHITECTURE.md`.
