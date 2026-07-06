import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApps, checkPipeline, type LoadedApp } from './registry.js';

const VALID = `
id: heartbeat
name: Heartbeat
executor: pipeline
triggers:
  - type: cron
    schedule: "0 9 * * *"
    timezone: "Asia/Shanghai"
`;

/** Build a temp apps/ dir. Map dirName -> app.yaml content (null = no app.yaml). */
function makeApps(specs: Record<string, string | null>): string {
  const appsDir = join(mkdtempSync(join(tmpdir(), 'hangar-reg-')), 'apps');
  mkdirSync(appsDir);
  for (const [name, yaml] of Object.entries(specs)) {
    const dir = join(appsDir, name);
    mkdirSync(dir);
    if (yaml !== null) writeFileSync(join(dir, 'app.yaml'), yaml);
  }
  return appsDir;
}

test('valid app.yaml registers with defaults applied', () => {
  const { apps, errors } = loadApps(makeApps({ heartbeat: VALID }));
  assert.equal(errors.length, 0);
  assert.equal(apps.length, 1);
  const app = apps[0];
  assert.equal(app.id, 'heartbeat');
  assert.equal(app.spec.executor, 'pipeline');
  assert.deepEqual(app.spec.tools, []); // default
  assert.deepEqual(app.spec.permissions.approval, []); // default
  assert.deepEqual(app.spec.config, {}); // default
});

test('missing executor → spec_invalid, not registered', () => {
  const { apps, errors } = loadApps(
    makeApps({ heartbeat: `id: heartbeat\nname: HB\ntriggers: []\n` }),
  );
  assert.equal(apps.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'spec_invalid');
});

test('unknown executor value (banana) → spec_invalid at load', () => {
  const { apps, errors } = loadApps(
    makeApps({
      heartbeat: `id: heartbeat\nname: HB\nexecutor: banana\ntriggers: []\n`,
    }),
  );
  assert.equal(apps.length, 0);
  assert.equal(errors[0].kind, 'spec_invalid');
});

test('id != directory name → spec_invalid', () => {
  const { apps, errors } = loadApps(
    makeApps({ heartbeat: VALID.replace('id: heartbeat', 'id: mismatch') }),
  );
  assert.equal(apps.length, 0);
  assert.equal(errors[0].kind, 'spec_invalid');
  assert.match(errors[0].detail, /directory name/);
});

test('one bad app does not block a sibling valid app', () => {
  const { apps, errors } = loadApps(
    makeApps({
      heartbeat: VALID,
      broken: `id: broken\nname: X\nexecutor: banana\ntriggers: []\n`,
    }),
  );
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'heartbeat');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'broken');
});

test('missing apps dir → appsDirMissing, no apps', () => {
  const load = loadApps(join(tmpdir(), 'hangar-nope-' + Date.now()));
  assert.equal(load.appsDirMissing, true);
  assert.equal(load.apps.length, 0);
});

test('dir without app.yaml is ignored (e.g. .gitkeep only)', () => {
  const { apps, errors } = loadApps(makeApps({ notanapp: null }));
  assert.equal(apps.length, 0);
  assert.equal(errors.length, 0);
});

test('executor direction: pipeline needs pipeline.ts; others deferred', () => {
  const dir = makeApps({ heartbeat: VALID });
  const [app] = loadApps(dir).apps;
  // pipeline app without pipeline.ts → pipeline_missing
  assert.equal(checkPipeline(app), 'pipeline_missing');
  // add pipeline.ts → gate clears
  writeFileSync(join(app.dir, 'pipeline.ts'), 'export function run() {}\n');
  assert.equal(checkPipeline(app), null);

  // non-pipeline executor: no pipeline_missing gate here (run-time gate instead)
  const nonPipeline: LoadedApp = { ...app, spec: { ...app.spec, executor: 'codex' } };
  assert.equal(checkPipeline(nonPipeline), null);
});
