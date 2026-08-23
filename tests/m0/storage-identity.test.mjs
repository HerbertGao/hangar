import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

import {
  recoveryEvidenceHarness,
  verifyClaims,
} from "./recovery-evidence-helper.mjs";
import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2s.transactions.case-fe75138ace6ae93a"
  ],
  "database/control identities and genesis fact commit atomically", async () => {
  await withDatabase((databasePath) => {
    const failed = sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO storage_identity VALUES (1, 'database-1', 'instance-1', 'enabled');
       INSERT INTO control_instance_ids VALUES ('instance-1', 'database-1', 'active');
       INSERT INTO source_facts VALUES (2, 'database-1', '${digest("0")}', '${digest("a")}', 'database-genesis', 'v1', '{}', '${digest("1")}');
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM storage_identity")[0]
        .count,
      0,
    );
    sqlite(databasePath, seedRunSql());
    assert.equal(
      query(databasePath, "SELECT database_identity FROM storage_identity")[0]
        .database_identity,
      "database-1",
    );
    assert.notEqual(
      sqlite(
        databasePath,
        "UPDATE storage_identity SET database_identity = 'other'",
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test.scenarios(
  [
    "v2s.sqlite.case-6e190cfeca05b49f"
  ],
  "clean restart crash before continuation commit leaves no writable subset", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    const failed = sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'control-instance-resumed', 'v1', '{}', '${digest("2")}');
       UPDATE control_instances SET incarnation_kind='resumed', boot_id='boot-2', startup_cycle_id='cycle-2' WHERE control_instance_id='instance-1';
       INSERT INTO source_facts VALUES (5, 'database-1', '${digest("c")}', '${digest("d")}', 'time-observed', 'v1', '{}', '${digest("3")}');
       COMMIT;`,
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.deepEqual(
      query(
        databasePath,
        "SELECT incarnation_kind, boot_id, startup_cycle_id FROM control_instances",
      )[0],
      { incarnation_kind: "genesis", boot_id: "boot-1", startup_cycle_id: "cycle-1" },
    );
    assert.equal(
      query(databasePath, "SELECT max(fact_seq) AS seq FROM source_facts")[0]
        .seq,
      2,
    );
  });
});

test.scenarios(
  [
    "v2s.sqlite.case-aaefe760d261e4bf",
    "v2s.sqlite.case-e1bb817e54595928"
  ],
  "clean restart compares signed proof with caller-owned identity and current boot/host/time state", async () => {
  const harness = await recoveryEvidenceHarness();
  await withDatabase(async (databasePath, directory) => {
    sqlite(databasePath, seedRunSql());
    const clonePath = join(directory, "clone.sqlite");
    await copyFile(databasePath, clonePath);
    const identity = query(clonePath, "SELECT * FROM storage_identity")[0];
    const claims = {
      evidenceId: "continuation-1",
      authorityId: "recovery-authority",
      authorityVersion: "v1",
      authorityGeneration: 1,
      issuedAtUtcMs: 10,
      expiresAtUtcMs: 100,
      databaseIdentity: identity.database_identity,
      targetControlInstanceId: identity.current_control_instance_id,
      casIdentity: `${identity.database_identity}:${identity.current_control_instance_id}`,
      priorIncarnationState: "writable",
      bootId: "boot-2",
      startupCycleId: "cycle-2",
      continuationGeneration: 1,
      timeEvidenceId: "time-1",
      timeEvidenceDigest: digest("9"),
      timeGeneration: 1,
      productionControlAttestationId: "attestation-1",
      productionControlAttestationDigest: digest("8"),
      productionControlAttestationGeneration: 1,
    };
    const verified = verifyClaims(harness, "clean-restart", claims);
    assert.equal(verified.profileId, "clean-restart");
    const envelopeJson = JSON.stringify(verified.envelope).replaceAll(
      "'",
      "''",
    );
    sqlite(
      clonePath,
      `BEGIN;
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'control-instance-resumed', 'v1', '{}', '${digest("2")}');
       INSERT INTO authenticated_evidence VALUES ('${claims.evidenceId}', 'clean-restart', 'recovery-authority', '${claims.authorityVersion}', 'key-v1', 1, '${envelopeJson}', '${verified.envelope.signature}', '${verified.envelopeDigest}', '${verified.authorizedPayloadDigest}', '${verified.casPredicates.expectedContextDigest}', '${verified.casPredicates.currentStateDigest}', 10, 100, 1, 3);
       INSERT INTO evidence_authority_heads VALUES ('restart:database-1', 1, '${claims.bootId}', '${claims.startupCycleId}', '${claims.productionControlAttestationId}', '${claims.productionControlAttestationDigest}', ${claims.productionControlAttestationGeneration}, '${claims.timeEvidenceId}', '${claims.timeEvidenceDigest}', ${claims.timeGeneration}, '${verified.casPredicates.currentStateDigest}', 3);
       INSERT INTO authenticated_evidence_consumptions VALUES ('${claims.evidenceId}', 'control-instance-resume', 'instance-1', 1, 3);
       UPDATE control_instances SET incarnation_kind='resumed', boot_id='${claims.bootId}', startup_cycle_id='${claims.startupCycleId}', continuation_authority_scope_id='restart:database-1', continuation_proof_digest='${verified.envelopeDigest}', continuation_evidence_id='${claims.evidenceId}', resumed_fact_seq=3 WHERE control_instance_id='instance-1';
       COMMIT;`,
    );
    assert.deepEqual(
      query(
        clonePath,
        "SELECT incarnation_kind, continuation_evidence_id, resumed_fact_seq FROM control_instances",
      )[0],
      {
        incarnation_kind: "resumed",
        continuation_evidence_id: claims.evidenceId,
        resumed_fact_seq: 3,
      },
    );

    const wrongTarget = {
      ...claims,
      evidenceId: "continuation-2",
      targetControlInstanceId: "other-instance",
      casIdentity: "database-1:other-instance",
    };
    assert.throws(
      () =>
        verifyClaims(harness, "clean-restart", wrongTarget, {
          expectedPatch: {
            targetControlInstanceId: identity.current_control_instance_id,
            casIdentity: `${identity.database_identity}:${identity.current_control_instance_id}`,
          },
        }),
      (error) => error?.code === "evidence_context_mismatch",
    );
    assert.throws(
      () =>
        verifyClaims(
          harness,
          "clean-restart",
          {
            ...claims,
            evidenceId: "continuation-3",
          },
          {
            currentPatch: { bootId: "boot-current" },
          },
        ),
      (error) => error?.code === "stale_authority",
    );
    assert.throws(
      () =>
        verifyClaims(
          harness,
          "clean-restart",
          {
            ...claims,
            evidenceId: "continuation-4",
          },
          {
            currentPatch: { authorityGeneration: 2 },
          },
        ),
      (error) => error?.code === "stale_authority",
    );
    verified.consume();
    assert.throws(
      () => verifyClaims(harness, "clean-restart", claims),
      (error) => error?.code === "stale_authority",
    );
  });
});
