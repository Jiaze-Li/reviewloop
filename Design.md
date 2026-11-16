# Design: Two-Stage Design Review (Independent Proposal + Supervisor Adjudication)

> `policy_sha`: `7f01e5a3ff53ed13ba763d684a098c0989425ec4` (`Jiaze-Li/personal-skills` `main`)
> Plan baseline: [Plan.md](./Plan.md) @ `4b428435eb020060ac16b5ce9306defa8a9b5d38`

## 1. Goal & Scope
1. Replace single-pass design review (`taskType === "design"` with `reviewTarget`) with a two-stage workflow:
   - **Stage 1 (Independent Proposal)**: Reviewer sees `Plan` (`contractText`) + bounded read-only codebase context, **never** `reviewTarget` in Round 1, and proposes up to 2 approaches with trade-offs.
   - **Stage 2 (Supervisor Adjudication)**: Supervisor sees `Plan`, Reviewer's proposals, and Worker's `reviewTarget`, outputs a structured two-column adjudication (proposal comparison + item-by-item design blocking checks), and on `PASS` generates a concise, formatted PR comment (`designPassComment`) for the Worker to post verbatim.
2. Cleanly separate shared engine infrastructure (provider pools, `meteredWithFailover`, spend/quota/accounting, persistence/lease, MCP transport) from `taskType`-specific workflow logic via an explicit mode field, leaving `code` and legacy `design` loops untouched.
3. Add observability (`statusLine` in `reviewloop_begin` / `reviewloop_review`, plus `notifications/progress` stage heartbeats), update docs, and tighten `agent-policy/COMMON.md` under a **3400-byte** budget.

**Non-goals**: Changing `code` review behavior/prompts/pools; adding new roles or model pools; giving ReviewLoop GitHub write access; relaxing spend/quota/fail-closed guarantees.

---

## 2. Verified Codebase Facts
- `src/reviewloop/reviewerRunner.js:189-192`: `const isDesignTask = usesSupervisorPoolForReview(objective);` routes legacy design loops (no `reviewTarget`) to `supervisor` pool (`agy:gemini-supervisor`), while `reviewTarget` design loops already route to `reviewer` pool (`agy:opus` first).
- `src/orchestrator/roleRouting.js:42-61`: `DEFAULT_ROLE_POLICY.supervisor` is `['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus']` (`agy-gemini` quota pool); `DEFAULT_ROLE_POLICY.reviewer` is `['agy:opus', 'agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus']` (`agy-claude-gpt` quota pool first).
- `src/reviewloop/adapters/minimalAgyAgent.js:48-75`: `reviewloop-minimal` is a single-turn, stateless JSON responder with `inheritCustomizations: false`, `inheritMcp: false`, `tools: []`, and explicit instruction `"Do not call any tool. Do not read repository or workspace files."`
- `src/reviewloop/controller.js:397,428`: `async function review({ loopId, evidence = [], signal, onHeartbeat } = {})` accepts `onHeartbeat` but calls `return await reviewInner({ loopId, evidence, signal });` — `onHeartbeat` is currently never forwarded to `reviewInner`.
- `src/mcp/reviewloopMcpServer.js:222-235`: `reviewloop_review` already passes `onHeartbeat` to `ctl.review()`, emitting MCP `notifications/progress` with `progressToken: extra?._meta?.progressToken ?? loopId`.
- `src/reviewloop/controller.js:1013-1025,1065-1079,1150-1160`: `designTarget` is read via `readReviewTarget`, verified to fit in one chunk (`assertTargetWithinOneChunk`), re-read after review to detect mid-review drift, and `loopState.designReview` persists `{ reviewTarget, designSha256, bytes, round, reviewedAt }`.
- `agent-policy/COMMON.md` & `tests/reviewLoopContextFootprint.test.js:46-51`: `COMMON.md` is currently 3241 bytes against a `<= 3300` byte assertion; user approved raising this cap to **3400 bytes** with concise cleanup.

---

## 3. Options Considered

### Option A: Controller-Proxied On-Demand File Read + Explicit `reviewMode` Dispatch (Recommended)
- **Reviewer context**: Keep `reviewloop-minimal` (`tools: []`, single-turn JSON). In `design-two-stage`, Stage 1 runs up to 2 sub-steps inside the controller:
  1. **File Request (optional)**: Reviewer receives `Plan` (`contractText`) + `git ls-files` tree (strictly excluding `reviewTarget`) + `docs/ARCHITECTURE.md` / `package.json` summary, and either returns `{ requestedFiles: string[] }` (capped, e.g., `<= 10` files) or skips directly to `{ proposals }` if no extra files are needed.
  2. **Proposal**: Controller reads `requestedFiles` directly from `cwd` (reusing `lstatNoSymlinks` / path-normalization guards, mechanically rejecting `reviewTarget`, capped at a bounded byte limit) and feeds them to Reviewer to output up to 2 proposals with trade-offs. (Exchange rounds reuse already-fetched files or allow one bounded refresh.)
- **Workflow isolation**: Add explicit `reviewMode` (`'code'` | `'design-legacy'` | `'design-two-stage'`) on `objective` and `loopState`. Extract two-stage design orchestration into a dedicated module (`src/reviewloop/designTwoStage.js`), keeping `controller.js` / `reviewerRunner.js` clean for `code` and `design-legacy`.
- **Why chosen**: Works identically across all transports (`agy`, `claude`, `codex`, test fakes); lets Reviewer inspect the exact source files it needs; mechanically guarantees `reviewTarget` cannot leak to Reviewer (satisfies A1); keeps `reviewloop_review` as a single call per round without trusting Worker-supplied file contents.

### Option B: Give Reviewer a Read-Only File Tool (`read_file` / Custom MCP)
- **Rejected**: `reviewloop-minimal` sets `tools: []` and `inheritMcp: false` specifically to avoid ambient context/tool-loop overhead. Enabling AGY built-in `read_file` cannot enforce a per-path block on `reviewTarget`, risking A1 leakage; building a custom path-filtering MCP server requires per-CLI injection across AGY, Codex, and Claude.

### Option C: Proxy File Reads Through the Worker (`NEED_FILES` Round-Trip)
- **Rejected**: Returning `NEED_FILES` to the Worker for re-submission complicates the `reviewloop_review` state machine, bloats Worker context, and weakens tamper-resistance when the controller already has direct read access to `cwd`.

### Option D: Overload Existing `reviewerRunner.js` + `runSupervisor` Branches
- **Rejected**: Violates D10; `runSupervisor` is currently tied to `REWORK` escalation after Reviewer failure, whereas two-stage design runs Supervisor as the primary adjudicator on every round. Mixing both in `controller.js` would couple `code` and `design` state machines.

---

## 4. Assumptions
- `reviewloop-minimal` (AGY Opus for Reviewer, Gemini 4 Hydrogen medium for Supervisor) can reliably follow the structured JSON schemas for optional file requests, independent proposals, and two-column adjudication (tracked as post-implementation live checks U1/U2).
- Bounded on-demand repo reads (`git ls-files` tree excluding `reviewTarget` + up to 10 Reviewer-requested files within a fixed byte cap) are sufficient for Reviewer to ground its proposals in actual code.
- `COMMON.md` footprint cap in `tests/reviewLoopContextFootprint.test.js` is raised from `3300` to `3400` bytes as authorized by the user.

---

## 5. Authoritative Design & State Machine

### 5.1 Explicit Mode & Backward Compatibility (D10, D11)
- `createReviewObjective` sets `reviewMode`:
  - `taskType === 'code'` → `'code'`
  - `taskType === 'design'` and `reviewTarget != null` → `'design-two-stage'`
  - `taskType === 'design'` and `reviewTarget == null` → `'design-legacy'`
- On resume of older persisted loops lacking `reviewMode`, a single migration helper infers `'design-legacy'` when `taskType === 'design' && !reviewTarget`, `'code'` when `taskType === 'code'`, and `'design-two-stage'` when `taskType === 'design' && reviewTarget`.

### 5.2 Two-Stage Design Round Flow (D1–D9, A1–A9)
Each `reviewloop_review` call in `'design-two-stage'` runs at most **3 logical model calls** (1 optional Reviewer file-request + 1 Reviewer proposal + 1 Supervisor adjudication):
1. **Preflight & Drift Guard**: Validate lease, Gate, and `readReviewTarget({ cwd, reviewTarget })` (must exist, valid UTF-8, `<= 64 KiB`). Emit `onHeartbeat` (`collecting_context`).
2. **Stage 1 — Reviewer Independent Proposal** (`reviewer` pool):
   - Emit `onHeartbeat` (`reviewer_proposing`).
   - **On-Demand File Request (optional, max 1 call/round)**: Reviewer sees `Plan` (`contractText`) + `git ls-files` tree (`reviewTarget` strictly excluded) + `ARCHITECTURE.md` / `package.json` summary; it may request up to 10 repo-relative files (`requestedFiles`). Controller reads them directly from `cwd` (symlink-safe, mechanically rejecting `reviewTarget`, bounded byte cap).
   - **Round 1 (`exchangeCount === 0`)**: Input contains `Plan` + repo tree + requested file contents (`reviewTarget` strictly excluded). Output: `{ proposals: [{ title, summary, tradeoffs }], confidenceNote }`, max 2 proposals.
   - **Exchange Rounds (`exchangeCount >= 1`, `<= 2`)**: Input contains `Plan` + repo context + **Supervisor's concise summary of Worker's previous-round approach** (never raw `reviewTarget` bytes).
   - If Reviewer fails or returns invalid schema (after `meteredWithFailover`), fail closed (`HUMAN_REQUIRED` / `spendDenialResult`, never `PASS`).
3. **Stage 2 — Supervisor Adjudication** (`supervisor` pool):
   - Emit `onHeartbeat` (`supervisor_adjudicating`).
   - Input: `Plan` (`contractText`), Reviewer's `proposals[]`, Worker's full `reviewTarget` content, and prior exchange history.
   - Output JSON schema (validated strictly; invalid schema = fail-closed):
     - `comparison`: `{ verdict: 'ALIGNED' | 'MINOR_DIFF' | 'MAJOR_DIFF' | 'NEEDS_HUMAN', reason: string, workerSummary: string, planConcern: string | null }`
     - `blockingFindings`: `[{ severity, title, detail, rule }]` (Plan/non-goal violation, missing AC, inconsistency, missing `Options`/`Assumptions`, over-engineering)
     - `nonBlockingFindings`: `[{ title, detail }]`
     - `humanQuestions`: `string[]` (required when `verdict === 'NEEDS_HUMAN'`)
     - `designPassComment`: `string | null` (formatted, concise user-readable comment when `ALIGNED`/`MINOR_DIFF` and `blockingFindings.length === 0`, covering: what is built, `Assumptions` to confirm, proposal comparison conclusion, `planConcern` if any)
4. **Mid-Review Drift Check**: Re-read `reviewTarget`; if `sha256` changed while Reviewer/Supervisor ran, discard and return `REWORK` (no `PASS`).
5. **Transition Rules**:
   - `comparison.verdict === 'NEEDS_HUMAN'` (any round, including Round 1) → `HUMAN_REQUIRED` with `humanQuestions`.
   - `blockingFindings.length > 0` (regardless of `ALIGNED`/`MINOR_DIFF`/`MAJOR_DIFF`) → `REWORK` (does **not** increment `exchangeCount`, so defect fixes do not consume the 2-exchange budget).
   - `comparison.verdict === 'MAJOR_DIFF'` and `blockingFindings.length === 0`:
     - If `exchangeCount < 2`: increment `exchangeCount` (`0→1` or `1→2`), persist `reviewerProposals` + `workerSummary`, return `REWORK` containing Reviewer's proposals for the Worker.
     - If `exchangeCount >= 2`: return `HUMAN_REQUIRED` (2 exchanges exhausted; still major divergence).
   - `comparison.verdict` in `['ALIGNED', 'MINOR_DIFF']` and `blockingFindings.length === 0`:
     - Require non-empty `designPassComment`; append/verify exact `designSha256: <hex>` on the returned comment so Worker posts it verbatim.
     - Persist `loopState.designReview` and transition to `PASS`.

### 5.3 Observability & Worker Policy (D12, D13, A10, A11)
- **`statusLine`**: Computed deterministically for both `reviewloop_begin` and `reviewloop_review`:
  - Begin: `[ReviewLoop | ${taskType} | 启动] loopId=${loopId}`
  - Review: `[ReviewLoop | ${taskType} | 第 ${round} 轮 → ${status}] loopId=${loopId}`
- **`notifications/progress`**: Forward `onHeartbeat` from `controller.review()` into `reviewInner()` and invoke at stage transitions (`collecting_context`, `reviewer_proposing`, `supervisor_adjudicating`, `gate_running`).
- **`agent-policy/COMMON.md` (<= 3400 bytes)**:
  - Replace the `<=5 plain lines` design-pass comment rule with posting Supervisor's `designPassComment` verbatim.
  - Require Worker replies to surface `statusLine` to the user.
  - Trim redundant phrasing so `COMMON.md` stays comfortably under `3400` bytes; update `tests/reviewLoopContextFootprint.test.js` cap from `3300` to `3400`.

---

## 6. Invariants & Failure Modes
1. **I1 (Round-1 Isolation)**: In `design-two-stage` Round 1, `reviewTarget` path/content is never passed to Reviewer. Verified by unit test inspecting Reviewer prompt inputs.
2. **I2 (Fail-Closed Adjudication)**: Invalid Supervisor JSON, missing `designPassComment` on `PASS`, provider failure, or budget/quota denial never produces `PASS`.
3. **I3 (`code` & Legacy Isolation)**: `reviewMode === 'code'` and `'design-legacy'` never enter `designTwoStage.js`. Verified by existing test suite + new isolation test.
4. **I4 (Exchange Bound)**: `exchangeCount` never exceeds 2; a 3rd `MAJOR_DIFF` always yields `HUMAN_REQUIRED`.
5. **I5 (Call Cap)**: Each `design-two-stage` round issues at most 2 Reviewer logical calls (1 optional file-request + 1 proposal) + 1 Supervisor logical call (3 total).

---

## 7. Work Contract (for Code Phase)
1. **Scope**: Implement `reviewMode` dispatch (`code` / `design-legacy` / `design-two-stage`), bounded read-only codebase context collector (excluding `reviewTarget`), two-stage Reviewer proposal + Supervisor adjudication prompts/schemas/transitions, `statusLine` + `onHeartbeat` progress wiring, `COMMON.md` update (`<= 3400` bytes), MCP schema updates, and `docs/ARCHITECTURE.md` + workflow doc updates.
2. **Global AC**: Satisfy Plan A1–A11; `npm test` (all deterministic tests) passes 100%; post-implementation run of U1/U2 live checks with real AGY providers (including an intentionally flawed design) confirms schema stability.
3. **Implementation Order**:
   - Phase 1: `objective.js` / `state.js` (`reviewMode` + migration) & `onHeartbeat` forwarding + `statusLine` helper.
   - Phase 2: `designTwoStage.js` (context collector excluding `reviewTarget`, Reviewer proposal + Supervisor adjudication schemas/prompts, 2-exchange state machine) + `controller.js` / `providerWiring.js` wiring.
   - Phase 3: `reviewloopMcpServer.js` output schema (`statusLine`, `designPassComment`, `planConcern`, `humanQuestions`), `COMMON.md` (`<= 3400B`), `docs/ARCHITECTURE.md`, and comprehensive unit/regression tests.
4. **Stop Conditions**: Stop and report if live U1/U2 checks show Gemini 4 Hydrogen medium or AGY Opus cannot reliably produce the structured outputs, or if any existing `code` test regresses.
