import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.restore.case-0e042a065fab2df9"
  ],
  "one RecoverySession target hosts independent per-Agent attempts and epochs", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
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
  const certificate = authority.initializeSession("session-1", 0);
  assert.equal(certificate.targetControlInstanceId, "target-1");
  authority.acknowledgeSession("session-1", "initialized");
  const first = authority.startAgentAttempt({
    agentAttemptId: "attempt-1",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
  });
  const second = authority.startAgentAttempt({
    agentAttemptId: "attempt-2",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-2",
    qualificationGeneration: 0,
  });
  assert.equal(first.targetControlInstanceId, second.targetControlInstanceId);
  assert.notEqual(
    authority.reserveEpoch("database-1", "agent-1"),
    authority.reserveEpoch("database-1", "agent-1"),
  );
  assert.equal(authority.reserveEpoch("database-1", "agent-2"), 1);
  assert.throws(
    () =>
      authority.startAgentAttempt({ ...first, agentAttemptId: "attempt-3" }),
    (error) => error?.code === "recovery_in_progress",
  );
});
