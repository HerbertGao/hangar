import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createProbeServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import test from "node:test";

import {
  createHangarReadServer,
  createHangarServerComposition,
  loadBundledHangarViewAssets,
} from "../../apps/hangar-server/index.ts";
import {
  compileRelease,
  type AgentSpec,
  type AttemptToken,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import { commandMeta } from "../../packages/control-core/index.ts";
import { RecoveryAuthority } from "../../packages/control-store-sqlite/index.ts";

const browserExecutable =
  "/Users/herbertgao/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const freePort = async (): Promise<number> => {
  const server = createProbeServer();
  const port = await new Promise<number>((resolve) =>
    server.listen(0, () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-view-"));
  const port = await freePort();
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-view", "target-view"));
  const secrets = new Map([["view-key", "view-secret"]]);
  const composition = createHangarServerComposition({
    tls: false,
    secureCookies: false,
    controlPath: join(directory, "control.sqlite"),
    controlStore: { authorityPath, fence },
    controlOptions: {
      timeAuthority: { nowUnixMs: () => 1_000 },
      approvalTtlMs: 60_000,
    },
    authPath: join(directory, "auth.sqlite"),
    authOptions: {
      nowUnixMs: () => 1_000,
      resolveSecret: (ref) => secrets.get(ref),
      origin: `http://127.0.0.1:${port}`,
      sessionTtlMs: 60_000,
      renewalGraceMs: 300_000,
    },
  });
  composition.auth.putHmacKey(1, "view-key", true);
  composition.auth.putCredential({
    rawToken: "view-bootstrap-secret",
    kind: "bootstrap",
    generation: 1,
    principalId: "view-operator",
    scopes: [
      "agent:read",
      "release:read",
      "run-start",
      "run:read",
      "approval:read",
      "event:read",
      "health:read",
    ],
  });
  const spec: AgentSpec = {
    agentId: "heartbeat-operator",
    goal: "emit one heartbeat",
    harnessKind: "fake",
    checkpointSchema: "checkpoint-v1",
    capabilities: [],
    effectOperations: ["fixture.commit"],
    intentDescriptors: [
      {
        intentId: "emit",
        descriptorVersion: 1,
        inputSchema: { id: "metadata", version: "1", digest: "a".repeat(64) },
        scope: "run-start",
        policyId: "shadow-only",
        resultSchema: { id: "result", version: "1", digest: "b".repeat(64) },
      },
    ],
  };
  const closure: ExecutionClosure = {
    entryId: "view",
    executable: process.execPath,
    executableDigest: sha("view"),
    members: [],
  };
  const release = compileRelease(spec, closure);
  const control = composition.control.control;
  value(
    control.publish(
      commandMeta(
        "owner",
        "publish-release",
        release.releaseId,
        "publish",
        release,
      ),
      release,
    ),
  );
  value(
    control.activateMode(
      commandMeta(
        "owner",
        "activate-mode",
        spec.agentId,
        "activate",
        {
          agentId: spec.agentId,
          releaseId: release.releaseId,
          epoch: 1,
          activationMode: "shadow",
        },
        { expectedCurrentEpoch: null },
      ),
      {
        agentId: spec.agentId,
        releaseId: release.releaseId,
        epoch: 1,
        activationMode: "shadow",
      },
    ),
  );
  const server = createHangarReadServer(composition, {
    heartbeatMs: 25,
    viewAssets: loadBundledHangarViewAssets(),
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    directory,
    port,
    owner,
    composition,
    server,
    control,
    release,
    close: async () => {
      (
        server as unknown as { closeAllConnections(): void }
      ).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      composition.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("V1-style Hangar View uses session-only bootstrap and public SDK for complete operator flow", async () => {
  const f = await setup();
  const browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await page.goto(`http://127.0.0.1:${f.port}/`);
    if (consoleErrors.length > 0)
      throw new Error(consoleErrors.join("\n"));
    await page.getByLabel("Bootstrap credential").fill("view-bootstrap-secret");
    await page.getByRole("button", { name: "建立安全会话" }).click();
    await page.getByRole("button", { name: /heartbeat-operator/ }).waitFor();
    assert.equal(
      await page.getByLabel("Bootstrap credential").inputValue(),
      "",
    );
    const residue = await page.evaluate(() => ({
      url: location.href,
      body: document.body.textContent ?? "",
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
    }));
    assert.equal(residue.body.includes("view-bootstrap-secret"), false);
    assert.equal(residue.url.includes("view-bootstrap-secret"), false);
    assert.equal(residue.cookie.includes("view-bootstrap-secret"), false);
    assert.equal(residue.local, 0);
    assert.equal(residue.session, 0);

    // Page restart restores the active HttpOnly session without bootstrap.
    await page.reload();
    await page.getByRole("button", { name: /heartbeat-operator/ }).waitFor();
    assert.equal(await page.locator("#login").isHidden(), true);

    await page.getByRole("button", { name: /heartbeat-operator/ }).click();
    await page.getByLabel("触发说明").fill("从网页启动 heartbeat");
    await page.getByRole("button", { name: "启动 shadow-evaluator" }).click();
    await page.waitForTimeout(200);
    const intentError =
      (await page.locator("#intentError").textContent()) ?? "";
    assert.equal(intentError, "", intentError);
    await page.locator("#activeRun").waitFor();
    const runId = (await page.locator("#runId").textContent())!.trim();
    assert.match(runId, /^[0-9a-f]{64}$/);
    await page.getByText("run-admitted").waitFor();

    // A real HarnessSession creates pending Approval; SSE refreshes the drawer.
    const admitted = value(f.control.sourceFacts()).find(
      ({ factKind, aggregateId }) =>
        factKind === "run-admitted" && aggregateId === runId,
    );
    assert.ok(admitted);
    // SAFETY: trusted test reads the run-admitted contract payload to obtain its
    // attempt-bound token; UI still sees only SDK projections.
    const token = (admitted!.payload as unknown as { token: AttemptToken })
      .token;
    const action = {
      type: "action" as const,
      action: {
        actionId: "web-effect-action",
        kind: "tool" as const,
        inputDigest: "c".repeat(64),
      },
    };
    value(
      f.control
        .harness(token)
        .submit(
          commandMeta(
            "fixture",
            "register-action",
            runId,
            "web-action",
            action,
            token,
          ),
          action,
        ),
    );
    const effect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "web-effect-action",
        intentKey: "web-approval",
        intentGeneration: 1,
        operation: "fixture.commit",
        payloadDigest: "d".repeat(64),
      },
    };
    const webApprovalId = value(
      f.control
        .harness(token)
        .submit(
          commandMeta(
            "fixture",
            "effect-intent",
            runId,
            "web-effect",
            effect,
            token,
          ),
          effect,
        ),
    ).effectId;
    assert.match(webApprovalId, /^[0-9a-f]{64}$/);
    await page.getByRole("button", { name: /heartbeat-operator/ }).click();
    await page.getByText("等待你的决定").waitFor();
    await page.getByRole("button", { name: "批准" }).click();
    await page
      .getByRole("button", { name: "批准", exact: true })
      .last()
      .click();
    await page.getByText("Approval 已记录").waitFor();
    await page.locator("#closeDrawer").click();

    await page.locator("#cancelRun").click();
    await page.locator("#confirmAction").click();
    await page.getByText("Cancel 已提交").waitFor();
    assert.match(
      (await page.locator("#runState").textContent()) ?? "",
      /cancel/,
    );

    // Revocation on refresh returns to login; Run remains owned by Control.
    f.composition.auth.revokeCredential("bootstrap", 1);
    await page.reload();
    await page.getByRole("button", { name: "建立安全会话" }).waitFor();
    assert.equal(
      value(f.control.snapshot(runId)).state.startsWith("cancel"),
      true,
    );
    assert.equal(consoleErrors.length, 1);
    assert.ok(
      consoleErrors.every((message) => message.includes("401 (Unauthorized)")),
      consoleErrors.join("\n"),
    );
  } finally {
    await browser.close();
    await f.close();
  }
});

test("view controller imports only generated SDK and contains no credential storage/CLI path", () => {
  const source = readFileSync(
    new URL("../../apps/hangar-view/public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\/control-sdk\.js"/);
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|localStorage\.|sessionStorage\.|node:sqlite|child_process|hangar-cli|control-core|control-store/,
  );
});
