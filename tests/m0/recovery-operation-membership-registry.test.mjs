import assert from "node:assert/strict";
import test from "./scenario-owner.mjs";

function register(registry, operationId, membership) {
  const record = registry.get(operationId) ?? {
    sequence: 0,
    memberships: [],
    conflictGeneration: null,
  };
  if (record.conflictGeneration !== null) throw new Error("operation_fenced");
  record.sequence += 1;
  record.memberships.push({ ...membership, sequence: record.sequence });
  registry.set(operationId, record);
  return record.sequence;
}

function fenceConflict(registry, operationId, conflictingAgentId) {
  const record = registry.get(operationId);
  record.sequence += 1;
  record.conflictGeneration = record.sequence;
  record.consumers = [
    ...new Set([
      ...record.memberships.map(({ agentId }) => agentId),
      conflictingAgentId,
    ]),
  ].sort();
  return { generation: record.conflictGeneration, consumers: record.consumers };
}

test.scenarios(
  [
    "v2s.restore.case-b44252179c9e7a5d"
  ],
  "external membership registry freezes every historical/current consumer", () => {
  const registry = new Map();
  register(registry, "operation-1", {
    ownerAgentId: "agent-1",
    agentId: "agent-1",
    recoverySessionId: "session-1",
    targetControlInstanceId: "target-1",
    qualificationGeneration: 0,
  });
  register(registry, "operation-1", {
    ownerAgentId: "agent-1",
    agentId: "agent-1",
    recoverySessionId: "session-2",
    targetControlInstanceId: "target-2",
    qualificationGeneration: 1,
  });
  assert.deepEqual(fenceConflict(registry, "operation-1", "agent-2"), {
    generation: 3,
    consumers: ["agent-1", "agent-2"],
  });
  assert.throws(
    () => register(registry, "operation-1", { agentId: "agent-3" }),
    /operation_fenced/,
  );
});
