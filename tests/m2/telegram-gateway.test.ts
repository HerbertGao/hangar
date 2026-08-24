import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commandMeta,
  createEffectGateway,
} from "../../packages/control-core/index.ts";
import {
  deriveDeliveryKey,
  signControlInteractionRef,
  verifyUpdateInteractionRef,
} from "../../packages/control-api/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";
import {
  TelegramTransportConnector,
  type TelegramTransport,
} from "../../packages/telegram-gateway/index.ts";
import type { Result } from "../../packages/contracts/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-telegram-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-telegram", "target-telegram"));
  const runtime = openSqliteControl(
    join(directory, "control.sqlite"),
    { authorityPath, fence },
    { controlCommandPolicy: () => "allow" },
  );
  const observedTokens: string[] = [];
  const rawBytes = Buffer.from('{"update_id":1001,"text":"private text"}');
  const transport: TelegramTransport = {
    poll: async (token, _cursor, _limit) => {
      observedTokens.push(token);
      return {
        updates: [
          {
            updateId: "1001",
            userId: "42",
            chatId: "7",
            messageIdOrCallbackId: "9",
            mappingVersion: 1,
            controlOperation: "read-run",
            normalizedTarget: "run-abc",
            rawBytes,
          },
        ],
        nextCursor: "1002",
      };
    },
    deliver: async (token, _delivery) => {
      observedTokens.push(token);
      return "committed";
    },
  };
  const gateway = createEffectGateway(runtime.control);
  const connector = new TelegramTransportConnector(
    gateway,
    transport,
    "secret-bot-token",
    {
      connectorInstanceId: "connector-1",
      adapterInstanceId: "adapter-1",
      serviceAuthorityRef: "service-ref-1",
      serviceAuthorityId: "service-1",
      serviceCredentialGeneration: 1,
      updateRefSecret: "update-secret",
      controlRefSecret: "control-secret",
      nowUnixMs: () => 1_000,
    },
  );
  return {
    runtime,
    owner,
    gateway,
    connector,
    observedTokens,
    rawBytes,
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const dispatchMeta = (effectId: string) => ({
  start: commandMeta("gateway", "dispatch-control-effect", effectId, "start", {
    effectId,
  }),
  outcome: commandMeta(
    "gateway",
    "record-control-effect-outcome",
    effectId,
    "outcome",
    { effectId, outcome: "committed" },
  ),
  unknown: commandMeta(
    "gateway",
    "mark-control-effect-unknown",
    effectId,
    "unknown",
    { effectId },
  ),
});

test("TelegramGatewayPort signs updates and keeps raw text/token outside refs", async () => {
  const f = await setup();
  try {
    const polled = await f.connector.pollUpdates({
      serviceAuthorityRef: "service-ref-1",
      cursor: null,
      limit: 10,
    });
    assert.equal(polled.updates.length, 1);
    assert.deepEqual([...polled.updates[0].rawUpdate], [...f.rawBytes]);
    const encoded = polled.updates[0].updateInteractionRef;
    assert.equal(encoded.includes("private text"), false);
    assert.equal(encoded.includes("secret-bot-token"), false);
    const verified = verifyUpdateInteractionRef(
      encoded,
      "update-secret",
      1_000,
    );
    assert.ok(verified.ok && verified.claims.normalizedTarget === "run-abc");
    assert.deepEqual(f.observedTokens, ["secret-bot-token"]);
    await assert.rejects(() =>
      f.connector.pollUpdates({
        serviceAuthorityRef: "wrong-service",
        cursor: null,
        limit: 1,
      }),
    );
  } finally {
    await f.close();
  }
});

test("verified dual refs create and dispatch a control-command Effect", async () => {
  const f = await setup();
  try {
    const polled = await f.connector.pollUpdates({
      serviceAuthorityRef: "service-ref-1",
      cursor: null,
      limit: 1,
    });
    const updateRef = polled.updates[0].updateInteractionRef;
    const updateRefDigest = sha(updateRef);
    const controlRef = signControlInteractionRef(
      {
        schemaVersion: "control-interaction-ref-v1",
        updateInteractionRefDigest: updateRefDigest,
        routeId: "runs.read",
        normalizedTarget: "run-abc",
        responseKind: "run-viewed",
        commandIdentityDigest: null,
        responseDigest: sha("projection"),
        factHead: 1,
        expiryUnixMs: 2_000,
        macKeyGeneration: 1,
      },
      "control-secret",
    );
    const controlRefDigest = sha(controlRef);
    const deliveryKey = deriveDeliveryKey(
      controlRefDigest,
      "send-message",
      "run-viewed",
    );
    const payloadBytes = Buffer.from("safe response");
    const requested = await f.connector.requestDelivery({
      serviceAuthorityRef: "service-ref-1",
      updateInteractionRef: updateRef,
      controlInteractionRef: controlRef,
      responseKind: "run-viewed",
      deliveryKey,
      deliveryOperation: "send-message",
      payloadBytes,
      payloadDigest: sha(payloadBytes),
    });
    assert.equal(requested.status, "effect");
    const effectId = requested.status === "effect" ? requested.effectId : "";
    assert.match(effectId, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      await f.connector.dispatch(dispatchMeta(effectId), effectId),
      {
        ok: true,
        value: null,
      },
    );
    const delivery = await f.connector.readDelivery({
      serviceAuthorityRef: "service-ref-1",
      effectId,
    });
    assert.equal(delivery.state, "committed");
    assert.deepEqual(f.observedTokens, [
      "secret-bot-token",
      "secret-bot-token",
    ]);
  } finally {
    await f.close();
  }
});

test("target/key/payload mismatches are denied before Effect creation", async () => {
  const f = await setup();
  try {
    const polled = await f.connector.pollUpdates({
      serviceAuthorityRef: "service-ref-1",
      cursor: null,
      limit: 1,
    });
    const updateRef = polled.updates[0].updateInteractionRef;
    const controlRef = signControlInteractionRef(
      {
        schemaVersion: "control-interaction-ref-v1",
        updateInteractionRefDigest: sha(updateRef),
        routeId: "runs.read",
        normalizedTarget: "run-abc",
        responseKind: "run-viewed",
        commandIdentityDigest: null,
        responseDigest: sha("projection"),
        factHead: 1,
        expiryUnixMs: 2_000,
        macKeyGeneration: 1,
      },
      "control-secret",
    );
    const payloadBytes = Buffer.from("safe response");
    const denied = await f.connector.requestDelivery({
      serviceAuthorityRef: "service-ref-1",
      updateInteractionRef: updateRef,
      controlInteractionRef: controlRef,
      responseKind: "run-viewed",
      deliveryKey: sha("forged-key"),
      deliveryOperation: "send-message",
      payloadBytes,
      payloadDigest: sha(payloadBytes),
    });
    assert.deepEqual(denied, { status: "denied", error: "forbidden" });
    assert.deepEqual(f.gateway.pendingControlDeliveries(), {
      ok: true,
      value: [],
    });
  } finally {
    await f.close();
  }
});
