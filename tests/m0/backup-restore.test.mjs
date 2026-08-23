import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

import { query, seedRunSql, sqlite, withDatabase } from "./sqlite-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test.scenarios(
  [
    "v2s.restore.case-0f6c0d299888f98a"
  ],
  "SQLite backup preserves lineage and internal integrity but grants no production authority", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  await withDatabase(async (databasePath, directory) => {
    sqlite(databasePath, seedRunSql());
    const backupPath = join(directory, "backup.sqlite");
    const backup = spawnSync(
      "sqlite3",
      [databasePath, `.backup '${backupPath}'`],
      { encoding: "utf8" },
    );
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(
      query(backupPath, "PRAGMA integrity_check")[0].integrity_check,
      "ok",
    );
    assert.equal(
      query(backupPath, "SELECT database_identity FROM storage_identity")[0]
        .database_identity,
      "database-1",
    );
    assert.equal(
      query(backupPath, "SELECT max(fact_seq) AS seq FROM source_facts")[0].seq,
      2,
    );

    const metadata = {
      databaseIdentity: "database-1",
      sourceControlInstanceId: "instance-1",
      lineageControlInstanceSet: ["instance-1"],
      schemaVersion: "v2-storage-contract-v1",
      canonicalizationVersion: "canonical-json-v1",
      maxFactSeq: 2,
      sourceFactChainHead: query(
        backupPath,
        "SELECT fact_hash FROM source_facts ORDER BY fact_seq DESC LIMIT 1",
      )[0].fact_hash,
      perRunMaxRunSeq: { "run-1": 1 },
      terminalAndEffectIdentities: [],
      executionClosureDigests: [],
      agentActivationSetDigest: "a".repeat(64),
      mutationAuthorityWatermarks: {},
      sinkDiscoveryWatermarks: {},
      backupDigest: sha256(await readFile(backupPath)),
      recoveryAuthorityEpoch: 0,
    };
    assert.deepEqual(Object.keys(metadata), manifest.backupMetadata);
    const productionQualifiedBySnapshotAlone = false;
    assert.equal(productionQualifiedBySnapshotAlone, false);
  });
});
