import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import { canonicalDigest } from "../../scripts/validate-m0.mjs";
import {
  digest,
  query,
  seedRecoverySql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.source-facts.case-0d073422ca59c3a0",
    "v2s.source-facts.case-9d12d5cab51d80e9"
  ],
  "snapshot-after operation uses stable discovery identity and is never dispatchable", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    const operationId = canonicalDigest([
      "recovery-operation-v1",
      "database-1",
      "source-1",
      "sink-1",
      "discovery-1",
    ]);
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'recovery-operation-discovered', 'v1', '{}', '${digest("2")}');
       INSERT INTO recovery_discovered_operations VALUES ('${operationId}', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("c")}', 'unknown', 'pending', 1);
       INSERT INTO recovery_operation_memberships VALUES ('recovery-attempt-1', 'agent-1', '${operationId}', 4, '${digest("d")}');
       COMMIT;`,
    );
    const operation = query(
      databasePath,
      "SELECT external_outcome, reconciliation_state FROM recovery_discovered_operations",
    )[0];
    assert.deepEqual(operation, {
      external_outcome: "unknown",
      reconciliation_state: "pending",
    });
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM effects")[0].count,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM effect_dispatches")[0]
        .count,
      0,
    );
  });
});
