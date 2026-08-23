import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const schemaUrl = new URL("../../oracles/m0/schema.json", import.meta.url);
const casesUrl = new URL("../../oracles/m0/cases.json", import.meta.url);
const expectationsUrl = new URL(
  "../../oracles/m0/scenario-expectations.json",
  import.meta.url,
);
const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test.scenarios(
  ["m0o.format.case-c0e7bd6c39f2fd47"],
  "every oracle case has one stable owner scenario and one expected outcome",
  async () => {
    const [schema, manifest, expectations, aggregate] = await Promise.all([
      readFile(schemaUrl, "utf8").then(JSON.parse),
      readFile(casesUrl, "utf8").then(JSON.parse),
      readFile(expectationsUrl, "utf8").then(JSON.parse),
      readFile(gatesUrl, "utf8").then(JSON.parse),
    ]);
    assert.equal(manifest.cases.length, aggregate.frozenDenominator.scenarios);
    assert.equal(
      new Set(manifest.cases.map(({ caseId }) => caseId)).size,
      manifest.cases.length,
    );
    assert.equal(
      new Set(manifest.cases.map(({ scenarioId }) => scenarioId)).size,
      manifest.cases.length,
    );
    for (const oracleCase of manifest.cases) {
      assert.ok(
        schema.caseRequiredFields.every((field) => field in oracleCase),
      );
      assert.equal(oracleCase.expected.kind, "owner-scenario-outcome");
      assert.equal(oracleCase.expected.ownerScenarioId, oracleCase.scenarioId);
      assert.match(oracleCase.caseId, /^oracle-case-[0-9a-f]{16}$/);
    }
    assert.equal(
      manifest.caseUniverseDigest,
      sha256(JSON.stringify(manifest.cases)),
    );
    assert.equal(
      manifest.typedExpectationManifest,
      schema.typedExpectationManifests[0],
    );
    assert.equal(expectations.expectations.length, manifest.cases.length);
    assert.equal(
      expectations.expectationSetDigest,
      sha256(JSON.stringify(expectations.expectations)),
    );
    assert.equal(schema.candidateMaySetDisposition, false);
    assert.equal(schema.importCandidateInternals, false);
  },
);
