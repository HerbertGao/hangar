import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

test.scenarios(
  [
    "v2c.effect.case-0079735399055528",
    "v2c.effect.case-17f8ea1e2fe54f6c",
    "v2c.effect.case-c577210f77a8f691",
    "v2s.source-facts.case-67e77675b7af2265",
    "v2s.source-facts.case-7346d8522d592f0b",
    "v2s.source-facts.case-e9aa255d0209ead8"
  ],
  "dispatch and receipt require complete claim, host, and connector authority bindings", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO external_receipts (
           effect_id, dispatch_generation, receipt_id, status, connector_id,
           authority_id, authority_type, authority_version, authority_generation,
           authentication_evidence_digest, proof_ref, fact_seq
         ) VALUES (
           'effect-1', 1, 'receipt-1', 'committed', 'connector-1',
           'connector-authority-1', 'connector-authority', 'v1', 1,
           '${digest("8")}', 'proof-1', 3
         )`,
        { allowFailure: true },
      ).status,
      0,
    );

    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'effect-origin', NULL, '${digest("9")}', 'command-action', 3);
       INSERT INTO effects VALUES ('effect-1', 'run-1', 'intent-1', 0, 'operation-1', '${digest("a")}', 0, 'action-1', 'claimed');
       INSERT INTO effect_claims VALUES ('effect-1', 1, 0, '${digest("2")}', 1, 'sink-1', 'operation-1', 'audience-1', 5000, 'issued');`,
    );

    assert.notEqual(
      sqlite(
        databasePath,
        `BEGIN;
         INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'effect-dispatch-started', 'v1', '{}', '${digest("b")}');
         INSERT INTO effect_dispatches VALUES (
           'effect-1', 1, 1, 'database-1', 'instance-1', 'run-1', 0,
           '${digest("2")}', 1, 'connector-1', 'sink-1', 'operation-1',
           'request-1', 'discovery-1', 'attestation-1', '${digest("7")}', 1,
           'effect-dispatch', 'verified', 4
         );
         COMMIT;`,
        { allowFailure: true },
      ).status,
      0,
    );

    const subject = JSON.stringify({
      effectId: "effect-1",
      dispatchGeneration: 1,
    });
    const controls = JSON.stringify({
      "credential-stripping": true,
      "outbound-default-deny": true,
      "secret-default-deny": true,
      "explicit-capability-grants": true,
    });
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'launch-attestation', 'v1', '{}', '${digest("b")}');
       INSERT INTO launch_attestations VALUES (
         'attestation-1', 'launch-1', '${digest("1")}', 'host-1', 'profile-1',
         'effect-dispatch', 'cycle-1', 1, 'verified', 'm0-launcher-verifier',
         'v1', 'Ed25519', '${subject}', '${digest("2")}', '${controls}',
         '${digest("3")}', '${digest("4")}', '${digest("7")}', 10, 5000, NULL, NULL, NULL, 4
       );
       INSERT INTO source_facts VALUES (5, 'database-1', '${digest("d")}', '${digest("e")}', 'effect-dispatch-started', 'v1', '{}', '${digest("c")}');
       INSERT INTO effect_dispatches VALUES (
         'effect-1', 1, 1, 'database-1', 'instance-1', 'run-1', 0,
         '${digest("2")}', 1, 'connector-1', 'sink-1', 'operation-1',
         'request-1', 'discovery-1', 'attestation-1', '${digest("7")}', 1,
         'effect-dispatch', 'verified', 5
       );
       UPDATE effects SET state='dispatch-started' WHERE effect_id='effect-1';
       INSERT INTO mutation_authorities VALUES (
         'connector-authority-1', 'instance-1', 'connector-authority', 'v1',
         1, 1, 'active'
       );
       INSERT INTO source_facts VALUES (6, 'database-1', '${digest("e")}', '${digest("f")}', 'external-receipt', 'v1', '{}', '${digest("d")}');`,
    );

    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO external_receipts VALUES (
           'effect-1', 1, 'receipt-1', 'committed', 'connector-1',
           'connector-authority-1', 'connector-authority', 'v2', 1,
           '${digest("8")}', 'proof-1', 6
         )`,
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO external_receipts VALUES (
         'effect-1', 1, 'receipt-1', 'committed', 'connector-1',
         'connector-authority-1', 'connector-authority', 'v1', 1,
         '${digest("8")}', 'proof-1', 6
       );`,
    );
    assert.equal(
      query(databasePath, "SELECT status FROM external_receipts")[0].status,
      "committed",
    );
    assert.deepEqual(
      query(
        databasePath,
        "SELECT receipt_id, fact_seq FROM external_receipts WHERE effect_id='effect-1' AND dispatch_generation=1 AND receipt_id='receipt-1'",
      ),
      [{ receipt_id: "receipt-1", fact_seq: 6 }],
    );
    assert.equal(
      query(databasePath, "SELECT count(*) AS count FROM external_receipts")[0]
        .count,
      1,
    );
    sqlite(
      databasePath,
      `INSERT INTO mutation_authorities VALUES (
         'connector-authority-1', 'instance-1', 'connector-authority', 'v1',
         2, 2, 'active'
       );`,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM mutation_authorities WHERE authority_id = 'connector-authority-1'",
      )[0].count,
      2,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT authority_generation FROM external_receipts",
      )[0].authority_generation,
      1,
    );
  });
});
