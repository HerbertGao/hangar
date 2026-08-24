import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ErrorKind =
  | "invalid_input"
  | "not_found"
  | "invalid_state"
  | "idempotency_conflict"
  | "stale_attempt"
  | "stale_epoch"
  | "stale_authority"
  | "terminal_conflict"
  | "unknown_effect";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorKind };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: ErrorKind): Result<T> => ({
  ok: false,
  error,
});

export interface SchemaRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface IntentDescriptor {
  readonly intentId: string;
  readonly descriptorVersion: number;
  readonly inputSchema: SchemaRef;
  readonly scope: string;
  readonly policyId: string;
  readonly resultSchema: SchemaRef;
}

export interface AgentSpec {
  readonly agentId: string;
  readonly goal: string;
  readonly harnessKind: "fake" | "legacy-process";
  readonly checkpointSchema: string;
  readonly capabilities: readonly string[];
  readonly effectOperations: readonly string[];
  readonly intentDescriptors: readonly IntentDescriptor[];
}

export interface ExecutionClosureMember {
  readonly id: string;
  readonly digest: string;
}

export interface ExecutionClosure {
  readonly entryId: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly members: readonly ExecutionClosureMember[];
}

export interface AgentRelease {
  readonly schemaVersion: "agent-release-v1" | "agent-release-v2";
  readonly canonicalizationVersion: "json-safe-v1";
  readonly hashAlgorithm: "sha256";
  readonly releaseId: string;
  readonly spec: AgentSpec;
  readonly closure: ExecutionClosure;
  readonly trustedDirectEffects: readonly never[];
}

export interface CommandMeta {
  readonly actorSubjectId: string;
  readonly commandKind: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly precondition: JsonValue;
  readonly preconditionDigest: string;
}

export type RunState =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type AttemptState =
  | "running"
  | "checkpointed"
  | "succeeded"
  | "failed"
  | "cancelled";
export type EffectState =
  | "pending"
  | "approved"
  | "claimed"
  | "dispatch-started"
  | "unknown"
  | "committed"
  | "not-committed";

export interface AttemptToken {
  readonly runId: string;
  readonly attempt: number;
  readonly sessionId: string;
  readonly generation: number;
}

export interface ActionInput {
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly kind: "tool" | "subagent" | "provider";
  readonly inputDigest: string;
}

export interface ToolObservationInput {
  readonly actionId: string;
  readonly toolId: string;
  readonly outputDigest: string;
  readonly grantGeneration: number;
}

export interface EffectApprovalInput {
  readonly decision: "approved";
  readonly releaseId: string;
  readonly activationEpoch: number;
  readonly expiresAtUnixMs: number;
}

export interface EffectIntentInput {
  readonly effectId: string;
  readonly actionId: string;
  readonly intentKey: string;
  readonly intentGeneration: number;
  readonly operation: string;
  readonly payloadDigest: string;
}

export interface CheckpointInput {
  readonly checkpointId: string;
  readonly producerActionId: string;
  readonly schema: string;
  readonly artifactDigest: string;
  readonly obligationOwner: "control-core" | "effect-gateway";
  readonly obligationGeneration: number;
  readonly effectId?: string;
}

export interface OutcomeProposalInput {
  readonly artifactDigest: string;
}

export type HarnessInput =
  | { readonly type: "action"; readonly action: ActionInput }
  | {
      readonly type: "tool-observation";
      readonly observation: ToolObservationInput;
    }
  | { readonly type: "effect-intent"; readonly effect: EffectIntentInput }
  | { readonly type: "checkpoint"; readonly checkpoint: CheckpointInput }
  | {
      readonly type: "outcome-proposal";
      readonly proposal: OutcomeProposalInput;
    };

export interface ProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startFingerprint: string;
  readonly containmentGeneration: number;
}

export interface RunView {
  readonly runId: string;
  readonly agentId: string;
  readonly releaseId: string;
  readonly activationEpoch: number;
  readonly state: RunState;
  readonly currentAttempt: number;
  readonly attemptState: AttemptState;
  readonly actions: readonly string[];
  readonly toolObservations: readonly ToolObservationInput[];
  readonly effects: Readonly<Record<string, EffectState>>;
  readonly checkpointId?: string;
  readonly outcomeArtifactDigest?: string;
  readonly process?: ProcessIdentity;
  readonly containmentReaped: boolean;
  readonly grantRevoked: boolean;
}

export interface SourceFact {
  readonly factSeq: number;
  readonly aggregateId: string;
  readonly factKind: string;
  readonly previousHash: string;
  readonly factHash: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function assertRecord(
  value: unknown,
  fields: readonly string[],
  subject: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")
  )
    throw new TypeError(`invalid_${subject}`);
}

function assertString(
  value: unknown,
  subject: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`invalid_${subject}`);
}

function assertStringList(
  value: unknown,
  subject: string,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  )
    throw new TypeError(`invalid_${subject}`);
}

export const CONTROL_METADATA_KEYS = ["trigger"] as const;

const ASCII_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Validates an intent input against the closed control-metadata contract:
 * exactly the declared keys, scalar values only, so inputs stay atomically
 * persistable with admission facts and can never carry bodies, secrets,
 * artifact payloads, or runtime-only data. Execution mode is selected by the
 * dedicated wire field, never duplicated inside the metadata.
 */
export function validateControlMetadataInput(
  value: unknown,
): Result<
  Readonly<Record<(typeof CONTROL_METADATA_KEYS)[number], JsonPrimitive>>
> {
  const failInput = (): Result<
    Readonly<Record<(typeof CONTROL_METADATA_KEYS)[number], JsonPrimitive>>
  > => fail("invalid_input");
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return failInput();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    [...CONTROL_METADATA_KEYS].sort().join("\0")
  )
    return failInput();
  const trigger = record.trigger;
  if (typeof trigger !== "string" || !ASCII_ID.test(trigger))
    return failInput();
  return ok({ trigger });
}

function assertSchemaRef(
  input: unknown,
  subject: string,
): asserts input is SchemaRef {
  assertRecord(input, ["id", "version", "digest"], subject);
  // SAFETY: assertRecord just verified the exact {id,version,digest} key set,
  // so each member holds the SchemaRef-declared primitive types.
  const ref = input as unknown as SchemaRef;
  if (!ASCII_ID.test(ref.id)) throw new TypeError(`invalid_${subject}_id`);
  if (!ASCII_ID.test(ref.version))
    throw new TypeError(`invalid_${subject}_version`);
  if (!HEX_64.test(ref.digest))
    throw new TypeError(`invalid_${subject}_digest`);
}

function assertIntentDescriptor(
  input: unknown,
): asserts input is IntentDescriptor {
  assertRecord(
    input,
    [
      "intentId",
      "descriptorVersion",
      "inputSchema",
      "scope",
      "policyId",
      "resultSchema",
    ],
    "intent_descriptor",
  );
  // SAFETY: assertRecord just verified the exact IntentDescriptor key set;
  // field-level checks below enforce the declared primitive shapes.
  const descriptor = input as unknown as IntentDescriptor;
  if (!ASCII_ID.test(descriptor.intentId))
    throw new TypeError("invalid_intent_id");
  if (
    !Number.isSafeInteger(descriptor.descriptorVersion) ||
    descriptor.descriptorVersion < 1
  )
    throw new TypeError("invalid_descriptor_version");
  if (!ASCII_ID.test(descriptor.scope))
    throw new TypeError("invalid_intent_scope");
  if (!ASCII_ID.test(descriptor.policyId))
    throw new TypeError("invalid_intent_policy_id");
  assertSchemaRef(descriptor.inputSchema, "input_schema");
  assertSchemaRef(descriptor.resultSchema, "result_schema");
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (entry: unknown): string => {
    if (entry === null || typeof entry === "boolean")
      return JSON.stringify(entry);
    if (typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new TypeError("invalid_number");
      return Object.is(entry, -0) ? "0" : String(entry);
    }
    if (typeof entry !== "object") throw new TypeError("invalid_json");
    if (seen.has(entry)) throw new TypeError("cyclic_json");
    seen.add(entry);
    if (Array.isArray(entry)) {
      const result = `[${entry.map(encode).join(",")}]`;
      seen.delete(entry);
      return result;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype)
      throw new TypeError("invalid_object");
    const record = entry as Readonly<Record<string, unknown>>;
    const result = `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
      .join(",")}}`;
    seen.delete(entry);
    return result;
  };
  return encode(value);
}

export const digestJson = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function compileRelease(
  inputSpec: AgentSpec,
  inputClosure: ExecutionClosure,
): AgentRelease {
  assertRecord(
    inputSpec as unknown,
    [
      "agentId",
      "goal",
      "harnessKind",
      "checkpointSchema",
      "capabilities",
      "effectOperations",
      "intentDescriptors",
    ],
    "agent_spec",
  );
  assertString(inputSpec.agentId, "agent_id");
  assertString(inputSpec.goal, "goal");
  if (!["fake", "legacy-process"].includes(inputSpec.harnessKind))
    throw new TypeError("invalid_harness_kind");
  assertString(inputSpec.checkpointSchema, "checkpoint_schema");
  assertStringList(inputSpec.capabilities, "capabilities");
  assertStringList(inputSpec.effectOperations, "effect_operations");
  if (!Array.isArray(inputSpec.intentDescriptors))
    throw new TypeError("invalid_intent_descriptors");
  for (const descriptor of inputSpec.intentDescriptors)
    assertIntentDescriptor(descriptor);
  if (
    new Set(inputSpec.intentDescriptors.map(({ intentId }) => intentId))
      .size !== inputSpec.intentDescriptors.length
  )
    throw new TypeError("duplicate_intent_descriptor");

  assertRecord(
    inputClosure as unknown,
    ["entryId", "executable", "executableDigest", "members"],
    "execution_closure",
  );
  assertString(inputClosure.entryId, "entry_id");
  assertString(inputClosure.executable, "executable");
  if (!HEX_64.test(inputClosure.executableDigest))
    throw new TypeError("invalid_executable_digest");
  if (!Array.isArray(inputClosure.members))
    throw new TypeError("invalid_closure_members");
  for (const member of inputClosure.members) {
    assertRecord(member as unknown, ["id", "digest"], "closure_member");
    assertString(member.id, "closure_member_id");
    if (!HEX_64.test(member.digest))
      throw new TypeError("invalid_closure_member_digest");
  }
  if (
    new Set(inputClosure.members.map(({ id }) => id)).size !==
    inputClosure.members.length
  )
    throw new TypeError("duplicate_closure_member");

  const spec: AgentSpec = {
    agentId: inputSpec.agentId,
    goal: inputSpec.goal,
    harnessKind: inputSpec.harnessKind,
    checkpointSchema: inputSpec.checkpointSchema,
    capabilities: [...inputSpec.capabilities].sort(),
    effectOperations: [...inputSpec.effectOperations].sort(),
    intentDescriptors: [...inputSpec.intentDescriptors]
      .map((descriptor) => ({ ...descriptor }))
      .sort((left, right) => left.intentId.localeCompare(right.intentId)),
  };
  const closure: ExecutionClosure = {
    entryId: inputClosure.entryId,
    executable: inputClosure.executable,
    executableDigest: inputClosure.executableDigest,
    members: [...inputClosure.members]
      .map(({ id, digest }) => ({ id, digest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const unsigned = {
    schemaVersion: "agent-release-v2" as const,
    canonicalizationVersion: "json-safe-v1" as const,
    hashAlgorithm: "sha256" as const,
    spec,
    closure,
    trustedDirectEffects: [] as readonly never[],
  };
  return deepFreeze({ ...unsigned, releaseId: digestJson(unsigned) });
}

/**
 * Verifies agent-release-v1 bytes under v1-only rules: the spec member must
 * have exactly the six v1 fields, so a v1 artifact is never reinterpreted by
 * the v2 compiler (e.g. no implied intent descriptors).
 */
function verifyV1Release(release: AgentRelease): boolean {
  // SAFETY: v1 spec member is only accessed after assertRecord below verifies
  // the exact six-field v1 key set; values stay as canonical JSON inputs.
  const v1Spec = release.spec as unknown as {
    readonly [key: string]: unknown;
  };
  assertRecord(
    release as unknown,
    [
      "schemaVersion",
      "canonicalizationVersion",
      "hashAlgorithm",
      "releaseId",
      "spec",
      "closure",
      "trustedDirectEffects",
    ],
    "agent_release",
  );
  if (
    release.canonicalizationVersion !== "json-safe-v1" ||
    release.hashAlgorithm !== "sha256" ||
    !HEX_64.test(release.releaseId) ||
    !Array.isArray(release.trustedDirectEffects) ||
    release.trustedDirectEffects.length !== 0
  )
    return false;
  assertRecord(
    v1Spec,
    [
      "agentId",
      "goal",
      "harnessKind",
      "checkpointSchema",
      "capabilities",
      "effectOperations",
    ],
    "agent_spec_v1",
  );
  assertRecord(
    release.closure as unknown,
    ["entryId", "executable", "executableDigest", "members"],
    "execution_closure",
  );
  const unsigned = {
    schemaVersion: "agent-release-v1" as const,
    canonicalizationVersion: "json-safe-v1" as const,
    hashAlgorithm: "sha256" as const,
    spec: v1Spec,
    closure: release.closure,
    trustedDirectEffects: release.trustedDirectEffects,
  };
  return digestJson(unsigned) === release.releaseId;
}

export function verifyRelease(release: AgentRelease): boolean {
  try {
    if (release.schemaVersion === "agent-release-v2") {
      assertRecord(
        release as unknown,
        [
          "schemaVersion",
          "canonicalizationVersion",
          "hashAlgorithm",
          "releaseId",
          "spec",
          "closure",
          "trustedDirectEffects",
        ],
        "agent_release",
      );
      if (
        release.canonicalizationVersion !== "json-safe-v1" ||
        release.hashAlgorithm !== "sha256" ||
        !HEX_64.test(release.releaseId) ||
        !Array.isArray(release.trustedDirectEffects) ||
        release.trustedDirectEffects.length !== 0
      )
        return false;
      const compiled = compileRelease(release.spec, release.closure);
      return canonicalJson(release) === canonicalJson(compiled);
    }
    if (release.schemaVersion === "agent-release-v1")
      return verifyV1Release(release);
    return false;
  } catch {
    return false;
  }
}
