#!/usr/bin/env node
// hangar-notify check — deploy-time preflight. Loud where resolve() is silent.
// Logs → stderr, report → stdout. Exit: 0 ok / 1 config problem / 2 usage error.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { check, type CheckResult } from './index.js';

function usage(): void {
  process.stderr.write(`hangar-notify — offline preflight for channels.yaml

Usage:
  hangar-notify check                       validate against this shell's environment
  hangar-notify check --from-plist <path>   validate against a launchd plist's
                                            EnvironmentVariables (the daemon's env);
                                            follows DOTENV_CONFIG_PATH if declared

Exit codes: 0 ok · 1 config problem · 2 usage error
Note: offline shape + presence check only; it does NOT verify a token is live/valid.
`);
}

// Read a launchd plist's EnvironmentVariables via the macOS built-in `plutil`
// (no new dependency). Throws on any failure — the caller maps that to exit 1.
function loadPlistEnv(plistPath: string): Record<string, string> {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', plistPath], {
    encoding: 'utf8',
  });
  const doc = JSON.parse(json) as { EnvironmentVariables?: unknown };
  const env = doc.EnvironmentVariables;
  if (!env || typeof env !== 'object') {
    throw new Error(`plist has no EnvironmentVariables dict: ${plistPath}`);
  }
  return env as Record<string, string>;
}

// Rebuild the same environment the daemon will actually run with.
//
// The daemon reads its env from two places:
//   1. the plist — the non-secret vars (PATH, HANGAR_APPS, DOTENV_CONFIG_PATH)
//   2. the .env file that DOTENV_CONFIG_PATH points at — the secrets, loaded by the
//      pilot's own `import 'dotenv/config'`
// Reading only the plist would report every secret as missing, so read both.
//
// The plist wins on conflicts. launchd sets its vars first, and dotenv leaves a var
// alone if it already exists. Merging the other way would check a value the daemon
// never actually has.
//
// We parse with dotenv itself rather than splitting on '=', so quotes and `export `
// prefixes are read the same way the pilot reads them. A parser that disagreed would
// let this check pass on a value that differs from the real one.
function loadDaemonEnv(plistPath: string): Record<string, string> {
  const plistEnv = loadPlistEnv(plistPath);
  const dotenvPath = plistEnv.DOTENV_CONFIG_PATH?.trim();
  if (!dotenvPath) return plistEnv;

  let text: string;
  try {
    text = readFileSync(dotenvPath, 'utf8');
  } catch (e) {
    // Fail here, loudly. dotenv itself ignores a file it cannot read, so the daemon
    // would start up quietly without those vars and you would later see a confusing
    // "TG_BOT_INBOX missing" that sends you looking in the wrong file.
    throw new Error(
      `plist declares DOTENV_CONFIG_PATH=${dotenvPath} but it cannot be read: ${(e as Error).message}`,
    );
  }
  return { ...parseDotenv(text), ...plistEnv };
}

function printReport(result: CheckResult): void {
  process.stdout.write(`channels.yaml: ${result.configPath}\n`);
  if (result.loadFailure) {
    process.stdout.write(`  FAIL config: ${result.loadFailure.reason}\n`);
  }
  for (const e of result.entries) {
    if (e.ok) {
      process.stdout.write(`  ok    ${e.app}/${e.lane}\n`);
    } else {
      const v = e.varName ? ` (${e.varName})` : '';
      process.stdout.write(`  FAIL  ${e.app}/${e.lane}: ${e.reason}${v}\n`);
    }
  }
  process.stdout.write('note: offline shape + presence check only; token validity NOT verified.\n');
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    usage();
    return 2;
  }

  let env: Record<string, string | undefined> = process.env;

  const fromPlistIdx = rest.indexOf('--from-plist');
  if (fromPlistIdx !== -1) {
    const plistPath = rest[fromPlistIdx + 1];
    if (!plistPath) {
      process.stderr.write('error: --from-plist requires a <path>\n');
      return 2;
    }
    let plistEnv: Record<string, string>;
    try {
      plistEnv = loadDaemonEnv(plistPath);
    } catch (e) {
      process.stderr.write(`error: cannot read the daemon's environment: ${(e as Error).message}\n`);
      return 1;
    }
    // HANGAR_NOTIFY_CONFIG MUST be declared somewhere in the daemon's env — the plist
    // or the env file it points at. Relying on the convention default would let a
    // "shell-green, daemon-blind" preflight pass (design D6). What is forbidden is
    // "declared nowhere", not "not in the plist".
    const declared = plistEnv.HANGAR_NOTIFY_CONFIG?.trim();
    if (!declared) {
      process.stderr.write(
        "error: the daemon's environment is missing HANGAR_NOTIFY_CONFIG — declare it in the plist or in the env file it points at, so this check reads the same file the daemon will.\n",
      );
      return 1;
    }
    // Use ONLY the plist env: check() derives the channels.yaml path from it, so the
    // file it reads IS the plist's declared HANGAR_NOTIFY_CONFIG. If that file is
    // missing/malformed, check() reports loadFailure below → exit 1 (assertion has teeth).
    env = plistEnv;
    process.stderr.write(`validating against plist EnvironmentVariables; HANGAR_NOTIFY_CONFIG=${declared}\n`);
  }

  const result = check(env);
  printReport(result);
  return result.ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
