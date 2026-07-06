import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from './db.js';
import { EVENT } from './events.js';
import { createRun, EngineError } from './store.js';
import { runApp } from './executor.js';
import { PipelineGateway, redactError } from './gateway.js';

function tmpDb(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-gw-'));
  return openDb(join(dir, 'hangar.sqlite'));
}
function runState(db: DB, runId: string): string {
  return (db.prepare('SELECT state FROM Run WHERE id=?').get(runId) as { state: string }).state;
}
function eventKinds(db: DB, runId: string): string[] {
  return (db.prepare('SELECT kind FROM RunEvent WHERE run_id=? ORDER BY seq').all(runId) as {
    kind: string;
  }[]).map((r) => r.kind);
}
function approvalStatuses(db: DB, runId: string): string[] {
  return (db.prepare('SELECT status FROM Approval WHERE run_id=? ORDER BY id').all(runId) as {
    status: string;
  }[]).map((r) => r.status);
}
// Approval ids are random UUIDs, so status-by-position is non-deterministic;
// key on the distinguishing `to` arg for order-independent assertions.
function approvalStatusByTo(db: DB, runId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT args_json, status FROM Approval WHERE run_id=?')
    .all(runId) as { args_json: string; status: string }[];
  return Object.fromEntries(rows.map((r) => [JSON.parse(r.args_json).to, r.status]));
}
function markerLines(marker: string): { to: string; key: string | null }[] {
  if (!existsSync(marker)) return [];
  const body = readFileSync(marker, 'utf8').trim();
  return body ? body.split('\n').map((l) => JSON.parse(l)) : [];
}

// A fixture app: pipeline proposes two 'fake.send' actions; the handler produces
// an observable side effect (a marker line) so DoD can prove execute really ran.
function appFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-gw-app-'));
  writeFileSync(
    join(dir, 'pipeline.ts'),
    `export async function run(ctx) {
       ctx.emit('domain.tick', { n: 1 });
       const r1 = await ctx.propose({ tool: 'fake.send', args: { to: 'a', marker: ctx.config.marker } });
       ctx.emit('propose.result', { r: r1 });
       await ctx.propose({ tool: 'fake.send', args: { to: 'b', marker: ctx.config.marker, fail: !!ctx.config.failSecond } });
     }`,
  );
  writeFileSync(
    join(dir, 'tools.ts'),
    `import { appendFileSync } from 'node:fs';
     export const tools = {
       'fake.send': async (args, ctx) => {
         if (args.fail) throw new Error('send failed: token=abcdef1234567890 leaked');
         appendFileSync(args.marker, JSON.stringify({ to: args.to, key: ctx.idempotencyKey ?? null }) + '\\n');
         return { sent: args.to };
       },
     };`,
  );
  return dir;
}

function markerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hangar-gw-mk-')), 'marker.log');
}

// ── redactError: generic, no domain regex ───────────────────────────────────
test('redactError strips secrets without any domain-specific regex', () => {
  assert.ok(!redactError(new Error('boom token=SECRET123456')).includes('SECRET123456'));
  assert.ok(!redactError('authorization: bearer abc.def.ghi').toLowerCase().includes('abc.def.ghi'));
  assert.equal(redactError(new Error('plain failure')), 'plain failure');
});

// ── PARK end-to-end: multi propose → park → approve → execute → completed ────
test('PARK end-to-end: two high-risk proposes park, approve runs both handlers, run completes', async () => {
  const db = tmpDb();
  const dir = appFixture();
  const marker = markerPath();
  const gw = new PipelineGateway(db, dir, ['fake.send']);

  const runId = await runApp(
    db,
    { appId: 'hb', appDir: dir, executor: 'pipeline', config: { marker } },
    gw,
  );

  // parked with two pending; handlers have NOT run yet (no false-green)
  assert.equal(runState(db, runId), 'waiting_human');
  assert.deepEqual(approvalStatuses(db, runId), ['pending', 'pending']);
  assert.equal(markerLines(marker).length, 0, 'no handler runs before approve');
  const parkedKinds = eventKinds(db, runId);
  assert.equal(parkedKinds.filter((k) => k === EVENT.approvalRequested).length, 2);
  assert.ok(!parkedKinds.includes(EVENT.runCompleted));

  await gw.approve(runId);

  assert.equal(runState(db, runId), 'completed');
  assert.deepEqual(approvalStatuses(db, runId), ['granted', 'granted']);
  const lines = markerLines(marker);
  assert.equal(lines.length, 2, 'both handlers produced an observable side effect');
  assert.deepEqual(lines.map((l) => l.to).sort(), ['a', 'b']);
  // Approval.id passed through as the idempotency key
  assert.ok(lines.every((l) => typeof l.key === 'string' && l.key.length > 0));
  const kinds = eventKinds(db, runId);
  assert.equal(kinds.filter((k) => k === EVENT.actionExecuted).length, 2);
  assert.equal(kinds.at(-1), EVENT.runCompleted);
  db.close();
});

// ── non-waiting_human runs reject approve/reject ────────────────────────────
test('approve/reject on a non-waiting_human run → not_waiting, run unchanged', async () => {
  const db = tmpDb();
  const gw = new PipelineGateway(db, appFixture(), ['fake.send']);
  const runId = createRun(db, 'hb', 'manual'); // state 'running'

  await assert.rejects(
    gw.approve(runId),
    (e: unknown) => e instanceof EngineError && e.kind === 'not_waiting',
  );
  await assert.rejects(
    gw.reject(runId),
    (e: unknown) => e instanceof EngineError && e.kind === 'not_waiting',
  );
  assert.equal(runState(db, runId), 'running', 'guard did not mutate the run');
  db.close();
});

// ── reject → cancelled, no handler runs ─────────────────────────────────────
test('reject a parked run → run.cancelled, pending rejected, no side effect', async () => {
  const db = tmpDb();
  const dir = appFixture();
  const marker = markerPath();
  const gw = new PipelineGateway(db, dir, ['fake.send']);
  const runId = await runApp(
    db,
    { appId: 'hb', appDir: dir, executor: 'pipeline', config: { marker } },
    gw,
  );
  assert.equal(runState(db, runId), 'waiting_human');

  await gw.reject(runId, 'not today');

  assert.equal(runState(db, runId), 'cancelled');
  assert.deepEqual(approvalStatuses(db, runId), ['rejected', 'rejected']);
  assert.equal(markerLines(marker).length, 0, 'reject executes nothing');
  assert.equal(eventKinds(db, runId).at(-1), EVENT.runCancelled);
  db.close();
});

// ── low-risk propose: awaits handler inline, emits action.executed ──────────
test('low-risk propose executes inline (awaitable result) and the run completes', async () => {
  const db = tmpDb();
  const dir = appFixture();
  const marker = markerPath();
  const gw = new PipelineGateway(db, dir, []); // nothing high-risk

  const runId = await runApp(
    db,
    { appId: 'hb', appDir: dir, executor: 'pipeline', config: { marker } },
    gw,
  );

  assert.equal(runState(db, runId), 'completed');
  const lines = markerLines(marker);
  assert.equal(lines.length, 2, 'both low-risk handlers ran during run()');
  assert.equal(lines[0].key, null, 'no idempotency key on the low-risk path');
  // handler result is resolved back to run() (captured via propose.result)
  const result = db
    .prepare(`SELECT payload_json FROM RunEvent WHERE run_id=? AND kind='propose.result'`)
    .get(runId) as { payload_json: string };
  assert.equal(JSON.parse(result.payload_json).r.sent, 'a');
  const kinds = eventKinds(db, runId);
  assert.equal(kinds.filter((k) => k === EVENT.actionExecuted).length, 2);
  assert.ok(!kinds.includes(EVENT.approvalRequested));
  assert.equal(kinds.at(-1), EVENT.runCompleted);
  db.close();
});

// ── approve partial failure → run.failed, granted kept, error redacted ──────
test('approve partial failure → run.failed, already-granted kept, remaining superseded, redacted', async () => {
  const db = tmpDb();
  const dir = appFixture();
  const marker = markerPath();
  const gw = new PipelineGateway(db, dir, ['fake.send']);
  const runId = await runApp(
    db,
    { appId: 'hb', appDir: dir, executor: 'pipeline', config: { marker, failSecond: true } },
    gw,
  );
  assert.equal(runState(db, runId), 'waiting_human');

  await gw.approve(runId);

  assert.equal(runState(db, runId), 'failed');
  // first action granted+executed (one marker line), second failed
  assert.equal(markerLines(marker).length, 1);
  assert.deepEqual(approvalStatusByTo(db, runId), { a: 'granted', b: 'failed' });
  const kinds = eventKinds(db, runId);
  assert.equal(kinds.filter((k) => k === EVENT.actionExecuted).length, 1);
  assert.ok(kinds.includes(EVENT.actionFailed));
  assert.equal(kinds.at(-1), EVENT.runFailed);
  // the leaked token must be redacted in the failed event payload
  const failed = db
    .prepare(`SELECT payload_json FROM RunEvent WHERE run_id=? AND kind=? ORDER BY seq DESC LIMIT 1`)
    .get(runId, EVENT.actionFailed) as { payload_json: string };
  assert.ok(!failed.payload_json.includes('abcdef1234567890'), 'secret redacted in action.failed');
  db.close();
});

// ── no pending approval on a waiting_human run → no_pending_approval ─────────
test('approve with no pending approval → no_pending_approval, run stays parked', async () => {
  const db = tmpDb();
  const dir = appFixture();
  const gw = new PipelineGateway(db, dir, ['fake.send']);
  // hand-craft a waiting_human run with zero pending approvals
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('r', 'hb', 'waiting_human', 'manual', now, null);
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('e1', 'r', 1, EVENT.runStarted, '{}', now);
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('e2', 'r', 2, EVENT.approvalRequested, '{}', now);

  await assert.rejects(
    gw.approve('r'),
    (e: unknown) => e instanceof EngineError && e.kind === 'no_pending_approval',
  );
  assert.equal(runState(db, 'r'), 'waiting_human', 'no_pending rolls back the lock claim');
  db.close();
});
