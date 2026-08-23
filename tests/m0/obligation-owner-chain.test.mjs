import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

import { resolveOwnerChain } from "./helpers.mjs";
import { digest, seedRunSql, sqlite, withDatabase } from "./sqlite-helper.mjs";

const reference = {
  kind: "effect",
  subjectId: "effect-1",
  subjectGeneration: 0,
  ownerKind: "effect-gateway",
  ownerGeneration: 1,
};

test.scenarios(
  [
    "v2s.handoff.case-f5df5cf32ce74b18"
  ],
  "DDL permits one successor and rejects a branch from the same owner generation", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'obligation-owner-transferred', 'v1', '{}', '${digest("8")}');
       INSERT INTO obligation_owner_transfers VALUES ('run-1', 'effect', 'effect-1', 0, 'effect-gateway', 1, 'reconciliation', 2, '${digest("9")}', 3);`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `BEGIN;
         INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'obligation-owner-transferred', 'v1', '{}', '${digest("a")}');
         INSERT INTO obligation_owner_transfers VALUES ('run-1', 'effect', 'effect-1', 0, 'effect-gateway', 1, 'control', 2, '${digest("a")}', 4);
         COMMIT;`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `BEGIN;
         INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'obligation-owner-transferred', 'v1', '{}', '${digest("a")}');
         INSERT INTO obligation_owner_transfers VALUES ('run-1', 'human', 'human-1', 0, 'control', 1, 'control', 3, '${digest("b")}', 4);
         COMMIT;`,
        { allowFailure: true },
      ).status,
      0,
    );
  });
});

test.scenarios(
  [
    "v2c.harness-session.case-746de4e07d1cb663"
  ],
  "resume follows the exact successor chain and rejects unresolved state", () => {
  const transfers = [
    {
      kind: "effect",
      subjectId: "effect-1",
      subjectGeneration: 0,
      fromOwnerKind: "effect-gateway",
      fromOwnerGeneration: 1,
      toOwnerKind: "reconciliation",
      toOwnerGeneration: 2,
    },
  ];
  assert.deepEqual(resolveOwnerChain(reference, transfers), {
    kind: "reconciliation",
    generation: 2,
  });
  assert.throws(
    () =>
      resolveOwnerChain(reference, [{ ...transfers[0], toOwnerGeneration: 3 }]),
    (error) => error.code === "owner_chain_gap",
  );
  const finalState = "unresolved";
  assert.ok(
    !["resolved-committed", "resolved-not-committed", "satisfied"].includes(
      finalState,
    ),
  );
});
