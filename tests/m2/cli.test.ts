import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runCli } from "../../apps/hangar-cli/index.ts";

const io = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      out: (line: string) => stdout.push(line),
      err: (line: string) => stderr.push(line),
    },
  };
};
const environment = {
  HANGAR_URL: "http://hangar.test",
  HANGAR_TOKEN: "token",
};

test("CLI success has fixed text/json output and exit 0", async () => {
  const text = io();
  assert.equal(
    await runCli(
      ["agents"],
      environment,
      text.value,
      async () =>
        new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    0,
  );
  assert.deepEqual(text.stderr, []);
  assert.match(text.stdout[0], /^agents: /);

  const json = io();
  assert.equal(
    await runCli(
      ["health", "--json"],
      environment,
      json.value,
      async () =>
        new Response(
          JSON.stringify({ health: { status: "healthy", headSeq: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
    0,
  );
  assert.deepEqual(JSON.parse(json.stdout[0]).ok, true);
  assert.deepEqual(json.stderr, []);
});

test("operation/auth/transport classes map to fixed exit codes", async () => {
  const operation = io();
  assert.equal(
    await runCli(
      [
        "intent",
        "agent",
        "emit",
        "--descriptor-version",
        "1",
        "--mode",
        "shadow-evaluator",
        "--trigger",
        "manual",
        "--idempotency-key",
        "key",
        "--if-match",
        `"${"a".repeat(64)}"`,
      ],
      environment,
      operation.value,
      async () =>
        new Response(
          JSON.stringify({
            error: {
              schemaVersion: "wire-error-v1",
              kind: "idempotency_conflict",
              message: "conflict",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ),
    1,
  );
  assert.match(operation.stderr[0], /^operation:/);

  const auth = io();
  assert.equal(
    await runCli(
      ["agents"],
      environment,
      auth.value,
      async () =>
        new Response("{}", {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ),
    2,
  );
  assert.match(auth.stderr[0], /^auth:/);

  const readTransport = io();
  assert.equal(
    await runCli(
      ["agents"],
      environment,
      readTransport.value,
      async () => {
        throw new TypeError("connection refused");
      },
    ),
    2,
  );
  assert.match(readTransport.stderr[0], /^transport:/);

  const writeUnknown = io();
  assert.equal(
    await runCli(
      [
        "cancel",
        "run-1",
        "--idempotency-key",
        "cancel-key",
        "--if-match",
        `"${"a".repeat(64)}"`,
      ],
      environment,
      writeUnknown.value,
      async () => {
        throw new TypeError("response lost");
      },
    ),
    1,
  );
  assert.match(writeUnknown.stderr[0], /^unknown-to-client:/);
});

test("usage/missing auth exits 2 and never sends", async () => {
  let calls = 0;
  const output = io();
  assert.equal(
    await runCli(
      ["intent"],
      environment,
      output.value,
      async () => {
        calls += 1;
        return new Response("{}");
      },
    ),
    2,
  );
  assert.equal(calls, 0);
  assert.equal(
    await runCli(["agents"], { HANGAR_URL: "x" }, output.value),
    2,
  );
});

test("caller-owned identity is replayed exactly; facade has no legacy/storage imports", async () => {
  const keys: string[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    keys.push(headers.get("idempotency-key") ?? "");
    return new Response(
      JSON.stringify({
        runId: "r",
        cancelStatus: "cleanup-pending",
        result: {
          runId: "r",
          cancelStatus: "cleanup-pending",
          fenceGeneration: 1,
        },
      }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  };
  const args = [
    "cancel",
    "r",
    "--idempotency-key",
    "stable-key",
    "--if-match",
    `"${"a".repeat(64)}"`,
  ];
  assert.equal(await runCli(args, environment, io().value, fakeFetch), 0);
  assert.equal(await runCli(args, environment, io().value, fakeFetch), 0);
  assert.deepEqual(keys, ["stable-key", "stable-key"]);

  const source = readFileSync(
    fileURLToPath(new URL("../../apps/hangar-cli/index.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /node:sqlite|node:fs|node:child_process|control-core|control-store|legacy-process/,
  );
});
