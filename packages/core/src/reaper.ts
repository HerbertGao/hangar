import type { DB } from './db.js';
import { parseLockOwner, processStartTime } from './lock.js';
import { EVENT } from './events.js';
import { chokePoint } from './store.js';

/**
 * True if the lock_owner fingerprint (`pid:startTime`) does NOT match a live
 * process — either no process with that pid, or the pid was reused by a different
 * process (start time differs). Comparing the start time is what defeats PID
 * reuse: a bare-pid check would see the reused pid as alive and leak the lock.
 */
function isDead(owner: string): boolean {
  const { pid, startTime } = parseLockOwner(owner);
  if (!Number.isFinite(pid)) return true;
  const live = processStartTime(pid);
  if (live === null) return true; // no such process
  return live !== startTime; // pid reused by an unrelated process
}

/**
 * Reap crashed orphan runs. Any non-terminal run (queued/running/executing) whose
 * lock_owner is a dead process is driven to `run.failed` through the single
 * choke-point (releasing its lock + superseding its approvals). `waiting_human`
 * runs hold no process and are intentionally parked, so they are left alone.
 *
 * Call ONLY from write-command startup (run/approve/reject/daemon); doctor and
 * read-only commands must not run it (they must not write the DB). This also
 * reclaims an approve that crashed in its second stage — it had taken the lock,
 * so lock_owner points at the dead approve process. Returns the reaped run ids.
 */
export function reap(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT id, lock_owner FROM Run
       WHERE state IN ('queued','running','executing') AND lock_owner IS NOT NULL`,
    )
    .all() as { id: string; lock_owner: string }[];
  const reaped: string[] = [];
  for (const r of rows) {
    if (isDead(r.lock_owner)) {
      chokePoint(db, r.id, EVENT.runFailed, { reason: 'reaped', owner: r.lock_owner });
      reaped.push(r.id);
    }
  }
  return reaped;
}
