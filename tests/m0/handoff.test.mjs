import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const handoffUrl = new URL(
  "../../contracts/v2/storage/handoff.json",
  import.meta.url,
);

function promotable(manifest, obligations) {
  return obligations.every(
    ({ outcome, reconciliation }) =>
      manifest.promotionGate.allowedExternalOutcomes.includes(outcome) &&
      manifest.promotionGate.allowedReconciliationStates.includes(
        reconciliation,
      ),
  );
}

test.scenarios(
  [
    "v2s.handoff.case-68b0f65fa59604fb",
    "v2s.handoff.case-a31d079de80b5ba3"
  ],
  "handoff closes admission, revokes unstarted claims, and rejects stale epoch", async () => {
  const manifest = JSON.parse(await readFile(handoffUrl, "utf8"));
  assert.deepEqual(manifest.productionBarrier, {
    closeOldAdmission: true,
    revokeUnstartedClaims: true,
    rejectStaleEpochDispatch: true,
    scheduledMutationSupported: false,
  });
  assert.equal(manifest.rollback.higherEpochRequired, true);
  assert.equal(manifest.rollback.simultaneousOwners, false);
});

test.scenarios(
  [
    "m0o.cutover.case-e51c6241ea07084b",
    "v2c.effect.case-b451b3bac19d7219",
    "v2s.handoff.case-618f0232dee6c5fb"
  ],
  "unknown, pending, claimed, conflicted, and unresolved obligations block promotion", async () => {
  const manifest = JSON.parse(await readFile(handoffUrl, "utf8"));
  assert.equal(
    promotable(manifest, [
      { outcome: "committed", reconciliation: "resolved-committed" },
      { outcome: "not-committed", reconciliation: "resolved-not-committed" },
    ]),
    true,
  );
  for (const obligation of [
    { outcome: "unknown", reconciliation: "pending" },
    { outcome: "committed", reconciliation: "claimed" },
    { outcome: "conflicted", reconciliation: "unresolved" },
  ]) {
    assert.equal(promotable(manifest, [obligation]), false);
  }
});

test.scenarios(
  [
    "v2s.handoff.case-851d8da0cda9f610"
  ],
  "unknown Effect ownership may transfer but still blocks promotion", async () => {
  const manifest = JSON.parse(await readFile(handoffUrl, "utf8"));
  assert.equal(
    promotable(manifest, [{ outcome: "unknown", reconciliation: "pending" }]),
    false,
  );
  assert.equal(manifest.reconciliationTransfer.singleSuccessor, true);
  assert.equal(
    manifest.reconciliationTransfer.subjectGenerationImmutable,
    true,
  );
});

test("owner transfer never creates intent or dispatch authority", async () => {
  const manifest = JSON.parse(await readFile(handoffUrl, "utf8"));
  assert.equal(manifest.reconciliationTransfer.singleSuccessor, true);
  assert.equal(
    manifest.reconciliationTransfer.subjectGenerationImmutable,
    true,
  );
  assert.equal(manifest.reconciliationTransfer.createsEffectIntent, false);
  assert.equal(manifest.reconciliationTransfer.grantsDispatchAuthority, false);
});
