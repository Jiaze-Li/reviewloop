// ReviewLoop Git evidence.
//
// The Worker edits the real workspace directly, so ReviewLoop does not run in
// an isolated worktree. It still needs a trustworthy before/after boundary:
// reviewloop_begin captures the exact pre-edit state, and each review computes
// ONLY the Worker's delta since that point — pre-existing unrelated user work
// (staged, unstaged, or untracked) is never attributed to the Worker.
//
// Mechanism (non-mutating throughout):
//   baseline:  `git stash create` -> a commit object of the dirty tracked
//              state, WITHOUT touching the working tree or the stash list.
//              Plus a content digest of every pre-existing untracked file.
//   delta:     `git diff <baselineStashCommit>` == exactly the tracked change
//              the Worker made since begin. Untracked files are attributed by
//              comparing current content digests against the baseline digests.
//
// Fail-closed rules:
//   * Every git command that feeds baseline / diff / HEAD / untracked
//     attribution is checked for a non-zero exit. A non-zero exit is NEVER
//     absorbed as an empty diff, an empty untracked set, or a fallback HEAD —
//     `captureBaseline` throws and `collectWorkerDelta` marks the evidence
//     incomplete so the controller fails closed (HUMAN_REQUIRED). Only an exit
//     code of 0 with genuinely empty stdout (a clean tree) is treated as "no
//     change".
//   * An untracked path is `lstat`'d BEFORE it is read or digested. A symlink,
//     FIFO, socket, or device is never followed — doing so would fold an
//     out-of-tree target's bytes into Reviewer evidence. Any such path fails
//     the evidence closed. (Mirrors the hardened collector in
//     src/adapters/gate/git-evidence/index.js.)
//   * A parent directory being swapped for a symlink between two separate
//     checks can never be closed by adding more checks — only by making the
//     check and the open the same kernel call. Where the runtime provides a
//     verified atomic whole-path guard (Darwin's O_NOFOLLOW_ANY), it is used;
//     where it does not, any untracked path with a parent directory component
//     is refused outright rather than trusted on a pathname comparison that
//     cannot itself be atomic. See fingerprintUntracked.
//   * A single untracked file is read into memory only up to MAX_UNTRACKED_BYTES;
//     a larger one is digested with a bounded streaming read and, if it is
//     brand-new Worker output, fails the evidence closed (unreviewable as text)
//     rather than OOMing the process.
//   * ReviewLoop does not recurse into git submodules. Any gitlink in the
//     Worker's tracked diff (new submodule commits OR a merely-dirty submodule
//     worktree) fails the evidence closed — the real change is unreviewable text.
//   * Attribution of a BRAND-NEW Worker file is structural, not content-based:
//     if ANY file was untracked at baseline, every brand-new Worker file is
//     unattributable (an arbitrary lossless transform of pre-existing untracked
//     content cannot be subtracted) and the evidence fails closed. A Worker
//     starting from a clean tree is unaffected.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  readFile as nodeReadFile, lstat as nodeLstat, open as nodeOpen, realpath as nodeRealpath,
  mkdtemp as nodeMkdtemp, mkdir as nodeMkdir, writeFile as nodeWriteFile,
  symlink as nodeSymlink, rm as nodeRm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// O_NOFOLLOW is a POSIX flag; 0 (no-op) on platforms that lack it. It only
// rejects a symlink at the FINAL path component — every earlier component is
// still resolved normally, which is the gap this file's TOCTOU hardening
// exists to close (see fingerprintUntracked below).
const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

// Darwin's O_NOFOLLOW_ANY (not exposed by Node's fs.constants): the kernel
// resolves and validates EVERY path component — not just the last — as part
// of the single open(2) syscall. Because the whole-path check and the open
// happen in one kernel call, there is no JS-observable window in which a
// concurrent process can swap an intermediate directory for a symlink: by
// the time control returns to JS, the open has either already succeeded
// against a symlink-free path or already failed with ELOOP. It must be
// passed ALONE (combining it with O_NOFOLLOW is rejected with EINVAL on this
// kernel, confirmed empirically — the two are mutually exclusive here).
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

// Never trust a platform/header check alone: verify, at runtime, that this
// kernel actually enforces the flag the way we depend on before relying on
// it. If the probe can't prove both directions (accepts a clean path, and
// rejects one that goes through a symlinked directory), atomic whole-path
// protection is treated as unavailable rather than assumed.
let atomicGuardProbe;
async function probeAtomicSymlinkGuard(open) {
  if (process.platform !== 'darwin') return null;
  let probeRoot;
  try {
    // os.tmpdir() itself commonly resolves through a symlink (e.g. macOS's
    // /var -> /private/var) — resolve that away first so the probe measures
    // the flag's behaviour on the SAME kind of already-canonical base that
    // fingerprintUntracked actually opens against (realCwd), not a false
    // positive from tmpdir's own ancestry.
    const rawProbeRoot = await nodeMkdtemp(path.join(os.tmpdir(), 'reviewloop-nofollow-probe-'));
    probeRoot = await nodeRealpath(rawProbeRoot);
  } catch {
    return null;
  }
  try {
    const realDir = path.join(probeRoot, 'real');
    await nodeMkdir(realDir);
    const realFile = path.join(realDir, 'f');
    await nodeWriteFile(realFile, 'x');
    const linkDir = path.join(probeRoot, 'link');
    await nodeSymlink(realDir, linkDir);

    let cleanPathOpens = false;
    try {
      const fh = await open(realFile, fsConstants.O_RDONLY | DARWIN_O_NOFOLLOW_ANY);
      await fh.close();
      cleanPathOpens = true;
    } catch {
      cleanPathOpens = false;
    }

    let symlinkedParentRejected = false;
    try {
      const fh = await open(path.join(linkDir, 'f'), fsConstants.O_RDONLY | DARWIN_O_NOFOLLOW_ANY);
      await fh.close();
    } catch (err) {
      symlinkedParentRejected = err?.code === 'ELOOP';
    }

    return (cleanPathOpens && symlinkedParentRejected) ? DARWIN_O_NOFOLLOW_ANY : null;
  } catch {
    return null;
  } finally {
    await nodeRm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// Memoised for the process lifetime — the kernel's behaviour cannot change
// between calls, and the probe is real filesystem I/O.
function getAtomicSymlinkGuardFlag(open) {
  if (!atomicGuardProbe) atomicGuardProbe = probeAtomicSymlinkGuard(open);
  return atomicGuardProbe;
}

// Hard ceiling on how many bytes of a single untracked file ReviewLoop will
// pull into memory (digest + evidence). A larger untracked file is digested
// with a bounded streaming read and never materialised whole, so a multi-GB
// artifact in the working tree cannot OOM the MCP process during
// `reviewloop_begin` or delta collection. A brand-new Worker file above this
// size cannot be reviewed as text and fails the evidence closed.
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

// SHA-256 of a file descriptor's full contents via a bounded, reused buffer —
// the whole file is never held in memory at once.
async function streamDigest(fh) {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let pos = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead <= 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

// git's human-readable messages (e.g. "Binary files ... differ") are
// translated by the user's locale. The evidence checks below match that English
// text, so every git call is pinned to the C locale; otherwise a translated
// message would silently skip the binary-delta check.
const GIT_ENV = Object.freeze({ LC_ALL: 'C' });

function runGit(args, cwd, spawn = nodeSpawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    const out = [];
    const errChunks = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => resolve({ code: 127, stdout: '', stderr: String(err?.message ?? err) }));
    child.on('close', (code) => resolve({
      code: code ?? 0,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    }));
  });
}

class GitEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitEvidenceError';
    this.code = 'REVIEWLOOP_GIT_EVIDENCE_FAILED';
  }
}

// Run a git command that MUST succeed for the evidence to be trustworthy.
async function gitOrThrow(args, cwd, spawn, context) {
  const res = await runGit(args, cwd, spawn);
  if (res.code !== 0) {
    throw new GitEvidenceError(
      `ReviewLoop ${context}: "git ${args.join(' ')}" exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`,
    );
  }
  return res;
}

function describeSpecial(info) {
  if (info.isFIFO()) return 'FIFO';
  if (info.isSocket()) return 'socket';
  if (info.isBlockDevice()) return 'block device';
  if (info.isCharacterDevice()) return 'character device';
  if (info.isDirectory()) return 'directory';
  return 'non-regular file';
}

// lstat-guarded content digest of an untracked path. NEVER follows a symlink
// and never reads a special file. Returns one of:
//   { safe: true, digest }         regular file
//   { safe: false, reason }        symlink / FIFO / socket / device / dir
//   { unreadable: true, reason }   lstat or read failure
async function fingerprintUntracked({
  cwd, filePath, lstat, readFile, open = nodeOpen, realpath = nodeRealpath,
  // Test-only override: skip the real capability probe and force a specific
  // guard flag (or `null` to force "unavailable"). Production callers never
  // pass this — it is determined by probeAtomicSymlinkGuard.
  atomicGuardFlag,
}) {
  const abs = path.join(cwd, filePath);
  // Fast pre-check by name: reject a symlink or a special file before opening.
  let info;
  try {
    info = await lstat(abs);
  } catch (err) {
    // ENOENT is the only "definitively absent" signal — every other lstat
    // failure (EACCES, EIO, ...) means the path may still exist and must not be
    // treated as a deletion by the caller.
    return {
      unreadable: true,
      missing: err?.code === 'ENOENT',
      reason: `cannot lstat untracked path ${filePath}: ${err?.message ?? err}`,
    };
  }
  if (info.isSymbolicLink()) {
    return { safe: false, reason: `untracked path ${filePath} is a symlink — refusing to follow or read its target` };
  }
  if (!info.isFile()) {
    return { safe: false, reason: `untracked path ${filePath} is a ${describeSpecial(info)} — refusing to read it` };
  }

  // The lstat above only inspects the FINAL path component, by name. It says
  // nothing about the parent directories git walked through to list this
  // path, and a second lstat/realpath call before the open would only move
  // the check — a concurrent process can still replace a parent directory
  // with a symlink AFTER whatever check ran and restore it before whatever
  // check runs next (a classic check-then-use race: two syscalls can never
  // be made atomic from JS by adding more of them in between). Closing this
  // requires the parent-directory check and the open to be the SAME kernel
  // call. Where the runtime provides that (Darwin's O_NOFOLLOW_ANY, verified
  // by probeAtomicSymlinkGuard above), use it. Where it does not, refuse to
  // open a path with any parent component at all rather than pretend a
  // pathname-comparison retrofit closes a race it structurally cannot.
  let realCwd;
  try {
    realCwd = await realpath(cwd);
  } catch (err) {
    return {
      unreadable: true,
      missing: err?.code === 'ENOENT',
      reason: `cannot resolve the real path of the repository root while fingerprinting ${filePath}: ${err?.message ?? err}`,
    };
  }

  const hasParentComponent = path.dirname(filePath) !== '.';
  const guardFlag = atomicGuardFlag !== undefined ? atomicGuardFlag : await getAtomicSymlinkGuardFlag(open);

  if (hasParentComponent && !guardFlag) {
    return {
      safe: false,
      reason: `untracked path ${filePath} lies under one or more parent directories and this runtime exposes no `
        + 'atomic whole-path symlink guard (no O_NOFOLLOW_ANY/openat2-equivalent available) — a parent directory '
        + 'could be swapped for a symlink between any two separate checks with no way to close that race here, so '
        + 'the read is refused rather than trusted',
    };
  }

  // realTarget is built from the fully-resolved (symlink-free) repository
  // root, so a whole-path guard on it only ever fires on a symlink in
  // filePath's OWN repo-relative components — a symlink that happens to sit
  // in cwd's own ancestry (e.g. a symlinked tmp/volume mount) is already
  // canonicalised out and never trips it.
  const realTarget = path.join(realCwd, filePath);
  // Confirmed empirically: this kernel rejects O_NOFOLLOW combined with
  // O_NOFOLLOW_ANY (EINVAL) — O_NOFOLLOW_ANY alone already subsumes
  // final-component symlink rejection, so the flags are never combined.
  const openFlags = fsConstants.O_RDONLY | (guardFlag || O_NOFOLLOW);

  // Authoritative read: open WITHOUT following a symlink, then operate ONLY
  // on the returned descriptor. A concurrent process that renames the real
  // file aside and drops a same-sized symlink in its place cannot redirect
  // us — fstat/read on the fd always see the one inode actually opened.
  let fh;
  try {
    fh = await open(realTarget, openFlags);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return {
        safe: false,
        reason: `untracked path ${filePath} resolves through a symlink (the file itself, or a parent directory) — refusing to follow it`,
      };
    }
    return {
      unreadable: true,
      missing: err?.code === 'ENOENT',
      reason: `cannot open untracked file ${filePath}: ${err?.message ?? err}`,
    };
  }
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      return { safe: false, reason: `untracked path ${filePath} is not a regular file when opened — refusing to read it` };
    }
    if (Number.isFinite(Number(st.size)) && Number(st.size) > MAX_UNTRACKED_BYTES) {
      // Too large to hold in memory. Digest it with a bounded streaming read so
      // attribution (rename/copy detection) still works, but never retain its
      // bytes — a brand-new Worker file this size fails the evidence closed.
      const digest = await streamDigest(fh);
      return {
        safe: true, digest, bytes: null, oversized: true, byteLength: Number(st.size),
      };
    }
    const buf = await fh.readFile();
    const st2 = await fh.stat();
    if ((Number.isFinite(st2.ino) && Number.isFinite(st.ino) && st2.ino !== st.ino)
      || (Number.isFinite(st2.size) && st2.size !== buf.length)) {
      return { safe: false, reason: `untracked path ${filePath} changed during read — refusing to trust its contents` };
    }
    return { safe: true, digest: sha256(buf), bytes: buf };
  } catch (err) {
    return { unreadable: true, reason: `cannot read untracked file ${filePath}: ${err?.message ?? err}` };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function listUntracked(cwd, spawn, context) {
  const res = await gitOrThrow(['ls-files', '--others', '--exclude-standard', '-z'], cwd, spawn, context);
  return res.stdout.split('\0').filter(Boolean);
}

// Capture the pre-Worker baseline. Never mutates the working tree, the index,
// or the stash list.
export async function captureBaseline({
  cwd, spawn = nodeSpawn, lstat = nodeLstat, readFile = nodeReadFile, open = nodeOpen,
  realpath = nodeRealpath, atomicGuardFlag,
} = {}) {
  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new GitEvidenceError(`ReviewLoop baseline: "${cwd}" is not inside a git repository`);
  }
  const headRes = await gitOrThrow(['rev-parse', 'HEAD'], cwd, spawn, 'baseline');
  const head = headRes.stdout.trim();
  if (!head) throw new GitEvidenceError(`ReviewLoop baseline: "git rev-parse HEAD" produced no SHA in "${cwd}"`);

  // A commit object snapshot of the tracked dirty state (index + worktree).
  // A non-zero exit is a real failure and must not be papered over with HEAD.
  // Exit 0 + empty stdout => the tracked tree was clean; use HEAD as the ref.
  const stashRes = await gitOrThrow(['stash', 'create', 'reviewloop-baseline'], cwd, spawn, 'baseline');
  const baselineRef = stashRes.stdout.trim() || head;

  const statusRes = await gitOrThrow(['status', '--porcelain=v1', '-z'], cwd, spawn, 'baseline');
  const dirtyFiles = statusRes.stdout.split('\0').filter(Boolean).map((raw) => ({
    path: raw.slice(3),
    status: raw.slice(0, 2).trim(),
    untracked: raw.slice(0, 2) === '??',
  }));

  const untracked = await listUntracked(cwd, spawn, 'baseline');
  // Only a digest is kept per baseline-untracked file — never its bytes.
  // ReviewLoop cannot subtract an arbitrary lossless transform (base64, gzip,
  // hex, NUL-stripping, ...) of pre-existing untracked content from a brand-new
  // Worker file, so it does not try: any file untracked at baseline makes every
  // brand-new Worker file unattributable and fails the evidence closed
  // (see collectWorkerDelta).
  const untrackedHashes = {};
  let evidenceComplete = true;
  const incompleteReasons = [];
  for (const filePath of untracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({
      cwd, filePath, lstat, readFile, open, realpath, atomicGuardFlag,
    });
    if (fp.safe) {
      untrackedHashes[filePath] = fp.digest;
    } else {
      evidenceComplete = false;
      incompleteReasons.push(fp.reason);
    }
  }

  return {
    head,
    baselineRef,
    capturedAt: new Date().toISOString(),
    dirtyFiles,
    untrackedHashes,
    evidenceComplete,
    incompleteReasons,
  };
}

// Compute the Worker's delta since the baseline. `diff` is scoped to
// baseline->current, NOT HEAD->current, so pre-existing dirty hunks are
// excluded. Returns changedFiles attributed to the Worker only. Any git
// command failure or unsafe untracked path marks evidenceComplete=false so the
// controller fails closed rather than reviewing partial / spoofed evidence.
export async function collectWorkerDelta({
  cwd, baseline, spawn = nodeSpawn, lstat = nodeLstat, readFile = nodeReadFile, open = nodeOpen,
  realpath = nodeRealpath, atomicGuardFlag,
} = {}) {
  if (!baseline?.head) throw new Error('collectWorkerDelta: baseline.head is required');
  const baseRef = baseline.baselineRef ?? baseline.head;

  let evidenceComplete = baseline.evidenceComplete !== false;
  const incompleteReasons = [...(baseline.incompleteReasons ?? [])];
  const fail = (reason) => { evidenceComplete = false; incompleteReasons.push(reason); };

  const currentHeadRes = await runGit(['rev-parse', 'HEAD'], cwd, spawn);
  let currentHead = null;
  if (currentHeadRes.code === 0 && currentHeadRes.stdout.trim()) {
    currentHead = currentHeadRes.stdout.trim();
  } else {
    fail(`cannot resolve current HEAD: "git rev-parse HEAD" exited ${currentHeadRes.code}`);
  }

  // Tracked delta since the baseline snapshot (index + worktree vs baseRef).
  const diffRes = await runGit(['diff', baseRef], cwd, spawn);
  let trackedDiff = '';
  if (diffRes.code === 0) trackedDiff = diffRes.stdout;
  else fail(`"git diff ${baseRef}" exited ${diffRes.code}: ${(diffRes.stderr || '').trim().slice(0, 200)}`);

  // NUL-delimited: a tracked path may legally contain a newline (or a leading/
  // trailing space). Newline-splitting or trimming that list would mis-slice
  // the path and mis-attribute the Worker's change; `-z` also disables git's
  // octal path-quoting so the bytes are literal.
  const nameRes = await runGit(['diff', '-z', '--name-only', baseRef], cwd, spawn);
  let trackedChanged = [];
  if (nameRes.code === 0) {
    trackedChanged = nameRes.stdout.split('\0').filter(Boolean);
  } else {
    fail(`"git diff -z --name-only ${baseRef}" exited ${nameRes.code}`);
  }

  // Submodule / gitlink delta. `git diff` renders any change inside a checked-out
  // submodule — new commits OR a merely-dirty worktree — as a lone
  // "Subproject commit <sha>[-dirty]" hunk over a 160000-mode gitlink; the
  // modified files and their contents never reach the Reviewer, so a CLEAN
  // review could PASS an entirely unreviewed implementation. ReviewLoop does not
  // recurse into submodules, so any gitlink in the Worker's tracked diff fails
  // the evidence closed. Detected structurally from the diff text git already
  // produced (mode 160000 line and/or the "Subproject commit" body).
  if (/^(?:(?:old|new|deleted file|new file) mode |index [0-9a-f]+\.\.[0-9a-f]+ )160000\b/m.test(trackedDiff)
    || /^[+-]Subproject commit [0-9a-f]+/m.test(trackedDiff)) {
    fail('the Worker delta changes a git submodule (gitlink) — ReviewLoop cannot see inside a submodule, '
      + 'so a change there (new commits or a dirty worktree) cannot be reviewed as text');
  }

  // Paths `git diff <baseRef>` renders as wholly-new additions (no blob in the
  // baseline tree). A pre-existing untracked file that the Worker renamed,
  // edited AND `git add`ed lands here — not in `currentUntracked` and not in
  // `baselineUntracked` — so the untracked rename+edit guard below never sees
  // it. Kept so that guard can also reconcile these against vanished
  // baseline-untracked paths.
  const addRes = await runGit(['diff', '-z', '--name-only', '--diff-filter=A', baseRef], cwd, spawn);
  let addedTracked = [];
  if (addRes.code === 0) {
    addedTracked = addRes.stdout.split('\0').filter(Boolean);
  } else {
    fail(`"git diff -z --name-only --diff-filter=A ${baseRef}" exited ${addRes.code}`);
  }

  // Untracked attribution.
  const lsRes = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd, spawn);
  let currentUntracked = new Set();
  let untrackedListingOk = false;
  if (lsRes.code === 0) {
    currentUntracked = new Set(lsRes.stdout.split('\0').filter(Boolean));
    untrackedListingOk = true;
  } else {
    fail(`"git ls-files --others" exited ${lsRes.code}`);
  }

  const baselineUntracked = baseline.untrackedHashes ?? {};
  // digest -> [baseline paths that had it], to catch a rename/copy of
  // pre-existing untracked content into a name absent from the baseline set.
  const baselineUntrackedDigests = new Map();
  for (const [p, d] of Object.entries(baselineUntracked)) {
    if (!baselineUntrackedDigests.has(d)) baselineUntrackedDigests.set(d, []);
    baselineUntrackedDigests.get(d).push(p);
  }
  const untrackedChanged = [];
  const untrackedDeleted = [];
  const modifiedUntrackedBaseline = [];
  const renamedUntrackedBaseline = [];
  const safeBytes = new Map(); // filePath -> Buffer (regular files only)

  for (const filePath of currentUntracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({
      cwd, filePath, lstat, readFile, open, realpath, atomicGuardFlag,
    });
    if (!fp.safe) {
      // symlink / special / unreadable — never attribute, never read.
      fail(fp.reason);
      continue;
    }
    if (!(filePath in baselineUntracked)) {
      if (baselineUntrackedDigests.has(fp.digest)) {
        // Byte-identical to a file that was untracked at baseline under another
        // name — a rename or copy of pre-existing content, not Worker-authored.
        // Emitting it whole would leak all of that pre-existing content (and the
        // old path would separately be reported deleted). Fail closed.
        renamedUntrackedBaseline.push(filePath);
        fail(`untracked file ${filePath} is byte-identical to a file that was untracked at baseline `
          + `(${baselineUntrackedDigests.get(fp.digest).join(', ')}) — a rename/copy of pre-existing content, not Worker output`);
      } else if (fp.oversized) {
        // Brand-new but too large to read into evidence (digest was streamed).
        // Cannot be reviewed as text — fail closed instead of OOMing on it.
        renamedUntrackedBaseline.push(filePath);
        fail(`brand-new untracked file ${filePath} is ${fp.byteLength} bytes — above the `
          + `${MAX_UNTRACKED_BYTES}-byte cap, so it cannot be read into evidence and reviewed as text`);
      } else {
        safeBytes.set(filePath, fp.bytes);
        untrackedChanged.push(filePath); // brand-new regular file -> Worker output
      }
    } else if (fp.digest !== baselineUntracked[filePath]) {
      // Pre-existing untracked file whose content changed since baseline, still
      // untracked (so it never enters the trackedChanged / modifiedStagedBaseline
      // path). The baseline retained only a digest, so an honest baseline->current
      // delta cannot be built: emitting the file as Worker output would leak its
      // unchanged pre-existing sections (possibly unrelated or sensitive) to the
      // Reviewer. Fail closed — same rationale as modifiedStagedBaseline. Its
      // bytes are NOT staged for evidence emission.
      modifiedUntrackedBaseline.push(filePath);
      fail(`pre-existing untracked file ${filePath} was modified after baseline — `
        + 'only a baseline digest was retained, so its pre-existing content cannot be separated from the Worker\'s change');
    }
    // pre-existing untracked, unchanged -> NOT Worker output, excluded.
  }
  // A file that was UNTRACKED at baseline but has since been `git add`ed shows
  // up in `git diff <baseRef>` (baseRef never captured untracked content) even
  // when its bytes are unchanged from baseline — that is pre-existing user
  // work, not the Worker's. Drop any such path (in the baseline untracked set,
  // current digest still equal to the baseline digest) from the name list AND
  // re-scope the diff text so its hunks never reach the Reviewer.
  const leakedStaged = [];
  const modifiedStagedBaseline = [];
  for (const filePath of trackedChanged) {
    if (!(filePath in baselineUntracked)) continue;
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({
      cwd, filePath, lstat, readFile, open, realpath, atomicGuardFlag,
    });
    if (fp.safe && fp.digest === baselineUntracked[filePath]) {
      leakedStaged.push(filePath); // unchanged pre-existing user work, just staged
    } else {
      // The Worker modified a file that was UNTRACKED at baseline and then
      // staged it. `git diff <baseRef>` has no blob for it, so it is rendered
      // as a wholly-new file: the FULL pre-existing baseline content would be
      // emitted as Worker evidence (and the path also marked deleted). There is
      // no way to construct an honest baseline->current delta here — fail closed.
      modifiedStagedBaseline.push(filePath);
      fail(`pre-existing untracked file ${filePath} was modified and staged after baseline — `
        + `"git diff ${baseRef}" cannot represent it without leaking its pre-existing content as Worker evidence`);
    }
  }
  const leaked = new Set([...leakedStaged, ...modifiedStagedBaseline]);
  if (leaked.size) {
    trackedChanged = trackedChanged.filter((p) => !leaked.has(p));
    if (trackedChanged.length) {
      const scoped = await runGit(['diff', baseRef, '--', ...trackedChanged], cwd, spawn);
      if (scoped.code === 0) trackedDiff = scoped.stdout;
      else fail(`"git diff ${baseRef} -- <scoped>" exited ${scoped.code}`);
    } else {
      trackedDiff = '';
    }
  }

  // A pre-existing untracked file the Worker DELETED (git diff cannot see it).
  // Only trustworthy when the current untracked listing itself succeeded.
  if (untrackedListingOk) {
    for (const filePath of Object.keys(baselineUntracked)) {
      // A path that is now staged (leaked, unchanged) was NOT deleted — it is
      // pre-existing user work that moved from untracked to the index.
      if (currentUntracked.has(filePath) || leaked.has(filePath) || trackedChanged.includes(filePath)) continue;
      // Absent from the untracked listing but not staged/tracked. It is EITHER
      // genuinely gone OR still on disk and now git-ignored (which hides it from
      // `git ls-files --exclude-standard`). Classify it as deleted only after
      // confirming it is actually gone — otherwise a modified-then-ignored file
      // would be reported deleted while PASS proceeds without reviewing it.
      // eslint-disable-next-line no-await-in-loop
      const fp = await fingerprintUntracked({
        cwd, filePath, lstat, readFile, open, realpath, atomicGuardFlag,
      });
      if (fp.unreadable && fp.missing) {
        untrackedDeleted.push(filePath); // definitively absent
      } else if (fp.unreadable) {
        // Present but unreadable (EACCES, EIO, a mid-read race): NOT a deletion,
        // and its current content was never reviewed — fail closed.
        fail(`baseline-untracked file ${filePath} vanished from the untracked listing but could not be confirmed absent (${fp.reason})`);
      } else if (!fp.safe) {
        fail(fp.reason); // a symlink/special now sits where a regular file was
      } else if (fp.digest === baselineUntracked[filePath]) {
        // still present, unchanged, just newly ignored -> pre-existing user
        // work, neither deleted nor Worker output; exclude it entirely.
      } else {
        // still present, content changed, now ignored -> the same leak as a
        // modified-but-still-untracked file; fail closed.
        modifiedUntrackedBaseline.push(filePath);
        fail(`pre-existing untracked file ${filePath} was modified and then git-ignored after baseline — `
          + 'only a baseline digest was retained, so its current content cannot be separated from the pre-existing bytes');
      }
    }
  }

  // Brand-new *tracked* additions (`git diff --diff-filter=A`) that were
  // neither tracked nor untracked at baseline. A rename/copy (+ optional edit)
  // of a baseline-untracked file into a staged new name lands here — not in
  // `currentUntracked`, not in `baselineUntracked` — so none of the untracked
  // guards above see it, and `git diff <baseRef>` renders it as a wholly-new
  // file, leaking its pre-existing bytes with evidenceComplete=true. Mirror the
  // two untracked-side protections for these paths.
  const brandNewTracked = addedTracked.filter(
    (p) => trackedChanged.includes(p) && !leaked.has(p) && !(p in baselineUntracked),
  );
  const droppedTracked = new Set();

  // (1) Exact digest match against a baseline-untracked file -> a copy/rename
  //     of pre-existing content. No vanished source required (the Worker may
  //     copy without deleting the original). Mirrors the untracked
  //     `renamedUntrackedBaseline` check.
  for (const p of brandNewTracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({
      cwd, filePath: p, lstat, readFile, open, realpath, atomicGuardFlag,
    });
    if (fp.safe && baselineUntrackedDigests.has(fp.digest)) {
      droppedTracked.add(p);
      renamedUntrackedBaseline.push(p);
      fail(`staged new file ${p} is byte-identical to a file that was untracked at baseline `
        + `(${baselineUntrackedDigests.get(fp.digest).join(', ')}) — a copy/rename of pre-existing content, not Worker output`);
    } else if (!fp.safe) {
      droppedTracked.add(p);
      fail(fp.reason);
    }
  }

  // (2) Any baseline-untracked path vanished while a brand-new file (untracked
  //     OR tracked) appeared -> a rename+edit cannot be told apart from a
  //     delete+create, and the baseline kept only digests. Fail closed and
  //     drop every candidate destination.
  if (untrackedDeleted.length && (untrackedChanged.length || brandNewTracked.length)) {
    const appeared = [...untrackedChanged, ...brandNewTracked];
    fail(`brand-new file(s) [${appeared.join(', ')}] appeared while pre-existing untracked `
      + `file(s) [${untrackedDeleted.join(', ')}] disappeared — a rename+edit cannot be distinguished from a `
      + 'delete+create and the baseline retained only digests');
    for (const p of untrackedChanged) {
      renamedUntrackedBaseline.push(p);
      safeBytes.delete(p);
    }
    for (const p of brandNewTracked) {
      if (!droppedTracked.has(p)) {
        droppedTracked.add(p);
        renamedUntrackedBaseline.push(p);
      }
    }
    // The disappeared paths are no longer "clean deletions" either — fold them
    // into the same ambiguous bucket.
    renamedUntrackedBaseline.push(...untrackedDeleted);
    untrackedChanged.length = 0;
    untrackedDeleted.length = 0;
  }

  // (3) Any brand-new Worker file (tracked addition or untracked) is
  //     unattributable when ANY file was untracked at baseline. The exact-digest
  //     and vanished-source guards above catch verbatim copies and rename+edits;
  //     an arbitrary lossless transform of pre-existing untracked content
  //     (base64, gzip, hex, NUL-stripping, ...) leaves no contiguous run to
  //     match and deletes no source, so no content comparison can reliably clear
  //     it. Rather than chase encodings, close the surface structurally: fail
  //     the evidence closed and drop every brand-new candidate. A Worker
  //     starting from a clean tree is unaffected; a pre-existing untracked file
  //     must be committed or removed before ReviewLoop can isolate new work.
  if (Object.keys(baselineUntracked).length) {
    const candidates = [
      ...untrackedChanged.map((p) => ({ p, tracked: false })),
      ...brandNewTracked.filter((p) => !droppedTracked.has(p) && trackedChanged.includes(p))
        .map((p) => ({ p, tracked: true })),
    ];
    for (const { p, tracked } of candidates) {
      renamedUntrackedBaseline.push(p);
      if (tracked) {
        droppedTracked.add(p);
      } else {
        safeBytes.delete(p);
        const idx = untrackedChanged.indexOf(p);
        if (idx !== -1) untrackedChanged.splice(idx, 1);
      }
      fail(`brand-new file ${p} cannot be cleared: one or more files were untracked at baseline and an `
        + 'arbitrary transform of their content cannot be separated from Worker authorship — failing '
        + 'closed rather than guessing attribution');
    }
  }

  // Re-scope the tracked diff so no dropped brand-new tracked file's bytes
  // reach the Reviewer.
  if (droppedTracked.size) {
    trackedChanged = trackedChanged.filter((p) => !droppedTracked.has(p));
    if (trackedChanged.length) {
      const scoped = await runGit(['diff', baseRef, '--', ...trackedChanged], cwd, spawn);
      if (scoped.code === 0) trackedDiff = scoped.stdout;
      else fail(`"git diff ${baseRef} -- <scoped>" exited ${scoped.code}`);
    } else {
      trackedDiff = '';
    }
  }

  // Tracked binary delta. `git diff` renders a changed binary blob (a real
  // binary, or a path forced binary by `.gitattributes`) as a lone
  // "Binary files a/<p> and b/<p> differ" line — NONE of the changed bytes
  // appear, so a Reviewer sees only that something changed, not what. A
  // Worker-created *untracked* binary already fails the evidence closed
  // (see the untracked-block builder below); mirror that for tracked blobs.
  // Checked on the FINAL tracked diff so a binary path already scoped out
  // above (e.g. a leaked baseline-untracked file) is not double-counted.
  // Detected structurally from git's own output — no content sniffing.
  for (const line of trackedDiff.split('\n')) {
    if (/^Binary files .+ differ$/.test(line)) {
      fail(`the Worker delta changes a binary file — "${line.trim()}" — whose changed bytes `
        + 'are never rendered in the diff and cannot be reviewed as text');
    }
  }

  const changedFiles = [
    ...new Set([
      ...trackedChanged, ...untrackedChanged, ...untrackedDeleted,
      ...modifiedUntrackedBaseline, ...renamedUntrackedBaseline,
    ]),
  ].sort();

  // Full worker-attributed evidence text: the tracked diff, the COMPLETE
  // content of every Worker-touched untracked text file (never truncated —
  // size is handled downstream by the deterministic diff chunker), and a
  // deletion marker for every removed pre-existing untracked file. A binary or
  // unreadable Worker-created file cannot be reviewed as text, so evidence is
  // marked incomplete and the controller fails closed (HUMAN_REQUIRED) rather
  // than letting a review PASS without covering it.
  const untrackedBlocks = [];
  for (const filePath of untrackedChanged) {
    const buf = safeBytes.get(filePath);
    if (!buf) {
      fail(`Worker-created untracked file ${filePath} could not be read for evidence`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (UNREADABLE) ---`);
      continue;
    }
    if (buf.includes(0)) {
      fail(`Worker-created untracked file ${filePath} is binary (${buf.length} bytes) — cannot be reviewed as text`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (BINARY, ${buf.length} bytes) ---`);
      continue;
    }
    untrackedBlocks.push(`--- Worker untracked file ${filePath} (${buf.length} bytes) ---\n${buf.toString('utf8')}`);
  }
  for (const filePath of untrackedDeleted) {
    untrackedBlocks.push(`--- Worker deleted pre-existing untracked file ${filePath} ---`);
  }
  const diff = [trackedDiff, ...untrackedBlocks].filter(Boolean).join('\n');

  const fingerprint = sha256(`${currentHead ?? 'UNKNOWN_HEAD'}\n${diff}`);
  const noWorkerChangeYet = evidenceComplete
    && changedFiles.length === 0
    && currentHead != null
    && currentHead === baseline.head
    && trackedDiff.trim() === '';

  return {
    baselineHead: baseline.head,
    baselineRef: baseRef,
    currentHead,
    fingerprint,
    diff,
    changedFiles,
    trackedChanged,
    untrackedChanged,
    untrackedDeleted,
    modifiedUntrackedBaseline,
    renamedUntrackedBaseline,
    evidenceComplete,
    incompleteReasons,
    noWorkerChangeYet,
  };
}

export { sha256 as evidenceSha256, GitEvidenceError };
