import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "./scenario-owner.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function accept(store, intent) {
  if (typeof intent.operation !== "string" || !intent.operation)
    throw new Error("single_operation_required");
  const key = `${intent.runId}\0${intent.intentKey}\0${intent.intentGeneration}`;
  const binding = JSON.stringify({
    operation: intent.operation,
    intentDigest: intent.intentDigest,
  });
  const previous = store.get(key);
  if (previous) {
    if (previous.binding !== binding) return { kind: "idempotency_conflict" };
    return previous.effect;
  }
  const effect = {
    effectId: sha256(`effect\0${key}`),
    runId: intent.runId,
    intentKey: intent.intentKey,
    intentGeneration: intent.intentGeneration,
    operation: intent.operation,
    intentDigest: intent.intentDigest,
    firstOriginRunAttempt: intent.originRunAttempt,
    firstOriginActionId: intent.originActionId,
  };
  store.set(key, { binding, effect });
  return effect;
}

test.scenarios(
  [
    "v2c.effect.case-5a2152bf98f8ad78",
    "v2c.effect.case-c5b2cb70424e191d",
    "v2s.ddl.case-a96c8105eaddf6f0"
  ],
  "same Run intent generation replays one Effect across RunAttempts", () => {
  const store = new Map();
  const original = {
    runId: "run-1",
    intentKey: "intent-a",
    intentGeneration: 0,
    operation: "operation-a",
    intentDigest: "a".repeat(64),
    originRunAttempt: 1,
    originActionId: "action-1",
  };
  const first = accept(store, original);
  const replay = accept(store, {
    ...original,
    originRunAttempt: 2,
    originActionId: "action-2",
  });
  assert.deepEqual(replay, first);
  assert.equal(replay.firstOriginRunAttempt, 1);
  assert.equal(replay.firstOriginActionId, "action-1");
  assert.equal(store.size, 1);
});

test.scenarios(
  [
    "v2c.effect.case-3c81cfa02aa23d2b"
  ],
  "operation/digest conflict rejects and explicit next generation creates a new Effect", () => {
  const store = new Map();
  const original = {
    runId: "run-1",
    intentKey: "intent-a",
    intentGeneration: 0,
    operation: "operation-a",
    intentDigest: "a".repeat(64),
    originRunAttempt: 1,
    originActionId: "action-1",
  };
  const first = accept(store, original);
  assert.deepEqual(accept(store, { ...original, operation: "operation-b" }), {
    kind: "idempotency_conflict",
  });
  const next = accept(store, {
    ...original,
    intentGeneration: 1,
    originRunAttempt: 2,
  });
  assert.notEqual(next.effectId, first.effectId);
  assert.equal(store.size, 2);
});
