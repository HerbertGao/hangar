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
    "v2c.effect.case-1aa57d13a5b3e2c9",
    "v2s.restore.case-5f0865c543d38000",
    "v2s.source-facts.case-509c8f8ee66c48fe",
    "v2s.source-facts.case-ff5f30494b34e8fa",
    "v2s.transactions.case-8c6021fe8d0041a2"
  ],
  "post-final recovery conflict atomically reopens evidence and quarantines authority", async () => {
   await withDatabase((databasePath) => {
      sqlite(databasePath, seedRecoverySql());
      sqlite(
         databasePath,
         `UPDATE recovery_qualifications SET state='qualified' WHERE agent_id='agent-1';
       UPDATE activations SET state='active' WHERE activation_id='activation-1';
       INSERT INTO recovery_discovered_operations VALUES ('operation-1', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("c")}', 'committed', 'resolved-committed', 1);
       INSERT INTO mutation_authorities VALUES ('authority-1', 'target-1', 'gateway-claim', 'v1', 1, 1, 'active');`,
      );
      sqlite(
         databasePath,
         `BEGIN;
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'recovery-post-final-conflict', 'v1', '{}', '${digest("2")}');
       UPDATE recovery_discovered_operations SET external_outcome='conflicted', reconciliation_state='unresolved', owner_generation=2 WHERE recovery_operation_id='operation-1' AND owner_generation=1;
       UPDATE recovery_qualifications SET state='invalidated' WHERE recovery_session_id='session-1' AND agent_id='agent-1' AND state='qualified';
       UPDATE activations SET state='quarantined' WHERE activation_id='activation-1' AND state='active';
       UPDATE mutation_authorities SET state='revoked' WHERE authority_id='authority-1' AND generation=1;
       COMMIT;`,
      );
      assert.deepEqual(
         query(
            databasePath,
            "SELECT external_outcome, reconciliation_state FROM recovery_discovered_operations",
         )[0],
         {
            external_outcome: "conflicted",
            reconciliation_state: "unresolved",
         },
      );
      assert.equal(
         query(databasePath, "SELECT state FROM recovery_qualifications")[0]
            .state,
         "invalidated",
      );
      assert.equal(
         query(databasePath, "SELECT state FROM activations")[0].state,
         "quarantined",
      );
      assert.equal(
         query(databasePath, "SELECT state FROM mutation_authorities")[0].state,
         "revoked",
      );
      sqlite(
         databasePath,
         `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'recovery-post-final-conflict', 'v1', '{}', '${digest("3")}');
       UPDATE recovery_qualifications SET state='invalidated' WHERE recovery_session_id='session-1' AND agent_id='agent-1' AND state='qualified';
       COMMIT;`,
      );
      assert.equal(
         query(databasePath, "SELECT state FROM recovery_qualifications")[0]
            .state,
         "invalidated",
      );
      assert.equal(
         query(
            databasePath,
            "SELECT count(*) AS count FROM recovery_agent_attempts",
         )[0].count,
         1,
      );
      assert.equal(
         query(
            databasePath,
            "SELECT count(*) AS count FROM activation_permit_evidence",
         )[0].count,
         0,
      );
   });
});
