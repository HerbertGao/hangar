import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const fixturesUrl = new URL(
  "../../oracles/m0/process-fixtures.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.process-lifecycle.case-41ed09ca1d5e1c11"
  ],
  "process fixture covers all owner/race failures with one convergence outcome", async () => {
  const manifest = JSON.parse(await readFile(fixturesUrl, "utf8"));
  assert.deepEqual(
    manifest.cases.map(({ fault }) => fault),
    [
      "parent-death",
      "late-descendant",
      "partial-jsonl",
      "cancel-during-spawn",
      "term-timeout",
      "dispatch-response-loss",
      "crash-after-checkpoint",
      "two-trigger-owners",
      "outer-retry-while-session-live",
    ],
  );
  assert.equal(
    new Set(manifest.cases.map(({ caseId }) => caseId)).size,
    manifest.cases.length,
  );
  assert.ok(manifest.cases.every(({ expected }) => expected));
  assert.deepEqual(manifest.owners, {
    outerRetry: "control",
    terminal: "control",
    containment: "control",
    innerRetry: "harness",
    internalSession: "harness",
  });
  for (const evidence of [
    "ActionEvent",
    "effectiveGrant",
    "CheckpointRef",
    "Effect",
    "containment",
    "recoveryPoint",
  ]) {
    assert.ok(manifest.requiredEvidence.includes(evidence));
  }
});
