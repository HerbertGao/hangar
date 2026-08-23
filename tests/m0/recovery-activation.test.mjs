import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  activationPermitClaims,
  contexts,
  recoveryArtifactClaims,
  recoveryAttemptInput,
  recoveryEvidenceHarness,
  recoverySqlEvidence,
  verifyClaims,
} from "./recovery-evidence-helper.mjs";
import { createEvidenceFixture } from "./evidence-verifier.mjs";
import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";
import {
  digest,
  query,
  seedRecoverySql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.restore.case-3367c5c311edba14"
  ],
  "restored storage cannot self-issue recovery artifact evidence", async () => {
  const harness = await recoveryEvidenceHarness();
  const claims = recoveryArtifactClaims({
    artifactId: "artifact-1",
    recoverySessionId: "session-1",
    agentAttemptId: "attempt-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
    reservedEpoch: 1,
    commandDigest: digest("d"),
  });
  const restoredStorage = createEvidenceFixture(harness.registry, {
    issuerId: "restored-storage",
  });
  const envelope = restoredStorage.issue("recovery-artifact", claims);
  const context = contexts(harness.registry, "recovery-artifact", claims);
  assert.throws(() =>
    harness.evidence.verify(
      envelope,
      context.expectedContext,
      context.currentState,
    ),
  );
});

test.scenarios(
  [
    "v2s.restore.case-77e7f58c0adbfd34",
    "v2s.restore.case-f0a80cef8d362eb0"
  ],
  "bound certificate and current permit consume one exact decision", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  assert.equal(manifest.bindingCertificate.clientVisible, false);
  assert.equal(manifest.activationPermit.clientVisible, false);
  assert.deepEqual(manifest.timeEvidenceStages, [
    "command-preflight",
    "recovery-session",
    "recovery-agent-attempt",
  ]);
  const harness = await recoveryEvidenceHarness();
  const authority = new RecoveryAuthorityFixture(manifest);
  authority.registerSession({
    recoverySessionId: "session-1",
    databaseIdentity: "database-1",
    sourceControlInstanceId: "source-1",
    backupDigest: digest("a"),
    targetControlInstanceId: "target-1",
    agentSetDigest: digest("b"),
    commandDigest: digest("c"),
  });
  const artifactInput = {
    artifactId: "artifact-1",
    agentAttemptId: "attempt-1",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
    commandDigest: digest("d"),
    reservedEpoch: authority.reserveEpoch("database-1", "agent-1"),
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
  assert.equal(permit.state, "issued");
  assert.equal(
    authority.consumeBinding(certificate.certificateId, {
      nowUtcMs: 50,
      currentAuthorityGeneration: 1,
      currentBootId: "boot-1",
      currentStartupCycleId: "cycle-1",
      currentHostAttestationId: "attestation-1",
      currentHostGeneration: 1,
      currentTimeEvidenceId: "time-1",
      currentTimeGeneration: 1,
    }).state,
    "consumed",
  );
  assert.equal(permit.state, "consumed");
});

test.scenarios(
  [
    "v2c.time.case-a3e48ad5c4a68065",
    "v2s.restore.case-11821e6b8fe70162",
    "v2s.restore.case-7e06f53c78c6245a"
  ],
  "SQLite rejects stale permit context, then atomically activates with a higher current permit", async () => {
  const evidence = await recoverySqlEvidence([1, 2]);
  const permit1 = evidence.permits.get(1);
  const permit2 = evidence.permits.get(2);
  const sqlJson = (value) => JSON.stringify(value).replaceAll("'", "''");
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `BEGIN;
       UPDATE recovery_qualifications SET state='ready' WHERE agent_id='agent-1';
       UPDATE recovery_agent_attempts SET state='bound' WHERE recovery_attempt_id='recovery-attempt-1';
       INSERT INTO commands VALUES ('command-activate', 'actor-1', 'recover-activate', 'session-1/agent-1/0', 'key-a', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'binding-certificate', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES ('${evidence.artifactClaims.evidenceId}', 'recovery-artifact', 'recovery-authority', '${evidence.artifactClaims.authorityVersion}', 'key-v1', 1, '${sqlJson(evidence.artifact.envelope)}', '${evidence.artifact.envelope.signature}', '${evidence.artifact.envelopeDigest}', '${evidence.artifact.authorizedPayloadDigest}', '${evidence.artifact.casPredicates.expectedContextDigest}', '${evidence.artifact.casPredicates.currentStateDigest}', ${evidence.artifactClaims.issuedAtUtcMs}, ${evidence.artifactClaims.expiresAtUtcMs}, 1, 2);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${evidence.artifactClaims.evidenceId}', 'recovery-artifact', 'artifact-1', 1, 2);
       INSERT INTO evidence_authority_heads VALUES ('recovery:database-1', 1, 'boot-1', 'cycle-1', '${evidence.artifactClaims.hostAttestationId}', '${evidence.artifactClaims.hostAttestationDigest}', ${evidence.artifactClaims.hostAttestationGeneration}, '${evidence.artifactClaims.timeEvidenceId}', '${evidence.artifactClaims.timeEvidenceDigest}', ${evidence.artifactClaims.timeGeneration}, '${permit1.verified.casPredicates.currentStateDigest}', 2);
       INSERT INTO recovery_artifacts VALUES ('artifact-1', 'recovery-attempt-1', '${evidence.artifact.envelopeDigest}', '${evidence.artifactClaims.evidenceId}', '${evidence.artifact.casPredicates.expectedContextDigest}', '${evidence.artifact.casPredicates.currentStateDigest}', 'recovery:database-1', 1, '${evidence.artifactClaims.hostAttestationId}', '${evidence.artifactClaims.hostAttestationDigest}', ${evidence.artifactClaims.hostAttestationGeneration}, '${evidence.artifactClaims.timeEvidenceId}', '${evidence.artifactClaims.timeEvidenceDigest}', ${evidence.artifactClaims.timeGeneration}, '${evidence.artifactClaims.commandDigest}', '${evidence.artifactClaims.dispatchDenominatorDigest}', 2, ${evidence.artifactClaims.expiresAtUtcMs}, 'bound');
       INSERT INTO binding_certificates VALUES ('certificate-1', 'artifact-1', 'command-activate', 'recovery-attempt-1', 'target-1', 2, '${evidence.artifact.envelopeDigest}', 'bound', 1);
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'activation-permit-evidence', 'v1', '{}', '${digest("3")}');
       INSERT INTO authenticated_evidence VALUES ('${permit1.claims.evidenceId}', 'activation-permit', 'recovery-authority', '${permit1.claims.authorityVersion}', 'key-v1', 1, '${sqlJson(permit1.verified.envelope)}', '${permit1.verified.envelope.signature}', '${permit1.verified.envelopeDigest}', '${permit1.verified.authorizedPayloadDigest}', '${permit1.verified.casPredicates.expectedContextDigest}', '${permit1.verified.casPredicates.currentStateDigest}', ${permit1.claims.issuedAtUtcMs}, ${permit1.claims.expiresAtUtcMs}, 1, 3);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${permit1.claims.evidenceId}', 'activation-permit', 'certificate-1/1', 1, 3);
       INSERT INTO activation_permit_evidence VALUES ('certificate-1', 1, 'issued', '${permit1.verified.envelopeDigest}', '${permit1.claims.evidenceId}', '${permit1.verified.casPredicates.expectedContextDigest}', '${permit1.verified.casPredicates.currentStateDigest}', 'recovery:database-1', 1, '${permit1.claims.bootId}', '${permit1.claims.startupCycleId}', '${permit1.claims.hostAttestationId}', '${permit1.claims.hostAttestationDigest}', ${permit1.claims.hostGeneration}, '${permit1.claims.timeEvidenceId}', '${permit1.claims.timeEvidenceDigest}', ${permit1.claims.timeGeneration}, ${permit1.claims.expiresAtUtcMs});
       COMMIT;`,
    );

    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'time-observed', 'v1', '{}', '${digest("4")}');
       UPDATE evidence_authority_heads SET boot_id='${permit2.claims.bootId}', startup_cycle_id='${permit2.claims.startupCycleId}', host_attestation_id='${permit2.claims.hostAttestationId}', host_attestation_digest='${permit2.claims.hostAttestationDigest}', host_generation=${permit2.claims.hostGeneration}, time_evidence_id='${permit2.claims.timeEvidenceId}', time_evidence_digest='${permit2.claims.timeEvidenceDigest}', time_generation=${permit2.claims.timeGeneration}, current_state_digest='${permit2.verified.casPredicates.currentStateDigest}', fact_seq=4 WHERE authority_scope_id='recovery:database-1';
       COMMIT;`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "UPDATE activation_permit_evidence SET status='consumed' WHERE certificate_id='certificate-1' AND permit_generation=1",
        { allowFailure: true },
      ).status,
      0,
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT state AS artifact, status AS permit FROM recovery_artifacts CROSS JOIN activation_permit_evidence WHERE permit_generation=1",
      )[0],
      { artifact: "bound", permit: "issued" },
    );

    sqlite(
      databasePath,
      `BEGIN;
       UPDATE activation_permit_evidence SET status='superseded' WHERE certificate_id='certificate-1' AND permit_generation=1;
       INSERT INTO source_facts VALUES (5, 'database-1', '${digest("d")}', '${digest("e")}', 'activation-permit-evidence', 'v1', '{}', '${digest("5")}');
       INSERT INTO authenticated_evidence VALUES ('${permit2.claims.evidenceId}', 'activation-permit', 'recovery-authority', '${permit2.claims.authorityVersion}', 'key-v1', 1, '${sqlJson(permit2.verified.envelope)}', '${permit2.verified.envelope.signature}', '${permit2.verified.envelopeDigest}', '${permit2.verified.authorizedPayloadDigest}', '${permit2.verified.casPredicates.expectedContextDigest}', '${permit2.verified.casPredicates.currentStateDigest}', ${permit2.claims.issuedAtUtcMs}, ${permit2.claims.expiresAtUtcMs}, 1, 5);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${permit2.claims.evidenceId}', 'activation-permit', 'certificate-1/2', 2, 5);
       INSERT INTO activation_permit_evidence VALUES ('certificate-1', 2, 'issued', '${permit2.verified.envelopeDigest}', '${permit2.claims.evidenceId}', '${permit2.verified.casPredicates.expectedContextDigest}', '${permit2.verified.casPredicates.currentStateDigest}', 'recovery:database-1', 1, '${permit2.claims.bootId}', '${permit2.claims.startupCycleId}', '${permit2.claims.hostAttestationId}', '${permit2.claims.hostAttestationDigest}', ${permit2.claims.hostGeneration}, '${permit2.claims.timeEvidenceId}', '${permit2.claims.timeEvidenceDigest}', ${permit2.claims.timeGeneration}, ${permit2.claims.expiresAtUtcMs});
       COMMIT;`,
    );
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (6, 'database-1', '${digest("e")}', '${digest("f")}', 'activation-permit-evidence', 'v1', '{}', '${digest("6")}');
       UPDATE recovery_artifacts SET state='consumed' WHERE artifact_id='artifact-1' AND state='bound';
       UPDATE activation_permit_evidence SET status='consumed' WHERE certificate_id='certificate-1' AND permit_generation=2 AND status='issued';
       UPDATE recovery_qualifications SET state='qualified' WHERE agent_id='agent-1' AND state='ready';
       UPDATE activations SET state='active', epoch=2 WHERE activation_id='activation-1' AND state='quarantined';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"activated"}' WHERE command_id='command-activate' AND status='pending-coordination';
       COMMIT;`,
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT q.state AS qualification, a.state AS activation, a.epoch FROM recovery_qualifications q JOIN activations a ON a.activation_id=q.activation_id",
      )[0],
      { qualification: "qualified", activation: "active", epoch: 2 },
    );
  });
});
