// `hangar-notify check` had no tests at all until 2026-07-29 — the CLI is what the deploy
// runbook makes mandatory, so an untested one is a preflight nobody has ever seen fail.
// (`@hangar/pgconfig` learned this the hard way: six mutations survived in its CLI.)
//
// `--from-plist` shells out to `plutil`, which is macOS-only. Rather than skip those cases
// on Linux — leaving them unguarded exactly where CI runs — a fake `plutil` goes on PATH,
// so the real path (spawn → parse → merge → env-select) still runs everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

const CLI = resolvePath(import.meta.dirname, 'cli.ts');
const TOKEN = '123456789:AAqwertyuiopasdfghjklzxcvbnm1234567';
const CONFIG = 'apps:\n  inbox:\n    private: { bot: "${TG_BOT_INBOX}", chat: "886699001" }\n';

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'notifycli-'));
  writeFileSync(join(dir, 'channels.yaml'), CONFIG);
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

test('no args / unknown subcommand → usage on stderr, exit 2', () => {
  for (const args of [[], ['bogus']]) {
    const r = run(args);
    assert.equal(r.code, 2, `args=${JSON.stringify(args)}`);
    assert.match(r.err, /Usage:/);
  }
});

test('--from-plist without a path → exit 2 (usage), not a crash', () => {
  const r = run(['check', '--from-plist']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--from-plist requires a <path>/);
});

test('--from-plist uses ONLY the daemon env — a token in the shell must not rescue it', () => {
  const d = sandbox();
  const bin = fakePlutil(
    d,
    JSON.stringify({ EnvironmentVariables: { HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml') } }),
  );
  // Green in the caller's environment, blind in the daemon's. That asymmetry is the
  // entire reason this mode exists.
  const r = run(['check', '--from-plist', join(d, 'x.plist')], { TG_BOT_INBOX: TOKEN }, bin);
  assert.equal(r.code, 1, 'the shell has the token; the daemon env does not → MUST fail');
  assert.match(r.out, /TG_BOT_INBOX/);
  rmSync(d, { recursive: true, force: true });
});

test('the token never reaches stdout or stderr', () => {
  const d = sandbox();
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: { HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml'), TG_BOT_INBOX: TOKEN },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], {}, bin);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((r.out + r.err).includes(TOKEN), false, 'a preflight must not print the secret');
  rmSync(d, { recursive: true, force: true });
});

test('HANGAR_NOTIFY_CONFIG declared nowhere → exit 1, never a silent fallback', () => {
  const d = sandbox();
  const bin = fakePlutil(d, JSON.stringify({ EnvironmentVariables: { TG_BOT_INBOX: TOKEN } }));
  const r = run(
    ['check', '--from-plist', join(d, 'x.plist')],
    { HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml') },
    bin,
  );
  assert.equal(r.code, 1, 'undeclared, it would fall back to the convention path — a different file');
  assert.match(r.err, /HANGAR_NOTIFY_CONFIG/);
  rmSync(d, { recursive: true, force: true });
});

// --- DOTENV_CONFIG_PATH layer -------------------------------------------------
// The deployed shape (ts.mac-mini, 2026-07-29) keeps secrets OUT of the plist: launchd
// declares only non-secret vars plus DOTENV_CONFIG_PATH, and the pilot's own
// `import 'dotenv/config'` loads the rest.

test('--from-plist follows DOTENV_CONFIG_PATH: a token in that file counts as present', () => {
  const d = sandbox();
  writeFileSync(join(d, '.env'), `TG_BOT_INBOX=${TOKEN}\n`);
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: {
        HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml'),
        DOTENV_CONFIG_PATH: join(d, '.env'),
      },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], { TG_BOT_INBOX: undefined }, bin);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal((r.out + r.err).includes(TOKEN), false);
  rmSync(d, { recursive: true, force: true });
});

test('a quoted value is read exactly as dotenv reads it, quotes stripped', () => {
  const d = sandbox();
  // A naive `split('=')` would hand the checker `"123…"` WITH the quotes while the daemon
  // gets it without — the shape check then disagrees with reality in one direction or the
  // other. This is why the parser must be dotenv's own.
  writeFileSync(join(d, '.env'), `TG_BOT_INBOX="${TOKEN}"\n`);
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: {
        HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml'),
        DOTENV_CONFIG_PATH: join(d, '.env'),
      },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], {}, bin);
  assert.equal(r.code, 0, `quoted token must validate; got:\n${r.out}${r.err}`);
  rmSync(d, { recursive: true, force: true });
});

test('on conflict the plist wins, matching launchd-then-dotenv order', () => {
  const d = sandbox();
  // dotenv does not overwrite an already-set process.env key, so in the daemon the
  // launchd value survives. A reversed merge would validate a value the daemon never has.
  writeFileSync(join(d, '.env'), `HANGAR_NOTIFY_CONFIG=/nonexistent/channels.yaml\nTG_BOT_INBOX=${TOKEN}\n`);
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: {
        HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml'),
        DOTENV_CONFIG_PATH: join(d, '.env'),
      },
    }),
  );
  const r = run(['check', '--from-plist', join(d, 'x.plist')], {}, bin);
  assert.equal(r.code, 0, `plist value must win; got:\n${r.out}${r.err}`);
  rmSync(d, { recursive: true, force: true });
});

test('a declared but unreadable DOTENV_CONFIG_PATH fails loudly, naming that file', () => {
  const d = sandbox();
  const bin = fakePlutil(
    d,
    JSON.stringify({
      EnvironmentVariables: {
        HANGAR_NOTIFY_CONFIG: join(d, 'channels.yaml'),
        DOTENV_CONFIG_PATH: join(d, 'missing.env'),
      },
    }),
  );
  // dotenv itself ignores a missing file. Inheriting that silence would surface later as
  // "TG_BOT_INBOX missing" and send the operator to the wrong file.
  const r = run(['check', '--from-plist', join(d, 'x.plist')], {}, bin);
  assert.equal(r.code, 1);
  assert.match(r.err, /DOTENV_CONFIG_PATH/);
  assert.match(r.err, /missing\.env/);
  rmSync(d, { recursive: true, force: true });
});
