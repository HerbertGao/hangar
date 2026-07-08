import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { loadApps, type LoadedApp } from './registry.js';
import { EVENT } from './events.js';
import {
  dispatch,
  startDaemon,
  hasActiveRun,
  daemonTasks,
  deriveBlocked,
  cronPeriodMs,
  makeFireGate,
  nodeSupported,
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
  opts: { approval?: string[]; pipeline: string; tools?: string; schedule?: string },
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
  assert.ok(d && d.code === 1 && d.errKind === 'refuse_root', 'daemon refuses root');
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
    checks: { sqlite_writable: string; apps_dir: string; apps: { id: string; spec: string; pipeline: string }[] };
  };
  assert.equal(report.checks.sqlite_writable, 'ok'); // dir writable, file absent
  assert.equal(report.checks.apps_dir, 'ok');
  assert.deepEqual(
    report.checks.apps.find((a) => a.id === 'good'),
    { id: 'good', spec: 'ok', pipeline: 'ok' },
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
  const runsRes = await dispatch(['runs', 'tr']); // one run so far → newest is this one
  assert.equal((runsRes.json as { trigger: string }[])[0].trigger, 'digest', 'Run.trigger stores the name');

  const noFlag = await dispatch(['run', 'tr'], NONROOT);
  assert.equal(await sawTrigger((noFlag.json as { run: string }).run), 'undefined', 'no --trigger → ctx.trigger undefined');

  // bare --trigger (no value) is a usage error
  assert.equal((await dispatch(['run', 'tr', '--trigger'], NONROOT)).code, 2);
});

// ── R2-F2: daemon fails fast if the lock fingerprint is unresolvable ──────────
test('daemon refuses to start when lockOwner throws (no silent idle, no db created)', () => {
  const { dbPath } = tmpEnv();
  const r = startDaemon(NONROOT, () => {
    throw new Error('cannot resolve start time');
  });
  assert.ok(r && r.code === 1 && r.errKind === 'internal', 'daemon fails fast, not into cron loop');
  assert.equal(existsSync(dbPath), false, 'pre-check fails before opening/creating the db');
});
