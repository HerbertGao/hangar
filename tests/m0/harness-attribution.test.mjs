import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const attributionUrl = new URL(
  "../../oracles/m0/attribution.json",
  import.meta.url,
);

function evaluate(vector, maximum) {
  if (vector.manifestApplicableCases === 0) return "invalid_invocation";
  if (vector.boundaryViolations > 0) return "contract_failure";
  if (vector.executedResults !== vector.manifestApplicableCases)
    return "evidence_failure";
  return vector.opaqueApplicableCases / vector.manifestApplicableCases <=
    maximum
    ? "pass"
    : "evidence_failure";
}

function processSpecFollowUp(decisions, threshold) {
  const required = decisions.filter(
    ({ platformDependencyState, faultCaseRefs }) =>
      platformDependencyState === "required" && faultCaseRefs.length > 0,
  ).length;
  return {
    openOptionalChange: required >= threshold,
    currentContractChanged: false,
  };
}

test.scenarios(
  [
    "m0o.harness-attribution.case-3d55277177b31053",
    "m0o.harness-attribution.case-f8f2fc1cf9d58a01"
  ],
  "opaque attribution denominator is frozen, nonzero, complete, and unrounded", async () => {
  const manifest = JSON.parse(await readFile(attributionUrl, "utf8"));
  for (const vector of manifest.vectors) {
    assert.equal(
      evaluate(vector, manifest.rules.opaqueRateMaximum),
      vector.expected,
      vector.id,
    );
  }
  assert.equal(manifest.rules.rounding, false);
  assert.equal(manifest.rules.requiredCaseExclusion, false);
  assert.equal(manifest.rules.candidateExclusion, false);
  assert.equal(manifest.rules.missingResultRemovedFromDenominator, false);
});

test.scenarios(
  [
    "m0o.harness-attribution.case-dda21f95e7a50d7e"
  ],
  "two valid tenant decisions open only an optional ProcessSpec change", async () => {
  const manifest = JSON.parse(await readFile(attributionUrl, "utf8"));
  const decisions = structuredClone(manifest.tenantDecisions);
  for (const [index, tenantId] of ["inbox", "auto-developer"].entries())
    Object.assign(
      decisions.find((entry) => entry.tenantId === tenantId),
      {
        platformDependencyState: "required",
        faultCaseRefs: [`matching-pilot-${index + 1}`],
      },
    );
  assert.deepEqual(
    processSpecFollowUp(decisions, manifest.processSpecChangeThreshold),
    { openOptionalChange: true, currentContractChanged: false },
  );
});

test.scenarios(
  [
    "m0o.harness-attribution.case-81b89a62ef11202a"
  ],
  "every public attribution case requires all owner and evidence dimensions", async () => {
  const manifest = JSON.parse(await readFile(attributionUrl, "utf8"));
  for (const required of [
    "runAttempt",
    "action",
    "effectiveGrant",
    "actualRuntimeToolIdentity",
    "inputCheckpoint",
    "outputCheckpoint",
    "effectOutcome",
    "recoveryPoint",
    "outerRetryOwner",
    "innerRetryOwner",
    "terminalOwner",
    "containmentOwner",
  ]) {
    assert.ok(manifest.requiredDimensions.includes(required));
  }
  assert.ok(
    manifest.tenantDecisions.every(({ platformDependencyState }) =>
      manifest.platformDependencyStates.includes(platformDependencyState),
    ),
  );
  assert.ok(
    manifest.tenantDecisions.filter(
      ({ platformDependencyState }) => platformDependencyState === "required",
    ).length < manifest.processSpecChangeThreshold,
  );
});
