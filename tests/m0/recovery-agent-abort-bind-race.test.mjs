import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  recoveryArtifactClaims,
  recoveryAttemptInput,
  recoveryEvidenceHarness,
  verifyClaims,
} from "./recovery-evidence-helper.mjs";
import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);
function setup(manifest, harness) {
  const authority = new RecoveryAuthorityFixture(manifest);
  authority.registerSession({
    recoverySessionId: "session-1",
    databaseIdentity: "database-1",
    sourceControlInstanceId: "source-1",
    backupDigest: "a".repeat(64),
    targetControlInstanceId: "target-1",
    agentSetDigest: "b".repeat(64),
    commandDigest: "c".repeat(64),
  });
  const artifact = {
    artifactId: "artifact-1",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
    commandDigest: "d".repeat(64),
    reservedEpoch: 2,
    evidenceDigest: "e".repeat(64),
  };
  const artifactClaims = recoveryArtifactClaims({
    ...artifact,
    agentAttemptId: "attempt-1",
  });
  authority.startAgentAttempt(
    recoveryAttemptInput(
      harness,
      {
        agentAttemptId: "attempt-1",
        recoverySessionId: "session-1",
        targetControlInstanceId: "target-1",
        agentId: "agent-1",
        qualificationGeneration: 0,
      },
      artifactClaims,
    ),
  );
  const command = {
    commandId: "command-1",
    commandDigest: artifact.commandDigest,
    targetControlInstanceId: "target-1",
  };
  return { authority, artifactClaims, command };
}

test.scenarios(
  [
    "v2s.restore.case-3e9388e64be6e424"
  ],
  "Agent abort winner excludes binding", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const { authority, artifactClaims, command } = setup(manifest, harness);
  const verifiedArtifact = verifyClaims(
    harness,
    "recovery-artifact",
    artifactClaims,
  );
  authority.abortAgentAttempt("attempt-1", 0);
  assert.throws(
    () => authority.bind("attempt-1", 0, verifiedArtifact, command),
    (error) => error?.code === "invalid_state",
  );
  assert.equal(authority.acknowledgeAgentAbort("attempt-1").state, "aborted");
});

test.scenarios(
  [
    "v2s.restore.case-c33b45229a234dc2"
  ],
  "binding winner excludes ordinary abort", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const { authority, artifactClaims, command } = setup(manifest, harness);
  const verifiedArtifact = verifyClaims(
    harness,
    "recovery-artifact",
    artifactClaims,
  );
  authority.bind("attempt-1", 0, verifiedArtifact, command);
  assert.throws(
    () => authority.abortAgentAttempt("attempt-1", 0),
    (error) => error?.code === "invalid_state",
  );
});
