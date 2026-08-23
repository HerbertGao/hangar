import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import { digest, query, sqlite, withDatabase } from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.ddl.case-633a4e32de7df4be"
  ],
  "schedule series and occurrence identity survive release/epoch changes", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      `INSERT INTO agents VALUES ('agent-1');
       INSERT INTO agent_releases VALUES ('${digest("1")}', 'agent-1', '{}', '${digest("2")}');
       INSERT INTO agent_releases VALUES ('${digest("3")}', 'agent-1', '{}', '${digest("4")}');
       INSERT INTO schedule_series VALUES ('agent-1', 'series-stable', '${digest("5")}');
       INSERT INTO release_schedule_series VALUES ('${digest("1")}', 'agent-1', 'series-stable');
       INSERT INTO release_schedule_series VALUES ('${digest("3")}', 'agent-1', 'series-stable');
       INSERT INTO schedule_occurrences VALUES ('agent-1', 'series-stable', 1000);`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM release_schedule_series",
      )[0].count,
      2,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "INSERT INTO schedule_occurrences VALUES ('agent-1', 'series-stable', 1000)",
        { allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE '%cursor%'",
      )[0].count,
      0,
    );
  });
});

test("M0/M1 Run storage rejects scheduled admission", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      `INSERT INTO agents VALUES ('agent-1');
       INSERT INTO agent_releases VALUES ('${digest("1")}', 'agent-1', '{}', '${digest("2")}');
       INSERT INTO activations VALUES ('activation-1', 'agent-1', '${digest("1")}', 1, 'active', 1);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO runs VALUES ('run-scheduled', 'agent-1', '${digest("1")}', 'activation-1', 1, 'scheduled', 'schedule-1', '${digest("3")}', '${digest("4")}', '${digest("5")}')`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
