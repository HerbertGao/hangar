import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { machineCell } from "./helpers.mjs";

const effectUrl = new URL(
  "../../contracts/v2/control/effect.json",
  import.meta.url,
);
const statesUrl = new URL(
  "../../contracts/v2/control/effect-state-machines.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.effect.case-eb9596718e63e1e7"
  ],
  "Effect lifecycle has one operation and a single gateway dispatch owner", async () => {
  const [effect, states] = await Promise.all([
    readFile(effectUrl, "utf8").then(JSON.parse),
    readFile(statesUrl, "utf8").then(JSON.parse),
  ]);
  assert.equal(effect.identity.singleOperation, true);
  assert.equal(effect.identity.firstOriginImmutable, true);
  assert.equal(effect.dispatch.owner, "effect-gateway");
  assert.equal(effect.claim.singleUse, true);
  assert.equal(effect.claim.clientVisible, false);
  assert.ok(effect.dispatch.requiredBindings.includes("attestationGeneration"));
  assert.equal(
    machineCell(states, "Effect", "claimed", "start-dispatch").nextState,
    "dispatch-started",
  );
});

test("ambiguous dispatch becomes unknown and never automatically redispatches", async () => {
  const [effect, states] = await Promise.all([
    readFile(effectUrl, "utf8").then(JSON.parse),
    readFile(statesUrl, "utf8").then(JSON.parse),
  ]);
  const ambiguous = machineCell(
    states,
    "Effect",
    "dispatch-started",
    "dispatch-ambiguous",
  );
  assert.equal(ambiguous.nextState, "unknown");
  assert.equal(ambiguous.automaticRedispatch, false);
  assert.equal(
    machineCell(states, "Effect", "unknown", "start-dispatch").kind,
    "reject",
  );
  assert.equal(effect.dispatch.unknownAutomaticRedispatch, false);
  assert.equal(effect.reconciliation.redispatch, false);
});

test.scenarios(
  [
    "v2c.effect.case-06f29d5923eb27ff",
    "v2c.effect.case-21e1b4425801e363",
    "v2c.effect.case-787f5219b6462e71",
    "v2s.restore.case-b41e629410d6bd72",
    "v2s.source-facts.case-228708d02b4f7b72"
  ],
  "receipt and reconciliation require authority proof and may finalize without receipt", async () => {
  const effect = JSON.parse(await readFile(effectUrl, "utf8"));
  assert.deepEqual(effect.authorityProofFields, [
    "authorityId",
    "authorityVersion",
    "authorityGeneration",
    "authenticationEvidenceDigest",
    "proofRef",
  ]);
  assert.equal(effect.receipt.requiresDispatchStarted, true);
  assert.equal(effect.reconciliation.receiptOptional, true);
  assert.equal(effect.reconciliation.notCommittedWithoutReceipt, true);
  assert.equal(effect.reconciliation.conflictResolutionRequiresCompleteEvidenceSet, true);
  assert.equal(effect.receipt.exactReplay, "existing-receipt");
  assert.equal(effect.receipt.conflictingReplay, "conflicted");
  assert.equal(effect.postFinalConflict.appendOnly, true);
  assert.deepEqual(effect.postFinalConflict.reopenAs, [
    "conflicted",
    "unresolved",
  ]);
  assert.equal(effect.postFinalConflict.quarantineActivation, true);
  assert.equal(effect.postFinalConflict.revokeMutationAuthority, true);
  assert.equal(effect.postFinalConflict.redispatch, false);
});
