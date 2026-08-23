import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { registerAction, validateCheckpoint } from "./helpers.mjs";

const harnessUrl = new URL(
  "../../contracts/v2/control/harness.json",
  import.meta.url,
);

function fixture(actionStore) {
  registerAction(actionStore, {
    runId: "run-1",
    actionId: "producer",
    originRunAttempt: 1,
    actionKind: "tool",
    inputArtifactDigest: "a".repeat(64),
    commandIdentity: "command-producer",
  });
  return {
    checkpointId: "checkpoint-1",
    releaseId: "release-1",
    runId: "run-1",
    producerAttempt: 1,
    producerActionId: "producer",
    checkpointSchemaId: "resume-v1",
    checkpointSchemaVersion: 1,
    artifactRef: { artifactId: "artifact-1" },
    artifactDigest: "b".repeat(64),
    boundaryKind: "human",
    outstandingObligations: [],
  };
}

test.scenarios(
  [
    "v2c.harness-session.case-1d41b7cd691717cc"
  ],
  "checkpoint persists only an attributed artifact reference", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  const actions = new Map();
  const checkpoint = fixture(actions);
  assert.equal(
    validateCheckpoint(checkpoint, harness, actions, new Map()),
    true,
  );
  assert.equal(harness.checkpoint.artifactRefOnly, true);
  assert.equal(harness.checkpoint.resumeCreatesNewAttempt, true);
  assert.equal(harness.checkpoint.sameAttemptResume, "invalid_state");
});

test.scenarios(
  [
    "v2c.harness-session.case-b943ecde74f72559"
  ],
  "inline continuation, wrong producer, and undeclared boundary fail closed", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  const actions = new Map();
  const checkpoint = fixture(actions);
  assert.throws(
    () =>
      validateCheckpoint(
        { ...checkpoint, modelContext: "inline" },
        harness,
        actions,
        new Map(),
      ),
    (error) => error?.code === "unknown_checkpoint_field",
  );
  assert.throws(
    () =>
      validateCheckpoint(
        { ...checkpoint, producerAttempt: 2 },
        harness,
        actions,
        new Map(),
      ),
    (error) => error?.code === "invalid_checkpoint_producer",
  );
  assert.throws(
    () =>
      validateCheckpoint(
        { ...checkpoint, boundaryKind: "arbitrary" },
        harness,
        actions,
        new Map(),
      ),
    (error) => error?.code === "invalid_checkpoint_boundary",
  );
});
