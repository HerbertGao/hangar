import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  canonicalDigest,
  checkSourceFacts,
} from "../../scripts/validate-m0.mjs";
import { digest, sqlite, withDatabase } from "./sqlite-helper.mjs";

const sourceFactsUrl = new URL(
  "../../contracts/v2/storage/source-facts.json",
  import.meta.url,
);

function hashFact(fact) {
  return canonicalDigest([
    "source-fact-v1",
    fact.databaseIdentity,
    fact.factSeq,
    fact.previousFactHash,
    fact.factKind,
    fact.schemaVersion,
    fact.payload,
  ]);
}

test("SourceFact union matches DDL and excludes raw ActivationPermit", async () => {
  const manifest = JSON.parse(await readFile(sourceFactsUrl, "utf8"));
  assert.equal(new Set(manifest.factKinds).size, manifest.factKinds.length);
  assert.ok(manifest.factKinds.includes("attempt-quiesced"));
  assert.ok(manifest.factKinds.includes("recovery-agent-binding-conflict"));
  assert.ok(manifest.factKinds.includes("target-authority-closed"));
  assert.equal(manifest.rawActivationPermitPersisted, false);
  assert.equal((await checkSourceFacts()).kind, "pass");
});

test("fact hash binds database identity, sequence, predecessor, kind, version, and payload", async () => {
  const manifest = JSON.parse(await readFile(sourceFactsUrl, "utf8"));
  const first = {
    databaseIdentity: "database-1",
    factSeq: 1,
    previousFactHash: manifest.hash.genesisPreviousHash,
    factKind: "database-genesis",
    schemaVersion: "v1",
    payload: { controlInstanceId: "instance-1" },
  };
  const firstHash = hashFact(first);
  const second = {
    databaseIdentity: "database-1",
    factSeq: 2,
    previousFactHash: firstHash,
    factKind: "time-observed",
    schemaVersion: "v1",
    payload: { generation: 1 },
  };
  assert.notEqual(
    hashFact(second),
    hashFact({ ...second, payload: { generation: 2 } }),
  );
  assert.notEqual(
    hashFact(second),
    hashFact({ ...second, previousFactHash: digest("f") }),
  );
});

test.scenarios(
  [
    "v2s.source-facts.case-6005b5c8c5c674d9"
  ],
  "DDL rejects unknown fact kinds", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      "INSERT INTO storage_identity VALUES (1, 'database-1', NULL, 'enabled')",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO source_facts VALUES (1, 'database-1', '${digest("0")}', '${digest("a")}', 'future-fact', 'v1', '{}', '${digest("1")}')`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
