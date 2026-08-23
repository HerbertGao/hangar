import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  obligationKey,
  registerAction,
  validateCheckpoint,
} from "./helpers.mjs";

const harnessUrl = new URL(
  "../../contracts/v2/control/harness.json",
  import.meta.url,
);

function base(actions) {
  registerAction(actions, {
    runId: "run-1",
    actionId: "producer",
    originRunAttempt: 1,
    actionKind: "effect-origin",
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
    boundaryKind: "effect",
  };
}

test("obligation kind, subject, owner, and generation are closed and canonical", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  const actions = new Map();
  const checkpoint = base(actions);
  const obligations = [
    {
      kind: "effect",
      subjectId: "effect-1",
      subjectGeneration: 0,
      ownerKind: "effect-gateway",
      ownerGeneration: 1,
      effectId: "effect-1",
      intentGeneration: 0,
    },
    {
      kind: "human",
      subjectId: "approval-1",
      subjectGeneration: 0,
      ownerKind: "control",
      ownerGeneration: 1,
    },
  ].sort((left, right) =>
    obligationKey(left, harness.obligations.canonicalOrder).localeCompare(
      obligationKey(right, harness.obligations.canonicalOrder),
    ),
  );
  const owners = new Map(
    obligations.map((obligation) => [
      obligationKey(obligation, harness.obligations.collisionKey),
      { kind: obligation.ownerKind, generation: obligation.ownerGeneration },
    ]),
  );
  assert.equal(
    validateCheckpoint(
      { ...checkpoint, outstandingObligations: obligations },
      harness,
      actions,
      owners,
    ),
    true,
  );
});

test.scenarios(
  [
    "v2c.harness-session.case-6e9a865e2f8ebcc9"
  ],
  "stale owner, missing effect identity, collision, and unsorted refs are rejected", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  const actions = new Map();
  const checkpoint = base(actions);
  const effect = {
    kind: "effect",
    subjectId: "effect-1",
    subjectGeneration: 0,
    ownerKind: "effect-gateway",
    ownerGeneration: 1,
    effectId: "effect-1",
    intentGeneration: 0,
  };
  const key = obligationKey(effect, harness.obligations.collisionKey);
  assert.throws(
    () =>
      validateCheckpoint(
        { ...checkpoint, outstandingObligations: [effect] },
        harness,
        actions,
        new Map([[key, { kind: "effect-gateway", generation: 2 }]]),
      ),
    (error) => error?.code === "stale_obligation_owner",
  );
  const missingIdentity = { ...effect };
  delete missingIdentity.effectId;
  assert.throws(
    () =>
      validateCheckpoint(
        { ...checkpoint, outstandingObligations: [missingIdentity] },
        harness,
        actions,
        new Map(),
      ),
    (error) => error?.code === "invalid_obligation",
  );
  assert.throws(
    () =>
      validateCheckpoint(
        {
          ...checkpoint,
          outstandingObligations: [effect, { ...effect, ownerGeneration: 2 }],
        },
        harness,
        actions,
        new Map([[key, { kind: "effect-gateway", generation: 1 }]]),
      ),
    (error) => error?.code === "obligation_collision",
  );
});
