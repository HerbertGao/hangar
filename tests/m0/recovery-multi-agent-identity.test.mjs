import assert from "node:assert/strict";
import test from "node:test";

import { digest, query, sqlite, withDatabase } from "./sqlite-helper.mjs";

function initializedSql() {
  return `BEGIN;
    INSERT INTO storage_identity VALUES (1, 'database-1', 'target-1', 'recovery-only');
    INSERT INTO control_instance_ids VALUES ('source-1', 'database-1', 'historical');
    INSERT INTO control_instance_ids VALUES ('target-1', 'database-1', 'active');
    INSERT INTO control_instances VALUES ('target-1', 'database-1', 'recovery-target', 'quarantined', NULL, NULL, NULL, NULL, NULL, NULL);
    INSERT INTO commands VALUES ('command-init', 'actor-1', 'restore-init', 'restore-target-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'completed', '{}', 'session-1', 'target-1', '${digest("5")}', '${digest("6")}');
    INSERT INTO recovery_sessions VALUES ('session-1', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-1', 'target-1', 'initialized', 'command-init');
    INSERT INTO agents VALUES ('agent-1'); INSERT INTO agents VALUES ('agent-2');
    INSERT INTO agent_releases VALUES ('${digest("a")}', 'agent-1', '{}', '${digest("b")}');
    INSERT INTO agent_releases VALUES ('${digest("c")}', 'agent-2', '{}', '${digest("d")}');
    INSERT INTO activations VALUES ('activation-1', 'agent-1', '${digest("a")}', 1, 'quarantined', NULL);
    INSERT INTO activations VALUES ('activation-2', 'agent-2', '${digest("c")}', 3, 'quarantined', NULL);
    INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-1', 0, 'target-1', 'activation-1', '${digest("a")}', 'quarantined', 2);
    INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-2', 0, 'target-1', 'activation-2', '${digest("c")}', 'quarantined', 7);
    COMMIT;`;
}

test("all Agents share one target while qualification and epoch remain independent", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, initializedSql());
    const rows = query(
      databasePath,
      "SELECT agent_id, target_control_instance_id, reserved_epoch FROM recovery_qualifications ORDER BY agent_id",
    );
    assert.deepEqual(rows, [
      {
        agent_id: "agent-1",
        target_control_instance_id: "target-1",
        reserved_epoch: 2,
      },
      {
        agent_id: "agent-2",
        target_control_instance_id: "target-1",
        reserved_epoch: 7,
      },
    ]);
  });
});

test("a qualification cannot reuse another Agent's Activation or Release", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, initializedSql());
    sqlite(
      databasePath,
      "UPDATE recovery_qualifications SET state = 'aborted' WHERE agent_id = 'agent-1'",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-1', 1, 'target-1', 'activation-2', '${digest("c")}', 'quarantined', 8)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test("a per-Agent qualification cannot bind another target", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, initializedSql());
    sqlite(
      databasePath,
      "INSERT INTO control_instance_ids VALUES ('target-2', 'database-1', 'proposed')",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-1', 1, 'target-2', 'activation-1', '${digest("a")}', 'quarantined', 8)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
