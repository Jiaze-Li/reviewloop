// What a human CLI action says when it cannot take the loop lease.
//
// The lease is NOT time-limited on the same host: a live owner pid keeps it
// forever (loopLease.js reclaim rule), so "wait for it to expire" is wrong
// advice there. This module only formats guidance; it never deletes or
// overwrites a lock and never signals a process.

function fmtAge(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

// `held` is either the raw lock record returned as `heldBy` by
// acquireLoopFileLease, or the result of describeLoopLease.
export function leaseRefusalMessage({ action, loopId, held }) {
  const lines = [`cannot ${action} while another process holds the loop lease for ${loopId}.`];
  if (held && typeof held === 'object' && held.reason && !held.pid) {
    lines.push(`  lease: ${held.reason}`);
  } else if (held && typeof held === 'object') {
    const sameHost = held.sameHost ?? null;
    lines.push(`  holder: pid ${held.pid ?? '?'} on ${held.host ?? '?'}  (acquired ${held.acquiredAt ?? '?'}, last renewed ${held.renewedAt ?? '?'}, expires ${held.expiresAt ?? '?'})`);
    if (held.secondsSinceRenewal != null) lines.push(`  last renewal: ${fmtAge(held.secondsSinceRenewal)} ago`);
    lines.push('  what to do (nothing here deletes the lock or stops the process for you):');
    if (sameHost === false) {
      lines.push('   1. The holder is on another host: its lock is reclaimed only after its expiry time passes. Wait, or act on that host.');
    } else {
      lines.push('   1. The holder is on this host: its lock is NEVER reclaimed while that process is alive, however old it is.');
      lines.push('      If the last renewal keeps moving, a review is still running: wait for it.');
      lines.push('      If the last renewal is stuck for a long time, the process has lost its way: you confirm it (for example `ps -p <pid>`) and stop it yourself.');
      lines.push('      Once the process is gone the next command reclaims the lock by itself.');
    }
    lines.push('   2. After stopping the process and BEFORE resuming or ending the task, check for unsettled calls: `reviewloop inspect-spend --loop <id>` / `reviewloop report --loop <id>`. Settle any with `reviewloop acknowledge-spend`.');
    lines.push('   3. Then continue the original task (acknowledge / reopen-gate / extend-calls) or end it with `reviewloop stop-loop`.');
    lines.push('   Do NOT delete or overwrite reviewloop.lock by hand; run `reviewloop lock-status --loop <id>` to look again.');
  }
  return lines.join('\n');
}
