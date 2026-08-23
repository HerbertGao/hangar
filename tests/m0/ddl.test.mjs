import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRecoverySql,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const contractUrl = new URL(
  "../../contracts/v2/storage/contract.json",
  import.meta.url,
);
const schemaUrl = new URL(
  "../../contracts/v2/storage/schema.sql",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.ddl.case-ea22dd0a6e6b281d"
  ],
  "schema bootstraps with foreign keys and every declared table", async () => {
  const contract = JSON.parse(await readFile(contractUrl, "utf8"));
  await withDatabase((databasePath) => {
    const tables = new Set(
      query(
        databasePath,
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      ).map(({ name }) => name),
    );
    for (const table of [
      ...contract.authoritativeTables,
      ...contract.supportTables,
      ...contract.disposableProjectionTables,
    ]) {
      assert.ok(tables.has(table), table);
    }
    assert.equal(query(databasePath, "PRAGMA foreign_keys")[0].foreign_keys, 1);
    assert.ok(!tables.has("App"));
    assert.ok(!tables.has("schedule_cursor"));
  });
});

test("schema is executable in a fresh in-memory SQLite database", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  const result = sqlite(":memory:", schema, { allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
});

test("source facts are append-only and globally contiguous", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      `INSERT INTO storage_identity VALUES (1, 'database-1', NULL, 'enabled');
       INSERT INTO source_facts VALUES (1, 'database-1', '${"0".repeat(64)}', '${"a".repeat(64)}', 'database-genesis', 'v1', '{}', '${"1".repeat(64)}');`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO source_facts VALUES (3, 'database-1', '${"a".repeat(64)}', '${"b".repeat(64)}', 'time-observed', 'v1', '{}', '${"2".repeat(64)}');`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(databasePath, "DELETE FROM source_facts", { allowFailure: true })
        .status,
      0,
    );
  });
});

test.scenarios(
  [
    "v2s.ddl.case-64a293247b9fb32a"
  ],
  "manual admission without a persistent command identity is rejected", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO runs VALUES ('run-2', 'agent-1', '${digest("2")}', 'activation-1', 1, 'manual', NULL, '${digest("4")}', '${digest("5")}', '${digest("6")}')`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM runs")[0].count,
      1,
    );
  });
});

test("authenticated evidence rejects wrong fact kinds, wrong consumer profiles, and mutation", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("2")}');`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO authenticated_evidence VALUES ('wrong-fact', 'production-child', 'launcher', 'v1', 'key-v1', 1, '{}', 'signature', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 10, 100, 1, 3);`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'target-authority-closed', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES ('closure-proof', 'target-authority-closed', 'recovery-authority', 'v1', 'key-v1', 1, '{}', 'signature', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 10, 100, 0, 2);
       INSERT INTO evidence_authority_heads VALUES ('recovery:database-1', 1, 'boot-1', 'cycle-1', 'attestation-1', '${digest("9")}', 1, 'time-1', '${digest("a")}', 1, '${digest("b")}', 2);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_artifacts VALUES ('artifact-wrong-profile', 'recovery-attempt-1', '${digest("3")}', 'closure-proof', '${digest("5")}', '${digest("6")}', 'recovery:database-1', 1, 'attestation-1', '${digest("9")}', 1, 'time-1', '${digest("a")}', 1, '${digest("c")}', '${digest("8")}', 2, 100, 'ready');`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "UPDATE authenticated_evidence SET authority_generation = 2 WHERE evidence_id = 'closure-proof'",
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test("recovery artifact cannot bind after its authority, host, or time snapshot becomes stale", async () => {
  const artifactEnvelope = JSON.stringify({
    claims: {
      authorityId: "recovery-authority",
      authorityVersion: "v1",
      artifactId: "artifact-1",
      agentAttemptId: "recovery-attempt-1",
      reservedEpoch: 2,
      expiresAtUtcMs: 100,
      commandDigest: digest("c"),
      dispatchDenominatorDigest: digest("8"),
      authorityGeneration: 1,
    },
  });
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'binding-certificate', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES ('artifact-proof', 'recovery-artifact', 'recovery-authority', 'v1', 'key-v1', 1, '${artifactEnvelope}', 'signature', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 10, 100, 1, 2);
       INSERT INTO authenticated_evidence_consumptions VALUES ('artifact-proof', 'recovery-artifact', 'artifact-1', 1, 2);
       INSERT INTO evidence_authority_heads VALUES ('recovery:database-1', 1, 'boot-1', 'cycle-1', 'attestation-1', '${digest("9")}', 1, 'time-1', '${digest("a")}', 1, '${digest("b")}', 2);
       INSERT INTO recovery_artifacts VALUES ('artifact-1', 'recovery-attempt-1', '${digest("3")}', 'artifact-proof', '${digest("5")}', '${digest("6")}', 'recovery:database-1', 1, 'attestation-1', '${digest("9")}', 1, 'time-1', '${digest("a")}', 1, '${digest("c")}', '${digest("8")}', 2, 100, 'ready');
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'time-observed', 'v1', '{}', '${digest("3")}');
       UPDATE evidence_authority_heads SET authority_generation=2, host_attestation_id='attestation-2', host_attestation_digest='${digest("d")}', host_generation=2, time_evidence_id='time-2', time_evidence_digest='${digest("e")}', time_generation=2, current_state_digest='${digest("f")}', fact_seq=3 WHERE authority_scope_id='recovery:database-1';`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "UPDATE recovery_artifacts SET state='bound' WHERE artifact_id='artifact-1'",
        { allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT state FROM recovery_artifacts")[0].state,
      "ready",
    );
  });
});
