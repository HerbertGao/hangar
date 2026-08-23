import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { checkStateMachines } from "../../scripts/validate-m0.mjs";
import { machineCell } from "./helpers.mjs";

const statesUrl = new URL(
  "../../contracts/v2/control/state-machines.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.control-taxonomy.case-9b1f2455b9486fb8"
  ],
  "RunAttempt table is exhaustive and terminal states are closed", async () => {
  const manifest = JSON.parse(await readFile(statesUrl, "utf8"));
  const machine = manifest.machines.find(({ id }) => id === "RunAttempt");
  assert.deepEqual(machine.states, [
    "created",
    "starting",
    "running",
    "quiescing",
    "checkpointed",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(machine.terminalStates, [
    "checkpointed",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.equal(
    machine.table.length,
    machine.states.length * machine.events.length,
  );
  assert.equal((await checkStateMachines()).kind, "pass");
});

test.scenarios(
  [
    "m0o.process-fixture.case-7d7457d8ec7f4690",
    "v2c.run-attempt.case-3b06c1e112fc8cba",
    "v2c.run-attempt.case-a5aeebde48e9ef31"
  ],
  "Harness cannot own outer retry and Control cannot overlap a live attempt", async () => {
  const manifest = JSON.parse(await readFile(statesUrl, "utf8"));
  assert.deepEqual(manifest.retryOwnership.outer, {
    owner: "control",
    unit: "RunAttempt",
  });
  assert.equal(manifest.retryOwnership.inner.owner, "harness");
  assert.equal(manifest.retryOwnership.inner.sameRunAttemptOnly, true);
  assert.deepEqual(manifest.retryOwnership.prohibitedAutomaticRetry, [
    "unknown-effect",
    "committed-effect",
  ]);
  assert.equal(
    machineCell(manifest, "RunAttempt", "running", "allocate-next-attempt")
      .kind,
    "reject",
  );
  assert.equal(
    machineCell(manifest, "RunAttempt", "succeeded", "allocate-next-attempt")
      .kind,
    "delegate",
  );
});

test.scenarios(
  [
    "v2c.run.case-f4f0e256f70be78a"
  ],
  "terminal Runs reject every new-work event", async () => {
  const manifest = JSON.parse(await readFile(statesUrl, "utf8"));
  for (const state of ["completed", "failed", "cancelled"])
    for (const event of ["allocate-attempt", "new-action", "new-effect-intent"])
      assert.equal(
        machineCell(manifest, "Run", state, event).kind,
        "reject",
        `${state}:${event}`,
      );
});

test.scenarios(
  [
    "v2c.run-attempt.case-a817b2f69a823972",
    "v2c.run.case-07b219604f77ec11"
  ],
  "technical success does not make the Run business-complete", async () => {
  const manifest = JSON.parse(await readFile(statesUrl, "utf8"));
  assert.deepEqual(
    machineCell(manifest, "RunAttempt", "running", "technical-succeeded"),
    {
      kind: "transition",
      nextState: "succeeded",
    },
  );
  const completion = machineCell(
    manifest,
    "Run",
    "settling",
    "terminal-complete",
  );
  assert.ok(completion.conditions.includes("domain-outcome-gate"));
  assert.equal(manifest.terminalChokePoint.harnessMaySubmitTerminal, false);
});
