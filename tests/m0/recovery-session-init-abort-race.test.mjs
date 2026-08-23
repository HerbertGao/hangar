import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);
const input = {
  recoverySessionId: "session-1",
  databaseIdentity: "database-1",
  sourceControlInstanceId: "source-1",
  backupDigest: "a".repeat(64),
  targetControlInstanceId: "target-1",
  agentSetDigest: "b".repeat(64),
  commandDigest: "c".repeat(64),
};

test.scenarios(
  [
    "v2s.restore.case-0245a8b20537e56d",
    "v2s.restore.case-257a8afa45e80f01"
  ],
  "session init CAS winner excludes abort", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  authority.registerSession(input);
  authority.initializeSession("session-1", 0);
  assert.throws(
    () => authority.abortSession("session-1", 0),
    (error) => error?.code === "invalid_state",
  );
  assert.equal(
    authority.acknowledgeSession("session-1", "initialized"),
    "initialized",
  );
});

test("session abort CAS winner excludes init", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  authority.registerSession(input);
  authority.abortSession("session-1", 0);
  assert.throws(
    () => authority.initializeSession("session-1", 0),
    (error) => error?.code === "invalid_state",
  );
  assert.equal(authority.acknowledgeSession("session-1", "retired"), "retired");
});
