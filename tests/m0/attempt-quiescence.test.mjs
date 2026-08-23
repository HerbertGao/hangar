import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { allocationMatches, machineCell } from "./helpers.mjs";

const harnessUrl = new URL(
  "../../contracts/v2/control/harness.json",
  import.meta.url,
);
const statesUrl = new URL(
  "../../contracts/v2/control/state-machines.json",
  import.meta.url,
);

const current = {
  priorAttemptTerminal: true,
  currentAttemptNumber: 1,
  containmentGeneration: 4,
  containmentSealed: true,
  grantRevocationGeneration: 7,
  obligationSetDigest: "a".repeat(64),
  checkpointOwnerChainHead: "owner-3",
};

test.scenarios(
  [
    "v2c.run-attempt.case-ad8e55b719c20ac5"
  ],
  "next attempt allocation consumes an exact AttemptQuiesced view", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  assert.equal(harness.attemptQuiescence.allocationConsumesFact, true);
  assert.equal(allocationMatches(current, current), true);
  for (const patch of [
    { priorAttemptTerminal: false },
    { currentAttemptNumber: 2 },
    { containmentGeneration: 5 },
    { containmentSealed: false },
    { grantRevocationGeneration: 8 },
    { obligationSetDigest: "b".repeat(64) },
    { checkpointOwnerChainHead: "owner-4" },
  ]) {
    assert.equal(allocationMatches(current, { ...current, ...patch }), false);
  }
});

test.scenarios(
  [
    "v2c.harness-session.case-4e97f754f85e6871"
  ],
  "resolved late dispatch changes the digest before checkpoint resume", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  const late = machineCell(
    states,
    "RunAttempt",
    "checkpointed",
    "late-obligation-outcome",
  );
  assert.equal(late.kind, "allow");
  assert.equal(late.schedulesWork, false);
  const resolved = { ...current, obligationSetDigest: "b".repeat(64) };
  assert.equal(allocationMatches(current, resolved), false);
  assert.equal(allocationMatches(resolved, resolved), true);
});

test.scenarios(
  [
    "v2c.run-attempt.case-79ea5c5af64adc96",
    "v2c.run-attempt.case-ae7db6cf250cbc93",
    "v2s.transactions.case-ca300ae5f1073288"
  ],
  "quiescence fences every derived input but permits non-scheduling late outcome", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  assert.deepEqual(harness.attemptQuiescence.fencedAttemptInputs, [
    "action-registration",
    "harness-event",
    "action-event",
    "effect-intent",
    "checkpoint",
    "outcome-proposal",
    "grant-use",
    "child-registration",
    "child-launch",
  ]);
  assert.equal(
    machineCell(states, "RunAttempt", "succeeded", "append-effect-intent")
      .errorKind,
    "stale_attempt",
  );
  const late = machineCell(
    states,
    "RunAttempt",
    "succeeded",
    "late-obligation-outcome",
  );
  assert.equal(late.kind, "allow");
  assert.equal(late.schedulesWork, false);
});
