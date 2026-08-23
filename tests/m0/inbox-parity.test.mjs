import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const parityUrl = new URL(
  "../../oracles/m0/inbox-parity.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function custodyComplete(parity) {
  return parity.normalizedRequirements.every((normalized) => {
    const decisions = parity.ownerDecisions.filter(({ normalizedIds }) =>
      normalizedIds.includes(normalized.normalizedId),
    );
    return (
      decisions.length === 1 &&
      decisions[0].result === "approved" &&
      normalized.sourceIds.every((sourceId) =>
        decisions[0].sourceIds.includes(sourceId),
      ) &&
      (!normalized.hardGate ||
        parity.hardGateIds.includes(normalized.normalizedId))
    );
  });
}

test("frozen Inbox source denominator is complete and fully mapped", async () => {
  const parity = JSON.parse(await readFile(parityUrl, "utf8"));
  assert.ok(parity.sources.length > 0);
  assert.equal(
    new Set(parity.sources.map(({ sourceId }) => sourceId)).size,
    parity.sources.length,
  );
  assert.ok(
    parity.sources.every(
      ({ revision, path, title, headingDigest }) =>
        /^[0-9a-f]{40}$/.test(revision) &&
        headingDigest === sha256(`${path}\0${title}`),
    ),
  );
  assert.equal(
    parity.sourceDenominatorDigest,
    sha256(JSON.stringify(parity.sources)),
  );

  const mappingCounts = new Map(
    parity.sources.map(({ sourceId }) => [sourceId, 0]),
  );
  for (const normalized of parity.normalizedRequirements)
    for (const sourceId of normalized.sourceIds)
      mappingCounts.set(sourceId, mappingCounts.get(sourceId) + 1);
  assert.ok([...mappingCounts.values()].every((count) => count === 1));
  assert.equal(
    parity.normalizedDenominatorDigest,
    sha256(JSON.stringify(parity.normalizedRequirements)),
  );
});

test.scenarios(
  ["m0o.inbox.case-b167e32ec41cdea6"],
  "a split or merge without its owner custody decision fails",
  async () => {
    const parity = JSON.parse(await readFile(parityUrl, "utf8"));
    assert.equal(custodyComplete(parity), true);
    const withoutMergeDecision = structuredClone(parity);
    const index = withoutMergeDecision.ownerDecisions.findIndex(
      ({ kind }) => kind === "merge",
    );
    withoutMergeDecision.ownerDecisions.splice(index, 1);
    assert.equal(custodyComplete(withoutMergeDecision), false);
  },
);

test.scenarios(
  ["m0o.inbox.case-37053fffaf6f642b"],
  "five owner safety gates are non-weakenable and every split/merge is approved",
  async () => {
    const parity = JSON.parse(await readFile(parityUrl, "utf8"));
    assert.deepEqual(parity.hardGateIds, [
      "inbox.hard.no-auto-send",
      "inbox.hard.no-sensitive-auto-read",
      "inbox.hard.low-confidence-safe-default",
      "inbox.hard.dedup-no-duplicate-effect",
      "inbox.hard.credentials-no-leak",
    ]);
    for (const id of parity.hardGateIds) {
      const record = parity.normalizedRequirements.find(
        ({ normalizedId }) => normalizedId === id,
      );
      assert.equal(record.hardGate, true);
      assert.ok(record.weight >= 10);
      assert.ok(record.expected);
    }
    assert.ok(
      parity.ownerDecisions.every(
        ({ owner, result, kind }) =>
          owner === "inbox-owner" &&
          result === "approved" &&
          ["one-to-one", "merge"].includes(kind),
      ),
    );
    assert.equal(
      parity.ownerDecisionDigest,
      sha256(JSON.stringify(parity.ownerDecisions)),
    );
    assert.deepEqual(parity.unresolvedConflicts, []);
  },
);
