import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const cutoverUrl = new URL("../../oracles/m0/cutover.json", import.meta.url);

function barriersClosed(input) {
  return input.cronClosed && input.manualClosed && input.intentClosed;
}

test.scenarios(
  [
    "m0o.cutover.case-9eac66f310b04558"
  ],
  "enabled false alone is not a cutover barrier", async () => {
  const manifest = JSON.parse(await readFile(cutoverUrl, "utf8"));
  const oracleCase = manifest.cases.find(
    ({ caseId }) => caseId === "cutover.enabled-false-only",
  );
  assert.equal(barriersClosed(oracleCase.input), false);
  assert.equal(oracleCase.expected, "contract_failure");
  assert.deepEqual(manifest.barriers, ["cron", "manual", "intent"]);
});

test.scenarios(
  [
    "m0o.cutover.case-f9f459fef4ce8b63",
    "v2c.activation.case-b2bbbf398a04a7b4",
    "v2s.ddl.case-bb747119f22de9e8"
  ],
  "cutover crash has zero or one owner, never two", async () => {
  const manifest = JSON.parse(await readFile(cutoverUrl, "utf8"));
  assert.equal(manifest.dualReadAllowed, true);
  assert.equal(manifest.dualWriteAllowed, false);
  assert.equal(manifest.dualAdmissionAllowed, false);
  assert.equal(
    manifest.cases.find(
      ({ caseId }) => caseId === "cutover.crash-before-promotion",
    ).expectedProductionOwners,
    0,
  );
  assert.equal(
    manifest.cases.find(({ caseId }) => caseId === "cutover.unknown-effect")
      .expected,
    "promotion-blocked",
  );
  assert.equal(
    manifest.cases.find(({ caseId }) => caseId === "cutover.stale-epoch")
      .expected,
    "stale_epoch",
  );
});
