import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const applicabilityUrl = new URL(
  "../../oracles/m0/applicability.json",
  import.meta.url,
);
const casesUrl = new URL("../../oracles/m0/cases.json", import.meta.url);

function disposition(predicates, oracleCase, invocation) {
  const predicate = predicates.find(
    ({ id }) => id === oracleCase.applicabilityPredicateId,
  );
  if (predicate.id === "always-required-v1") return { kind: "applicable" };
  if (predicate.applicableProfiles.includes(invocation.profileId))
    return { kind: "applicable" };
  return { kind: "excluded-with-owner-reason", code: predicate.excludedCode };
}

test("owner predicate derives disposition before execution", async () => {
  const [manifest, cases] = await Promise.all([
    readFile(applicabilityUrl, "utf8").then(JSON.parse),
    readFile(casesUrl, "utf8").then(JSON.parse),
  ]);
  const neutral = cases.cases.find(
    ({ coverageClass }) => coverageClass === "neutral-control-storage",
  );
  const tenant = cases.cases.find(
    ({ coverageClass }) => coverageClass === "named-tenant",
  );
  assert.deepEqual(
    disposition(manifest.predicates, neutral, { profileId: "anything" }),
    { kind: "applicable" },
  );
  assert.deepEqual(
    disposition(manifest.predicates, tenant, { profileId: "inbox" }),
    { kind: "applicable" },
  );
  assert.deepEqual(
    disposition(manifest.predicates, tenant, { profileId: "process-host" }),
    {
      kind: "excluded-with-owner-reason",
      code: "tenant-not-selected",
    },
  );
  assert.equal(manifest.invocation.candidateDispositionField, false);
  assert.equal(manifest.invocation.postExecutionChange, false);
});

test.scenarios(
  [
    "m0o.format.case-0d5b80f3325f6dcd"
  ],
  "free text, missing evidence, and post-execution exclusions are invalid", async () => {
  const manifest = JSON.parse(await readFile(applicabilityUrl, "utf8"));
  assert.deepEqual(manifest.invalidReasons, [
    "free-text-reason",
    "missing-evidence",
    "predicate-mismatch",
    "post-execution-exclusion",
  ]);
});
