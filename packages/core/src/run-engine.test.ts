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
import { HOST_CAPABILITIES } from './capabilities.js';
import { doctorReport } from './cli.js';

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
  const runId = await runApp(db, { appId: 'heartbeat', appDir: dir, executor: 'pipeline', triggerKind: 'manual' }, gw);
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
  const runId = await runApp(db, { appId: 'hb', appDir: dir, executor: 'pipeline', triggerKind: 'manual' }, gw);
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
    runApp(db, { appId: 'hb', appDir: dir, executor: 'pipeline', triggerKind: 'manual' }, gw),
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
  const runId = await runApp(db, { appId: 'inbox', appDir: dir, executor: 'pipeline', triggerKind: 'manual' }, gw);
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
    { appId: 'a1', appDir: appDirWith(seeTrigger), executor: 'pipeline', triggerKind: 'cron', triggerName: 'digest' },
    gw,
  );
  assert.equal(sawTrigger(r1), 'digest', 'ctx.trigger === triggerName');
  assert.equal(runTrigger(r1), 'digest', 'Run.trigger stores the name (trace attribution)');

  // no triggerName → ctx.trigger undefined, Run.trigger falls back to the category
  const r2 = await runApp(
    db,
    { appId: 'a2', appDir: appDirWith(seeTrigger), executor: 'pipeline', triggerKind: 'cron' },
    gw,
  );
  assert.equal(sawTrigger(r2), null, 'absent triggerName → ctx.trigger undefined');
  assert.equal(runTrigger(r2), 'cron', 'Run.trigger falls back to category when no name');
  db.close();
});

// ── 4.4 plumbing: runApp threads req.triggerKind/triggerName onto ctx ─────────
// This proves the executor faithfully PASSES the host-written kind onto the ctx — NOT that
// the kind is unforgeable. At this layer triggerKind is just a literal we hand to runApp, so
// asserting it here is plumbing only; unforgeability is proven at the CLI/daemon entries
// (cli.test.ts: run --trigger is always manual; daemonRunOne is always cron).
test('runApp: threads req.triggerKind/triggerName onto ctx (plumbing, not an unforgeability proof)', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const seeKind = `export async function run(ctx){ ctx.emit('saw', { kind: ctx.triggerKind, name: ctx.triggerName ?? null, trigger: ctx.trigger ?? null }); }`;
  const saw = (runId: string): { kind: string; name: string | null; trigger: string | null } =>
    JSON.parse(
      (db.prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='saw'").get(runId) as { p: string }).p,
    );
  const runId = await runApp(
    db,
    { appId: 'a', appDir: appDirWith(seeKind), executor: 'pipeline', triggerKind: 'cron', triggerName: 'digest' },
    gw,
  );
  assert.equal(saw(runId).kind, 'cron', 'ctx.triggerKind === req.triggerKind');
  assert.equal(saw(runId).name, 'digest', 'ctx.triggerName === req.triggerName');
  assert.equal(saw(runId).trigger, 'digest', 'ctx.trigger (deprecated) still mirrors triggerName');
  db.close();
});

test('runApp: each run gets a fresh frozen canonical capability snapshot that app data cannot replace', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const dir = appDirWith(`
    let previous;
    export async function run(ctx) {
      let writeThrew = false;
      let deleteThrew = false;
      let sortThrew = false;
      const canonical = [...ctx.capabilities];
      try { ctx.capabilities[0] = 'forged'; } catch { writeThrew = true; }
      const writeIneffective = ctx.capabilities[0] === canonical[0];
      try { delete ctx.capabilities[0]; } catch { deleteThrew = true; }
      const deleteIneffective = ctx.capabilities.length === canonical.length && ctx.capabilities[0] === canonical[0];
      try { ctx.capabilities.sort(); } catch { sortThrew = true; }
      const sortIneffective = JSON.stringify(ctx.capabilities) === JSON.stringify(canonical);
      ctx.emit('saw.capabilities', {
        capabilities: [...ctx.capabilities],
        frozen: Object.isFrozen(ctx.capabilities),
        sameAsPrevious: previous === ctx.capabilities,
        writeThrew,
        writeIneffective,
        deleteThrew,
        deleteIneffective,
        sortThrew,
        sortIneffective,
        inputCapabilities: ctx.input?.capabilities,
        configCapabilities: ctx.config?.capabilities,
      });
      previous = ctx.capabilities;
    }
  `);
  const request = {
    appId: 'caps',
    appDir: dir,
    executor: 'pipeline',
    triggerKind: 'manual' as const,
    triggerName: 'runtime-capabilities',
    input: { capabilities: ['input-forged'] },
    config: { capabilities: ['config-forged'] },
    capabilities: ['request-forged'],
  };

  const first = await runApp(db, request, gw);
  const second = await runApp(db, request, gw);
  const seen = (runId: string) => JSON.parse(
    (db.prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='saw.capabilities'").get(runId) as { p: string }).p,
  ) as {
    capabilities: string[];
    frozen: boolean;
    sameAsPrevious: boolean;
    writeThrew: boolean;
    writeIneffective: boolean;
    deleteThrew: boolean;
    deleteIneffective: boolean;
    sortThrew: boolean;
    sortIneffective: boolean;
    inputCapabilities: string[];
    configCapabilities: string[];
  };

  for (const observation of [seen(first), seen(second)]) {
    assert.deepEqual(observation.capabilities, HOST_CAPABILITIES);
    assert.equal(observation.frozen, true);
    assert.equal(observation.sameAsPrevious, false, 'every run receives a fresh array reference');
    assert.ok(observation.writeThrew || observation.writeIneffective, 'index write throws or is ineffective');
    assert.ok(observation.deleteThrew || observation.deleteIneffective, 'delete throws or is ineffective');
    assert.ok(observation.sortThrew || observation.sortIneffective, 'sort throws or is ineffective');
    assert.deepEqual(observation.inputCapabilities, ['input-forged']);
    assert.deepEqual(observation.configCapabilities, ['config-forged']);
  }
  assert.deepEqual(HOST_CAPABILITIES, [
    'hangar.run.trigger-kind/v1',
    'hangar.run.abort-signal/v1',
    'hangar.run.cancelled-terminal/v1',
    'hangar.run.runtime-capabilities/v1',
  ], 'snapshot mutation attempts do not alter the canonical set');
  const doctorCapabilities = doctorReport().capabilities;
  assert.strictEqual(
    doctorCapabilities,
    HOST_CAPABILITIES,
    'the real doctor report still reads the same canonical module instance',
  );
  assert.equal(Object.isFrozen(doctorCapabilities), true);
  assert.deepEqual(doctorCapabilities, [
    'hangar.run.trigger-kind/v1',
    'hangar.run.abort-signal/v1',
    'hangar.run.cancelled-terminal/v1',
    'hangar.run.runtime-capabilities/v1',
  ], 'runtime mutation attempts do not pollute doctor output');
  db.close();
});

test('runApp: unknown executor → executor_unsupported, no Run created', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  await assert.rejects(
    runApp(db, { appId: 'hb', appDir: '/nope', executor: 'claude-code', triggerKind: 'manual' }, gw),
    (e: unknown) => e instanceof EngineError && e.kind === 'executor_unsupported',
  );
  assert.equal((db.prepare('SELECT count(*) c FROM Run').get() as { c: number }).c, 0);
  db.close();
});

// ── 5.1/5.2/5.6 cancellation: abort → single run.cancelled terminal ───────────
/** The only terminal events on a run (run.started is non-terminal). Exactly one is
 *  ever allowed through the choke-point, so this doubles as the "single writer" check. */
function terminalKinds(db: DB, runId: string): string[] {
  return (
    db
      .prepare(
        "SELECT kind FROM RunEvent WHERE run_id=? AND kind IN ('run.completed','run.failed','run.cancelled') ORDER BY seq",
      )
      .all(runId) as { kind: string }[]
  ).map((r) => r.kind);
}
function insertPendingApproval(db: DB, runId: string): void {
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run(`ap_${runId}`, runId, 'fake.send', '{}', 'pending', new Date().toISOString());
}
function approvalStatuses(db: DB, runId: string): string[] {
  return (
    db.prepare('SELECT status FROM Approval WHERE run_id=? ORDER BY id').all(runId) as {
      status: string;
    }[]
  ).map((r) => r.status);
}
/** Yield until the pipeline has emitted `kind` — proof it is genuinely mid-run (parked). */
async function waitEvent(db: DB, runId: string, kind: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (db.prepare('SELECT 1 FROM RunEvent WHERE run_id=? AND kind=?').get(runId, kind)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timeout waiting for ${kind}`);
}

// A pipeline that parks on the abort signal (with an entry guard for abort-before-park)
// and rejects when cancelled — the cooperative shape a real trusted pilot uses.
const PARK_UNTIL_ABORT = `export async function run(ctx){
  ctx.emit('domain.ready', {});
  await new Promise((_res, reject) => {
    if (ctx.signal.aborted) return reject(new Error('cancelled'));
    ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
}`;

test('5.1 runApp: pre-aborted run (pipeline throws) → single run.cancelled, lock freed, pending approval superseded', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  const dir = appDirWith(
    `export async function run(ctx){ if (ctx.signal.aborted) throw new Error('pre-aborted boom'); ctx.emit('ran', {}); }`,
  );
  let runId!: string;
  await runApp(
    db,
    { appId: 'a', appDir: dir, executor: 'pipeline', triggerKind: 'manual' },
    gw,
    { onActive: (id, abort) => { runId = id; insertPendingApproval(db, id); abort(); } }, // abort before the pipeline body
  );
  assert.equal(runState(db, runId), 'cancelled');
  assert.deepEqual(terminalKinds(db, runId), ['run.cancelled'], 'aborted throw → cancelled, not failed');
  assert.equal(lockOf(db, runId), null, 'cancel releases the lock');
  assert.deepEqual(approvalStatuses(db, runId), ['superseded'], 'pending approval superseded on cancel');
  assert.equal(calls.evaluate, 0, 'aborted run never reaches evaluateAfterRun');
  db.close();
});

test('5.1 runApp: aborted run that RETURNS normally records cancelled (evaluate-guard), never completed', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  // observes abort but returns normally (no throw); without the pre-evaluate guard this would complete.
  const dir = appDirWith(
    `export async function run(ctx){ if (ctx.signal.aborted) return; ctx.emit('would.complete', {}); }`,
  );
  let runId!: string;
  await runApp(
    db,
    { appId: 'a', appDir: dir, executor: 'pipeline', triggerKind: 'manual' },
    gw,
    { onActive: (id, abort) => { runId = id; abort(); } },
  );
  assert.equal(runState(db, runId), 'cancelled', 'normal return under abort → cancelled, not completed');
  assert.deepEqual(terminalKinds(db, runId), ['run.cancelled']);
  assert.equal(calls.evaluate, 0, 'evaluate-guard skips evaluateAfterRun when aborted');
  assert.equal(lockOf(db, runId), null);
  db.close();
});

test('5.1/5.6 runApp: mid-run abort → single run.cancelled (no later completed/failed), lock freed once, approval superseded', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  const dir = appDirWith(PARK_UNTIL_ABORT);
  let runId!: string;
  let abortFn!: () => void;
  const p = runApp(
    db,
    { appId: 'a', appDir: dir, executor: 'pipeline', triggerKind: 'manual' },
    gw,
    { onActive: (id, abort) => { runId = id; abortFn = abort; insertPendingApproval(db, id); } },
  );
  await waitEvent(db, runId, 'domain.ready'); // pipeline is genuinely parked mid-run
  abortFn();
  await p;
  assert.equal(runState(db, runId), 'cancelled');
  // 5.6 single-writer: exactly one terminal, cancelled — nothing written after it.
  assert.deepEqual(terminalKinds(db, runId), ['run.cancelled'], '5.6: no run.completed/run.failed after cancel');
  assert.equal(lockOf(db, runId), null, '5.6: lock released once (single terminal = single release)');
  assert.deepEqual(approvalStatuses(db, runId), ['superseded']);
  assert.equal(calls.evaluate, 0);
  db.close();
});

test('5.1 runApp: aborting twice / a redundant late terminal → still a single run.cancelled (idempotent)', async () => {
  const db = tmpDb();
  const { gw } = stubGateway(db);
  const dir = appDirWith(PARK_UNTIL_ABORT);
  let runId!: string;
  let abortFn!: () => void;
  const p = runApp(
    db,
    { appId: 'a', appDir: dir, executor: 'pipeline', triggerKind: 'manual' },
    gw,
    { onActive: (id, abort) => { runId = id; abortFn = abort; } },
  );
  await waitEvent(db, runId, 'domain.ready');
  abortFn();
  abortFn(); // second abort on the same controller is a no-op
  await p;
  chokePoint(db, runId, EVENT.runCancelled, {}); // a late duplicate terminal is a no-op too
  assert.equal(runState(db, runId), 'cancelled');
  assert.deepEqual(terminalKinds(db, runId), ['run.cancelled'], 'repeat cancel never doubles the terminal event');
  db.close();
});

test('5.2 runApp: a pipeline that ignores ctx.signal still runs to natural completion (no regression)', async () => {
  const db = tmpDb();
  const { gw, calls } = stubGateway(db);
  const dir = appDirWith(
    `export async function run(ctx){ ctx.emit('sig', { has: typeof ctx.signal !== 'undefined', aborted: ctx.signal.aborted }); }`,
  );
  const runId = await runApp(
    db,
    { appId: 'a', appDir: dir, executor: 'pipeline', triggerKind: 'manual' },
    gw,
  );
  assert.equal(runState(db, runId), 'completed', 'signal field present but unread → still completes');
  assert.equal(calls.evaluate, 1, 'no abort → normal evaluateAfterRun path');
  assert.deepEqual(terminalKinds(db, runId), ['run.completed']);
  const sig = JSON.parse(
    (db.prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='sig'").get(runId) as {
      p: string;
    }).p,
  );
  assert.equal(sig.has, true, 'ctx.signal is delivered to the pipeline');
  assert.equal(sig.aborted, false, 'unaborted run sees signal.aborted === false');
  db.close();
});
