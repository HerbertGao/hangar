/**
 * Phase 0 exit-gate (DoD) — the run → park → approve → trace chain, driven through
 * the REAL command surface (cli.ts `dispatch`) against the REAL apps/heartbeat toy,
 * plus the three anti-false-green assertions from design.md §8.2 / the risk note
 * "出口闸只验快乐路径". This file exists to make "Phase 0 passed" mean the spine is
 * actually trustworthy, not just that the happy path happened to run once.
 *
 * ── Phase 0 single-process assumption (task 8.3) ────────────────────────────
 * This DoD verifies a SINGLE approving process only. Multi-process concurrent
 * approve/reject arbitration (seq-race loser retry, approve-vs-reject live race,
 * `granting` lease/timeout reclaim) is NOT covered here and NOT guaranteed by
 * Phase 0 — it is deferred to Phase 1 (see ROADMAP "从 Phase 0 review 延后到此"
 * and design.md 非目标). Phase 0's guarantees are exactly: run-state guard +
 * approve's run-lock claim + PID-fingerprint reaper + Approval.id idempotency key.
 * Do NOT read a green DoD as a proof of concurrent-approval integrity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from './db.js';
import { EVENT, isTerminalKind } from './events.js';
import { createRun } from './store.js';
import { reap } from './reaper.js';
import { PipelineGateway } from './gateway.js';
import { dispatch, type DoctorReport, type Deps } from './cli.js';

const NONROOT: Deps = { getuid: () => 1000 };

function tmpDb(): DB {
  return openDb(join(mkdtempSync(join(tmpdir(), 'hangar-dod-')), 'hangar.sqlite'));
}
function tmpFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'f');
}
function runState(db: DB, id: string): string {
  return (db.prepare('SELECT state FROM Run WHERE id=?').get(id) as { state: string }).state;
}
function lockOf(db: DB, id: string): string | null {
  return (db.prepare('SELECT lock_owner FROM Run WHERE id=?').get(id) as { lock_owner: string | null })
    .lock_owner;
}
function eventKinds(db: DB, id: string): string[] {
  return (
    db.prepare('SELECT kind FROM RunEvent WHERE run_id=? ORDER BY seq').all(id) as { kind: string }[]
  ).map((r) => r.kind);
}
function approvalStatus(db: DB, id: string): string {
  return (db.prepare('SELECT status FROM Approval WHERE id=?').get(id) as { status: string }).status;
}
/** Number of appended lines in a marker file (0 if absent/empty). */
function countLines(p: string): number {
  if (!existsSync(p)) return 0;
  const body = readFileSync(p, 'utf8').trim();
  return body ? body.split('\n').length : 0;
}

// ── 8.1 happy path, through the real command surface + real heartbeat ────────
test('8.1 doctor(no db) → run heartbeat→waiting_human(2 pending) → status → approve→completed (marker really written) → trace timeline', async () => {
  const realApps = fileURLToPath(new URL('../../../apps', import.meta.url));
  const dbPath = join(mkdtempSync(join(tmpdir(), 'hangar-dod-db-')), 'hangar.sqlite');
  const marker = tmpFile('hangar-dod-hb-');
  process.env.HANGAR_APPS = realApps;
  process.env.HANGAR_DB = dbPath;
  process.env.HANGAR_HEARTBEAT_MARKER = marker; // heartbeat/tools.ts reads this at load

  // doctor: all-green, lists heartbeat, and must NOT create the db
  const doc = await dispatch(['doctor'], NONROOT);
  assert.equal(doc.code, 0);
  const report = doc.json as DoctorReport;
  assert.equal(report.ok, true, 'doctor reports green');
  assert.deepEqual(
    report.checks.apps.find((a) => a.id === 'heartbeat'),
    { id: 'heartbeat', spec: 'ok', pipeline: 'ok' },
  );
  assert.equal(existsSync(dbPath), false, 'doctor never creates hangar.sqlite');

  // run → waiting_human (both high-risk proposes park)
  const rr = await dispatch(['run', 'heartbeat'], NONROOT);
  assert.equal(rr.code, 0);
  const runId = (rr.json as { run: string; state: string }).run;
  assert.equal((rr.json as { state: string }).state, 'waiting_human');

  const tr1 = await dispatch(['trace', runId], NONROOT);
  assert.equal(
    (tr1.json as { pendingApprovals: unknown[] }).pendingApprovals.length,
    2,
    'two pending approvals',
  );

  const st = await dispatch(['status'], NONROOT);
  const row = (
    st.json as { app: string; state: string | null; lastRun: string | null }[]
  ).find((r) => r.app === 'heartbeat');
  assert.equal(row?.state, 'waiting_human');
  assert.equal(row?.lastRun, runId);

  // no handler side effect before approve → not a false green
  assert.equal(countLines(marker), 0, 'no side effect before approve');

  // approve → completed, both actions granted
  const ap = await dispatch(['approve', runId], NONROOT);
  assert.equal(ap.code, 0);
  assert.equal((ap.json as { state: string }).state, 'completed');
  const executed = (ap.json as { executed: { tool: string; ok: boolean }[] }).executed;
  assert.equal(executed.length, 2);
  assert.ok(executed.every((e) => e.ok), 'both actions granted');

  // THE load-bearing DoD assertion: the handler's observable marker was really
  // written (execute is not a no-op), each line tagged with the idempotency key
  // (= Approval.id) that the gateway threads through the high-risk approve path.
  const lines = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'both handlers wrote their marker line');
  assert.ok(
    lines.every((l) => /key=ap_[0-9a-f-]+/.test(l)),
    'each side effect carries its Approval.id idempotency key',
  );

  // trace: full lifecycle timeline (domain 'progress' events filtered out)
  const tr2 = await dispatch(['trace', runId], NONROOT);
  const kinds = (tr2.json as { events: { kind: string }[] }).events.map((e) => e.kind);
  const lifecycle = kinds.filter(
    (k) => k.startsWith('run.') || k.startsWith('approval.') || k.startsWith('action.'),
  );
  assert.deepEqual(lifecycle, [
    EVENT.runStarted,
    EVENT.approvalRequested,
    EVENT.approvalRequested,
    EVENT.approvalGranted,
    EVENT.actionExecuted,
    EVENT.actionExecuted,
    EVENT.runCompleted,
  ]);
});

// ── 8.2① action.failed is non-terminal — a failed low-risk action doesn't kill
//     the run or drop its lock (only run.* through the choke-point does). ───────
function failingLowRiskApp(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-dod-fail-'));
  writeFileSync(
    join(dir, 'tools.ts'),
    `import { appendFileSync } from 'node:fs';
     const P = ${JSON.stringify(marker)};
     export const tools = { flaky: async () => { appendFileSync(P, 'attempt\\n'); throw new Error('always fails'); } };`,
  );
  return dir;
}

test('8.2① a low-risk action.failed leaves the run non-terminal and still holding its lock', async () => {
  const db = tmpDb();
  const marker = tmpFile('hangar-dod-mk-');
  const gw = new PipelineGateway(db, failingLowRiskApp(marker), []); // flaky is low-risk
  const runId = createRun(db, 'a', 'manual'); // running, lock held

  await assert.rejects(gw.propose(runId, { tool: 'flaky', args: {} }));

  assert.equal(countLines(marker), 3, 'in-memory bounded retry exhausted (MAX_ATTEMPTS)');
  assert.equal(runState(db, runId), 'executing', 'action.failed does not terminate the run');
  assert.ok(lockOf(db, runId) !== null, 'action.failed does not release the app lock');
  const kinds = eventKinds(db, runId);
  assert.ok(kinds.includes(EVENT.actionFailed));
  assert.ok(!kinds.some(isTerminalKind), 'no run.* terminal event from a failed action');
  db.close();
});

// ── 8.2② reaper reclaims a crashed approve; the already-executed action does not
//     re-fire (approve crashed mid-executing, lock wedged by a dead owner). ─────
test('8.2② reaper reclaims a crashed approve (executing + dead owner); the done action is not re-run', () => {
  const db = tmpDb();
  const marker = tmpFile('hangar-dod-mk-');
  const ts = new Date().toISOString();
  // approve had claimed the lock (→executing), executed action #1 (granted + its side
  // effect), then the process crashed with #2 still 'granting'. lock_owner = dead pid.
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('orphan', 'a', 'executing', 'manual', ts, '999999:123456');
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('e1', 'orphan', 1, EVENT.runStarted, '{}', ts);
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('ap1', 'orphan', 'demo.risky', '{}', 'granted', ts);
  db.prepare(
    'INSERT INTO Approval (id,run_id,tool,args_json,status,requested_at) VALUES (?,?,?,?,?,?)',
  ).run('ap2', 'orphan', 'demo.risky', '{}', 'granting', ts);
  appendFileSync(marker, 'ap1-effect\n'); // #1's side effect already happened pre-crash
  const before = countLines(marker);

  const reaped = reap(db); // a write command runs the reaper on entry

  assert.deepEqual(reaped, ['orphan']);
  assert.equal(runState(db, 'orphan'), 'failed');
  assert.equal(lockOf(db, 'orphan'), null, 'reaper releases the wedged lock');
  assert.equal(approvalStatus(db, 'ap1'), 'granted', 'already-granted action kept, not rolled back');
  assert.equal(approvalStatus(db, 'ap2'), 'superseded', 'the mid-flight granting approval is voided');
  // the reaper only fails the run — it never re-invokes a handler, so an action that
  // already fired cannot double-fire (Approval.id idempotency is the approve-path
  // guarantee; the reaper's guarantee here is non-re-execution).
  assert.equal(countLines(marker), before, 'the done action does not re-fire on reap');
  db.close();
});

// ── 8.2③ approve on a non-waiting_human run → not_waiting (real command surface) ─
test('8.2③ approve on a non-waiting_human (completed) run → not_waiting, code 1', async () => {
  const appsDir = mkdtempSync(join(tmpdir(), 'hangar-dod-apps-'));
  process.env.HANGAR_APPS = appsDir;
  process.env.HANGAR_DB = join(mkdtempSync(join(tmpdir(), 'hangar-dod-db-')), 'hangar.sqlite');
  const dir = join(appsDir, 'done');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'app.yaml'),
    'id: done\nname: done\nexecutor: pipeline\ntriggers: []\npermissions:\n  approval: []\n',
  );
  writeFileSync(join(dir, 'pipeline.ts'), `export async function run(ctx){ ctx.emit('progress',{}); }`);

  const rr = await dispatch(['run', 'done'], NONROOT);
  assert.equal((rr.json as { state: string }).state, 'completed');
  const ap = await dispatch(['approve', (rr.json as { run: string }).run], NONROOT);
  assert.equal(ap.code, 1);
  assert.equal(ap.errKind, 'not_waiting');
});
