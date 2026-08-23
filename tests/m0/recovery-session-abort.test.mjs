import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import { digest, query, sqlite, withDatabase } from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.restore.case-328187b3d7e9970d"
  ],
  "pending session abort retires proposed target and completes both commands", async () => {
   await withDatabase((databasePath) => {
      sqlite(
         databasePath,
         `INSERT INTO storage_identity VALUES (1, 'database-1', NULL, 'recovery-only');
       INSERT INTO control_instance_ids VALUES ('source-1', 'database-1', 'historical');
       INSERT INTO commands VALUES ('command-init', 'actor-1', 'restore-init', 'restore-target', 'key-init', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', '${digest("5")}', '${digest("6")}');
       INSERT INTO commands VALUES ('command-abort', 'actor-1', 'abort-recovery', 'session-1', 'key-abort', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("7")}', '${digest("8")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);
       INSERT INTO control_instance_ids VALUES ('target-1', 'database-1', 'proposed');
       INSERT INTO recovery_sessions VALUES ('session-1', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-1', NULL, 'pending-target', 'command-init');`,
      );
      sqlite(
         databasePath,
         `BEGIN;
       UPDATE recovery_sessions SET state='retired' WHERE recovery_session_id='session-1' AND state='pending-target';
       UPDATE control_instance_ids SET lifecycle='retired' WHERE control_instance_id='target-1' AND lifecycle='proposed';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"recovery_aborted"}' WHERE command_id='command-init';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"aborted"}' WHERE command_id='command-abort';
       COMMIT;`,
      );
      assert.equal(
         query(databasePath, "SELECT state FROM recovery_sessions")[0].state,
         "retired",
      );
      assert.deepEqual(
         query(
            databasePath,
            "SELECT command_id, status FROM commands ORDER BY command_id",
         ),
         [
            { command_id: "command-abort", status: "completed" },
            { command_id: "command-init", status: "completed" },
         ],
      );
      assert.equal(
         query(
            databasePath,
            "SELECT count(*) AS count FROM recovery_qualifications",
         )[0].count,
         0,
      );
   });
});
