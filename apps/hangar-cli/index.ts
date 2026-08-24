#!/usr/bin/env node
import {
  ControlSdk,
  ControlSdkError,
  type ControlSdkOptions,
} from "../../packages/control-sdk/index.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliEnvironment {
  readonly HANGAR_URL?: string;
  readonly HANGAR_TOKEN?: string;
}

const usage =
  "usage: hangar <agents|releases|run|health|intent|cancel|decision> ... [--json]";

const flags = (values: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      result.set(value, next);
      index += 1;
    } else result.set(value, "true");
  }
  return result;
};

const output = (
  io: CliIo,
  json: boolean,
  value: unknown,
  label: string,
): void => {
  io.out(
    json
      ? JSON.stringify({ ok: true, command: label, result: value })
      : `${label}: ${JSON.stringify(value)}`,
  );
};

const failure = (
  io: CliIo,
  json: boolean,
  error: unknown,
  writeStarted: boolean,
): number => {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ControlSdkError ? error.status : undefined;
  const auth = status === 401 || status === 403;
  const operation =
    writeStarted ||
    (error instanceof ControlSdkError &&
      (error.kind === "http" || error.kind === "protocol") &&
      !auth);
  const code = auth ? 2 : operation ? 1 : 2;
  const kind = auth
    ? "auth"
    : writeStarted && !(error instanceof ControlSdkError)
      ? "unknown-to-client"
      : operation
        ? "operation"
        : "transport";
  io.err(
    json
      ? JSON.stringify({
          ok: false,
          kind,
          message,
          ...(status ? { status } : {}),
        })
      : `${kind}: ${message}`,
  );
  return code;
};

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment,
  io: CliIo,
  fetchImpl: ControlSdkOptions["fetchImpl"] = fetch,
): Promise<number> {
  const json = argv.includes("--json");
  const positional = argv.filter((value) => !value.startsWith("--"));
  const command = positional[0];
  if (!environment.HANGAR_URL || !environment.HANGAR_TOKEN || !command) {
    io.err(
      json
        ? JSON.stringify({ ok: false, kind: "usage", message: usage })
        : usage,
    );
    return 2;
  }
  const sdk = new ControlSdk({
    baseUrl: environment.HANGAR_URL,
    credentialHeaders: () => ({
      Authorization: `Bearer ${environment.HANGAR_TOKEN}`,
    }),
    fetchImpl,
  });
  const options = flags(argv);
  let writeStarted = false;
  try {
    if (command === "agents") {
      output(io, json, await sdk.listAgents(), command);
      return 0;
    }
    if (command === "releases" && positional[1]) {
      output(io, json, await sdk.listReleases(positional[1]), command);
      return 0;
    }
    if (command === "run" && positional[1]) {
      output(io, json, await sdk.getRun(positional[1]), command);
      return 0;
    }
    if (command === "health") {
      output(io, json, await sdk.health(), command);
      return 0;
    }
    const idempotencyKey = options.get("--idempotency-key");
    const ifMatch = options.get("--if-match");
    if (command === "intent" && positional[1] && positional[2]) {
      const descriptorVersion = Number(options.get("--descriptor-version"));
      const mode = options.get("--mode");
      const trigger = options.get("--trigger");
      if (
        !idempotencyKey ||
        !ifMatch ||
        !Number.isSafeInteger(descriptorVersion) ||
        descriptorVersion < 1 ||
        !trigger ||
        !["shadow-evaluator", "production"].includes(mode ?? "")
      )
        throw new TypeError(usage);
      writeStarted = true;
      output(
        io,
        json,
        await sdk.submitIntent(
          positional[1],
          positional[2],
          {
            descriptorVersion,
            executionMode: mode as "shadow-evaluator" | "production",
            input: { trigger },
          },
          { idempotencyKey, ifMatch },
        ),
        command,
      );
      return 0;
    }
    if (command === "cancel" && positional[1] && idempotencyKey && ifMatch) {
      writeStarted = true;
      output(
        io,
        json,
        await sdk.cancelRun(positional[1], { idempotencyKey, ifMatch }),
        command,
      );
      return 0;
    }
    if (
      command === "decision" &&
      positional[1] &&
      ["approved", "denied"].includes(positional[2] ?? "") &&
      idempotencyKey &&
      ifMatch
    ) {
      writeStarted = true;
      output(
        io,
        json,
        await sdk.decideApproval(
          positional[1],
          positional[2] as "approved" | "denied",
          { idempotencyKey, ifMatch },
        ),
        command,
      );
      return 0;
    }
    io.err(
      json
        ? JSON.stringify({ ok: false, kind: "usage", message: usage })
        : usage,
    );
    return 2;
  } catch (error) {
    if (error instanceof TypeError && error.message === usage) {
      io.err(
        json
          ? JSON.stringify({ ok: false, kind: "usage", message: usage })
          : usage,
      );
      return 2;
    }
    return failure(io, json, error, writeStarted);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then((code) => {
    process.exitCode = code;
  });
}
