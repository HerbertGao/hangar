// The CLI is the deliverable for an entire spec requirement and the step the production
// runbook makes mandatory — but nothing here executed it until this file existed, so a
// password print, a merged env, a deleted presence check and two broken exit codes all
// passed the suite. Each test below pins one of those.
//
// `--from-plist` shells out to `plutil`, which is macOS-only. Rather than skip those cases
// on Linux (leaving the false-green mutations unguarded exactly where CI runs), we put a
// fake `plutil` on PATH: the real code path — spawn, parse, filter, env-select — still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

const CLI = resolvePath(import.meta.dirname, 'cli.ts');
const SECRET = 'sup3r-s3cret-pw';
const CONFIG = `apps:\n  inbox:\n    host: 127.0.0.1\n    database: inbox\n    user: inbox\n    password: "\${PG_PW_INBOX}"\n`;

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcli-'));
  writeFileSync(join(dir, 'databases.yaml'), CONFIG);
  return dir;
}

/** A `plutil` stand-in that prints `json` regardless of arguments. */
function fakePlutil(dir: string, json: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'plist.json'), json);
  writeFileSync(join(bin, 'plutil'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'plist.json'))}\n`);
  chmodSync(join(bin, 'plutil'), 0o755);
  return bin;
}

function run(args: string[], env: Record<string, string | undefined> = {}, pathPrefix?: string) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH}` } : {}),
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('no args / unknown subcommand → usage on stderr, exit 2, nothing on stdout', () => {
  for (const args of [[], ['bogus'], ['--json']]) {
    const r = run(args);
    assert.equal(r.code, 2, `args=${JSON.stringify(args)}`);
    assert.match(r.err, /Usage:/);
    assert.equal(r.out, '');
  }
});

test('--from-plist without a path → exit 2 (usage), not a crash', () => {
  const r = run(['check', '--from-plist']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--from-plist requires a <path>/);
});

test('an unrecognised argument is rejected, never ignored', () => {
  const d = sandbox();
  const cfg = { HANGAR_PG_CONFIG: join(d, 'databases.yaml'), PG_PW_INBOX: SECRET };
  // `--from-plsit` is the dangerous one: ignoring it silently downgrades the check to the
  // operator's shell — green, while the daemon's env was never looked at. That is exactly
  // the false-green --from-plist exists to prevent, reachable by one transposed letter.
  for (const args of [
    ['check', '--from-plsit', '/x.plist'],
    ['check', '--bogus'],
    ['check', '--json', 'extra'],
  ]) {
    const r = run(args, cfg);
    assert.equal(r.code, 2, `args=${JSON.stringify(args)} must not silently succeed`);
    assert.match(r.err, /unknown argument/);
  }
  // The valid forms must still work — a strict parser that rejects everything is no better.
  assert.equal(run(['check'], cfg).code, 0);
  assert.equal(run(['check', '--json'], cfg).code, 0);
  rmSync(d, { recursive: true, force: true });
});

test('a malformed value never reaches stderr via a YAML warning', () => {
  // The library reports recoverable problems through process.emitWarning, quoting the
  // offending source line. Two reasons this needs its own harness:
  //   · the return value stays a fixed reason code, so inspecting return values (or
  //     serialising `check()`) cannot see the leak at all;
  //   · the warning is emitted ASYNCHRONOUSLY, so the CLI — which ends in
  //     `process.exit(main(...))` — can exit before it flushes. Driving this through the
  //     CLI would produce a test that passes even with the fix removed.
  // So: spawn a script that uses the library and returns naturally, like a pilot does.
  const d = mkdtempSync(join(tmpdir(), 'pgcli-warn-'));
  const cfg = join(d, 'databases.yaml');
  writeFileSync(
    cfg,
    `apps:\n  inbox:\n    host: h\n    database: d\n    user: u\n    password: !unknown ${SECRET}\n`,
  );
  const lib = resolvePath(import.meta.dirname, 'index.ts');
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `import { resolveWithReason } from ${JSON.stringify(lib)};` +
        `process.stdout.write(JSON.stringify(resolveWithReason('inbox')));`,
    ],
    { encoding: 'utf8', env: { ...process.env, HANGAR_PG_CONFIG: cfg } },
  );
  assert.match(r.stdout, /schema-invalid/, 'the malformed entry must still be rejected');
  assert.equal(r.stderr.includes(SECRET), false, `the YAML warning leaked the value:\n${r.stderr}`);
  assert.equal(r.stdout.includes(SECRET), false);
  rmSync(d, { recursive: true, force: true });
});

test('check: exit 0 when every variable resolves, 1 when one does not', () => {
  const d = sandbox();
  const cfg = { HANGAR_PG_CONFIG: join(d, 'databases.yaml') };
  assert.equal(run(['check'], { ...cfg, PG_PW_INBOX: SECRET }).code, 0);
  const bad = run(['check'], { ...cfg, PG_PW_INBOX: undefined });
  assert.equal(bad.code, 1, 'a missing variable MUST fail the preflight');
  assert.match(bad.out, /FAIL {2}inbox: env-missing \(PG_PW_INBOX\)/);
  rmSync(d, { recursive: true, force: true });
});

test('the password never reaches stdout or stderr, plain or --json', () => {
  const d = sandbox();
  const cfg = { HANGAR_PG_CONFIG: join(d, 'databases.yaml'), PG_PW_INBOX: SECRET };
  for (const args of [['check'], ['check', '--json']]) {
    const r = run(args, cfg);
    assert.equal(r.code, 0);
    assert.equal(r.out.includes(SECRET), false, `stdout leaked the password: ${args}`);
    assert.equal(r.err.includes(SECRET), false, `stderr leaked the password: ${args}`);
  }
  rmSync(d, { recursive: true, force: true });
});

test('--json emits one parseable object; the report never claims connectivity', () => {
  const d = sandbox();
  const cfg = { HANGAR_PG_CONFIG: join(d, 'databases.yaml'), PG_PW_INBOX: SECRET };
  const parsed = JSON.parse(run(['check', '--json'], cfg).out) as { ok: boolean; entries: unknown[] };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  // The honesty note is normative (场景:不谎称验过连通性) — deleting it must break a test.
  assert.match(run(['check'], cfg).out, /NOT verified/);
  rmSync(d, { recursive: true, force: true });
});

test('--from-plist uses ONLY the plist env — a variable present in the shell must not rescue it', () => {
  const d = sandbox();
  const bin = fakePlutil(
    d,
    JSON.stringify({ EnvironmentVariables: { HANGAR_PG_CONFIG: join(d, 'databases.yaml') } }),
  );
  // Deliberately green in the caller's environment, blind in the daemon's. That asymmetry
  // is the entire reason this mode exists.
  const r = run(['check', '--from-plist', join(d, 'x.plist')], { PG_PW_INBOX: SECRET }, bin);
  assert.equal(r.code, 1, 'the shell has the password; the plist does not → MUST fail');
  assert.match(r.out, /PG_PW_INBOX/);
  rmSync(d, { recursive: true, force: true });
});

test('--from-plist passes when the plist itself carries the variable', () => {
  const d = sandbox();
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: { HANGAR_PG_CONFIG: join(d, 'databases.yaml'), PG_PW_INBOX: SECRET },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], { PG_PW_INBOX: undefined }, bin);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.includes(SECRET), false);
  rmSync(d, { recursive: true, force: true });
});

test('--from-plist rejects a plist that does not declare HANGAR_PG_CONFIG', () => {
  const d = sandbox();
  const bin = fakePlutil(d, JSON.stringify({ EnvironmentVariables: { PG_PW_INBOX: SECRET } }));
  const r = run(['check', '--from-plist', join(d, 'x.plist')], { HANGAR_PG_CONFIG: join(d, 'databases.yaml') }, bin);
  assert.equal(r.code, 1, 'without an explicit declaration it would fall back to the convention path');
  assert.match(r.err, /missing HANGAR_PG_CONFIG/);
  rmSync(d, { recursive: true, force: true });
});

test('--from-plist survives non-string plist values and a plist with no EnvironmentVariables', () => {
  const d = sandbox();
  // <integer> is how an operator naively writes a numeric password in XML. It must not
  // reach `.trim()` and produce a stack trace from the tool whose job is clean diagnostics.
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: { HANGAR_PG_CONFIG: join(d, 'databases.yaml'), PG_PW_INBOX: 123456 },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], {}, bin);
  assert.equal(r.code, 1);
  assert.equal(/TypeError|at Object\./.test(r.err), false, `crashed instead of reporting:\n${r.err}`);
  assert.match(r.out, /PG_PW_INBOX/);

  const d2 = sandbox();
  const bin2 = fakePlutil(d2, JSON.stringify({ Label: 'com.example' }));
  const r2 = run(['check', '--from-plist', join(d2, 'x.plist')], {}, bin2);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /no EnvironmentVariables dict/);
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});
