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
    "v2s.restore.case-a6ed285ae8d5d206"
  ],
  "Agent abort completes its winner and unbound activation loser without affecting session", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql({ twoAgents: true }));
    sqlite(
      databasePath,
      `INSERT INTO commands VALUES ('command-abort', 'actor-1', 'abort-recovery', 'session-1/agent-1/0', 'key-abort', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);
       INSERT INTO commands VALUES ('command-activate', 'actor-1', 'recover-activate', 'session-1/agent-1/0', 'key-activate', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("5")}', '${digest("6")}', '${digest("4")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'recovery-qualification', 'v1', '{}', '${digest("7")}');
       UPDATE recovery_qualifications SET state='aborted' WHERE agent_id='agent-1' AND state='enumerating';
       UPDATE recovery_agent_attempts SET state='aborted' WHERE agent_id='agent-1' AND state='executing';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"aborted"}' WHERE command_id='command-abort';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"recovery_aborted"}' WHERE command_id='command-activate';
       COMMIT;`,
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT agent_id, state FROM recovery_qualifications ORDER BY agent_id",
      ),
      [
        { agent_id: "agent-1", state: "aborted" },
        { agent_id: "agent-2", state: "enumerating" },
      ],
    );
    assert.equal(
      query(databasePath, "SELECT state FROM recovery_sessions")[0].state,
      "initialized",
    );
  });
});
