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

function setup(manifest) {
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
  authority.initializeSession("session-1", 0);
  authority.acknowledgeSession("session-1", "initialized");
  return authority;
}

test.scenarios(
  [
    "v2s.restore.case-2535bafa3b986d9f"
  ],
  "binding rejects any artifact or command aimed at another target", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const authority = setup(manifest);
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
  const verifiedArtifact = verifyClaims(
    harness,
    "recovery-artifact",
    artifactClaims,
  );
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
    targetControlInstanceId: "target-other",
  };
  assert.throws(
    () => authority.bind("attempt-1", 0, artifact, command),
    (error) => error?.code === "stale_authority",
  );
  assert.throws(
    () =>
      authority.bind(
        "attempt-1",
        0,
        {
          kind: "VerifiedEvidence",
          profileId: "recovery-artifact",
          claims: verifiedArtifact.claims,
          envelopeDigest: "f".repeat(64),
          consume() {},
        },
        command,
      ),
    (error) => error?.code === "stale_authority",
  );
  assert.throws(
    () => authority.bind("attempt-1", 0, verifiedArtifact, command),
    (error) => error?.code === "target_mismatch",
  );
  command.targetControlInstanceId = "target-1";
  const wrongReleaseClaims = {
    ...artifactClaims,
    evidenceId: "artifact-evidence-wrong-release",
    releaseId: "f".repeat(64),
  };
  const wrongReleaseEvidence = verifyClaims(
    harness,
    "recovery-artifact",
    wrongReleaseClaims,
  );
  assert.throws(
    () => authority.bind("attempt-1", 0, wrongReleaseEvidence, command),
    (error) => error?.code === "stale_authority",
  );
  const certificate = authority.bind("attempt-1", 0, verifiedArtifact, command);
  assert.equal(certificate.targetControlInstanceId, "target-1");
  assert.equal(certificate.state, "bound");
  assert.equal(
    authority.bind("attempt-1", 0, verifiedArtifact, command),
    certificate,
  );
  assert.throws(
    () =>
      authority.bind("attempt-1", 0, verifiedArtifact, {
        ...command,
        commandId: "command-other",
      }),
    (error) => error?.code === "target_mismatch",
  );
});
