import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRecoverySql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.source-facts.case-b9798ce8ffef3ce4"
  ],
  "authenticated cross-Agent ownership evidence conflicts one global operation", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql({ twoAgents: true }));
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'recovery-operation-discovered', 'v1', '{}', '${digest("2")}');
       INSERT INTO recovery_discovered_operations VALUES ('operation-1', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("c")}', 'unknown', 'pending', 1);
       INSERT INTO recovery_operation_memberships VALUES ('recovery-attempt-1', 'agent-1', 'operation-1', 4, '${digest("d")}');`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("e")}', 'recovery-agent-binding-conflict', 'v1', '{"ownerAgentId":"agent-2"}', '${digest("3")}');
       UPDATE recovery_discovered_operations SET external_outcome='conflicted', reconciliation_state='unresolved', owner_generation=2
       WHERE recovery_operation_id='operation-1' AND owner_generation=1;
       COMMIT;`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT external_outcome FROM recovery_discovered_operations",
      )[0].external_outcome,
      "conflicted",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "INSERT INTO recovery_operation_memberships VALUES ('recovery-attempt-2', 'agent-2', 'operation-1', 5, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')",
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
