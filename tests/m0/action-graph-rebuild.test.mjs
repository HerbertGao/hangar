import assert from "node:assert/strict";
import test from "node:test";

function rebuild(records) {
  const actions = new Map();
  const checkpoints = new Map();
  const effects = new Map();
  for (const record of records) {
    if (record.kind === "action") {
      if (
        actions.has(record.actionId) ||
        (record.parentActionId && !actions.has(record.parentActionId))
      ) {
        throw new Error("invalid_action_graph");
      }
      actions.set(record.actionId, record);
    } else if (record.kind === "checkpoint") {
      const producer = actions.get(record.producerActionId);
      if (!producer || producer.originAttempt !== record.producerAttempt)
        throw new Error("invalid_checkpoint_producer");
      checkpoints.set(record.checkpointId, record);
    } else if (record.kind === "effect") {
      const origin = actions.get(record.firstOriginActionId);
      if (!origin || origin.originAttempt !== record.firstOriginAttempt)
        throw new Error("invalid_effect_origin");
      const previous = effects.get(record.effectId);
      if (
        previous &&
        (previous.firstOriginActionId !== record.firstOriginActionId ||
          previous.firstOriginAttempt !== record.firstOriginAttempt)
      ) {
        throw new Error("effect_origin_conflict");
      }
      effects.set(record.effectId, record);
    }
  }
  return { actions, checkpoints, effects };
}

test("parent-linked action/checkpoint/effect projection rebuilds from ordered facts", () => {
  const result = rebuild([
    { kind: "action", actionId: "a", parentActionId: null, originAttempt: 0 },
    { kind: "action", actionId: "b", parentActionId: "a", originAttempt: 0 },
    {
      kind: "checkpoint",
      checkpointId: "c",
      producerActionId: "b",
      producerAttempt: 0,
    },
    {
      kind: "effect",
      effectId: "e",
      firstOriginActionId: "b",
      firstOriginAttempt: 0,
    },
  ]);
  assert.equal(result.actions.get("b").parentActionId, "a");
  assert.equal(result.checkpoints.get("c").producerActionId, "b");
  assert.equal(result.effects.get("e").firstOriginActionId, "b");
});

test("dangling parent, producer mismatch, and first-origin conflict stop rebuild", () => {
  assert.throws(
    () =>
      rebuild([
        {
          kind: "action",
          actionId: "b",
          parentActionId: "a",
          originAttempt: 0,
        },
      ]),
    /invalid_action_graph/,
  );
  assert.throws(
    () =>
      rebuild([
        {
          kind: "action",
          actionId: "a",
          parentActionId: null,
          originAttempt: 0,
        },
        {
          kind: "checkpoint",
          checkpointId: "c",
          producerActionId: "a",
          producerAttempt: 1,
        },
      ]),
    /invalid_checkpoint_producer/,
  );
  assert.throws(
    () =>
      rebuild([
        {
          kind: "action",
          actionId: "a",
          parentActionId: null,
          originAttempt: 0,
        },
        {
          kind: "action",
          actionId: "b",
          parentActionId: null,
          originAttempt: 0,
        },
        {
          kind: "effect",
          effectId: "e",
          firstOriginActionId: "a",
          firstOriginAttempt: 0,
        },
        {
          kind: "effect",
          effectId: "e",
          firstOriginActionId: "b",
          firstOriginAttempt: 0,
        },
      ]),
    /effect_origin_conflict/,
  );
});
