import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

import { seedRunSql, sqlite, withDatabase } from "./sqlite-helper.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function snapshot(directory) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await stat(path, { bigint: true });
    output.push({
      name,
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      digest: sha256(await readFile(path)),
    });
  }
  return output;
}

test.scenarios(
  [
    "v2s.read-only.case-0225d0fcb67a7e0c",
    "v2s.sqlite.case-172434e8f69c8fde"
  ],
  "read-only validation creates no WAL, SHM, journal, database, or sidecar", async () => {
  await withDatabase(async (databasePath, directory) => {
    sqlite(databasePath, seedRunSql());
    const before = await snapshot(directory);
    const result = spawnSync(
      "sqlite3",
      [
        "-readonly",
        databasePath,
        "PRAGMA query_only=ON; PRAGMA integrity_check; SELECT count(*) FROM source_facts;",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await snapshot(directory), before);
    assert.ok(
      !(await readdir(directory)).some((name) =>
        /-(?:wal|shm|journal)$/.test(name),
      ),
    );

    const missing = join(directory, "missing.sqlite");
    assert.notEqual(
      spawnSync("sqlite3", ["-readonly", missing, "SELECT 1"], {
        encoding: "utf8",
      }).status,
      0,
    );
    await assert.rejects(access(missing));
  });
});
