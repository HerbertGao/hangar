import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const sourceFactsUrl = new URL(
  "../../contracts/v2/storage/source-facts.json",
  import.meta.url,
);

function cell(lifecycle, state, event) {
  const matches = lifecycle.table.filter(
    (entry) => entry.state === state && entry.event === event,
  );
  assert.equal(matches.length, 1);
  return matches[0].outcome;
}

test.scenarios(
  [
    "v2s.source-facts.case-6777c69a705f989d",
    "v2s.source-facts.case-cbe14e90f7c830d4"
  ],
  "RecoveryDiscoveredOperation lifecycle is exhaustive and non-dispatching", async () => {
  const manifest = JSON.parse(await readFile(sourceFactsUrl, "utf8"));
  const lifecycle = manifest.recoveryOperation.lifecycle;
  assert.equal(
    lifecycle.table.length,
    lifecycle.states.length * lifecycle.events.length,
  );
  assert.equal(
    cell(lifecycle, "unknown-pending", "claim").nextState,
    "unknown-claimed",
  );
  assert.equal(
    cell(lifecycle, "unknown-claimed", "observe-committed").nextState,
    "committed-resolved",
  );
  assert.equal(
    cell(lifecycle, "conflicted-unresolved", "resolve-not-committed").nextState,
    "not-committed-resolved",
  );
  assert.equal(
    cell(lifecycle, "unknown-claimed", "observe-conflict").nextState,
    "conflicted-unresolved",
  );
  assert.equal(
    cell(lifecycle, "committed-resolved", "post-final-conflict").nextState,
    "conflicted-unresolved",
  );
  assert.equal(
    cell(lifecycle, "committed-resolved", "post-final-conflict").factKind,
    "recovery-post-final-conflict",
  );
  assert.equal(cell(lifecycle, "unknown-pending", "replay").kind, "idempotent");
  assert.equal(
    cell(lifecycle, "conflicted-unresolved", "replay").nextState,
    "conflicted-unresolved",
  );
  assert.equal(manifest.recoveryOperation.dispatchAuthority, false);
  assert.equal(manifest.recoveryOperation.effectIdentity, false);
});
