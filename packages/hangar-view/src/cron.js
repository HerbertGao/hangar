// View-side cron period computation. ZERO import of @hangar/core — this ~15-line
// module re-implements the algorithm hangar's own cli.ts uses (node-cron
// createTask.getNextRuns), because the view承诺零 import core (invariant #1 边界).
//
// Handles the `schedule: string | string[]` union: an array (one trigger, many
// cron times, e.g. inbox digest 三个 cron 时刻) collapses to the MIN period — the
// most aggressive "overdue if the fastest one slipped" rule (same as core).
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';

/**
 * Exact period (ms) between consecutive fires of a cron schedule, or null if the
 * expression is invalid / can't be probed. node-cron's getNextRuns(2) gives the
 * real gap — no cron-arithmetic guesswork.
 */
export function cronPeriodMs(schedule, timezone) {
  const one = (s) => {
    try {
      const opts = timezone
        ? { timezone, name: `view_${randomUUID()}` }
        : { name: `view_${randomUUID()}` };
      const task = cron.createTask(s, () => {}, opts);
      const runs = task.getNextRuns(2);
      task.destroy();
      return runs && runs.length === 2 ? runs[1].getTime() - runs[0].getTime() : null;
    } catch {
      return null;
    }
  };
  const periods = (Array.isArray(schedule) ? schedule : [schedule])
    .map(one)
    .filter((p) => p != null);
  return periods.length ? Math.min(...periods) : null;
}
