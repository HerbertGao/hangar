import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 *   - `pipeline_missing` — executor:pipeline app without pipeline.ts (checkPipeline)
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

const CronTrigger = z.object({
  type: z.literal('cron'),
  schedule: z.string().min(1),
  timezone: z.string().optional(),
});

/** AgentAppSpec — the sole app-definition entry (app.yaml). See DESIGN §3.2. */
export const SpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  executor: z.enum(EXECUTORS),
  triggers: z.array(CronTrigger),
  tools: z.array(z.string()).default([]),
  permissions: z
    .object({ approval: z.array(z.string()).default([]) })
    .default({ approval: [] }),
  config: z.record(z.string(), z.unknown()).default({}),
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
  kind: 'spec_invalid';
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
    if (!ent.isDirectory()) continue;
    const dir = join(appsDir, ent.name);
    const yamlPath = join(dir, 'app.yaml');
    if (!existsSync(yamlPath)) continue; // a dir without app.yaml is simply not an app
    const r = loadOne(dir, ent.name, yamlPath);
    if ('spec' in r) load.apps.push(r);
    else load.errors.push(r);
  }
  return load;
}

/**
 * pipeline_missing gate for doctor/executor: a pipeline-executor app must have
 * pipeline.ts. Non-pipeline executors return null here (their gate is the
 * run-time executor_unsupported, not this one).
 */
export function checkPipeline(app: LoadedApp): 'pipeline_missing' | null {
  if (app.spec.executor !== 'pipeline') return null;
  // ponytail: convention is `pipeline.ts` (run-time tsx/dynamic import); probe .js only if apps ship precompiled.
  return existsSync(join(app.dir, 'pipeline.ts')) ? null : 'pipeline_missing';
}
