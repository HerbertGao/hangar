import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { checkStateMachines } from "../../scripts/validate-m0.mjs";

const processUrl = new URL(
  "../../contracts/v2/runtime/process-lifecycle.json",
  import.meta.url,
);

function sameIdentity(recorded, observed) {
  return (
    recorded.hostBootId === observed.hostBootId &&
    recorded.containmentId === observed.containmentId &&
    recorded.containmentGeneration === observed.containmentGeneration &&
    recorded.rootPid === observed.rootPid &&
    recorded.rootStartTimeFingerprint === observed.rootStartTimeFingerprint
  );
}

test.scenarios(
  [
    "m0o.v0-reaper.case-a62d31eb26def809",
    "v2c.process-lifecycle.case-dc99a9593d204e32"
  ],
  "PID reuse never authorizes a signal", () => {
  const recorded = {
    hostBootId: "boot-1",
    containmentId: "containment-1",
    containmentGeneration: 1,
    rootPid: 42,
    rootStartTimeFingerprint: "start-a",
  };
  assert.equal(
    sameIdentity(recorded, {
      ...recorded,
      rootStartTimeFingerprint: "start-b",
    }),
    false,
  );
  assert.equal(sameIdentity(recorded, recorded), true);
});

test.scenarios(
  [
    "v2c.process-lifecycle.case-3959fd59b64289b9",
    "v2c.process-lifecycle.case-470b4e7f410682fc",
    "v2s.transactions.case-983d8042df39a94b"
  ],
  "process registration and launch proof commit before entrypoint release", async () => {
  const manifest = JSON.parse(await readFile(processUrl, "utf8"));
  assert.equal(manifest.registration.bootstrapGateUntilCommit, true);
  assert.equal(manifest.registration.zeroOrComplete, true);
  assert.deepEqual(manifest.registration.transactionFields, [
    "processOwnershipRecord",
    "productionChildAttestationId",
    "productionChildAttestationDigest",
    "productionChildAttestationGeneration",
    "launchSourceFact",
  ]);
  const superseded = manifest.table.find(
    ({ state, event }) =>
      state === "registered" && event === "attestation-superseded",
  ).outcome;
  assert.equal(superseded.nextState, "failed-before-entry");
  assert.equal(superseded.entrypointReleased, false);
  assert.equal(superseded.mustHardReap, true);
  assert.equal((await checkStateMachines()).kind, "pass");
});

test("signal actions recheck full identity and recovery keeps one terminal owner", async () => {
  const manifest = JSON.parse(await readFile(processUrl, "utf8"));
  assert.equal(manifest.signals.identityRecheckEachAct, true);
  assert.equal(manifest.signals.pidOnlySufficient, false);
  assert.equal(manifest.recovery.terminalChokePoint, "Run");
  assert.equal(
    manifest.recovery.restrictedChildAuthorityReplacesLocalLifecycle,
    false,
  );
});
