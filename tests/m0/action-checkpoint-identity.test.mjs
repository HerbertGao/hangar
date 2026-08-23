import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

function actionCheckpointSql() {
  return `
    INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
    INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'tool', NULL, '${digest("9")}', 'command-action', 3);
    INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'checkpoint-appended', 'v1', '{}', '${digest("a")}');
    INSERT INTO checkpoints VALUES ('run-1', 'checkpoint-1', '${digest("2")}', 0, 'action-1', 'resume-v1', 1, '{}', '${digest("e")}', 'human', 4);`;
}

test("action and checkpoint identities bind one exact producer", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(databasePath, actionCheckpointSql());
    assert.equal(
      query(databasePath, "SELECT producer_action_id FROM checkpoints")[0]
        .producer_action_id,
      "action-1",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'provider', NULL, '${digest("9")}', 'command-other', 3)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO checkpoints VALUES ('run-1', 'checkpoint-1', '${digest("2")}', 0, 'action-1', 'resume-v1', 1, '{}', '${digest("e")}', 'human', 4)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `BEGIN;
         INSERT INTO agent_releases VALUES ('${digest("8")}', 'agent-1', '{}', '${digest("9")}');
         INSERT INTO source_facts VALUES (5, 'database-1', '${digest("d")}', '${digest("f")}', 'checkpoint-appended', 'v1', '{}', '${digest("b")}');
         INSERT INTO checkpoints VALUES ('run-1', 'checkpoint-cross-release', '${digest("8")}', 0, 'action-1', 'resume-v1', 1, '{}', '${digest("e")}', 'human', 5);
         COMMIT;`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test.scenarios(
  [
    "v2s.ddl.case-16147bca7cebaa21"
  ],
  "checkpoint producer attempt must match the action origin", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'tool', NULL, '${digest("9")}', 'command-action', 3);
       INSERT INTO run_attempts VALUES ('run-1', 1, 'session-1', 'created', '${digest("a")}', 20000, NULL);
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'checkpoint-appended', 'v1', '{}', '${digest("b")}');`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO checkpoints VALUES ('run-1', 'checkpoint-wrong', '${digest("2")}', 1, 'action-1', 'resume-v1', 1, '{}', '${digest("e")}', 'human', 4)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
