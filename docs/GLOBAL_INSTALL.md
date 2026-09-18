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

## Runtime state

`~/.reviewloop` holds durable loop state and ledgers. `~/.supergpt` is left
untouched (historical user data) and is never auto-resumed.
