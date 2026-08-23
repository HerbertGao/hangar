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
    "v2s.source-facts.case-daa1deb9b4d0f663"
  ],
  "different member under one discovery key conflicts the existing operation", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'recovery-operation-discovered', 'v1', '{"member":"${digest("c")}"}', '${digest("2")}');
       INSERT INTO recovery_discovered_operations VALUES ('operation-1', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("c")}', 'unknown', 'pending', 1);`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("d")}', 'recovery-operation-outcome', 'v1', '{"conflictingMember":"${digest("e")}"}', '${digest("3")}');
       UPDATE recovery_discovered_operations
       SET external_outcome='conflicted', reconciliation_state='unresolved', owner_generation=2
       WHERE recovery_operation_id='operation-1' AND owner_generation=1;
       COMMIT;`,
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT external_outcome, reconciliation_state, owner_generation FROM recovery_discovered_operations",
      )[0],
      {
        external_outcome: "conflicted",
        reconciliation_state: "unresolved",
        owner_generation: 2,
      },
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_discovered_operations VALUES ('operation-2', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("e")}', 'unknown', 'pending', 1)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
