import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  canonicalDigest,
  canonicalize,
  parseStrictJson,
  validateSafeIntegerFields,
} from "../../scripts/validate-m0.mjs";

const identityUrl = new URL(
  "../../contracts/v2/release/identity.json",
  import.meta.url,
);
const vectorsUrl = new URL(
  "../../contracts/v2/release/canonical-vectors.json",
  import.meta.url,
);

function errorCode(callback, expected) {
  assert.throws(callback, (error) => error?.code === expected);
}

test.scenarios(
  [
    "v2c.release-identity.case-2e2e1115131297ba",
    "v2c.release-identity.case-69a7d96569601720",
    "v2c.release-identity.case-a4de272b16b48742",
    "v2c.release-identity.case-c92ef8d54b132b4b"
  ],
  "strict JSON canonicalization matches every frozen vector", async () => {
  const manifest = JSON.parse(await readFile(vectorsUrl, "utf8"));
  for (const vector of manifest.vectors) {
    if (vector.kind === "reject") {
      errorCode(() => parseStrictJson(vector.sources[0]), vector.expectedError);
      continue;
    }
    if (vector.kind === "unsafe-integer") {
      errorCode(
        () =>
          validateSafeIntegerFields(
            vector.value,
            new Set(vector.safeIntegerFields),
          ),
        vector.expectedError,
      );
      continue;
    }
    if (vector.kind === "malformed-utf8") {
      errorCode(
        () => parseStrictJson(Buffer.from(vector.bytesBase64, "base64")),
        vector.expectedError,
      );
      continue;
    }
    const values = vector.sources.map(parseStrictJson);
    assert.deepEqual(
      values.map(canonicalize),
      vector.expectedCanonicals,
      vector.id,
    );
    assert.deepEqual(
      values.map(canonicalDigest),
      vector.expectedDigests,
      vector.id,
    );
    if (vector.kind === "equivalent")
      assert.equal(new Set(vector.expectedDigests).size, 1, vector.id);
    if (vector.kind === "distinct")
      assert.equal(
        new Set(vector.expectedDigests).size,
        vector.sources.length,
        vector.id,
      );
  }
});

test("AgentRelease identity uses exactly the closed static membership", async () => {
  const identity = JSON.parse(await readFile(identityUrl, "utf8"));
  assert.deepEqual(
    Object.keys(identity.sampleRelease),
    identity.requiredFields,
  );
  assert.equal(
    canonicalDigest(identity.sampleRelease),
    identity.sampleReleaseId,
  );
  validateSafeIntegerFields(
    identity.sampleRelease,
    new Set(identity.numericDomains.safeIntegerFields),
  );

  const allowed = new Set(identity.requiredFields);
  for (const field of [
    ...identity.rejectedIdentifiers.identityFields,
    ...identity.rejectedIdentifiers.mutableEvidenceFields,
    ...identity.rejectedIdentifiers.deferredFields,
  ]) {
    assert.ok(!allowed.has(field));
    assert.throws(() => {
      const candidate = { ...identity.sampleRelease, [field]: "unexpected" };
      for (const key of Object.keys(candidate))
        if (!allowed.has(key)) throw new Error("unknown_field");
    }, /unknown_field/);
  }
});

test.scenarios(
  [
    "v2c.core-objects.case-4f0c7298f9d90368",
    "v2c.release-identity.case-844f43ad17b4d919"
  ],
  "skill, policy, operation, and host declaration changes create new identities", async () => {
  const identity = JSON.parse(await readFile(identityUrl, "utf8"));
  const baseline = identity.sampleReleaseId;
  const variants = [
    { ...identity.sampleRelease, approvedSkillDigests: ["a".repeat(64)] },
    { ...identity.sampleRelease, policyDigests: ["b".repeat(64)] },
    {
      ...identity.sampleRelease,
      requiredCapabilities: ["artifact-read", "tool-call"],
    },
    { ...identity.sampleRelease, requiredOperations: ["read", "write"] },
    { ...identity.sampleRelease, hostDeclarationDigest: "c".repeat(64) },
    { ...identity.sampleRelease, executionClosureDigest: "d".repeat(64) },
  ];
  for (const candidate of variants)
    assert.notEqual(canonicalDigest(candidate), baseline);
});

test("canonicalization rejects unsupported JavaScript values", () => {
  errorCode(() => canonicalize({ value: undefined }), "unsupported_json_value");
  errorCode(() => canonicalize(Number.POSITIVE_INFINITY), "non_finite_number");
  errorCode(() => canonicalize("\ud800"), "lone_surrogate");
});
