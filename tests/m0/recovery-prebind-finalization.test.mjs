import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

function finalize(manifest, cause) {
  const result = manifest.prebindFinalization[cause];
  if (result === "remain-pending-same-cas")
    return { status: "pending-coordination", retry: "same-external-cas" };
  return { status: "completed", result };
}

test.scenarios(
  [
    "v2s.restore.case-f4ba9a3a00d08fc1"
  ],
  "every deterministic pre-bind failure completes the pending activation command", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  assert.deepEqual(finalize(manifest, "artifactExpired"), {
    status: "completed",
    result: "recovery_artifact_expired",
  });
  assert.deepEqual(finalize(manifest, "authorityStale"), {
    status: "completed",
    result: "stale_authority",
  });
  assert.deepEqual(finalize(manifest, "recoveryConflict"), {
    status: "completed",
    result: "recovery_evidence_conflict",
  });
  assert.deepEqual(finalize(manifest, "deterministicPreconditionFailure"), {
    status: "completed",
    result: "invalid_state",
  });
});

test("ambiguous authority response keeps one pending command and retries only the same CAS", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  assert.deepEqual(finalize(manifest, "ambiguousAuthorityResponse"), {
    status: "pending-coordination",
    retry: "same-external-cas",
  });
});
