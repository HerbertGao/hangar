import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const admissionUrl = new URL(
  "../../contracts/v2/control/admission.json",
  import.meta.url,
);

function commitAdmission(manifest, expected, current) {
  const matches = manifest.productionCasCompares.every(
    (field) => expected[field] === current[field],
  );
  return matches
    ? { committed: true, facts: [...manifest.productionCommitSet] }
    : { committed: false, error: manifest.zeroRowResult };
}

test("production admission atomically binds current host generation", async () => {
  const manifest = JSON.parse(await readFile(admissionUrl, "utf8"));
  const expected = {
    singleProductionOwner: true,
    releaseId: "release-1",
    activationEpoch: 4,
    attestationMode: "production-control",
    attestationGeneration: 7,
    attestationExpiry: 5000,
  };
  const result = commitAdmission(manifest, expected, expected);
  assert.equal(result.committed, true);
  for (const field of [
    "Run",
    "initialRunEvent",
    "commandResult",
    "projection",
    "productionControlAttestationId",
    "productionControlAttestationDigest",
    "productionControlAttestationGeneration",
  ]) {
    assert.ok(result.facts.includes(field));
  }
});

test.scenarios(
  [
    "v2c.host-attestation.case-5146596e4f18a1b5",
    "v2c.run.case-2921bf8d39cbedd0",
    "v2s.transactions.case-4863eac769e290dc"
  ],
  "superseded host generation commits no admission subset", async () => {
  const manifest = JSON.parse(await readFile(admissionUrl, "utf8"));
  const expected = {
    singleProductionOwner: true,
    releaseId: "release-1",
    activationEpoch: 4,
    attestationMode: "production-control",
    attestationGeneration: 7,
    attestationExpiry: 5000,
  };
  assert.deepEqual(
    commitAdmission(manifest, expected, {
      ...expected,
      attestationGeneration: 8,
    }),
    {
      committed: false,
      error: "stale_generation",
    },
  );
  assert.equal(
    manifest.profiles.find(({ id }) => id === "production")
      .requiredAttestationMode,
    "production-control",
  );
});
