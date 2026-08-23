import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { registerAction } from "./helpers.mjs";
import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const harnessUrl = new URL(
  "../../contracts/v2/control/harness.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.harness-session.case-cb42e12634f953ca",
    "v2s.transactions.case-1cbd0389b01450b2"
  ],
  "action registration replays exactly and rejects conflicting identity reuse", () => {
  const store = new Map();
  const action = {
    runId: "run-1",
    actionId: "action-1",
    originRunAttempt: 1,
    actionKind: "tool",
    inputArtifactDigest: "a".repeat(64),
    commandIdentity: "command-1",
  };
  const first = registerAction(store, action);
  assert.deepEqual(registerAction(store, action), first);
  assert.equal(store.size, 1);
  assert.throws(
    () => registerAction(store, { ...action, actionKind: "subagent" }),
    (error) => error?.code === "idempotency_conflict",
  );
});

test("parent action must already exist in the same Run", () => {
  const store = new Map();
  assert.throws(
    () =>
      registerAction(store, {
        runId: "run-1",
        actionId: "child",
        parentActionId: "future-parent",
        originRunAttempt: 1,
        actionKind: "tool",
        inputArtifactDigest: "b".repeat(64),
        commandIdentity: "command-child",
      }),
    (error) => error?.code === "invalid_parent",
  );
});

test("inner-retry storage requires an ordinal and other events forbid one", async () => {
  await withDatabase((databasePath) => {
    sqlite(
      databasePath,
      `${seedRunSql()}
       INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'action-registered', 'v1', '{}', '${digest("8")}');
       INSERT INTO actions VALUES ('run-1', 'action-1', 0, 'tool', NULL, '${digest("9")}', 'command-action', 3);
       INSERT INTO source_facts VALUES (4, 'database-1', '${digest("c")}', '${digest("d")}', 'action-event', 'v1', '{}', '${digest("a")}');`,
    );
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO action_events VALUES ('run-1', 'action-1', 1, 0, 'inner-retry', '${digest("1")}', '${digest("2")}', NULL, 4)`,
        { allowFailure: true },
      ).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO action_events VALUES ('run-1', 'action-1', 1, 0, 'inner-retry', '${digest("1")}', '${digest("2")}', 0, 4)`,
    );
    assert.equal(
      query(databasePath, "SELECT inner_retry_ordinal FROM action_events")[0]
        .inner_retry_ordinal,
      0,
    );
  });
});

test.scenarios(
  [
    "v2c.control-taxonomy.case-992da280c223705c"
  ],
  "ActionEvent kinds and attribution bindings are closed", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  assert.deepEqual(harness.actionEvents.kinds, [
    "action-started",
    "action-progress",
    "inner-retry",
    "tool-result",
    "subagent-result",
    "action-succeeded",
    "action-failed",
    "action-skipped",
  ]);
  for (const required of [
    "runId",
    "attempt",
    "actionId",
    "actualIdentityDigest",
    "effectiveGrantDigest",
  ]) {
    assert.ok(harness.actionEvents.requiredBindings.includes(required));
  }
  assert.deepEqual(harness.actionEvents.innerRetryOrdinalRequiredFor, [
    "inner-retry",
  ]);
});
