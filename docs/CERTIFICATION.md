# ReviewLoop certification records

Moved from the README. Each entry covers one implementation snapshot; read them
separately, not as a running total.

Three distinct certification events on `v2-routing`. They are **not**
interchangeable — each covers a different implementation snapshot and a
different part of the engine; read them separately, not as one running total.

### 1. Historical LOCAL real-provider certification — `ce02f1e`

Certified implementation snapshot: **`ce02f1e83276d7349ac6dfec332f75c7b972fd32`**
— the frozen implementation head this certification was run against.

- Deterministic bar at `ce02f1e`: **PASS** — `npm test` **573/573**,
  `npm run doctor` PASS, `npm run benchmark:transports` PASS (0 real spawns),
  `git diff --check` clean.
- A full `reviewloop_begin` → Gate → Reviewer → verdict loop was carried to a
  controller **PASS** over the `ce02f1e` snapshot against the byte-exact
  frozen delta `bb0c36e → ce02f1e`: Reviewer **`agy:opus`** (first choice),
  live-resolved model `claude-opus-4-6-thinking`, quota pool
  `agy-claude-gpt`; Supervisor first choice `agy:gemini-supervisor` not
  invoked (converged round 1); 1 physical Reviewer call, 0 Supervisor calls;
  `usageVolume` **8960**; AGY isolation / effective-loading verification
  **PASS**; no blocking P1/P2 findings.
- Scope: **LOCAL mode only**, first-choice Reviewer only. Does not cover PR
  mode or multi-provider failover.

### 2. PR-target real-provider certification — PR #5

Implementation freeze: **`787a4070336d9839590d437ce95ec8a898519d11`**.
Certification PR: **#5**, reviewed head
**`755c1e53cdcf113e2c85aa901e4e43ed21836d1d`**.

- Physical Reviewer: **`codex:default`**. 1 Reviewer call, 0 Supervisor calls.
- Controller verdict: **PASS**, round 1, "no P1/P2 findings".
- `usageVolume` **16759**, `contextOverheadTokens` **16460** — Token Sentinel
  **not tripped** (threshold 40000 single-call / 30000 context-overhead).
- Exercises the real PR-target production path end to end: repository
  identity, exact base/head SHA binding, Gate on the exact reviewed HEAD, one
  real Reviewer call.

### 3. Final routing-hardening implementation — `928f79f`

Implementation head: **`928f79fdbc342ad1ca0f22f2357c4ed78dc88a6e`**.

- Deterministic local suite / `npm run doctor` / `npm run benchmark:transports`:
  **PASS**.
- Independent manual GitHub code review: **PASS**.
- **No extra real-provider certification was performed against this head.**
  One real-provider certification attempt over the routing-hardening change
  hit the post-settlement Token Sentinel (a `codex:default` Reviewer call,
  `usageVolume` 79256 / `contextOverheadTokens` 69297, both over threshold) —
  this is a **safety trip, not a code finding**: the anomalous call was fully
  accounted, the loop latched to `HUMAN_REQUIRED`, and no further automatic
  provider spend occurred. The Sentinel thresholds were **not** raised or
  bypassed to get past it.

`claude:opus` uses the stable provider alias `opus`; `codex:default` follows
the provider default. No concrete release is pinned by default.

Historical SuperGPT V1/V2 measured numbers are labelled historical in
`docs/history/` and are not ReviewLoop certification.
