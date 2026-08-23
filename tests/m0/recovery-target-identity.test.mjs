import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import { digest, query, sqlite, withDatabase } from "./sqlite-helper.mjs";

function pendingSessionSql() {
  return `BEGIN;
    INSERT INTO storage_identity VALUES (1, 'database-1', NULL, 'recovery-only');
    INSERT INTO control_instance_ids VALUES ('source-1', 'database-1', 'historical');
    INSERT INTO commands VALUES ('command-init', 'actor-1', 'restore-init', 'restore-target-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', '${digest("5")}', '${digest("6")}');
    INSERT INTO control_instance_ids VALUES ('target-1', 'database-1', 'proposed');
    INSERT INTO recovery_sessions VALUES ('session-1', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-1', NULL, 'pending-target', 'command-init');
    COMMIT;`;
}

test.scenarios(
  [
    "v2s.command-results.case-207bca756be6ac0d",
    "v2s.sqlite.case-929cebd105ea0925"
  ],
  "restore-init preallocates one non-reusable session/target identity", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, pendingSessionSql());
    const row = query(databasePath, "SELECT * FROM recovery_sessions")[0];
    assert.equal(row.recovery_session_id, "session-1");
    assert.equal(row.proposed_target_control_instance_id, "target-1");
    assert.equal(row.target_control_instance_id, null);
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO commands VALUES ('command-init-2', 'actor-1', 'restore-init', 'restore-target-2', 'key-2', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'pending-coordination', NULL, 'session-2', 'target-2', '${digest("5")}', '${digest("6")}');
         INSERT INTO control_instance_ids VALUES ('target-2', 'database-1', 'proposed');
         INSERT INTO recovery_sessions VALUES ('session-2', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-2', NULL, 'pending-target', 'command-init-2');`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test("initialized target must equal the preallocated proposed target", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, pendingSessionSql());
    assert.notEqual(
      sqlite(
        databasePath,
        "UPDATE recovery_sessions SET state='initialized', target_control_instance_id='other'",
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `UPDATE control_instance_ids SET lifecycle='active' WHERE control_instance_id='target-1';
       INSERT INTO control_instances VALUES ('target-1', 'database-1', 'recovery-target', 'quarantined', NULL, NULL, NULL, NULL, NULL, NULL);
       UPDATE recovery_sessions SET state='initialized', target_control_instance_id='target-1' WHERE recovery_session_id='session-1';`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT target_control_instance_id FROM recovery_sessions",
      )[0].target_control_instance_id,
      "target-1",
    );
  });
});
