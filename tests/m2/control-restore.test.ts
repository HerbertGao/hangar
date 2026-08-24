import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  ControlCommandDeliveryInput,
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
  preflightM2ControlRestore,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-restore-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(
    owner.initialize("database-restore-m2", "target-restore-m2"),
  );
  const runtime = openSqliteControl(
    join(directory, "control.sqlite"),
    { authorityPath, fence },
    { controlCommandPolicy: () => "allow" },
  );
  const gateway = createEffectGateway(runtime.control);
  const create = (suffix: string) => {
    const payloadBytes = Buffer.from(`payload-${suffix}`);
    const input: ControlCommandDeliveryInput = {
      connectorInstanceId: "connector-1",
      serviceAuthorityId: "service-1",
      updateId: suffix,
      updateOccurrenceKey: controlDeliveryOccurrenceKey(
        "connector-1",
        "service-1",
        suffix,
      ),
      claimsDigest: sha(`claims-${suffix}`),
      rawUpdateDigest: sha(`raw-${suffix}`),
      controlInteractionIdentity: sha(`interaction-${suffix}`),
      deliveryKey: sha(`delivery-${suffix}`),
      deliveryGeneration: 1,
      mappingVersion: 1,
      target: `target-${suffix}`,
      deliveryOperation: "send-message",
      responseKind: "run-viewed",
      payloadBytes,
      payloadDigest: sha(payloadBytes),
    };
    const result = value(
      gateway.requestControlDelivery(
        commandMeta(
          "service",
          "request-control-delivery",
          input.controlInteractionIdentity,
          controlDeliveryIdempotencyKey(input.updateOccurrenceKey),
          normalizeControlDeliveryInput(input),
        ),
        input,
      ),
    );
    if (result.status !== "effect") throw new Error("effect not created");
    return { effectId: result.effectId, input };
  };
  const dispatch = async (effectId: string) => {
    const base = { effectId };
    return gateway.dispatchControl(
      {
        start: commandMeta(
          "gateway",
          "dispatch-control-effect",
          effectId,
          `start-${effectId}`,
          base,
        ),
        outcome: commandMeta(
          "gateway",
          "record-control-effect-outcome",
          effectId,
          `outcome-${effectId}`,
          { effectId, outcome: "committed" },
        ),
        unknown: commandMeta(
          "gateway",
          "mark-control-effect-unknown",
          effectId,
          `unknown-${effectId}`,
          base,
        ),
      },
      effectId,
      async () => "committed",
    );
  };
  return {
    directory,
    runtime,
    owner,
    create,
    dispatch,
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("any non-final control delivery fails restore preflight without mutation", async () => {
  const f = await setup();
  try {
    f.create("1001");
    for (const state of ["pending", "claimed", "unknown", "conflicted"]) {
      const path = join(f.directory, `${state}.sqlite`);
      await f.runtime.backupTo(path);
      const db = new DatabaseSync(path);
      db.prepare(
        "UPDATE effects SET state = ? WHERE subject_kind = 'control-command'",
      ).run(state);
      db.close();
      const before = sha(readFileSync(path));
      assert.deepEqual(preflightM2ControlRestore(path), {
        ok: false,
        error: "unsupported_control_delivery_restore",
      });
      assert.equal(sha(readFileSync(path)), before, state);
    }
  } finally {
    await f.close();
  }
});

test("all-final backup permits Agent restore but leaves connector disabled", async () => {
  const f = await setup();
  try {
    const first = f.create("2001");
    assert.deepEqual(await f.dispatch(first.effectId), {
      ok: true,
      value: null,
    });
    const backup = join(f.directory, "all-final.sqlite");
    await f.runtime.backupTo(backup);
    const before = sha(readFileSync(backup));
    assert.deepEqual(preflightM2ControlRestore(backup), {
      ok: true,
      value: { connectorEnabled: false, finalControlDeliveries: 1 },
    });
    assert.equal(sha(readFileSync(backup)), before);

    const db = new DatabaseSync(backup);
    try {
      const columns = db
        .prepare("PRAGMA table_info(effects)")
        .all()
        .map((row) => row.name);
      assert.equal(columns.includes("owner_agent_id"), false);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM effects WHERE state = 'committed'",
          )
          .get()?.count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("delivery created after snapshot is absent from restore target and never redispatched", async () => {
  const f = await setup();
  try {
    const first = f.create("3001");
    await f.dispatch(first.effectId);
    const backup = join(f.directory, "snapshot.sqlite");
    await f.runtime.backupTo(backup);

    const later = f.create("3002"); // committed after backup snapshot
    assert.notEqual(later.effectId, first.effectId);
    assert.deepEqual(preflightM2ControlRestore(backup), {
      ok: true,
      value: { connectorEnabled: false, finalControlDeliveries: 1 },
    });
    const db = new DatabaseSync(backup);
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM effects").get()?.count,
        1,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) AS count FROM effects WHERE effect_id = ?")
          .get(later.effectId)?.count,
        0,
      );
    } finally {
      db.close();
    }
    // Preflight has no connector argument and cannot dispatch either delivery.
  } finally {
    await f.close();
  }
});
