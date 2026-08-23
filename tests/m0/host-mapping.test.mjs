import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const hostUrl = new URL("../../oracles/m0/host-mapping.json", import.meta.url);

test.scenarios(
  [
    "m0o.host-mapping.case-2c26189c0114871c",
    "v2c.host-attestation.case-5c3db26dc9e6b746"
  ],
  "every target host maps every closed mode without inheriting evidence", async () => {
  const manifest = JSON.parse(await readFile(hostUrl, "utf8"));
  for (const host of manifest.hosts) {
    assert.deepEqual(
      host.modeEvidence.map(({ mode }) => mode),
      manifest.modes,
      host.hostId,
    );
    for (const evidence of host.modeEvidence) {
      assert.ok(
        ["verified", "unverified-claim", "unsupported"].includes(
          evidence.status,
        ),
      );
      if (evidence.status === "verified")
        assert.deepEqual(evidence.controls, manifest.controls);
    }
  }
});

test.scenarios(
  [
    "m0o.host-mapping.case-f671b474c14eb9e3",
    "v2c.host-attestation.case-98272db6decc78fe"
  ],
  "local Darwin host remains mutation-disabled until positive containment proof", async () => {
  const manifest = JSON.parse(await readFile(hostUrl, "utf8"));
  const local = manifest.hosts.find(
    ({ hostId }) => hostId === "local-darwin-arm64",
  );
  assert.equal(process.platform, local.platform);
  assert.equal(process.arch, local.architecture);
  assert.equal(local.productionEligible, false);
  assert.equal(manifest.localProductionQualification, "blocked");
  const evaluator = local.modeEvidence.find(
    ({ mode }) => mode === "mutation-disabled-evaluator",
  );
  assert.equal(evaluator.status, "unverified-claim");
  assert.equal(manifest.unverifiedStructuralGuaranteeCount, 0);
});
