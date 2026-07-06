import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { lockOwner } from './lock.js';
import {
  classify,
  EVENT,
  isTerminalKind,
  STATE_BY_KIND,
  type EventLike,
  type State,
} from './events.js';

/** Business-failure kinds surfaced to the CLI (exit code 1). */
export type ErrorKind =
  | 'already_running'
  | 'pipeline_missing'
  | 'executor_unsupported'
  | 'pipeline_invalid'
  | 'run_not_found'
  // gateway (C2) business failures, surfaced to the CLI with exit code 1
  | 'not_waiting'
  | 'no_pending_approval'
  | 'tool_handler_missing';

export class EngineError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = 'EngineError';
  }
}

const TERMINAL_STATES = ['completed', 'failed', 'cancelled'];
const now = (): string => new Date().toISOString();

function nextSeq(db: DB, runId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM RunEvent WHERE run_id=?`)
    .get(runId) as { n: number };
  return row.n;
}

function isConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * Create a Run and its `run.started` (seq=1) in ONE transaction, holding the app
 * lock (lock_owner = this process). A queued+locked orphan (0 events) is never
 * persisted — a crash between the two would otherwise wedge the app lock. Throws
 * EngineError('already_running') if the app already has an active (non-terminal)
 * run; the partial unique index backstops a lost check-and-insert race.
 */
export function createRun(db: DB, appId: string, trigger: string): string {
  const runId = `run_${randomUUID()}`;
  const tx = db.transaction(() => {
    const active = db
      .prepare(
        `SELECT id FROM Run WHERE app_id=? AND state NOT IN ('completed','failed','cancelled') LIMIT 1`,
      )
      .get(appId);
    if (active) {
      throw new EngineError('already_running', `app ${appId} already has an active run`);
    }
    const ts = now();
    db.prepare(
      `INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)`,
    ).run(runId, appId, STATE_BY_KIND[EVENT.runStarted], trigger, ts, lockOwner());
    db.prepare(
      `INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)`,
    ).run(`ev_${randomUUID()}`, runId, 1, EVENT.runStarted, '{}', ts);
  });
  try {
    tx();
  } catch (err) {
    if (err instanceof EngineError) throw err;
    if (isConstraintViolation(err)) {
      throw new EngineError('already_running', `app ${appId} already has an active run`);
    }
    throw err;
  }
  return runId;
}

/**
 * Append a NON-terminal event with seq = max(seq)+1 and advance the state cache.
 * Terminal `run.*` events must go through {@link chokePoint} (enforced here so the
 * single-choke-point invariant can't be bypassed). lock_owner is left untouched:
 * the lock rides on state, and reaper excludes waiting_human by state, not owner.
 */
export function appendEvent(db: DB, runId: string, kind: string, payload: object = {}): number {
  if (isTerminalKind(kind)) {
    throw new Error(`terminal event ${kind} must go through chokePoint, not appendEvent`);
  }
  const tx = db.transaction(() => {
    const seq = nextSeq(db, runId);
    db.prepare(
      `INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)`,
    ).run(`ev_${randomUUID()}`, runId, seq, kind, JSON.stringify(payload), now());
    const s = STATE_BY_KIND[kind];
    if (s !== undefined) db.prepare(`UPDATE Run SET state=? WHERE id=?`).run(s, runId);
    return seq;
  });
  return tx();
}

/**
 * The single terminal transition. In ONE transaction: append the terminal `run.*`
 * event, update the state cache + ended_at, release the app lock (state falls out
 * of the partial unique index; lock_owner → NULL), and supersede this run's still-
 * open approvals. The lock release does NOT check lock_owner==self — approve's
 * second-stage process (or reaper) may release a dead trigger's lock. Idempotent:
 * a no-op if the run is already terminal (guards against a double terminal event).
 */
export function chokePoint(
  db: DB,
  runId: string,
  terminalKind: string,
  payload: object = {},
): void {
  if (!isTerminalKind(terminalKind)) {
    throw new Error(`chokePoint requires a terminal run.* kind, got ${terminalKind}`);
  }
  const tx = db.transaction(() => {
    const run = db.prepare(`SELECT state FROM Run WHERE id=?`).get(runId) as
      | { state: string }
      | undefined;
    if (!run) throw new EngineError('run_not_found', runId);
    if (TERMINAL_STATES.includes(run.state)) return; // already terminal → idempotent
    const ts = now();
    db.prepare(
      `INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)`,
    ).run(`ev_${randomUUID()}`, runId, nextSeq(db, runId), terminalKind, JSON.stringify(payload), ts);
    db.prepare(`UPDATE Run SET state=?, ended_at=?, lock_owner=NULL WHERE id=?`).run(
      STATE_BY_KIND[terminalKind],
      ts,
      runId,
    );
    db.prepare(
      `UPDATE Approval SET status='superseded', decided_at=? WHERE run_id=? AND status IN ('pending','granting')`,
    ).run(ts, runId);
  });
  tx();
}

/** Recompute a run's state from its events (the `runId` form of classify). */
export function stateOf(db: DB, runId: string): State {
  const events = db
    .prepare(`SELECT seq, kind FROM RunEvent WHERE run_id=? ORDER BY seq`)
    .all(runId) as EventLike[];
  return classify(events);
}
