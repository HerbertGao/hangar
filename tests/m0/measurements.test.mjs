import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { validateMeasurementLedger } from "../../scripts/validate-m0.mjs";

const manifestUrl = new URL(
  "../../measurements/manifest.json",
  import.meta.url,
);
const ledgerUrl = new URL("../../measurements/ledger.json", import.meta.url);
const evidenceUrl = new URL(
  "../../measurements/evidence.json",
  import.meta.url,
);

function completeEnablementEvidence(impact) {
  return (
    Number.isFinite(impact?.agentSpecificPersonMs) &&
    Number.isSafeInteger(impact?.candidateSpecificGlueLoc) &&
    impact.agentSpecificPersonMs >= 0 &&
    impact.candidateSpecificGlueLoc >= 0
  );
}

test("measurement definitions cover time, cost, code, resources, and TCO", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.deepEqual(
    manifest.metrics.map(({ id }) => id),
    [
      "T_attempt",
      "T_ready",
      "C_platform",
      "C_enable",
      "glue_LOC",
      "cold_start",
      "idle_RSS",
      "peak_RSS",
      "disk",
      "process_count",
      "TCO_12_month",
    ],
  );
  assert.ok(manifest.recordRequiredFields.includes("environmentId"));
  assert.ok(manifest.recordRequiredFields.includes("rawEvidenceRef"));
  assert.equal(manifest.correctionPolicy, "append-superseding-record");
  assert.equal(manifest.overwriteAllowed, false);
});

test.scenarios(
  ["m0o.measurements.case-5b501ace1dff7b23"],
  "C_enable evidence includes candidate-specific setup and glue",
  async () => {
    const [ledger, evidence] = await Promise.all([
      readFile(ledgerUrl, "utf8").then(JSON.parse),
      readFile(evidenceUrl, "utf8").then(JSON.parse),
    ]);
    const latest = ledger.records
      .filter(({ metricId }) => metricId === "C_enable")
      .at(-1);
    const impact = evidence.sources.m0AdvisoryHandoff.impact;
    assert.equal(
      latest.rawEvidenceRef,
      "measurements/evidence.json#/sources/m0AdvisoryHandoff/impact",
    );
    assert.equal(completeEnablementEvidence(impact), true);
    const incomplete = structuredClone(impact);
    delete incomplete.candidateSpecificGlueLoc;
    assert.equal(completeEnablementEvidence(incomplete), false);
  },
);

test("measurement ledger records every M0 metric with durable raw evidence", async () => {
  const [manifest, ledger, evidence] = await Promise.all([
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(ledgerUrl, "utf8").then(JSON.parse),
    readFile(evidenceUrl, "utf8").then(JSON.parse),
  ]);
  assert.equal(manifest.evidenceManifest, "measurements/evidence.json");
  assert.equal(evidence.environment.productionEligible, false);
  assert.deepEqual(
    validateMeasurementLedger(manifest, ledger, evidence).findings,
    [],
  );
  const branch = structuredClone(ledger);
  const latest = branch.records.at(-1);
  branch.records.push({
    ...latest,
    recordId: `${latest.recordId}-branch`,
    recordedAtUtcMs: latest.recordedAtUtcMs + 1,
  });
  assert.ok(
    validateMeasurementLedger(manifest, branch, evidence).findings.length > 0,
  );
  const crossMetric = structuredClone(ledger);
  const crossLatest = crossMetric.records.at(-1);
  crossMetric.records.push({
    ...crossLatest,
    recordId: `${crossLatest.recordId}-cross-metric`,
    metricId: "T_attempt",
    supersedesRecordId: crossLatest.recordId,
    recordedAtUtcMs: crossLatest.recordedAtUtcMs + 1,
  });
  assert.ok(
    validateMeasurementLedger(manifest, crossMetric, evidence).findings.length >
      0,
  );
  assert.equal(
    new Set(ledger.records.map(({ recordId }) => recordId)).size,
    ledger.records.length,
  );
  assert.deepEqual(
    new Set(ledger.records.map(({ metricId }) => metricId)),
    new Set(manifest.metrics.map(({ id }) => id)),
  );
  const seen = new Set();
  for (const record of ledger.records) {
    assert.ok(
      manifest.recordRequiredFields.every((field) => field in record),
      record.recordId,
    );
    assert.match(record.rawEvidenceRef, /^measurements\/evidence\.json#\//);
    if (record.supersedesRecordId !== null)
      assert.ok(seen.has(record.supersedesRecordId));
    seen.add(record.recordId);
  }
  assert.equal(
    ledger.records.find(({ metricId }) => metricId === "T_attempt").value,
    evidence.sources.sessionWindow.durationMs,
  );
  assert.equal(
    ledger.records.find(({ metricId }) => metricId === "peak_RSS").value,
    evidence.sources.prerequisiteProbe.maximumResidentSetBytes,
  );

  const historical = evidence.sources.e1ParentDirectGateClosure;
  const bundle = evidence.sources.m0DefinitionBundle;
  const advisory = evidence.sources.m0AdvisoryHandoff;
  assert.equal(historical.authorityStatus, "superseded-historical-only");
  assert.equal(historical.runtimeConsumed, false);
  assert.equal(bundle.authorityStatus, "superseded-by-m0-advisory");
  assert.equal(advisory.authorityStatus, "active-non-authorizing-advisory");
  assert.equal(advisory.m1AuthorizationGranted, true);
  assert.equal(advisory.m1ImplementationAuthorizationEffective, true);
  assert.equal(advisory.authorizationCondition, "entry-review-pass-satisfied");
  assert.equal(advisory.entryStatus, "passed");
  assert.equal(advisory.candidateQualification, false);
  assert.equal(advisory.token, "M0 advisory: READY");
  assert.equal(advisory.tokenMeaning, "diagnostics-readable-only");
  assert.equal(advisory.tokenConsumers, 0);
  assert.equal(advisory.historicalPassTokensValid, false);
  assert.equal(advisory.knownGaps.length, 6);
  assert.equal(
    advisory.knownGaps.find(({ id }) => id === "M1-ENTRY-001").disposition,
    "implementation-authorized-not-started",
  );
  assert.deepEqual(advisory.entryReview, {
    round: "R5",
    codeReviewer: {
      agentId: "779b840e-33f4-42e",
      verdict: "APPROVE",
      blockerOrMajor: 0,
      minor: 1,
      minorDisposition: "fixed",
    },
    realityChecker: {
      agentId: "c858d619-423b-4ef",
      verdict: "APPROVE",
      blockerOrMajor: 0,
    },
    productPathsCreated: 0,
    entryIsConformance: false,
  });
  assert.ok(
    advisory.knownGaps.every(
      ({ dispositionOwner, approvalRef }) =>
        typeof dispositionOwner === "string" &&
        dispositionOwner.length > 0 &&
        approvalRef in advisory.approvalRegister,
    ),
  );
  assert.deepEqual(advisory.approvalRegister, {
    "USER-ADVISORY-ENTRY-2026-08-22": {
      owner: "Product Decision Owner",
      scope: "entry-artifacts",
    },
    "SOT-HOST-LOCAL-ONLY": {
      owner: "Host Qualification Owner",
      scope: "disposable-local-evidence-only",
      productionQualification: false,
    },
    "USER-M1-AUTH-2026-08-22": {
      owner: "Product Decision Owner",
      scope: "post-entry-m1-heartbeat",
      cleanupAuthorized: ["D1", "D2", "D3"],
      entryPassRequired: true,
      m1ImplementationAuthorizationGranted: true,
    },
  });
  assert.equal(
    advisory.cleanup.frozenDenominatorOwner,
    "oracles/m0/aggregate-gates.json#/frozenDenominator",
  );
  assert.equal(advisory.cleanup.restoresM0Authority, false);
  assert.deepEqual(advisory.ownerMatrix, {
    responsibilities: 7,
    duplicateOwners: 0,
    unassignedOwners: 0,
  });
  assert.deepEqual(advisory.budget, {
    activeDeveloperDayPersonHours: 8,
    m0WallClockUpperBoundMs: 148290920,
    m0ActiveDeveloperDaysUpperBound: 6,
    entryMaximumDays: 1,
    m1MaximumRemainingDays: 8,
    day3ObservationCheckpoint: true,
    day15AbstractionCutTrigger: true,
  });
  assert.deepEqual(advisory.advisoryAcceptance, {
    fullSuiteTests: 225,
    fullSuitePassed: 225,
    aggregateExitStatus: 0,
    aggregateStdoutBytes: 19,
    aggregateStderrBytes: 0,
    aggregateStdoutSha256:
      "a953782bfb7cd4b3c11d4ba0328128f4c8bc8a7d1e02779d3322aa042ade585b",
    candidateExecutions: 0,
    supersededBy: "cleanupAcceptance",
  });
  assert.equal(advisory.activeAcceptance, "cleanupAcceptance");
  assert.deepEqual(advisory.cleanupAcceptance, {
    fullSuiteTests: 226,
    fullSuitePassed: 226,
    aggregateExitStatus: 0,
    aggregateStdoutBytes: 19,
    aggregateStderrBytes: 0,
    aggregateStdoutSha256:
      "a953782bfb7cd4b3c11d4ba0328128f4c8bc8a7d1e02779d3322aa042ade585b",
    candidateExecutions: 0,
  });
  assert.deepEqual(advisory.cleanup.removed, {
    jsonLines: 9644,
    validatorLines: 64,
    sha256Literals: 2691,
    testPathLiterals: 488,
    assertionDetailLines: 7770,
  });
  assert.equal(advisory.cleanup.openSpecBoundary, "external-process-only");
  assert.equal(advisory.cleanup.productPathsCreated, 0);
  const performance = advisory.aggregatePerformance;
  assert.equal(performance.runs.length, 3);
  assert.ok(
    performance.runs.every(
      ({ exitStatus, stdoutBytes, applicationStderrBytes }) =>
        exitStatus === 0 && stdoutBytes === 19 && applicationStderrBytes === 0,
    ),
  );
  assert.equal(
    performance.p95ElapsedMs,
    Math.max(...performance.runs.map(({ elapsedMs }) => elapsedMs)),
  );
  assert.ok(performance.p95ElapsedMs < performance.stopLossMs);
  assert.equal(performance.stopLossExceeded, false);
  assert.equal(advisory.impact.dependenciesAdded, 0);
  assert.equal(advisory.impact.daemonsAdded, 0);
  assert.equal(advisory.impact.productPackagesAdded, 0);
  const historicalTcoParents = new Set([
    "m0-e1-q3-final-tco-12-month-20260821",
    "m0-e1-q3-r3-tco-12-month-20260821",
    "m0-e1-composite-tco-12-month-20260821",
    "m0-definition-bundle-tco-12-month-20260821",
    "m0-definition-bundle-r2-tco-12-month-20260821",
    "m0-definition-bundle-r3-tco-12-month-20260821",
  ]);
  assert.ok(
    ledger.records.some(
      ({ metricId, supersedesRecordId }) =>
        metricId === "TCO_12_month" &&
        historicalTcoParents.has(supersedesRecordId),
    ),
  );
});
