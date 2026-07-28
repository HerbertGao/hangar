// The boundary this package exists to hold, as a runnable check rather than a promise in
// a proposal. If any of these fail, "hangar manages databases" has become true and the
// change has drifted past what was argued for (invariant #1 + the multi-tenancy non-goal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

const HERE = import.meta.dirname;
const PKG_ROOT = resolvePath(HERE, '..');
const REPO_ROOT = resolvePath(HERE, '../../..');

// `skipTests` exists for THIS package only: these very files carry the banned patterns as
// literals, so scanning them would trip the guard on its own fixtures. Core has no such
// excuse — excluding its tests would leave a third of its source unscanned, and an import
// of the driver from a core test file is still an invariant breach.
function sourceFiles(dir: string, skipTests: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p, skipTests);
    // Every extension the toolchain would actually compile — a guard that only knows
    // `.ts`/`.js` is bypassed by renaming the offending file to `.mts`.
    if (!e.isFile() || !/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(e.name)) return [];
    return skipTests && /\.test\.[a-z]+$/.test(e.name) ? [] : [p];
  });
}

function readAll(dir: string, skipTests: boolean): { file: string; text: string }[] {
  const files = sourceFiles(dir, skipTests);
  // A scan that matched nothing would make every assertion built on it vacuously true.
  assert.ok(files.length > 0, `no source files found under ${dir} — the scan is vacuous`);
  return files.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }));
}

test('runtime deps are exactly yaml + zod — no driver, no ORM, in ANY dep section', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['yaml', 'zod']);
  // `optionalDependencies` and `peerDependencies` are installed/resolved too, so checking
  // only `dependencies` + `devDependencies` leaves a section a driver could hide in.
  for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const names = Object.keys(pkg[section] ?? {});
    assert.equal(
      names.some((d) => /(^|\/)(pg|postgres)($|[-.])/.test(d)),
      false,
      `${section} must not contain a postgres driver: ${names.join(', ')}`,
    );
  }
});

test('source imports no driver, no @hangar/core, no logger, no socket, no sqlite', () => {
  // Each pattern is anchored at an import/require site so a word like "postgres" inside a
  // comment (explaining the boundary) does not trip it — the ban is on code, not prose.
  const banned: [RegExp, string][] = [
    [/from\s+['"]pg(-[a-z]+)?['"]|require\(['"]pg(-[a-z]+)?['"]\)/, "a postgres driver"],
    [/from\s+['"]postgres['"]|require\(['"]postgres['"]\)/, 'the `postgres` client'],
    [/from\s+['"]@hangar\/core['"]|require\(['"]@hangar\/core['"]\)/, '@hangar/core'],
    [/from\s+['"]pino['"]|require\(['"]pino['"]\)/, 'a logger'],
    [/from\s+['"]node:(net|tls|http|https|dgram)['"]/, 'a socket/HTTP module'],
    [/from\s+['"]better-sqlite3['"]|require\(['"]better-sqlite3['"]\)/, 'better-sqlite3'],
    [/from\s+['"]node:sqlite['"]|require\(['"]node:sqlite['"]\)/, "node's built-in sqlite"],
    // Dynamic and side-effect imports evade the `from '…'` shape entirely.
    [/import\s*\(\s*['"](pg|postgres|@hangar\/core|better-sqlite3|node:sqlite)/, 'a dynamic import of a banned module'],
    [/^\s*import\s+['"](pg|postgres|better-sqlite3)['"]/m, 'a side-effect import of a banned module'],
    [/\bfetch\s*\(/, 'fetch()'],
    // The realistic drift path is not an import — it is shelling out. This package already
    // spawns (plutil), so `execFileSync('psql', ['-f', 'deploy/roles.sql'])` would pass
    // every other guard here and quietly turn "hangar creates the roles for you" into truth.
    [/\b(psql|pg_dump|pg_restore|createdb|createuser|dropdb)\b/, 'a postgres CLI'],
  ];
  for (const { file, text } of readAll(join(PKG_ROOT, 'src'), true)) {
    for (const [re, what] of banned) {
      assert.equal(re.test(text), false, `${file} must not import/use ${what}`);
    }
  }
});

test('@hangar/core stays free of postgres concepts (invariant #1 regression guard)', () => {
  // Deliberately NOT a bare /pg/ search: that matches "pgconfig" and any word containing
  // those two letters, so it would either be permanently red or trained to be ignored.
  // The anchored *specifier* form is precise and is the most direct breach of the very
  // invariant this test exists for — core importing the driver itself. A word-only ban
  // would have let `import { Client } from 'pg'` through untouched.
  const banned = [
    /postgres/i,
    /databases\.yaml/,
    /@hangar\/pgconfig/,
    /\bpgconfig\b/,
    /from\s+['"]pg(-[a-z]+)?['"]|require\(['"]pg(-[a-z]+)?['"]\)/,
  ];
  const coreSrc = join(REPO_ROOT, 'packages/core/src');
  assert.ok(statSync(coreSrc).isDirectory(), 'core src must exist for this guard to mean anything');
  for (const { file, text } of readAll(coreSrc, false)) {
    for (const re of banned) {
      assert.equal(re.test(text), false, `${file} must not mention ${re} — pg is a pilot's domain store`);
    }
  }
});

// Scope is the shipped source only. `deploy/roles.sql` in this same package is nothing but
// DDL — deliberately: it is a template the operator runs, not something this code executes.
test('shipped source contains no DDL', () => {
  const ddl = /\b(CREATE|ALTER|DROP)\s+(TABLE|ROLE|DATABASE|USER|SCHEMA)\b/i;
  for (const { file, text } of readAll(join(PKG_ROOT, 'src'), true)) {
    assert.equal(ddl.test(text), false, `${file} must not contain DDL — roles/databases are the deployment's job`);
  }
});
