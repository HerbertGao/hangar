import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2c.run-attempt.case-e76d5ba84942b386"
  ],
  "allocation CAS consumes only the exact quiescence generation and obligation digest", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'attempt-quiesced', 'v1', '{}', '${digest("8")}');
       INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, NULL);`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       UPDATE attempt_quiescence SET consumed_by_attempt=1
       WHERE run_id='run-1' AND attempt=0 AND quiescence_generation=1
         AND obligation_set_digest='${digest("f")}' AND consumed_by_attempt IS NULL;
       INSERT INTO run_attempts
       SELECT 'run-1', 1, 'session-1', 'created', '${digest("9")}', 20000, NULL WHERE changes() = 1;
       COMMIT;`,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM run_attempts")[0]
        .count,
      1,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT consumed_by_attempt FROM attempt_quiescence",
      )[0].consumed_by_attempt,
      null,
    );
  });
});

test("AttemptQuiesced fences late old-session action registration", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'attempt-quiesced', 'v1', '{}', '${digest("8")}');
       INSERT INTO attempt_quiescence VALUES ('run-1', 0, 1, 'session-0', 'containment-0', 1, 2, '${digest("a")}', 3, NULL);
       INSERT INTO actions
       SELECT 'run-1', 'late-action', 0, 'tool', NULL, '${digest("9")}', 'late-command', 3
       WHERE NOT EXISTS (SELECT 1 FROM attempt_quiescence WHERE run_id='run-1' AND attempt=0);`,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM actions")[0].count,
      0,
    );
  });
});
