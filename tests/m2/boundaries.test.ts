import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const source = (path: string): Promise<string> => readFile(path, "utf8");

const imports = (value: string): string[] =>
  [...value.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(
    (match) => match[1],
  );

async function localDependencyClosure(
  entry: string,
  allowedBare: readonly string[] = [],
): Promise<string[]> {
  const pending = [resolve(entry)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const body = await source(path);
    assert.doesNotMatch(
      body,
      /\b(?:import|require)\s*\(/,
      `${path} must not hide a dynamic dependency edge`,
    );
    for (const specifier of imports(body)) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(path), specifier));
        continue;
      }
      assert.ok(
        specifier.startsWith("node:") || allowedBare.includes(specifier),
        `${path} has unexpected bare/workspace dependency ${specifier}`,
      );
    }
  }
  return [...visited].sort();
}

async function productSources(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await productSources(path)));
    else if (/\.(?:ts|js|mjs)$/.test(entry.name)) paths.push(path);
  }
  return paths;
}

test("CLI and Web depend only on generated Control SDK surfaces", async () => {
  const cli = await source("apps/hangar-cli/index.ts");
  assert.match(cli, /packages\/control-sdk\/index\.ts/);
  assert.doesNotMatch(
    cli,
    /control-core|control-store|auth-store|node:sqlite|child_process|legacy-process/,
  );

  const view = await source("apps/hangar-view/public/app.js");
  assert.match(view, /from "\/control-sdk\.js"/);
  assert.doesNotMatch(
    view,
    /localStorage|sessionStorage|indexedDB|node:sqlite|hangar-cli|child_process/,
  );
});

test("Harness, HTTP, and Telegram adapters preserve dependency boundaries", async () => {
  const bridgePath = "packages/pi-harness/bridge.ts";
  const bridge = await source(bridgePath);
  assert.match(bridge, /HarnessAdapterPort/);
  assert.deepEqual(imports(bridge).sort(), [
    "../contracts/index.ts",
    "../pi-child-protocol/index.ts",
    "./expected-artifact.ts",
    "node:crypto",
  ]);
  assert.doesNotMatch(bridge, /\b(?:import|require)\s*\(/);
  assert.doesNotMatch(
    bridge,
    /control-core|control-store|auth-store|telegram-gateway|approveEffect|dispatchEffect|acceptOutcome|terminalize|expiresAtUnixMs|unknown_effect/,
  );
  const contracts = await source("packages/contracts/index.ts");
  const port = /export interface HarnessAdapterPort \{([\s\S]*?)\n\}/.exec(
    contracts,
  )?.[1];
  assert.ok(port);
  assert.deepEqual(
    [...port.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]),
    ["submit", "submit", "submitEffect", "recordFault", "commitCleanup"],
  );
  assert.doesNotMatch(
    port,
    /approve|dispatch|terminalize|expiresAtUnixMs|connector|acceptOutcome/,
  );
  assert.equal(
    (await localDependencyClosure(bridgePath, ["zod"])).some((path) =>
      /control-core|control-store|auth-store|telegram-gateway/.test(path),
    ),
    false,
  );

  const httpPath = "apps/hangar-server/http.ts";
  const http = await source(httpPath);
  assert.doesNotMatch(http, /\b(?:import|require)\s*\(/);
  assert.deepEqual(imports(http).sort(), [
    "../../packages/contracts/index.ts",
    "../../packages/control-api/index.ts",
    "node:buffer",
    "node:crypto",
    "node:fs",
    "node:http",
  ]);
  assert.doesNotMatch(
    http,
    /control-core|control-store-sqlite|auth-store-sqlite|node:sqlite/,
  );
  assert.equal(
    (await localDependencyClosure(httpPath, ["zod"])).some((path) =>
      /control-core|control-store-sqlite|auth-store-sqlite/.test(path),
    ),
    false,
  );
  const composition = await source("apps/hangar-server/index.ts");
  assert.doesNotMatch(
    composition,
    /function (?:handleAuthSession|handleReadRequest|streamEvents)|createGuardedServer/,
  );

  const telegram = await source("packages/telegram-adapter/index.ts");
  assert.doesNotMatch(telegram, /\b(?:import|require)\s*\(/);
  assert.match(telegram, /TelegramGatewayPort/);
  assert.match(telegram, /control-sdk\/index\.ts/);
  assert.doesNotMatch(
    telegram,
    /control-core|control-store-sqlite|auth-store-sqlite|telegram-gateway|api\.telegram\.org|BOT_TOKEN|sendMessage|editMessageText|answerCallbackQuery/,
  );
  assert.equal(
    (
      await localDependencyClosure("packages/telegram-adapter/index.ts", [
        "zod",
      ])
    ).some((path) =>
      /control-core|control-store-sqlite|auth-store-sqlite|telegram-gateway/.test(
        path,
      ),
    ),
    false,
  );
  for (const path of [
    "packages/control-core/index.ts",
    "packages/telegram-gateway/index.ts",
  ])
    assert.doesNotMatch(
      await source(path),
      /telegram-transport-store-sqlite/,
      `${path} must not read adapter transport truth`,
    );
});

test("product code reads no planning evidence and acceptance uses real Telegram ports", async () => {
  for (const directory of ["apps", "packages"])
    for (const path of await productSources(directory))
      assert.doesNotMatch(
        await source(path),
        /openspec\/|oracles\/m0\/|measurements\/|evidence\//,
        `${path} must not read planning or evaluation artifacts`,
      );

  const acceptance = await source("tests/m2/cross-client.test.ts");
  assert.match(acceptance, /TelegramTransportConnector/);
  assert.match(acceptance, /TelegramHttpTransport/);
  assert.match(acceptance, /TelegramLongPollingAdapter/);
});
