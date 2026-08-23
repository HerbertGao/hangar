import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { canonicalDigest } from "../../scripts/validate-m0.mjs";

const boundaryUrl = new URL(
  "../../contracts/v2/runtime/boundary.json",
  import.meta.url,
);
const coreUrl = new URL(
  "../../contracts/v2/control/core-objects.json",
  import.meta.url,
);

function grantMatches(grant, context, use) {
  return Boolean(
    use.actionId &&
      use.registeredActionIds.has(use.actionId) &&
      grant.releaseId === context.releaseId &&
      grant.activationEpoch === context.activationEpoch &&
      grant.runId === context.runId &&
      grant.attempt === context.attempt &&
      grant.harnessSessionId === context.harnessSessionId &&
      grant.purpose === context.purpose &&
      grant.operation === context.operation &&
      grant.audience === context.audience &&
      Number.isSafeInteger(use.nowUtcMs) &&
      grant.issuedAtUtcMs <= use.nowUtcMs &&
      use.nowUtcMs < grant.expiresAtUtcMs &&
      grant.revocationGeneration === use.currentRevocationGeneration &&
      use.requestCount <= grant.requestBudget &&
      use.byteCount <= grant.byteBudget &&
      use.requestCount >= 0 &&
      use.byteCount >= 0 &&
      use.effectiveGrantDigest === canonicalDigest(grant),
  );
}

function launchAllowed(manifest, launch) {
  const allowedEnvironment = new Set(manifest.launch.environmentAllowlist);
  const allowedDescriptors = new Set(manifest.launch.allowedDescriptors);
  return (
    launch.environmentKeys.every((key) => allowedEnvironment.has(key)) &&
    launch.descriptors.every((descriptor) =>
      allowedDescriptors.has(descriptor),
    ) &&
    launch.executableAbsolute &&
    launch.executableDigestMatchesClosure &&
    launch.controlPlaneReachable === false &&
    launch.containmentReady === true
  );
}

test.scenarios(
  [
    "v2c.runtime-boundary.case-04ff6b58f2fd0c86",
    "v2c.runtime-boundary.case-310c7b0081698071"
  ],
  "HarnessRequest rejects missing required and undeclared context fields", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  const schema = core.objectSchemas.find(({ id }) => id === "HarnessRequest");
  const allowed = new Set(schema.fields.map(({ id }) => id));
  const required = [
    "releaseId",
    "activationEpoch",
    "runId",
    "attempt",
    "harnessSessionId",
    "runtimeInput",
    "contextArtifacts",
    "budget",
    "deadlineUtcMs",
    "abortSignalId",
    "runtimeGrants",
  ];
  const valid = Object.fromEntries(required.map((field) => [field, field]));
  const validate = (request) => {
    if (
      Object.keys(request).some((field) => !allowed.has(field)) ||
      required.some((field) => !(field in request))
    )
      throw new Error("invalid_harness_request");
    return true;
  };
  assert.equal(validate(valid), true);
  for (const field of required) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => validate(missing), /invalid_harness_request/);
  }
  assert.throws(
    () => validate({ ...valid, undeclaredContext: "hidden" }),
    /invalid_harness_request/,
  );
});

test.scenarios(
  [
    "m0o.harness-attribution.case-0cc33223b9c43411",
    "v2c.runtime-boundary.case-0b1874f01659e11b",
    "v2c.runtime-boundary.case-fc1ae165227e0aad"
  ],
  "RuntimeGrant is action-attributed and bound to one RunAttempt context", async () => {
  const manifest = JSON.parse(await readFile(boundaryUrl, "utf8"));
  const context = {
    releaseId: "release-1",
    activationEpoch: 2,
    runId: "run-1",
    attempt: 1,
    harnessSessionId: "session-1",
    purpose: "artifact-read",
    operation: "read",
    audience: "tool-broker",
  };
  const grant = {
    ...context,
    issuedAtUtcMs: 1,
    expiresAtUtcMs: 100,
    revocationGeneration: 1,
    requestBudget: 3,
    byteBudget: 1024,
  };
  const use = {
    actionId: "action-1",
    registeredActionIds: new Set(["action-1"]),
    effectiveGrantDigest: canonicalDigest(grant),
    nowUtcMs: 50,
    currentRevocationGeneration: 1,
    requestCount: 1,
    byteCount: 512,
  };
  assert.equal(grantMatches(grant, context, use), true);
  for (const [candidateGrant, candidateUse] of [
    [grant, { ...use, actionId: "unregistered" }],
    [grant, { ...use, effectiveGrantDigest: "0".repeat(64) }],
    [grant, { ...use, nowUtcMs: 100 }],
    [grant, { ...use, currentRevocationGeneration: 2 }],
    [grant, { ...use, requestCount: 4 }],
    [grant, { ...use, byteCount: 1025 }],
    [{ ...grant, attempt: 2 }, use],
  ])
    assert.equal(grantMatches(candidateGrant, context, candidateUse), false);
  assert.deepEqual(manifest.grant.useValidation, [
    "issued-before-use",
    "not-expired",
    "revocation-generation-current",
    "action-registered-in-same-run",
    "effective-digest-matches",
    "request-budget-not-exceeded",
    "byte-budget-not-exceeded",
  ]);
});

test.scenarios(
  [
    "v2c.runtime-boundary.case-84add5e324213bbb",
    "v2c.runtime-boundary.case-f2679e28b8f6e5ea"
  ],
  "launch fails on environment, descriptor, closure, or control-plane escape", async () => {
  const manifest = JSON.parse(await readFile(boundaryUrl, "utf8"));
  const valid = {
    environmentKeys: ["LANG"],
    descriptors: ["stdin", "stdout", "stderr", "broker"],
    executableAbsolute: true,
    executableDigestMatchesClosure: true,
    controlPlaneReachable: false,
    containmentReady: true,
  };
  assert.equal(launchAllowed(manifest, valid), true);
  for (const patch of [
    { environmentKeys: ["LANG", "HOST_SECRET"] },
    { descriptors: ["stdin", "control-db-fd"] },
    { executableDigestMatchesClosure: false },
    { controlPlaneReachable: true },
    { containmentReady: false },
  ]) {
    assert.equal(launchAllowed(manifest, { ...valid, ...patch }), false);
  }
  assert.equal(manifest.launch.resolvedSecretsInEnvironment, false);
  assert.equal(manifest.launch.outsideServerProcess, true);
});

test.scenarios(
  [
    "v2c.runtime-boundary.case-0193a18bfd177d6f"
  ],
  "actual runtime identity is observed rather than copied from declaration", async () => {
  const manifest = JSON.parse(await readFile(boundaryUrl, "utf8"));
  for (const field of [
    "harnessExecutableDigest",
    "runtimeExecutableDigest",
    "adapterId",
    "runtimeId",
    "modelId",
    "containmentId",
    "executionClosureId",
    "launchAttestationId",
  ]) {
    assert.ok(manifest.actualIdentityFact.includes(field));
  }
});
