// hangar-notify — a CONFIG RESOLVER for notification destinations, NOT a transport.
// It reads channels.yaml, interpolates ${ENV} into a bot token, validates shape,
// and hands the caller the raw destination. It contains ZERO HTTP/fetch/apprise
// code and imports no logger (see design.md D2/D5). How to deliver is the pilot's job.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

/** Closed lane set (design D1 / spec). */
export type Lane = 'private' | 'broadcast';

/** The raw materials for a destination; the caller's own transport uses these. */
export interface Destination {
  botToken: string;
  chatId: string;
}

/**
 * Why a resolve produced no destination. NEVER contains a secret value —
 * only a stable machine `reason` and, when relevant, the env var NAME.
 * `severity`: 'error' = present-but-invalid (caller SHOULD log ERROR);
 *             'info'  = absent / not-configured (caller degrades silently, design D5).
 */
export interface ResolveFailure {
  reason: string;
  varName?: string;
  severity: 'info' | 'error';
}

export type ResolveResult =
  | { destination: Destination; failure?: undefined }
  | { destination: undefined; failure: ResolveFailure };

// `bot` MUST be a bare ${ENV_NAME} placeholder — fail-closed against committed plaintext.
const BOT_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;
// Token shape MUST NOT be wider than inbox's redactError.ts:24, or a token this
// resolver accepts would slip past that log-redaction (design D10).
const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const laneEntrySchema = z.object({
  bot: z
    .string()
    .regex(BOT_PLACEHOLDER, 'bot must be a ${ENV_NAME} placeholder, not a plaintext token'),
  chat: z.string().refine((s) => s.trim().length > 0, 'chat must be non-empty'),
});

// strictObject: a mis-nested app entry (e.g. bot/chat placed directly under the app,
// forgetting the lane) becomes a loud schema error at deploy time, not a silent skip.
const appEntrySchema = z.strictObject({
  private: laneEntrySchema.optional(),
  broadcast: laneEntrySchema.optional(),
});

const channelsSchema = z.object({
  apps: z.record(z.string(), appEntrySchema),
});

type ChannelsConfig = z.infer<typeof channelsSchema>;

type LoadState =
  | { kind: 'ok'; config: ChannelsConfig }
  | { kind: 'fail'; reason: string; severity: 'info' | 'error' };

// ponytail: memoized by resolved path. In production HANGAR_NOTIFY_CONFIG is fixed →
// exactly one entry → "read once and cache" (design D8). Keying by path also lets
// tests point at different temp files without a reset backdoor shipping in prod.
const loadCache = new Map<string, LoadState>();

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** channels.yaml path from the given env, with the convention default (design D7). */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  const p = env.HANGAR_NOTIFY_CONFIG?.trim();
  if (p) return expandTilde(p);
  return join(homedir(), '.config', 'hangar', 'channels.yaml');
}

// Read + parse + validate. NEVER throws — every IO/parse/validate failure maps to a
// fail state. A throw here would be permanently cached by the ESM loader in a caller
// that constructs its channel at module-eval under await import() (design D5).
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
    doc = YAML.parse(text);
  } catch {
    return { kind: 'fail', reason: 'yaml-syntax', severity: 'error' };
  }
  // Empty/whitespace-only file → YAML.parse yields null: "no config present",
  // same bucket as a missing file (info/silent), not a schema error.
  if (doc == null) return { kind: 'fail', reason: 'config-missing', severity: 'info' };
  const parsed = channelsSchema.safeParse(doc);
  // Return a fixed reason code only — zod's message can echo the offending value
  // (e.g. a committed plaintext token); never surface it (spec: 密钥不入日志/诊断).
  if (!parsed.success) return { kind: 'fail', reason: 'schema-invalid', severity: 'error' };
  return { kind: 'ok', config: parsed.data };
}

function loadConfig(path: string): LoadState {
  const hit = loadCache.get(path);
  if (hit) return hit;
  const state = readParseValidate(path);
  loadCache.set(path, state);
  return state;
}

function fail(reason: string, severity: 'info' | 'error', varName?: string): ResolveResult {
  return { destination: undefined, failure: { reason, severity, varName } };
}

function resolveIn(
  app: string,
  lane: Lane,
  env: Record<string, string | undefined>,
): ResolveResult {
  const state = loadConfig(configPath(env));
  if (state.kind === 'fail') return fail(state.reason, state.severity);

  const laneCfg = state.config.apps[app]?.[lane];
  if (!laneCfg) return fail('no-entry', 'info'); // this app doesn't speak on this lane

  // schema guarantees the placeholder matched; re-extract the env var name.
  const varName = BOT_PLACEHOLDER.exec(laneCfg.bot)![1];
  const raw = env[varName];
  // Empty string counts as SET in JS — treat whitespace-only as missing (spec).
  if (raw === undefined || raw.trim().length === 0) {
    return fail(raw === undefined ? 'env-missing' : 'env-empty', 'info', varName);
  }
  const botToken = raw.trim();
  if (!TOKEN_SHAPE.test(botToken)) {
    return fail('token-shape-invalid', 'error', varName); // present-but-invalid → ERROR
  }
  return { destination: { botToken, chatId: laneCfg.chat } };
}

/** Hot path: the destination, or undefined on ANY problem (never throws). */
export function resolve(app: string, lane: Lane): Destination | undefined {
  return resolveIn(app, lane, process.env).destination;
}

/** Same, but surfaces { reason, varName } so the caller can log ERROR (design D5). */
export function resolveWithReason(app: string, lane: Lane): ResolveResult {
  return resolveIn(app, lane, process.env);
}

/** Bind an app id so the pilot passes it once; core stays untouched (design D9). */
export function createResolver(app: string) {
  return {
    resolve: (lane: Lane): Destination | undefined => resolve(app, lane),
    resolveWithReason: (lane: Lane): ResolveResult => resolveWithReason(app, lane),
  };
}

export interface CheckEntryResult {
  app: string;
  lane: Lane;
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
 * Offline preflight over the given env (design D6). Interpolates and validates every
 * (app, lane) against THIS env — not necessarily process.env — so `--from-plist` can
 * check the daemon's env, not the operator's shell. Shape + presence only; does NOT
 * verify a token is live.
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
  for (const [app, appCfg] of Object.entries(state.config.apps)) {
    for (const lane of Object.keys(appCfg) as Lane[]) {
      const r = resolveIn(app, lane, env);
      const entryOk = r.destination !== undefined;
      if (!entryOk) ok = false;
      entries.push({ app, lane, ok: entryOk, reason: r.failure?.reason, varName: r.failure?.varName });
    }
  }
  return { configPath: path, entries, ok };
}
