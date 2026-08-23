import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

function denominator(restored, enumerated, discovered) {
  return new Set([...restored, ...enumerated, ...discovered]);
}

test.scenarios(
  [
    "v2s.restore.case-200a3a215b8df2f9",
    "v2s.restore.case-875c30fd430746cf",
    "v2s.restore.case-db75b8ca6e733373"
  ],
  "dispatch denominator is the exact union and every member must be final", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  assert.equal(manifest.dispatchDenominator.setOperation, "union");
  const members = denominator(
    ["local-1"],
    ["local-1", "external-2"],
    ["external-2"],
  );
  assert.deepEqual([...members].sort(), ["external-2", "local-1"]);
  const outcomes = new Map([
    ["local-1", "committed"],
    ["external-2", "unknown"],
  ]);
  assert.equal(
    [...members].every((id) =>
      manifest.dispatchDenominator.finalOutcomes.includes(outcomes.get(id)),
    ),
    false,
  );
  outcomes.set("external-2", "not-committed");
  assert.equal(
    [...members].every((id) =>
      manifest.dispatchDenominator.finalOutcomes.includes(outcomes.get(id)),
    ),
    true,
  );
  assert.equal(
    manifest.dispatchDenominator.finiteAuthenticatedWatermarkRequired,
    true,
  );
});
