import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { machineCell } from "./helpers.mjs";
import {
  digest,
  query,
  seedRunSql,
  sqlite,
  withDatabase,
} from "./sqlite-helper.mjs";

const statesUrl = new URL(
  "../../contracts/v2/control/state-machines.json",
  import.meta.url,
);
const admissionUrl = new URL(
  "../../contracts/v2/control/admission.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.activation.case-9437319ace99e1c7",
    "v2s.restore.case-21c4fe51e1eaaf75"
  ],
  "only active admits production manual or intent input", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  for (const event of ["admit-manual", "admit-intent"]) {
    assert.equal(
      machineCell(states, "Activation", "active", event).kind,
      "allow",
    );
    for (const state of ["inactive", "shadow", "draining", "quarantined"]) {
      assert.equal(
        machineCell(states, "Activation", state, event).kind,
        "reject",
      );
    }
  }
});

test.scenarios(
  [
    "v2c.activation.case-0ca0ce9a7b52c579"
  ],
  "scheduled admission is typed unsupported in every Activation state", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  const activation = states.machines.find(({ id }) => id === "Activation");
  for (const state of activation.states) {
    assert.deepEqual(
      machineCell(states, "Activation", state, "admit-scheduled"),
      {
        kind: "reject",
        errorKind: "unsupported_schedule",
      },
    );
  }
});

test.scenarios(
  [
    "v2c.activation.case-437c70c5849e6f45"
  ],
  "promotion to active requires current production host evidence", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  for (const state of ["inactive", "shadow"])
    assert.ok(
      machineCell(states, "Activation", state, "promote-active").conditions.includes(
        "current-production-control-attestation",
      ),
    );
});

test.scenarios(
  [
    "v2c.activation.case-9517e01d762d1f29"
  ],
  "a second production owner for one Agent is rejected", async () => {
  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    assert.notEqual(
      sqlite(
        databasePath,
        `INSERT INTO activations VALUES ('activation-2', 'agent-1', '${digest("2")}', 2, 'active', 1)`,
        { allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      query(
        databasePath,
        "SELECT count(*) AS count FROM activations WHERE agent_id='agent-1' AND state='active'",
      )[0].count,
      1,
    );
  });
});

test("production and recovery activation require an empty direct-effect list", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  for (const state of ["inactive", "shadow"])
    assert.ok(
      machineCell(
        states,
        "Activation",
        state,
        "promote-active",
      ).conditions.includes("trusted-direct-effects-empty"),
    );
  assert.ok(
    machineCell(
      states,
      "Activation",
      "quarantined",
      "recover-activate",
    ).conditions.includes("trusted-direct-effects-empty"),
  );
});

test.scenarios(
  [
    "v2c.activation.case-d29467a38bb37b18"
  ],
  "shadow profile is mutation-disabled and recovery activation is delegated", async () => {
  const states = JSON.parse(await readFile(statesUrl, "utf8"));
  const admission = JSON.parse(await readFile(admissionUrl, "utf8"));
  const shadow = admission.profiles.find(({ id }) => id === "shadow");
  assert.equal(shadow.mutationDisabled, true);
  assert.deepEqual(shadow.admissionKinds, ["evaluator"]);
  assert.equal(
    machineCell(states, "Activation", "quarantined", "recover-activate")
      .ownerRequirementId,
    "v2s.restore",
  );
  assert.equal(admission.recovery.clientPermitArgument, false);
});
