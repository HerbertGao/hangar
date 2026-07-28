// Self-check for the resolver. The three things worth pinning: it NEVER throws, it never
// hands back a half-formed target (right user + empty password is worse than no config),
// and no return value or diagnostic string ever carries the password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, resolveWithReason, check, configPath } from './index.js';

const SECRET = 'sup3r-s3cret-pw';

/** A fresh path per call, so the parsed-config cache never leaks between tests. */
function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcfg-'));
  const p = join(dir, 'databases.yaml');
  writeFileSync(p, body);
  return p;
}

const ENTRY = (extra = '', pw = '${PG_PW_TEST}') =>
  `apps:\n  inbox:\n    host: 127.0.0.1\n    database: inbox\n    user: inbox\n    password: "${pw}"\n${extra}`;

/** Run fn with HANGAR_PG_CONFIG + the given vars set, restoring afterwards. */
function withEnv(path: string, vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = { HANGAR_PG_CONFIG: process.env.HANGAR_PG_CONFIG };
  process.env.HANGAR_PG_CONFIG = path;
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('happy path: target from config + env, port defaults to 5432', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    assert.deepEqual(resolve('inbox'), {
      host: '127.0.0.1',
      port: 5432,
      database: 'inbox',
      user: 'inbox',
      password: SECRET,
    });
  });
  rmSync(p, { force: true });
});

test('explicit port is honoured', () => {
  const p = writeConfig(ENTRY('    port: 5433\n'));
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    assert.equal(resolve('inbox')?.port, 5433);
  });
});

test('no entry for the app → undefined, including inherited Object keys', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    // A bare `apps[app]` lookup walks the prototype chain: 'constructor' and friends
    // resolve to truthy functions, sail past the falsy guard, and then throw on the
    // non-null assertion. "No entry → undefined" is stated absolutely, so these count.
    for (const app of ['nosuchapp', 'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.equal(resolve(app), undefined, app);
      assert.equal(resolveWithReason(app).failure?.reason, 'no-entry', app);
    }
  });
});

test('env var missing → undefined, names the var', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: undefined }, () => {
    assert.equal(resolve('inbox'), undefined);
    const f = resolveWithReason('inbox').failure;
    assert.equal(f?.reason, 'env-missing');
    assert.equal(f?.varName, 'PG_PW_TEST');
  });
});

// Whitespace, not `''`, is the case worth pinning: all three collapse onto the same
// `raw.trim().length === 0`, but a "simplification" to `!raw` or `raw === ''` would still
// catch the empty string while letting `'   '` through as a real password.
test('env var whitespace-only → undefined, NOT a target with a blank password', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: '   ' }, () => {
    assert.equal(resolve('inbox'), undefined);
    assert.equal(resolveWithReason('inbox').failure?.reason, 'env-empty');
  });
});

test('plaintext password → schema rejects (fail-closed), never used to connect', () => {
  const p = writeConfig(ENTRY('', SECRET));
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    assert.equal(resolve('inbox'), undefined);
    assert.equal(resolveWithReason('inbox').failure?.reason, 'schema-invalid');
  });
});

test('never throws: yaml syntax error / missing file / unreadable dir', () => {
  const bad = writeConfig('apps:\n  inbox:\n   - [unclosed\n');
  withEnv(bad, {}, () => {
    assert.equal(resolve('inbox'), undefined);
    assert.equal(resolveWithReason('inbox').failure?.reason, 'yaml-syntax');
  });
  withEnv(join(tmpdir(), 'pgcfg-does-not-exist', 'databases.yaml'), {}, () => {
    assert.equal(resolve('inbox'), undefined);
    assert.equal(resolveWithReason('inbox').failure?.reason, 'config-missing');
  });
});

test('empty file → config-missing (same bucket as absent), not a schema error', () => {
  const p = writeConfig('\n   \n');
  withEnv(p, {}, () => {
    assert.equal(resolveWithReason('inbox').failure?.reason, 'config-missing');
  });
});

test('repeated resolve in one process is stable (memoize has no destructive side effect)', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    const a = resolve('inbox');
    const b = resolve('inbox');
    assert.deepEqual(a, b);
    // The resolver MUST NOT consume the variable it read.
    assert.equal(process.env.PG_PW_TEST, SECRET);
  });
});

// The distinction CodeRabbit flagged in the spec, as a test: caching must cover the
// PARSED file, never the interpolated result. Otherwise whichever env resolved first
// decides the answer for every later caller — and `check --from-plist` (a different env,
// same file) becomes meaningless.
test('memoize caches the parsed file, NOT the interpolated result', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: undefined }, () => {
    assert.equal(resolve('inbox'), undefined, 'first call: var absent');
  });
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    assert.equal(resolve('inbox')?.password, SECRET, 'same file, var now present → must resolve');
  });
});

// A launchd daemon runs for days. If a failed read were cached, an operator who writes the
// config (or fixes its mode) after the daemon started would see it keep returning undefined
// forever, with nothing saying a restart is needed.
test('a failed read is NOT cached — the config can appear later in the same process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgcfg-late-'));
  const p = join(dir, 'databases.yaml');
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    assert.equal(resolve('inbox'), undefined, 'file does not exist yet');
    writeFileSync(p, ENTRY());
    assert.equal(resolve('inbox')?.password, SECRET, 'written in-process → must now resolve');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('an app named __proto__ fails the whole file — it must not be silently dropped', () => {
  // z.record() drops such a key: the entry vanishes, `check` reports ok, and that app's
  // password — plaintext or not — was never validated while `resolve` can never find it.
  // Half-loading a config is worse than rejecting it.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const p = writeConfig(`${ENTRY()}  ${key}:\n    host: h\n    database: d\n    user: u\n    password: PLAINTEXT\n`);
    const r = check({ HANGAR_PG_CONFIG: p, PG_PW_TEST: SECRET });
    assert.equal(r.ok, false, key);
    assert.equal(r.loadFailure?.reason, 'schema-invalid', key);
    assert.equal(r.entries.length, 0, `${key}: must not report a partial entry list`);
  }
});

test('a stray key beside `apps:` fails the schema (strict at the top level too)', () => {
  const p = writeConfig(`${ENTRY()}defaults:\n  host: h\n`);
  const r = check({ HANGAR_PG_CONFIG: p, PG_PW_TEST: SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.loadFailure?.reason, 'schema-invalid');
});

test('check() validates against the GIVEN env, not process.env', () => {
  const p = writeConfig(ENTRY());
  // Deliberately put the secret in process.env, and pass an env that lacks it.
  withEnv(p, { PG_PW_TEST: SECRET }, () => {
    const r = check({ HANGAR_PG_CONFIG: p });
    assert.equal(r.ok, false, 'the supplied env has no PG_PW_TEST → must fail');
    assert.equal(r.entries[0]?.varName, 'PG_PW_TEST');
    assert.equal(check({ HANGAR_PG_CONFIG: p, PG_PW_TEST: SECRET }).ok, true);
  });
});

test('check(): a file with an empty apps map fails loudly, not silently ok', () => {
  const p = writeConfig('apps: {}\n');
  const r = check({ HANGAR_PG_CONFIG: p });
  assert.equal(r.ok, false);
  assert.equal(r.loadFailure?.reason, 'no-apps-configured');
});

test('shape: empty host/database/user, out-of-range or non-integer port, unknown key', () => {
  const cases: Record<string, string> = {
    'empty host': 'apps:\n  a:\n    host: "  "\n    database: d\n    user: u\n    password: "${P}"\n',
    'empty database': 'apps:\n  a:\n    host: h\n    database: ""\n    user: u\n    password: "${P}"\n',
    'empty user': 'apps:\n  a:\n    host: h\n    database: d\n    user: ""\n    password: "${P}"\n',
    'port 0': 'apps:\n  a:\n    host: h\n    port: 0\n    database: d\n    user: u\n    password: "${P}"\n',
    'port 70000': 'apps:\n  a:\n    host: h\n    port: 70000\n    database: d\n    user: u\n    password: "${P}"\n',
    'port float': 'apps:\n  a:\n    host: h\n    port: 5432.5\n    database: d\n    user: u\n    password: "${P}"\n',
    'typo key (db not database)': 'apps:\n  a:\n    host: h\n    db: d\n    user: u\n    password: "${P}"\n',
  };
  for (const [label, body] of Object.entries(cases)) {
    const p = writeConfig(body);
    const r = check({ HANGAR_PG_CONFIG: p, P: SECRET });
    assert.equal(r.ok, false, label);
    assert.equal(r.loadFailure?.reason, 'schema-invalid', label);
  }
});

test('the password value never appears in any diagnostic or check report', () => {
  // Two ways a secret could leak: a plaintext password echoed by zod, and a resolved
  // value echoed in a failure. Serialise the whole result and search it.
  const plain = writeConfig(ENTRY('', SECRET));
  const r1 = check({ HANGAR_PG_CONFIG: plain, PG_PW_TEST: SECRET });
  assert.equal(JSON.stringify(r1).includes(SECRET), false, 'plaintext-password report leaked it');

  const ok = writeConfig(ENTRY());
  const r2 = check({ HANGAR_PG_CONFIG: ok }); // var absent → failure path
  assert.equal(JSON.stringify(r2).includes(SECRET), false);

  const wr = writeConfig(ENTRY());
  withEnv(wr, { PG_PW_TEST: SECRET }, () => {
    // resolveWithReason's FAILURE shape must be secret-free; the success shape carries
    // the password by design (it is the point), so only assert on the failure side.
    const f = resolveWithReason('nosuchapp');
    assert.equal(JSON.stringify(f.failure).includes(SECRET), false);
  });
});

test('password is not trimmed — surrounding whitespace can be part of the secret', () => {
  const p = writeConfig(ENTRY());
  withEnv(p, { PG_PW_TEST: '  pw with spaces  ' }, () => {
    assert.equal(resolve('inbox')?.password, '  pw with spaces  ');
  });
});

test('configPath: HANGAR_PG_CONFIG wins, else the convention default', () => {
  assert.equal(configPath({ HANGAR_PG_CONFIG: '/tmp/x.yaml' }), '/tmp/x.yaml');
  assert.match(configPath({}), /\.config[/\\]hangar[/\\]databases\.yaml$/);
  // An empty/whitespace override must not produce a path of "" — fall back instead.
  assert.match(configPath({ HANGAR_PG_CONFIG: '   ' }), /databases\.yaml$/);
});
