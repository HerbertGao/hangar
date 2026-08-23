import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { checkStateMachines, isExpired } from "../../scripts/validate-m0.mjs";
import { machineCell } from "./helpers.mjs";

const approvalUrl = new URL(
  "../../contracts/v2/control/approval.json",
  import.meta.url,
);
const statesUrl = new URL(
  "../../contracts/v2/control/effect-state-machines.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.approval.case-af4c5a4f83eb7110"
  ],
  "Approval state/event table is exhaustive with one decision winner", async () => {
  const [approval, states] = await Promise.all([
    readFile(approvalUrl, "utf8").then(JSON.parse),
    readFile(statesUrl, "utf8").then(JSON.parse),
  ]);
  const machine = states.machines.find(({ id }) => id === "Approval");
  assert.equal(
    machine.table.length,
    machine.states.length * machine.events.length,
  );
  assert.equal(
    machineCell(states, "Approval", "pending", "claim-decision").kind,
    "transition",
  );
  assert.equal(
    machineCell(states, "Approval", "deciding", "approve").nextState,
    "approved",
  );
  assert.equal(
    machineCell(states, "Approval", "approved", "duplicate-decision").kind,
    "idempotent",
  );
  assert.equal(
    machineCell(states, "Approval", "rejected", "approve").kind,
    "reject",
  );
  assert.equal(approval.decisionCas.singleWinner, true);
  assert.equal((await checkStateMachines()).kind, "pass");
});

test.scenarios(
  [
    "v2c.approval.case-4b9af75392ae3179",
    "v2c.approval.case-dc69d0aceed65d86",
    "v2c.authority-policy.case-42e4f70f8db79275"
  ],
  "Approval binds exact subject and reauthorizes before dispatch", async () => {
  const approval = JSON.parse(await readFile(approvalUrl, "utf8"));
  for (const field of [
    "effectId",
    "intentDigest",
    "operation",
    "policyVersion",
    "releaseId",
    "activationEpoch",
  ]) {
    assert.ok(approval.subjectBinding.includes(field));
  }
  assert.deepEqual(approval.authorizationChecks, [
    "at-decision",
    "immediately-before-dispatch",
  ]);
  assert.equal(approval.defaultDecision, "deny");
  assert.equal(approval.invalidation.subjectExpansion, false);
  assert.equal(isExpired(1000, 1000), true);
});
