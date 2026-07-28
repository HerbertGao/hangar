#!/usr/bin/env node
// hangar-pgconfig check — deploy-time preflight. Loud where resolve() is silent.
// Logs → stderr, report → stdout, `--json` for structured output.
// Exit: 0 ok / 1 config problem / 2 usage error.
import { execFileSync } from 'node:child_process';
import { check, type CheckResult } from './index.js';

function usage(): void {
  process.stderr.write(`hangar-pgconfig — offline preflight for databases.yaml

Usage:
  hangar-pgconfig check                       validate against this shell's environment
  hangar-pgconfig check --from-plist <path>   validate against a launchd plist's
                                              EnvironmentVariables (the daemon's env)
  hangar-pgconfig check [--json]              structured report on stdout

Exit codes: 0 ok · 1 config problem · 2 usage error
Note: offline shape + presence check only. It does NOT connect, so it proves nothing
about reachability or whether postgres accepts these credentials.
`);
}

// Read a launchd plist's EnvironmentVariables via the macOS built-in `plutil` (no new
// dependency). Throws on any failure — the caller maps that to exit 1.
function loadPlistEnv(plistPath: string): Record<string, string> {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', plistPath], {
    encoding: 'utf8',
  });
  let doc: { EnvironmentVariables?: unknown };
  try {
    doc = JSON.parse(json) as { EnvironmentVariables?: unknown };
  } catch {
    // Fixed message, never the parse error: its text can echo the start of the input, and
    // plutil's stdout is exactly where the passwords are.
    throw new Error(`plutil output was not JSON: ${plistPath}`);
  }
  const env = doc.EnvironmentVariables;
  if (!env || typeof env !== 'object') {
    throw new Error(`plist has no EnvironmentVariables dict: ${plistPath}`);
  }
  // Drop non-string values. A plist can legitimately hold <integer>/<true/>, and launchd
  // does not export those as environment variables anyway — but an unchecked cast lets one
  // reach `raw.trim()` and crash the very command the deploy runbook makes mandatory.
  // Dropping them reports the variable as missing, which is the honest answer.
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
}

function printReport(result: CheckResult): void {
  process.stdout.write(`databases.yaml: ${result.configPath}\n`);
  if (result.loadFailure) {
    process.stdout.write(`  FAIL config: ${result.loadFailure.reason}\n`);
  }
  for (const e of result.entries) {
    if (e.ok) {
      process.stdout.write(`  ok    ${e.app}\n`);
    } else {
      const v = e.varName ? ` (${e.varName})` : '';
      process.stdout.write(`  FAIL  ${e.app}: ${e.reason}${v}\n`);
    }
  }
  process.stdout.write(
    'note: offline shape + presence check only; connectivity and credential validity NOT verified.\n',
  );
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    usage();
    return 2;
  }

  // Strict parsing, because the failure mode of lenient parsing here is silent and unsafe:
  // `--from-plsit <path>` (a plausible typo) used to be ignored, and the check then ran
  // against the operator's shell — passing green while the daemon's env was never looked
  // at, which is the exact false-green `--from-plist` exists to prevent.
  let json = false;
  let plistPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') {
      json = true;
    } else if (a === '--from-plist') {
      plistPath = rest[++i];
      if (!plistPath || plistPath.startsWith('--')) {
        process.stderr.write('error: --from-plist requires a <path>\n');
        return 2;
      }
    } else {
      process.stderr.write(`error: unknown argument: ${a}\n`);
      usage();
      return 2;
    }
  }

  let env: Record<string, string | undefined> = process.env;

  if (plistPath !== undefined) {
    let plistEnv: Record<string, string>;
    try {
      plistEnv = loadPlistEnv(plistPath);
    } catch (e) {
      process.stderr.write(
        `error: cannot read plist EnvironmentVariables: ${(e as Error).message}\n`,
      );
      return 1;
    }
    // HANGAR_PG_CONFIG MUST be declared IN the plist. Falling back to the convention
    // default here is what makes a "shell-green, daemon-blind" preflight possible: the
    // operator's shell may have the vars while the daemon's env has none.
    // Note this is a presence requirement, not a comparison — comparing the path we read
    // against the value we derived it from would be a tautology that always passes.
    const declared = plistEnv.HANGAR_PG_CONFIG?.trim();
    if (!declared) {
      process.stderr.write(
        'error: plist EnvironmentVariables is missing HANGAR_PG_CONFIG — set it explicitly so this check reads the same file the daemon will.\n',
      );
      return 1;
    }
    // Use ONLY the plist env from here on: check() derives databases.yaml from it, so the
    // file it reads IS the plist's declared HANGAR_PG_CONFIG. If that file is missing or
    // malformed, check() reports loadFailure → exit 1, so the assertion has teeth.
    env = plistEnv;
    process.stderr.write(
      `validating against plist EnvironmentVariables; HANGAR_PG_CONFIG=${declared}\n`,
    );
  }

  const result = check(env);
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    printReport(result);
  }
  return result.ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
