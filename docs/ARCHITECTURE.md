# ReviewLoop architecture

ReviewLoop current source of truth.

Worker owns execution.
ReviewLoop owns independent verification and repair control.

## Ownership

| concern | owner |
|---|---|
| implement / test / lint / build / debug / commit / push | **Worker** (external coding agent) |
| immutable review objective + baseline / PR-HEAD identity | ReviewLoop |
| deterministic Gate (0 model tokens) | ReviewLoop |
| independent Reviewer (same engine for LOCAL and PR targets) | ReviewLoop |
| review normalization + finding signatures | ReviewLoop |
| convergence / non-convergence policy | ReviewLoop |
| Supervisor exception guidance | ReviewLoop |
| durable loop state / resume | ReviewLoop |
| ReviewLoop's own token safety (Reviewer + Supervisor spend) | ReviewLoop |

ReviewLoop cannot autonomously: rewrite files, execute repair code, commit,
push, force-push, merge, weaken the objective, or spend models without fresh
evidence.

## Modules

```
src/reviewloop/
  objective.js          immutable ReviewObjective (fingerprinted, never weakened)
  state.js              durable loop state + deterministic state machine
  gitEvidence.js        pre-Worker baseline (git stash create) + exact Worker-delta attribution
  gatePolicy.js         verification discovery + deterministic Gate + baseline-diff
  diffChunker.js        deterministic diff chunking (no silent truncation)
  reviewPolicy.js       review normalization + convergence policy
  reviewSpend.js        DURABLE ReviewLoop-scoped Token Safety (Reviewer + Supervisor)
  prEvidence.js         PR merge-base->HEAD delta via LOCAL git over explicit fetched SHAs (LOCAL-delta-shaped; fails closed; never a live API call)
  prWorktree.js         isolated disposable `git worktree` at the exact PR HEAD — Gate + evidence identity both run inside it
  prIdentity.js         cwd repository == PR repository, proven independently of `gh`/env, fail closed
  githubBackend.js      slim PR-target transport via the `gh` CLI (repo id, base/HEAD SHA, optional result publication — never a reviewer, never PR diff evidence)
  providerWiring.js     production Reviewer/Supervisor pool (RoleRouter) + PR backend
  adapters/
    scratchCwd.js          shared isolated empty scratch cwd for every narrow transport
    boundedCli.js          bounded argv-only CLI runner (wall-clock timeout, process-group teardown)
    cliReviewTransports.js  narrow single-turn codex / claude Reviewer+Supervisor transports
    minimalAgyAgent.js      deterministic provisioning of the `reviewloop-minimal` AGY custom agent (inheritCustomizations:false) into the isolated gemini dir
    agyCustomAgentCapability.js  startup capability probe + per-call effective-loading verification (agy must actually LOAD reviewloop-minimal, not silently fall back)
  controller.js         reviewloop_begin + reviewloop_review
  runtimeDir.js         ~/.reviewloop

src/mcp/reviewloopMcpServer.js   exactly 2 Worker-facing tools
```

Preserved generic primitives: `ModelSpendAuthority`, `ReservationLedger`,
`NewInformationLedger`, provider health/quota routing (`roleRouting.js`), Git
evidence collector, normalized review, `baselineDiffGate`,
`gateFailureIdentity`, process-tree cleanup.

## Phase-aware task lifecycle

A ReviewLoop session may carry an optional frozen ordered phase plan. This does
**not** add Planner/Executor roles and does not create nested ReviewLoop
sessions. The invariant is:

```
one user task
= one loopId
= one immutable task objective
= one original baseline
= N phase gates + one final whole-task gate
```

Each phase gate runs the same engine: deterministic Gate (zero model tokens) →
independent Reviewer → same-session Worker repair → exception-only Supervisor
on non-convergence. A clean phase returns `PHASE_PASS`, advances the durable
`currentPhaseIndex`, clears only gate-local convergence state, and returns the
loop to `READY_FOR_WORK`. It is non-terminal. After the last phase,
`currentPhaseIndex === phases.length` denotes the final whole-task gate; only
a clean final gate transitions to terminal `PASS`.

The task-global `round` remains monotonic for audit / operation identity.
`gateRound` is the convergence counter and resets on PHASE_PASS. Likewise,
finding-signature history, Supervisor-invoked state and Gate-repair count are
gate-local. The original baseline, immutable objective, durable spend,
reservation/information ledgers, provider health/accounting and Token Sentinel
never reset at a phase boundary.

The optional phase plan is fingerprinted into the immutable
`ReviewObjective`. Phase ids/order/objectives/exit criteria/invariants may not
be edited after `reviewloop_begin`. Phase-specific exact verification commands,
when provided, are frozen in the phase plan and are appended to the ordinary
deterministic Gate for that phase. They are phase-local: the final whole-task
gate runs the ordinary frozen global Gate plan, because a later phase may
legitimately replace an intermediate implementation. Top-level
`reviewloop_begin.verificationCommands` are the explicit whole-task mechanical
plan and therefore remain active through the final gate. Requirements that must
survive later phases belong in carry-forward invariants (Reviewer scope) or that
global verification plan (mechanical Gate).

A persisted `completedPhases` prefix is not trusted merely because its ids and
index line up. Every completion carries a chained PHASE_PASS evidence hash bound
to the immutable objective, exact review-scope fingerprint, deterministic Gate
fingerprint and Reviewer fingerprint. In PR mode the completion must additionally
match a durable PHASE_PASS audit record whose exact-HEAD checks succeeded
(`headStillCurrent` and `gateRanOnReviewedHead`). Missing, fabricated or
corrupted progression therefore fails closed before the next gate can run.

Reviewer/Supervisor prompts receive an explicit current review scope. During a
phase they judge only that phase's exit criteria plus global constraints and
already-established invariants; unfinished later-phase work is not a blocker.
The final gate judges the cumulative diff against the complete task and all
phase contracts.

## One review engine, two targets

There is a single review path. `reviewloop_review` attributes evidence, runs
the deterministic Gate, routes an independent Reviewer over the full evidence
(bounded or chunked), applies the convergence policy, and — only on
non-convergence — the Supervisor.

| target | evidence | Gate cwd | HEAD binding |
|--------|----------|----------|--------------|
| LOCAL  | `reviewloop_begin` baseline → current Worker delta | the user's own worktree | n/a |
| PR     | `merge-base(prBaseSha, observedHead) .. observedHead` via LOCAL `git diff` | an isolated disposable `git worktree` checked out DETACHED at `observedHead` (prWorktree.js) | live PR HEAD re-read every round; a pre-`PASS` recheck refuses to certify a stale review if the HEAD moved |

For a PR target, the Reviewer's diff identity, the deterministic Gate, and the
verification-manifest drift check ALL run inside the SAME isolated worktree —
never the user's ambient cwd (which may be on another branch, dirty, or
unrelated to the PR). The worktree is built fresh each round at the round's
`observedHead`, torn down (success or failure) before the round's Reviewer
call, and never commits, pushes, or mutates the user's own branches. Before a
PR loop is even registered, `reviewloop_begin` PROVES cwd's own repository
(from its literal `origin` remote, independent of any `gh`/env override) is
the exact repository the PR belongs to (prIdentity.js) — never best-effort
metadata; an unresolvable or mismatched identity refuses the begin.

A PR round writes a durable, tamper-evident audit record to loop state
(`loopState.audit[]`): the frozen target identity (repository, prNumber,
baseSha, reviewedHeadSha, mergeBase) + a `targetFingerprint` over it, the
objective fingerprint, the Gate verdict/fingerprint (plus a structural
`gateRanOnReviewedHead` flag proving the Gate ran in the exact-HEAD
worktree), the Reviewer verdict/findings, and — for every PHYSICAL Reviewer
and Supervisor call this round made (including every failover retry and every
chunk) — its role, family, provider, quota pool, resolved model, attempt,
round, chunk index/total, outcome, and raw usage. A failover or chunked round
never collapses to one abstract "internal" entry. The record also carries the
Supervisor state, the spend telemetry, and the round result. The objective
fingerprint itself folds in `prBaseSha` and `reviewedHeadSha`, so editing
persisted PR identity fails the integrity check. `reviewloop_review` never
PASSes a PR round unless it can positively prove: repository identity is
known, the Reviewer's evidence is bound to the exact reviewed HEAD, the Gate
ran inside that exact HEAD's worktree, AND the live PR HEAD re-read just
before certifying still matches — any one of those being unknown refuses PASS.

## Active model roles

Exactly `reviewer` and `supervisor` (`DEFAULT_ROLE_POLICY`). No `planner`, no
`executor`. The Worker is outside role routing entirely.

## Reviewer / Supervisor transports

Both roles are NARROW, stateless, single-turn inference — never a second
coding Worker. Every transport (agy, `codex`, `claude`) runs from one shared
isolated empty scratch cwd (`adapters/scratchCwd.js`): no repo, no
`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`, no project or agent memory to
preload. The `codex` / `claude` transports additionally disable user config,
project rules and MCP servers, run read-only with no tool use, and never
resume a conversation; each is bounded by a wall-clock timeout with
whole-process-tree teardown (`adapters/boundedCli.js`). Output goes through
the SAME strict normalization as agy — a malformed Reviewer result →
`HUMAN_REQUIRED`, never a clean empty result (a malformed Supervisor result is
a transient failure — see Convergence). One physical attempt per call; bounded
failover lives in the controller, not in the transport.

### Per-family context isolation (what each CLI can and cannot narrow)

All argv below is verified against the installed CLIs' own `--help`; the
`benchmark:transports` harness pins the narrow-flag set mechanically.

| Family | Per-call narrowing available | Not closable per call | Measured live tax |
| --- | --- | --- | --- |
| `claude:opus` | `--setting-sources ''` (no user/project/local settings → no hooks, custom agents, output styles, statusline), `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (no MCP), `--tools ''` (no built-in tools/schemas), `--disable-slash-commands` (no skills), `--no-session-persistence` (no resume/write), `--exclude-dynamic-system-prompt-sections`, scratch cwd | admin/managed (policy) settings; the built-in `claude -p` base system prompt (zeroing it needs `--system-prompt`, which also kills the dynamic-section trim). `--bare` would remove more but forces API-key-only auth. | live-certified: Reviewer usageVolume 3449, Supervisor 3741 (resolvedModel `opus`) |
| `codex:default` | `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only`, scratch cwd | the `codex exec` harness system prompt + built-in tool schemas (apply_patch/shell) — no flag lever | live-certified: Reviewer usageVolume 16535, Supervisor 16899 (the `codex exec` harness prompt dominates) |
| `agy:gpt-oss` | `--agent reviewloop-minimal` (`inheritCustomizations: false`) discovered from an isolated **redirected gemini dir** (`--gemini_dir`, `adapters/scratchCwd.js#narrowAgyGeminiDir`), `--disable-slash-commands`, scratch cwd | the `agy` base agent/system prompt and built-in tool schemas — no flag lever; admin/managed config | live-certified Reviewer: usageVolume 2427, resolvedModel `gpt-oss-120b-medium`, isolationVerified |
| `agy:gemini-reviewer` | same as `agy:gpt-oss` (fixed effort **low** → catalog resolves `gemini-*-low`) | same as `agy:gpt-oss` | Reviewer head; shares the `agy-gemini` quota pool with `agy:gemini-supervisor` |
| `agy:gemini-supervisor` | same as `agy:gpt-oss` (fixed effort **medium** → catalog resolves `gemini-*-medium`, currently `gemini-3.8-flash-medium`) | same as `agy:gpt-oss` | **definitive isolated-agent live result**: Supervisor usageVolume 2933, resolvedModel `gemini-3.8-flash-medium`, effectiveLoadingVerified + isolationVerified |
| `agy:sonnet` | same as `agy:gpt-oss` (AGY-hosted Claude Sonnet; `catalogPrefix: 'claude-sonnet-'` → newest catalog Sonnet, currently `claude-sonnet-4-6`) | same as `agy:gpt-oss` | live-certified: Reviewer usageVolume 3191, Supervisor 3303, resolvedModel `claude-sonnet-4-6`, isolationVerified |
| `agy:opus` | same as `agy:gpt-oss` (AGY-hosted Claude Opus; `catalogPrefix: 'claude-opus-'` → newest catalog Opus, currently `claude-opus-4-6-thinking`, resolved dynamically at pool construction — never a long-term version pin) | same as `agy:gpt-oss` | **Reviewer role only** — Reviewer first choice. LOCAL controller-level live cert: Reviewer usageVolume 8960, resolvedModel `claude-opus-4-6-thinking`, effectiveLoadingVerified + isolationVerified, controller verdict PASS. Shares the `agy-claude-gpt` quota pool with `agy:sonnet` + `agy:gpt-oss` |

**AGY minimal-agent transport — effective loading**:
ReviewLoop runs every AGY family through the `reviewloop-minimal` agent
(`inheritCustomizations: false`) instead of AGY's ambient/default agent. The
agent lives at `<isolated gemini dir>/config/agents/reviewloop-minimal/agent.md`
and is reached with `--gemini_dir` — **not** a workspace `.agents/` path.

Why the redirected gemini dir: agy does **not** reliably discover a custom
agent from a workspace `.agents/agents/<name>/agent.md`. An unresolvable
`--agent` **silently falls back to the default agent** (`session.go:81 Agent
"…" not found, falling back to default`), so a file merely existing on disk
proves nothing. agy *does* discover agents from its gemini-dir config tree. The
real `~/.gemini` is off-limits (user data + daily `agy`), so the transport:

- provisions the agent at
  `<geminiDir>/config/agents/reviewloop-minimal/agent.md` in an **isolated
  redirected gemini dir** (`narrowAgyGeminiDir()`), and points agy at it with
  the `--gemini_dir=<dir>` flag. That flag is **not** in `agy --help` for
  1.1.27, so it is never assumed: `detectAgyCustomAgentSupport()` runs a
  zero-model-turn probe at MCP startup (stream-json, stdin closed → agy emits
  `init` and exits) and only enables the AGY families if the agy log confirms
  `Starting new conversation (agent=true)`. A build that rejects `--gemini_dir`,
  or that still falls back, → AGY families **UNAVAILABLE** (fail closed).
- verifies **per call**: the transport captures the agy `--log-file` and
  raises `AGY_ISOLATION_UNVERIFIED` (and fences off all AGY families so bounded
  failover routes away) if that call did not activate the custom agent. The
  default-agent reply is never returned as a usable result.
- auth is unaffected — agy authenticates via the OS keyring, not the gemini
  dir — and agy's own logs/cache now land in the isolated dir instead of
  polluting `~/.gemini`. Plain `agy` in a terminal is untouched.

If provisioning fails, the AGY families are marked **UNAVAILABLE** — ReviewLoop
never silently falls back to the default AGY agent.

Historical AGY token figures are **not** a baseline:

- the earlier ~40k `gemini-*` Supervisor call had a valid controller/provider
  path but isolation did **not** take effect — it silently ran the default
  agent — so it is not a minimal-agent cost baseline;
- the still-earlier ~6.7k "minimal" smoke was taken before effective loading
  was verified, so it is not a trusted isolation baseline either.

The definitive isolated-agent live results are the `agy:gemini-supervisor`
medium Supervisor (**usageVolume 2933, effectiveLoadingVerified**) and the
`agy:opus` Reviewer carried to a controller-level `PASS` in LOCAL mode
(**usageVolume 8960, resolvedModel `claude-opus-4-6-thinking`,
effectiveLoadingVerified + isolationVerified**, against the certified
implementation snapshot `ce02f1e` and the frozen delta `bb0c36e → ce02f1e`).
The live certification
(`scripts/live-reviewloop-certify.mjs`) asserts `customAgentSupport.supported`
plus per-call effective-loading verification and reports the real numbers.

### Final fixed routing (deterministic — NO risk-based selection)

`DEFAULT_ROLE_POLICY` is a fixed ordered list per role. There is no diff-size,
filename, or keyword heuristic and no risk classifier — automatic failover
simply walks the list in order.

| Order | Reviewer | Supervisor |
| --- | --- | --- |
| 1 | `agy:opus` (AGY Claude Opus, `agy-claude-gpt` pool) | `agy:gemini-supervisor` (effort **medium**, `agy-gemini` pool) |
| 2 | `agy:gemini-reviewer` (effort **low**) | `codex:default` |
| 3 | `codex:default` | `agy:sonnet` |
| 4 | `agy:sonnet` | `claude:opus` |
| 5 | `agy:gpt-oss` | — |
| 6 | `claude:opus` | — |

Normal production path: Worker = Claude (external), Reviewer = AGY Claude Opus
(`agy:opus`), Supervisor = AGY Gemini at **medium** effort. The two role
primaries deliberately sit in **different quota pools** — the Reviewer's
`agy:opus` in `agy-claude-gpt`, the Supervisor's `agy:gemini-supervisor` in
`agy-gemini` — so a quota cooldown on one role's first choice never silently
disables the other role's first choice. `agy:opus` is enabled for the Reviewer
role only; the Supervisor pool is unchanged. It resolves its concrete Opus
model dynamically from the AGY runtime catalog (`catalogPrefix: 'claude-opus-'`)
and reuses the same `reviewloop-minimal` isolation / token accounting /
ModelSpendAuthority / sentinel / bounded-failover path as every other AGY
family. The two Gemini heads remain distinct role-scoped family identities
(`agy:gemini-reviewer` / `agy:gemini-supervisor`), each locked to one role and
one effort, sharing the single `agy-gemini` quota pool. GPT-OSS is a deliberate
low-cost Reviewer fallback (not degraded).

**`agy:gpt-oss` is NOT a Supervisor candidate.** Its live Supervisor
certification succeeded on transport, token accounting and agent isolation, but
its decision output violated the Supervisor decision schema (it returned
`recommendation = "REWORK|HUMAN_REQUIRED"` where the schema permits exactly one
of `"REWORK"` or `"HUMAN_REQUIRED"`). The Supervisor parser is deliberately not
loosened; `agy:gpt-oss` was removed from the Supervisor production pool instead.
Its family / transport / accounting support is unchanged and it remains a
Reviewer candidate. `PRODUCTION_ROLE_CAPABILITIES['agy:gpt-oss']` is therefore
`['reviewer']`.

No production family is `highContext`: every AGY family (`agy:gemini-reviewer`,
`agy:gemini-supervisor`, `agy:opus`, `agy:gpt-oss`, `agy:sonnet`) runs through the isolated
`reviewloop-minimal` agent, and the definitive `agy:gemini-supervisor` result
(usageVolume 2933) is in line with the other families, so the Gemini heads
participate in ordinary automatic routing — they are **not** excluded on a
high-context basis. The generic
`RoleRouter` `highContext` mechanism (a candidate so marked is skipped unless
`signals.allowHighContext === true`) is retained for any future family that
needs it, but nothing sets the flag today.

### Shared quota topology

```
agy:opus               ─┐
agy:sonnet             ─┼─ agy-claude-gpt  (one AGY "Claude & GPT" quota pool)
agy:gpt-oss            ─┘
agy:gemini-reviewer    ─┐
                        ├─ agy-gemini      (one separate Gemini quota pool —
agy:gemini-supervisor  ─┘                   both role heads share its cooldown)
codex:default          ── codex
claude:opus            ── claude
```

The Reviewer first choice (`agy:opus`, `agy-claude-gpt`) and the Supervisor
first choice (`agy:gemini-supervisor`, `agy-gemini`) are in different pools by
design: a cooldown on one role's primary pool leaves the other role's primary
routable.

A `PROVIDER_QUOTA_EXHAUSTED` / `PROVIDER_RATE_LIMITED` cooldown on any one of
`agy:opus` / `agy:sonnet` / `agy:gpt-oss` puts `agy-claude-gpt` into cooldown,
so the other two are skipped at route time — no wasted physical call to confirm
the same pool is empty. A model-specific health failure that is NOT a quota
failure leaves the shared pool healthy and the siblings still selectable;
family health and
shared-pool health stay independent.

### Automatic failover (the user does not participate)

Any of the following, when the existing spend-safety semantics allow it,
automatically advances to the next candidate — up to one attempt per unique
candidate, then the pool is exhausted and the loop stops (never an infinite
retry; the `tried` set + a null route both stop it early):

- quota exhausted / rate limited
- pre-send CLI unavailable / executable missing / local auth unavailable
- mechanically pre-send spawn failure
- provider family health unavailable
- known-settled retryable provider/protocol failure

The effective attempt bound is the role's own candidate count
(`providerAttemptBudget(role)` in `controller.js`), replacing the old
hard-coded `MAX_PROVIDER_ATTEMPTS = 3` which could leave the 4th Reviewer /
Supervisor candidate permanently unreachable. `MAX_SUPERVISOR_CALLS` tracks the
Supervisor pool size (**4**) so one supervised round can traverse the whole
pool. A `PROVIDER_ATTEMPT_HARD_CEILING` (16) remains purely as a runaway guard.

**The one spend-safety stop that is NOT a failover:** if a physical call was
already dispatched and its usage cannot be reliably settled
(`MODEL_SPEND_USAGE_UNRESOLVED`), UNKNOWN ≠ ZERO — ReviewLoop fails closed to a
deterministic terminal and does NOT burn another provider "to be safe". This is
a safety stop, not an interactive prompt.

### Pool-completeness invariant

`tests/reviewLoopFinalRoutingPool.test.js` mechanically asserts, with zero
provider calls, that every `DEFAULT_ROLE_POLICY` candidate is: in
`MODEL_FAMILY_REGISTRY`, role-declared in `PRODUCTION_ROLE_CAPABILITIES`, has a
quota topology, a provider-capability record, a known accounting class, a wired
transport, a reported runtime status, and (AGY families) runs
`--agent reviewloop-minimal`. Plus full ordered traversal at both `route()` and
controller (`meteredWithFailover`) level, including the no-skip regression for
the retired attempt cap and the shared-quota sibling skip.

**Claude `PROVIDER_PROTOCOL_ERROR` root cause (fixed 2026-09-07)**: the
transport passed `--mcp-config '{}'`. The installed CLI (2.1.x) validates the
value as an object that MUST carry an `mcpServers` key and rejects a bare
`{}` with `Invalid MCP configuration: mcpServers: Invalid input`, exiting 1 in
~0.5s — before any model dispatch, which is why the failure looked like a
protocol error rather than an auth or inference failure. The value is now
`'{"mcpServers":{}}'`.

**Dynamic model-family resolution** preserves family semantics without
concrete release pins. `agy:gemini-reviewer` / `agy:gemini-supervisor` /
`agy:gpt-oss` / `agy:sonnet` / `agy:opus` resolve from the probed `agy models`
catalog when available (by `catalogPrefix`: `gemini-` / `gemini-` / `gpt-oss-` /
`claude-sonnet-` / `claude-opus-`, honouring the family's `defaultEffort` —
`agy:gemini-reviewer` = `low`, `agy:gemini-supervisor` = `medium`,
`agy:gpt-oss` = `medium`, `agy:sonnet` = none, `agy:opus` = none; when the exact effort variant is
absent, resolution falls back to the newest entry, preferring higher effort on
a version tie). The two Gemini heads are SEPARATE stable family identities, one
per role, so the concrete `-low` / `-medium` id is bound at pool construction
from the family's own effort and can never drift: the id the AGY transport
passes as `--model` is exactly what telemetry persists — a `-low` family never
dispatches a `-medium` model. `codex:default` omits a model flag and
tracks the Codex provider default; `claude:opus` passes the stable Claude CLI
alias `--model opus`, which tracks the current Opus release. Provider-returned
concrete model identity is persisted by telemetry. `doctor` must report
`versionPinnedByDefault=no` for every family.

**Pool composition is honest**: a family is either a WIRED transport that can
actually be selected and called, or explicitly UNAVAILABLE with a recorded
reason. The `codex` / `claude` adapters always exist, but production wires them
only after two zero-model startup checks succeed: `--version` and the local
auth-status command (`codex login status` / `claude auth status`). A missing or
locally unauthenticated CLI is removed from eligibility before any ReviewLoop
model permit is requested; routing can therefore choose the next family with
zero model spend.

**Authentication has two safety boundaries**. Local auth preflight is the only
mechanically pre-dispatch authentication signal. If a prompt-bearing CLI
invocation has already started and then returns a 401/403/authentication-looking
failure, the transport classifies it as `PROVIDER_AUTH_REJECTED`, not as
pre-send zero. Absent reliable provider usage, ModelSpendAuthority settles it
UNRESOLVED and further spend/failover on the same evidence is blocked.
`UNKNOWN != ZERO` wins over convenience.

**Per-loop lease, fail-closed on loss**. Each `reviewloop_review` holds an
in-process chain lock plus a durable cross-process lock file
(`<runtimeRoot>/<loopId>/reviewloop.lock`). Reclaim of a foreign lock is
ownership-preserving: same host → only when the owner pid is gone (a slow-but-
alive owner keeps its lock past the nominal TTL); other host → only when the
TTL, kept fresh by the owner's heartbeat, has expired; a malformed record → an
atomically-guarded reclaim. **Renew is a compare-and-swap on the inode**: the
owner writes renewals only through the descriptor it opened on the lock file it
published, so a renewal issued after a remote contender reclaimed the path lands
on the owner's now-unlinked inode and is invisible — it can never overwrite a
successor lease. If a remote contender does reclaim an apparently-expired lease
mid-review, the displaced owner **fails closed**: `assertLeaseHeld` (a fresh
ownership probe) runs immediately before every paid model dispatch and every
durable ReviewLoop state write, and a lost lease aborts the call read-only
(`WAITING_FOR_REVIEW`) — no further dispatch, no state write; the new owner
reconciles.

### Final routing-hardening invariants (928f79f)

Closing invariant set for `RoleRouter` route selection and its durable audit
trail, landed across `a1cfe2c` (durable route audit, primary-first invariant,
stale-health revalidation) and `928f79f` (reason-scoped stale-health
revalidation, transport gate, per-call audit attribution):

- **`agy:opus` eligible → must be the Reviewer primary selection.** If
  `agy:opus` is not skipped, it is selected; `assertRoutePrimaryFirstInvariant`
  throws (`ROUTE_PRIMARY_NOT_EVALUATED` / `ROUTE_PRIMARY_REASON_NOT_ENUMERATED`
  / `ROUTE_PRIMARY_SKIP_UNPERSISTED`) if a route ever picks a non-primary
  candidate without the primary having been evaluated and durably skipped for
  an enumerated reason first.
- **Every pre-dispatch skip records a durable, enumerated reason before route
  moves to the next candidate** — one of `ROUTE_SKIP_REASONS` (capability,
  high-context, quota cooldown, provider health, `no_transport`, …); an
  unenumerated or unpersisted skip reason fails the invariant rather than
  silently falling through.
- **An unpersisted or unknown routing decision fails closed** — a skip whose
  audit write did not durably persist is treated as if the primary was never
  properly evaluated, never as an implicit pass-through.
- **No wired transport → `no_transport`, never selectable.** A candidate whose
  `resolved.transportAvailable === false` is skipped with `NO_TRANSPORT` and
  can never be chosen regardless of health/quota state.
- **Stale health is cleared only by a zero-token probe that proves that
  specific failure class recovered.** Revalidation is reason-scoped: it only
  attempts to clear a health record whose `reasonCode` is
  `AGY_PROVISIONING_FAILED`; every other reasonCode (a post-dispatch
  `PROVIDER_*` failure, or no reasonCode at all) refuses revalidation and
  requires an MCP server restart to clear, never a re-probe on the same
  process.
- **Audit attribution is per loop / round / operation / attempt / chunk.**
  `RouteAuditLog.record` persists `loopId`, `round`, `operationId`, `attempt`,
  `chunkIndex`, `chunkTotal` alongside every route decision, so a failover or
  chunked round never collapses into one abstract entry — each physical
  routing decision is independently attributable in the durable log
  (`~/.reviewloop/route-audit.log` by default).

## State machine

```
READY_FOR_WORK → REVIEWING → PASS
                          ├→ REWORK → REVIEWING
                          ├→ SUPERVISING → REWORK
                          ├→ WAITING_FOR_REVIEW → REVIEWING
                          └→ HUMAN_REQUIRED
```

`WAITING_FOR_REVIEW` is a normal durable state, not an error. It is reached
only transiently — another process holds the loop lease, or (PR target) the PR
HEAD kept moving faster than one review round could complete. Re-call
`reviewloop_review` once state settles.

### PR HEAD binding

Each PR round re-reads the live PR HEAD (`gh pr view … headRefOid`), fails
closed if it cannot be resolved, and builds an isolated `git worktree`
checked out DETACHED at that exact SHA (prWorktree.js) to compute
`merge-base(objective.prBaseSha, observedHead) .. observedHead` via LOCAL git
diff and to run the deterministic Gate — never a live `gh pr diff` call and
never the user's own ambient cwd. Before a `PASS` the live HEAD is read once
more: only `finalObservedHeadSha === reviewedHeadSha` lets the round PASS,
and an explicit invariant check additionally requires repository identity to
be known, the Reviewer evidence to be bound to `observedHead`, and the Gate
to have run inside that exact HEAD's worktree — any one UNKNOWN refuses PASS.
A HEAD that moved during the review is never certified by the stale review —
the round rebinds and re-reviews the new HEAD (bounded; a HEAD that never
settles → `WAITING_FOR_REVIEW`). `PUSH_REQUIRED` is returned when the HEAD is
unchanged since a prior actionable review (fix not pushed yet).

## Convergence

Default: `blockingSeverities = [P1, P2]`, `maxReviewRounds = 3`.

- Round 1: Gate → Reviewer. P1/P2 → direct REWORK (Supervisor calls = 0).
- Round 2: same blocking finding survives a genuine changed diff → Supervisor
  **exactly once** → guidance → REWORK.
- Round 3: P1/P2 still present → HUMAN_REQUIRED.
- Any round with no P1 and no P2 → PASS. Waiting never consumes a round.
- Identical evidence resubmitted → deterministic `NO_PROGRESS`, no model call.

Only a Supervisor that actually adjudicates the loop non-convergent
(`recommendation = "HUMAN_REQUIRED"`) ends it — that HUMAN_REQUIRED is terminal
(`budgetExhausted`). A *degradable transient* Supervisor failure — caller
cancelled before dispatch, provider pool exhausted with settled accounting,
output unusable but the call settled — is never valid guidance and never
terminal: the round degrades to a plain REWORK
(`REVIEWLOOP_SUPERVISOR_UNAVAILABLE` non-blocking safety event,
`supervisorInvoked` reset so a later persistent round can retry). The
`maxReviewRounds` cap remains the stagnation circuit-breaker regardless. The one
exception is the same spend-safety stop as everywhere else: a Supervisor call
that was dispatched but whose usage cannot be settled
(`MODEL_SPEND_USAGE_UNRESOLVED`, UNKNOWN ≠ ZERO) fails closed to a
non-terminal `HUMAN_REQUIRED` and does not degrade.

The zero-provider `benchmark:transports` harness mechanically covers the
controller paths E2E-A (one-round PASS), E2E-B (REWORK → changed implementation
→ PASS), and E2E-C (persistent blocker after changed implementation →
Supervisor exactly once → REWORK), in addition to CLI transport narrowness.

## Token Safety

`UNKNOWN != ZERO`. `CallIntent → authorize → PhysicalCallPermit → dispatch →
SETTLED_KNOWN | UNRESOLVED`. Scoped to ReviewLoop-owned spend (Reviewer,
Supervisor) for every target — LOCAL and PR alike. Worker usage is reported as
`external / not observable by ReviewLoop` — never as zero.

Limits (`REVIEWLOOP_*`): `MAX_COST_USD`, `MAX_USAGE_VOLUME`,
`MAX_REVIEW_ROUNDS`, `MAX_REVIEWER_CALLS`, `MAX_SUPERVISOR_CALLS`,
`MAX_REVIEW_DIFF_CHARS`, `MAX_REVIEW_CHUNKS`, `MAX_SINGLE_CALL_USAGE`,
`MAX_CONTEXT_OVERHEAD_TOKENS` (single-call Token Sentinel — see below).

The aggregate budget (call counts, `usageVolume`, `costUsd`) is **durable** and
keyed by `loopId`: it accumulates across every `reviewloop_review` round, the
Supervisor call, and a process restart. A crash after provider settlement
cannot reset it — the reservation ledger is cross-checked on load and any
settled/blocking metered reservation with no matching spend record is counted
conservatively (call counted, usage UNKNOWN, never zero).

### Single-call Token Sentinel (post-settlement circuit breaker)

The aggregate ceilings only fire once the *running total* crosses the line, so
one call that suddenly balloons (running total 10k → a single 150k call) has
already spent the 150k before the aggregate blocks the *next* call. The Token
Sentinel closes that gap. It is **post-settlement**: it cannot un-spend the
anomalous call — its job is *anomalous call → precise accounting → explicit
alarm → durable block → no more automatic burn*.

After a physical Reviewer/Supervisor call whose usage settled **reliably**
(`volumeResolved === true` — an UNKNOWN/unresolved call keeps the existing
UNRESOLVED fail-closed path and is never guessed at), the Sentinel trips when
either:

- `usageVolume > REVIEWLOOP_MAX_SINGLE_CALL_USAGE` (default **40 000**), or
- a *known* `contextOverheadTokens > REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS`
  (default **30 000**).

Both are env-overridable but clamped to `(0, hard-cap]`
(`TOKEN_SENTINEL_HARD_CAPS` — 250 000 / 200 000): an illegal value (non-finite,
`≤ 0`, unparseable) falls back to the default and can never *disable* the
protection, and no value can inflate the ceiling to infinity.

On a trip:

1. the anomalous call's real usage is **fully, durably accounted first** (never
   treated as 0);
2. a **BLOCKING** `MODEL_SPEND_TOKEN_ANOMALY` safety event is recorded (role,
   family/provider, `resolvedModel`, `usageVolume`, `contextOverheadTokens`,
   configured threshold, reason, `actionTaken`);
3. the anomaly is **durably latched** for the loop
   (`reviewLoopTokenAnomaly` in workflow state);
4. `meteredCall` throws `MODEL_SPEND_TOKEN_ANOMALY_BLOCKED` (an
   `AuthorizationError`) — every further Reviewer/Supervisor model call in the
   loop is refused at the **authorization stage**, and the latch is re-read
   from durable state so the block **survives a process restart**.

It is an orchestrator safety stop, never provider failure: **no auto-failover**
to the next candidate, **no** provider health/quota mutation, and it is never
disguised as a provider health failure. Clearing it requires a human.

**`usageVolume` is provider/family-aware** (`usageAccountingOf({ usage, family,
provider })`, keyed off the actual family/provider bound into the CallIntent —
never guessed from a model name). Cached tokens must not be double-counted into
this hard ceiling:

| Class | Method | Rule |
| --- | --- | --- |
| any (confirmed total field only) | `provider_total` | an authoritative provider-reported total wins verbatim — trusted **only** from a token-total field mechanically confirmed for that class (`AUTHORITATIVE_TOTAL_ALIASES`: `openai` → `total_tokens`; `anthropic` → *none*, the Messages API returns no aggregate total; `agy` → `total_tokens`/`totalTokenCount`). A bare `total`, or any total on an unknown provider, is never trusted. AGY Gemini live: reported total 7252, cache-read 8128 not added |
| `openai` (`codex:default`) | `openai_input_plus_output` | `cache_read ⊂ input`, reasoning `⊂ output` — add neither (Codex live: input 16922 incl. 10624 cache-read, output 9 → volume **16931**, not 27555) |
| `anthropic` (`claude:opus`) | `anthropic_cache_additive` | `input + output + cache_creation + cache_read` — the two cache categories are separate billing lines, never dropped (live: 2 + 1549 + 2168 + 1285 → **5004**). Absent `cache_*` is a schema-defined 0; absent `input`/`output` is not |
| `agy` w/o confirmed total, or unknown provider | `conservative_additive_unknown` | sum every reported field, **flagged `semanticsKnown:false`** — UNKNOWN != ZERO: never under-count a safety ceiling, never present the number as an exact provider figure |

**Partial usage fails closed.** A fallback method reports `semanticsKnown:true`
/ `volumeResolved:true` **only** when every field it mechanically requires
(`openai`/`anthropic`: `input` + `output`) is actually present. If a
post-dispatch usage object exists but a required field is absent, it is
`volumeResolved:false` and `meteredCall` routes it into the existing
`MODEL_SPEND_USAGE_UNRESOLVED` / `ReservationLedger` UNRESOLVED path — the
reservation latches UNRESOLVED and blocks all further internal model spend for
the loop until a human clears it. Missing fields are never silently read as 0.
(The `agy`/unknown conservative path stays `volumeResolved:true` — a
floor-safe over-count is its accepted posture.)

The raw per-field breakdown (`usageBreakdownOf`) is always preserved for
telemetry regardless of method — `reportedTotalTokens` is strictly a total-ish
field the provider reported (not necessarily the authoritative one for that
family); `rawFieldSumTokens` is a **diagnostic** arithmetic sum, never a
token-accounting total. Every durable spend record carries `usageAccounting:
{ method, semanticsKnown, volumeResolved, accountingClass, reportedTotalTokens }`
provenance; telemetry surfaces `unknownSemanticsCalls`.

**Malformed provider output** (unparseable, no findings channel, invalid
severity, empty Supervisor guidance) is never reduced to a clean empty result —
it fails closed to `HUMAN_REQUIRED`.

**Review evidence coverage**: the Worker's full attributed diff is reviewed —
either in one bounded call or split into deterministic chunks that are EACH
reviewed and metered; `PASS` requires every chunk to have been reviewed
successfully. Evidence too large to chunk within the cap → `REVIEW_TOO_LARGE` →
`HUMAN_REQUIRED`. Each completed chunk's result is durably checkpointed
(keyed to `sha(deltaFingerprint :: gateFingerprint :: reviewScopeFingerprint)`); a crash mid-round
resumes at the next unreviewed chunk without re-calling the model for the ones
already done.

**One logical review state → one dispatch sequence**: a chunk cites ONE
composite evidenceId (`sha(diffChunkHash :: gateFingerprint)`). Attempt 1
durably consumes it; bounded failover retries (`attempt > 1`) may reuse that
one claim ONLY when every earlier physical attempt is durably proven never to
have reached the provider (`RESERVED` / `CANCELLED_PRE_DISPATCH`, or
`SETTLED_KNOWN` with `settlementReason === PROVEN_PRE_SEND_ZERO` — set from an
explicit pre-send provenance flag, never inferred from a zero token count); a
first attempt on already-consumed evidence is denied — so a re-call on an
identical `(diff+gate+review-scope)` state across crash/resume yields exactly one physical
Reviewer dispatch, and a post-send provider error is never a licence to retry.
`NO NEW INFORMATION → NO NEW MODEL CALL` holds.

**Per-`loopId` serialization**: an in-process lock chain plus a durable
cross-process lock file (`<runtime>/<loopId>/reviewloop.lock`) serialize every
`reviewloop_review` for a loop. Overlapping calls run one after another (the
second then hits the deterministic `NO_PROGRESS` guard — one dispatch, no lost
update); a live foreign holder makes the call return `WAITING_FOR_REVIEW`
without touching state; a stale/expired/dead-pid lock is reclaimed.

**Gate FAIL is a repair cycle, not a Reviewer round**: a deterministic Gate
FAIL increments `gateRepairCount`, never `round`, so Gate-repair loops never
exhaust the objective's max fresh Reviewer rounds. Each Gate command has a
deterministic timeout (`REVIEWLOOP_GATE_TIMEOUT_MS`) with whole-process-tree
teardown.

**Frozen verification plan**: `reviewloop_begin` resolves and freezes the Gate
verification plan (`source`, exact `commands`, a `manifestFingerprint` of the
`.reviewloop.json` / `package.json` test-script bytes) into the immutable
objective. `reviewloop_review` runs those exact frozen commands; any manifest
drift since `begin` blocks the review (REWORK) rather than trusting a Gate the
Worker can edit mid-loop.

**Baseline-diff suppression is objective-bound**: a review-time Gate FAIL is
downgraded to WARN only for failures the begin-time baseline Gate already had.
That begin-time evidence lives in `workflow.json` (outside the tamper-checked
objective), so its stable identity (`pass`, `source`, a hash of the failure
evidence) is folded into the objective fingerprint. At review the persisted
evidence is used for suppression only when it still matches that bound identity;
otherwise it is ignored (a real regression stays FAIL) and a
`REVIEWLOOP_BASELINE_GATE_EVIDENCE_UNVERIFIED` safety event is recorded.

**Bounded Gate output**: each verification command's stdout/stderr is capped as
chunks arrive (not only sliced after concat), so a runaway command that streams
hundreds of MB cannot OOM the MCP host before the Gate timeout fires.

**Baseline attribution**: `git stash create` snapshots the exact pre-Worker
tracked state without touching the tree; the review diff is `baseline..current`
(never `HEAD..current`), so pre-existing staged/unstaged/untracked user work is
never attributed to the Worker. Unattributable state → `HUMAN_REQUIRED`. No
Worker change since `begin` → deterministic `NO_PROGRESS`, zero Reviewer calls.

**PR evidence** (`prEvidence.js` + `prWorktree.js`): the primary Reviewer
evidence for a PR target is `merge-base(prBaseSha, reviewedHeadSha) ..
reviewedHeadSha`, computed with LOCAL `git diff`/`git diff --name-only`
inside an isolated disposable worktree — never a live `gh pr diff` API call,
and never "what the Worker changed since `begin`". `prWorktree.js` first
proves both SHAs are real, fetched commit objects (fetching them by exact SHA
when the reviewer's own checkout does not already have them, falling back to
`refs/pull/<n>/head` for the HEAD SHA only), computes their merge-base, then
checks out a throwaway `git worktree --detach` at the exact HEAD SHA — torn
down again (success or failure) before the round's Reviewer call, never
committing, pushing, or touching the user's own branches. A base/HEAD that
cannot be fetched, a merge-base that cannot be resolved, a diff that fails, or
a binary/submodule hunk in the diff all mark the evidence incomplete →
`HUMAN_REQUIRED`. GitHub is a target adapter only: it resolves the repository
identity (cross-checked against cwd's own git remote — see **PR repository
identity** below), the base SHA, the current HEAD SHA, and (opt-in,
`REVIEWLOOP_PUBLISH_PR_RESULT=1`) publishes a one-comment result summary. It
is never a reviewer, never serves the PR diff as Reviewer evidence, never
posts a review-trigger comment, and a publication failure never changes the
verdict.

**PR repository identity** (`prIdentity.js`): `reviewloop_begin({ cwd,
prNumber })` refuses to register a PR loop unless cwd's own repository is
PROVEN identical to the PR's repository — never best-effort metadata. cwd's
identity is derived from the LITERAL configured `git config
remote.origin.url` (never `git remote get-url`, which silently applies any
local `insteadOf` rewrite, and never the MCP process's own working
directory), canonicalized to `owner/name`; the PR's identity comes from
`prBackend.resolveRepo({ cwd, prNumber })`, itself scoped to `cwd` rather than
an ambient process cwd. cwd not being a git repository, having no `origin`
remote, an unparseable/non-GitHub remote, GitHub reporting no identity, or the
two identities disagreeing are ALL refused — never treated as an implicit
match.

**Complete physical-attempt accounting**: every settled metered attempt —
success, known-usage failure, OR mechanically-zero pre-send failure
(`PROVIDER_UNAVAILABLE` / `AGY_ENOENT` / `AGY_SPAWN_FAILED` /
`AGY_BAD_INPUT`) — writes a durable spend-log record tagged with its
`reservationId` before the business error propagates. Production CLI auth
preflight happens before a model-spend permit and therefore creates no metered
attempt at all. A normal failover never looks like unaccounted spend on the
next load. If a crash still leaves a `SETTLED_KNOWN` reservation with no
matching record (orphan by `reservationId`), its real usage/cost are gone —
`UNKNOWN != ZERO`, so every further metered call is refused
(`MODEL_SPEND_USAGE_UNRESOLVED`) until a human acknowledges it
(`REVIEWLOOP_ACK_UNACCOUNTED_SPEND`).

**Unknown dollar cost is never $0**: a provider that reports no cost yields
`costKnown: false`; telemetry's `costUsd` is then a lower bound. The cost
ceiling fires on the known sum, and also once the known sum passes half the
ceiling while any unknown-cost call exists; `usageVolume` stays the hard
runaway guard.

**Untracked evidence** is never silently truncated: a Worker-touched untracked
text file's full content reaches the Reviewer via the chunker; a binary or
unreadable Worker-created file marks the evidence incomplete → `HUMAN_REQUIRED`;
a deleted pre-existing untracked file is recognised as a Worker change. A file
that was untracked at baseline (only a digest was kept) but is now modified —
whether still untracked, staged, or newly `.gitignore`d — cannot yield an
honest baseline→current delta and fails the evidence closed rather than
emitting its whole content; likewise a brand-new untracked path whose bytes are
identical to a baseline-untracked file (a rename or copy of pre-existing
content). The same protections extend to a brand-new **tracked** addition
(`git diff --diff-filter=A`) that was neither tracked nor untracked at baseline.
Attribution of any brand-new Worker file (tracked or untracked) is **structural,
not content-based**: an exact-digest match against a baseline-untracked file
fails closed (a verbatim copy/rename), and — because ReviewLoop keeps only a
digest per baseline-untracked file and cannot subtract an arbitrary lossless
transform of that content (base64, gzip, hex, NUL-stripping, …) — **if any file
was untracked at baseline, every brand-new Worker file is treated as
unattributable and the evidence fails closed.** A Worker starting from a clean
tree is unaffected; a pre-existing untracked file must be committed or removed
before ReviewLoop can isolate new work. Any **git submodule** in the Worker's
tracked diff — new submodule commits *or* a merely-dirty submodule worktree,
which `git diff` renders only as a lone `Subproject commit …-dirty` line —
fails the evidence closed: ReviewLoop does not recurse into submodules, so the
real change is unreviewable text. A single untracked file is read into memory
only up to an 8 MiB cap; a larger one is digested with a bounded streaming read
and, if it is brand-new Worker output, fails the evidence closed rather than
OOMing the process. A baseline-untracked path missing from the
current listing is called *deleted* only when its absence is definitively
confirmed (`ENOENT`); any other `lstat`/read failure (`EACCES`, a mid-read
race) fails the evidence closed instead. Every untracked path
is `lstat`'d before it is read — a symlink, FIFO, socket, or device is never
followed (it would fold an out-of-tree target's bytes into Reviewer evidence)
and fails the evidence closed. Any git command that feeds
baseline / diff / HEAD / untracked attribution fails closed on a non-zero exit
— never absorbed as an empty diff, an empty set, or a fallback HEAD.

**Per-invocation isolation**: `safetyEvents` in a result are scoped to that one
`reviewloop_review` call (a long-lived controller shared by many `loopId`s
never leaks one loop's events into another's). `NO_PROGRESS` /
`WAITING_FOR_REVIEW` / `PUSH_REQUIRED` / terminal results report the durable
cumulative spend, never zeros.
