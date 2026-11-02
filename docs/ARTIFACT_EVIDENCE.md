# Local Artifact Evidence snapshots (opt-in)

ReviewLoop's isolated Reviewer intentionally has **no filesystem tools**.
Ordinary evidence summaries and `artifactRef` values remain human-readable
claims/pointers; a filename alone is not proof.

## Scope

The Controller can optionally capture a **bounded UTF-8 byte snapshot** of an
artifact explicitly named by the Worker, put it in the Reviewer prompt as
**untrusted data**, and bind the SHA-256 of the observed bytes to the logical
review state and crash-resume chunk checkpoint. It does not run scripts found in
artifacts, open arbitrary repository files, follow symlinks, use hidden Reviewer
tools, or treat the existence of a file as sufficient to PASS.

This is content inspection, **not** proof of genuine test execution. A Worker
can author false output, so verification tied to the deterministic Gate remains
stronger. Reviewers must judge evidence against the frozen requirement and
the inspected code.

## Protocol

1. Freeze an evidence requirement at `reviewloop_begin` with
   `{id:"integration-log", type:"artifact", gate:"final", required:true, description:"..."}`.
2. Put a small plain UTF-8 file in the current loop's dedicated **runtime**
   artifacts directory:

   `$REVIEWLOOP_RUNTIME_DIR/<loopId>/artifacts/results.txt`

   If `REVIEWLOOP_RUNTIME_DIR` is unset, the root is
   `~/.reviewloop`. This is **not** the application repository or its Git
   worktree.
3. Submit a **factual inline summary** to `reviewloop_review` and opt into the
   bounded capture:

   `{requirementId:"integration-log", summary:"Executed 7 checks: 7 passed, 0 failed, exit code 0.", artifactRef:"reviewloop-artifact:results.txt"}`

4. After the deterministic Gate stabilizes the code, the Controller opens the
   exact single-named file, captures bytes, verifies size/text and digest, and
   includes the content and SHA-256 in the Reviewer/Supervisor evidence context.

The prefix `reviewloop-artifact:` is opt-in. Existing absolute/relative paths
and old `artifactRef` strings are **not opened** and remain human metadata.
A prefixed ref requires `type:"artifact"`.

## Bounds and safety

- Flat, nonhidden names only; `.txt`, `.md`, `.json`, `.log`, `.csv`.
  No separators, absolute paths, `..`, directories or prefix escapes.
- Only under `<runtimeRoot>/<loopId>/artifacts`; directories must not be
  symlinks. Files must be regular, single-linked and opened without following a
  symlink. Devices, hardlinks, binary/invalid UTF-8 and terminal-control text
  are refused.
- Per file **8 KiB**, combined **16 KiB**, at most **8 files**. The existing
  **24 KiB** combined evidence prompt budget is still enforced on the bytes
  actually sent. Over-budget data is **rejected**, never silently truncated.
- Snapshot SHA-256 and byte length enter the existing evidence fingerprint;
  source bytes are not copied into `workflow.json` or returned to the Worker.
  Replacing an artifact (even with unchanged code, Gate or summary) is new
  review evidence and invalidates old Chunk checkpoints.
- The Controller re-reads each included file after Reviewer execution. If
  content changed or disappeared before acceptance, it returns REWORK instead
  of PASS. This is not a claim of preventing modifications after PASS.
- Artifact text is **untrusted content** and can contain prompt-injection
  attempts. It must never become Reviewer instructions. Avoid copying secrets
  into artifacts: the reviewed bytes are sent to an external model provider.
- Invalid/missing artifacts cause deterministic `INVALID_EVIDENCE` rework
  without Reviewer model spend. Files are not automatically created or copied
  by ReviewLoop, avoiding an implicit arbitrary-path import capability.

## Non-goals

No blanket file browsing, raw binary/image interpretation, self-certification
from Worker-produced results, arbitrary file traversal, or caching across
changed code/diffs. These require separate design and independent verification.
