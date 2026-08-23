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
    "v2s.transactions.case-e9834734c4ea005b"
  ],
  "checkpoint, obligations, fact, and projection are all-or-none", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'tool', NULL, '${digest("9")}', 'command-1', 3);`,
    );
    const failed = sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'checkpoint-appended', 'v1', '{}', '${digest("a")}');
       INSERT INTO checkpoints VALUES ('run-1', 'checkpoint-1', '${digest("2")}', 0, 'action-1', 'resume-v1', 1, '{}', '${digest("e")}', 'effect', 4);
       INSERT INTO checkpoint_obligations VALUES ('run-1', 'checkpoint-1', 'effect', 'effect-missing', 0, 'effect-gateway', 1, NULL, NULL);
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM checkpoints")[0].count,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT max(fact_seq) AS seq FROM source_facts")[0]
        .seq,
      3,
    );
  });
});
