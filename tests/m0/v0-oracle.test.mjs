import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const oracleUrl = new URL("../../oracles/m0/v0-oracle.json", import.meta.url);
const ledgerUrl = new URL("../../oracles/m0/v0-ledger.json", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test.scenarios(
  [
    "m0o.v0-reaper.case-ea8aa672669d0564"
  ],
  "v0 oracle contains every preserved and known-false decision, never excluded details", async () => {
  const [oracle, ledger] = await Promise.all([
    readFile(oracleUrl, "utf8").then(JSON.parse),
    readFile(ledgerUrl, "utf8").then(JSON.parse),
  ]);
  const expected = ledger.decisions.filter(
    ({ disposition }) => disposition !== "excluded",
  );
  assert.equal(oracle.cases.length, expected.length);
  assert.deepEqual(
    new Set(oracle.cases.map(({ decisionId }) => decisionId)),
    new Set(expected.map(({ decisionId }) => decisionId)),
  );
  assert.equal(oracle.ledgerDigest, ledger.decisionDigest);
  assert.equal(oracle.caseDigest, sha256(JSON.stringify(oracle.cases)));
  assert.ok(
    oracle.cases
      .filter(({ expected: result }) => result.kind === "known-false-green")
      .every(
        ({ expected: result }) =>
          result.qualification === "must-fail-until-fixed",
      ),
  );
});
