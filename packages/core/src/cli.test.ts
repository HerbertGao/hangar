import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import cron from 'node-cron';
import { openDb, type DB } from './db.js';
import { loadApps, type LoadedApp } from './registry.js';
import { EVENT } from './events.js';
import { reap } from './reaper.js';
import { HOST_CAPABILITIES } from './capabilities.js';
import {
  dispatch,
  startDaemon,
  daemonRunOne,
  hasActiveRun,
  daemonTasks,
  deriveBlocked,
  cronPeriodMs,
  makeFireGate,
  nodeSupported,
  shutdownGraceMs,
  type Deps,
} from './cli.js';

const NONROOT: Deps = { getuid: () => 1000 };
const ROOT: Deps = { getuid: () => 0 };

/** Point HANGAR_DB/HANGAR_APPS at a fresh temp root (read each dispatch call). */
function tmpEnv(): { root: string; dbPath: string; appsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hangar-cli-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir, { recursive: true });
  const dbPath = join(root, 'hangar.sqlite');
  process.env.HANGAR_DB = dbPath;
  process.env.HANGAR_APPS = appsDir;
  return { root, dbPath, appsDir };
}

function writeApp(
  appsDir: string,
  id: string,
  opts: { approval?: string[]; pipeline: string; tools?: string; schedule?: string; triggerName?: string },
): void {
  const dir = join(appsDir, id);
  mkdirSync(dir, { recursive: true });
  const approval = (opts.approval ?? []).map((t) => `"${t}"`).join(', ');
  const yaml =
    [
      `id: ${id}`,
      `name: ${id}`,
      `executor: pipeline`,
      `triggers:`,
      `  - type: cron`,
      // 4.2: an optional named cron trigger (default fixture is a single unnamed one).
      ...(opts.triggerName ? [`    name: ${opts.triggerName}`] : []),
      `    schedule: "${opts.schedule ?? '* * * * *'}"`,
      `permissions:`,
      `  approval: [${approval}]`,
    ].join('\n') + '\n';
  writeFileSync(join(dir, 'app.yaml'), yaml);
  writeFileSync(join(dir, 'pipeline.ts'), opts.pipeline);
  if (opts.tools) writeFileSync(join(dir, 'tools.ts'), opts.tools);
}

// ── 6.2 refuse root + no db write on refusal ─────────────────────────────────
test('write commands refuse root (EUID==0) and do not create the db', async () => {
  const { dbPath } = tmpEnv();
  for (const argv of [['run', 'x'], ['approve', 'r'], ['reject', 'r']]) {
    const res = await dispatch(argv, ROOT);
    assert.equal(res.code, 1);
    assert.equal(res.errKind, 'refuse_root');
  }
  const d = startDaemon(ROOT);
  assert.ok(!('shutdown' in d), 'root refusal returns a Result, not a started daemon');
  assert.equal(d.code, 1);
  assert.equal(d.errKind, 'refuse_root');
  assert.equal(existsSync(dbPath), false, 'root-refused writes must not create the db');
});

// ── 6.1 exit-code fan-out: 0 / 1 / 2 ─────────────────────────────────────────
test('exit codes: help=0, unknown=2, missing-arg=2', async () => {
  tmpEnv();
  assert.equal((await dispatch([])).code, 0); // no args → help
  assert.equal((await dispatch(['bogus'])).code, 2); // unknown command
  assert.equal((await dispatch(['trace'])).code, 2); // missing <run>
  assert.equal((await dispatch(['run'], NONROOT)).code, 2); // missing <app>
});

// ── 6.5 doctor is non-destructive and reports green ──────────────────────────
test('doctor never creates the db and reports ok on a green env (even as root)', async () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'good', { approval: ['fake.send'], pipeline: 'export async function run(){}' });
  const res = await dispatch(['doctor'], ROOT); // doctor does NOT refuse root
  assert.equal(res.code, 0);
  const report = res.json as {
    ok: boolean;
    checks: { sqlite_writable: string; apps_dir: string; apps: { id: string; spec: string; pipeline: string; enabled?: boolean }[] };
  };
  assert.equal(report.checks.sqlite_writable, 'ok'); // dir writable, file absent
  assert.equal(report.checks.apps_dir, 'ok');
  assert.deepEqual(
    report.checks.apps.find((a) => a.id === 'good'),
    { id: 'good', spec: 'ok', pipeline: 'ok', enabled: true },
  );
  assert.equal(report.ok, true);
  assert.equal(existsSync(dbPath), false, 'doctor must not create hangar.sqlite');
});

test('doctor flags spec_invalid and pipeline_missing → ok:false', async () => {
  const { appsDir } = tmpEnv();
  mkdirSync(join(appsDir, 'bad'));
  writeFileSync(join(appsDir, 'bad', 'app.yaml'), 'id: bad\nexecutor: pipeline\ntriggers: []\n'); // no name
  mkdirSync(join(appsDir, 'nopipe'));
  writeFileSync(
    join(appsDir, 'nopipe', 'app.yaml'),
    'id: nopipe\nname: nopipe\nexecutor: pipeline\ntriggers: []\n',
  ); // valid spec, no pipeline.ts
  const report = (await dispatch(['doctor'])).json as {
    ok: boolean;
    checks: { apps: { id: string; spec: string; pipeline: string }[] };
  };
  assert.equal(report.ok, false);
  assert.equal(report.checks.apps.find((a) => a.id === 'bad')?.spec, 'spec_invalid');
  assert.equal(report.checks.apps.find((a) => a.id === 'nopipe')?.pipeline, 'pipeline_missing');
});

test('doctor derives blocked for an app parked past its cron period (no db created for absent case)', async () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'stuck', { approval: ['fake.send'], pipeline: 'export async function run(){}' });
  const db = openDb(dbPath); // creating the db is the test's setup, not doctor's job
  const old = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago > 60s cron period
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('r_stuck', 'stuck', 'waiting_human', 'cron', old, null);
  db.close();
  const report = (await dispatch(['doctor'])).json as { checks: { blocked: string[] } };
  assert.deepEqual(report.checks.blocked, ['stuck']);
});

// ── add-app-disable: disabled app not scheduled, never derived blocked, still listed ──
test('disabled app: daemonTasks omits it; status/doctor list it with enabled:false but never blocked', async () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'live', { approval: ['fake.send'], pipeline: 'export async function run(){}' });
  writeApp(appsDir, 'off', { approval: ['fake.send'], pipeline: 'export async function run(){}' });
  const offYaml = join(appsDir, 'off', 'app.yaml');
  writeFileSync(offYaml, readFileSync(offYaml, 'utf8') + 'enabled: false\n');

  // daemon does not schedule the disabled app (both have a '* * * * *' trigger)
  assert.deepEqual(
    daemonTasks(loadApps()).map((t) => t.appId).sort(),
    ['live'],
    'enabled:false app is not fed into cron.schedule',
  );

  // both have an overdue parked run (5m ago > 60s cron period)
  const db = openDb(dbPath);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const ins = db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  );
  ins.run('r_live', 'live', 'waiting_human', 'cron', old, null);
  ins.run('r_off', 'off', 'waiting_human', 'cron', old, null);
  db.close();

  // status: both listed; only the enabled one derives blocked
  const rows = (await dispatch(['status'])).json as { app: string; blocked: boolean }[];
  assert.ok(rows.some((r) => r.app === 'off'), 'disabled app still listed in status');
  assert.equal(rows.find((r) => r.app === 'off')?.blocked, false, 'disabled app never blocked');
  assert.equal(rows.find((r) => r.app === 'live')?.blocked, true);

  // doctor: disabled app listed with enabled:false, and NOT in checks.blocked
  const rep = (await dispatch(['doctor'])).json as {
    checks: { apps: { id: string; enabled?: boolean }[]; blocked: string[] };
  };
  assert.equal(rep.checks.apps.find((a) => a.id === 'off')?.enabled, false);
  assert.equal(rep.checks.apps.find((a) => a.id === 'live')?.enabled, true);
  assert.deepEqual(rep.checks.blocked, ['live'], 'disabled app excluded from checks.blocked');
});

// ── 6.3 run_not_found ────────────────────────────────────────────────────────
test('run_not_found: trace/approve/reject an unknown run → kind run_not_found, code 1', async () => {
  tmpEnv();
  const t = await dispatch(['trace', 'nope']);
  assert.equal(t.code, 1);
  assert.equal(t.errKind, 'run_not_found');
  const a = await dispatch(['approve', 'nope'], NONROOT);
  assert.equal(a.errKind, 'run_not_found');
  const r = await dispatch(['reject', 'nope'], NONROOT);
  assert.equal(r.errKind, 'run_not_found');
});

// ── 6.3 read-only commands never write (no reap) ─────────────────────────────
test('status/trace are read-only: they do not reap orphaned runs', async () => {
  const { dbPath } = tmpEnv();
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('orphan', 'a', 'running', 'manual', now, '999999:1'); // dead owner → reapable by a WRITE cmd
  db.prepare(
    'INSERT INTO RunEvent (id,run_id,seq,kind,payload_json,at) VALUES (?,?,?,?,?,?)',
  ).run('e', 'orphan', 1, EVENT.runStarted, '{}', now);
  db.close();

  await dispatch(['status']);
  await dispatch(['trace', 'orphan']);

  const db2 = openDb(dbPath);
  const state = (db2.prepare('SELECT state FROM Run WHERE id=?').get('orphan') as { state: string })
    .state;
  db2.close();
  assert.equal(state, 'running', 'read-only commands must not reap (must not write the db)');
});

// ── R2-F1: read-only commands never write the db (production shape: DELETE mode) ─
// Tests the REAL production db (openDb, no manual journal flip). If anyone re-adds
// `journal_mode = WAL` to openDb, `mode0` below is 'wal' → this fails: a WAL db read
// under root spawns persistent root-owned -wal/-shm sidecars a later non-root run
// can't write. The regression guard the old (WAL-flip-first) test could not provide.
test('read-only commands do not write the db (no WAL, no sidecar, no mtime/size change)', async () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'a', { pipeline: 'export async function run(){}' });
  const setup = openDb(dbPath); // exactly as production builds it
  const mode0 = setup.pragma('journal_mode', { simple: true }) as string;
  setup.close();
  assert.equal(mode0, 'delete', 'openDb must NOT enable WAL (else read-only leaves root-owned sidecars)');
  assert.equal(existsSync(dbPath + '-wal'), false, 'precondition: no -wal sidecar');
  const before = statSync(dbPath);

  await dispatch(['status']);
  await dispatch(['runs']);
  await dispatch(['trace', 'nope']);

  const after = statSync(dbPath);
  assert.equal(existsSync(dbPath + '-wal'), false, 'no -wal sidecar written by a read command');
  assert.equal(existsSync(dbPath + '-shm'), false, 'no -shm sidecar written by a read command');
  assert.equal(after.size, before.size, 'read command must not change db size');
  assert.equal(after.mtimeMs, before.mtimeMs, 'read command must not write the db');
});

// ── R3-F2: a present-but-unopenable db surfaces an error, never masks as empty ──
// openReadonlyOrNull returns null ONLY when the file is absent (legit empty). If the
// db exists but can't be opened (EACCES / corrupt), the error must propagate so
// status/runs/trace fail loudly instead of lying "no data" (run_not_found for trace).
test('read-only commands on an unreadable existing db throw (not silent empty)', async (t) => {
  const { dbPath } = tmpEnv();
  // root bypasses file perms → can't simulate EACCES. Report skipped, not a false green.
  if (process.getuid?.() === 0) return void t.skip('root cannot simulate EACCES');
  openDb(dbPath).close();
  chmodSync(dbPath, 0o000); // exists but unreadable → openDbReadonly throws SQLITE_CANTOPEN
  try {
    // dispatch has no catch; main() maps these throws to {code:1, errKind:'internal'}.
    // Old code swallowed the open error → resolved {code:0, empty}, which would NOT reject.
    await assert.rejects(dispatch(['status']), 'status must fail loudly, not return empty');
    await assert.rejects(dispatch(['runs']), 'runs must fail loudly, not return (no runs)');
    await assert.rejects(dispatch(['trace', 'nope']), 'trace must fail loudly, not run_not_found');
  } finally {
    chmodSync(dbPath, 0o600); // restore so temp-dir cleanup can remove it
  }
});

// ── runs --limit: 取最近 N 条(管道消费者收小输出、避 process.exit 截断 + 无界增长)──
test('runs --limit N caps to the N most-recent runs; invalid limit is a usage error', async () => {
  const { dbPath } = tmpEnv();
  const db = openDb(dbPath);
  const ins = db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  );
  for (let i = 0; i < 5; i++) {
    ins.run(`r${i}`, 'app', 'completed', 'poll', `2026-07-01T00:0${i}:00.000Z`, null);
  }
  db.close();

  const all = await dispatch(['runs']);
  assert.equal((all.json as unknown[]).length, 5, 'no --limit → all runs');

  const two = await dispatch(['runs', '--limit', '2']);
  const rows = two.json as { id: string }[];
  assert.equal(rows.length, 2, '--limit 2 → 2 runs');
  assert.deepEqual(
    rows.map((r) => r.id),
    ['r4', 'r3'],
    '--limit keeps the most-recent (started_at DESC)',
  );

  assert.equal((await dispatch(['runs', '--limit', '0'])).code, 2, '--limit 0 → usage error');
  assert.equal((await dispatch(['runs', '--limit', 'abc'])).code, 2, '--limit abc → usage error');
});

// ── 6.3 derived "blocked" ────────────────────────────────────────────────────
test('deriveBlocked: waiting_human past one cron period is blocked; else not', () => {
  const triggers = [{ schedule: '* * * * *' }]; // 60s period
  const now = Date.parse('2026-01-01T00:05:00Z');
  assert.equal(deriveBlocked(triggers, 'waiting_human', '2026-01-01T00:00:00Z', now), true); // 5m > 60s
  assert.equal(deriveBlocked(triggers, 'waiting_human', '2026-01-01T00:04:30Z', now), false); // 30s < 60s
  assert.equal(deriveBlocked(triggers, 'running', '2026-01-01T00:00:00Z', now), false); // not parked
  assert.equal(deriveBlocked([], 'waiting_human', '2026-01-01T00:00:00Z', now), false); // no cron
  assert.equal(cronPeriodMs('*/5 * * * *'), 300000);
});

// ── R2-F5: node floor is 22.18 (flag-free .ts strip backport), not just 22 ────
test('nodeSupported: 22.17 unsupported (would crash on app .ts import), 22.18+ ok', () => {
  assert.equal(nodeSupported('22.17.0'), false); // pre-backport → ERR_UNKNOWN_FILE_EXTENSION
  assert.equal(nodeSupported('22.18.0'), true); // backport landed
  assert.equal(nodeSupported('22.20.5'), true);
  assert.equal(nodeSupported('23.6.0'), true); // default from here
  assert.equal(nodeSupported('20.11.0'), false); // too old entirely
  assert.equal(nodeSupported('24.0.0'), true);
});

test('shutdownGraceMs: env coercion — 0 kept (not snapped to default), invalid/negative → 5000', () => {
  const prev = process.env.HANGAR_SHUTDOWN_GRACE_MS;
  try {
    delete process.env.HANGAR_SHUTDOWN_GRACE_MS;
    assert.equal(shutdownGraceMs(), 5000, 'unset → default');
    process.env.HANGAR_SHUTDOWN_GRACE_MS = '0';
    assert.equal(shutdownGraceMs(), 0, '0 → immediate exit, NOT snapped back by `|| 5000`');
    process.env.HANGAR_SHUTDOWN_GRACE_MS = '250';
    assert.equal(shutdownGraceMs(), 250, 'finite ≥0 honored');
    process.env.HANGAR_SHUTDOWN_GRACE_MS = '-1';
    assert.equal(shutdownGraceMs(), 5000, 'negative → default');
    process.env.HANGAR_SHUTDOWN_GRACE_MS = 'abc';
    assert.equal(shutdownGraceMs(), 5000, 'non-numeric → default');
  } finally {
    if (prev === undefined) delete process.env.HANGAR_SHUTDOWN_GRACE_MS;
    else process.env.HANGAR_SHUTDOWN_GRACE_MS = prev;
  }
});

// ── 6.4 e2e: run → park → status → trace → approve (handler really runs) ──────
test('e2e: run parks on high-risk propose; approve executes handlers → completed', async () => {
  const { appsDir } = tmpEnv();
  const marker = join(mkdtempSync(join(tmpdir(), 'hangar-mk-')), 'marker');
  writeApp(appsDir, 'hb', {
    approval: ['fake.send'],
    pipeline: `export async function run(ctx){ ctx.emit('domain.tick',{n:1}); await ctx.propose({tool:'fake.send',args:{to:'x'}}); await ctx.propose({tool:'fake.send',args:{to:'y'}}); }`,
    tools: `import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const P = ${JSON.stringify(marker)};
export const tools = { 'fake.send': async () => { const n = existsSync(P)?Number(readFileSync(P,'utf8')):0; writeFileSync(P, String(n+1)); return { ok:true }; } };`,
  });

  const rr = await dispatch(['run', 'hb'], NONROOT);
  assert.equal(rr.code, 0);
  const runId = (rr.json as { run: string; state: string }).run;
  assert.equal((rr.json as { state: string }).state, 'waiting_human');

  const st = await dispatch(['status']);
  const row = (st.json as { app: string; state: string; lastRun: string }[]).find((r) => r.app === 'hb');
  assert.equal(row?.state, 'waiting_human');
  assert.equal(row?.lastRun, runId);

  const tr = await dispatch(['trace', runId]);
  assert.equal((tr.json as { pendingApprovals: unknown[] }).pendingApprovals.length, 2);

  const ap = await dispatch(['approve', runId], NONROOT);
  assert.equal(ap.code, 0);
  assert.equal((ap.json as { state: string }).state, 'completed');
  assert.equal(readFileSync(marker, 'utf8'), '2', 'both handlers executed (approve is not a no-op)');
});

// ── 6.4 reject → cancelled ───────────────────────────────────────────────────
test('reject: park then reject → cancelled, rejected lists the approval', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'hb', {
    approval: ['fake.send'],
    pipeline: `export async function run(ctx){ await ctx.propose({tool:'fake.send',args:{}}); }`,
  });
  const rr = await dispatch(['run', 'hb'], NONROOT);
  const runId = (rr.json as { run: string }).run;
  const rj = await dispatch(['reject', runId, '--reason', 'nope'], NONROOT);
  assert.equal(rj.code, 0);
  assert.equal((rj.json as { state: string }).state, 'cancelled');
  assert.equal((rj.json as { rejected: string[] }).rejected.length, 1);
});

// ── approve exit code reflects the run outcome ───────────────────────────────
test('approve a run whose high-risk action fails → code 1, state=failed (detail kept)', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'boom', {
    approval: ['fake.send'],
    pipeline: `export async function run(ctx){ await ctx.propose({tool:'fake.send',args:{}}); }`,
    tools: `export const tools = { 'fake.send': async () => { throw new Error('kaboom'); } };`,
  });
  const rr = await dispatch(['run', 'boom'], NONROOT);
  const runId = (rr.json as { run: string }).run;
  const ap = await dispatch(['approve', runId], NONROOT);
  assert.equal(ap.code, 1, 'failed action → business-failure exit code');
  assert.equal((ap.json as { state: string }).state, 'failed');
  assert.deepEqual((ap.json as { executed: { tool: string; ok: boolean }[] }).executed, [
    { tool: 'fake.send', ok: false },
  ]);
});

// ── R4-F2: run whose pipeline throws → code 1, state=failed (mirrors approve) ──
test('run a pipeline that throws collapses to failed → code 1 (not misleading 0)', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'boom', { pipeline: `export async function run(){ throw new Error('kaboom'); }` });
  const rr = await dispatch(['run', 'boom'], NONROOT);
  assert.equal((rr.json as { state: string }).state, 'failed');
  assert.equal(rr.code, 1, 'a run that collapses to failed is a business failure, not success');
});

// ── 6.4 not_waiting ──────────────────────────────────────────────────────────
test('approve a non-waiting (completed) run → not_waiting, code 1', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'done', { pipeline: `export async function run(ctx){ ctx.emit('domain.tick',{}); }` });
  const rr = await dispatch(['run', 'done'], NONROOT);
  assert.equal((rr.json as { state: string }).state, 'completed');
  const ap = await dispatch(['approve', (rr.json as { run: string }).run], NONROOT);
  assert.equal(ap.code, 1);
  assert.equal(ap.errKind, 'not_waiting');
});

// ── 6.6 daemon helpers: skip-when-active + trigger flattening ─────────────────
test('daemon helpers: hasActiveRun reflects active runs; daemonTasks flattens triggers', () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'hb', { schedule: '*/2 * * * *', pipeline: 'export async function run(){}' });
  assert.deepEqual(daemonTasks(loadApps()), [
    { appId: 'hb', name: undefined, schedule: '*/2 * * * *', timezone: undefined },
  ]);
  const db = openDb(dbPath);
  assert.equal(hasActiveRun(db, 'hb'), false);
  db.prepare(
    'INSERT INTO Run (id,app_id,state,trigger,started_at,lock_owner) VALUES (?,?,?,?,?,?)',
  ).run('r1', 'hb', 'waiting_human', 'cron', new Date().toISOString(), null);
  assert.equal(hasActiveRun(db, 'hb'), true, 'a parked run counts as active → cron would skip');
  db.close();
});

// ── 2.2 daemonTasks: array schedule fan-out (same name, dedup) + overdue min ──
test('daemonTasks: array schedule fans out per cron with the same name (dup deduped); overdue period = min', () => {
  const { appsDir } = tmpEnv();
  const dir = join(appsDir, 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'app.yaml'),
    [
      'id: inbox',
      'name: inbox',
      'executor: pipeline',
      'triggers:',
      '  - type: cron',
      '    name: poll',
      '    schedule: "*/3 * * * *"',
      '  - type: cron',
      '    name: digest',
      '    schedule: ["0 6 * * *", "0 6 * * *", "0 19 * * *"]', // dup "0 6" → deduped
      'permissions:',
      '  approval: []',
    ].join('\n') + '\n',
  );
  writeFileSync(join(dir, 'pipeline.ts'), 'export async function run(){}');
  const tasks = daemonTasks(loadApps());
  assert.equal(tasks.length, 3, 'poll(1) + digest(2 after dedup) = 3 tasks');
  assert.ok(tasks.every((t) => t.appId === 'inbox'));
  assert.deepEqual(
    tasks.filter((t) => t.name === 'digest').map((t) => t.schedule),
    ['0 6 * * *', '0 19 * * *'],
    'all array-fan-out tasks carry the same name; dup string dropped',
  );
  // cronPeriodMs on an array = min of each element's own period (each daily = 24h)
  assert.equal(cronPeriodMs(['0 6 * * *', '0 19 * * *']), 24 * 60 * 60_000);
  // overdue uses the FASTEST trigger's period (poll 3min), not the daily digest
  assert.equal(
    deriveBlocked(
      [{ schedule: '*/3 * * * *' }, { schedule: ['0 6 * * *', '0 19 * * *'] }],
      'waiting_human',
      '2026-01-01T00:00:00Z',
      Date.parse('2026-01-01T00:10:00Z'), // 10min > 3min fastest period
    ),
    true,
  );
});

// ── 2.4 makeFireGate: per-app serialization, pending dedup/order, skip on active ─
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const fakeApp = (id: string): LoadedApp => ({ id }) as unknown as LoadedApp;

test('makeFireGate: in-flight second trigger → pending (not skip); drains in insertion order; dedup keeps ≤1', async () => {
  const app = fakeApp('inbox');
  const runs: (string | undefined)[] = [];
  const skips: (string | undefined)[] = [];
  const gates: { resolve: () => void }[] = [];
  const { fire } = makeFireGate({
    hasActive: () => false,
    runOne: (_a, name) => {
      runs.push(name);
      const d = deferred();
      gates.push(d);
      return d.promise;
    },
    logSkip: (_a, name) => skips.push(name),
  });

  // ① + ⑤ two same-tick fires (check-then-add, no await between) → one runs, one pending
  fire(app, 'poll');
  fire(app, 'digest');
  assert.deepEqual(runs, ['poll'], 'only the first fire runs');
  assert.deepEqual(skips, [], 'a same-app in-flight fire is queued, never skipped');
  // ③ same trigger fired repeatedly while in-flight → at most one pending
  fire(app, 'digest');
  fire(app, 'digest');

  // ② first run reaches terminal → pending drains (insertion order)
  gates[0].resolve();
  await flush();
  assert.deepEqual(runs, ['poll', 'digest'], 'pending digest drained after poll settled');
  gates[1].resolve();
  await flush();
  assert.deepEqual(runs, ['poll', 'digest'], 'digest ran exactly once despite 3 fires (dedup)');
});

test('makeFireGate: ④ active/park → skip+log, no run; a parked settle drains its pending to skip', async () => {
  const app = fakeApp('inbox');
  const runs: (string | undefined)[] = [];
  const skips: (string | undefined)[] = [];
  let active = false;
  const d = deferred();
  const { fire } = makeFireGate({
    hasActive: () => active,
    runOne: (_a, name) => {
      runs.push(name);
      return d.promise;
    },
    logSkip: (_a, name) => skips.push(name),
  });

  // cross-process / park with nothing in-flight → skip+log, never createRun
  active = true;
  fire(app, 'digest');
  await flush();
  assert.deepEqual(runs, [], 'no run started while an active run exists elsewhere');
  assert.deepEqual(skips, ['digest'], 'fire is skip+logged');

  // now let a run start, queue a pending, then have the run PARK (settle non-terminal):
  active = false;
  fire(app, 'poll'); // runs
  fire(app, 'digest'); // pending
  active = true; // run parked → still holds the active-lock
  d.resolve();
  await flush();
  assert.deepEqual(runs, ['poll'], 'pending digest did NOT run — parked run still holds the lock');
  assert.deepEqual(skips, ['digest', 'digest'], 'drain reused the guard → skip+log, no already_running');
});

test('makeFireGate: parked run with ≥2 residual pending → residual dropped, no spurious replay after recovery', async () => {
  const app = fakeApp('inbox');
  const runs: (string | undefined)[] = [];
  const skips: (string | undefined)[] = [];
  const gates: { resolve: () => void }[] = [];
  let active = false;
  const { fire } = makeFireGate({
    hasActive: () => active,
    runOne: (_a, name) => {
      runs.push(name);
      const d = deferred();
      gates.push(d);
      return d.promise;
    },
    logSkip: (_a, name) => skips.push(name),
  });

  // poll runs; two distinct residual triggers queue as pending
  fire(app, 'poll');
  fire(app, 'digest');
  fire(app, 'weekly');
  assert.deepEqual(runs, ['poll'], 'only poll runs; digest+weekly are pending');

  // poll settles but the run PARKS (still holds the active-lock)
  active = true;
  gates[0].resolve();
  await flush();
  // drain shifts one pending → fire → hasActive → skip AND drops the whole residual queue
  assert.deepEqual(runs, ['poll'], 'nothing drained into the parked app');
  assert.deepEqual(skips, ['digest'], 'drained fire skip+logged; residual weekly dropped, not stranded');

  // park resolves; a fresh fire runs — and no stale pending replays
  active = false;
  fire(app, 'poll');
  await flush();
  assert.deepEqual(runs, ['poll', 'poll'], 'no spurious weekly replay after recovery (residual was dropped)');
});

// ── 2.3/2.5 run --trigger threads ctx.trigger + Run.trigger; omitted → undefined ─
test('run --trigger threads ctx.trigger and records Run.trigger; omitted → undefined/manual', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'tr', {
    pipeline: `export async function run(ctx){ ctx.emit('saw.trigger', { trigger: ctx.trigger ?? 'undefined' }); }`,
  });
  const sawTrigger = async (runId: string): Promise<string | undefined> => {
    const tr = await dispatch(['trace', runId]);
    return (tr.json as { events: { kind: string; payload: { trigger?: string } }[] }).events.find(
      (e) => e.kind === 'saw.trigger',
    )?.payload.trigger;
  };

  const withFlag = await dispatch(['run', 'tr', '--trigger', 'digest'], NONROOT);
  const runId = (withFlag.json as { run: string }).run;
  assert.equal(await sawTrigger(runId), 'digest', 'ctx.trigger === the --trigger name');
  // 4.4 (zero-regression): this pipeline reads ONLY ctx.trigger — it never touches the new
  // ctx.triggerKind field. Adding triggerKind/triggerName to the ctx must not perturb it:
  // the old-style pilot still runs to completion exactly as before.
  assert.equal((withFlag.json as { state: string }).state, 'completed', 'triggerKind-unaware pipeline unaffected');
  const runsRes = await dispatch(['runs', 'tr']); // one run so far → newest is this one
  assert.equal((runsRes.json as { trigger: string }[])[0].trigger, 'digest', 'Run.trigger stores the name');

  const noFlag = await dispatch(['run', 'tr'], NONROOT);
  assert.equal(await sawTrigger((noFlag.json as { run: string }).run), 'undefined', 'no --trigger → ctx.trigger undefined');

  // bare --trigger (no value) is a usage error
  assert.equal((await dispatch(['run', 'tr', '--trigger'], NONROOT)).code, 2);
});

// Read a pipeline-emitted { kind, name } snapshot of the ctx trigger fields back from a run's trace.
const sawTriggerKind = async (
  runId: string,
): Promise<{ kind?: string; name?: string } | undefined> => {
  const tr = await dispatch(['trace', runId]);
  return (
    tr.json as { events: { kind: string; payload: { kind?: string; name?: string } }[] }
  ).events.find((e) => e.kind === 'saw.kind')?.payload;
};
const KIND_PIPELINE = `export async function run(ctx){ ctx.emit('saw.kind', { kind: ctx.triggerKind, name: ctx.triggerName ?? 'undefined' }); }`;

// ── 4.1 manual boundary: triggerKind is host-written 'manual', unforgeable by --trigger ──
// MUST go through `hangar run` (CLI dispatch): at the runApp layer triggerKind is just a
// literal we hand in, so only the manual ENTRY (cmdRun) writing it proves unforgeability.
test('run --trigger: ctx.triggerKind is always manual (named + unnamed); flag cannot forge kind', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'mk', { pipeline: KIND_PIPELINE });

  const named = await dispatch(['run', 'mk', '--trigger', 'digest'], NONROOT);
  const namedSeen = await sawTriggerKind((named.json as { run: string }).run);
  assert.equal(namedSeen?.kind, 'manual', '--trigger <name> is manual — flag sets name, never kind');
  assert.equal(namedSeen?.name, 'digest', 'triggerName carries the flag value');

  const unnamed = await dispatch(['run', 'mk'], NONROOT);
  const unnamedSeen = await sawTriggerKind((unnamed.json as { run: string }).run);
  assert.equal(unnamedSeen?.kind, 'manual', 'unnamed manual run is manual');
  assert.equal(unnamedSeen?.name, 'undefined', 'no --trigger → triggerName undefined');
});

test('run input cannot forge host-written triggerKind or triggerName', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'input-forge', {
    pipeline: `export async function run(ctx){ ctx.emit('saw.kind', {
      kind: ctx.triggerKind,
      name: ctx.triggerName,
      inputKind: ctx.input?.triggerKind,
      inputName: ctx.input?.triggerName,
    }); }`,
  });
  const res = await dispatch([
    'run',
    'input-forge',
    '--trigger',
    'host-name',
    '--input',
    JSON.stringify({ triggerKind: 'cron', triggerName: 'input-name' }),
  ], NONROOT);
  const trace = await dispatch(['trace', (res.json as { run: string }).run]);
  const seen = (trace.json as { events: { kind: string; payload: Record<string, string> }[] })
    .events.find((event) => event.kind === 'saw.kind')!.payload;
  assert.deepEqual(seen, {
    kind: 'manual',
    name: 'host-name',
    inputKind: 'cron',
    inputName: 'input-name',
  });
});

// ── 4.2 name collision: manual --trigger daily on an app with a cron trigger named daily ──
// Honest note (per spec): cmdRun does not read app.spec.triggers, so kind has no path to leak
// from the spec — the load-bearing assertion is "host writes manual". The same-named `daily`
// cron trigger is a faithful-to-spec regression guard, not the source of discrimination.
test('run --trigger daily colliding with a same-named cron trigger stays kind=manual, name=daily', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'coll', { triggerName: 'daily', pipeline: KIND_PIPELINE });

  const res = await dispatch(['run', 'coll', '--trigger', 'daily'], NONROOT);
  const seen = await sawTriggerKind((res.json as { run: string }).run);
  assert.equal(seen?.kind, 'manual', 'name collision with a cron trigger does NOT promote the run to cron');
  assert.equal(seen?.name, 'daily');
});

// ── 4.3①② cron arm: daemonRunOne writes an unforgeable triggerKind==='cron' (named + unnamed) ──
// Direct test of the extracted daemonRunOne — the true cron-arm proof, not a
// makeFireGate-injected stub: real LoadedApp from loadApps() + real PipelineGateway/runApp
// inside daemonRunOne, and two app ids so createRun's single-active-run lock never collides
// between the two fires. (startDaemon's routing through daemonRunOne is verified by inspection,
// not asserted here — an automated wiring test would need startDaemon to expose its fire.)
test('daemonRunOne: cron fire yields ctx.triggerKind==="cron" for named and unnamed triggers', async () => {
  const { appsDir } = tmpEnv();
  writeApp(appsDir, 'cron-named', { pipeline: KIND_PIPELINE });
  writeApp(appsDir, 'cron-unnamed', { pipeline: KIND_PIPELINE });
  const apps = loadApps().apps;
  const named = apps.find((a) => a.id === 'cron-named')!;
  const unnamed = apps.find((a) => a.id === 'cron-unnamed')!;

  const db = openDb();
  try {
    const sawKind = (runId: string): { kind?: string; name?: string } =>
      JSON.parse(
        (
          db
            .prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='saw.kind'")
            .get(runId) as { p: string }
        ).p,
      );
    // daemonRunOne resolves to the run id on success (runApp's return passes through .catch).
    const namedRun = (await daemonRunOne(db, named, 'daily')) as string;
    assert.equal(sawKind(namedRun).kind, 'cron', 'named cron fire → triggerKind cron (host-written)');
    assert.equal(sawKind(namedRun).name, 'daily', 'named cron → triggerName is the trigger name');

    const unnamedRun = (await daemonRunOne(db, unnamed, undefined)) as string;
    assert.equal(sawKind(unnamedRun).kind, 'cron', 'unnamed cron fire → still triggerKind cron');
    assert.equal(sawKind(unnamedRun).name, 'undefined', 'unnamed cron → triggerName undefined');
  } finally {
    db.close();
  }
});

// ── R2-F2: daemon fails fast if the lock fingerprint is unresolvable ──────────
test('daemon refuses to start when lockOwner throws (no silent idle, no db created)', () => {
  const { dbPath } = tmpEnv();
  const r = startDaemon(NONROOT, () => {
    throw new Error('cannot resolve start time');
  });
  assert.ok(!('shutdown' in r), 'unresolvable lock returns a Result, not a started daemon');
  assert.equal(r.code, 1);
  assert.equal(r.errKind, 'internal');
  assert.equal(existsSync(dbPath), false, 'pre-check fails before opening/creating the db');
});

// ── 5.3/5.4 daemon graceful shutdown + manual-run SIGINT (driven, no real signals) ──
// A far-future cron so the real timer never fires mid-test; runs are driven via h.fire.
const NEVER = '0 0 1 1 *';
// Cooperative pilot: parks on the abort signal (with an entry guard for abort-before-park)
// and winds down when cancelled. HANG ignores the signal and never settles.
const COOP = `export async function run(ctx){
  ctx.emit('domain.ready', {});
  await new Promise((_res, reject) => {
    if (ctx.signal.aborted) return reject(new Error('cancelled'));
    ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
}`;
const HANG = `export async function run(){ await new Promise(() => {}); }`;

const appById = (id: string): LoadedApp => loadApps().apps.find((a) => a.id === id)!;
function runStateOfId(db: DB, id: string): string {
  return (db.prepare('SELECT state FROM Run WHERE id=?').get(id) as { state: string }).state;
}
function lockOwnerOfId(db: DB, id: string): string | null {
  return (db.prepare('SELECT lock_owner FROM Run WHERE id=?').get(id) as { lock_owner: string | null })
    .lock_owner;
}
function terminalKindsOf(db: DB, id: string): string[] {
  return (
    db
      .prepare(
        "SELECT kind FROM RunEvent WHERE run_id=? AND kind IN ('run.completed','run.failed','run.cancelled') ORDER BY seq",
      )
      .all(id) as { kind: string }[]
  ).map((r) => r.kind);
}
async function pollRunId(db: DB, appId: string): Promise<string> {
  for (let i = 0; i < 5000; i++) {
    const row = db.prepare('SELECT id FROM Run WHERE app_id=? LIMIT 1').get(appId) as
      | { id: string }
      | undefined;
    if (row) return row.id;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error(`no run appeared for ${appId}`);
}
async function pollEventKind(db: DB, kind: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (db.prepare('SELECT 1 FROM RunEvent WHERE kind=? LIMIT 1').get(kind)) return;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error(`timeout waiting for ${kind}`);
}
/** startDaemon installs SIGINT/SIGTERM handlers, opens a db, and schedules cron. Tests
 *  drive shutdown directly (never a real signal), so clean up the process-level effects. */
function stopDaemonEffects(): void {
  for (const task of cron.getTasks().values()) task.destroy();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
}

test('5.3 daemon shutdown: aborts an in-flight run → run.cancelled within grace (real Map); 2nd shutdown is an idempotent no-op', async (t) => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'coop', { schedule: NEVER, pipeline: COOP });
  const h = startDaemon(NONROOT);
  assert.ok('shutdown' in h, 'non-root start returns a DaemonHandle');
  t.after(stopDaemonEffects);

  h.fire(appById('coop'), undefined); // real runApp + real onActive → real active Map (no stub)
  const db = openDb(dbPath);
  try {
    const runId = await pollRunId(db, 'coop');
    const t0 = Date.now();
    await h.shutdown(2000); // abort-all, then poll Map.size to empty (not a blind sleep)
    assert.ok(Date.now() - t0 < 2000, 'settled before the deadline → active Map emptied, not a full-grace timeout');
    assert.equal(runStateOfId(db, runId), 'cancelled');
    assert.deepEqual(terminalKindsOf(db, runId), ['run.cancelled'], 'exactly one terminal, cancelled');
    assert.equal(lockOwnerOfId(db, runId), null, 'cancel released the app lock');

    const t1 = Date.now();
    await h.shutdown(2000); // SIGINT→SIGTERM style 2nd call
    assert.ok(Date.now() - t1 < 100, '2nd shutdown early-returns (idempotent: no re-abort, no re-wait)');
    assert.deepEqual(terminalKindsOf(db, runId), ['run.cancelled'], 'no duplicate terminal from the 2nd shutdown');
  } finally {
    db.close();
  }
});

test('5.3 daemon shutdown: a signal-ignoring run outlives grace → left non-terminal, then reaped to run.failed (cleanup-timeout, not cancelled)', async (t) => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'hang', { schedule: NEVER, pipeline: HANG });
  const h = startDaemon(NONROOT);
  assert.ok('shutdown' in h);
  t.after(stopDaemonEffects);

  h.fire(appById('hang'), undefined);
  const db = openDb(dbPath);
  try {
    const runId = await pollRunId(db, 'hang');
    await h.shutdown(100); // abort has no effect (pipeline ignores signal); grace times out
    assert.ok(
      !['completed', 'failed', 'cancelled'].includes(runStateOfId(db, runId)),
      'grace-timeout run is left non-terminal, never force-written at shutdown',
    );
    // Its lock_owner is THIS live test process, so a naive reap won't touch it — that's the
    // point of the cleanup-timeout leg: forge a dead owner to exercise the reaper fallback.
    assert.ok(lockOwnerOfId(db, runId), 'in-flight run holds a live lock owner');
    db.prepare('UPDATE Run SET lock_owner=? WHERE id=?').run('999999:1', runId);
    assert.deepEqual(reap(db), [runId], 'the next daemon start reaps the dead-owner orphan');
    assert.equal(runStateOfId(db, runId), 'failed', 'reaper records failed, NOT cancelled');
    const payload = JSON.parse(
      (db.prepare("SELECT payload_json p FROM RunEvent WHERE run_id=? AND kind='run.failed'").get(runId) as {
        p: string;
      }).p,
    );
    assert.equal(payload.reason, 'reaped', 'cleanup-timeout → reason=reaped, distinct from a clean cancel');
  } finally {
    db.close();
  }
});

test('5.3 daemon shutdown: once shuttingDown is latched, a fire (cron tick / drain) creates no new run', async (t) => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'gate', { schedule: NEVER, pipeline: COOP });
  const h = startDaemon(NONROOT);
  assert.ok('shutdown' in h);
  t.after(stopDaemonEffects);

  const sd = h.shutdown(150); // latches shuttingDown synchronously
  h.fire(appById('gate'), undefined); // a cron tick landing in the shutdown window → must be gated
  await sd;
  const db = openDb(dbPath);
  try {
    const count = (db.prepare('SELECT count(*) c FROM Run WHERE app_id=?').get('gate') as { c: number }).c;
    assert.equal(count, 0, 'shuttingDown gate stops fire from createRun-ing a run that would escape abort-all');
  } finally {
    db.close();
  }
});

async function waitForExternalRunReady(dbPath: string, appId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(dbPath)) {
      let db: DB | undefined;
      try {
        db = openDb(dbPath);
        const row = db.prepare(
          "SELECT r.id FROM Run r JOIN RunEvent e ON e.run_id=r.id WHERE r.app_id=? AND e.kind='cleanup.ready' LIMIT 1",
        ).get(appId) as { id: string } | undefined;
        if (row) return row.id;
      } catch {
        // The daemon may still be creating/migrating the database; retry until ready.
      } finally {
        db?.close();
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timeout waiting for external daemon run ${appId}`);
}

test('5.3 daemon SIGINT/SIGTERM, including a second signal, honor 12s grace for real cleanup lasting over 5s', async () => {
  const cliEntry = resolve(import.meta.dirname, 'cli.ts');
  const scenarios: Array<{ label: string; signals: NodeJS.Signals[] }> = [
    { label: 'sigint', signals: ['SIGINT'] },
    { label: 'sigterm', signals: ['SIGTERM'] },
    { label: 'sigint-sigterm', signals: ['SIGINT', 'SIGTERM'] },
  ];
  for (const { label, signals } of scenarios) {
    const root = mkdtempSync(join(tmpdir(), `hangar-daemon-${label}-`));
    const appsDir = join(root, 'apps');
    const dbPath = join(root, 'hangar.sqlite');
    mkdirSync(appsDir, { recursive: true });
    const appId = `slow-${label}`;
    writeApp(appsDir, appId, {
      schedule: '* * * * * *',
      pipeline: `export async function run(ctx) {
        ctx.emit('cleanup.ready', {});
        await new Promise((_resolve, reject) => {
          const cleanup = () => setTimeout(() => reject(new Error('cancelled after cleanup')), 5100);
          if (ctx.signal.aborted) cleanup();
          else ctx.signal.addEventListener('abort', cleanup, { once: true });
        });
      }`,
    });
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, 'daemon'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        HANGAR_APPS: appsDir,
        HANGAR_DB: dbPath,
        HANGAR_SHUTDOWN_GRACE_MS: '12000',
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      const runId = await waitForExternalRunReady(dbPath, appId);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `${label} daemon did not exit within 12s grace; stdout=${stdout}; stderr=${stderr}`,
        )), 12_500);
        child.once('close', (code, childSignal) => {
          clearTimeout(timer);
          resolveExit({ code, signal: childSignal });
        });
      });
      const started = Date.now();
      assert.equal(child.kill(signals[0]!), true, `${signals[0]} delivered to daemon`);
      if (signals[1]) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        assert.equal(child.kill(signals[1]), true, `${signals[1]} delivered during shutdown grace`);
      }
      const exit = await exited;
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 5_000, `${label} did not exit before >5s cleanup completed (${elapsed}ms)`);
      assert.ok(elapsed < 12_000, `${label} settled within configured 12s grace (${elapsed}ms)`);
      assert.deepEqual(exit, { code: 0, signal: null }, `${label} is a graceful daemon exit`);

      const db = openDb(dbPath);
      try {
        assert.equal(runStateOfId(db, runId), 'cancelled');
        assert.deepEqual(terminalKindsOf(db, runId), ['run.cancelled']);
        assert.equal(lockOwnerOfId(db, runId), null, 'cancelled run releases its lock');
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
});

test('5.4 hangar run cancelled by SIGINT → exit code 1 + prints run id/state (reject cancelled stays 0, covered above)', async () => {
  const { dbPath, appsDir } = tmpEnv();
  writeApp(appsDir, 'sig', { pipeline: COOP });
  const db = openDb(dbPath);
  const before = new Set(process.listeners('SIGINT'));
  try {
    const runP = dispatch(['run', 'sig'], NONROOT);
    await pollEventKind(db, 'domain.ready'); // cmdRun's run is parked on the abort listener
    // cmdRun registered its abort via process.once('SIGINT', abort). Invoke it directly (no real
    // signal → no process.exit, no test-runner interference) — the "grab abort from onActive" path.
    const added = process.listeners('SIGINT').filter((l) => !before.has(l));
    assert.equal(added.length, 1, 'cmdRun installed exactly one SIGINT abort');
    (added[0] as () => void)();
    const res = await runP;
    assert.equal(res.code, 1, 'cancelled → exit code 1 (business-failure band, same as failed)');
    const out = res.json as { run: string; state: string };
    assert.equal(out.state, 'cancelled');
    assert.ok(out.run, 'prints the run id for tracing');
    assert.ok(res.text?.includes('cancelled'), 'text carries `<runId> -> cancelled`');
    assert.deepEqual(
      process.listeners('SIGINT').filter((l) => !before.has(l)),
      [],
      'cmdRun removed its SIGINT listener on settle (no leak)',
    );
  } finally {
    db.close();
    process.removeAllListeners('SIGINT');
  }
});

// ── 5.5 doctor --json broadcasts the full capability set (three-state assertCapabilities
//     is already covered in capabilities.test.ts — reused, not duplicated here). ──
test('5.5 doctor --json capabilities[] is the canonical HOST_CAPABILITIES set', async () => {
  tmpEnv();
  const res = await dispatch(['doctor', '--json']);
  const caps = (res.json as { capabilities: string[] }).capabilities;
  assert.strictEqual(caps, HOST_CAPABILITIES, 'doctor returns the canonical set, not a duplicate');
  assert.deepEqual([...caps].sort(), [...HOST_CAPABILITIES].sort(), 'broadcast set === HOST_CAPABILITIES');
  for (const c of [
    'hangar.run.trigger-kind/v1',
    'hangar.run.abort-signal/v1',
    'hangar.run.cancelled-terminal/v1',
    'hangar.run.runtime-capabilities/v1',
  ]) {
    assert.ok(caps.includes(c), `capabilities[] contains ${c}`);
  }
});
