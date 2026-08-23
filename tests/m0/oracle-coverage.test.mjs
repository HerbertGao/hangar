import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateClosedDimensionDefinitions } from "../../scripts/validate-m0.mjs";

const authorityUrl = new URL(
  "../../oracles/m0/authority-map.json",
  import.meta.url,
);
const casesUrl = new URL("../../oracles/m0/cases.json", import.meta.url);
const matrixUrl = new URL(
  "../../oracles/m0/fault-matrix.json",
  import.meta.url,
);
const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);

test("every normative scenario has exactly one required-class case", async () => {
  const [authority, manifest, matrix, aggregate] = await Promise.all([
    readFile(authorityUrl, "utf8").then(JSON.parse),
    readFile(casesUrl, "utf8").then(JSON.parse),
    readFile(matrixUrl, "utf8").then(JSON.parse),
    readFile(gatesUrl, "utf8").then(JSON.parse),
  ]);
  const expected = new Map(
    authority.requirements.flatMap(({ scenarios }) =>
      scenarios.map(({ scenarioId, coverageClass }) => [
        scenarioId,
        coverageClass,
      ]),
    ),
  );
  const counts = new Map();
  for (const oracleCase of manifest.cases) {
    counts.set(
      oracleCase.scenarioId,
      (counts.get(oracleCase.scenarioId) ?? 0) + 1,
    );
    assert.equal(oracleCase.coverageClass, expected.get(oracleCase.scenarioId));
  }
  assert.equal(counts.size, expected.size);
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.deepEqual(
    new Set(manifest.cases.map(({ coverageClass }) => coverageClass)),
    new Set(authority.coverageClasses),
  );
  const denominator = aggregate.frozenDenominator;
  assert.equal(authority.requirements.length, denominator.requirements);
  assert.equal(expected.size, denominator.scenarios);
  assert.deepEqual(
    manifest.cases.reduce((distribution, { coverageClass }) => {
      distribution[coverageClass] = (distribution[coverageClass] ?? 0) + 1;
      return distribution;
    }, {}),
    {
      "evaluator-self-test": 28,
      "named-process-host": 27,
      "named-tenant": 3,
      "neutral-control-storage": 186,
    },
  );
  const dimensionMembers = matrix.closedDimensions.reduce(
    (total, { values }) => total + values.length,
    0,
  );
  assert.equal(dimensionMembers, denominator.closedDimensionMembers);
  assert.equal(matrix.recoveryRaceCells.length, denominator.recoveryRaceCells);
  assert.equal(
    expected.size + dimensionMembers + matrix.recoveryRaceCells.length,
    denominator.scenarioDimensionRaceMembers,
  );
  assert.equal(aggregate.gates.length, denominator.aggregateGates);
  assert.equal(
    aggregate.gates.filter(({ type }) => type.endsWith("-definition")).length,
    denominator.definitionGates,
  );
  const wrongOwner = structuredClone(matrix);
  wrongOwner.closedDimensions[0].ownerRequirementId = "m0o.format";
  assert.ok(
    evaluateClosedDimensionDefinitions(authority, wrongOwner).findings.length >
      0,
  );
});
