# Design — Unified ReviewLoop settings (batch A + B), single source of truth

policy_sha: 7f01e5a3ff53ed13ba763d684a098c0989425ec4 · base: feat/shared-settings-file @ 1571ea6 (batch A, review PASS, pushed, not merged)

## Plan amendment — confirmed by the product owner
The frozen Plan fixed `MAX_SINGLE_CALL_USAGE` at 50000. Jack first said "那个5万的限制顺手改成8万吧，5万还是太小了", and, when the design review asked for confirmation (HUMAN_REQUIRED), replied "8万确认". The binding value for this task is therefore **80000**; every other Plan term is unchanged.

## Problem restated
Same-concept parameters live in several places (code defaults, per-client MCP env, per-model-family constants, docs/scripts). They already diverge: a review call times out at a fixed 180 s for Codex/Claude CLI but 240 s (cap 600 s, own env var) for AGY; Claude's client config says 80 000 for the single-call limit while Antigravity's says nothing (40 000). Goal: ONE ReviewLoop-owned file is the only source for every managed parameter, applied identically in every client and for every model family; everything it replaces is deleted.

## Managed parameters (the file's complete key set)
Batch A (already in file loader): `MAX_COST_USD`, `MAX_USAGE_VOLUME`, `MAX_REVIEW_ROUNDS`, `MAX_REVIEWER_CALLS`, `MAX_SUPERVISOR_CALLS`, `MAX_SINGLE_CALL_USAGE`, `MAX_CONTEXT_OVERHEAD_TOKENS`.
Batch B (new): `GATE_TIMEOUT_MS`, `MAX_GATE_REPAIRS`, `MAX_REVIEW_DIFF_CHARS`, `MAX_REVIEW_CHUNKS`, `AUTH_PROBE_TIMEOUT_MS`, `REVIEW_CALL_TIMEOUT_MS` (new unified name).
Not managed (stay outside, documented): model-selection vars (batch C), `REVIEWLOOP_ACK_UNACCOUNTED_SPEND`, `REVIEWLOOP_RUNTIME_DIR`, `REVIEWLOOP_SETTINGS_FILE`, installer dir vars (batch D); internal hard constants (Supervisor multiplier, hard caps).

## Options considered
1. **Settings authority at server start + keep env-shaped resolvers (chosen).** At `startReviewLoopMcpServer`, for each managed key: if the process env carries the legacy `REVIEWLOOP_<KEY>` variable, DISCARD it and warn once ("legacy env X ignored; ReviewLoop settings file is the only source — remove it from the client config"), then fill the env-shaped map from the file only. Existing resolvers and their many tests, which inject an explicit `env` object, are unchanged; production can no longer be influenced by client env. Smallest change that still gives one production source.
2. Thread an explicit `settings` object through every resolver and drop env reading entirely. Cleaner in the abstract but touches ~24 test files and ~15 call sites for no user-visible gain; rejected (higher regression risk than the problem warrants).
3. Keep env as an optional override (precedence env > file). Rejected by the product owner: it leaves a second source and the exact client divergence we are removing.
4. Per-family sections in the file (e.g. separate codex/claude/agy timeouts). Rejected: the product owner wants the same parameter unified, not per client/family.

## Design
**File.** `reviewloop.settings.json` (repo root, tracked), plain JSON, lists EVERY managed key with its current effective value, so the file is the one visible truth. Keys keep the short names. `MAX_SINGLE_CALL_USAGE` = 80000 (Plan amendment: the Plan froze 50000, but Jack explicitly changed it to 80000 during the Design stage — "5万还是太小了"; this document supersedes that one number and the current branch value 50000 is updated in the Code stage); `REVIEW_CALL_TIMEOUT_MS` = 240000; `AUTH_PROBE_TIMEOUT_MS` = 25000; all other keys = today's effective code default (3 rounds, $5, 400 000 volume, 91/8 call ceilings, 30 000 overhead, 600 000 gate timeout, 15 repairs, 45 000 diff chars, 12 chunks). Code defaults remain only as the fail-safe fallback when a key is missing/invalid; a test asserts the shipped file contains every managed key and each shipped value is valid, so fallbacks are never the live path.

**Loader (extends `settingsFile.js`).** Whitelist becomes the full managed set with a per-key validator (positive finite number; integer where required, e.g. repairs/rounds/chunks). Illegal → ignored + warning, fall back to code default. Hard caps stay (token thresholds 250 000/200 000, auth probe 60 000, review call timeout 600 000), enforced at the single resolver point for each key, not per client. Legacy-env discard + warning implemented once in `applySettingsFile` (it must clear the legacy var even when the file lacks the key).

**Timeout unification.** New single resolver `resolveReviewCallTimeoutMs(env)` reading `REVIEW_CALL_TIMEOUT_MS`; used by (a) the AGY review wiring (replaces `resolveAgyReviewTimeoutMs`/`AGY_REVIEW_TIMEOUT_ENV`/`DEFAULT_AGY_REVIEW_TIMEOUT_MS`/`MAX_AGY_REVIEW_TIMEOUT_MS`, deleted) and (b) the Codex and Claude CLI review transports (replaces the hard-wired `DEFAULT_CLI_TRANSPORT_TIMEOUT_MS = 180000`, deleted; the transports receive the resolved value as their `timeoutMs`). Auth probe: one value for all executables (`DEFAULT_AUTH_PROBE_TIMEOUT_MS` per-executable table and fallback deleted; the 25 s value is the wider of the two old defaults so no executable gets a stricter probe than before). `agyClient.DEFAULT_AGY_TIMEOUT_MS` (120 s) is a library default of `callAgy` that the review path always overrides with the resolved review timeout; it is not a separate user-facing parameter and is left as a call-argument default.

**Other batch B keys.** `GATE_TIMEOUT_MS` (gatePolicy), `MAX_GATE_REPAIRS` (controller), `MAX_REVIEW_DIFF_CHARS`/`MAX_REVIEW_CHUNKS` (diffChunker/designTarget/reviewerRunner) keep their existing resolver code; only their value source changes to the file via the map above. `MAX_GATE_REPAIRS` and the others reuse the shared validators so illegal values behave identically.

**Cleanup (deletion list).**
- Code: AGY-specific timeout resolver/consts/env name; fixed CLI transport timeout const; per-executable auth probe table/env name replaced by the unified key; stale comments quoting numbers.
- Docs: `docs/ARCHITECTURE.md` limits section lists key names, meaning, unit and caps but NOT numeric values (it points to the file); `README.md` and `docs/ROADMAP.md` mentions of env knobs/defaults rewritten to reference the file; `bin/reviewloop.js` hint text points at the file. Dated `docs/DECISIONS.md` records stay as history; a new decision entry supersedes the env-knob decisions (D36 etc.) and records the single-source rule.
- Scripts: `scripts/live-reviewloop-certify*.mjs` currently pass per-run `REVIEWLOOP_MAX_*` env into the spawned server; they instead write a temp settings file and set `REVIEWLOOP_SETTINGS_FILE` (location var, not a managed value).
- Out of repo (after merge + Jack's go-ahead only): remove `REVIEWLOOP_MAX_SINGLE_CALL_USAGE` from the Claude client config; Antigravity config already has no ReviewLoop numbers.

**Risk and compatibility.** Behavior changes: Codex/Claude review calls go 180 s → 240 s; Codex auth probe 10 s → 25 s; Antigravity's effective single-call limit 40 000 → 80 000, Claude's stays 80 000 but now comes from the file (explicit product decision, so both clients now agree); AGY timeout cap 600 000 retained. Operators who still set legacy env in a client get a warning and the value is ignored, never silently honoured.

## Assumptions
- The product owner's "unified timeout 4 minutes" is the initial value and can be edited in the file at any time.
- The effective defaults quoted above are read from current code and re-verified by tests against the shipped file.
- Hard-coded internal constants (not env-reachable today) are intentionally out of scope.
- `DEFAULT_AGY_TIMEOUT_MS` is only a library call default overridden on the review path (verified by grep: single review call site passes `timeoutMs`).
- Tests that inject an explicit `env` into resolvers stay valid because the discard logic lives only in `applySettingsFile`, which only the server entrypoint calls.

## Work Contract (Code stage)
Goal: managed parameters are read only from `reviewloop.settings.json` in production; all legacy sources and conflicting numbers are removed.
AC1. Shipped file contains exactly the 13 managed keys with valid values; a test fails if a managed key is missing or invalid. Evidence: unit test + `resolveReviewLoopLimits`/other resolvers read file values.
AC2. Legacy `REVIEWLOOP_<KEY>` env for any managed key, set in the process env at server start, is discarded with one warning per key and does not change resolved values; evidence: test that sets legacy env + different file value and asserts the file value wins, warning emitted, env var removed.
AC3. One `REVIEW_CALL_TIMEOUT_MS` governs Codex, Claude and AGY review calls; evidence: tests assert each transport/wiring receives the same resolved timeout from the file value and that the old AGY env name is gone (grep gate).
AC4. One `AUTH_PROBE_TIMEOUT_MS` governs all executables, capped at 60 000; per-executable table removed.
AC5. Illegal/missing file values fall back to code defaults with a warning, never disabling or inflating a guard (existing clamp tests stay green; add tests per new key).
AC6. No stale numbers: a repo grep gate/test fails if README/ARCHITECTURE/ROADMAP/bin hint text quote numeric defaults or removed env names for managed keys; DECISIONS gets a superseding entry; live certify scripts use `REVIEWLOOP_SETTINGS_FILE` and their tests stay green.
AC7. `npm test` and `npm run doctor` pass; existing explicit-env injection tests unchanged except where they referenced removed names.
Non-goals: batches C/D, hard-coded constants, merge, out-of-repo config edits (reported to Jack after merge).
