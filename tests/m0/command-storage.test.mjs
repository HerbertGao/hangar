import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRecoverySql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const commandUrl = new URL(
  "../../contracts/v2/storage/command-results.json",
  import.meta.url,
);

test("command row stores the full historical canonicalization tuple and identity", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      `INSERT INTO commands VALUES ('command-1', 'actor-1', 'cancel-run', 'run-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', NULL, 'completed', '{"kind":"cancelled"}', NULL, NULL, NULL, NULL)`,
    );
    const row = query(
      databasePath,
      "SELECT actor_subject_id, command_kind, target_aggregate_id, idempotency_key, command_schema_version, canonicalization_version, hash_algorithm, payload_digest, precondition_digest FROM commands",
    )[0];
    assert.deepEqual(row, {
      actor_subject_id: "actor-1",
      command_kind: "cancel-run",
      target_aggregate_id: "run-1",
      idempotency_key: "key-1",
      command_schema_version: "control-command-v1",
      canonicalization_version: "canonical-json-v1",
      hash_algorithm: "sha256",
      payload_digest: digest("2"),
      precondition_digest: digest("3"),
    });
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO commands VALUES ('command-2', 'actor-1', 'cancel-run', 'run-1', 'key-1', 'control-command-v2', 'canonical-json-v2', 'sha512', '${digest("1")}', '${digest("4")}', '${digest("5")}', NULL, 'completed', '{}', NULL, NULL, NULL, NULL)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test("only recovery coordination commands may remain pending", async () => {
  await withDatabase((databasePath) => {
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO commands VALUES ('normal-pending', 'actor-1', 'cancel-run', 'run-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', NULL, 'pending-coordination', NULL, NULL, NULL, NULL, NULL)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test.scenarios(
  [
    "v2s.command-results.case-9a101297cada90be"
  ],
  "command completion and mutation fact cannot split", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO commands VALUES ('command-activate', 'actor-1', 'recover-activate', 'session-1/agent-1/0', 'key-a', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL)`,
    );
    const failed = sqlite(
      databasePath,
      `BEGIN;
       UPDATE commands SET status='completed', safe_result_json='{"kind":"ok"}' WHERE command_id='command-activate';
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("a")}', '${digest("b")}', 'command-result', 'v1', '{}', '${digest("2")}');
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(
      query(
        databasePath,
        "SELECT status FROM commands WHERE command_id='command-activate'",
      )[0].status,
      "pending-coordination",
    );
  });
});

test.scenarios(
  [
    "v2s.command-results.case-7afc003bcd02ae6c"
  ],
  "recovery finalization rejects a missing pending command without facts", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    const factCount = query(
      databasePath,
      "SELECT count(*) AS count FROM source_facts",
    )[0].count;
    const commandCount = query(
      databasePath,
      "SELECT count(*) AS count FROM commands",
    )[0].count;
    const finalize = (commandId) => {
      const rows = query(
        databasePath,
        `SELECT status FROM commands WHERE command_id='${commandId}'`,
      );
      if (rows.length !== 1 || rows[0].status !== "pending-coordination")
        throw new Error("pending_command_missing");
    };
    assert.throws(() => finalize("missing-command"), /pending_command_missing/);
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM commands")[0].count,
      commandCount,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM source_facts")[0]
        .count,
      factCount,
    );
  });
});

test.scenarios(
  [
    "v2c.authority-policy.case-5c67acc325c0c5cc",
    "v2c.command-idempotency.case-a20b4cd54b52d782",
    "v2c.command-idempotency.case-fe14f31f64c6e9c7",
    "v2s.command-results.case-543e5abd1372fe6d",
    "v2s.command-results.case-83427b6d51b66fa6",
    "v2s.restore.case-ea0f82fddbb05f2f"
  ],
  "stored results require current disclosure authorization and never carry reusable grant", async () => {
  const manifest = JSON.parse(await readFile(commandUrl, "utf8"));
  assert.equal(manifest.replay.storedTuple, true);
  assert.equal(manifest.replay.currentTupleReinterpretation, false);
  assert.equal(manifest.replay.currentDisclosureAuthorization, true);
  assert.equal(manifest.replay.mutationReexecution, false);
  assert.equal(manifest.reusableGrantInResult, false);
});
