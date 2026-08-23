import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const transactionsUrl = new URL(
  "../../contracts/v2/storage/transactions.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.restore.case-6a06ceb80ff91466",
    "v2s.transactions.case-5358dd57d404c41a",
    "v2s.transactions.case-9eb297ffe7853458",
    "v2s.transactions.case-a6e4bd377058f104",
    "v2s.transactions.case-c0fd0d3206248974",
    "v2s.transactions.case-e5e6bfa6b9efa5e9"
  ],
  "every declared transaction has a closed all-or-none crash result", async () => {
  const manifest = JSON.parse(await readFile(transactionsUrl, "utf8"));
  assert.deepEqual(manifest.crashOutcomes, [
    "none-visible",
    "complete-set-visible",
  ]);
  assert.equal(
    new Set(manifest.operations.map(({ id }) => id)).size,
    manifest.operations.length,
  );
  assert.ok(
    manifest.operations.every(
      ({ members }) =>
        members.length >= 2 && new Set(members).size === members.length,
    ),
  );
  assert.equal(manifest.producerProofPersisted, true);
});

test("a failed activation transaction exposes neither fact nor state change", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    const failed = sqlite(
      databasePath,
      `BEGIN;
       UPDATE activations SET state='draining' WHERE activation_id='activation-1';
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'activation-changed', 'v1', '{}', '${digest("8")}');
       INSERT INTO source_facts VALUES (5, 'database-1', '${digest("c")}', '${digest("d")}', 'activation-changed', 'v1', '{}', '${digest("9")}');
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(
      query(databasePath, "SELECT state FROM activations")[0].state,
      "active",
    );
    assert.equal(
      query(databasePath, "SELECT max(fact_seq) AS seq FROM source_facts")[0]
        .seq,
      2,
    );
  });
});

test("release and admitted Run identity are immutable while Activation epoch only advances", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    for (const statement of [
      `UPDATE agent_releases SET release_json = '{"changed":true}' WHERE release_id = '${digest("2")}'`,
      "UPDATE activations SET epoch = 0 WHERE activation_id = 'activation-1'",
      "UPDATE runs SET trigger_id = 'manual-other' WHERE run_id = 'run-1'",
    ]) {
      assert.notEqual(
        sqlite(databasePath, statement, { allowFailure: true }).status,
        0,
      );
    }
    sqlite(
      databasePath,
      "UPDATE activations SET epoch = 2 WHERE activation_id = 'activation-1'",
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT a.epoch AS current_epoch, r.activation_epoch AS admitted_epoch FROM activations a JOIN runs r ON r.activation_id = a.activation_id",
      )[0],
      { current_epoch: 2, admitted_epoch: 1 },
    );
  });
});

test.scenarios(
  [
    "v2s.transactions.case-551eb32e55c10eb6"
  ],
  "external invocation remains outside SQLite and ambiguous dispatch is unknown", async () => {
  const manifest = JSON.parse(await readFile(transactionsUrl, "utf8"));
  assert.equal(manifest.externalCallPolicy.insideSqliteTransaction, false);
  assert.equal(
    manifest.externalCallPolicy.dispatchStartedCrashOutcome,
    "unknown",
  );
  assert.equal(manifest.externalCallPolicy.automaticRedispatch, false);
});
