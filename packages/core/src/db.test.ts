import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, openDbReadonly } from './db.js';
import { lockOwner, parseLockOwner, processStartTime } from './lock.js';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-test-'));
  return openDb(join(dir, 'hangar.sqlite'));
}

test('four tables exist', () => {
  const db = tmpDb();
  const names = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  for (const t of ['App', 'Run', 'RunEvent', 'Approval']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test('tables are readable/writable', () => {
  const db = tmpDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO App (id,name,registered_at) VALUES (?,?,?)').run(
    'heartbeat',
    'Heartbeat',
    now,
  );
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('run_1', 'heartbeat', 'running', 'manual', now, lockOwner());
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('ev_1', 'run_1', 1, 'run.started', '{}', now);
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('apr_1', 'run_1', 'fake.send', '{}', 'pending', now);
  const c = (db.prepare('SELECT count(*) c FROM RunEvent').get() as { c: number }).c;
  assert.equal(c, 1);
  db.close();
});

test('UNIQUE(run_id, seq) rejects duplicate seq', () => {
  const db = tmpDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at) VALUES (?,?,?,?,?)',
  ).run('run_2', 'heartbeat', 'running', 'manual', now);
  const ins = db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,at) VALUES (?,?,?,?,?)',
  );
  ins.run('ev_a', 'run_2', 1, 'run.started', now);
  assert.throws(
    () => ins.run('ev_b', 'run_2', 1, 'action.executed', now),
    /UNIQUE/,
  );
  db.close();
});

test('run lock: one active run per app; terminal frees it', () => {
  const db = tmpDb();
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at) VALUES (?,?,?,?,?)',
  );
  ins.run('run_3', 'heartbeat', 'running', 'manual', now);
  assert.throws(
    () => ins.run('run_4', 'heartbeat', 'running', 'manual', now),
    /UNIQUE/,
  );
  db.prepare(`UPDATE Run SET state='completed' WHERE id='run_3'`).run();
  assert.doesNotThrow(() =>
    ins.run('run_5', 'heartbeat', 'running', 'manual', now),
  );
  db.close();
});

test('lock owner fingerprint round-trips', () => {
  const owner = lockOwner();
  const { pid, startTime } = parseLockOwner(owner);
  assert.equal(pid, process.pid);
  assert.equal(startTime, processStartTime() ?? 0);
  assert.notEqual(processStartTime(), null, 'own start time resolvable');
});

test('lockOwner throws (never writes a pid:0 fingerprint) when start time is unresolvable', () => {
  assert.throws(() => lockOwner(() => null), /start time/);
});

// ── R4-F1: openDb converts an EXISTING WAL db to DELETE (not just default new dbs) ─
// WAL is sticky in the db header, so a db previously built in WAL (old version / stray
// test) stays WAL when reopened unless openDb explicitly converts it. If it stayed WAL,
// a later read-only open would spawn persistent root-owned -wal/-shm sidecars a non-root
// `run` can't write. This is the coverage the new-db-only DELETE test could not give.
test('openDb converts an existing WAL db to DELETE (no sidecar on a later read)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-test-'));
  const dbPath = join(dir, 'hangar.sqlite');
  // Simulate a legacy db left in WAL mode.
  const legacy = new Database(dbPath);
  assert.equal(legacy.pragma('journal_mode = WAL', { simple: true }), 'wal');
  legacy.exec('CREATE TABLE t (x)');
  legacy.prepare('INSERT INTO t (x) VALUES (1)').run();
  legacy.close();

  // Production openDb must flip the header back to DELETE — would be 'wal' without the
  // explicit pragma (i.e. this assertion is the regression guard).
  const db = openDb(dbPath);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'delete', 'existing WAL db not converted');
  db.close();

  // A subsequent read-only command leaves no -wal/-shm sidecar.
  const ro = openDbReadonly(dbPath);
  ro.prepare('SELECT count(*) FROM Run').get();
  ro.close();
  assert.equal(existsSync(dbPath + '-wal'), false, 'no -wal sidecar after DELETE conversion');
  assert.equal(existsSync(dbPath + '-shm'), false, 'no -shm sidecar after DELETE conversion');
});
