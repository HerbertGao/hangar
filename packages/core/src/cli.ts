#!/usr/bin/env node
// Requires Node >=22.18 (see package.json engines): apps ship pipeline.ts/tools.ts
// as .ts and are imported directly, so the runtime needs flag-free native TS type-
// stripping — backported to 22.18 (default in 23.6). On 22.0–22.17 an app's .ts
// import throws ERR_UNKNOWN_FILE_EXTENSION unless --experimental-strip-types is set.
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import cron from 'node-cron';
import { openDb, openDbReadonly, resolveDbPath, type DB } from './db.js';
import { lockOwner } from './lock.js';
import {
  checkPipeline,
  loadApps,
  type LoadedApp,
  type RegistryLoad,
} from './registry.js';
import { runApp } from './executor.js';
import { PipelineGateway } from './gateway.js';
import { reap } from './reaper.js';
import { EngineError } from './store.js';

// Logs → stderr, data → stdout (CLI contract).
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

/** Flag-free native .ts type-stripping is the binding constraint: backported to
 *  Node 22.18 (default in 23.6). 22.0–22.17 would false-green here but crash on the
 *  first app .ts import, so the floor is major.minor, not just major. */
const MIN_NODE = { major: 22, minor: 18 };

/** True iff `version` (default: this runtime) can flag-free import an app's .ts. */
export function nodeSupported(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

const HELP = `hangar — headless AgentOS spine

Usage: hangar <command> [options]

Commands:
  run <app> [--input <json>]    trigger a run
  status                        each app's latest run state (+ derived block)
  runs [<app>]                  run history
  trace <run>                   full event timeline of a run
  approve <run>                 execute a run's pending approvals
  reject <run> [--reason ...]   reject pending approvals
  doctor                        environment self-check (never creates the db)
  daemon                        start the cron scheduler (long-running)

Global: --json for structured stdout. Logs go to stderr.
Exit codes: 0 ok / 1 business failure / 2 usage error.
`;

// ── result plumbing ─────────────────────────────────────────────────────────
// A command returns a Result; main() serializes it and picks stdout vs stderr.
// This keeps every command body pure/testable (no direct process I/O or exit).
export interface Result {
  code: number;
  json?: unknown; // success payload → stdout when --json
  text?: string; // success payload → stdout otherwise (includes trailing \n)
  errKind?: string; // business/usage failure kind (→ {ok:false,kind} in --json)
  errMsg?: string; // human error (→ stderr otherwise)
}

export interface Deps {
  /** EUID probe; injectable so root-refusal is testable. undefined on platforms without getuid. */
  getuid: () => number | undefined;
}
const defaultDeps: Deps = { getuid: () => process.getuid?.() };

const usage = (msg: string): Result => ({ code: 2, errKind: 'usage', errMsg: msg });
const notFound = (runId: string): Result => ({
  code: 1,
  errKind: 'run_not_found',
  errMsg: `run ${runId} not found`,
});

/** Write commands (run/approve/reject/daemon) refuse root; read-only + doctor do not. */
function refuseRoot(deps: Deps): Result | null {
  return deps.getuid() === 0
    ? { code: 1, errKind: 'refuse_root', errMsg: 'refusing to run a write command as root (EUID==0)' }
    : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ── arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(args: string[]): {
  positionals: string[];
  flags: Record<string, string | true>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (key !== 'json' && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

// ── run row helpers ─────────────────────────────────────────────────────────
interface RunRow {
  id: string;
  app_id: string;
  state: string;
}
function getRun(db: DB, id: string): RunRow | undefined {
  return db.prepare('SELECT id, app_id, state FROM Run WHERE id=?').get(id) as
    | RunRow
    | undefined;
}
function runStateOf(db: DB, id: string): string {
  return getRun(db, id)?.state ?? 'unknown';
}

// ── derived "blocked" (6.3) ─────────────────────────────────────────────────
// Not persisted. A waiting_human run is blocking its app once it has been parked
// longer than one cron period (i.e. it already ate at least one scheduled fire).
// ponytail: node-cron's createTask.getNextRuns(2) gives the EXACT period (gap
// between consecutive fires) — no cron-arithmetic guesswork, no 5th table.
export function cronPeriodMs(schedule: string, timezone?: string): number | null {
  try {
    const opts = timezone
      ? { timezone, name: `probe_${randomUUID()}` }
      : { name: `probe_${randomUUID()}` };
    const task = cron.createTask(schedule, () => {}, opts);
    const runs = task.getNextRuns(2);
    task.destroy();
    return runs && runs.length === 2 ? runs[1].getTime() - runs[0].getTime() : null;
  } catch {
    return null;
  }
}

function appPeriodMs(triggers: { schedule: string; timezone?: string }[]): number | null {
  const periods = triggers
    .map((t) => cronPeriodMs(t.schedule, t.timezone))
    .filter((p): p is number => p != null);
  return periods.length ? Math.min(...periods) : null;
}

export function deriveBlocked(
  triggers: { schedule: string; timezone?: string }[],
  state: string,
  startedAt: string,
  now: number,
): boolean {
  if (state !== 'waiting_human') return false;
  const period = appPeriodMs(triggers);
  if (period == null) return false; // no cron → nothing schedules it, so not "overdue"
  const age = now - Date.parse(startedAt);
  return Number.isFinite(age) && age > period;
}

// ── doctor (6.5) ────────────────────────────────────────────────────────────
function pnpmOk(): boolean {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export interface DoctorReport {
  ok: boolean;
  checks: {
    node: string;
    pnpm: string;
    sqlite_writable: string;
    apps_dir: string;
    apps: { id: string; spec: string; pipeline: string }[];
    /** apps blocked by an overdue parked run — derived, same rule as status. */
    blocked: string[];
  };
}

export function doctorReport(): DoctorReport {
  const node = nodeSupported() ? 'ok' : 'unsupported';
  const pnpm = pnpmOk() ? 'ok' : 'missing'; // informational (matches SKILL shape); not part of ok

  // Non-destructive writability: probe the FILE if it exists (catches a root-owned
  // db a non-root run could never write), else the DIR — never create the db.
  const dbPath = resolveDbPath();
  let sqlite_writable: string;
  try {
    accessSync(existsSync(dbPath) ? dbPath : dirname(dbPath), constants.W_OK);
    sqlite_writable = 'ok';
  } catch {
    sqlite_writable = 'sqlite_unwritable';
  }

  const load = loadApps();
  const apps_dir = load.appsDirMissing ? 'apps_dir_missing' : 'ok';
  const apps = [
    ...load.apps.map((a) => ({
      id: a.id,
      spec: 'ok',
      pipeline: checkPipeline(a) === 'pipeline_missing' ? 'pipeline_missing' : 'ok',
    })),
    ...load.errors.map((e) => ({ id: e.id, spec: 'spec_invalid', pipeline: 'unknown' })),
  ];

  // Derive blocked apps (same rule as status) so "forgot to approve" surfaces here
  // too. Read-ONLY on an EXISTING db — never create/write it (guards the non-
  // destructive contract; openDb would run DDL and create the file if absent).
  // ponytail: unlike status/runs/trace, doctor keeps its own try/catch so it stays a
  // report that ALWAYS returns even if the db is unreadable (root-owned or corrupt) —
  // sqlite_writable already flags that as the real problem, so blocked=[] is fine here.
  const blocked: string[] = [];
  if (existsSync(dbPath)) {
    try {
      const db = openDbReadonly(dbPath);
      try {
        const nowMs = Date.now();
        for (const a of load.apps) {
          const latest = db
            .prepare(
              `SELECT state, started_at FROM Run WHERE app_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
            )
            .get(a.id) as { state: string; started_at: string } | undefined;
          if (latest && deriveBlocked(a.spec.triggers, latest.state, latest.started_at, nowMs)) {
            blocked.push(a.id);
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // leave blocked=[]; the env problem shows up in sqlite_writable/apps checks
    }
  }

  const ok =
    node === 'ok' &&
    sqlite_writable === 'ok' &&
    apps_dir === 'ok' &&
    apps.every((a) => a.spec === 'ok' && a.pipeline === 'ok');
  return { ok, checks: { node, pnpm, sqlite_writable, apps_dir, apps, blocked } };
}

function cmdDoctor(): Result {
  const report = doctorReport();
  const lines = [
    `ok: ${report.ok}`,
    `node: ${report.checks.node}`,
    `pnpm: ${report.checks.pnpm}`,
    `sqlite_writable: ${report.checks.sqlite_writable}`,
    `apps_dir: ${report.checks.apps_dir}`,
    ...report.checks.apps.map((a) => `  ${a.id}: spec=${a.spec} pipeline=${a.pipeline}`),
    `blocked: ${report.checks.blocked.length ? report.checks.blocked.join(', ') : '-'}`,
  ];
  // doctor is a diagnostic: it always exits 0 when it produced a report; health
  // rides in the `ok` field (the Agent pings `doctor --json` and reads `ok`).
  return { code: 0, json: report, text: lines.join('\n') + '\n' };
}

// ── read-only commands (6.3): no reap, no root check, never create/write the db ─
/** Open the state store read-only for a read command. Returns null ONLY when the db
 *  file is absent (a legitimate empty result — a read command must never create it).
 *  If the file exists but can't be opened (EACCES / corrupt), the error propagates so
 *  status/runs/trace fail loudly (main() → code 1 internal) instead of masking a
 *  permission/corruption problem as "no data". */
function openReadonlyOrNull(): DB | null {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return null;
  return openDbReadonly(dbPath);
}

function cmdStatus(): Result {
  const load = loadApps();
  const db = openReadonlyOrNull();
  const now = Date.now();
  const rows = load.apps.map((app) => {
    const latest = db
      ? (db
          .prepare(
            `SELECT id, state, started_at FROM Run WHERE app_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
          )
          .get(app.id) as { id: string; state: string; started_at: string } | undefined)
      : undefined;
    const blocked = latest
      ? deriveBlocked(app.spec.triggers, latest.state, latest.started_at, now)
      : false;
    return {
      app: app.id,
      lastRun: latest?.id ?? null,
      state: latest?.state ?? null,
      since: latest?.started_at ?? null,
      blocked,
    };
  });
  db?.close();
  const text = rows.length
    ? rows
        .map((r) => `${r.app}\t${r.state ?? '-'}\t${r.lastRun ?? '-'}${r.blocked ? '\tBLOCKED' : ''}`)
        .join('\n') + '\n'
    : '(no apps)\n';
  return { code: 0, json: rows, text };
}

function cmdRuns(appFilter?: string): Result {
  const db = openReadonlyOrNull();
  if (!db) return { code: 0, json: [], text: '(no runs)\n' };
  const rows = (
    appFilter
      ? db
          .prepare(
            `SELECT id, app_id, state, trigger, started_at, ended_at FROM Run WHERE app_id=? ORDER BY started_at DESC, rowid DESC`,
          )
          .all(appFilter)
      : db
          .prepare(
            `SELECT id, app_id, state, trigger, started_at, ended_at FROM Run ORDER BY started_at DESC, rowid DESC`,
          )
          .all()
  ) as {
    id: string;
    app_id: string;
    state: string;
    trigger: string;
    started_at: string;
    ended_at: string | null;
  }[];
  db.close();
  const out = rows.map((r) => ({
    id: r.id,
    app: r.app_id,
    state: r.state,
    trigger: r.trigger,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
  const text = out.length
    ? out.map((r) => `${r.id}\t${r.app}\t${r.state}\t${r.trigger}`).join('\n') + '\n'
    : '(no runs)\n';
  return { code: 0, json: out, text };
}

function cmdTrace(runId?: string): Result {
  if (!runId) return usage('usage: hangar trace <run>');
  const db = openReadonlyOrNull();
  const run = db ? getRun(db, runId) : undefined;
  if (!db || !run) {
    db?.close();
    return notFound(runId);
  }
  const events = (
    db
      .prepare(`SELECT seq, kind, payload_json, at FROM RunEvent WHERE run_id=? ORDER BY seq`)
      .all(runId) as { seq: number; kind: string; payload_json: string; at: string }[]
  ).map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, payload: safeJson(e.payload_json) }));
  const pendingApprovals = (
    db
      .prepare(
        `SELECT id, tool, args_json FROM Approval WHERE run_id=? AND status='pending' ORDER BY rowid`,
      )
      .all(runId) as { id: string; tool: string; args_json: string }[]
  ).map((a) => ({ id: a.id, tool: a.tool, args: safeJson(a.args_json) }));
  db.close();
  const json = { run: run.id, app: run.app_id, state: run.state, events, pendingApprovals };
  const text =
    [
      `run ${run.id} (${run.app_id}) ${run.state}`,
      ...events.map((e) => `  #${e.seq} ${e.kind} @ ${e.at}`),
      ...(pendingApprovals.length
        ? ['pending:', ...pendingApprovals.map((p) => `  ${p.id} ${p.tool}`)]
        : []),
    ].join('\n') + '\n';
  return { code: 0, json, text };
}

// ── write commands (6.2/6.4): refuse root, reap on entry ─────────────────────
async function cmdRun(
  deps: Deps,
  appId: string | undefined,
  flags: Record<string, string | true>,
): Promise<Result> {
  const root = refuseRoot(deps);
  if (root) return root;
  if (!appId) return usage('usage: hangar run <app> [--input <json>]');

  let input: unknown;
  if (typeof flags.input === 'string') {
    try {
      input = JSON.parse(flags.input);
    } catch {
      return usage('--input must be valid JSON');
    }
  } else if (flags.input === true) {
    return usage('--input requires a JSON value');
  }

  const load = loadApps();
  const app = load.apps.find((a) => a.id === appId);
  if (!app) {
    const bad = load.errors.find((e) => e.id === appId);
    if (bad) return { code: 1, errKind: 'spec_invalid', errMsg: `app ${appId}: ${bad.detail}` };
    return { code: 1, errKind: 'app_not_found', errMsg: `app ${appId} not found` };
  }

  const db = openDb();
  try {
    reap(db);
    const gateway = new PipelineGateway(db, app.dir, app.spec.permissions.approval);
    const runId = await runApp(
      db,
      {
        appId,
        appDir: app.dir,
        executor: app.spec.executor,
        config: app.spec.config,
        input,
        trigger: 'manual',
      },
      gateway,
    );
    const state = runStateOf(db, runId);
    // Mirror approve: a thrown pipeline collapses the run to 'failed' via chokePoint
    // (runApp returns, not throws), so map the terminal state to the exit code —
    // failed → 1 (business failure), waiting_human (parked) / completed → 0. No errKind:
    // keep run/state detail, which emit()'s {ok:false,kind} error branch would drop.
    const code = state === 'failed' ? 1 : 0;
    return { code, json: { run: runId, state }, text: `${runId} -> ${state}\n` };
  } catch (e) {
    if (e instanceof EngineError) return { code: 1, errKind: e.kind, errMsg: e.message };
    throw e;
  } finally {
    db.close();
  }
}

/** Shared prelude for approve/reject: refuse root, resolve the run + its gateway. */
function openForDecision(
  deps: Deps,
  runId: string | undefined,
  verb: string,
): Result | { db: DB; runId: string; gateway: PipelineGateway } {
  const root = refuseRoot(deps);
  if (root) return root;
  if (!runId) return usage(`usage: hangar ${verb} <run>`);
  if (!existsSync(resolveDbPath())) return notFound(runId);

  const db = openDb();
  reap(db);
  const run = getRun(db, runId);
  if (!run) {
    db.close();
    return notFound(runId);
  }
  const app = loadApps().apps.find((a) => a.id === run.app_id);
  if (!app) {
    db.close();
    return {
      code: 1,
      errKind: 'app_not_found',
      errMsg: `app ${run.app_id} for run ${runId} is not registered`,
    };
  }
  return {
    db,
    runId,
    gateway: new PipelineGateway(db, app.dir, app.spec.permissions.approval),
  };
}

async function cmdApprove(deps: Deps, runId: string | undefined): Promise<Result> {
  const ctx = openForDecision(deps, runId, 'approve');
  if (!('db' in ctx)) return ctx;
  const { db } = ctx;
  try {
    await ctx.gateway.approve(ctx.runId);
    const state = runStateOf(db, ctx.runId);
    const executed = (
      db
        .prepare(
          `SELECT tool, status FROM Approval WHERE run_id=? AND status IN ('granted','failed') ORDER BY rowid`,
        )
        .all(ctx.runId) as { tool: string; status: string }[]
    ).map((a) => ({ tool: a.tool, ok: a.status === 'granted' }));
    // The action ran through chokePoint even on failure (run.failed, not a throw),
    // so map the run's terminal state to the exit code: completed→0, anything else
    // (failed…)→1. No errKind — the failure detail rides in state/executed and would
    // otherwise be dropped by emit()'s {ok:false,kind} error branch.
    const code = state === 'completed' ? 0 : 1;
    return { code, json: { run: ctx.runId, state, executed }, text: `${ctx.runId} -> ${state}\n` };
  } catch (e) {
    if (e instanceof EngineError) return { code: 1, errKind: e.kind, errMsg: e.message };
    throw e;
  } finally {
    db.close();
  }
}

async function cmdReject(
  deps: Deps,
  runId: string | undefined,
  flags: Record<string, string | true>,
): Promise<Result> {
  const ctx = openForDecision(deps, runId, 'reject');
  if (!('db' in ctx)) return ctx;
  const { db } = ctx;
  const reason = typeof flags.reason === 'string' ? flags.reason : undefined;
  try {
    await ctx.gateway.reject(ctx.runId, reason);
    const state = runStateOf(db, ctx.runId);
    const rejected = (
      db
        .prepare(`SELECT id FROM Approval WHERE run_id=? AND status='rejected' ORDER BY rowid`)
        .all(ctx.runId) as { id: string }[]
    ).map((a) => a.id);
    return { code: 0, json: { run: ctx.runId, state, rejected }, text: `${ctx.runId} -> ${state}\n` };
  } catch (e) {
    if (e instanceof EngineError) return { code: 1, errKind: e.kind, errMsg: e.message };
    throw e;
  } finally {
    db.close();
  }
}

// ── daemon (6.6) ─────────────────────────────────────────────────────────────
export function hasActiveRun(db: DB, appId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM Run WHERE app_id=? AND state NOT IN ('completed','failed','cancelled') LIMIT 1`,
    )
    .get(appId);
}

/** Flatten registry apps → one scheduling task per cron trigger (testable, pure). */
export function daemonTasks(
  load: RegistryLoad,
): { appId: string; schedule: string; timezone?: string }[] {
  return load.apps.flatMap((app) =>
    app.spec.triggers.map((t) => ({ appId: app.id, schedule: t.schedule, timezone: t.timezone })),
  );
}

/**
 * Register cron per trigger; on fire, only start a run when the app has NO active
 * run (else skip + stderr log — the block is never persisted, it's derived by
 * status/doctor). Returns a Result on refusal (root), or null once started.
 * Long-running: main() keeps the process alive; cron timers do the rest.
 */
export function startDaemon(
  deps: Deps = defaultDeps,
  probeLock: () => string = lockOwner,
): Result | null {
  const root = refuseRoot(deps);
  if (root) return root;
  // Pre-check the lock fingerprint before wiring cron. If this host can't resolve
  // its own start time, lockOwner() throws — and since every cron fire's runApp
  // writes that fingerprint, each fire would reject into .catch() and the daemon
  // would idle forever, silently never working. Fail fast with a clear message.
  try {
    probeLock();
  } catch (e) {
    return { code: 1, errKind: 'internal', errMsg: String((e as Error)?.message ?? e) };
  }
  const db = openDb();
  reap(db);
  const load = loadApps();
  const byId = new Map<string, LoadedApp>(load.apps.map((a) => [a.id, a]));
  for (const t of daemonTasks(load)) {
    const app = byId.get(t.appId)!;
    cron.schedule(
      t.schedule,
      () => {
        if (hasActiveRun(db, t.appId)) {
          log.info({ app: t.appId }, 'cron fire skipped: app has an active run');
          return;
        }
        const gateway = new PipelineGateway(db, app.dir, app.spec.permissions.approval);
        runApp(
          db,
          {
            appId: t.appId,
            appDir: app.dir,
            executor: app.spec.executor,
            config: app.spec.config,
            trigger: 'cron',
          },
          gateway,
        ).catch((err) =>
          log.error({ app: t.appId, err: String((err as Error)?.message ?? err) }, 'cron run failed'),
        );
      },
      t.timezone ? { timezone: t.timezone } : undefined,
    );
  }
  log.info({ tasks: daemonTasks(load).length, apps: load.apps.length }, 'daemon started');
  return null;
}

// ── dispatch + main ──────────────────────────────────────────────────────────
export async function dispatch(argv: string[], deps: Deps = defaultDeps): Promise<Result> {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { code: 0, text: HELP };
  const { positionals, flags } = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'doctor':
      return cmdDoctor();
    case 'status':
      return cmdStatus();
    case 'runs':
      return cmdRuns(positionals[0]);
    case 'trace':
      return cmdTrace(positionals[0]);
    case 'run':
      return cmdRun(deps, positionals[0], flags);
    case 'approve':
      return cmdApprove(deps, positionals[0]);
    case 'reject':
      return cmdReject(deps, positionals[0], flags);
    case 'daemon':
      // real start is handled by main() (long-running); here just honor the root
      // guard so a stray dispatch(['daemon']) never spins up cron timers.
      return refuseRoot(deps) ?? { code: 0, text: 'daemon is long-running; run `hangar daemon`\n' };
    default:
      return { code: 2, errKind: 'usage', errMsg: `unknown command '${cmd}'` };
  }
}

function emit(r: Result, jsonMode: boolean): void {
  const isErr = r.errKind !== undefined || r.errMsg !== undefined;
  if (isErr) {
    if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, kind: r.errKind ?? 'error' }) + '\n');
    else process.stderr.write(`hangar: ${r.errMsg ?? r.errKind}\n`);
    return;
  }
  if (jsonMode && r.json !== undefined) process.stdout.write(JSON.stringify(r.json) + '\n');
  else if (r.text !== undefined) process.stdout.write(r.text);
}

async function main(argv: string[], deps: Deps = defaultDeps): Promise<number> {
  const jsonMode = argv.includes('--json');
  if (argv[0] === 'daemon') {
    const r = startDaemon(deps);
    if (r) {
      emit(r, jsonMode);
      return r.code;
    }
    return await new Promise<number>(() => {}); // never resolves: cron timers keep us alive
  }
  let r: Result;
  try {
    r = await dispatch(argv, deps);
  } catch (e) {
    log.error({ err: String((e as Error)?.message ?? e) }, 'unexpected failure');
    r = { code: 1, errKind: 'internal', errMsg: String((e as Error)?.message ?? e) };
  }
  emit(r, jsonMode);
  return r.code;
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
