import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { actorSubjectId, composePolicy } from "../../scripts/validate-m0.mjs";

const authorityUrl = new URL(
  "../../contracts/v2/control/authority-policy.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.authority-policy.case-9b97adc9c88e72db",
    "v2c.authority-policy.case-ccba4fa4c23ea597"
  ],
  "stable actor subject separates issuer, represented subject, and audience", async () => {
  const manifest = JSON.parse(await readFile(authorityUrl, "utf8"));
  const base = manifest.sampleAuthorityContext;
  assert.equal(actorSubjectId(base), manifest.sampleActorSubjectId);
  assert.equal(
    actorSubjectId({
      ...base,
      issuerVersion: "issuer-v4",
      authenticatedMethod: "new-method",
      issuedAtUtcMs: 2000,
      expiresAtUtcMs: 3000,
      revocationVersion: "rev-8",
    }),
    manifest.sampleActorSubjectId,
  );
  for (const patch of [
    { issuerNamespaceId: "issuer-other" },
    { representedSubjectId: "subject-other" },
    { audience: "effect-gateway" },
  ]) {
    assert.notEqual(
      actorSubjectId({ ...base, ...patch }),
      manifest.sampleActorSubjectId,
    );
  }
});

test("policy composition follows the closed deny/max/intersection/union/min rules", async () => {
  const manifest = JSON.parse(await readFile(authorityUrl, "utf8"));
  for (const vector of manifest.vectors) {
    if (vector.expectedError) {
      assert.throws(
        () =>
          composePolicy(vector.registry, vector.release, manifest.riskRanks),
        (error) => error?.code === vector.expectedError,
        vector.id,
      );
    } else {
      assert.deepEqual(
        composePolicy(vector.registry, vector.release, manifest.riskRanks),
        vector.expected,
        vector.id,
      );
    }
  }
});

test.scenarios(
  [
    "v2c.authority-policy.case-bf7b8be3fed43b6b"
  ],
  "an unknown risk or constraint fails closed", async () => {
  const manifest = JSON.parse(await readFile(authorityUrl, "utf8"));
  const vector = manifest.vectors[0];
  for (const release of [
    { ...vector.release, risk: "future-risk" },
    { ...vector.release, unsupportedConstraint: "allow" },
  ]) {
    assert.throws(
      () => composePolicy(vector.registry, release, manifest.riskRanks),
      (error) => error?.code === "incomparable_policy",
    );
  }
});
