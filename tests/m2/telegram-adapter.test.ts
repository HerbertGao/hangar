import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TelegramGatewayPort } from "../../packages/contracts/index.ts";
import {
  TelegramLongPollingAdapter,
  type MappedControlRequest,
  type TelegramControlSdk,
} from "../../packages/telegram-adapter/index.ts";
import {
  deriveTelegramIdempotencyKey,
  deriveUpdateOccurrenceKey,
  signUpdateInteractionRef,
} from "../../packages/control-api/index.ts";
import { TelegramTransportStore } from "../../packages/telegram-transport-store-sqlite/index.ts";

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const signedUpdate = (
  rawUpdate: Uint8Array,
  overrides: Partial<Parameters<typeof signUpdateInteractionRef>[0]> = {},
) => {
  const updateOccurrenceKey = deriveUpdateOccurrenceKey(
    "connector-1",
    "service-1",
    "1001",
  );
  const claims = {
    schemaVersion: "telegram-update-ref-v1" as const,
    connectorInstanceId: "connector-1",
    adapterInstanceId: "adapter-1",
    serviceAuthorityId: "service-1",
    serviceCredentialGeneration: 1,
    updateId: "1001",
    updateOccurrenceKey,
    userId: "42",
    chatId: "7",
    messageIdOrCallbackId: "9" as string | null,
    mappingVersion: 1,
    controlOperation: "read-run" as const,
    normalizedTarget: "run-1",
    rawUpdateDigest: sha(rawUpdate),
    expiryUnixMs: 10_000,
    ...overrides,
  };
  return {
    claims,
    rawUpdate,
    updateInteractionRef: signUpdateInteractionRef(claims, "update-secret"),
  };
};

async function setup(
  options: {
    mapped?: MappedControlRequest;
    sdkFailure?: boolean;
    deliveryFailure?: boolean;
    mappingValid?: boolean;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "hangar-m2-telegram-adapter-"),
  );
  let now = 1_000;
  let sdkFailure = options.sdkFailure ?? false;
  let deliveryFailure = options.deliveryFailure ?? false;
  let mappingValid = options.mappingValid ?? true;
  const store = new TelegramTransportStore(
    join(directory, "transport.sqlite"),
    () => now,
  );
  const sdkCalls: Array<{ method: string; options: unknown }> = [];
  const sdkResponse = (version: string) => ({
    data: { run: { runId: "run-1", state: version }, pendingApprovals: [] },
    status: 200,
    etag: `"${sha(version)}"`,
    interactionRef: sha(`interaction-${version}`),
  });
  let responseVersion = "snapshot-v1";
  const sdk: TelegramControlSdk = {
    getRun: async (_runId, requestOptions) => {
      sdkCalls.push({ method: "run", options: requestOptions });
      if (sdkFailure) throw new Error("control response lost");
      return sdkResponse(responseVersion);
    },
    submitIntent: async (_agent, _intent, _body, requestOptions) => {
      sdkCalls.push({ method: "intent", options: requestOptions });
      if (sdkFailure) throw new Error("control response lost");
      return {
        ...sdkResponse(responseVersion),
        data: { runId: "new-run", result: { state: "running" } },
      };
    },
    cancelRun: async (_runId, requestOptions) => {
      sdkCalls.push({ method: "cancel", options: requestOptions });
      if (sdkFailure) throw new Error("control response lost");
      return {
        ...sdkResponse(responseVersion),
        data: { runId: "run-1", cancelStatus: "cleanup-pending", result: {} },
      };
    },
    decideApproval: async (_approvalId, _decision, requestOptions) => {
      sdkCalls.push({ method: "decision", options: requestOptions });
      if (sdkFailure) throw new Error("control response lost");
      return {
        ...sdkResponse(responseVersion),
        data: {
          approvalId: "approval-1",
          state: "approved",
          result: "accepted",
        },
      };
    },
  };
  const updates: Array<{
    rawUpdate: Uint8Array;
    updateInteractionRef: string;
  }> = [];
  const deliveryCalls: unknown[] = [];
  const port: TelegramGatewayPort = {
    pollUpdates: async () => ({
      updates: updates.splice(0),
      nextCursor: "cursor-next",
    }),
    requestDelivery: async (input) => {
      deliveryCalls.push(input);
      if (deliveryFailure) throw new Error("Effect ACK lost");
      return {
        status: "effect",
        effectId: sha("effect-1"),
        state: "approved",
        outcome: null,
      };
    },
    readDelivery: async ({ effectId }) => ({
      effectId,
      state: "approved",
      sanitizedSummary: null,
    }),
  };
  const mapper = {
    map: async () =>
      options.mapped ?? ({ kind: "run", runId: "run-1" } as const),
  };
  const adapter = new TelegramLongPollingAdapter(sdk, port, store, mapper, {
    serviceAuthorityRef: "service-ref",
    nowUnixMs: () => now,
    mappingValid: () => mappingValid,
  });
  return {
    directory,
    store,
    adapter,
    updates,
    sdkCalls,
    deliveryCalls,
    setNow: (value: number) => {
      now = value;
    },
    setSdkFailure: (value: boolean) => {
      sdkFailure = value;
    },
    setDeliveryFailure: (value: boolean) => {
      deliveryFailure = value;
    },
    setMappingValid: (value: boolean) => {
      mappingValid = value;
    },
    setResponseVersion: (value: string) => {
      responseVersion = value;
    },
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("happy path persists correlation→control tuple→delivery tuple and advances cursor", async () => {
  const f = await setup();
  try {
    const update = signedUpdate(Buffer.from("raw update"));
    f.updates.push(update);
    await f.adapter.pollOnce();
    const record = f.store.get(update.claims.updateOccurrenceKey)!;
    assert.equal(record.disposition, "delivery-recorded");
    assert.equal(record.rawUpdateDigest, update.claims.rawUpdateDigest);
    assert.match(record.correlationSeed, /^[0-9a-f]{64}$/);
    const mapped = record.controlTuple?.mapped;
    assert.ok(mapped && typeof mapped === "object" && !Array.isArray(mapped));
    assert.equal((mapped as Record<string, unknown>).kind, "run");
    assert.ok(record.interactionRef);
    assert.ok(record.deliveryKey);
    assert.equal(record.effectId, sha("effect-1"));
    assert.equal(f.store.cursor(), "cursor-next");
    assert.equal(f.sdkCalls.length, 1);
    assert.deepEqual(
      (f.sdkCalls[0].options as { channelContext: string }).channelContext,
      update.updateInteractionRef,
    );
    assert.equal(f.deliveryCalls.length, 1);
  } finally {
    await f.close();
  }
});

test("same occurrence with changed raw/claims quarantines and creates no second command", async () => {
  const f = await setup();
  try {
    const first = signedUpdate(Buffer.from("raw one"));
    f.updates.push(first);
    await f.adapter.pollOnce();
    const forged = signedUpdate(Buffer.from("raw two"), {
      rawUpdateDigest: sha("raw two"),
    });
    f.updates.push(forged);
    await f.adapter.pollOnce();
    assert.equal(
      f.store.get(first.claims.updateOccurrenceKey)?.disposition,
      "quarantined-unknown",
    );
    assert.equal(f.sdkCalls.length, 1);
    assert.equal(f.deliveryCalls.length, 1);
  } finally {
    await f.close();
  }
});

test("control response loss stays control-unknown and never retries before quarantine", async () => {
  const f = await setup({ sdkFailure: true });
  try {
    const update = signedUpdate(Buffer.from("raw"));
    f.updates.push(update);
    await f.adapter.pollOnce();
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "control-unknown",
    );
    await f.adapter.resume();
    assert.equal(f.sdkCalls.length, 1);
    f.setSdkFailure(false);
    f.setNow(10_001);
    await f.adapter.resume();
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "quarantined-unknown",
    );
    assert.equal(f.sdkCalls.length, 1);
  } finally {
    await f.close();
  }
});

test("Effect ACK loss stays delivery-unknown; stored read snapshot/payload never changes", async () => {
  const f = await setup({ deliveryFailure: true });
  try {
    const update = signedUpdate(Buffer.from("raw"));
    f.updates.push(update);
    await f.adapter.pollOnce();
    const before = f.store.get(update.claims.updateOccurrenceKey)!;
    assert.equal(before.disposition, "delivery-unknown");
    const payload = [...before.payloadBytes!];
    f.setResponseVersion("snapshot-v2");
    f.setDeliveryFailure(false);
    await f.adapter.resume();
    assert.equal(f.deliveryCalls.length, 1);
    assert.deepEqual(
      [...f.store.get(update.claims.updateOccurrenceKey)!.payloadBytes!],
      payload,
    );
    f.setNow(10_001);
    await f.adapter.resume();
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "quarantined-unknown",
    );
  } finally {
    await f.close();
  }
});

test("cancel/decision redelivery preserves ETag and authenticated occurrence identity", async () => {
  for (const mapped of [
    { kind: "cancel" as const, runId: "run-1", ifMatch: sha("run-etag") },
    {
      kind: "decision" as const,
      runId: "run-1",
      approvalId: "approval-1",
      decision: "approved" as const,
      ifMatch: sha("run-etag"),
    },
  ]) {
    const f = await setup({ mapped });
    try {
      const update = signedUpdate(Buffer.from(`raw-${mapped.kind}`));
      f.updates.push(update);
      await f.adapter.pollOnce();
      const write = f.sdkCalls.find(({ method }) => method === mapped.kind);
      assert.ok(write);
      assert.equal(
        (write!.options as { idempotencyKey: string }).idempotencyKey,
        deriveTelegramIdempotencyKey(update.claims.updateOccurrenceKey),
      );
      const calls = f.sdkCalls.length;
      f.updates.push(update); // exact Telegram redelivery
      await f.adapter.pollOnce();
      assert.equal(f.sdkCalls.length, calls);
      assert.equal(f.deliveryCalls.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("missing write precondition abandons before any Control or delivery call", async () => {
  const f = await setup({
    mapped: { kind: "cancel", runId: "run-1" } as never,
  });
  try {
    const update = signedUpdate(Buffer.from("missing-if-match"));
    f.updates.push(update);
    await f.adapter.pollOnce();
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "abandoned-before-send",
    );
    assert.equal(f.sdkCalls.length, 0);
    assert.equal(f.deliveryCalls.length, 0);
  } finally {
    await f.close();
  }
});

test("two adapter workers compete through single disposition CAS", async () => {
  const f = await setup();
  try {
    const update = signedUpdate(Buffer.from("race"));
    f.store.registerUpdate({
      occurrenceKey: update.claims.updateOccurrenceKey,
      updateRef: update.updateInteractionRef,
      rawUpdate: update.rawUpdate,
    });
    await Promise.all([f.adapter.resume(), f.adapter.resume()]);
    assert.equal(f.sdkCalls.length, 1);
    assert.equal(f.deliveryCalls.length, 1);
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "delivery-recorded",
    );
  } finally {
    await f.close();
  }
});

test("mapping rotation abandons pending before send; source imports contain no Bot API/core/store", async () => {
  const f = await setup({ mappingValid: false });
  try {
    const update = signedUpdate(Buffer.from("raw"));
    f.updates.push(update);
    await f.adapter.pollOnce();
    assert.equal(
      f.store.get(update.claims.updateOccurrenceKey)?.disposition,
      "abandoned-before-send",
    );
    assert.equal(f.sdkCalls.length, 0);
    assert.equal(f.deliveryCalls.length, 0);
    const source = readFileSync(
      new URL("../../packages/telegram-adapter/index.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /Bot API|botToken|control-core|control-store-sqlite|node:sqlite|fetch\s*\(/,
    );
  } finally {
    await f.close();
  }
});
