import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const ownerUrl = new URL(
  "../../oracles/m0/external-harness-owner.json",
  import.meta.url,
);

test.scenarios(
  [
    "m0o.harness-attribution.case-82707c94512c91b5",
    "v2c.process-lifecycle.case-4d527d433a02b22e"
  ],
  "external Harness adapter and replacement platform never overlap outer owners", async () => {
  const manifest = JSON.parse(await readFile(ownerUrl, "utf8"));
  for (const mode of manifest.modes) {
    assert.notEqual(
      mode.hangarOuterLifecycleOwner,
      mode.externalOuterLifecycleOwner,
      mode.id,
    );
    assert.equal(mode.externalInnerProgressOwner, true);
    assert.equal(mode.privateStoreQualifiesAsPublicEvidence, false);
  }
  assert.equal(manifest.overlappingOuterOwners, "contract_failure");
  assert.equal(
    manifest.unknownOrCommittedEffectRetryByHarness,
    "contract_failure",
  );
  assert.equal(
    manifest.tenantSupervisorCleanupCountsAsHangarContainment,
    false,
  );
});
