import assert from "node:assert/strict";
import test from "node:test";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test("Run identity must match the selected Activation release and epoch", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO agent_releases VALUES ('${digest("8")}', 'agent-1', '{}', '${digest("9")}');`,
    );
    for (const statement of [
      `INSERT INTO runs VALUES ('run-wrong-release', 'agent-1', '${digest("8")}', 'activation-1', 1, 'manual', 'manual-2', '${digest("a")}', '${digest("b")}', '${digest("c")}')`,
      `INSERT INTO runs VALUES ('run-wrong-epoch', 'agent-1', '${digest("2")}', 'activation-1', 99, 'manual', 'manual-3', '${digest("a")}', '${digest("b")}', '${digest("c")}')`,
    ]) {
      assert.notEqual(
        sqlite(databasePath, statement, { allowFailure: true }).status,
        0,
      );
    }
  });
});

test("RunAttempt, HarnessSession, and quiescence identities are unique", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO run_attempts VALUES ('run-1', 0, 'session-other', 'created', '${digest("7")}', 10000, NULL)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO run_attempts VALUES ('run-1', 1, 'session-0', 'created', '${digest("7")}', 10000, NULL)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO run_attempts VALUES ('run-1', 1, 'session-1', 'created', '${digest("7")}', 10000, 'checkpoint-missing')`,
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'attempt-quiesced', 'v1', '{}', '${digest("8")}');
       INSERT INTO run_attempts VALUES ('run-1', 1, 'session-1', 'created', '${digest("9")}', 20000, NULL);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'wrong-session', 'containment-0', 1, 2, '${digest("a")}', 3, 1)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, 0)`,
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, 1);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, NULL)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM run_attempts")[0]
        .count,
      2,
    );
  });
});

test("one next attempt cannot consume two quiescence facts", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'attempt-quiesced', 'v1', '{}', '${digest("8")}');
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'attempt-quiesced', 'v1', '{}', '${digest("9")}');
       INSERT INTO run_attempts VALUES ('run-1', 1, 'session-1', 'created', '${digest("e")}', 20000, NULL);
       INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, 1);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO attempt_quiescence VALUES ('run-1', 0, 2, 'session-0', 'containment-0', 1, 3, '${digest("f")}', 4, 1)`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
