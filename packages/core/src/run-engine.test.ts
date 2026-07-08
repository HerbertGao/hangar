import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from './db.js';
import { lockOwner } from './lock.js';
import { processStartTime } from './lock.js';
import { classify, EVENT } from './events.js';
import { appendEvent, chokePoint, createRun, EngineError, stateOf } from './store.js';
import { reap } from './reaper.js';
import { runApp, type Gateway } from './executor.js';

function tmpDb(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-re-'));
  return openDb(join(dir, 'hangar.sqlite'));
}

function runState(db: DB, runId: string): string {
  return (db.prepare('SELECT state FROM Run WHERE id=?').get(runId) as { state: string }).state;
}
function lockOf(db: DB, runId: string): string | null {
  return (db.prepare('SELECT lock_owner FROM Run WHERE id=?').get(runId) as { lock_owner: string | null })
    .lock_owner;
}

// ── classify: full map, action.* non-terminal, only run.* terminal ──────────
test('classify: action.failed is non-terminal (executing), only run.* terminal', () => {
  assert.equal(classify([]), 'queued');
  assert.equal(classify([{ seq: 1, kind: EVENT.runStarted }]), 'running');
  assert.equal(
    classify([
      { seq: 1, kind: EVENT.runStarted },
      { seq: 2, kind: EVENT.actionFailed },
    ]),
    'executing',
    'action.failed must NOT terminate the run',
  );
  assert.equal(
    classify([
      { seq: 1, kind: EVENT.runStarted },
      { seq: 2, kind: EVENT.actionExecuted },
      { seq: 3, kind: EVENT.runCompleted },
    ]),
    'completed',
  );
  // domain event as latest does not regress or terminate the lifecycle state
  assert.equal(
    classify([
      { seq: 1, kind: EVENT.runStarted },
      { seq: 2, kind: EVENT.actionExecuted },
      { seq: 3, kind: 'domain.progress' },
    ]),
    'executing',
    'domain kinds are stepped over',
  );
});

// ── createRun + appendEvent: same-txn, seq bump, run lock ────────────────────
test('createRun: same-txn run.started seq=1, running, holds lock; already_running', () => {
  const db = tmpDb();
  const runId = createRun(db, 'heartbeat', 'manual');
  assert.equal(runState(db, runId), 'running');
  assert.equal(stateOf(db, runId), 'running');
  const ev = db.prepare('SELECT seq, kind FROM RunEvent WHERE run_id=? ORDER BY seq').all(runId);
  assert.deepEqual(ev, [{ seq: 1, kind: EVENT.runStarted }]);
  assert.ok(lockOf(db, runId), 'lock_owner set on create');

  // second active run for same app is rejected
  assert.throws(
    () => createRun(db, 'heartbeat', 'manual'),
    (e: unknown) => e instanceof EngineError && e.kind === 'already_running',
  );

  // appendEvent bumps seq and advances the state cache
  const seq = appendEvent(db, runId, EVENT.actionExecuted, { tool: 'fake' });
  assert.equal(seq, 2);
  assert.equal(runState(db, runId), 'executing');

  // terminal kinds must not go through appendEvent
  assert.throws(() => appendEvent(db, runId, EVENT.runCompleted));
  db.close();
});

// ── choke-point: releases lock + supersedes approvals + idempotent ──────────
test('chokePoint: frees lock, supersedes pending/granting approvals, idempotent', () => {
  const db = tmpDb();
  const runId = createRun(db, 'heartbeat', 'manual');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('ap1', runId, 'fake.send', '{}', 'pending', now);
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('ap2', runId, 'fake.send', '{}', 'granting', now);

  chokePoint(db, runId, EVENT.runFailed, { error: 'x' });

  assert.equal(runState(db, runId), 'failed');
  assert.equal(lockOf(db, runId), null, 'lock released without checking owner==self');
  const statuses = (
    db.prepare('SELECT status FROM Approval WHERE run_id=? ORDER BY id').all(runId) as {
      status: string;
    }[]
  ).map((r) => r.status);
  assert.deepEqual(statuses, ['superseded', 'superseded']);

  // lock freed → a new run for the same app is now allowed
  assert.doesNotThrow(() => createRun(db, 'heartbeat', 'manual'));

  // idempotent: a second choke-point is a no-op (no duplicate terminal event)
  const before = db.prepare('SELECT count(*) c FROM RunEvent WHERE run_id=?').get(runId) as {
    c: number;
  };
  chokePoint(db, runId, EVENT.runCancelled, {});
  const after = db.prepare('SELECT count(*) c FROM RunEvent WHERE run_id=?').get(runId) as {
    c: number;
  };
  assert.equal(after.c, before.c, 'already-terminal choke-point adds no event');
  assert.equal(runState(db, runId), 'failed');
  db.close();
});

// ── reaper: dead PID reaped, PID reuse detected, live untouched ──────────────
test('reap: dead lock_owner reclaimed, PID-reuse detected, live & waiting_human left', () => {
  const db = tmpDb();
  const now = new Date().toISOString();
  const mkRun = (id: string, app: string, state: string, owner: string | null) => {
    db.prepare(
      'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
    ).run(id, app, state, 'manual', now, owner);
    db.prepare(
      'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
    ).run('ev_' + id, id, 1, EVENT.runStarted, '{}', now);
  };

  // dead: no such process
  mkRun('dead', 'a', 'running', '999999:123456');
  // PID reuse: our live pid but a wrong start time → same pid, different process
  mkRun('reused', 'b', 'executing', `${process.pid}:1`);
  // live: genuine current fingerprint → must survive
  mkRun('live', 'c', 'running', lockOwner());
  // parked: waiting_human holds no process → never reaped even with a dead owner
  mkRun('parked', 'd', 'waiting_human', '999999:123456');

  const reaped = reap(db).sort();
  assert.deepEqual(reaped, ['dead', 'reused']);
  assert.equal(runState(db, 'dead'), 'failed');
  assert.equal(runState(db, 'reused'), 'failed', 'PID reuse must not read as alive');
  assert.equal(lockOf(db, 'dead'), null);
  assert.equal(runState(db, 'live'), 'running', 'live process run untouched');
  assert.equal(runState(db, 'parked'), 'waiting_human', 'parked run untouched');

  // sanity: our own start time resolves (so `live` really is judged alive)
  assert.notEqual(processStartTime(), null);
  db.close();
});

test('reap: reclaims a crashed approve (executing + dead owner) and voids its approval', () => {
  const db = tmpDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('r', 'a', 'executing', 'manual', now, '999999:123456');
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('e', 'r', 1, EVENT.runStarted, '{}', now);
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('ap', 'r', 'fake.send', '{}', 'granting', now);

  assert.deepEqual(reap(db), ['r']);
  assert.equal(runState(db, 'r'), 'failed');
  assert.equal(
    (db.prepare('SELECT status FROM Approval WHERE id=?').get('ap') as { status: string }).status,
    'superseded',
  );
  db.close();
});

// ── executor / runApp end-to-end ────────────────────────────────────────────
function stubGateway(db: DB): { gw: Gateway; calls: { propose: number; evaluate: number } } {
  const calls = { propose: 0, evaluate: 0 };
  const gw: Gateway = {
    async propose() {
      calls.propose++;
      return { ok: true };
    },
    async evaluateAfterRun(runId) {
      calls.evaluate++;
      chokePoint(db, runId, EVENT.runCompleted, {});
    },
    async approve() {},
    async reject() {},
  };
  return { gw, calls };
}

function appDirWith(pipeline: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-app-'));
  writeFileSync(join(dir, 'pipeline.ts'), pipeline);
  return dir;
}

test('runApp: pipeline runs, gateway.evaluateAfterRun decides completion', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  const dir = appDirWith(
    `export async function run(ctx) {
       ctx.emit('domain.tick', { n: 1 });
       await ctx.propose({ tool: 'fake.send', args: {} });
     }`,
  );
  const runId = await runApp(db, { appId: 'heartbeat', appDir: dir, executor: 'pipeline' }, gw);
  assert.equal(calls.propose, 1);
  assert.equal(calls.evaluate, 1);
  assert.equal(runState(db, runId), 'completed');
  const kinds = (
    db.prepare('SELECT kind FROM RunEvent WHERE run_id=? ORDER BY seq').all(runId) as {
      kind: string;
    }[]
  ).map((r) => r.kind);
  assert.deepEqual(kinds, [EVENT.runStarted, 'domain.tick', EVENT.runCompleted]);
  db.close();
});

test('runApp: a thrown pipeline goes to run.failed via choke-point (PARK is not a throw)', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  const dir = appDirWith(`export async function run() { throw new Error('boom'); }`);
  const runId = await runApp(db, { appId: 'hb', appDir: dir, executor: 'pipeline' }, gw);
  assert.equal(runState(db, runId), 'failed');
  assert.equal(lockOf(db, runId), null, 'failed run releases the lock');
  assert.equal(calls.evaluate, 0, 'evaluateAfterRun is not called on failure');
  db.close();
});

test('runApp: missing pipeline.ts is rejected before the Run is created', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const dir = mkdtempSync(join(tmpdir(), 'hangar-empty-')); // no pipeline.ts
  await assert.rejects(
    runApp(db, { appId: 'hb', appDir: dir, executor: 'pipeline' }, gw),
    (e: unknown) => e instanceof EngineError && e.kind === 'pipeline_missing',
  );
  assert.equal((db.prepare('SELECT count(*) c FROM Run').get() as { c: number }).c, 0);
  db.close();
});

test('runApp: dist/pipeline.js is preferred over a sibling pipeline.ts', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const dir = mkdtempSync(join(tmpdir(), 'hangar-app-'));
  // realistic compiled external pilot: own package.json (ESM) + dist/pipeline.js
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'pipeline.ts'), `export async function run(ctx) { ctx.emit('from.ts'); }`);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'pipeline.js'), `export async function run(ctx) { ctx.emit('from.dist'); }`);
  const runId = await runApp(db, { appId: 'inbox', appDir: dir, executor: 'pipeline' }, gw);
  const kinds = (
    db.prepare('SELECT kind FROM RunEvent WHERE run_id=? ORDER BY seq').all(runId) as {
      kind: string;
    }[]
  ).map((r) => r.kind);
  assert.ok(kinds.includes('from.dist'), 'ran the compiled dist/pipeline.js entry');
  assert.ok(!kinds.includes('from.ts'), 'did not run the flat pipeline.ts entry');
  db.close();
});

test('runApp: triggerName threads to ctx.trigger + Run.trigger (name priority); absent → undefined/category', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const seeTrigger = `export async function run(ctx){ ctx.emit('saw', { t: ctx.trigger ?? null }); }`;
  const sawTrigger = (runId: string): unknown =>
    JSON.parse(
      (db.prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='saw'").get(runId) as { p: string }).p,
    ).t;
  const runTrigger = (runId: string): string =>
    (db.prepare('SELECT trigger FROM Run WHERE id=?').get(runId) as { trigger: string }).trigger;

  // named trigger → ctx.trigger === name, Run.trigger stores the name
  const r1 = await runApp(
    db,
    { appId: 'a1', appDir: appDirWith(seeTrigger), executor: 'pipeline', trigger: 'cron', triggerName: 'digest' },
    gw,
  );
  assert.equal(sawTrigger(r1), 'digest', 'ctx.trigger === triggerName');
  assert.equal(runTrigger(r1), 'digest', 'Run.trigger stores the name (trace attribution)');

  // no triggerName → ctx.trigger undefined, Run.trigger falls back to the category
  const r2 = await runApp(
    db,
    { appId: 'a2', appDir: appDirWith(seeTrigger), executor: 'pipeline', trigger: 'cron' },
    gw,
  );
  assert.equal(sawTrigger(r2), null, 'absent triggerName → ctx.trigger undefined');
  assert.equal(runTrigger(r2), 'cron', 'Run.trigger falls back to category when no name');
  db.close();
});

test('runApp: unknown executor → executor_unsupported, no Run created', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  await assert.rejects(
    runApp(db, { appId: 'hb', appDir: '/nope', executor: 'claude-code' }, gw),
    (e: unknown) => e instanceof EngineError && e.kind === 'executor_unsupported',
  );
  assert.equal((db.prepare('SELECT count(*) c FROM Run').get() as { c: number }).c, 0);
  db.close();
});
