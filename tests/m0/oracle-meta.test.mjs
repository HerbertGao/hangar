import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { evaluateOracleCases } from "../../scripts/validate-m0.mjs";

const load = (path) =>
  readFile(new URL(`../../oracles/m0/${path}`, import.meta.url), "utf8").then(
    JSON.parse,
  );
const validatorUrl = new URL("../../scripts/validate-m0.mjs", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function artifacts() {
  return Promise.all([
    load("authority-map.json"),
    load("cases.json"),
    load("evaluator-registry.json"),
    load("scenario-expectations.json"),
  ]);
}

test("all scenario definitions compile typed expectations from normative WHEN/THEN", async () => {
  const [authority, cases, registry, expectations] = await artifacts();
  const evaluation = await evaluateOracleCases(
    authority,
    cases,
    registry,
    expectations,
  );
  assert.deepEqual(evaluation.findings, []);
  const { frozenDenominator } = await load("aggregate-gates.json");
  assert.equal(
    [...evaluation.results.keys()].filter((key) => key.startsWith("scenario:"))
      .length,
    frozenDenominator.scenarios,
  );
  assert.ok(
    [...evaluation.results.values()].every(
      ({ basis, definitionStatus, kind }) =>
        basis === "definition" &&
        definitionStatus === "definition-valid" &&
        kind === "pass",
    ),
  );
});

test("unresolved fixtures and recomputed-but-wrong typed expectations fail", async () => {
  const [authority, cases, registry, expectations] = await artifacts();
  const unresolved = structuredClone(cases);
  unresolved.cases[0].inputFixtureId = "missing-fixture-v1";
  assert.notEqual(
    (
      await evaluateOracleCases(authority, unresolved, registry, expectations)
    ).results.get(`scenario:${unresolved.cases[0].scenarioId}`).kind,
    "pass",
  );

  const supplied = structuredClone(cases);
  supplied.cases[0].candidateObservation = { kind: "pass" };
  supplied.caseUniverseDigest = sha256(JSON.stringify(supplied.cases));
  assert.notEqual(
    (
      await evaluateOracleCases(authority, supplied, registry, expectations)
    ).results.get(`scenario:${supplied.cases[0].scenarioId}`).kind,
    "pass",
  );

  const registryMutation = structuredClone(registry);
  registryMutation.fixturePassIsCandidateEvidence = true;
  registryMutation.candidateExecutionOwner = "m0";
  assert.ok(
    (
      await evaluateOracleCases(
        authority,
        cases,
        registryMutation,
        expectations,
      )
    ).findings.length > 0,
  );

  const excludable = structuredClone(cases);
  const neutral = excludable.cases.find(
    ({ coverageClass }) => coverageClass === "neutral-control-storage",
  );
  Object.assign(neutral, {
    inputFixtureId: "inbox-tenant-fixture-v1",
    observationSchemaId: "tenant-public-observation-v1",
    applicabilityPredicateId: "selected-tenant-v1",
    qualificationProfiles: ["inbox"],
    exclusionCodes: ["tenant-not-selected"],
  });
  excludable.caseUniverseDigest = sha256(JSON.stringify(excludable.cases));
  assert.notEqual(
    (
      await evaluateOracleCases(authority, excludable, registry, expectations)
    ).results.get(`scenario:${neutral.scenarioId}`).kind,
    "pass",
  );

  const duplicateAuthority = structuredClone(authority);
  duplicateAuthority.requirements[0].requirementId =
    duplicateAuthority.requirements[1].requirementId;
  assert.ok(
    (
      await evaluateOracleCases(
        duplicateAuthority,
        cases,
        registry,
        expectations,
      )
    ).findings.length > 0,
  );

  const wrong = structuredClone(expectations);
  wrong.expectations[0].observation.outcomeClass = "not-a-closed-outcome";
  wrong.expectationSetDigest = sha256(JSON.stringify(wrong.expectations));
  assert.notEqual(
    (await evaluateOracleCases(authority, cases, registry, wrong)).results.get(
      `scenario:${wrong.expectations[0].scenarioId}`,
    ).kind,
    "pass",
  );
});

test("owner scenario refs remain one-to-one with typed expectations", async () => {
  const [, cases, , expectations] = await artifacts();
  assert.equal(
    cases.typedExpectationManifest,
    "oracles/m0/scenario-expectations.json",
  );
  assert.equal(expectations.expectations.length, cases.cases.length);
  for (const oracleCase of cases.cases) {
    assert.deepEqual(Object.keys(oracleCase.expected).sort(), [
      "kind",
      "ownerScenarioId",
    ]);
    assert.equal(oracleCase.expected.ownerScenarioId, oracleCase.scenarioId);
  }
});

test.scenarios(
  ["m0o.format.case-5be25c06932ee3c1"],
  "two candidates consume the same frozen scenario expectation",
  async () => {
    const [authority, cases, registry, expectations] = await artifacts();
    const scenarioId = "m0o.format.case-5be25c06932ee3c1";
    const outputs = await Promise.all(
      ["candidate-a", "candidate-b"].map(() =>
        evaluateOracleCases(authority, cases, registry, expectations),
      ),
    );
    assert.deepEqual(
      outputs[0].results.get(`scenario:${scenarioId}`),
      outputs[1].results.get(`scenario:${scenarioId}`),
    );
    assert.equal(
      expectations.expectations.filter(
        (entry) => entry.scenarioId === scenarioId,
      ).length,
      1,
    );
  },
);

test("oracle validator imports no candidate or retired M0 authority", async () => {
  const source = await readFile(validatorUrl, "utf8");
  const imports = [
    ...source.matchAll(/(?:from\s+|import\()["']([^"']+)["']/gu),
  ].map((match) => match[1]);
  for (const forbidden of [
    "packages/control",
    "packages/core",
    "../inbox-pilot",
    "../auto-developer",
    "candidate/constants",
    "scenario-gates",
    "fixture-runner",
    "fixture-plan",
  ])
    assert.ok(
      imports.every((specifier) => !specifier.includes(forbidden)),
      forbidden,
    );
  assert.equal(source.includes("evaluateCandidateAdapters"), false);
});
