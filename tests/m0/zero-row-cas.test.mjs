import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { query, seedRunSql, sqlite, withDatabase } from "./sqlite-helper.mjs";

const transactionsUrl = new URL(
  "../../contracts/v2/storage/transactions.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.transactions.case-9c51032e4d4038e1"
  ],
  "every fenced CAS maps zero rows to non-success typed outcomes", async () => {
  const manifest = JSON.parse(await readFile(transactionsUrl, "utf8"));
  assert.equal(manifest.zeroRowMaySucceed, false);
  assert.ok(
    manifest.fencedCas.every(
      ({ zeroRowKinds }) =>
        zeroRowKinds.length > 0 && !zeroRowKinds.includes("pass"),
    ),
  );
});

test("zero-row activation CAS performs no downstream mutation", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    const rows = query(
      databasePath,
      `UPDATE activations SET state='draining' WHERE activation_id='activation-1' AND epoch=99;
       SELECT changes() AS changed;`,
    );
    assert.equal(rows[0].changed, 0);
    assert.equal(
      query(databasePath, "SELECT state FROM activations")[0].state,
      "active",
    );
  });
});
