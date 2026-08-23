import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  activationPermitClaims,
  boundConflictClaims,
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
  const certificate = authority.bind(
    "attempt-1",
    0,
    verifyClaims(harness, "recovery-artifact", artifactClaims),
    {
      commandId: "command-1",
      commandDigest: artifactInput.commandDigest,
      targetControlInstanceId: "target-1",
    },
  );
  const permit = authority.issuePermit(
    certificate.certificateId,
    verifyClaims(
      harness,
      "activation-permit",
      activationPermitClaims(certificate, 1),
    ),
  );
  return { authority, certificate, permit };
}

test("authenticated bound conflict compares exact certificate, command, evidence, and Agent context", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  for (const kind of manifest.boundConflict.allowedKinds) {
    const harness = await recoveryEvidenceHarness();
    const { authority, certificate, permit } = setup(manifest, harness);
    const wrongAgent = boundConflictClaims(certificate, kind, {
      evidenceId: `wrong-agent-${kind}`,
      agentId: "agent-other",
    });
    assert.throws(
      () =>
        verifyClaims(harness, "bound-conflict", wrongAgent, {
          expectedPatch: { agentId: certificate.agentId },
        }),
      (error) => error?.code === "evidence_context_mismatch",
    );
    const conflictClaims = boundConflictClaims(certificate, kind);
    assert.throws(
      () =>
        verifyClaims(
          harness,
          "bound-conflict",
          {
            ...conflictClaims,
            evidenceId: `stale-generation-${kind}`,
          },
          { currentPatch: { conflictGeneration: 2 } },
        ),
      (error) => error?.code === "stale_authority",
    );
    const conflictContext = contexts(
      harness.registry,
      "bound-conflict",
      conflictClaims,
    ).expectedContext;
    assert.throws(
      () =>
        authority.invalidateBinding(
          certificate.certificateId,
          {
            kind: "VerifiedEvidence",
            profileId: "bound-conflict",
            claims: conflictClaims,
            consume() {},
          },
          conflictContext,
        ),
      (error) => error?.code === "stale_authority",
    );
    authority.invalidateBinding(
      certificate.certificateId,
      verifyClaims(harness, "bound-conflict", conflictClaims),
      conflictContext,
    );
    assert.equal(certificate.state, "binding-invalidated-awaiting-local");
    assert.equal(permit.state, "revoked");
    authority.acknowledgeBindingInvalidated(certificate.certificateId);
    assert.equal(certificate.state, "invalidated");
    assert.throws(
      () =>
        authority.startAgentAttempt({
          agentAttemptId: "attempt-2",
          recoverySessionId: "session-1",
          targetControlInstanceId: "target-1",
          agentId: "agent-1",
          qualificationGeneration: 1,
        }),
      (error) => error?.code === "invalid_state",
    );
  }
});

test.scenarios(
  [
    "v2s.restore.case-16c82e6efcff0680"
  ],
  "ordinary authority rotation cannot masquerade as a bound conflict", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const { authority, certificate } = setup(manifest, harness);
  const verified = verifyClaims(
    harness,
    "bound-conflict",
    boundConflictClaims(certificate, "OrdinaryAuthorityRotation"),
  );
  const conflictContext = contexts(
    harness.registry,
    "bound-conflict",
    verified.claims,
  ).expectedContext;
  assert.throws(
    () =>
      authority.invalidateBinding(
        certificate.certificateId,
        verified,
        conflictContext,
      ),
    (error) => error?.code === "stale_authority",
  );
});
