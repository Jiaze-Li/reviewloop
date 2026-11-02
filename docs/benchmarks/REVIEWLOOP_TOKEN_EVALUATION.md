# ReviewLoop: measured Token savings evaluation

## Decision today (2026-11-02)

**NO VALID PAIRED LIVE MEASUREMENT AVAILABLE.** ReviewLoop now records per-call
`usageVolume`, model identity, cache telemetry, prompt-section character counts
and cost completeness, and provides `reviewloop profile --loop <id>`. However
the repository does **not** contain a pre-/post-optimization **matched pair** of
completed ReviewLoop LOCAL tasks with the same frozen objective, code/Gate/evidence
fingerprint and model routing. The tested reduction in changed-file-list
**characters** is not a measured reduction in provider Token usage.

Historical real provider certification exists in
[../CERTIFICATION.md](../CERTIFICATION.md): a LOCAL ReviewLoop session at
`ce02f1e` reported one Reviewer physical call and `usageVolume = 8,960`.
A separate retired PR-mode certification reported `usageVolume = 16,759`.
These differ in task, version and mode and **must not** be subtracted or used
to claim an optimization percentage. More recent releases currently lack an
equivalent matched live-provider dataset in version control.

## New fail-closed comparison command

From the ReviewLoop repository, given **two separately captured real**
`workflow.json` files:

```bash
node scripts/compare-token-profiles.mjs \
  /safe/previous-run/workflow.json \
  /safe/current-run/workflow.json
```

Use `--json` for a machine-readable audit, still containing only whitelist
metadata, not prompts/contracts/Worker evidence.

It refuses a savings claim (prints `NOT_COMPARABLE`, exits status 2) if:

- Frozen objective fingerprint differs or is absent.
- Last reviewed code/Gate/evidence fingerprint differs or is absent.
- Either session is not a final LOCAL `PASS`.
- Physical spend ledger is absent, empty, or contains unknown usage.
- Reviewer/Supervisor family or resolved model identities differ or are unknown.

When these conditions are met, it reports *observed* recorded
`usageVolume`, physical-call and (only when completely known) USD cost deltas.
Cache reads are NOT added to volume; the accounting may be a conservative
overcount where cache semantics are unconfirmed. A matched pair is an
observation, not a statistically significant causal performance claim.

No new model calls or filesystem mutations are performed by the comparator.

## How to collect real ReviewLoop-only A/B evidence

1. Pin a representative **ReviewLoop repository task**: original frozen
   acceptance contract, Git baseline/HEAD, Gate commands, evidence, review
   scope and provider family/model. Record the ReviewLoop implementation
   version being evaluated.
2. Execute independent pre-/post-optimization local ReviewLoop sessions with
   **isolated runtime directories** and the exact same input/source snapshot.
   Keep the full independent Reviewer, deterministic Gate and normal stop/PASS
   policy enabled. Do not tune caps, disable Sentinel, artificially reuse
   results or skip defect tests to obtain an attractive number.
3. Keep both durable `workflow.json` snapshots, and run the comparator.
   If the runs diverge in contract, code/Gate/evidence or provider, record them
   as **non-comparable** instead of manufacturing a difference.
4. Collect several independent matched pairs across small/medium/large diffs
   (target at least five tasks, with repeated runs). Report the distribution
   of physical calls, `usageVolume`, cache telemetry and actual known cost,
   not one cherry-picked successful case.
5. Maintain correctness controls: deterministic tests, seeded-defect tasks,
   full P1/P2 finding inspection, no erroneous PASS, and crash/resume
   invariants. Two runs returning PASS do not alone prove equal detection.

A/B experiments require an actual local provider runtime and its durable
spend records. **No paired real model calls were executed as part of this PR**.
The included tests use synthetic ledgers only to verify the fail-closed
comparison algorithm. They are not performance evidence.

## Follow-up decision

Do not start cross-round Chunk caching or contract omission based solely on
prompt-character benchmarks. First obtain comparable provider-usage samples.
If observed savings are small or correctness controls regress, retain the
current full-contract/full-diff review design and stop optimizing that path.
