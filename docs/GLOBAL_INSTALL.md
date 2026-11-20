# ReviewLoop global install

After cloning/pulling the repository, the recommended one-command setup is:

```
npm run setup
```

It refreshes the global integration and immediately runs the zero-model doctor.

The individual commands remain available:

```
npm run install-global      # or: reviewloop install
npm run doctor
npm run uninstall-global
```

## What it does

For every supported coding agent **present on the machine** (Claude, Codex,
Gemini/AGY — missing ones are skipped, not fatal):

- registers the `reviewloop` MCP server (`bin/reviewloop-mcp.js`)
- writes `agent-policy/COMMON.md` into the agent's auto-loaded rules inside one
  managed block:
  `<!-- REVIEWLOOP-GLOBAL-POLICY:BEGIN --> … <!-- REVIEWLOOP-GLOBAL-POLICY:END -->`
- for AGY, also writes the `reviewloop` skill

`npm run doctor` verifies the installed managed blocks match COMMON byte-for-
byte, with zero model calls. A stale or absent global install is a **warning**,
never a doctor failure — doctor separates the repo invariant (always checked)
from external install freshness.

## Legacy SuperGPT migration

If an older SuperGPT install is found, the installer transactionally migrates
it: removes the `supergpt` MCP registration it owns, removes the
`<!-- SUPERGPT-GLOBAL-POLICY -->` managed block, and removes the old AGY
`supergpt` skill. Content outside the managed block is preserved byte-for-byte.
Every touched file is snapshotted first; any failure rolls all of them back.
Ambiguous ownership of an old entry fails closed rather than deleting blindly.

## Dotfiles / symlinked rules files

If an agent's rules file is a symlink into a separately tracked dotfiles repo,
only the managed ReviewLoop block changes; all user-owned content outside the
block is preserved. Commit that managed-file change in the dotfiles repo
separately — never mix it into this repo, and never force-push.

**Failure rollback keeps links intact.** Before touching anything, the
installer records each target's type (regular file, symlink, missing), the
link's `readlink` string, and the target's bytes and mode. If an install step
fails, files are restored **in place**: a symlink is never replaced by a
regular file, only its target's content is put back. After rollback every path
is re-checked (type, link target, content hash, mode).

- A **dangling** symlink (or a non-regular-file target) at a path the install
  would write is refused up front, with nothing changed.
- MCP registrations that existed before the install are not removed by
  rollback; only registrations the failed install itself added are removed.
- Anything that cannot be proven restored (including a registration the CLI
  cannot re-create) is listed in the error — path, what was expected, what was
  found, and the next step — and the install is never reported as successful.
  The same data is on `error.rollback.{restored,residual,mcp}` for callers.
- Directories created by the failed install are removed only if still empty.

## Global `reviewloop` command

`npm run setup` / `install-global` configure the agents; they do **not**
create the global `reviewloop` command. That command is the pair of npm links
that `npm link` (or `npm i -g <dir>`) leaves under the npm global prefix:

```
<prefix>/lib/node_modules/reviewloop  ->  <this checkout>
<prefix>/bin/reviewloop               ->  ../lib/node_modules/reviewloop/bin/reviewloop.js
```

If the checkout is moved or renamed those links dangle. `npm run doctor`
prints a `cli_link` warning (never a failure). To inspect and repair, use the
entry points that keep working even when `reviewloop` itself is broken:

```
npm run cli:status                    # or: node bin/reviewloop.js cli status
npm run cli:repair                    # dry run: prints what it would do
npm run cli:repair -- --apply         # or: node bin/reviewloop.js cli repair --apply
```

`status` checks that the links resolve **and the command actually runs**
(`reviewloop spec plan` through the linked binary), and that no other
`reviewloop` earlier on PATH shadows it. `repair` is dry-run by default and
only re-points a dangling package link that is recognisably ReviewLoop's own
(atomic replace). It never touches a link that points at another existing
program or checkout, a real file/directory, or a PATH conflict; it never uses
sudo. When it cannot act (permission denied, `absent`, `wrong-target`,
`foreign`) it prints the exact command to run yourself, or `npm link` from
the checkout for a machine with no links at all.

## Runtime state

`~/.reviewloop` holds durable loop state and ledgers. `~/.supergpt` is left
untouched (historical user data) and is never auto-resumed.
