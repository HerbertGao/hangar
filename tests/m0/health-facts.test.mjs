import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const healthUrl = new URL(
  "../../contracts/v2/control/health.json",
  import.meta.url,
);

function validSequence(manifest, facts) {
  const terminal = facts.filter((kind) =>
    manifest.terminalKinds.includes(kind),
  );
  if (terminal.length !== 1) return false;
  const invoked = facts.indexOf("invoked");
  if (invoked >= 0 && invoked !== 0) return false;
  const degraded = facts.indexOf("degraded");
  if (degraded >= 0 && invoked < 0) return false;
  if (facts.filter((kind) => kind === "invoked").length > 1) return false;
  if (facts.filter((kind) => kind === "degraded").length > 1) return false;
  return facts.at(-1) === terminal[0];
}

test.scenarios(
  [
    "v2c.health-facts.case-0d9643ce87048dd1",
    "v2c.health-facts.case-2b4ea87746cb91bc",
    "v2c.health-facts.case-a635871d9e818d72",
    "v2c.health-facts.case-f3612354bebfb68b"
  ],
  "health sequences preserve invocation order and exactly one terminal fact", async () => {
  const manifest = JSON.parse(await readFile(healthUrl, "utf8"));
  assert.deepEqual(manifest.factKinds, [
    "invoked",
    "produced",
    "skipped",
    "degraded",
    "failed",
  ]);
  for (const sequence of manifest.sequences)
    assert.equal(validSequence(manifest, sequence.facts), true, sequence.id);
  for (const invalid of [
    ["invoked"],
    ["produced", "failed"],
    ["degraded", "failed"],
    ["skipped", "invoked"],
    ["invoked", "invoked", "failed"],
  ]) {
    assert.equal(validSequence(manifest, invalid), false);
  }
});

test("liveness, readiness, and outcome remain distinct assertions", async () => {
  const manifest = JSON.parse(await readFile(healthUrl, "utf8"));
  assert.deepEqual(manifest.assertionKinds, [
    "liveness",
    "readiness",
    "outcome",
  ]);
  assert.equal(manifest.rules.producedCountMinimum, 1);
  assert.equal(manifest.rules.declaredSubjectRequiresActionId, true);
});
