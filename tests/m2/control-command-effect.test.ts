import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  ControlCommandDeliveryInput,
  ControlCommandDeliveryResult,
  Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  controlDeliveryIdempotencyKey,
  controlDeliveryOccurrenceKey,
  createEffectGateway,
  normalizeControlDeliveryInput,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const effectResult = (
  result: ControlCommandDeliveryResult,
): Extract<ControlCommandDeliveryResult, { status: "effect" }> => {
  if (result.status !== "effect") throw new Error(result.error);
  return result;
};
const effectValue = (
  result: Result<ControlCommandDeliveryResult>,
): Extract<ControlCommandDeliveryResult, { status: "effect" }> =>
  effectResult(value(result));
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const input = (
  overrides: Partial<ControlCommandDeliveryInput> = {},
): ControlCommandDeliveryInput => {
  const payloadBytes = Buffer.from("safe telegram response");
  return {
    connectorInstanceId: "connector-1",
    serviceAuthorityId: "service-1",
    updateId: "1001",
    updateOccurrenceKey: controlDeliveryOccurrenceKey(
      "connector-1",
      "service-1",
      "1001",
    ),
    claimsDigest: sha("claims-1"),
    rawUpdateDigest: sha("raw-1"),
    controlInteractionIdentity: sha("interaction-1"),
    deliveryKey: sha("delivery-1"),
    deliveryGeneration: 1,
    mappingVersion: 1,
    target: "chat-42",
    deliveryOperation: "send-message",
    responseKind: "run-viewed",
    payloadBytes,
    payloadDigest: sha(payloadBytes),
    ...overrides,
  };
};

const requestMeta = (value: ControlCommandDeliveryInput, key = "request") =>
  commandMeta(
    "telegram-service",
    "request-control-delivery",
    value.controlInteractionIdentity,
    controlDeliveryIdempotencyKey(value.updateOccurrenceKey),
    normalizeControlDeliveryInput(value),
    null,
    sha(`authority-${key}`),
  );

async function setup(policy: "allow" | "deny" = "allow") {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-control-effect-"));
  const authorityPath = join(directory, "authority.sqlite");
  const controlPath = join(directory, "control.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(
    owner.initialize("database-control-effect", "target-control-effect"),
  );
  let currentPolicy = policy;
  let fenceValid = true;
  let crashAfter = false;
  const storeOptions = {
    authorityPath,
    fence,
    afterCommitBeforeAck: () => {
      if (crashAfter) {
        crashAfter = false;
        throw new Error("simulated ACK loss");
      }
    },
  };
  const controlOptions = {
    controlCommandPolicy: () => currentPolicy,
    controlDeliveryFenceValid: () => fenceValid,
  };
  let runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
  let closed = false;
  return {
    directory,
    authorityPath,
    controlPath,
    get runtime() {
      return runtime;
    },
    get gateway() {
      return createEffectGateway(runtime.control);
    },
    setPolicy: (next: "allow" | "deny") => {
      currentPolicy = next;
    },
    setFenceValid: (next: boolean) => {
      fenceValid = next;
    },
    setCrashAfter: () => {
      crashAfter = true;
    },
    closeRuntime: () => {
      if (!closed) runtime.close();
      closed = true;
    },
    reopen: () => {
      if (!closed) throw new Error("runtime still open");
      runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
      closed = false;
    },
    close: async () => {
      if (!closed) runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const dispatchMeta = (
  effectId: string,
  prefix: string,
  outcome = "committed",
) => ({
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
    { effectId, outcome },
  ),
  unknown: commandMeta(
    "gateway",
    "mark-control-effect-unknown",
    effectId,
    `${prefix}-unknown`,
    { effectId },
  ),
});

test("legacy schema fails migration preflight before sidecar or byte mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-migration-"));
  try {
    const legacyPath = join(directory, "legacy.sqlite");
    const absentAuthority = join(directory, "must-not-exist.sqlite");
    const db = new DatabaseSync(legacyPath);
    db.exec(
      "CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY, database_identity TEXT NOT NULL);" +
        "INSERT INTO store_meta VALUES (1, 'legacy-db')",
    );
    db.close();
    const before = sha(readFileSync(legacyPath));
    assert.throws(
      () =>
        openSqliteControl(legacyPath, {
          authorityPath: absentAuthority,
          fence: {
            databaseIdentity: "legacy-db",
            targetId: "t",
            generation: 0,
          },
        }),
      /migration_required/,
    );
    assert.equal(sha(readFileSync(legacyPath)), before);
    assert.equal(existsSync(absentAuthority), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject-specific DDL rejects mixed run-action/control-command columns", async () => {
  const f = await setup();
  try {
    f.closeRuntime();
    const db = new DatabaseSync(f.controlPath);
    try {
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO effects(effect_identity,effect_id,subject_kind,owner_id," +
              "run_id,action_id,intent_key,intent_generation," +
              "control_interaction_identity,delivery_key,delivery_generation," +
              "target,payload_base64url,payload_digest,state)" +
              " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            "mixed",
            "effect",
            "run-action",
            "owner",
            "run",
            "action",
            "intent",
            1,
            "control-id",
            "delivery",
            1,
            "target",
            "bytes",
            sha("payload"),
            "pending",
          ),
      );
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("pre-Effect deny is durable across ACK loss with zero Effect facts", async () => {
  const f = await setup("deny");
  try {
    const request = input();
    const before = value(f.runtime.control.sourceFacts()).length;
    f.setCrashAfter();
    assert.deepEqual(
      f.gateway.requestControlDelivery(requestMeta(request), request),
      { ok: false, error: "invalid_state" },
    );
    f.setPolicy("allow"); // replay must not reinterpret the stored denial
    assert.deepEqual(
      f.gateway.requestControlDelivery(requestMeta(request), request),
      { ok: true, value: { status: "denied", error: "forbidden" } },
    );
    assert.equal(value(f.runtime.control.sourceFacts()).length, before);
    assert.deepEqual(f.gateway.pendingControlDeliveries(), {
      ok: true,
      value: [],
    });
  } finally {
    await f.close();
  }
});

test("allow binds first occurrence; mismatch quarantines without second Effect", async () => {
  const f = await setup();
  try {
    const first = input();
    const created = effectValue(
      f.gateway.requestControlDelivery(requestMeta(first), first),
    );
    const effectId = created.effectId;
    const factsBefore = value(f.runtime.control.sourceFacts());
    assert.equal(
      factsBefore.filter(
        ({ factKind }) => factKind === "control-command-effect-created",
      ).length,
      1,
    );
    const mismatch = input({
      claimsDigest: sha("claims-forged"),
      controlInteractionIdentity: sha("interaction-forged"),
      deliveryKey: sha("delivery-forged"),
    });
    assert.deepEqual(
      f.gateway.requestControlDelivery(
        requestMeta(mismatch, "mismatch"),
        mismatch,
      ),
      {
        ok: true,
        value: { status: "denied", error: "channel_evidence_conflict" },
      },
    );
    const factsAfter = value(f.runtime.control.sourceFacts());
    assert.equal(
      factsAfter.filter(
        ({ factKind }) => factKind === "control-command-effect-created",
      ).length,
      1,
    );
    assert.equal(
      factsAfter.some(
        ({ factKind }) => factKind === "telegram-occurrence-quarantined",
      ),
      true,
    );
    assert.equal(
      effectValue(f.gateway.readControlDelivery(effectId)).state,
      "approved",
    );
    f.closeRuntime();
    const db = new DatabaseSync(f.controlPath);
    try {
      const row = db
        .prepare(
          "SELECT subject_kind,target,payload_base64url,payload_digest FROM effects WHERE effect_id = ?",
        )
        .get(effectId);
      assert.equal(row?.subject_kind, "control-command");
      assert.equal(row?.target, first.target);
      assert.equal(
        row?.payload_base64url,
        Buffer.from(first.payloadBytes).toString("base64url"),
      );
      assert.equal(row?.payload_digest, first.payloadDigest);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("connector/mapping fence applies predispatch but not after dispatch-started", async () => {
  const revoked = await setup();
  try {
    const request = input();
    const effectId = effectValue(
      revoked.gateway.requestControlDelivery(requestMeta(request), request),
    ).effectId;
    revoked.setFenceValid(false);
    let calls = 0;
    assert.deepEqual(
      await revoked.gateway.dispatchControl(
        dispatchMeta(effectId, "revoked"),
        effectId,
        async () => {
          calls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "forbidden" },
    );
    assert.equal(calls, 0);
    assert.equal(
      effectValue(revoked.gateway.readControlDelivery(effectId)).state,
      "not-committed",
    );
  } finally {
    await revoked.close();
  }

  const started = await setup();
  try {
    const request = input();
    const effectId = effectValue(
      started.gateway.requestControlDelivery(requestMeta(request), request),
    ).effectId;
    assert.deepEqual(
      await started.gateway.dispatchControl(
        dispatchMeta(effectId, "started"),
        effectId,
        async () => {
          // Fence rotates only after dispatch-started; old reconciler retains
          // authority to record the authenticated outcome, never redispatch.
          started.setFenceValid(false);
          return "committed";
        },
      ),
      { ok: true, value: null },
    );
    assert.equal(
      effectValue(started.gateway.readControlDelivery(effectId)).state,
      "committed",
    );
  } finally {
    await started.close();
  }
});

test("restart recovers payload from Control DB; unknown never auto-redispatches", async () => {
  const f = await setup();
  try {
    const request = input({ target: "terminal-agent-run-is-irrelevant" });
    const created = effectValue(
      f.gateway.requestControlDelivery(requestMeta(request), request),
    );
    const effectId = created.effectId;
    f.closeRuntime();
    f.reopen();
    assert.equal(
      effectResult(value(f.gateway.pendingControlDeliveries())[0]).effectId,
      effectId,
    );
    let calls = 0;
    assert.deepEqual(
      await f.gateway.dispatchControl(
        dispatchMeta(effectId, "unknown"),
        effectId,
        async (delivery) => {
          calls += 1;
          assert.equal(delivery.target, request.target);
          assert.deepEqual(
            [...delivery.payloadBytes],
            [...request.payloadBytes],
          );
          throw new Error("response lost");
        },
      ),
      { ok: false, error: "unknown_effect" },
    );
    assert.equal(calls, 1);
    assert.equal(
      effectValue(f.gateway.readControlDelivery(effectId)).state,
      "unknown",
    );

    // Unknown is reconciliation-only: second dispatch cannot call connector.
    assert.equal(
      (
        await f.gateway.dispatchControl(
          dispatchMeta(effectId, "retry"),
          effectId,
          async () => {
            calls += 1;
            return "committed";
          },
        )
      ).ok,
      false,
    );
    assert.equal(calls, 1);
    value(
      f.gateway.reconcileControl(
        commandMeta(
          "gateway",
          "record-control-effect-outcome",
          effectId,
          "reconcile",
          { effectId, outcome: "not-committed" },
        ),
        effectId,
        "not-committed",
      ),
    );
    assert.equal(
      effectValue(f.gateway.readControlDelivery(effectId)).state,
      "not-committed",
    );
    // There is no Agent Run aggregate for this delivery; its lifecycle is independent.
    assert.deepEqual(f.runtime.control.snapshot(request.target), {
      ok: false,
      error: "not_found",
    });
  } finally {
    await f.close();
  }
});
