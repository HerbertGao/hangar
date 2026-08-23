import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const directUrl = new URL(
  "../../contracts/v2/control/direct-effects.json",
  import.meta.url,
);

function productionEligible(manifest, profile, exceptions) {
  return (
    !manifest.productionProfilesRequiringEmptyList.includes(profile) ||
    exceptions.length === 0
  );
}

test.scenarios(
  [
    "v2c.direct-effect.case-78b3454612fc61ab",
    "v2s.restore.case-57fad8805d2aa65d",
    "v2s.restore.case-baaf6879571987c3"
  ],
  "M0/M1 production and restore require an empty direct-effect list", async () => {
  const manifest = JSON.parse(await readFile(directUrl, "utf8"));
  assert.deepEqual(manifest.productionExceptions, []);
  for (const profile of ["m0", "m1"]) {
    assert.equal(productionEligible(manifest, profile, []), true);
    assert.equal(
      productionEligible(manifest, profile, [
        {
          inventoryRef: "inventory-1",
          sink: "sink-a",
          operation: "operation-a",
          authorizationCapability: "capability-a",
          justification: "legacy evidence only",
        },
      ]),
      false,
    );
  }
  assert.ok(manifest.forbiddenQualifications.includes("production-restore"));
});

test.scenarios(
  [
    "v2c.direct-effect.case-68bf1a8ab565a087",
    "v2c.direct-effect.case-f3d2fd539d793604"
  ],
  "direct exceptions require exact enforceable operation boundaries", async () => {
  const manifest = JSON.parse(await readFile(directUrl, "utf8"));
  assert.equal(manifest.enforcementLevel, "operation");
  assert.equal(manifest.unenforceableOperationBoundary, "reject");
  assert.equal(
    manifest.mutationCapableReadAuthorization,
    "treat-as-mutation-capable",
  );
  assert.equal(manifest.onboarding.afterCountMayExceedBefore, false);
  assert.ok(manifest.shadowRemoves.includes("mutation-capable-credential"));
});
