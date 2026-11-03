// Crash-safe, single-file UTF-8 snapshot replacement.
//
// The previous snapshot must remain readable until the COMPLETE replacement
// has been written and fsynced. A rename on the same filesystem then publishes
// it atomically; fsync of the containing directory makes the rename durable
// on filesystems that implement the POSIX contract.
//
// This is NOT a cross-process read-modify-write transaction. ReviewLoop's
// per-loop lease remains necessary to prevent concurrent lost updates. No
// recovery silently uses an incomplete temporary file.
//
// Accept an injected I/O surface only for deterministic fault-injection tests;
// production callers always use the built-in node:fs/promises implementation.

import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const defaultIo = { open, rename, unlink };

export async function atomicReplaceUtf8(filename, content, { io = defaultIo } = {}) {
  if (typeof filename !== 'string' || !filename || typeof content !== 'string') {
    throw new TypeError('atomicReplaceUtf8 requires a filename and UTF-8 text');
  }
  const dir = path.dirname(filename);
  const temp = path.join(dir, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  let promoted = false;
  try {
    // Exclusive creation also prevents a stale temporary file or symlink from
    // being followed. Narrow permissions avoid exporting ledger details.
    handle = await io.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
      handle = null;
    }
    await io.rename(temp, filename);
    promoted = true;

    // Do NOT silently swallow fsync failure. A rename may already be visible
    // but durable status is ambiguous: the caller must stop, never authorize a
    // new paid dispatch on the assumption the state safely committed.
    const directory = await io.open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!promoted) await io.unlink(temp).catch(() => {});
  }
}
