import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { registerAction } from "./helpers.mjs";

const harnessUrl = new URL(
  "../../contracts/v2/control/harness.json",
  import.meta.url,
);

test.scenarios(
  [
    "m0o.process-fixture.case-a87a23aa283ded9d",
    "v2c.harness-session.case-80eec2d75f35676f"
  ],
  "one HarnessSession owns dynamic inner progress without Control graph authority", async () => {
  const harness = JSON.parse(await readFile(harnessUrl, "utf8"));
  assert.equal(harness.session.uniquePerRunAttempt, true);
  assert.equal(harness.session.projectionAuthority, false);
  assert.equal(harness.session.mayCreateRun, false);
  assert.equal(harness.session.mayCreateRunAttempt, false);
  assert.equal(harness.session.maySubmitTerminal, false);

  const actions = new Map();
  const first = registerAction(actions, {
    runId: "run-1",
    actionId: "opaque-a",
    originRunAttempt: 1,
    actionKind: "tool",
    inputArtifactDigest: "a".repeat(64),
    commandIdentity: "command-a",
  });
  const second = registerAction(actions, {
    runId: "run-1",
    actionId: "opaque-b",
    parentActionId: first.actionId,
    originRunAttempt: 1,
    actionKind: "subagent",
    inputArtifactDigest: "b".repeat(64),
    commandIdentity: "command-b",
  });
  assert.equal(second.parentActionId, first.actionId);
  assert.equal(actions.size, 2);
});
