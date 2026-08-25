import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
import { ControlSdk } from "../../packages/control-sdk/index.ts";
import { commandMeta } from "../../packages/control-core/index.ts";
import {
  TelegramLongPollingAdapter,
  type MappedControlRequest,
  type TelegramControlMapper,
} from "../../packages/telegram-adapter/index.ts";
import { TelegramTransportConnector } from "../../packages/telegram-gateway/index.ts";
import { TelegramHttpTransport } from "../../packages/telegram-gateway/http-transport.ts";
import { TelegramTransportStore } from "../../packages/telegram-transport-store-sqlite/index.ts";
import { RecoveryAuthority } from "../../packages/control-store-sqlite/index.ts";

const browserExecutable =
  "/Users/herbertgao/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const freePort = async (): Promise<number> => {
  const probe = createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, () => resolve((probe.address() as { port: number }).port)),
  );
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-cross-client-"));
  const [serverPort, telegramPort] = await Promise.all([
    freePort(),
    freePort(),
  ]);
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-cross", "target-cross"));
  const composition = createHangarServerComposition({
    tls: false,
    secureCookies: false,
    controlPath: join(directory, "control.sqlite"),
    controlStore: { authorityPath, fence },
    controlOptions: {
      timeAuthority: { nowUnixMs: () => 1_000 },
      approvalTtlMs: 60_000,
      controlCommandPolicy: () => "allow",
    },
    authPath: join(directory, "auth.sqlite"),
    authOptions: {
      nowUnixMs: () => 1_000,
      resolveSecret: () => "auth-secret",
      origin: `http://127.0.0.1:${serverPort}`,
    },
    telegramChannel: {
      updateRefSecret: "update-secret",
      controlRefSecret: "control-secret",
      serviceAuthorityId: "telegram-service-authority",
      macKeyGeneration: 1,
      nowUnixMs: () => 1_000,
    },
  });
  composition.auth.putHmacKey(1, "auth-key", true);
  composition.auth.putCredential({
    rawToken: "web-bootstrap",
    kind: "bootstrap",
    generation: 1,
    principalId: "shared-subject",
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
  composition.auth.putCredential({
    rawToken: "telegram-service-token",
    kind: "telegram_service",
    generation: 1,
    principalId: "telegram-service-principal",
    scopes: ["run-start", "run:read", "approval:read"],
  });
  composition.auth.putTelegramMapping({
    servicePrincipalId: "telegram-service-principal",
    userId: "42",
    chatId: "7",
    mappingVersion: 1,
    representedSubjectId: "shared-subject",
    scopes: ["run-start", "run:read", "approval:read"],
  });
  const spec: AgentSpec = {
    agentId: "agent-cross",
    goal: "cross client acceptance",
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
    entryId: "cross",
    executable: process.execPath,
    executableDigest: sha("cross"),
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
  await new Promise<void>((resolve) => server.listen(serverPort, resolve));

  const updates: Record<string, unknown>[] = [];
  const telegramCalls: Array<{ method: string; body: unknown }> = [];
  let responseLoss = false;
  const telegramDouble = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    const method = request.url?.split("/").at(-1) ?? "";
    telegramCalls.push({ method, body });
    if (method === "getUpdates") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: updates.splice(0) }));
      return;
    }
    if (responseLoss) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise<void>((resolve) =>
    telegramDouble.listen(telegramPort, resolve),
  );

  const gateway = composition.gateway;
  const protocolMapper = {
    normalize(update: Readonly<Record<string, unknown>>) {
      const command = update.command as Record<string, unknown>;
      return {
        userId: String(update.user_id),
        chatId: String(update.chat_id),
        messageIdOrCallbackId: String(
          update.message_id ?? update.callback_id ?? "",
        ),
        mappingVersion: Number(update.mapping_version),
        controlOperation: command.operation as
          | "submit-intent"
          | "read-run"
          | "cancel-run"
          | "decide-approval",
        normalizedTarget: String(command.target),
      };
    },
    delivery(input: { target: string; payloadBytes: Uint8Array }) {
      return {
        chat_id: "7",
        text: new TextDecoder().decode(input.payloadBytes).slice(0, 4000),
      };
    },
  };
  const transport = new TelegramHttpTransport({
    baseUrl: `http://127.0.0.1:${telegramPort}`,
    mapper: protocolMapper,
    timeoutMs: 100,
  });
  const connector = new TelegramTransportConnector(
    gateway,
    transport,
    "BOT_TOKEN_PRIVATE",
    {
      connectorInstanceId: "connector-1",
      adapterInstanceId: "adapter-1",
      serviceAuthorityRef: "service-ref",
      serviceAuthorityId: "telegram-service-authority",
      serviceCredentialGeneration: 1,
      updateRefSecret: "update-secret",
      controlRefSecret: "control-secret",
      nowUnixMs: () => 1_000,
    },
  );
  const transportStore = new TelegramTransportStore(
    join(directory, "telegram-transport.sqlite"),
    () => 1_000,
  );
  const sdk = new ControlSdk({
    baseUrl: `http://127.0.0.1:${serverPort}`,
    credentialHeaders: () => ({
      Authorization: "Bearer telegram-service-token",
    }),
  });
  const mapper: TelegramControlMapper = {
    map({ rawUpdate }) {
      const raw = JSON.parse(new TextDecoder().decode(rawUpdate)) as {
        command: Record<string, unknown>;
      };
      const command = raw.command;
      if (command.kind === "intent") {
        const mapped = {
          kind: "intent" as const,
          agentId: "agent-cross",
          intentId: "emit",
          descriptorVersion: 1,
          executionMode: "shadow-evaluator" as const,
          input: { trigger: String(command.trigger) },
          ifMatch:
            command.omitIfMatch === true ? undefined : `"${release.releaseId}"`,
        };
        return mapped as unknown as MappedControlRequest;
      }
      if (command.kind === "run")
        return { kind: "run", runId: String(command.runId) };
      return {
        kind: "decision",
        runId: String(command.runId),
        approvalId: String(command.approvalId),
        decision: String(command.decision) as "approved" | "denied",
        ifMatch: String(command.ifMatch),
      };
    },
  };
  const adapter = new TelegramLongPollingAdapter(
    sdk,
    connector,
    transportStore,
    mapper,
    {
      serviceAuthorityRef: "service-ref",
      nowUnixMs: () => 1_000,
      mappingValid: () => true,
    },
  );
  return {
    directory,
    owner,
    composition,
    control,
    release,
    server,
    serverPort,
    telegramDouble,
    telegramPort,
    telegramCalls,
    updates,
    connector,
    adapter,
    transportStore,
    setResponseLoss: (value: boolean) => {
      responseLoss = value;
    },
    close: async () => {
      transportStore.close();
      (
        server as unknown as { closeAllConnections(): void }
      ).closeAllConnections();
      (
        telegramDouble as unknown as { closeAllConnections(): void }
      ).closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => telegramDouble.close(() => resolve())),
      ]);
      composition.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const dispatchMeta = (effectId: string, prefix: string) => ({
  start: commandMeta(
    "gateway",
    "dispatch-control-effect",
    effectId,
    `${prefix}-start`,
    { effectId },
  ),
  outcome: commandMeta(
    "gateway",
    "record-control-effect-outcome",
    effectId,
    `${prefix}-outcome`,
    { effectId, outcome: "committed" },
  ),
  unknown: commandMeta(
    "gateway",
    "mark-control-effect-unknown",
    effectId,
    `${prefix}-unknown`,
    { effectId },
  ),
});

test("missing Telegram write precondition abandons before real Control server", async () => {
  const f = await setup();
  try {
    const factCount = value(f.control.sourceFacts()).length;
    f.updates.push({
      update_id: 1999,
      user_id: 42,
      chat_id: 7,
      message_id: 19,
      mapping_version: 1,
      command: {
        kind: "intent",
        operation: "submit-intent",
        target: "agent-cross",
        trigger: "missing-if-match",
        omitIfMatch: true,
      },
    });
    await f.adapter.pollOnce();
    assert.equal(value(f.control.sourceFacts()).length, factCount);
    assert.deepEqual(
      f.telegramCalls.map(({ method }) => method),
      ["getUpdates"],
    );
    assert.equal(f.updates.length, 0);
  } finally {
    await f.close();
  }
});

test("real Telegram adapter and browser share Control facts; opposite decisions have one winner", async () => {
  const f = await setup();
  const browser = await chromium.launch({
    executablePath: browserExecutable,
    headless: true,
  });
  const page = await (await browser.newContext()).newPage();
  try {
    // Telegram starts the first public shadow intent.
    f.updates.push({
      update_id: 1001,
      user_id: 42,
      chat_id: 7,
      message_id: 11,
      mapping_version: 1,
      command: {
        kind: "intent",
        operation: "submit-intent",
        target: "agent-cross",
        trigger: "telegram",
      },
    });
    await f.adapter.pollOnce();
    const firstRecord = f.transportStore.get(
      f.transportStore.work()[0]?.occurrenceKey ??
        // terminal rows are not in work(); read key from first fact payload below
        value(f.control.sourceFacts()).find(
          ({ factKind }) => factKind === "telegram-occurrence-bound",
        )!.aggregateId,
    )!;
    const firstPayload = JSON.parse(
      new TextDecoder().decode(firstRecord.payloadBytes!),
    ) as { runId: string };
    const telegramRunId = firstPayload.runId;
    assert.match(telegramRunId, /^[0-9a-f]{64}$/);
    const firstEffectId = firstRecord.effectId!;
    const effectFactIndex = value(f.control.sourceFacts()).findIndex(
      ({ factKind, aggregateId }) =>
        factKind === "control-command-effect-created" &&
        aggregateId === firstEffectId,
    );
    assert.ok(effectFactIndex >= 0);
    await f.connector.dispatch(
      dispatchMeta(firstEffectId, "intent-delivery"),
      firstEffectId,
    );
    assert.equal(
      f.telegramCalls.some(({ method }) => method === "sendMessage"),
      true,
    );

    // Browser uses the generated browser SDK and same represented subject.
    await page.goto(`http://127.0.0.1:${f.serverPort}/`);
    await page.getByLabel("Bootstrap credential").fill("web-bootstrap");
    await page.getByRole("button", { name: "建立安全会话" }).click();
    await page.getByRole("button", { name: /agent-cross/ }).waitFor();
    const webRun = await page.evaluate(async (releaseId) => {
      const moduleUrl = "/control-sdk.js";
      const { BrowserControlSdk } = await import(moduleUrl);
      const sdk = new BrowserControlSdk("");
      return sdk.submitIntent(
        "agent-cross",
        "emit",
        {
          descriptorVersion: 1,
          executionMode: "shadow-evaluator",
          input: { trigger: "web" },
        },
        { idempotencyKey: "web-independent-key", ifMatch: `"${releaseId}"` },
      );
    }, f.release.releaseId);
    const webRunId = webRun.data.runId as string;
    assert.notEqual(webRunId, telegramRunId);
    const admissionFacts = value(f.control.sourceFacts()).filter(
      ({ factKind, aggregateId }) =>
        factKind === "run-admitted" &&
        [telegramRunId, webRunId].includes(aggregateId),
    );
    const actorIds = admissionFacts.map(
      ({ payload }) =>
        (payload as unknown as { actorSubjectId: string }).actorSubjectId,
    );
    assert.equal(new Set(actorIds).size, 2);

    // Read response travels through editMessage without changing target Run.
    f.updates.push({
      update_id: 1003,
      user_id: 42,
      chat_id: 7,
      message_id: 13,
      mapping_version: 1,
      command: {
        kind: "run",
        operation: "read-run",
        target: telegramRunId,
        runId: telegramRunId,
      },
    });
    await f.adapter.pollOnce();
    const readOccurrence = value(f.control.sourceFacts()).findLast(
      ({ factKind, aggregateId }) =>
        factKind === "telegram-occurrence-bound" &&
        aggregateId !== firstRecord.occurrenceKey,
    )!.aggregateId;
    const readEffectId = f.transportStore.get(readOccurrence)!.effectId!;
    await f.connector.dispatch(
      dispatchMeta(readEffectId, "read-delivery"),
      readEffectId,
    );
    assert.equal(
      f.telegramCalls.some(({ method }) => method === "editMessageText"),
      true,
    );

    // Pending Approval is produced by the actual Harness, not pre-populated.
    const admitted = value(f.control.sourceFacts()).find(
      ({ factKind, aggregateId }) =>
        factKind === "run-admitted" && aggregateId === telegramRunId,
    )!;
    const token = (admitted.payload as unknown as { token: AttemptToken })
      .token;
    const action = {
      type: "action" as const,
      action: {
        actionId: "cross-action",
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
            telegramRunId,
            "cross-action",
            action,
            token,
          ),
          action,
        ),
    );
    const effect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "cross-action",
        intentKey: "cross-approval",
        intentGeneration: 1,
        operation: "fixture.commit",
        payloadDigest: "d".repeat(64),
      },
    };
    const approvalId = value(
      f.control
        .harness(token)
        .submit(
          commandMeta(
            "fixture",
            "effect-intent",
            telegramRunId,
            "cross-effect",
            effect,
            token,
          ),
          effect,
        ),
    ).effectId;
    const webSnapshot = await page.evaluate(async (runId) => {
      const moduleUrl = "/control-sdk.js";
      const { BrowserControlSdk } = await import(moduleUrl);
      return new BrowserControlSdk("").getRun(runId);
    }, telegramRunId);

    f.updates.push({
      update_id: 1002,
      user_id: 42,
      chat_id: 7,
      callback_id: "cb-1",
      mapping_version: 1,
      command: {
        kind: "decision",
        operation: "decide-approval",
        target: approvalId,
        runId: telegramRunId,
        approvalId,
        decision: "denied",
        ifMatch: webSnapshot.etag,
      },
    });
    await Promise.all([
      page.evaluate(
        async ({ etag, approvalId: browserApprovalId }) => {
          const moduleUrl = "/control-sdk.js";
          const { BrowserControlSdk } = await import(moduleUrl);
          return new BrowserControlSdk("").decideApproval(
            browserApprovalId,
            "approved",
            { idempotencyKey: "web-decision", ifMatch: etag },
          );
        },
        { etag: webSnapshot.etag, approvalId },
      ),
      f.adapter.pollOnce(),
    ]);
    const decisions = value(f.control.sourceFacts()).filter(
      ({ factKind, aggregateId }) =>
        factKind === "approval-decided" && aggregateId === telegramRunId,
    );
    assert.equal(decisions.length, 1);

    const decisionOccurrence = value(f.control.sourceFacts()).findLast(
      ({ factKind }) => factKind === "telegram-occurrence-bound",
    )!.aggregateId;
    const decisionRecord = f.transportStore.get(decisionOccurrence)!;
    const decisionEffectId = decisionRecord.effectId!;
    const beforeSendFacts = value(f.control.sourceFacts()).some(
      ({ factKind, aggregateId }) =>
        factKind === "control-command-effect-created" &&
        aggregateId === decisionEffectId,
    );
    assert.equal(beforeSendFacts, true);
    const sendsBefore = f.telegramCalls.length;
    f.setResponseLoss(true);
    assert.deepEqual(
      await f.connector.dispatch(
        dispatchMeta(decisionEffectId, "decision-loss"),
        decisionEffectId,
      ),
      { ok: false, error: "unknown_effect" },
    );
    assert.equal(f.telegramCalls.length, sendsBefore + 1);
    assert.equal(
      (
        await f.connector.dispatch(
          dispatchMeta(decisionEffectId, "decision-retry"),
          decisionEffectId,
        )
      ).ok,
      false,
    );
    assert.equal(f.telegramCalls.length, sendsBefore + 1);
    assert.equal(value(f.control.snapshot(telegramRunId)).state, "running");
  } finally {
    await browser.close();
    await f.close();
  }
});

test("Telegram protocol double fails hard on malformed/timeout without advancing adapter truth", async () => {
  const malformed = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{broken");
  });
  const port = await freePort();
  await new Promise<void>((resolve) => malformed.listen(port, resolve));
  const transport = new TelegramHttpTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    mapper: {
      normalize: () => {
        throw new Error("not reached");
      },
      delivery: () => ({}),
    },
    timeoutMs: 25,
  });
  try {
    await assert.rejects(
      () => transport.poll("TOKEN", null, 1),
      /malformed_json/,
    );
  } finally {
    await new Promise<void>((resolve) => malformed.close(() => resolve()));
  }

  const slow = createServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.end(JSON.stringify({ ok: true, result: [] }));
  });
  const slowPort = await freePort();
  await new Promise<void>((resolve) => slow.listen(slowPort, resolve));
  const timeout = new TelegramHttpTransport({
    baseUrl: `http://127.0.0.1:${slowPort}`,
    mapper: {
      normalize: () => {
        throw new Error("not reached");
      },
      delivery: () => ({}),
    },
    timeoutMs: 10,
  });
  try {
    await assert.rejects(() => timeout.poll("TOKEN", null, 1));
  } finally {
    (slow as unknown as { closeAllConnections(): void }).closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  }
});
