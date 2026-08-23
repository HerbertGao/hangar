import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const compatibilityUrl = new URL(
  "../../contracts/v2/release/compatibility.json",
  import.meta.url,
);
const identityUrl = new URL(
  "../../contracts/v2/release/identity.json",
  import.meta.url,
);

function supports(manifest, release) {
  return manifest.supportedTuples.some(
    (tuple) =>
      tuple.schemaVersion === release.schemaVersion &&
      tuple.canonicalizationVersion === release.canonicalizationVersion &&
      tuple.hashAlgorithm === release.hashAlgorithm,
  );
}

test.scenarios(
  [
    "v2c.core-objects.case-2625bc33f3368451",
    "v2c.release-compatibility.case-75883b57b2954516"
  ],
  "only exact declared release tuples are supported", async () => {
  const compatibility = JSON.parse(await readFile(compatibilityUrl, "utf8"));
  const identity = JSON.parse(await readFile(identityUrl, "utf8"));
  assert.equal(supports(compatibility, identity.sampleRelease), true);
  assert.equal(compatibility.implicitMinorCompatibility, false);
  assert.equal(compatibility.unknownFieldPolicy, "reject");

  for (const patch of [
    { schemaVersion: "agent-release-v2" },
    { canonicalizationVersion: "canonical-json-v2" },
    { hashAlgorithm: "sha512" },
  ]) {
    assert.equal(
      supports(compatibility, { ...identity.sampleRelease, ...patch }),
      false,
    );
  }
});

test.scenarios(
  [
    "v2c.release-compatibility.case-a2f0f8982e81e26f"
  ],
  "unknown release fields fail even under a supported tuple", async () => {
  const compatibility = JSON.parse(await readFile(compatibilityUrl, "utf8"));
  const identity = JSON.parse(await readFile(identityUrl, "utf8"));
  const candidate = { ...identity.sampleRelease, futureOptionalField: true };
  assert.equal(supports(compatibility, candidate), true);
  assert.notDeepEqual(
    Object.keys(candidate).sort(),
    [...identity.requiredFields].sort(),
  );
  assert.equal(compatibility.unknownFieldPolicy, "reject");
});
