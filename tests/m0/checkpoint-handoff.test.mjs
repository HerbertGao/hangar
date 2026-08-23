import assert from "node:assert/strict";
import test from "node:test";

import { resolveOwnerChain } from "./helpers.mjs";

const reference = {
  kind: "effect",
  subjectId: "effect-1",
  subjectGeneration: 0,
  ownerKind: "effect-gateway",
  ownerGeneration: 1,
};
const first = {
  kind: "effect",
  subjectId: "effect-1",
  subjectGeneration: 0,
  fromOwnerKind: "effect-gateway",
  fromOwnerGeneration: 1,
  toOwnerKind: "reconciliation",
  toOwnerGeneration: 2,
};

test("a unique immutable successor chain reaches the current owner", () => {
  assert.deepEqual(resolveOwnerChain(reference, [first]), {
    kind: "reconciliation",
    generation: 2,
  });
});

test("owner handoff branch and cycle fail closed", () => {
  assert.throws(
    () =>
      resolveOwnerChain(reference, [
        first,
        { ...first, toOwnerKind: "control", toOwnerGeneration: 2 },
      ]),
    (error) => error?.code === "owner_chain_branch",
  );
  assert.throws(
    () =>
      resolveOwnerChain(reference, [
        first,
        {
          ...first,
          fromOwnerKind: "reconciliation",
          fromOwnerGeneration: 2,
          toOwnerKind: "effect-gateway",
          toOwnerGeneration: 1,
        },
      ]),
    (error) => error?.code === "owner_chain_cycle",
  );
});

test("a transfer for another subject cannot satisfy this checkpoint", () => {
  assert.deepEqual(
    resolveOwnerChain(reference, [{ ...first, subjectId: "effect-other" }]),
    {
      kind: "effect-gateway",
      generation: 1,
    },
  );
});
