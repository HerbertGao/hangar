import assert from "node:assert/strict";
import test from "node:test";

import {
  digest,
  query,
  seedRecoverySql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test("binding winner completes a competing abort command instead of leaving it pending", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO commands VALUES ('command-abort', 'actor-1', 'abort-recovery', 'session-1/agent-1/0', 'abort-key', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);
       INSERT INTO commands VALUES ('command-activate', 'actor-1', 'recover-activate', 'session-1/agent-1/0', 'activate-key', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("5")}', '${digest("6")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       UPDATE recovery_agent_attempts SET state='bound' WHERE recovery_attempt_id='recovery-attempt-1' AND state='executing';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"invalid_state"}' WHERE command_id='command-abort';
       COMMIT;`,
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT command_id, status FROM commands WHERE command_id IN ('command-abort','command-activate') ORDER BY command_id",
      ),
      [
        { command_id: "command-abort", status: "completed" },
        { command_id: "command-activate", status: "pending-coordination" },
      ],
    );
  });
});
