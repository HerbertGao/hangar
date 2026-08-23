import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ledgerUrl = new URL("../../oracles/m0/v0-ledger.json", import.meta.url);
const sourcesUrl = new URL("../../oracles/m0/sources.json", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("every frozen v0 behavior has an explicit owner disposition", async () => {
  const [ledger, sources] = await Promise.all([
    readFile(ledgerUrl, "utf8").then(JSON.parse),
    readFile(sourcesUrl, "utf8").then(JSON.parse),
  ]);
  const main = sources.repositories.find(
    ({ id }) => id === ledger.sourceRepositoryId,
  );
  assert.equal(ledger.sourceRevision, main.revision);
  assert.deepEqual(ledger.allowedDispositions, [
    "preserve",
    "known-false-green-to-fix",
    "excluded",
  ]);
  assert.ok(ledger.denominator.length > 0);
  assert.equal(
    new Set(ledger.denominator.map(({ sourceId }) => sourceId)).size,
    ledger.denominator.length,
  );
  assert.equal(
    ledger.denominatorDigest,
    sha256(JSON.stringify(ledger.denominator)),
  );

  const sourceIds = new Set(ledger.denominator.map(({ sourceId }) => sourceId));
  const covered = new Set();
  const decisionIds = new Set();
  const behaviorKeys = new Set();
  for (const decision of ledger.decisions) {
    assert.ok(sourceIds.has(decision.sourceId));
    assert.ok(ledger.allowedDispositions.includes(decision.disposition));
    assert.equal(decision.owner, "hangar-owner");
    assert.ok(
      decision.ownerRequirementId &&
        decision.reasonCode &&
        decision.reason &&
        decision.behavior,
    );
    assert.ok(!decisionIds.has(decision.decisionId));
    const behaviorKey = `${decision.sourceId}\0${decision.behavior}`;
    assert.ok(!behaviorKeys.has(behaviorKey));
    decisionIds.add(decision.decisionId);
    behaviorKeys.add(behaviorKey);
    covered.add(decision.sourceId);
  }
  assert.deepEqual(covered, sourceIds);
  assert.equal(ledger.decisionDigest, sha256(JSON.stringify(ledger.decisions)));
  assert.deepEqual(
    new Set(ledger.decisions.map(({ disposition }) => disposition)),
    new Set(ledger.allowedDispositions),
  );
  assert.ok(!JSON.stringify(ledger).includes("undecided"));
});
