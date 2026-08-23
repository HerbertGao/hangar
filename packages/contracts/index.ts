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

export interface AgentSpec {
  readonly agentId: string;
  readonly goal: string;
  readonly harnessKind: "fake" | "legacy-process";
  readonly checkpointSchema: string;
  readonly capabilities: readonly string[];
  readonly effectOperations: readonly string[];
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
  readonly schemaVersion: "agent-release-v1";
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
    schemaVersion: "agent-release-v1" as const,
    canonicalizationVersion: "json-safe-v1" as const,
    hashAlgorithm: "sha256" as const,
    spec,
    closure,
    trustedDirectEffects: [] as readonly never[],
  };
  return deepFreeze({ ...unsigned, releaseId: digestJson(unsigned) });
}

export function verifyRelease(release: AgentRelease): boolean {
  try {
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
      release.schemaVersion !== "agent-release-v1" ||
      release.canonicalizationVersion !== "json-safe-v1" ||
      release.hashAlgorithm !== "sha256" ||
      !HEX_64.test(release.releaseId) ||
      !Array.isArray(release.trustedDirectEffects) ||
      release.trustedDirectEffects.length !== 0
    )
      return false;
    const compiled = compileRelease(release.spec, release.closure);
    return canonicalJson(release) === canonicalJson(compiled);
  } catch {
    return false;
  }
}
