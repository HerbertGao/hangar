import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  recoveryArtifactClaims,
  recoveryEvidenceHarness,
  verifyClaims,
} from "./recovery-evidence-helper.mjs";
import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);
const sessionInput = {
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
    "v2s.restore.case-9208c1a9969444c0",
    "v2s.restore.case-da2a90fc7592ecac",
    "v2s.transactions.case-63b1c687d34aeee5"
  ],
  "RecoveryAuthority owns stable session identity and exact target binding", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  const first = authority.registerSession(sessionInput);
  assert.equal(authority.registerSession(sessionInput), first);
  assert.throws(
    () =>
      authority.registerSession({
        ...sessionInput,
        targetControlInstanceId: "target-other",
      }),
    (error) => error?.code === "target_mismatch",
  );
  assert.throws(
    () =>
      authority.registerSession({
        ...sessionInput,
        recoverySessionId: "session-2",
        sourceControlInstanceId: "source-2",
        backupDigest: "d".repeat(64),
      }),
    (error) => error?.code === "recovery_in_progress",
  );
});

test.scenarios(
  [
    "v2s.restore.case-bd1a0e6d778e751e"
  ],
  "consumed recovery challenge and reserved epoch cannot be replayed", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const authority = new RecoveryAuthorityFixture(manifest);
  const reservedEpoch = authority.reserveEpoch("database-1", "agent-1");
  const claims = recoveryArtifactClaims({
    artifactId: "artifact-1",
    recoverySessionId: "session-1",
    agentAttemptId: "attempt-1",
    targetControlInstanceId: "target-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
    reservedEpoch,
    commandDigest: "d".repeat(64),
  });
  verifyClaims(harness, "recovery-artifact", claims).consume();
  assert.throws(
    () => verifyClaims(harness, "recovery-artifact", claims),
    (error) => error?.code === "stale_authority",
  );
  assert.equal(authority.reserveEpoch("database-1", "agent-1"), 2);
});

test("recovery epochs are monotonic per database and Agent and never reused", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  assert.equal(authority.reserveEpoch("database-1", "agent-1"), 1);
  assert.equal(authority.reserveEpoch("database-1", "agent-1"), 2);
  assert.equal(authority.reserveEpoch("database-1", "agent-2"), 1);
  assert.equal(authority.reserveEpoch("database-2", "agent-1"), 1);
});
