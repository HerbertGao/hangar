import assert from "node:assert/strict";
import test from "node:test";

import { digest, query, sqlite, withDatabase } from "./sqlite-helper.mjs";

function recoveryBaseSql() {
  return `BEGIN;
    INSERT INTO storage_identity VALUES (1, 'database-1', 'target-1', 'recovery-only');
    INSERT INTO control_instance_ids VALUES ('source-1', 'database-1', 'historical');
    INSERT INTO control_instance_ids VALUES ('target-1', 'database-1', 'active');
    INSERT INTO commands VALUES ('command-init', 'actor-1', 'restore-init', 'restore-target-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'completed', '{}', 'session-1', 'target-1', '${digest("5")}', '${digest("6")}');
    INSERT INTO recovery_sessions VALUES ('session-1', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-1', 'target-1', 'initialized', 'command-init');
    INSERT INTO agents VALUES ('agent-1'); INSERT INTO agents VALUES ('agent-2');
    INSERT INTO agent_releases VALUES ('${digest("a")}', 'agent-1', '{}', '${digest("b")}');
    INSERT INTO activations VALUES ('activation-1', 'agent-1', '${digest("a")}', 1, 'quarantined', NULL);
    INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-1', 0, 'target-1', 'activation-1', '${digest("a")}', 'enumerating', 2);
    INSERT INTO recovery_agent_attempts VALUES ('attempt-r1', 'session-1', 'agent-1', 0, 'executing', 1);
    COMMIT;`;
}

test("stable discovery key has one global operation identity and Agent-bound membership", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, recoveryBaseSql());
    sqlite(
      databasePath,
      `INSERT INTO recovery_discovered_operations VALUES ('operation-1', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("c")}', 'unknown', 'pending', 1);
       INSERT INTO recovery_operation_memberships VALUES ('attempt-r1', 'agent-1', 'operation-1', 4, '${digest("d")}');`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM recovery_discovered_operations",
      )[0].count,
      1,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_discovered_operations VALUES ('operation-2', 'database-1', 'source-1', 'sink-1', 'discovery-1', 'agent-1', '${digest("e")}', 'unknown', 'pending', 1)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_operation_memberships VALUES ('attempt-r1', 'agent-2', 'operation-1', 5, '${digest("e")}')`,
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO recovery_discovered_operations VALUES ('operation-2', 'database-1', 'source-1', 'sink-1', 'discovery-2', 'agent-2', '${digest("f")}', 'unknown', 'pending', 1);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO recovery_operation_memberships VALUES ('attempt-r1', 'agent-2', 'operation-2', 6, '${digest("1")}')`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
