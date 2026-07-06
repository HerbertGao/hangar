import Database from 'better-sqlite3';
import { resolve } from 'node:path';

export type DB = Database.Database;

/**
 * The OS state store: exactly four tables (App / Run / RunEvent / Approval).
 * The spine knows no domain concepts — domain detail flows only through
 * RunEvent.payload_json. No 5th table; the run lock is a partial unique index.
 *
 * - Run.state is a cache column; the source of truth is always RunEvent.
 * - Run.lock_owner = `${pid}:${startTime}` (see lock.ts) so a reaper can tell a
 *   live holder from a dead one across PID reuse. NULL once the lock is released.
 * - RunEvent is append-only with UNIQUE(run_id, seq); seq is per-run from 1.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS App (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Run (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL,
  state      TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  lock_owner TEXT
);

CREATE TABLE IF NOT EXISTS RunEvent (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES Run(id),
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  at           TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS Approval (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES Run(id),
  tool         TEXT NOT NULL,
  args_json    TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT
);

-- run lock: at most one active (non-terminal) Run per app, enforced without a
-- 5th table. Terminal states release the lock by falling out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_active_lock
  ON Run (app_id)
  WHERE state NOT IN ('completed', 'failed', 'cancelled');
`;

/** Default state-store path: repo-root cwd, overridable via HANGAR_DB. */
export function resolveDbPath(): string {
  // ponytail: cwd-relative like package-lock/.git; override with HANGAR_DB.
  return process.env.HANGAR_DB ?? resolve(process.cwd(), 'hangar.sqlite');
}

/** Open (creating if absent) the state store and idempotently ensure schema. */
export function openDb(dbPath: string = resolveDbPath()): DB {
  const db = new Database(dbPath);
  // ponytail: force the DELETE rollback journal (no WAL). WAL mode is sticky in the db
  // header, so an EXISTING db built in WAL (an old version's or a stray test's
  // hangar.sqlite) stays WAL unless we explicitly convert it — merely relying on the
  // new-db default would leave those alone. Setting it explicitly flips such a db back
  // to DELETE (and clears its -wal/-shm), and is idempotent on new/already-DELETE dbs.
  // Why it matters: a read-only open of a WAL db still creates persistent root-owned
  // -wal/-shm sidecars (WAL needs O_RDWR|O_CREAT for -shm), so root running a read-only
  // command would leave files a later non-root `run` can't write. DELETE creates no
  // sidecar on read; busy_timeout covers the rare write overlap. Trade-off: no WAL
  // read/write concurrency — only matters for a daemon + concurrent CLIs (multi-process,
  // deferred to Phase 1). Re-add WAL there if needed.
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Open an EXISTING state store strictly read-only — no schema DDL, no writes, and
 * (because openDb uses the default DELETE journal, not WAL) no `-wal`/`-shm` sidecar.
 * Read-only commands + doctor use this so they never touch the db: openDb() would run
 * DDL and create the file if absent, and since those commands don't refuse root, a
 * root invocation could leave root-owned files a later non-root `run` can't write.
 */
export function openDbReadonly(dbPath: string = resolveDbPath()): DB {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
