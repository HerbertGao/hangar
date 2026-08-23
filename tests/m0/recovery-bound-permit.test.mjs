import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  activationPermitClaims,
  contexts,
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

function bound(manifest, harness) {
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
  const artifactInput = {
    artifactId: "artifact-1",
    agentAttemptId: "attempt-1",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
    commandDigest: "d".repeat(64),
    reservedEpoch: 2,
  };
  const artifactClaims = recoveryArtifactClaims(artifactInput);
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
  const verifiedArtifact = verifyClaims(
    harness,
    "recovery-artifact",
    artifactClaims,
  );
  const certificate = authority.bind("attempt-1", 0, verifiedArtifact, {
    commandId: "command-1",
    commandDigest: artifactInput.commandDigest,
    targetControlInstanceId: "target-1",
  });
  return { authority, certificate };
}

test.scenarios(
  [
    "v2s.restore.case-436bdaf8d0ce678e"
  ],
  "permit issue and consume require the exact current authority, boot, host, and time context", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const { authority, certificate } = bound(manifest, harness);
  const firstClaims = activationPermitClaims(certificate, 1);
  assert.throws(
    () =>
      authority.issuePermit(certificate.certificateId, {
        kind: "VerifiedEvidence",
        profileId: "activation-permit",
        claims: firstClaims,
        consume() {},
      }),
    (error) => error?.code === "stale_authority",
  );
  const first = authority.issuePermit(
    certificate.certificateId,
    verifyClaims(harness, "activation-permit", firstClaims),
  );

  const secondClaims = activationPermitClaims(certificate, 2);
  const secondEnvelope = harness.evidence.issue(
    "activation-permit",
    secondClaims,
  );
  const secondContext = contexts(
    harness.registry,
    "activation-permit",
    secondClaims,
    { nowUtcMs: 80 },
  );
  assert.throws(
    () =>
      harness.evidence.verify(secondEnvelope, secondContext.expectedContext, {
        ...secondContext.currentState,
        bootId: "old-boot",
      }),
    (error) => error?.code === "stale_authority",
  );
  const second = authority.issuePermit(
    certificate.certificateId,
    harness.evidence.verify(
      secondEnvelope,
      secondContext.expectedContext,
      secondContext.currentState,
    ),
  );
  assert.equal(first.state, "superseded");
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.certificateId, first.certificateId);
  assert.equal(authority.attempts.size, 1);
  assert.throws(
    () =>
      authority.consumeBinding(certificate.certificateId, {
        nowUtcMs: 80,
        currentAuthorityGeneration: 1,
        currentBootId: "boot-1",
        currentStartupCycleId: "cycle-1",
        currentHostAttestationId: "attestation-1",
        currentHostGeneration: 1,
        currentTimeEvidenceId: "time-1",
        currentTimeGeneration: 1,
      }),
    (error) => error?.code === "invalid_state",
  );
  assert.equal(
    authority.consumeBinding(certificate.certificateId, {
      nowUtcMs: 80,
      currentAuthorityGeneration: 1,
      currentBootId: "boot-2",
      currentStartupCycleId: "cycle-2",
      currentHostAttestationId: "attestation-2",
      currentHostGeneration: 2,
      currentTimeEvidenceId: "time-2",
      currentTimeGeneration: 2,
    }).state,
    "consumed",
  );
  assert.equal(manifest.activationPermit.resignSameBindingOnly, true);
  assert.equal(manifest.activationPermit.rawPersisted, false);
});
