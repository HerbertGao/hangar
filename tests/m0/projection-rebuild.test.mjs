import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { canonicalDigest } from "../../scripts/validate-m0.mjs";

const rebuildUrl = new URL(
  "../../contracts/v2/storage/projection-rebuild.json",
  import.meta.url,
);
const sourceUrl = new URL(
  "../../contracts/v2/storage/source-facts.json",
  import.meta.url,
);

function append(previous, factKind, payload) {
  const fact = {
    databaseIdentity: "database-1",
    factSeq: previous ? previous.factSeq + 1 : 1,
    previousFactHash: previous ? previous.factHash : "0".repeat(64),
    factKind,
    schemaVersion: "v1",
    payload,
  };
  fact.factHash = canonicalDigest([
    "source-fact-v1",
    fact.databaseIdentity,
    fact.factSeq,
    fact.previousFactHash,
    fact.factKind,
    fact.schemaVersion,
    fact.payload,
  ]);
  return fact;
}

function rebuild(facts, allowedKinds) {
  const projection = new Map();
  let previous;
  for (const fact of facts) {
    if (fact.schemaVersion !== "v1")
      throw new Error("unsupported_fact_version");
    if (!allowedKinds.has(fact.factKind)) throw new Error("unknown_fact_kind");
    const expectedHash = canonicalDigest([
      "source-fact-v1",
      fact.databaseIdentity,
      fact.factSeq,
      fact.previousFactHash,
      fact.factKind,
      fact.schemaVersion,
      fact.payload,
    ]);
    if (
      fact.factSeq !== (previous?.factSeq ?? 0) + 1 ||
      fact.previousFactHash !== (previous?.factHash ?? "0".repeat(64)) ||
      fact.factHash !== expectedHash
    ) {
      throw new Error("fact_chain_invalid");
    }
    if (fact.factKind === "run-admitted")
      projection.set(fact.payload.runId, "running");
    if (fact.factKind === "run-terminal")
      projection.set(fact.payload.runId, fact.payload.state);
    previous = fact;
  }
  return projection;
}

test.scenarios(
  [
    "v2c.run.case-ec2c4c60bf3bed92",
    "v2s.projection-rebuild.case-b54e26fca3983bd7",
    "v2s.projection-rebuild.case-c046c9999f5ab2e8",
    "v2s.source-facts.case-ce3f2208e42495a3"
  ],
  "source fact replay deterministically rebuilds terminal Run projection", async () => {
  const source = JSON.parse(await readFile(sourceUrl, "utf8"));
  const first = append(null, "database-genesis", {});
  const second = append(first, "run-admitted", { runId: "run-1" });
  const third = append(second, "run-terminal", {
    runId: "run-1",
    state: "completed",
  });
  assert.equal(
    rebuild([first, second, third], new Set(source.factKinds)).get("run-1"),
    "completed",
  );
  assert.throws(
    () => rebuild([first, third], new Set(source.factKinds)),
    /fact_chain_invalid/,
  );
  assert.throws(
    () =>
      rebuild(
        [first, { ...second, payload: { runId: "tampered" } }],
        new Set(source.factKinds),
      ),
    /fact_chain_invalid/,
  );
  assert.throws(
    () =>
      rebuild(
        [first, { ...second, factKind: "future-fact" }],
        new Set(source.factKinds),
      ),
    /unknown_fact_kind/,
  );
  assert.throws(
    () =>
      rebuild(
        [first, { ...second, schemaVersion: "v-next" }],
        new Set(source.factKinds),
      ),
    /unsupported_fact_version/,
  );
});

test.scenarios(
  [
    "v2c.run.case-3d2ffc3684961b8b"
  ],
  "completion and cancellation commit one terminal fact", () => {
  const facts = [];
  let terminal = null;
  const terminalize = (commandId, state) => {
    if (terminal) return { kind: "terminal_conflict", winner: terminal.commandId };
    terminal = { commandId, state };
    facts.push({ kind: "run-terminal", state });
    return { kind: "committed", state };
  };
  assert.deepEqual(terminalize("complete-command", "completed"), {
    kind: "committed",
    state: "completed",
  });
  assert.deepEqual(terminalize("cancel-command", "cancelled"), {
    kind: "terminal_conflict",
    winner: "complete-command",
  });
  assert.deepEqual(facts, [{ kind: "run-terminal", state: "completed" }]);
});

test.scenarios(
  [
    "v2c.harness-session.case-04841c02ff8ac172",
    "v2s.source-facts.case-9426ccb80cf037a4"
  ],
  "receipt/reconciliation projection cannot rewrite terminal or schedule work", async () => {
  const manifest = JSON.parse(await readFile(rebuildUrl, "utf8"));
  assert.equal(manifest.receiptAndReconciliation.mayRewriteRunTerminal, false);
  assert.equal(manifest.receiptAndReconciliation.mayScheduleHarness, false);
  assert.equal(manifest.projectionAuthority, false);
});
