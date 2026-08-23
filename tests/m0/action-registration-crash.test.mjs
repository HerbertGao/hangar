import assert from "node:assert/strict";
import test from "node:test";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test("action row and registration SourceFact cannot split on crash", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    const failed = sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 99, 'tool', NULL, '${digest("9")}', 'command-1', 3);
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM actions")[0].count,
      0,
    );
    assert.equal(
      query(databasePath, "SELECT max(fact_seq) AS seq FROM source_facts")[0]
        .seq,
      2,
    );

    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'tool', NULL, '${digest("9")}', 'command-1', 3);
       COMMIT;`,
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM actions")[0].count,
      1,
    );
  });
});
