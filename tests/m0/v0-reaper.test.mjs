import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const reaperUrl = new URL("../../oracles/m0/v0-reaper.json", import.meta.url);

function observe(input) {
  if (input.terminalAlreadyExists)
    return {
      signalsSent: 0,
      terminalFactsAppended: 0,
      ownershipRecordsRemaining: 0,
    };
  if (input.pidMatches && input.startTimeMatches)
    return {
      signalsSent: 0,
      terminalFactsAppended: 0,
      ownershipRecordsRemaining: 1,
    };
  return {
    signalsSent: 0,
    terminalFactsAppended: 1,
    ownershipRecordsRemaining: 0,
  };
}

test.scenarios(
  [
    "m0o.v0-reaper.case-7de98c1b85dc6e91",
    "m0o.v0-reaper.case-9fc8a1d4167a0b31"
  ],
  "dead owner, PID reuse, and repeated recovery match stable observations", async () => {
  const manifest = JSON.parse(await readFile(reaperUrl, "utf8"));
  for (const oracleCase of manifest.cases.filter(
    ({ caseId }) => caseId !== "v0-reaper.os-descendant-gap",
  )) {
    assert.deepEqual(
      observe(oracleCase.input),
      oracleCase.expected,
      oracleCase.caseId,
    );
  }
});

test("DB reaping never counts as whole-tree containment proof", async () => {
  const manifest = JSON.parse(await readFile(reaperUrl, "utf8"));
  const gap = manifest.cases.find(
    ({ caseId }) => caseId === "v0-reaper.os-descendant-gap",
  );
  assert.equal(gap.expected.productionContainment, false);
  assert.equal(gap.expected.qualification, "known-false-green-to-fix");
});
