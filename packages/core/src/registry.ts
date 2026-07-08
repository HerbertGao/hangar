import { z } from 'zod';
import cron from 'node-cron';
import { parse as parseYaml } from 'yaml';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * App registry — FS is the authority. Scans `apps/*` /app.yaml, zod-validates
 * each spec, requires `id === directory name`, and picks the executor
 * direction. The App table (db.ts) is a non-authoritative cache with no Phase-0
 * reader, so registration = this scan; we don't upsert here.
 *
 * Error kinds are identifiable strings (never bare thrown strings) so doctor and
 * the executor can consume them:
 *   - `spec_invalid`     — bad/absent required fields or unknown executor (load time)
 *   - `app_unresolved`   — dir entry (symlink) that can't be stat'd: dangling/inaccessible
 *   - `pipeline_missing` — executor:pipeline app with neither dist/pipeline.js nor pipeline.ts (checkPipeline)
 * `executor_unsupported` (known-but-unimplemented executor) is a *run-time* gate
 * owned by the run engine, not this scan.
 */

/**
 * Known executor values. v0 implements only `pipeline`; the rest are declared
 * but unimplemented (run-time → executor_unsupported). Any value NOT in this
 * enum is rejected by zod at load time as spec_invalid.
 */
export const EXECUTORS = ['pipeline', 'llm-direct', 'claude-code', 'codex'] as const;
export type ExecutorKind = (typeof EXECUTORS)[number];

// Each schedule string must be a valid cron expression. Rejecting bad/empty cron
// at load time (→ spec_invalid, doctor error, app not registered) keeps an illegal
// cron out of the daemon's cron.schedule loop — that loop has no try/catch, so a bad
// expression would throw synchronously and crash the whole daemon (all apps stop).
const cronString = z
  .string()
  .min(1)
  .refine((s) => cron.validate(s), { message: 'invalid cron expression' });

// A present timezone must be a valid IANA zone. Same rationale as cronString above: the
// daemon's cron.schedule loop has no try/catch, so a bad zone throws synchronously and
// crashes the whole daemon — reject it at load (spec_invalid) instead. Intl.DateTimeFormat
// accepts exactly the zone set node-cron uses.
const ianaTz = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid IANA timezone' },
);

// `type` is a discriminant (v0 only 'cron'); webhook/manual/event are future arms
// (Phase 3, #6-gated — no mechanism built here). `name` is the opaque trigger identity
// routed via ctx.trigger; SpecSchema.superRefine enforces it when triggers.length > 1.
// .strict(): a trigger carries ONLY these 4 fields — a stray per-trigger config/
// permissions/executor is rejected (spec_invalid), not silently stripped (spec: MUST NOT).
const CronTrigger = z
  .object({
    type: z.literal('cron'),
    name: z.string().min(1).optional(),
    schedule: z.union([cronString, z.array(cronString).min(1)]),
    timezone: ianaTz.optional(),
  })
  .strict();

/** AgentAppSpec — the sole app-definition entry (app.yaml). See DESIGN §3.2. */
export const SpecSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    executor: z.enum(EXECUTORS),
    triggers: z.array(CronTrigger),
    tools: z.array(z.string()).default([]),
    permissions: z
      .object({ approval: z.array(z.string()).default([]) })
      .default({ approval: [] }),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  // >1 trigger ENTRIES (not array-schedule fan-out) ⇒ each needs a non-empty name,
  // all names unique — name is the trigger identity for ctx.trigger / Run.trigger /
  // pending dedup; a missing or duplicate name collapses that attribution.
  .superRefine((spec, ctx) => {
    if (spec.triggers.length <= 1) return;
    const names = spec.triggers.map((t) => t.name);
    if (names.some((n) => !n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers'],
        message: 'trigger name required when triggers > 1',
      });
    }
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const n of names) {
      if (!n) continue;
      if (seen.has(n)) dup.add(n);
      else seen.add(n);
    }
    if (dup.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers'],
        message: `duplicate trigger name(s): ${[...dup].join(', ')}`,
      });
    }
  });
export type Spec = z.infer<typeof SpecSchema>;

export interface LoadedApp {
  id: string;
  dir: string; // absolute path to the app directory
  spec: Spec;
}

export interface AppError {
  id: string; // directory name (best-effort id when the spec is unparseable)
  dir: string;
  kind: 'spec_invalid' | 'app_unresolved';
  detail: string;
}

export interface RegistryLoad {
  appsDir: string;
  appsDirMissing: boolean; // for doctor's apps_dir_missing
  apps: LoadedApp[]; // valid, registered
  errors: AppError[]; // spec_invalid, NOT registered
}

/** Default apps dir: cwd-relative like the SQLite path; override with HANGAR_APPS. */
export function resolveAppsDir(): string {
  return process.env.HANGAR_APPS ?? resolve(process.cwd(), 'apps');
}

function loadOne(dir: string, dirName: string, yamlPath: string): LoadedApp | AppError {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, 'utf8'));
  } catch (e) {
    const detail = `yaml: ${e instanceof Error ? e.message : String(e)}`;
    return { id: dirName, dir, kind: 'spec_invalid', detail };
  }
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { id: dirName, dir, kind: 'spec_invalid', detail };
  }
  if (parsed.data.id !== dirName) {
    return {
      id: dirName,
      dir,
      kind: 'spec_invalid',
      detail: `id '${parsed.data.id}' must equal directory name '${dirName}'`,
    };
  }
  return { id: parsed.data.id, dir, spec: parsed.data };
}

/** Scan the apps dir, registering every dir holding a valid app.yaml. */
export function loadApps(appsDir: string = resolveAppsDir()): RegistryLoad {
  const load: RegistryLoad = { appsDir, appsDirMissing: false, apps: [], errors: [] };
  let entries;
  try {
    entries = readdirSync(appsDir, { withFileTypes: true });
  } catch {
    load.appsDirMissing = true;
    return load;
  }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(appsDir, ent.name);
    // Follow symlink→dir (external pilots register via a symlink named <id>);
    // a symlink reports isDirectory()===false. statSync throws ENOENT/EACCES on a
    // dangling/inaccessible link — record app_unresolved and continue so loadApps
    // stays total (doctor's "always returns a report" contract must hold).
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = statSync(dir).isDirectory();
      } catch (e) {
        load.errors.push({
          id: ent.name,
          dir,
          kind: 'app_unresolved',
          detail: `symlink: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
    }
    if (!isDir) continue;
    const yamlPath = join(dir, 'app.yaml');
    if (!existsSync(yamlPath)) continue; // a dir without app.yaml is simply not an app
    const r = loadOne(dir, ent.name, yamlPath);
    if ('spec' in r) load.apps.push(r);
    else load.errors.push(r);
  }
  return load;
}

/**
 * Resolve a pipeline app's entry (DESIGN §3.1): prefer the compiled external-pilot
 * `dist/pipeline.js`, fall back to the flat repo-internal dev `pipeline.ts`. Returns
 * the absolute path, or null if neither exists. Single resolution site — executor,
 * checkPipeline, and doctor all route through here so the .js-preferred rule can't drift.
 */
export function resolvePipelineEntry(appDir: string): string | null {
  const compiled = join(appDir, 'dist', 'pipeline.js');
  if (existsSync(compiled)) return compiled;
  const flat = join(appDir, 'pipeline.ts');
  if (existsSync(flat)) return flat;
  return null;
}

/**
 * pipeline_missing gate for doctor/executor: a pipeline-executor app must resolve
 * an entry (dist/pipeline.js or pipeline.ts). Non-pipeline executors return null
 * here (their gate is the run-time executor_unsupported, not this one).
 */
export function checkPipeline(app: LoadedApp): 'pipeline_missing' | null {
  if (app.spec.executor !== 'pipeline') return null;
  return resolvePipelineEntry(app.dir) !== null ? null : 'pipeline_missing';
}
