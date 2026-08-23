import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { evaluateTrustedTime, isExpired } from "../../scripts/validate-m0.mjs";

const timeUrl = new URL(
  "../../contracts/v2/control/time.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.time.case-883b1bf6cd8950c3",
    "v2c.time.case-9a9be5874a6bcccc"
  ],
  "trusted time vectors cover equality, forward, skew, and rollback", async () => {
  const manifest = JSON.parse(await readFile(timeUrl, "utf8"));
  for (const vector of manifest.vectors) {
    if (vector.id === "expiry-equality") {
      assert.equal(
        isExpired(vector.nowUtcMs, vector.expiryUtcMs),
        vector.expired,
      );
    } else {
      assert.deepEqual(
        evaluateTrustedTime(vector.input),
        vector.expected,
        vector.id,
      );
    }
  }
  assert.equal(isExpired(999, 1000), false);
  assert.equal(isExpired(1001, 1000), true);
});

test.scenarios(
  [
    "v2c.time.case-7b31ba4290763ede"
  ],
  "elapsed deadlines remain startup-cycle monotonic", async () => {
  const manifest = JSON.parse(await readFile(timeUrl, "utf8"));
  assert.equal(manifest.elapsedBudget.clock, "startup-cycle-monotonic");
  assert.equal(manifest.elapsedBudget.wallClockReconstruction, false);
  assert.deepEqual(
    manifest.evidenceStages.map(({ id }) => id),
    ["command-preflight", "recovery-session", "recovery-agent-attempt"],
  );
  for (const stage of manifest.evidenceStages) {
    assert.ok(stage.binding.includes("bootId"));
    assert.ok(stage.binding.includes("startupCycleId"));
    assert.ok(stage.binding.includes("clockGeneration"));
  }
});

test("unsafe or ambiguous time input fails closed", () => {
  for (const input of [
    { sampleUtcMs: 1.5, priorWatermarkUtcMs: 1, maxBackwardSkewMs: 0 },
    { sampleUtcMs: 1, priorWatermarkUtcMs: 1, maxBackwardSkewMs: -1 },
    {
      sampleUtcMs: Number.MAX_SAFE_INTEGER + 1,
      priorWatermarkUtcMs: 1,
      maxBackwardSkewMs: 0,
    },
  ]) {
    assert.throws(
      () => evaluateTrustedTime(input),
      (error) => error?.code === "invalid_time",
    );
  }
});
