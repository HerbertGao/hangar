// @hangar/pgconfig — a CONFIG RESOLVER for postgres connection targets, NOT a client.
// It hands back the raw materials; connecting, pooling and migrating are the pilot's job.
// The moment this package can connect or create roles, "hangar manages databases" becomes
// true — which collides with invariant #1 and the multi-tenancy non-goal. The boundary is
// enforced, not promised: see `invariants.test.ts` for what is banned and why it stays.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

/** The raw materials for a connection; the caller's own driver uses these. */
export interface PgTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Why a resolve produced no target. NEVER contains the password value — only a stable
 * machine `reason` and, when relevant, the env var NAME.
 * `severity`: 'error' = present-but-invalid (caller SHOULD log ERROR);
 *             'info'  = absent / not-configured (caller decides: degrade or fail loud).
 */
export interface ResolveFailure {
  reason: string;
  varName?: string;
  severity: 'info' | 'error';
}

export type ResolveResult =
  | { target: PgTarget; failure?: undefined }
  | { target: undefined; failure: ResolveFailure };

// `password` MUST be a bare ${ENV_NAME} placeholder — fail-closed against a plaintext
// password committed to git. Not a warning: a schema failure.
const PW_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

const nonEmpty = (label: string) =>
  z.string().refine((s) => s.trim().length > 0, `${label} must be non-empty`);

// strictObject: a typo'd or mis-nested key (e.g. `db:` instead of `database:`) becomes a
// loud schema error at deploy time rather than a silently missing field.
const appEntrySchema = z.strictObject({
  host: nonEmpty('host'),
  // Integer in the real TCP range. A float or 70000 would otherwise reach the driver and
  // fail there with a much worse message, on the pilot's hot path instead of preflight.
  port: z.int().min(1).max(65535).default(5432),
  database: nonEmpty('database'),
  user: nonEmpty('user'),
  password: z
    .string()
    .regex(PW_PLACEHOLDER, 'password must be a ${ENV_NAME} placeholder, not a plaintext password'),
});

// strict at the top level too: a stray sibling key next to `apps:` is a mistake worth
// failing on, not something to silently ignore.
const databasesSchema = z.strictObject({
  apps: z.record(z.string(), appEntrySchema),
});

type DatabasesConfig = z.infer<typeof databasesSchema>;

type LoadState =
  | { kind: 'ok'; config: DatabasesConfig }
  | { kind: 'fail'; reason: string; severity: 'info' | 'error' };

// Memoizes the PARSED file state keyed by path — never an interpolated result. That
// distinction is load-bearing: `check(env)` must interpolate against a supplied env
// (a launchd plist's), while `resolve()` uses process.env. Caching post-interpolation
// values or failures would let whichever env ran first decide the answer for the other.
const loadCache = new Map<string, LoadState>();

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** databases.yaml path from the given env, with the convention default. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  // `env` is exported API and callers may hand us a parsed plist, where a value can be a
  // number or a dict. `?.trim()` would throw on those; a non-string is simply "not set".
  const raw: unknown = env.HANGAR_PG_CONFIG;
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (p) return expandTilde(p);
  return join(homedir(), '.config', 'hangar', 'databases.yaml');
}

// Read + parse + validate. NEVER throws — every IO/parse/validate failure maps to a fail
// state, so a caller that resolves at module-eval can't get a permanently-cached throw.
function readParseValidate(path: string): LoadState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { kind: 'fail', reason: 'config-missing', severity: 'info' };
    return { kind: 'fail', reason: 'config-unreadable', severity: 'error' };
  }
  let doc: unknown;
  try {
    // logLevel:'error' is a SECRET-CONTAINMENT setting, not a tidiness one. At the default
    // level `yaml` reports recoverable problems through process.emitWarning, and the
    // warning text quotes the offending source line — so a malformed `password:` line
    // prints the plaintext to stderr even though this function returns a fixed reason code.
    // Under launchd that lands in the daemon's log file. Syntax errors still throw.
    doc = YAML.parse(text, { logLevel: 'error' });
  } catch {
    return { kind: 'fail', reason: 'yaml-syntax', severity: 'error' };
  }
  // Empty/whitespace-only file → YAML.parse yields null: "no config present", same
  // bucket as a missing file, not a schema error.
  if (doc == null) return { kind: 'fail', reason: 'config-missing', severity: 'info' };
  // An app named `__proto__` (or `constructor`/`prototype`) is silently DROPPED by
  // `z.record()` — the entry vanishes, so `check` reports ok while that app's password,
  // plaintext or not, was never validated and `resolve` can never find it. Reject the
  // whole file instead: a config that cannot be represented must not half-load.
  const appsRaw: unknown = (doc as { apps?: unknown }).apps;
  if (appsRaw !== null && typeof appsRaw === 'object') {
    for (const k of Object.getOwnPropertyNames(appsRaw)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return { kind: 'fail', reason: 'schema-invalid', severity: 'error' };
      }
    }
  }
  const parsed = databasesSchema.safeParse(doc);
  // Fixed reason code only — zod's message can echo the offending value (e.g. a
  // committed plaintext password); never surface it.
  if (!parsed.success) return { kind: 'fail', reason: 'schema-invalid', severity: 'error' };
  return { kind: 'ok', config: parsed.data };
}

function loadConfig(path: string): LoadState {
  const hit = loadCache.get(path);
  if (hit) return hit;
  const state = readParseValidate(path);
  // Only successes are cached. Caching failures makes them terminal for the process
  // lifetime: a daemon that starts before the operator writes databases.yaml (or with the
  // file mode wrong) would keep returning undefined forever, and nothing tells the
  // operator a restart is required. One extra failed open() per resolve on the sad path
  // is free; "read once" is about the happy path, which is what memoizing is for.
  if (state.kind === 'ok') loadCache.set(path, state);
  return state;
}

function fail(reason: string, severity: 'info' | 'error', varName?: string): ResolveResult {
  return { target: undefined, failure: { reason, severity, varName } };
}

function resolveIn(app: string, env: Record<string, string | undefined>): ResolveResult {
  const state = loadConfig(configPath(env));
  if (state.kind === 'fail') return fail(state.reason, state.severity);

  // Object.hasOwn, not a bare index: `apps['constructor']` (or __proto__/toString/…)
  // walks the prototype chain and yields a function, which is truthy — the `!cfg` guard
  // then passes and the non-null assertion below dereferences null. "No entry" is stated
  // absolutely in the spec, so every key that isn't an own key is a no-entry.
  const cfg = Object.hasOwn(state.config.apps, app) ? state.config.apps[app] : undefined;
  if (!cfg) return fail('no-entry', 'info'); // this app has no database here

  // schema guarantees the placeholder matched; re-extract the env var name.
  const varName = PW_PLACEHOLDER.exec(cfg.password)![1];
  const raw: unknown = env[varName];
  if (raw !== undefined && typeof raw !== 'string') return fail('env-missing', 'info', varName);
  // Empty string counts as SET in JS. A whitespace-only value would otherwise produce a
  // target with the right user and an empty password — harder to diagnose than no config.
  if (raw === undefined || raw.trim().length === 0) {
    return fail(raw === undefined ? 'env-missing' : 'env-empty', 'info', varName);
  }
  return {
    target: {
      host: cfg.host.trim(),
      port: cfg.port,
      database: cfg.database.trim(),
      user: cfg.user.trim(),
      // NOT trimmed: a password's leading/trailing whitespace is part of the secret.
      password: raw,
    },
  };
}

/** Hot path: the connection target, or undefined on ANY problem (never throws). */
export function resolve(app: string): PgTarget | undefined {
  return resolveIn(app, process.env).target;
}

/** Same, but surfaces { reason, varName } so the caller can log ERROR if it wants. */
export function resolveWithReason(app: string): ResolveResult {
  return resolveIn(app, process.env);
}

export interface CheckEntryResult {
  app: string;
  ok: boolean;
  reason?: string;
  varName?: string;
}

export interface CheckResult {
  configPath: string;
  loadFailure?: ResolveFailure;
  entries: CheckEntryResult[];
  ok: boolean;
}

/**
 * Offline preflight over the GIVEN env. Interpolates and validates every app against
 * THIS env — not necessarily process.env — so `--from-plist` checks the daemon's env
 * rather than the operator's shell. Shape + presence only: it does NOT connect, so it
 * proves nothing about reachability or whether the credentials are accepted.
 */
export function check(env: Record<string, string | undefined> = process.env): CheckResult {
  const path = configPath(env);
  const state = loadConfig(path);
  if (state.kind === 'fail') {
    return {
      configPath: path,
      loadFailure: { reason: state.reason, severity: state.severity },
      entries: [],
      ok: false,
    };
  }
  const entries: CheckEntryResult[] = [];
  let ok = true;
  for (const app of Object.keys(state.config.apps)) {
    const r = resolveIn(app, env);
    const entryOk = r.target !== undefined;
    if (!entryOk) ok = false;
    entries.push({ app, ok: entryOk, reason: r.failure?.reason, varName: r.failure?.varName });
  }
  // An empty `apps:` map is not "fine" — it means the file exists but configures nothing,
  // which at deploy time is indistinguishable from a truncated/wrong file.
  if (entries.length === 0) {
    return {
      configPath: path,
      loadFailure: { reason: 'no-apps-configured', severity: 'error' },
      entries: [],
      ok: false,
    };
  }
  return { configPath: path, entries, ok };
}
