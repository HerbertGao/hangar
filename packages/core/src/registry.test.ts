import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApps, checkPipeline, resolvePipelineEntry, type LoadedApp } from './registry.js';

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

test('resolvePipelineEntry: dist/pipeline.js preferred over a sibling pipeline.ts', () => {
  const appsDir = makeApps({ inbox: VALID.replace('id: heartbeat', 'id: inbox') });
  const dir = join(appsDir, 'inbox');
  writeFileSync(join(dir, 'pipeline.ts'), 'export function run() {}\n');
  mkdirSync(join(dir, 'dist'));
  const js = join(dir, 'dist', 'pipeline.js');
  writeFileSync(js, 'export function run() {}\n');
  assert.equal(resolvePipelineEntry(dir), js);
  assert.equal(checkPipeline(loadApps(appsDir).apps[0]), null);
});

test('resolvePipelineEntry: flat pipeline.ts (no dist/) still resolves; none → null', () => {
  const appsDir = makeApps({ heartbeat: VALID });
  const dir = join(appsDir, 'heartbeat');
  assert.equal(resolvePipelineEntry(dir), null);
  const ts = join(dir, 'pipeline.ts');
  writeFileSync(ts, 'export function run() {}\n');
  assert.equal(resolvePipelineEntry(dir), ts);
});

// ── multi-trigger schema (2.1) ───────────────────────────────────────────────
const multi = (triggers: string): string =>
  `id: multi\nname: Multi\nexecutor: pipeline\ntriggers:\n${triggers}`;

test('multi-trigger: a >1-trigger app with a name-less trigger → spec_invalid', () => {
  const yaml = multi(
    `  - type: cron\n    name: poll\n    schedule: "*/3 * * * *"\n  - type: cron\n    schedule: "0 6 * * *"\n`,
  );
  const { apps, errors } = loadApps(makeApps({ multi: yaml }));
  assert.equal(apps.length, 0);
  assert.equal(errors[0].kind, 'spec_invalid');
  assert.match(errors[0].detail, /name required/);
});

test('multi-trigger: duplicate trigger names → spec_invalid', () => {
  const yaml = multi(
    `  - type: cron\n    name: dup\n    schedule: "*/3 * * * *"\n  - type: cron\n    name: dup\n    schedule: "0 6 * * *"\n`,
  );
  const { apps, errors } = loadApps(makeApps({ multi: yaml }));
  assert.equal(apps.length, 0);
  assert.equal(errors[0].kind, 'spec_invalid');
  assert.match(errors[0].detail, /duplicate trigger name/);
});

test('single trigger may omit name; named multi-trigger with array schedule loads', () => {
  // ③ single unnamed trigger (heartbeat) is valid, name stays undefined
  const single = loadApps(makeApps({ heartbeat: VALID }));
  assert.equal(single.errors.length, 0);
  assert.equal(single.apps[0].spec.triggers[0].name, undefined);
  // ④ two named triggers, one with an array schedule → valid, array preserved
  const yaml = multi(
    `  - type: cron\n    name: poll\n    schedule: "*/3 * * * *"\n  - type: cron\n    name: digest\n    schedule: ["0 6 * * *", "30 12 * * *", "0 19 * * *"]\n`,
  );
  const { apps, errors } = loadApps(makeApps({ multi: yaml }));
  assert.equal(errors.length, 0);
  assert.equal(apps.length, 1);
  assert.deepEqual(apps[0].spec.triggers[1].schedule, ['0 6 * * *', '30 12 * * *', '0 19 * * *']);
});

test('invalid cron (bad expression / empty string) → spec_invalid, not registered', () => {
  const bad = loadApps(
    makeApps({
      bad: `id: bad\nname: Bad\nexecutor: pipeline\ntriggers:\n  - type: cron\n    schedule: "30 12 * *"\n`,
    }),
  );
  assert.equal(bad.apps.length, 0);
  assert.equal(bad.errors[0].kind, 'spec_invalid');
  const empty = loadApps(
    makeApps({
      empty: `id: empty\nname: Empty\nexecutor: pipeline\ntriggers:\n  - type: cron\n    schedule: ""\n`,
    }),
  );
  assert.equal(empty.apps.length, 0);
  assert.equal(empty.errors[0].kind, 'spec_invalid');
});

test('invalid IANA timezone → spec_invalid (else it crashes the daemon cron loop, like a bad cron)', () => {
  const bad = loadApps(
    makeApps({
      badtz: `id: badtz\nname: BadTz\nexecutor: pipeline\ntriggers:\n  - type: cron\n    schedule: "*/3 * * * *"\n    timezone: "Not/AZone"\n`,
    }),
  );
  assert.equal(bad.apps.length, 0);
  assert.equal(bad.errors[0].kind, 'spec_invalid');
  // a valid IANA zone still registers
  const ok = loadApps(
    makeApps({
      oktz: `id: oktz\nname: OkTz\nexecutor: pipeline\ntriggers:\n  - type: cron\n    schedule: "*/3 * * * *"\n    timezone: "Asia/Shanghai"\n`,
    }),
  );
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.apps.length, 1);
});

test('strict trigger: a stray per-trigger config key → spec_invalid (spec: triggers MUST NOT carry config/permissions/executor)', () => {
  const stray = loadApps(
    makeApps({
      stray: `id: stray\nname: Stray\nexecutor: pipeline\ntriggers:\n  - type: cron\n    schedule: "*/3 * * * *"\n    config: { foo: bar }\n`,
    }),
  );
  assert.equal(stray.apps.length, 0);
  assert.equal(stray.errors[0].kind, 'spec_invalid');
});

test('loadApps follows a symlinked pilot dir (external checkout registered by symlink)', () => {
  // real pilot checkout lives outside apps/; register it via a symlink named <id>
  const pilot = join(mkdtempSync(join(tmpdir(), 'hangar-ext-')), 'inbox-pilot');
  mkdirSync(pilot);
  writeFileSync(join(pilot, 'app.yaml'), VALID.replace('id: heartbeat', 'id: inbox'));
  const appsDir = join(mkdtempSync(join(tmpdir(), 'hangar-reg-')), 'apps');
  mkdirSync(appsDir);
  symlinkSync(pilot, join(appsDir, 'inbox'));
  const { apps, errors } = loadApps(appsDir);
  assert.equal(errors.length, 0);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'inbox');
});

test('a dangling symlink → app_unresolved recorded, loadApps does not throw, siblings still enumerated', () => {
  const appsDir = join(mkdtempSync(join(tmpdir(), 'hangar-reg-')), 'apps');
  mkdirSync(appsDir);
  // healthy sibling
  const hb = join(appsDir, 'heartbeat');
  mkdirSync(hb);
  writeFileSync(join(hb, 'app.yaml'), VALID);
  // dangling symlink named like a pilot → target does not exist (statSync throws)
  symlinkSync(join(appsDir, 'no-such-target'), join(appsDir, 'inbox'));
  const { apps, errors } = loadApps(appsDir); // must NOT throw
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'heartbeat');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, 'inbox');
  assert.equal(errors[0].kind, 'app_unresolved');
});
