import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
  recoveryEvidenceHarness,
  targetClosureClaims,
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
    "v2s.restore.case-d5f19166b03545ac"
  ],
  "only complete context-verified target closure evidence may replace local ack", async () => {
  const harness = await recoveryEvidenceHarness();
  const body = targetClosureClaims();
  const verified = verifyClaims(harness, "target-authority-closed", body, {
    currentPatch: { nowUtcMs: 60 },
  });
  const envelopeJson = JSON.stringify(verified.envelope).replaceAll("'", "''");

  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRecoverySql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'target-authority-closed', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES (
         '${body.evidenceId}', 'target-authority-closed', 'recovery-authority',
         '${body.authorityVersion}', 'key-v1', ${body.authorityGeneration}, '${envelopeJson}',
         '${verified.envelope.signature}', '${verified.envelopeDigest}', '${verified.authorizedPayloadDigest}',
         '${verified.casPredicates.expectedContextDigest}',
         '${verified.casPredicates.currentStateDigest}', ${body.issuedAtUtcMs},
         ${body.expiresAtUtcMs}, 0, 2
       );
       INSERT INTO target_authority_closures VALUES (
         '${body.targetControlInstanceId}', '${body.databaseIdentity}', '${body.evidenceId}',
         'recovery-authority', '${body.authorityVersion}', ${body.authorityGeneration},
         '${body.casIdentity}', ${body.registrationClosureWatermark},
         ${body.continuationClosureWatermark}, '${body.revokedMemberSetDigest}',
         '${body.invalidatedAttestationDigest}', ${body.maxGrantExpiryUtcMs},
         ${body.observedAtUtcMs}, '${body.timeEvidenceDigest}',
         '${body.dispatchObligationDigest}', '${body.discoveryObligationDigest}',
         '${body.obligationDigest}',
         '${verified.casPredicates.expectedContextDigest}',
         '${verified.casPredicates.currentStateDigest}', '${verified.envelopeDigest}',
         ${body.issuedAtUtcMs}, 1, 2
       );`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM target_authority_closures",
      )[0].count,
      1,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `UPDATE target_authority_closures SET obligation_digest = '${digest("f")}' WHERE target_control_instance_id = 'target-1'`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});
