import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * OS process start time for `pid` (default: this process), or null if no such
 * process exists. Stable for a process's lifetime and differs across PID reuse,
 * so a stored `${pid}:${startTime}` fingerprint lets a reaper distinguish
 * "same process still alive" from "PID reused by an unrelated process".
 *
 * The same function is used to write our own fingerprint and to verify another
 * pid's, guaranteeing the two compare equal for a genuinely-live process.
 *
 * ponytail: Linux reads /proc; elsewhere shells out to `ps`. Fine at write-
 * command startup (called once per run/approve/reject/daemon).
 */
export function processStartTime(pid: number = process.pid): number | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) is parenthesized and may contain spaces/parens, so slice
      // past the last ')'. Remaining tokens start at field 3 (state); field 22
      // (starttime, jiffies since boot) is index 19 from there.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const starttime = Number(fields[19]);
      return Number.isFinite(starttime) ? starttime : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Lock-owner fingerprint for this process: `${pid}:${startTime}`. Throws (fail
 * loud) when the start time is unresolvable — never writes a `pid:0` fingerprint,
 * which a reaper would read as "some process born at boot" and could mis-reap.
 * `startTime` is injectable so the throw path is testable (mirrors Deps.getuid).
 * Plain Error, not EngineError: store.ts imports lock.ts, so importing it back
 * would be a cycle.
 */
export function lockOwner(startTime: () => number | null = processStartTime): string {
  const t = startTime();
  if (t === null) {
    throw new Error(
      `cannot resolve this process's start time (pid ${process.pid}); refusing to write a lock fingerprint`,
    );
  }
  return `${process.pid}:${t}`;
}

/** Parse a lock_owner string back into its parts. */
export function parseLockOwner(owner: string): { pid: number; startTime: number } {
  const [pid, startTime] = owner.split(':');
  return { pid: Number(pid), startTime: Number(startTime) };
}
