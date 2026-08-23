import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
   boundConflictClaims,
   recoverySqlEvidence,
   verifyClaims,
} from "./recovery-evidence-helper.mjs";
import {
   digest,
   query,
   seedRecoverySql,
   sqlite,
   withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.restore.case-ae8edc529117987b"
  ],
  "bound conflict revokes permits and atomically completes local invalidation", async () => {
   const evidence = await recoverySqlEvidence([1]);
   const permit = evidence.permits.get(1);
   const conflictClaims = boundConflictClaims(
      evidence.certificate,
      "RecoveryAgentBindingConflict",
   );
   const conflict = verifyClaims(
      evidence.harness,
      "bound-conflict",
      conflictClaims,
   );
   const sqlJson = (value) => JSON.stringify(value).replaceAll("'", "''");
   await withDatabase((databasePath) => {
      sqlite(databasePath, seedRecoverySql());
      sqlite(
         databasePath,
         `UPDATE recovery_qualifications SET state='ready' WHERE agent_id='agent-1';
       UPDATE recovery_agent_attempts SET state='bound' WHERE recovery_attempt_id='recovery-attempt-1';
       INSERT INTO commands VALUES ('command-activate', 'actor-1', 'recover-activate', 'session-1/agent-1/0', 'activate-key', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("3")}', '${digest("4")}', '${digest("5")}', '${digest("6")}', 'pending-coordination', NULL, 'session-1', 'target-1', NULL, NULL);
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'binding-certificate', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES ('${evidence.artifactClaims.evidenceId}', 'recovery-artifact', 'recovery-authority', '${evidence.artifactClaims.authorityVersion}', 'key-v1', 1, '${sqlJson(evidence.artifact.envelope)}', '${evidence.artifact.envelope.signature}', '${evidence.artifact.envelopeDigest}', '${evidence.artifact.authorizedPayloadDigest}', '${evidence.artifact.casPredicates.expectedContextDigest}', '${evidence.artifact.casPredicates.currentStateDigest}', ${evidence.artifactClaims.issuedAtUtcMs}, ${evidence.artifactClaims.expiresAtUtcMs}, 1, 2);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${evidence.artifactClaims.evidenceId}', 'recovery-artifact', 'artifact-1', 1, 2);
       INSERT INTO evidence_authority_heads VALUES ('recovery:database-1', 1, 'boot-1', 'cycle-1', '${evidence.artifactClaims.hostAttestationId}', '${evidence.artifactClaims.hostAttestationDigest}', ${evidence.artifactClaims.hostAttestationGeneration}, '${evidence.artifactClaims.timeEvidenceId}', '${evidence.artifactClaims.timeEvidenceDigest}', ${evidence.artifactClaims.timeGeneration}, '${permit.verified.casPredicates.currentStateDigest}', 2);
       INSERT INTO recovery_artifacts VALUES ('artifact-1', 'recovery-attempt-1', '${evidence.artifact.envelopeDigest}', '${evidence.artifactClaims.evidenceId}', '${evidence.artifact.casPredicates.expectedContextDigest}', '${evidence.artifact.casPredicates.currentStateDigest}', 'recovery:database-1', 1, '${evidence.artifactClaims.hostAttestationId}', '${evidence.artifactClaims.hostAttestationDigest}', ${evidence.artifactClaims.hostAttestationGeneration}, '${evidence.artifactClaims.timeEvidenceId}', '${evidence.artifactClaims.timeEvidenceDigest}', ${evidence.artifactClaims.timeGeneration}, '${evidence.artifactClaims.commandDigest}', '${evidence.artifactClaims.dispatchDenominatorDigest}', 2, ${evidence.artifactClaims.expiresAtUtcMs}, 'bound');
       INSERT INTO binding_certificates VALUES ('certificate-1', 'artifact-1', 'command-activate', 'recovery-attempt-1', 'target-1', 2, '${evidence.artifact.envelopeDigest}', 'bound', 1);
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'activation-permit-evidence', 'v1', '{}', '${digest("3")}');
       INSERT INTO authenticated_evidence VALUES ('${permit.claims.evidenceId}', 'activation-permit', 'recovery-authority', '${permit.claims.authorityVersion}', 'key-v1', 1, '${sqlJson(permit.verified.envelope)}', '${permit.verified.envelope.signature}', '${permit.verified.envelopeDigest}', '${permit.verified.authorizedPayloadDigest}', '${permit.verified.casPredicates.expectedContextDigest}', '${permit.verified.casPredicates.currentStateDigest}', ${permit.claims.issuedAtUtcMs}, ${permit.claims.expiresAtUtcMs}, 1, 3);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${permit.claims.evidenceId}', 'activation-permit', 'certificate-1/1', 1, 3);
       INSERT INTO activation_permit_evidence VALUES ('certificate-1', 1, 'issued', '${permit.verified.envelopeDigest}', '${permit.claims.evidenceId}', '${permit.verified.casPredicates.expectedContextDigest}', '${permit.verified.casPredicates.currentStateDigest}', 'recovery:database-1', 1, '${permit.claims.bootId}', '${permit.claims.startupCycleId}', '${permit.claims.hostAttestationId}', '${permit.claims.hostAttestationDigest}', ${permit.claims.hostGeneration}, '${permit.claims.timeEvidenceId}', '${permit.claims.timeEvidenceDigest}', ${permit.claims.timeGeneration}, ${permit.claims.expiresAtUtcMs});
       INSERT INTO mutation_authorities VALUES ('authority-1', 'target-1', 'admission-owner', 'v1', 1, 1, 'active');`,
      );
      sqlite(
         databasePath,
         `BEGIN;
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'recovery-agent-binding-conflict', 'v1', '{}', '${digest("4")}');
       INSERT INTO authenticated_evidence VALUES ('${conflictClaims.evidenceId}', 'bound-conflict', 'recovery-authority', '${conflictClaims.authorityVersion}', 'key-v1', 1, '${sqlJson(conflict.envelope)}', '${conflict.envelope.signature}', '${conflict.envelopeDigest}', '${conflict.authorizedPayloadDigest}', '${conflict.casPredicates.expectedContextDigest}', '${conflict.casPredicates.currentStateDigest}', ${conflictClaims.issuedAtUtcMs}, ${conflictClaims.expiresAtUtcMs}, 1, 4);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${conflictClaims.evidenceId}', 'bound-conflict', 'certificate-1/1', 1, 4);
       INSERT INTO recovery_conflict_heads VALUES ('${conflictClaims.recoveryOperationId}', ${conflictClaims.conflictGeneration}, '${conflictClaims.registryProofDigest}', '${conflictClaims.authenticationEvidenceDigest}', 4);
       INSERT INTO binding_conflict_evidence VALUES ('certificate-1', ${conflictClaims.conflictGeneration}, '${conflictClaims.kind}', '${conflictClaims.recoveryOperationId}', '${conflictClaims.registryProofDigest}', '${conflictClaims.authenticationEvidenceDigest}', '${conflictClaims.evidenceId}', '${conflict.envelopeDigest}', '${conflict.casPredicates.expectedContextDigest}', '${conflict.casPredicates.currentStateDigest}', 4);
       UPDATE activation_permit_evidence SET status='revoked' WHERE certificate_id='certificate-1' AND status='issued';
       UPDATE recovery_artifacts SET state='invalidated' WHERE artifact_id='artifact-1' AND state='bound';
       UPDATE recovery_qualifications SET state='invalidated' WHERE recovery_session_id='session-1' AND agent_id='agent-1' AND state='ready';
       UPDATE recovery_agent_attempts SET state='binding-invalidated-awaiting-local' WHERE recovery_attempt_id='recovery-attempt-1' AND state='bound';
       UPDATE binding_certificates SET binding_state='binding-invalidated-awaiting-local' WHERE certificate_id='certificate-1' AND binding_state='bound';
       UPDATE mutation_authorities SET state='revoked' WHERE authority_id='authority-1';
       UPDATE commands SET status='completed', safe_result_json='{"kind":"recovery_evidence_conflict"}' WHERE command_id='command-activate' AND status='pending-coordination';
       COMMIT;`,
      );
      assert.equal(
         query(databasePath, "SELECT status FROM activation_permit_evidence")[0]
            .status,
         "revoked",
      );
      assert.equal(
         query(databasePath, "SELECT state FROM recovery_artifacts")[0].state,
         "invalidated",
      );
      assert.equal(
         query(databasePath, "SELECT state FROM recovery_qualifications")[0]
            .state,
         "invalidated",
      );
      assert.equal(
         query(
            databasePath,
            "SELECT status FROM commands WHERE command_id='command-activate'",
         )[0].status,
         "completed",
      );
      assert.equal(
         query(databasePath, "SELECT state FROM activations")[0].state,
         "quarantined",
      );
   });
});
