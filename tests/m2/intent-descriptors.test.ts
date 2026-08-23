import assert from "node:assert/strict";
import test from "../m0/scenario-owner.mjs";
import {
  compileRelease,
  digestJson,
  validateControlMetadataInput,
  verifyRelease,
  type AgentSpec,
  type ExecutionClosure,
  type IntentDescriptor,
} from "../../packages/contracts/index.ts";

const inputSchema = {
  id: "intent-input",
  version: "1",
  digest: "a".repeat(64),
};
const resultSchema = {
  id: "intent-result",
  version: "1",
  digest: "b".repeat(64),
};
const descriptor: IntentDescriptor = {
  intentId: "emit-heartbeat",
  descriptorVersion: 1,
  inputSchema,
  scope: "run-emit",
  policyId: "policy-shadow-only",
  resultSchema,
};

const spec: AgentSpec = {
  agentId: "agent-heartbeat",
  goal: "emit one heartbeat artifact",
  harnessKind: "fake",
  checkpointSchema: "heartbeat-checkpoint-v1",
  // Domain-scoped tool grants only: none of these are host filesystem tools.
  capabilities: ["tool.read", "artifact.write"],
  effectOperations: ["fixture.commit"],
  intentDescriptors: [descriptor],
};
const closure: ExecutionClosure = {
  entryId: "heartbeat-entry",
  executable: process.execPath,
  executableDigest: "c".repeat(64),
  members: [{ id: "contracts", digest: "d".repeat(64) }],
};

const value = <T>(
  result: ReturnType<typeof validateControlMetadataInput>,
): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value as T;
};

test.scenarios(
  ["m0o.reproducibility.case-4704830eebf87e0f"],
  "descriptor version, schema digest, scope, or policy change forces a new releaseId",
  () => {
    const base = compileRelease(spec, closure);
    const drifts: readonly AgentSpec[] = [
      {
        ...spec,
        intentDescriptors: [{ ...descriptor, descriptorVersion: 2 }],
      },
      {
        ...spec,
        intentDescriptors: [
          {
            ...descriptor,
            inputSchema: { ...inputSchema, digest: "e".repeat(64) },
          },
        ],
      },
      { ...spec, intentDescriptors: [{ ...descriptor, scope: "run-emit-v2" }] },
      {
        ...spec,
        intentDescriptors: [
          { ...descriptor, policyId: "policy-production-gated" },
        ],
      },
    ];
    for (const drifted of drifts)
      assert.notEqual(
        compileRelease(drifted, closure).releaseId,
        base.releaseId,
      );
    // Unrelated spec order must not matter; identical descriptors reproduce id.
    const reordered = compileRelease(
      { ...spec, capabilities: [...spec.capabilities].reverse() },
      closure,
    );
    assert.equal(reordered.releaseId, base.releaseId);
    assert.equal(verifyRelease(base), true);
  },
);

test.scenarios(
  ["m0o.reproducibility.case-4704830eebf87e0f"],
  "control-metadata input rejects bodies, secrets, and runtime-only fields",
  () => {
    value(
      validateControlMetadataInput({
        executionClass: "shadow-evaluator",
        trigger: "manual-run",
      }),
    );
    const rejected: readonly unknown[] = [
      // extra body/runtime-only keys outside the closed set
      { executionClass: "shadow-evaluator", trigger: "t", promptBody: "hi" },
      { executionClass: "shadow-evaluator", trigger: "t", runtimeState: {} },
      // missing required selection
      { trigger: "t" },
      // nested payload instead of scalar metadata
      { executionClass: "shadow-evaluator", trigger: { id: "t" } },
      // array-shaped body
      ["shadow-evaluator", "t"],
      // unknown execution class
      { executionClass: "yolo", trigger: "t" },
      // invalid identifier characters
      { executionClass: "production", trigger: "bad trigger!" },
    ];
    for (const candidate of rejected)
      assert.equal(validateControlMetadataInput(candidate).ok, false);
  },
);

test.scenarios(
  ["m0o.reproducibility.case-4704830eebf87e0f"],
  "v1 release bytes verify under v1 rules and are never reinterpreted by the v2 compiler",
  () => {
    const v1Spec = {
      agentId: "agent-heartbeat",
      goal: "emit one heartbeat artifact",
      harnessKind: "fake",
      checkpointSchema: "heartbeat-checkpoint-v1",
      capabilities: ["tool.read"],
      effectOperations: ["fixture.commit"],
    };
    const v1Unsigned = {
      schemaVersion: "agent-release-v1" as const,
      canonicalizationVersion: "json-safe-v1" as const,
      hashAlgorithm: "sha256" as const,
      spec: v1Spec,
      closure,
      trustedDirectEffects: [] as readonly never[],
    };
    const v1Release = {
      ...v1Unsigned,
      releaseId: digestJson(v1Unsigned),
    };
    assert.equal(verifyRelease(v1Release as never), true);
    // A tampered v1 spec carrying a descriptor field is rejected outright:
    // the v2 compiler must not reinterpret v1 bytes as descriptor-bearing.
    const smuggled = {
      ...v1Release,
      spec: { ...v1Spec, intentDescriptors: [descriptor] },
    };
    assert.equal(verifyRelease(smuggled as never), false);
    // Unknown schema versions are refused, not parsed leniently.
    const future = { ...v1Release, schemaVersion: "agent-release-v99" };
    assert.equal(verifyRelease(future as never), false);
    // Descriptor-less v2 specs stay verifiable and distinct from the v1 id.
    const v2Empty = compileRelease({ ...spec, intentDescriptors: [] }, closure);
    assert.equal(verifyRelease(v2Empty), true);
    assert.notEqual(v2Empty.releaseId, v1Release.releaseId);
  },
);

test.scenarios(
  ["m0o.reproducibility.case-4704830eebf87e0f"],
  "heartbeat-style fixtures declare no host filesystem tools",
  () => {
    const hostFsTools = ["bash", "edit", "write", "read"];
    for (const capability of spec.capabilities)
      assert.equal(hostFsTools.includes(capability), false, capability);
    for (const descriptor of spec.intentDescriptors) {
      assert.ok(/^[A-Za-z0-9_-]+$/.test(descriptor.intentId));
      assert.match(descriptor.policyId, /^policy-/);
    }
  },
);
