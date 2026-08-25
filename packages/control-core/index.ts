import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  digestJson,
  fail,
  ok,
  validateControlMetadataInput,
  verifyRelease,
  type ActionInput,
  type AgentRelease,
  type AgentSummary,
  type AuthorityContext,
  type AttemptState,
  type AttemptToken,
  type CheckpointInput,
  type CommandMeta,
  type ControlCommandDeliveryInput,
  type ControlCommandDeliveryResult,
  type EffectApprovalInput,
  type EffectIntentInput,
  type EffectState,
  type ErrorKind,
  type ExecutionMode,
  type HarnessAdapterPort,
  type HarnessCleanupEvidence,
  type HarnessInput,
  type HarnessSubmitResult,
  type HealthSummary,
  type IntentAdmissionInput,
  type IntentAdmissionResult,
  type OutcomeProposalInput,
  type PendingApprovalSummary,
  type ProjectionFamily,
  type QueryEnvelope,
  type ReleaseSummary,
  type RunEventPage,
  type SanitizedRunSummary,
  type JsonValue,
  type ProcessIdentity,
  type Result,
  type RunState,
  type RunView,
  type SourceFact,
  type ToolObservationInput,
} from "../contracts/index.ts";

export interface FactDraft {
  readonly aggregateId: string;
  readonly factKind: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface ProjectionRow {
  readonly family: "release" | "activation" | "run" | "effect";
  readonly entityId: string;
  readonly sourceFactSeq: number;
  readonly payload: JsonValue;
}

export interface StoreSnapshot {
  readonly revision: number;
  readonly headSeq: number;
  readonly facts: readonly SourceFact[];
  readonly projections: readonly ProjectionRow[];
}

export interface CommitPlan<T> {
  readonly expectedRevision: number;
  readonly facts: readonly FactDraft[];
  readonly projections: readonly ProjectionRow[];
  readonly result: T;
}

export interface TransactOptions {
  readonly rejectReplay?: boolean;
  /** Only these decide-time failures are completed as safe stored results. */
  readonly persistRejections?: readonly ErrorKind[];
  /** Current read authorization gate before replay/conflict disclosure. */
  readonly authorizeStoredResult?: (snapshot: StoreSnapshot) => Result<null>;
}

export interface OutcomeGateInput {
  readonly release: AgentRelease;
  readonly runId: string;
  readonly attempt: number;
  readonly artifactDigest: string;
  readonly toolObservations: readonly ToolObservationInput[];
}

export type OutcomeGate = (input: OutcomeGateInput) => boolean;

export interface ControlOptions {
  readonly outcomeGate?: OutcomeGate;
  /** Authenticated admission gate; forbidden results are eligible to persist. */
  readonly authorizeCommandAdmission?: (
    meta: CommandMeta,
    snapshot: StoreSnapshot,
  ) => Result<null>;
  /** Auth boundary hook; no stored result/conflict is disclosed before it. */
  readonly authorizeCommandDisclosure?: (
    meta: CommandMeta,
    snapshot: StoreSnapshot,
  ) => Result<null>;
  /** Target visibility owner after the built-in family scope gate. */
  readonly authorizeQuery?: (
    authority: AuthorityContext,
    family: ProjectionFamily,
    entityId: string | null,
  ) => boolean;
  /** Trusted host-attestation owner for production admission. */
  readonly productionEligible?: (
    release: AgentRelease,
    agentId: string,
  ) => boolean;
  readonly timeAuthority?: { nowUnixMs(): number };
  readonly approvalTtlMs?: number;
  readonly effectAuthorityValid?: (runId: string, effectId: string) => boolean;
  /** Pre-Effect policy only: no pending Approval branch for control-command. */
  readonly controlCommandPolicy?: (
    input: ControlCommandDeliveryInput,
  ) => "allow" | "deny";
  readonly controlDeliveryFenceValid?: (input: {
    connectorInstanceId: string;
    serviceAuthorityId: string;
    deliveryGeneration: number;
    mappingVersion: number;
  }) => boolean;
}

export interface OutcomeAcceptor {
  accept(
    meta: CommandMeta,
    input: { runId: string; attempt: number; artifactDigest: string },
  ): Result<null>;
}

export interface ControlStore {
  transact<T>(
    meta: CommandMeta,
    decide: (snapshot: StoreSnapshot) => Result<CommitPlan<T>>,
    options?: TransactOptions,
  ): Result<T>;
  readSnapshot(): Result<StoreSnapshot>;
  replaceProjections(
    expectedHeadSeq: number,
    rows: readonly ProjectionRow[],
  ): Result<null>;
  /** Best-effort wake only; subscribers must always reread durable head. */
  subscribeCommits(listener: () => void): () => void;
  close(): void;
}

interface InternalApproval extends EffectApprovalInput {
  actorSubjectId: string;
}

interface InternalEffect {
  state: EffectState;
  approval?: InternalApproval;
  approvalDecision?: "approved" | "denied";
  approvalDisposition?: "expired";
  approvalExpiresAtUnixMs?: number;
  approvalSuperseded?: boolean;
  gatewayWake?: boolean;
  localDispatchResult?:
    | "denied"
    | "claim-expired"
    | "claim-revoked"
    | "transport-not-started";
  operation: string;
  actionId: string;
  originAttempt: number;
  intentKey: string;
  intentGeneration: number;
  payloadDigest: string;
}

interface InternalControlEffect {
  effectId: string;
  state: EffectState;
  connectorInstanceId: string;
  serviceAuthorityId: string;
  updateOccurrenceKey: string;
  controlInteractionIdentity: string;
  deliveryKey: string;
  deliveryGeneration: number;
  mappingVersion: number;
  target: string;
  payloadBase64url: string;
  payloadDigest: string;
  deliveryOperation: string;
  responseKind: string;
  claimsDigest: string;
  rawUpdateDigest: string;
  outcome?: "committed" | "not-committed";
}

interface TelegramOccurrence {
  claimsDigest: string;
  rawUpdateDigest: string;
  quarantined: boolean;
}

interface InternalToolObservation extends ToolObservationInput {
  attempt: number;
}

interface InternalCheckpoint {
  checkpointId: string;
  producerActionId: string;
  schema: string;
  artifactDigest: string;
  obligationOwner: "control-core" | "effect-gateway";
  obligationGeneration: number;
  effectId?: string;
}

interface AttemptFence {
  checkpointId: string;
  sessionId: string;
  containmentGeneration: number;
  grantGeneration: number;
  obligationDigest: string;
  fenceDigest: string;
  consumed: boolean;
}

interface InternalRun {
  runId: string;
  agentId: string;
  releaseId: string;
  activationEpoch: number;
  executionMode?: ExecutionMode;
  intentId?: string;
  intentDescriptorVersion?: number;
  inputDigest?: string;
  promptDigest?: string;
  cancelRequested: boolean;
  cancelFenceGeneration: number;
  reconciliationWake: Set<string>;
  state: RunState;
  currentAttempt: number;
  sessions: Map<number, AttemptToken>;
  attempts: Map<number, AttemptState>;
  actions: Map<string, JsonValue>;
  toolObservations: Map<string, InternalToolObservation>;
  effects: Map<string, InternalEffect>;
  checkpoints: Map<number, InternalCheckpoint>;
  proposedOutcomes: Map<number, string>;
  acceptedOutcomes: Map<number, string>;
  faultedAttempts: Set<number>;
  processes: Map<number, ProcessIdentity>;
  reaped: Set<number>;
  revoked: Set<number>;
  quiesced: Map<number, AttemptFence>;
}

interface ControlState {
  releases: Map<string, AgentRelease>;
  activations: Map<
    string,
    { releaseId: string; epoch: number; mode: "active" | "shadow" }
  >;
  runs: Map<string, InternalRun>;
  controlEffects: Map<string, InternalControlEffect>;
  telegramOccurrences: Map<string, TelegramOccurrence>;
}

const GATEWAY = Symbol("effect-gateway");
const OUTCOME_OWNER = Symbol("domain-outcome-owner");
const PROCESS_OWNER = Symbol("trusted-process-owner");
const CANCEL_OWNER = Symbol("trusted-cancel-owner");
const PI_CHILD_OWNER = Symbol("trusted-pi-child-owner");
const SYSTEM_TIME_AUTHORITY = {
  nowUnixMs: (): number => new Date().getTime(),
};
const HEX_64 = /^[0-9a-f]{64}$/;

// SAFETY: the trusted store accepts fact drafts only from this module, and each
// factKind is decoded by the matching closed payload shape below.
const payload = <T>(fact: SourceFact): T => fact.payload as unknown as T;
const asJson = (value: unknown): JsonValue => value as JsonValue;
const asPayload = (value: unknown): Readonly<Record<string, JsonValue>> =>
  value as Readonly<Record<string, JsonValue>>;

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value)
    )
      return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    const allowed = new Set([...required, ...optional]);
    if (
      !required.every((key) => Object.hasOwn(descriptors, key)) ||
      !keys.every((key) => allowed.has(key)) ||
      !keys.every(
        (key) =>
          Object.hasOwn(descriptors[key], "value") &&
          descriptors[key].enumerable === true,
      )
    )
      return undefined;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch {
    return undefined;
  }
}

const COMMAND_META_KEYS = [
  "actorSubjectId",
  "authorityContextDigest",
  "commandKind",
  "targetId",
  "idempotencyKey",
  "payloadDigest",
  "precondition",
  "preconditionDigest",
] as const;

function decodeCommandMeta(meta: CommandMeta): CommandMeta | undefined {
  const value = exactRecord(meta, COMMAND_META_KEYS);
  if (
    !value ||
    typeof value.actorSubjectId !== "string" ||
    value.actorSubjectId.length === 0 ||
    typeof value.authorityContextDigest !== "string" ||
    !HEX_64.test(value.authorityContextDigest) ||
    typeof value.commandKind !== "string" ||
    value.commandKind.length === 0 ||
    typeof value.targetId !== "string" ||
    value.targetId.length === 0 ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length === 0 ||
    typeof value.payloadDigest !== "string" ||
    !HEX_64.test(value.payloadDigest) ||
    typeof value.preconditionDigest !== "string" ||
    !HEX_64.test(value.preconditionDigest)
  )
    return undefined;
  try {
    if (digestJson(value.precondition) !== value.preconditionDigest)
      return undefined;
  } catch {
    return undefined;
  }
  // SAFETY: exactRecord materialized exactly the seven validated data fields.
  return value as unknown as CommandMeta;
}

function matchingCommandMeta(
  meta: CommandMeta,
  commandKind: string,
  targetId: string,
  input: unknown,
  expectedPrecondition?: unknown,
): CommandMeta | undefined {
  const decoded = decodeCommandMeta(meta);
  if (
    !decoded ||
    decoded.commandKind !== commandKind ||
    decoded.targetId !== targetId
  )
    return undefined;
  try {
    if (
      digestJson(input) !== decoded.payloadDigest ||
      (expectedPrecondition !== undefined &&
        digestJson(expectedPrecondition) !== decoded.preconditionDigest)
    )
      return undefined;
  } catch {
    return undefined;
  }
  return decoded;
}

const PROJECTION_SCOPES: Readonly<Record<ProjectionFamily, string>> = {
  agent: "agent:read",
  release: "release:read",
  activation: "activation:read",
  run: "run:read",
  attempt: "run:read",
  event: "event:read",
  approval: "approval:read",
  effect: "effect:read",
  health: "health:read",
  recovery: "recovery:read",
  "command-result": "command:read",
};

export function requiredScopeForProjection(family: string): Result<string> {
  if (!Object.hasOwn(PROJECTION_SCOPES, family)) return fail("invalid_input");
  return ok(PROJECTION_SCOPES[family as ProjectionFamily]);
}

const AUTHORITY_CONTEXT_KEYS = [
  "issuerNamespaceId",
  "principalId",
  "representedSubjectId",
  "audience",
  "issuerVersion",
  "authenticatedMethod",
  "delegationChainDigest",
  "effectiveScope",
  "effectiveOperation",
  "issuedAtUtcMs",
  "expiresAtUtcMs",
  "revocationVersion",
] as const;

function decodeAuthorityContext(value: unknown): AuthorityContext | undefined {
  const context = exactRecord(value, AUTHORITY_CONTEXT_KEYS);
  if (!context) return undefined;
  const strings = [
    "issuerNamespaceId",
    "principalId",
    "representedSubjectId",
    "audience",
    "issuerVersion",
    "authenticatedMethod",
    "effectiveOperation",
    "revocationVersion",
  ] as const;
  if (
    strings.some(
      (field) =>
        typeof context[field] !== "string" || context[field].length === 0,
    ) ||
    typeof context.delegationChainDigest !== "string" ||
    !HEX_64.test(context.delegationChainDigest) ||
    !Array.isArray(context.effectiveScope) ||
    context.effectiveScope.some(
      (scope) => typeof scope !== "string" || scope.length === 0,
    ) ||
    new Set(context.effectiveScope).size !== context.effectiveScope.length ||
    !Number.isSafeInteger(context.issuedAtUtcMs) ||
    !Number.isSafeInteger(context.expiresAtUtcMs) ||
    (context.issuedAtUtcMs as number) < 0 ||
    (context.expiresAtUtcMs as number) <= (context.issuedAtUtcMs as number)
  )
    return undefined;
  // SAFETY: exactRecord plus field checks above cover all contract members.
  return context as unknown as AuthorityContext;
}

export const actorSubjectId = (authority: AuthorityContext): string =>
  digestJson([
    "actor-subject-v1",
    authority.issuerNamespaceId,
    authority.principalId,
    authority.representedSubjectId,
    authority.audience,
  ]);

export const intentRunId = (
  actorId: string,
  agentId: string,
  intentId: string,
  idempotencyKey: string,
): string => digestJson(["run-v1", actorId, agentId, intentId, idempotencyKey]);

export const attemptPromptDigest = (
  release: AgentRelease,
  input: IntentAdmissionInput,
): string =>
  digestJson([
    "attempt-prompt-v1",
    release.releaseId,
    release.spec.goal,
    input.intentId,
    input.descriptorVersion,
    input.input,
    release.closure.members,
  ]);

export const controlDeliveryOccurrenceKey = (
  connectorInstanceId: string,
  serviceAuthorityId: string,
  updateId: string,
): string =>
  digestJson([
    "telegram-update-v1",
    connectorInstanceId,
    serviceAuthorityId,
    updateId,
  ]);

export const controlDeliveryIdempotencyKey = (
  updateOccurrenceKey: string,
): string => digestJson(["telegram-control-v1", updateOccurrenceKey]);

export function normalizeControlDeliveryInput(
  input: ControlCommandDeliveryInput,
): Readonly<Record<string, JsonValue>> {
  if (
    createHash("sha256").update(input.payloadBytes).digest("hex") !==
    input.payloadDigest
  )
    throw new TypeError("invalid_payload_digest");
  return asPayload({
    connectorInstanceId: input.connectorInstanceId,
    serviceAuthorityId: input.serviceAuthorityId,
    updateId: input.updateId,
    updateOccurrenceKey: input.updateOccurrenceKey,
    claimsDigest: input.claimsDigest,
    rawUpdateDigest: input.rawUpdateDigest,
    controlInteractionIdentity: input.controlInteractionIdentity,
    deliveryKey: input.deliveryKey,
    deliveryGeneration: input.deliveryGeneration,
    mappingVersion: input.mappingVersion,
    target: input.target,
    deliveryOperation: input.deliveryOperation,
    responseKind: input.responseKind,
    payloadBase64url: Buffer.from(input.payloadBytes).toString("base64url"),
    payloadDigest: input.payloadDigest,
  });
}

function attemptToken(runId: string, attempt: number): AttemptToken {
  return {
    runId,
    attempt,
    sessionId: randomUUID(),
    generation: attempt + 1,
  };
}

function reduceFacts(facts: readonly SourceFact[]): ControlState {
  const state: ControlState = {
    releases: new Map(),
    activations: new Map(),
    runs: new Map(),
    controlEffects: new Map(),
    telegramOccurrences: new Map(),
  };
  for (const fact of facts) {
    switch (fact.factKind) {
      case "release-published": {
        const value = payload<{ release: AgentRelease }>(fact);
        state.releases.set(value.release.releaseId, value.release);
        break;
      }
      case "activation-active": {
        const value = payload<{
          agentId: string;
          releaseId: string;
          epoch: number;
          mode?: "active" | "shadow";
        }>(fact);
        state.activations.set(value.agentId, {
          releaseId: value.releaseId,
          epoch: value.epoch,
          mode: value.mode ?? "active",
        });
        break;
      }
      case "run-admitted": {
        const value = payload<{
          runId: string;
          agentId: string;
          releaseId: string;
          activationEpoch: number;
          token: AttemptToken;
          executionMode?: ExecutionMode;
          intentId?: string;
          intentDescriptorVersion?: number;
          inputDigest?: string;
          promptDigest?: string;
        }>(fact);
        state.runs.set(value.runId, {
          runId: value.runId,
          agentId: value.agentId,
          releaseId: value.releaseId,
          activationEpoch: value.activationEpoch,
          ...(value.executionMode &&
          value.intentId &&
          value.intentDescriptorVersion !== undefined &&
          value.inputDigest &&
          value.promptDigest
            ? {
                executionMode: value.executionMode,
                intentId: value.intentId,
                intentDescriptorVersion: value.intentDescriptorVersion,
                inputDigest: value.inputDigest,
                promptDigest: value.promptDigest,
              }
            : {}),
          cancelRequested: false,
          cancelFenceGeneration: 0,
          reconciliationWake: new Set(),
          state: "running",
          currentAttempt: 0,
          sessions: new Map([[0, value.token]]),
          attempts: new Map([[0, "running"]]),
          actions: new Map(),
          toolObservations: new Map(),
          effects: new Map(),
          checkpoints: new Map(),
          proposedOutcomes: new Map(),
          acceptedOutcomes: new Map(),
          faultedAttempts: new Set(),
          processes: new Map(),
          reaped: new Set(),
          revoked: new Set(),
          quiesced: new Map(),
        });
        break;
      }
      case "attempt-prompt-bound":
        // Immutable digest is already carried by the run-admission payload;
        // the separate fact closes the launch/audit boundary atomically.
        break;
      case "attempt-allocated": {
        const value = payload<{
          runId: string;
          attempt: number;
          token: AttemptToken;
        }>(fact);
        const run = state.runs.get(value.runId)!;
        run.currentAttempt = value.attempt;
        run.sessions.set(value.attempt, value.token);
        run.attempts.set(value.attempt, "running");
        run.state = "running";
        break;
      }
      case "action-registered": {
        const value = payload<{
          runId: string;
          actionId: string;
          binding: JsonValue;
        }>(fact);
        state.runs.get(value.runId)!.actions.set(value.actionId, value.binding);
        break;
      }
      case "tool-observed": {
        const value = payload<{
          runId: string;
          attempt: number;
          observation: ToolObservationInput;
        }>(fact);
        state.runs
          .get(value.runId)!
          .toolObservations.set(value.observation.actionId, {
            attempt: value.attempt,
            ...value.observation,
          });
        break;
      }
      case "telegram-occurrence-bound": {
        const value = payload<{
          updateOccurrenceKey: string;
          claimsDigest: string;
          rawUpdateDigest: string;
        }>(fact);
        state.telegramOccurrences.set(value.updateOccurrenceKey, {
          claimsDigest: value.claimsDigest,
          rawUpdateDigest: value.rawUpdateDigest,
          quarantined: false,
        });
        break;
      }
      case "telegram-occurrence-quarantined": {
        const value = payload<{ updateOccurrenceKey: string }>(fact);
        const occurrence = state.telegramOccurrences.get(
          value.updateOccurrenceKey,
        );
        if (occurrence) occurrence.quarantined = true;
        break;
      }
      case "control-command-effect-created": {
        const value = payload<InternalControlEffect>(fact);
        state.controlEffects.set(value.effectId, { ...value });
        break;
      }
      case "control-effect-claimed": {
        const value = payload<{ effectId: string }>(fact);
        state.controlEffects.get(value.effectId)!.state = "claimed";
        break;
      }
      case "control-effect-dispatch-started": {
        const value = payload<{ effectId: string }>(fact);
        state.controlEffects.get(value.effectId)!.state = "dispatch-started";
        break;
      }
      case "control-effect-unknown": {
        const value = payload<{ effectId: string }>(fact);
        state.controlEffects.get(value.effectId)!.state = "unknown";
        break;
      }
      case "control-effect-outcome": {
        const value = payload<{
          effectId: string;
          outcome: "committed" | "not-committed";
        }>(fact);
        const effect = state.controlEffects.get(value.effectId)!;
        effect.state = value.outcome;
        effect.outcome = value.outcome;
        break;
      }
      case "effect-intent": {
        const value = payload<{
          runId: string;
          effectId: string;
          operation: string;
          actionId: string;
          attempt: number;
          intentKey: string;
          intentGeneration: number;
          payloadDigest: string;
        }>(fact);
        state.runs.get(value.runId)!.effects.set(value.effectId, {
          state: "pending",
          operation: value.operation,
          actionId: value.actionId,
          originAttempt: value.attempt,
          intentKey: value.intentKey,
          intentGeneration: value.intentGeneration,
          payloadDigest: value.payloadDigest,
        });
        break;
      }
      case "effect-approved": {
        const value = payload<{
          runId: string;
          effectId: string;
          approval: InternalApproval;
        }>(fact);
        const effect = state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!;
        effect.state = "approved";
        effect.approval = value.approval;
        break;
      }
      case "approval-opened": {
        const value = payload<{
          runId: string;
          effectId: string;
          expiresAtUnixMs: number;
        }>(fact);
        state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!.approvalExpiresAtUnixMs =
          value.expiresAtUnixMs;
        break;
      }
      case "approval-decided": {
        const value = payload<{
          runId: string;
          effectId: string;
          decision: "approved" | "denied";
          disposition?: "expired";
          approval?: InternalApproval;
        }>(fact);
        const effect = state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!;
        effect.approvalDecision = value.decision;
        effect.approvalDisposition = value.disposition;
        if (value.approval) {
          effect.approval = value.approval;
          effect.state = "approved";
        }
        break;
      }
      case "gateway-wake": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!.gatewayWake = true;
        break;
      }
      case "gateway-wake-consumed": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!.gatewayWake = false;
        break;
      }
      case "approval-superseded": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        const effect = state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!;
        effect.approval = undefined;
        effect.approvalSuperseded = true;
        break;
      }
      case "local-dispatch-result": {
        const value = payload<{
          runId: string;
          effectId: string;
          status:
            | "denied"
            | "claim-expired"
            | "claim-revoked"
            | "transport-not-started";
        }>(fact);
        const effect = state.runs
          .get(value.runId)!
          .effects.get(value.effectId)!;
        effect.localDispatchResult = value.status;
        effect.state = "not-committed";
        break;
      }
      case "reconciliation-wake": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs.get(value.runId)!.reconciliationWake.add(value.effectId);
        break;
      }
      case "cancel-requested": {
        const value = payload<{
          runId: string;
          fenceGeneration: number;
          pendingReconciliation: boolean;
        }>(fact);
        const run = state.runs.get(value.runId)!;
        run.cancelRequested = true;
        run.cancelFenceGeneration = value.fenceGeneration;
        run.state = value.pendingReconciliation
          ? "cancel-pending-reconciliation"
          : "cancel-requested";
        break;
      }
      case "effect-claimed": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs.get(value.runId)!.effects.get(value.effectId)!.state =
          "claimed";
        break;
      }
      case "effect-dispatch-started": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs.get(value.runId)!.effects.get(value.effectId)!.state =
          "dispatch-started";
        break;
      }
      case "effect-unknown": {
        const value = payload<{ runId: string; effectId: string }>(fact);
        state.runs.get(value.runId)!.effects.get(value.effectId)!.state =
          "unknown";
        break;
      }
      case "effect-outcome": {
        const value = payload<{
          runId: string;
          effectId: string;
          outcome: "committed" | "not-committed";
        }>(fact);
        state.runs.get(value.runId)!.effects.get(value.effectId)!.state =
          value.outcome;
        break;
      }
      case "checkpoint-recorded": {
        const value = payload<{
          runId: string;
          attempt: number;
          checkpoint: InternalCheckpoint;
        }>(fact);
        state.runs
          .get(value.runId)!
          .checkpoints.set(value.attempt, value.checkpoint);
        break;
      }
      case "outcome-proposed": {
        const value = payload<{
          runId: string;
          attempt: number;
          artifactDigest: string;
        }>(fact);
        state.runs
          .get(value.runId)!
          .proposedOutcomes.set(value.attempt, value.artifactDigest);
        break;
      }
      case "outcome-accepted": {
        const value = payload<{
          runId: string;
          attempt: number;
          artifactDigest: string;
        }>(fact);
        state.runs
          .get(value.runId)!
          .acceptedOutcomes.set(value.attempt, value.artifactDigest);
        break;
      }
      case "attempt-fault-recorded": {
        const value = payload<{ runId: string; attempt: number }>(fact);
        state.runs.get(value.runId)!.faultedAttempts.add(value.attempt);
        break;
      }
      case "attempt-settled": {
        const value = payload<{
          runId: string;
          attempt: number;
          state: AttemptState;
        }>(fact);
        state.runs.get(value.runId)!.attempts.set(value.attempt, value.state);
        break;
      }
      case "process-registered": {
        const value = payload<{
          runId: string;
          attempt: number;
          process: ProcessIdentity;
        }>(fact);
        state.runs
          .get(value.runId)!
          .processes.set(value.attempt, value.process);
        break;
      }
      case "containment-reaped": {
        const value = payload<{ runId: string; attempt: number }>(fact);
        state.runs.get(value.runId)!.reaped.add(value.attempt);
        break;
      }
      case "grant-revoked": {
        const value = payload<{ runId: string; attempt: number }>(fact);
        state.runs.get(value.runId)!.revoked.add(value.attempt);
        break;
      }
      case "attempt-quiesced": {
        const value = payload<{
          runId: string;
          attempt: number;
          checkpointId: string;
          sessionId: string;
          containmentGeneration: number;
          grantGeneration: number;
          obligationDigest: string;
          fenceDigest: string;
        }>(fact);
        const run = state.runs.get(value.runId)!;
        run.state = "waiting";
        run.quiesced.set(value.attempt, {
          checkpointId: value.checkpointId,
          sessionId: value.sessionId,
          containmentGeneration: value.containmentGeneration,
          grantGeneration: value.grantGeneration,
          obligationDigest: value.obligationDigest,
          fenceDigest: value.fenceDigest,
          consumed: false,
        });
        break;
      }
      case "quiescence-consumed": {
        const value = payload<{ runId: string; attempt: number }>(fact);
        state.runs
          .get(value.runId)!
          .quiesced.get(value.attempt)!.consumed = true;
        break;
      }
      case "run-terminal": {
        const value = payload<{ runId: string; state: RunState }>(fact);
        state.runs.get(value.runId)!.state = value.state;
        break;
      }
      default:
        throw new Error("unknown_fact_kind");
    }
  }
  return state;
}

function view(run: InternalRun): RunView {
  const attempt = run.currentAttempt;
  return {
    runId: run.runId,
    agentId: run.agentId,
    releaseId: run.releaseId,
    activationEpoch: run.activationEpoch,
    state: run.state,
    currentAttempt: attempt,
    attemptState: run.attempts.get(attempt) ?? "running",
    actions: [...run.actions.keys()].sort(),
    toolObservations: [...run.toolObservations.values()]
      .filter((observation) => observation.attempt === attempt)
      .map(({ attempt: _attempt, ...observation }) => observation)
      .sort((left, right) => left.actionId.localeCompare(right.actionId)),
    effects: Object.fromEntries(
      [...run.effects].map(([id, effect]) => [id, effect.state]),
    ),
    ...(run.checkpoints.get(attempt)
      ? { checkpointId: run.checkpoints.get(attempt)!.checkpointId }
      : {}),
    ...(run.acceptedOutcomes.get(attempt)
      ? { outcomeArtifactDigest: run.acceptedOutcomes.get(attempt) }
      : {}),
    ...(run.processes.get(attempt)
      ? { process: run.processes.get(attempt) }
      : {}),
    containmentReaped: run.reaped.has(attempt),
    grantRevoked: run.revoked.has(attempt),
  };
}

function project(state: ControlState, sourceFactSeq: number): ProjectionRow[] {
  return [
    ...[...state.releases].map(([id, release]) => ({
      family: "release" as const,
      entityId: id,
      sourceFactSeq,
      payload: asJson(release),
    })),
    ...[...state.activations].map(([agentId, activation]) => ({
      family: "activation" as const,
      entityId: agentId,
      sourceFactSeq,
      payload: asJson({ agentId, ...activation }),
    })),
    ...[...state.runs].map(([id, run]) => ({
      family: "run" as const,
      entityId: id,
      sourceFactSeq,
      payload: asJson(view(run)),
    })),
    ...[...state.controlEffects].map(([id, effect]) => ({
      family: "effect" as const,
      entityId: id,
      sourceFactSeq,
      payload: asJson({
        effectId: effect.effectId,
        subjectKind: "control-command",
        state: effect.state,
        target: effect.target,
        payloadDigest: effect.payloadDigest,
      }),
    })),
  ].sort(
    (left, right) =>
      left.family.localeCompare(right.family) ||
      left.entityId.localeCompare(right.entityId),
  );
}

function stateWithDrafts(
  snapshot: StoreSnapshot,
  drafts: readonly FactDraft[],
): ControlState {
  const synthetic = drafts.map((draft, index) => ({
    factSeq: snapshot.headSeq + index + 1,
    aggregateId: draft.aggregateId,
    factKind: draft.factKind,
    previousHash: "",
    factHash: "",
    payload: draft.payload,
  }));
  return reduceFacts([...snapshot.facts, ...synthetic]);
}

function plan<T>(
  snapshot: StoreSnapshot,
  drafts: readonly FactDraft[],
  result: T,
): Result<CommitPlan<T>> {
  const state = stateWithDrafts(snapshot, drafts);
  return ok({
    expectedRevision: snapshot.revision,
    facts: drafts,
    projections: project(state, snapshot.headSeq + drafts.length),
    result,
  });
}

function matchesStoredToken(
  run: InternalRun | undefined,
  token: AttemptToken,
): boolean {
  const current = run?.sessions.get(run.currentAttempt);
  return Boolean(
    run &&
      current?.attempt === token.attempt &&
      current.sessionId === token.sessionId &&
      current.generation === token.generation,
  );
}

function actionBinding(
  run: InternalRun,
  actionId: string,
): Readonly<Record<string, JsonValue>> | undefined {
  const binding = run.actions.get(actionId);
  return binding && typeof binding === "object" && !Array.isArray(binding)
    ? (binding as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function actionAttempt(run: InternalRun, actionId: string): number | undefined {
  const attempt = actionBinding(run, actionId)?.attempt;
  return typeof attempt === "number" && Number.isSafeInteger(attempt)
    ? attempt
    : undefined;
}

function actionKind(run: InternalRun, actionId: string): JsonValue | undefined {
  return actionBinding(run, actionId)?.kind;
}

function attemptFence(
  run: InternalRun,
  attempt: number,
): Omit<AttemptFence, "consumed"> | undefined {
  const checkpoint = run.checkpoints.get(attempt);
  const session = run.sessions.get(attempt);
  const containment = run.processes.get(attempt);
  if (!checkpoint || !session || !containment) return undefined;
  const effect = checkpoint.effectId
    ? run.effects.get(checkpoint.effectId)
    : undefined;
  const obligationDigest = digestJson({
    owner: checkpoint.obligationOwner,
    generation: checkpoint.obligationGeneration,
    ...(checkpoint.effectId ? { effectId: checkpoint.effectId } : {}),
    ...(effect ? { state: effect.state } : {}),
  });
  const binding = {
    checkpointId: checkpoint.checkpointId,
    sessionId: session.sessionId,
    containmentGeneration: containment.containmentGeneration,
    grantGeneration: session.generation,
    obligationDigest,
  };
  return { ...binding, fenceDigest: digestJson(binding) };
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "EPERM",
    );
  }
}

function processGroupExists(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "EPERM",
    );
  }
}

function currentActivation(state: ControlState, run: InternalRun): boolean {
  const activation = state.activations.get(run.agentId);
  return Boolean(
    activation &&
      activation.releaseId === run.releaseId &&
      activation.epoch === run.activationEpoch,
  );
}

function validToken(
  run: InternalRun | undefined,
  token: AttemptToken,
): boolean {
  return Boolean(
    matchesStoredToken(run, token) &&
      run?.state === "running" &&
      run.attempts.get(run.currentAttempt) === "running",
  );
}

export function commandMeta(
  actorSubjectId: string,
  commandKind: string,
  targetId: string,
  idempotencyKey: string,
  input: unknown,
  precondition: unknown = null,
  authorityContextDigest = digestJson([
    "m1-authority-context-v1",
    actorSubjectId,
  ]),
): CommandMeta {
  return {
    actorSubjectId,
    authorityContextDigest,
    commandKind,
    targetId,
    idempotencyKey,
    payloadDigest: digestJson(input),
    precondition: precondition as JsonValue,
    preconditionDigest: digestJson(precondition),
  };
}

function bindCommandMeta(
  meta: CommandMeta,
  input: unknown,
  precondition: unknown,
): Result<CommandMeta> {
  const decoded = decodeCommandMeta(meta);
  if (!decoded) return fail("invalid_input");
  const matched = matchingCommandMeta(
    decoded,
    decoded.commandKind,
    decoded.targetId,
    input,
    precondition,
  );
  return matched ? ok(matched) : fail("invalid_input");
}

type EffectHarnessInput = Extract<HarnessInput, { type: "effect-intent" }>;
type NonEffectHarnessInput = Exclude<HarnessInput, { type: "effect-intent" }>;
type OutcomeHarnessInput = Extract<HarnessInput, { type: "outcome-proposal" }>;
type PassiveHarnessInput = Exclude<
  HarnessInput,
  { type: "effect-intent" } | { type: "outcome-proposal" }
>;

export class HarnessSession {
  readonly #control: Control;
  readonly #token: AttemptToken;

  constructor(control: Control, token: AttemptToken) {
    this.#control = control;
    this.#token = token;
  }

  submit(
    meta: CommandMeta,
    input: EffectHarnessInput,
  ): Result<{ readonly effectId: string }>;
  submit(meta: CommandMeta, input: NonEffectHarnessInput): Result<null>;
  submit(meta: CommandMeta, input: HarnessInput): Result<HarnessSubmitResult>;
  submit(meta: CommandMeta, input: HarnessInput): Result<HarnessSubmitResult> {
    const bound = bindCommandMeta(meta, input, this.#token);
    return bound.ok
      ? this.#control.submitHarness(bound.value, this.#token, input)
      : bound;
  }
}

export class Control {
  readonly #store: ControlStore;
  readonly #options: ControlOptions;

  constructor(store: ControlStore, options: ControlOptions = {}) {
    this.#store = store;
    this.#options = options;
  }

  #now(): number {
    const value = (
      this.#options.timeAuthority ?? SYSTEM_TIME_AUTHORITY
    ).nowUnixMs();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("invalid_time_authority");
    return value;
  }

  #queryAuthority(
    input: AuthorityContext,
    family: ProjectionFamily,
    entityId: string | null,
  ): Result<AuthorityContext> {
    const authority = decodeAuthorityContext(input);
    if (!authority) return fail("invalid_input");
    const requiredScope = requiredScopeForProjection(family);
    if (!requiredScope.ok) return fail(requiredScope.error);
    if (
      authority.audience !== "hangar-control" ||
      !authority.effectiveScope.includes(requiredScope.value)
    )
      return fail("forbidden");
    if (this.#options.authorizeQuery?.(authority, family, entityId) === false)
      return entityId === null ? fail("forbidden") : fail("not_found");
    return ok(authority);
  }

  #transact<T>(
    meta: CommandMeta,
    input: unknown,
    decide: (snapshot: StoreSnapshot) => Result<CommitPlan<T>>,
    options?: TransactOptions,
  ): Result<T> {
    const value = decodeCommandMeta(meta);
    if (!value) return fail("invalid_input");
    let canonicalPayloadDigest: string;
    let canonicalPreconditionDigest: string;
    try {
      canonicalPayloadDigest = digestJson(input);
      canonicalPreconditionDigest = digestJson(value.precondition);
    } catch {
      return fail("invalid_input");
    }
    if (
      canonicalPreconditionDigest !== value.preconditionDigest ||
      canonicalPayloadDigest !== value.payloadDigest
    )
      return fail("invalid_input");
    return this.#store.transact(
      {
        actorSubjectId: value.actorSubjectId,
        authorityContextDigest: value.authorityContextDigest,
        commandKind: value.commandKind,
        targetId: value.targetId,
        idempotencyKey: value.idempotencyKey,
        payloadDigest: canonicalPayloadDigest,
        precondition: value.precondition as JsonValue,
        preconditionDigest: canonicalPreconditionDigest,
      },
      (snapshot) => {
        const admission = this.#options.authorizeCommandAdmission?.(
          value,
          snapshot,
        );
        if (admission && !admission.ok) return fail(admission.error);
        return decide(snapshot);
      },
      {
        ...options,
        persistRejections:
          options?.persistRejections ??
          ([
            "forbidden",
            "invalid_state",
            "stale_epoch",
            "terminal_conflict",
          ] as const),
        authorizeStoredResult:
          options?.authorizeStoredResult ??
          (this.#options.authorizeCommandDisclosure
            ? (snapshot) =>
                this.#options.authorizeCommandDisclosure!(value, snapshot)
            : undefined),
      },
    );
  }

  publish(meta: CommandMeta, release: AgentRelease): Result<AgentRelease> {
    if (!release || !verifyRelease(release)) return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(
      meta,
      "publish-release",
      release.releaseId,
      release,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, release, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const existing = state.releases.get(release.releaseId);
      if (existing) return plan(snapshot, [], existing);
      return plan(
        snapshot,
        [
          {
            aggregateId: release.releaseId,
            factKind: "release-published",
            payload: asPayload({ release }),
          },
        ],
        release,
      );
    });
  }

  activate(
    meta: CommandMeta,
    input: { agentId: string; releaseId: string; epoch: number },
  ): Result<{ agentId: string; releaseId: string; epoch: number }> {
    const value = exactRecord(input, ["agentId", "releaseId", "epoch"]);
    if (
      !value ||
      typeof value.agentId !== "string" ||
      value.agentId.length === 0 ||
      typeof value.releaseId !== "string" ||
      value.releaseId.length === 0 ||
      !Number.isSafeInteger(value.epoch) ||
      (value.epoch as number) < 0
    )
      return fail("invalid_input");
    const decoded = {
      agentId: value.agentId,
      releaseId: value.releaseId,
      epoch: value.epoch as number,
    };
    const metaValue = matchingCommandMeta(
      meta,
      "activate",
      decoded.agentId,
      decoded,
    );
    const precondition = exactRecord(metaValue?.precondition, [
      "expectedCurrentEpoch",
    ]);
    if (
      !metaValue ||
      !precondition ||
      !(
        precondition.expectedCurrentEpoch === null ||
        (Number.isSafeInteger(precondition.expectedCurrentEpoch) &&
          (precondition.expectedCurrentEpoch as number) >= 0)
      )
    )
      return fail("invalid_input");
    const expectedCurrentEpoch = precondition.expectedCurrentEpoch as
      | number
      | null;
    return this.#transact(metaValue, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const release = state.releases.get(decoded.releaseId);
      if (!release) return fail("not_found");
      if (release.spec.agentId !== decoded.agentId)
        return fail("invalid_input");
      const current = state.activations.get(decoded.agentId);
      if ((current?.epoch ?? null) !== expectedCurrentEpoch)
        return fail("stale_epoch");
      if (current && decoded.epoch <= current.epoch) return fail("stale_epoch");
      return plan(
        snapshot,
        [
          {
            aggregateId: decoded.agentId,
            factKind: "activation-active",
            payload: asPayload(decoded),
          },
        ],
        decoded,
      );
    });
  }

  activateMode(
    meta: CommandMeta,
    input: {
      agentId: string;
      releaseId: string;
      epoch: number;
      activationMode: "active" | "shadow";
    },
  ): Result<{
    agentId: string;
    releaseId: string;
    epoch: number;
    activationMode: "active" | "shadow";
  }> {
    const value = exactRecord(input, [
      "agentId",
      "releaseId",
      "epoch",
      "activationMode",
    ]);
    if (
      !value ||
      typeof value.agentId !== "string" ||
      typeof value.releaseId !== "string" ||
      !Number.isSafeInteger(value.epoch) ||
      (value.epoch as number) < 0 ||
      !["active", "shadow"].includes(String(value.activationMode))
    )
      return fail("invalid_input");
    const decoded = {
      agentId: value.agentId,
      releaseId: value.releaseId,
      epoch: value.epoch as number,
      activationMode: value.activationMode as "active" | "shadow",
    };
    const metaValue = matchingCommandMeta(
      meta,
      "activate-mode",
      decoded.agentId,
      decoded,
    );
    const precondition = exactRecord(metaValue?.precondition, [
      "expectedCurrentEpoch",
    ]);
    if (!metaValue || !precondition) return fail("invalid_input");
    const expectedCurrentEpoch = precondition.expectedCurrentEpoch;
    if (
      expectedCurrentEpoch !== null &&
      (!Number.isSafeInteger(expectedCurrentEpoch) ||
        (expectedCurrentEpoch as number) < 0)
    )
      return fail("invalid_input");
    return this.#transact(metaValue, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const release = state.releases.get(decoded.releaseId);
      if (!release || release.spec.agentId !== decoded.agentId)
        return fail("not_found");
      const current = state.activations.get(decoded.agentId);
      if ((current?.epoch ?? null) !== expectedCurrentEpoch)
        return fail("stale_epoch");
      if (current && decoded.epoch <= current.epoch) return fail("stale_epoch");
      return plan(
        snapshot,
        [
          {
            aggregateId: decoded.agentId,
            factKind: "activation-active",
            payload: asPayload({
              agentId: decoded.agentId,
              releaseId: decoded.releaseId,
              epoch: decoded.epoch,
              mode: decoded.activationMode,
            }),
          },
        ],
        decoded,
      );
    });
  }

  admitIntentFromWire(
    authorityInput: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: IntentAdmissionInput,
  ): Result<IntentAdmissionResult> {
    const authority = decodeAuthorityContext(authorityInput);
    if (!authority || !HEX_64.test(ifMatch)) return fail("invalid_input");
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const state = reduceFacts(snapshot.value.facts);
      const activation = state.activations.get(input.agentId);
      const release = activation
        ? state.releases.get(activation.releaseId)
        : undefined;
      const descriptor = release?.spec.intentDescriptors.find(
        ({ intentId }) => intentId === input.intentId,
      );
      if (!activation || !release || !descriptor) return fail("not_found");
      if (release.releaseId !== ifMatch) return fail("stale_epoch");
      const actor = actorSubjectId(authority);
      const runId = intentRunId(
        actor,
        input.agentId,
        input.intentId,
        idempotencyKey,
      );
      return this.admitIntent(
        authority,
        commandMeta(
          actor,
          "admit-intent",
          runId,
          idempotencyKey,
          input,
          {
            releaseId: release.releaseId,
            activationEpoch: activation.epoch,
            inputSchemaDigest: descriptor.inputSchema.digest,
          },
          digestJson(authority),
        ),
        input,
      );
    } catch {
      return fail("invalid_state");
    }
  }

  admitIntent(
    authorityInput: AuthorityContext,
    meta: CommandMeta,
    input: IntentAdmissionInput,
  ): Result<IntentAdmissionResult> {
    const raw = exactRecord(input, [
      "agentId",
      "intentId",
      "descriptorVersion",
      "executionMode",
      "input",
    ]);
    const metadata = validateControlMetadataInput(raw?.input);
    const authority = decodeAuthorityContext(authorityInput);
    if (
      !raw ||
      !metadata.ok ||
      !authority ||
      authority.audience !== "hangar-control" ||
      typeof raw.agentId !== "string" ||
      raw.agentId.length === 0 ||
      typeof raw.intentId !== "string" ||
      raw.intentId.length === 0 ||
      !Number.isSafeInteger(raw.descriptorVersion) ||
      (raw.descriptorVersion as number) < 1 ||
      !["shadow-evaluator", "production"].includes(String(raw.executionMode))
    )
      return fail("invalid_input");
    const decoded: IntentAdmissionInput = {
      agentId: raw.agentId,
      intentId: raw.intentId,
      descriptorVersion: raw.descriptorVersion as number,
      executionMode: raw.executionMode as ExecutionMode,
      input: metadata.value,
    };
    const expectedActor = actorSubjectId(authority);
    const runId = intentRunId(
      expectedActor,
      decoded.agentId,
      decoded.intentId,
      meta?.idempotencyKey,
    );
    const metaValue = matchingCommandMeta(meta, "admit-intent", runId, decoded);
    const precondition = exactRecord(metaValue?.precondition, [
      "releaseId",
      "activationEpoch",
      "inputSchemaDigest",
    ]);
    if (
      !metaValue ||
      metaValue.actorSubjectId !== expectedActor ||
      metaValue.authorityContextDigest !== digestJson(authority) ||
      !precondition ||
      typeof precondition.releaseId !== "string" ||
      !Number.isSafeInteger(precondition.activationEpoch) ||
      typeof precondition.inputSchemaDigest !== "string" ||
      !HEX_64.test(precondition.inputSchemaDigest)
    )
      return fail("invalid_input");
    return this.#transact(metaValue, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const activation = state.activations.get(decoded.agentId);
      const release = activation
        ? state.releases.get(activation.releaseId)
        : undefined;
      if (!activation || !release) return fail("not_found");
      if (
        precondition.releaseId !== release.releaseId ||
        precondition.activationEpoch !== activation.epoch
      )
        return fail("stale_epoch");
      const descriptor = release.spec.intentDescriptors.find(
        ({ intentId }) => intentId === decoded.intentId,
      );
      if (!descriptor) return fail("not_found");
      if (
        descriptor.descriptorVersion !== decoded.descriptorVersion ||
        descriptor.inputSchema.digest !== precondition.inputSchemaDigest
      )
        return fail("invalid_state");
      if (!authority.effectiveScope.includes(descriptor.scope))
        return fail("forbidden");
      const mutationGrant = [
        ...release.spec.capabilities,
        ...release.spec.effectOperations,
      ].some(
        (name) => name.startsWith("mutation.") || name.startsWith("external."),
      );
      if (decoded.executionMode === "shadow-evaluator") {
        if (activation.mode !== "shadow" || mutationGrant)
          return fail("forbidden");
      } else if (
        activation.mode !== "active" ||
        this.#options.productionEligible?.(release, decoded.agentId) !== true
      ) {
        return fail("forbidden");
      }
      if (state.runs.has(runId)) return fail("idempotency_conflict");
      const token = attemptToken(runId, 0);
      const inputDigest = digestJson(decoded.input);
      const promptDigest = attemptPromptDigest(release, decoded);
      const result: IntentAdmissionResult = {
        runId,
        releaseId: release.releaseId,
        activationEpoch: activation.epoch,
        executionMode: decoded.executionMode,
        inputDigest,
        promptDigest,
      };
      return plan(
        snapshot,
        [
          {
            aggregateId: runId,
            factKind: "run-admitted",
            payload: asPayload({
              runId,
              agentId: decoded.agentId,
              releaseId: release.releaseId,
              activationEpoch: activation.epoch,
              token,
              actorSubjectId: expectedActor,
              executionMode: decoded.executionMode,
              intentId: decoded.intentId,
              intentDescriptorVersion: descriptor.descriptorVersion,
              inputSchemaId: descriptor.inputSchema.id,
              inputSchemaVersion: descriptor.inputSchema.version,
              inputSchemaDigest: descriptor.inputSchema.digest,
              controlMetadata: decoded.input,
              inputDigest,
              promptDigest,
            }),
          },
          {
            aggregateId: runId,
            factKind: "attempt-prompt-bound",
            payload: asPayload({
              runId,
              attempt: 0,
              releaseId: release.releaseId,
              inputDigest,
              promptDigest,
            }),
          },
        ],
        result,
      );
    });
  }

  admit(
    meta: CommandMeta,
    input: {
      runId: string;
      agentId: string;
      releaseId: string;
      activationEpoch: number;
    },
  ): Result<AttemptToken> {
    const value = exactRecord(input, [
      "runId",
      "agentId",
      "releaseId",
      "activationEpoch",
    ]);
    if (
      !value ||
      typeof value.runId !== "string" ||
      value.runId.length === 0 ||
      typeof value.agentId !== "string" ||
      value.agentId.length === 0 ||
      typeof value.releaseId !== "string" ||
      value.releaseId.length === 0 ||
      !Number.isSafeInteger(value.activationEpoch) ||
      (value.activationEpoch as number) < 0
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      agentId: value.agentId,
      releaseId: value.releaseId,
      activationEpoch: value.activationEpoch as number,
    };
    const metaValue = matchingCommandMeta(
      meta,
      "admit",
      decoded.runId,
      decoded,
    );
    const precondition = exactRecord(metaValue?.precondition, [
      "releaseId",
      "activationEpoch",
    ]);
    if (
      !metaValue ||
      !precondition ||
      typeof precondition.releaseId !== "string" ||
      precondition.releaseId.length === 0 ||
      !Number.isSafeInteger(precondition.activationEpoch) ||
      (precondition.activationEpoch as number) < 0
    )
      return fail("invalid_input");
    return this.#transact(metaValue, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const activation = state.activations.get(decoded.agentId);
      if (
        precondition.releaseId !== decoded.releaseId ||
        precondition.activationEpoch !== decoded.activationEpoch ||
        !activation ||
        activation.releaseId !== decoded.releaseId ||
        activation.epoch !== decoded.activationEpoch
      )
        return fail("stale_epoch");
      if (state.runs.has(decoded.runId)) return fail("idempotency_conflict");
      const token = attemptToken(decoded.runId, 0);
      return plan(
        snapshot,
        [
          {
            aggregateId: decoded.runId,
            factKind: "run-admitted",
            payload: asPayload({ ...decoded, token }),
          },
        ],
        token,
      );
    });
  }

  harness(token: AttemptToken): HarnessSession {
    return new HarnessSession(this, token);
  }

  submitHarness(
    meta: CommandMeta,
    token: AttemptToken,
    input: HarnessInput,
  ): Result<HarnessSubmitResult> {
    const raw = input as unknown;
    const type =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { type?: unknown }).type
        : undefined;
    let decoded: HarnessInput;
    if (type === "action") {
      const envelope = exactRecord(raw, ["type", "action"]);
      const value = exactRecord(
        envelope?.action,
        ["actionId", "kind", "inputDigest"],
        ["parentActionId"],
      );
      if (
        !value ||
        typeof value.actionId !== "string" ||
        value.actionId.length === 0 ||
        !["tool", "subagent", "provider"].includes(String(value.kind)) ||
        typeof value.inputDigest !== "string" ||
        (value.parentActionId !== undefined &&
          typeof value.parentActionId !== "string")
      )
        return fail("invalid_input");
      const action: ActionInput = {
        actionId: value.actionId,
        kind: value.kind as ActionInput["kind"],
        inputDigest: value.inputDigest,
        ...(typeof value.parentActionId === "string"
          ? { parentActionId: value.parentActionId }
          : {}),
      };
      decoded = { type, action };
    } else if (type === "tool-observation") {
      const envelope = exactRecord(raw, ["type", "observation"]);
      const value = exactRecord(envelope?.observation, [
        "actionId",
        "toolId",
        "outputDigest",
        "grantGeneration",
      ]);
      if (
        !value ||
        typeof value.actionId !== "string" ||
        typeof value.toolId !== "string" ||
        typeof value.outputDigest !== "string" ||
        !HEX_64.test(value.outputDigest) ||
        !Number.isSafeInteger(value.grantGeneration)
      )
        return fail("invalid_input");
      const observation: ToolObservationInput = {
        actionId: value.actionId,
        toolId: value.toolId,
        outputDigest: value.outputDigest,
        grantGeneration: value.grantGeneration as number,
      };
      decoded = { type, observation };
    } else if (type === "effect-intent") {
      const envelope = exactRecord(raw, ["type", "effect"]);
      const value = exactRecord(envelope?.effect, [
        "actionId",
        "intentKey",
        "intentGeneration",
        "operation",
        "payloadDigest",
      ]);
      if (
        !value ||
        ![
          value.actionId,
          value.intentKey,
          value.operation,
          value.payloadDigest,
        ].every((part) => typeof part === "string" && part.length > 0) ||
        !Number.isSafeInteger(value.intentGeneration)
      )
        return fail("invalid_input");
      const effect: EffectIntentInput = {
        actionId: value.actionId as string,
        intentKey: value.intentKey as string,
        intentGeneration: value.intentGeneration as number,
        operation: value.operation as string,
        payloadDigest: value.payloadDigest as string,
      };
      decoded = { type, effect };
    } else if (type === "checkpoint") {
      const envelope = exactRecord(raw, ["type", "checkpoint"]);
      const value = exactRecord(
        envelope?.checkpoint,
        [
          "checkpointId",
          "producerActionId",
          "schema",
          "artifactDigest",
          "obligationOwner",
          "obligationGeneration",
        ],
        ["effectId"],
      );
      if (
        !value ||
        ![
          value.checkpointId,
          value.producerActionId,
          value.schema,
          value.artifactDigest,
        ].every((part) => typeof part === "string" && part.length > 0) ||
        !["control-core", "effect-gateway"].includes(
          String(value.obligationOwner),
        ) ||
        !Number.isSafeInteger(value.obligationGeneration) ||
        (value.effectId !== undefined && typeof value.effectId !== "string")
      )
        return fail("invalid_input");
      const checkpoint: CheckpointInput = {
        checkpointId: value.checkpointId as string,
        producerActionId: value.producerActionId as string,
        schema: value.schema as string,
        artifactDigest: value.artifactDigest as string,
        obligationOwner:
          value.obligationOwner as CheckpointInput["obligationOwner"],
        obligationGeneration: value.obligationGeneration as number,
        ...(typeof value.effectId === "string"
          ? { effectId: value.effectId }
          : {}),
      };
      decoded = { type, checkpoint };
    } else if (type === "outcome-proposal") {
      const envelope = exactRecord(raw, ["type", "proposal"]);
      const value = exactRecord(envelope?.proposal, ["artifactDigest"]);
      if (!value || typeof value.artifactDigest !== "string")
        return fail("invalid_input");
      const proposal: OutcomeProposalInput = {
        artifactDigest: value.artifactDigest,
      };
      decoded = { type, proposal };
    } else {
      return fail("invalid_input");
    }

    const expectedCommandKind =
      decoded.type === "action"
        ? "register-action"
        : decoded.type === "tool-observation"
          ? "tool-observation"
          : decoded.type === "effect-intent"
            ? "effect-intent"
            : decoded.type === "checkpoint"
              ? "checkpoint"
              : "outcome-proposal";
    const decodedMeta = matchingCommandMeta(
      meta,
      expectedCommandKind,
      token?.runId,
      decoded,
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(token.runId);
      if (run?.cancelRequested) return fail("terminal_conflict");
      if (!validToken(run, token)) return fail("stale_attempt");
      if (!currentActivation(state, run!)) return fail("stale_epoch");
      const drafts: FactDraft[] = [];
      let submitResult: HarnessSubmitResult = null;
      if (decoded.type === "action") {
        if (
          decodedMeta.commandKind !== "register-action" ||
          !HEX_64.test(decoded.action.inputDigest)
        )
          return fail("invalid_input");
        const prior = run!.actions.get(decoded.action.actionId);
        const binding = asJson({ attempt: token.attempt, ...decoded.action });
        if (prior && digestJson(prior) !== digestJson(binding))
          return fail("idempotency_conflict");
        if (
          decoded.action.parentActionId &&
          !run!.actions.has(decoded.action.parentActionId)
        )
          return fail("invalid_input");
        if (!prior)
          drafts.push({
            aggregateId: token.runId,
            factKind: "action-registered",
            payload: asPayload({
              runId: token.runId,
              actionId: decoded.action.actionId,
              binding,
            }),
          });
      } else if (decoded.type === "tool-observation") {
        if (decodedMeta.commandKind !== "tool-observation")
          return fail("invalid_input");
        const release = state.releases.get(run!.releaseId)!;
        if (
          actionAttempt(run!, decoded.observation.actionId) !== token.attempt ||
          actionKind(run!, decoded.observation.actionId) !== "tool" ||
          !release.spec.capabilities.includes(decoded.observation.toolId) ||
          decoded.observation.grantGeneration !== token.generation
        )
          return fail("invalid_input");
        const prior = run!.toolObservations.get(decoded.observation.actionId);
        const observation: InternalToolObservation = {
          attempt: token.attempt,
          ...decoded.observation,
        };
        if (prior)
          return digestJson(prior) === digestJson(observation)
            ? plan(snapshot, [], null)
            : fail("idempotency_conflict");
        drafts.push({
          aggregateId: token.runId,
          factKind: "tool-observed",
          payload: asPayload({
            runId: token.runId,
            attempt: token.attempt,
            observation: decoded.observation,
          }),
        });
      } else if (decoded.type === "effect-intent") {
        if (decodedMeta.commandKind !== "effect-intent")
          return fail("invalid_input");
        const release = state.releases.get(run!.releaseId)!;
        if (
          actionAttempt(run!, decoded.effect.actionId) !== token.attempt ||
          !release.spec.effectOperations.includes(decoded.effect.operation) ||
          !HEX_64.test(decoded.effect.payloadDigest) ||
          decoded.effect.intentGeneration < 0
        )
          return fail("invalid_input");
        const effectId = digestJson([
          "effect-v1",
          token.runId,
          decoded.effect.intentKey,
          decoded.effect.intentGeneration,
        ]);
        const sameIntent = [...run!.effects.entries()].find(
          ([, effect]) =>
            effect.intentKey === decoded.effect.intentKey &&
            effect.intentGeneration === decoded.effect.intentGeneration,
        );
        if (sameIntent) {
          const [priorId, prior] = sameIntent;
          return prior.operation === decoded.effect.operation &&
            prior.payloadDigest === decoded.effect.payloadDigest
            ? plan(snapshot, [], { effectId: priorId })
            : fail("idempotency_conflict");
        }
        submitResult = { effectId };
        const expiresAtUnixMs =
          this.#now() + (this.#options.approvalTtlMs ?? 60_000);
        drafts.push(
          {
            aggregateId: token.runId,
            factKind: "effect-intent",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              effectId,
              ...decoded.effect,
            }),
          },
          {
            aggregateId: token.runId,
            factKind: "approval-opened",
            payload: asPayload({
              runId: token.runId,
              effectId,
              expiresAtUnixMs,
            }),
          },
        );
      } else if (decoded.type === "checkpoint") {
        if (decodedMeta.commandKind !== "checkpoint")
          return fail("invalid_input");
        const release = state.releases.get(run!.releaseId)!;
        const effect = decoded.checkpoint.effectId
          ? run!.effects.get(decoded.checkpoint.effectId)
          : undefined;
        const obligationValid = decoded.checkpoint.effectId
          ? decoded.checkpoint.obligationOwner === "effect-gateway" &&
            effect?.originAttempt === token.attempt &&
            effect.intentGeneration === decoded.checkpoint.obligationGeneration
          : decoded.checkpoint.obligationOwner === "control-core" &&
            decoded.checkpoint.obligationGeneration === token.generation;
        const checkpoint: InternalCheckpoint = { ...decoded.checkpoint };
        const priorAttempt = run!.checkpoints.get(token.attempt);
        const priorIdentity = [...run!.checkpoints.values()].find(
          (candidate) =>
            candidate.checkpointId === decoded.checkpoint.checkpointId,
        );
        if (
          decoded.checkpoint.schema !== release.spec.checkpointSchema ||
          !HEX_64.test(decoded.checkpoint.artifactDigest) ||
          actionAttempt(run!, decoded.checkpoint.producerActionId) !==
            token.attempt ||
          !obligationValid
        )
          return fail("invalid_input");
        if (priorAttempt || priorIdentity) {
          const prior = priorAttempt ?? priorIdentity!;
          return digestJson(prior) === digestJson(checkpoint)
            ? plan(snapshot, [], null)
            : fail("idempotency_conflict");
        }
        drafts.push({
          aggregateId: token.runId,
          factKind: "checkpoint-recorded",
          payload: asPayload({
            runId: token.runId,
            attempt: token.attempt,
            checkpoint,
          }),
        });
      } else {
        if (
          decodedMeta.commandKind !== "outcome-proposal" ||
          !HEX_64.test(decoded.proposal.artifactDigest)
        )
          return fail("invalid_input");
        const prior = run!.proposedOutcomes.get(token.attempt);
        if (prior)
          return prior === decoded.proposal.artifactDigest
            ? plan(snapshot, [], null)
            : fail("idempotency_conflict");
        drafts.push({
          aggregateId: token.runId,
          factKind: "outcome-proposed",
          payload: asPayload({
            runId: token.runId,
            attempt: token.attempt,
            artifactDigest: decoded.proposal.artifactDigest,
          }),
        });
      }
      return plan(snapshot, drafts, submitResult);
    });
  }

  recordOutcomeAcceptance(
    authority: symbol,
    meta: CommandMeta,
    input: { runId: string; attempt: number; artifactDigest: string },
  ): Result<null> {
    const value = exactRecord(input, ["runId", "attempt", "artifactDigest"]);
    if (
      authority !== OUTCOME_OWNER ||
      !value ||
      typeof value.runId !== "string" ||
      value.runId.length === 0 ||
      !Number.isSafeInteger(value.attempt) ||
      (value.attempt as number) < 0 ||
      typeof value.artifactDigest !== "string" ||
      !HEX_64.test(value.artifactDigest)
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      attempt: value.attempt as number,
      artifactDigest: value.artifactDigest,
    };
    const decodedMeta = matchingCommandMeta(
      meta,
      "accept-outcome",
      decoded.runId,
      decoded,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(decoded.runId);
      if (!run) return fail("not_found");
      if (run.cancelRequested) return fail("terminal_conflict");
      const release = state.releases.get(run.releaseId);
      const observations = [...run.toolObservations.values()]
        .filter((observation) => observation.attempt === decoded.attempt)
        .map(({ attempt: _attempt, ...observation }) => observation);
      if (
        run.currentAttempt !== decoded.attempt ||
        run.proposedOutcomes.get(decoded.attempt) !== decoded.artifactDigest ||
        !release ||
        !this.#options.outcomeGate?.({
          release,
          runId: decoded.runId,
          attempt: decoded.attempt,
          artifactDigest: decoded.artifactDigest,
          toolObservations: observations,
        })
      )
        return fail("invalid_state");
      const accepted = run.acceptedOutcomes.get(decoded.attempt);
      if (accepted)
        return accepted === decoded.artifactDigest
          ? plan(snapshot, [], null)
          : fail("idempotency_conflict");
      return plan(
        snapshot,
        [
          {
            aggregateId: decoded.runId,
            factKind: "outcome-accepted",
            payload: asPayload(decoded),
          },
        ],
        null,
      );
    });
  }

  registerProcess(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
    process: ProcessIdentity,
  ): Result<null> {
    const value = exactRecord(process, [
      "pid",
      "processGroupId",
      "startFingerprint",
      "containmentGeneration",
    ]);
    if (
      authority !== PROCESS_OWNER ||
      !value ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      !Number.isSafeInteger(value.processGroupId) ||
      (value.processGroupId as number) <= 0 ||
      typeof value.startFingerprint !== "string" ||
      value.startFingerprint.length === 0 ||
      !Number.isSafeInteger(value.containmentGeneration) ||
      (value.containmentGeneration as number) <= 0
    )
      return fail("invalid_input");
    const decoded: ProcessIdentity = {
      pid: value.pid as number,
      processGroupId: value.processGroupId as number,
      startFingerprint: value.startFingerprint,
      containmentGeneration: value.containmentGeneration as number,
    };
    const decodedMeta = matchingCommandMeta(
      meta,
      "register-process",
      token?.runId,
      decoded,
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(token.runId);
      if (run?.cancelRequested) return fail("terminal_conflict");
      if (!validToken(run, token)) return fail("stale_attempt");
      if (!currentActivation(state, run!)) return fail("stale_epoch");
      if (!processExists(decoded.pid)) return fail("invalid_input");
      const prior = run!.processes.get(token.attempt);
      if (prior)
        return digestJson(prior) === digestJson(decoded)
          ? plan(snapshot, [], null)
          : fail("idempotency_conflict");
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind: "process-registered",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              process: decoded,
            }),
          },
        ],
        null,
      );
    });
  }

  recordTechnicalExit(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
    exitCode: number,
  ): Result<null> {
    if (
      authority !== PROCESS_OWNER ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0
    )
      return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(
      meta,
      "technical-exit",
      token?.runId,
      { exitCode },
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, { exitCode }, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(token.runId);
      if (!validToken(run, token)) return fail("stale_attempt");
      const registered = run!.processes.get(token.attempt);
      if (!registered || processExists(registered.pid))
        return fail("invalid_state");
      const settled: AttemptState =
        exitCode === 0
          ? run!.checkpoints.has(token.attempt)
            ? "checkpointed"
            : "succeeded"
          : "failed";
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind: "attempt-settled",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              state: settled,
              exitCode,
            }),
          },
        ],
        null,
      );
    });
  }

  markContainmentReaped(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
  ): Result<null> {
    return this.#attemptFact(
      authority,
      meta,
      token,
      "reap-containment",
      "containment-reaped",
    );
  }

  revokeGrant(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
  ): Result<null> {
    return this.#attemptFact(
      authority,
      meta,
      token,
      "revoke-grant",
      "grant-revoked",
    );
  }

  #attemptFact(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
    commandKind: string,
    factKind: string,
  ): Result<null> {
    if (authority !== PROCESS_OWNER) return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(
      meta,
      commandKind,
      token?.runId,
      { factKind },
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, { factKind }, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(token.runId);
      if (!run || !matchesStoredToken(run, token)) return fail("stale_attempt");
      const registered = run.processes.get(token.attempt);
      if (factKind === "containment-reaped" && run.reaped.has(token.attempt))
        return plan(snapshot, [], null);
      if (factKind === "grant-revoked" && run.revoked.has(token.attempt))
        return plan(snapshot, [], null);
      if (
        factKind === "containment-reaped" &&
        (!registered ||
          processExists(registered.pid) ||
          processGroupExists(registered.processGroupId))
      )
        return fail("invalid_state");
      if (factKind === "grant-revoked" && !run.reaped.has(token.attempt))
        return fail("invalid_state");
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind,
            payload: asPayload({ runId: token.runId, attempt: token.attempt }),
          },
        ],
        null,
      );
    });
  }

  quiesce(
    meta: CommandMeta,
    token: AttemptToken,
    checkpointId: string,
  ): Result<null> {
    if (typeof checkpointId !== "string" || checkpointId.length === 0)
      return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(meta, "quiesce", token?.runId, {
      checkpointId,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, { checkpointId }, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(token.runId);
      if (run?.cancelRequested) return fail("terminal_conflict");
      if (!run || !matchesStoredToken(run, token)) return fail("stale_attempt");
      const checkpoint = run.checkpoints.get(token.attempt);
      const fence = attemptFence(run, token.attempt);
      const effectsFinal = [...run.effects.values()].every((effect) =>
        ["committed", "not-committed"].includes(effect.state),
      );
      if (
        checkpoint?.checkpointId !== checkpointId ||
        !fence ||
        !["checkpointed", "succeeded", "failed", "cancelled"].includes(
          run.attempts.get(token.attempt) ?? "running",
        ) ||
        !run.reaped.has(token.attempt) ||
        !run.revoked.has(token.attempt) ||
        !effectsFinal
      )
        return fail("invalid_state");
      const existing = run.quiesced.get(token.attempt);
      if (existing)
        return existing.fenceDigest === fence.fenceDigest && !existing.consumed
          ? plan(snapshot, [], null)
          : fail("idempotency_conflict");
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind: "attempt-quiesced",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              ...fence,
            }),
          },
        ],
        null,
      );
    });
  }

  resume(
    meta: CommandMeta,
    input: { runId: string; checkpointId: string },
  ): Result<AttemptToken> {
    const value = exactRecord(input, ["runId", "checkpointId"]);
    if (
      !value ||
      typeof value.runId !== "string" ||
      value.runId.length === 0 ||
      typeof value.checkpointId !== "string" ||
      value.checkpointId.length === 0
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      checkpointId: value.checkpointId,
    };
    const decodedMeta = matchingCommandMeta(meta, "resume", decoded.runId, {
      checkpointId: decoded.checkpointId,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(
      decodedMeta,
      { checkpointId: decoded.checkpointId },
      (snapshot) => {
        const state = reduceFacts(snapshot.facts);
        const run = state.runs.get(decoded.runId);
        if (!run || run.state !== "waiting") return fail("invalid_state");
        if (run.cancelRequested) return fail("terminal_conflict");
        if (!currentActivation(state, run)) return fail("stale_epoch");
        const oldAttempt = run.currentAttempt;
        const quiescence = run.quiesced.get(oldAttempt);
        if (
          !quiescence ||
          quiescence.consumed ||
          quiescence.checkpointId !== decoded.checkpointId
        )
          return fail("invalid_state");
        const currentFence = attemptFence(run, oldAttempt);
        if (
          !currentFence ||
          currentFence.fenceDigest !== quiescence.fenceDigest
        )
          return fail("invalid_state");
        const next = oldAttempt + 1;
        const token = attemptToken(decoded.runId, next);
        return plan(
          snapshot,
          [
            {
              aggregateId: decoded.runId,
              factKind: "quiescence-consumed",
              payload: asPayload({ runId: decoded.runId, attempt: oldAttempt }),
            },
            {
              aggregateId: decoded.runId,
              factKind: "attempt-allocated",
              payload: asPayload({
                runId: decoded.runId,
                attempt: next,
                token,
              }),
            },
          ],
          token,
        );
      },
    );
  }

  terminalize(
    meta: CommandMeta,
    input: { runId: string; state: "completed" | "failed" | "cancelled" },
  ): Result<RunView> {
    const value = exactRecord(input, ["runId", "state"]);
    if (
      !value ||
      typeof value.runId !== "string" ||
      value.runId.length === 0 ||
      !(["completed", "failed", "cancelled"] as readonly unknown[]).includes(
        value.state,
      )
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      state: value.state as "completed" | "failed" | "cancelled",
    };
    const decodedMeta = matchingCommandMeta(
      meta,
      "terminalize",
      decoded.runId,
      { state: decoded.state },
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, { state: decoded.state }, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(decoded.runId);
      if (!run) return fail("not_found");
      if (
        run.cancelRequested ||
        ["completed", "failed", "cancelled"].includes(run.state)
      )
        return fail("terminal_conflict");
      const attemptState = run.attempts.get(run.currentAttempt) ?? "running";
      const effectsFinal = [...run.effects.values()].every((effect) =>
        ["committed", "not-committed"].includes(effect.state),
      );
      const terminalMatchesAttempt =
        (decoded.state === "completed" &&
          attemptState === "succeeded" &&
          run.acceptedOutcomes.has(run.currentAttempt)) ||
        (decoded.state === "failed" && attemptState === "failed") ||
        (decoded.state === "cancelled" && attemptState === "cancelled");
      if (
        !terminalMatchesAttempt ||
        !run.reaped.has(run.currentAttempt) ||
        !run.revoked.has(run.currentAttempt) ||
        !effectsFinal
      )
        return fail("invalid_state");
      const drafts: FactDraft[] = [
        {
          aggregateId: decoded.runId,
          factKind: "run-terminal",
          payload: asPayload(decoded),
        },
      ];
      const next = stateWithDrafts(snapshot, drafts).runs.get(decoded.runId)!;
      return plan(snapshot, drafts, view(next));
    });
  }

  recordHarnessFault(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
  ): Result<null> {
    if (authority !== PI_CHILD_OWNER) return fail("forbidden");
    const input = { reasonCode: "adapter-fault" as const };
    const decodedMeta = matchingCommandMeta(
      meta,
      "harness-fault",
      token.runId,
      input,
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, input, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(token.runId);
      if (!run || !matchesStoredToken(run, token)) return fail("stale_attempt");
      if (run.cancelRequested) return fail("terminal_conflict");
      if (
        ["succeeded", "failed", "cancelled"].includes(
          run.attempts.get(token.attempt) ?? "",
        )
      )
        return fail("terminal_conflict");
      if (run.faultedAttempts.has(token.attempt))
        return plan(snapshot, [], null);
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind: "attempt-fault-recorded",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              reasonCode: input.reasonCode,
            }),
          },
        ],
        null,
      );
    });
  }

  recordPiCleanup(
    authority: symbol,
    meta: CommandMeta,
    token: AttemptToken,
    evidence: HarnessCleanupEvidence,
  ): Result<{ runId: string; attempt: number; state: "succeeded" | "failed" }> {
    if (authority !== PI_CHILD_OWNER) return fail("forbidden");
    const input = { evidence };
    const decodedMeta = matchingCommandMeta(
      meta,
      "pi-cleanup",
      token.runId,
      input,
      token,
    );
    if (!decodedMeta) return fail("invalid_input");
    if (
      !evidence.ipcDrained ||
      !evidence.stdoutDrained ||
      !evidence.stderrDrained ||
      !evidence.wholeTreeReaped ||
      !evidence.grantRevoked
    )
      return fail("invalid_state");
    return this.#transact(decodedMeta, input, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(token.runId);
      if (!run || !matchesStoredToken(run, token)) return fail("stale_attempt");
      if (run.cancelRequested) return fail("terminal_conflict");
      const cause =
        run.acceptedOutcomes.has(token.attempt) &&
        !run.faultedAttempts.has(token.attempt)
          ? ("succeeded" as const)
          : ("failed" as const);
      const existing = run.attempts.get(token.attempt);
      if (["succeeded", "failed"].includes(existing ?? ""))
        return existing === cause
          ? plan(snapshot, [], {
              runId: token.runId,
              attempt: token.attempt,
              state: cause,
            })
          : fail("terminal_conflict");
      return plan(
        snapshot,
        [
          {
            aggregateId: token.runId,
            factKind: "attempt-settled",
            payload: asPayload({
              runId: token.runId,
              attempt: token.attempt,
              state: cause,
            }),
          },
          {
            aggregateId: token.runId,
            factKind: "containment-reaped",
            payload: asPayload({ runId: token.runId, attempt: token.attempt }),
          },
          {
            aggregateId: token.runId,
            factKind: "grant-revoked",
            payload: asPayload({ runId: token.runId, attempt: token.attempt }),
          },
        ],
        { runId: token.runId, attempt: token.attempt, state: cause },
      );
    });
  }

  cancelFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: { runId: string; reasonCode: "user-requested" },
  ) {
    const current = this.readRun(authority, input.runId);
    if (!current.ok) return current;
    if (digestJson(current.value.value) !== ifMatch) return fail("stale_epoch");
    const actor = actorSubjectId(authority);
    return this.cancel(
      commandMeta(
        actor,
        "cancel-run",
        input.runId,
        idempotencyKey,
        input,
        { expectedRunDigest: ifMatch },
        digestJson(authority),
      ),
      input,
    );
  }

  cancel(
    meta: CommandMeta,
    input: { runId: string; reasonCode: "user-requested" },
  ): Result<{
    runId: string;
    cancelStatus: "cleanup-pending" | "cancel-pending-reconciliation";
    fenceGeneration: number;
  }> {
    const value = exactRecord(input, ["runId", "reasonCode"]);
    if (
      !value ||
      typeof value.runId !== "string" ||
      value.reasonCode !== "user-requested"
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      reasonCode: "user-requested" as const,
    };
    const decodedMeta = matchingCommandMeta(
      meta,
      "cancel-run",
      decoded.runId,
      decoded,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, decoded, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(decoded.runId);
      if (!run) return fail("not_found");
      if (["completed", "failed", "cancelled"].includes(run.state))
        return fail("terminal_conflict");
      if (run.cancelRequested) return fail("invalid_state");
      const fenceGeneration = run.cancelFenceGeneration + 1;
      const drafts: FactDraft[] = [];
      let pendingReconciliation = false;
      for (const [effectId, effect] of run.effects) {
        if (effect.localDispatchResult) continue;
        if (["pending", "approved", "claimed"].includes(effect.state)) {
          if (["pending", "approved"].includes(effect.state))
            drafts.push({
              aggregateId: decoded.runId,
              factKind: "approval-superseded",
              payload: asPayload({
                runId: decoded.runId,
                effectId,
                fenceGeneration,
              }),
            });
          drafts.push({
            aggregateId: decoded.runId,
            factKind: "local-dispatch-result",
            payload: asPayload({
              runId: decoded.runId,
              effectId,
              status: "claim-revoked",
              fenceGeneration,
            }),
          });
        } else if (
          effect.state === "dispatch-started" ||
          effect.state === "unknown"
        ) {
          pendingReconciliation = true;
          if (!run.reconciliationWake.has(effectId))
            drafts.push({
              aggregateId: decoded.runId,
              factKind: "reconciliation-wake",
              payload: asPayload({
                runId: decoded.runId,
                effectId,
                fenceGeneration,
              }),
            });
        }
      }
      drafts.unshift({
        aggregateId: decoded.runId,
        factKind: "cancel-requested",
        payload: asPayload({
          runId: decoded.runId,
          currentAttempt: run.currentAttempt,
          fenceGeneration,
          pendingReconciliation,
          reasonCode: decoded.reasonCode,
        }),
      });
      const result = {
        runId: decoded.runId,
        cancelStatus: pendingReconciliation
          ? ("cancel-pending-reconciliation" as const)
          : ("cleanup-pending" as const),
        fenceGeneration,
      };
      return plan(snapshot, drafts, result);
    });
  }

  recordCancelCleanup(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
  ): Result<{ runId: string; state: "cancelled" }> {
    if (authority !== CANCEL_OWNER) return fail("forbidden");
    const decodedMeta = matchingCommandMeta(meta, "cancel-cleanup", runId, {
      runId,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, { runId }, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(runId);
      if (!run) return fail("not_found");
      if (!run.cancelRequested) return fail("invalid_state");
      if (run.state === "cancelled")
        return plan(snapshot, [], { runId, state: "cancelled" as const });
      if (
        [...run.effects.values()].some(
          (effect) =>
            effect.state === "dispatch-started" || effect.state === "unknown",
        )
      )
        return fail("invalid_state");
      const attempt = run.currentAttempt;
      if (run.processes.has(attempt) && !run.reaped.has(attempt))
        return fail("invalid_state");
      const drafts: FactDraft[] = [];
      if (run.attempts.get(attempt) === "running")
        drafts.push({
          aggregateId: runId,
          factKind: "attempt-settled",
          payload: asPayload({ runId, attempt, state: "cancelled" }),
        });
      if (!run.revoked.has(attempt))
        drafts.push({
          aggregateId: runId,
          factKind: "grant-revoked",
          payload: asPayload({ runId, attempt }),
        });
      drafts.push({
        aggregateId: runId,
        factKind: "run-terminal",
        payload: asPayload({ runId, state: "cancelled" }),
      });
      return plan(snapshot, drafts, { runId, state: "cancelled" as const });
    });
  }

  authorizeLaunch(token: AttemptToken): Result<AgentRelease> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const state = reduceFacts(snapshot.value.facts);
      const run = state.runs.get(token.runId);
      if (run?.cancelRequested) return fail("terminal_conflict");
      if (!validToken(run, token)) return fail("stale_attempt");
      if (!currentActivation(state, run!)) return fail("stale_epoch");
      const release = state.releases.get(run!.releaseId);
      return release && verifyRelease(release)
        ? ok(release)
        : fail("not_found");
    } catch {
      return fail("invalid_state");
    }
  }

  listAgents(
    authorityInput: AuthorityContext,
  ): Result<QueryEnvelope<readonly AgentSummary[]>> {
    const authority = this.#queryAuthority(authorityInput, "agent", null);
    if (!authority.ok) return authority;
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const state = reduceFacts(snapshot.value.facts);
      const counts = new Map<string, number>();
      for (const release of state.releases.values())
        if (
          this.#options.authorizeQuery?.(
            authority.value,
            "agent",
            release.spec.agentId,
          ) !== false
        )
          counts.set(
            release.spec.agentId,
            (counts.get(release.spec.agentId) ?? 0) + 1,
          );
      const agents = [...counts]
        .map(([agentId, releaseCount]) => ({ agentId, releaseCount }))
        .sort((left, right) => left.agentId.localeCompare(right.agentId));
      return ok({
        policyVersion: authority.value.issuerVersion,
        value: agents,
      });
    } catch {
      return fail("invalid_state");
    }
  }

  listReleases(
    authorityInput: AuthorityContext,
    agentId: string,
  ): Result<QueryEnvelope<readonly ReleaseSummary[]>> {
    const authority = this.#queryAuthority(authorityInput, "release", agentId);
    if (!authority.ok) return authority;
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const releases = [...reduceFacts(snapshot.value.facts).releases.values()]
        .filter((release) => release.spec.agentId === agentId)
        .map((release) => ({
          agentId,
          releaseId: release.releaseId,
          schemaVersion: release.schemaVersion,
          intentDescriptors: release.spec.intentDescriptors,
          etag: `"${release.releaseId}"`,
        }))
        .sort((left, right) => left.releaseId.localeCompare(right.releaseId));
      return releases.length === 0
        ? fail("not_found")
        : ok({ policyVersion: authority.value.issuerVersion, value: releases });
    } catch {
      return fail("invalid_state");
    }
  }

  readRun(
    authorityInput: AuthorityContext,
    runId: string,
  ): Result<
    QueryEnvelope<{
      readonly run: SanitizedRunSummary;
      readonly pendingApprovals: readonly PendingApprovalSummary[];
    }>
  > {
    const runAuthority = this.#queryAuthority(authorityInput, "run", runId);
    if (!runAuthority.ok) return runAuthority;
    const approvalAuthority = this.#queryAuthority(
      authorityInput,
      "approval",
      runId,
    );
    if (!approvalAuthority.ok) return approvalAuthority;
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const internal = reduceFacts(snapshot.value.facts).runs.get(runId);
      if (!internal) return fail("not_found");
      const currentAttempt = internal.currentAttempt;
      const run: SanitizedRunSummary = {
        runId: internal.runId,
        agentId: internal.agentId,
        releaseId: internal.releaseId,
        activationEpoch: internal.activationEpoch,
        state: internal.state,
        currentAttempt,
        attemptState: internal.attempts.get(currentAttempt) ?? "running",
        ...(internal.executionMode
          ? { executionMode: internal.executionMode }
          : {}),
        ...(internal.checkpoints.get(currentAttempt)
          ? {
              checkpointId:
                internal.checkpoints.get(currentAttempt)!.checkpointId,
            }
          : {}),
        ...(internal.acceptedOutcomes.get(currentAttempt)
          ? {
              outcomeArtifactDigest:
                internal.acceptedOutcomes.get(currentAttempt),
            }
          : {}),
      };
      const pendingApprovals = [...internal.effects]
        .filter(
          ([, effect]) =>
            effect.state === "pending" && effect.approvalDecision === undefined,
        )
        .map(([approvalId, effect]) => ({
          approvalId,
          runId,
          state: "pending" as const,
          operation: effect.operation,
          ...(effect.approvalExpiresAtUnixMs
            ? { expiresAtUnixMs: effect.approvalExpiresAtUnixMs }
            : {}),
        }))
        .sort((left, right) => left.approvalId.localeCompare(right.approvalId));
      return ok({
        policyVersion: runAuthority.value.issuerVersion,
        value: { run, pendingApprovals },
      });
    } catch {
      return fail("invalid_state");
    }
  }

  readHealth(
    authorityInput: AuthorityContext,
  ): Result<QueryEnvelope<HealthSummary>> {
    const authority = this.#queryAuthority(authorityInput, "health", null);
    if (!authority.ok) return authority;
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    return ok({
      policyVersion: authority.value.issuerVersion,
      value: { status: "healthy", headSeq: snapshot.value.headSeq },
    });
  }

  readRunEvents(
    authorityInput: AuthorityContext,
    runId: string,
    cursor: string | null = null,
  ): Result<QueryEnvelope<RunEventPage>> {
    const authority = this.#queryAuthority(authorityInput, "event", runId);
    if (!authority.ok)
      return cursor === null || authority.error !== "not_found"
        ? authority
        : fail("cursor_unavailable");
    let cursorSeq = 0;
    if (cursor !== null) {
      if (!/^[1-9][0-9]{0,15}$/.test(cursor)) return fail("invalid_input");
      cursorSeq = Number(cursor);
      if (
        !Number.isSafeInteger(cursorSeq) ||
        cursorSeq > Number.MAX_SAFE_INTEGER
      )
        return fail("invalid_input");
    }
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const state = reduceFacts(snapshot.value.facts);
      if (!state.runs.has(runId))
        return cursor === null ? fail("not_found") : fail("cursor_unavailable");
      if (cursor !== null) {
        const anchor = snapshot.value.facts.find(
          ({ factSeq }) => factSeq === cursorSeq,
        );
        if (!anchor || anchor.aggregateId !== runId)
          return fail("cursor_unavailable");
      }
      const events = snapshot.value.facts
        .filter(
          ({ aggregateId, factSeq }) =>
            aggregateId === runId && factSeq > cursorSeq,
        )
        .slice(0, 128)
        .map(({ factSeq, factKind }) => ({
          id: String(factSeq),
          runId,
          eventKind: factKind,
        }));
      return ok({
        policyVersion: authority.value.issuerVersion,
        value: {
          events,
          nextCursor: events.at(-1)?.id ?? cursor,
          durableHead: String(snapshot.value.headSeq),
        },
      });
    } catch {
      return fail("invalid_state");
    }
  }

  openRunEventCursor(
    authority: AuthorityContext,
    runId: string,
    cursor: string | null = null,
    options: EventCursorOptions = {},
  ): Result<ControlEventCursor> {
    const port = new ControlEventCursor(
      this,
      (listener: () => void) => this.#store.subscribeCommits(listener),
      authority,
      runId,
      cursor,
      options,
    );
    const initialized = port.initialize();
    if (!initialized.ok) {
      port.close();
      return initialized;
    }
    return ok(port);
  }

  release(releaseId: string): Result<AgentRelease> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const release = reduceFacts(snapshot.value.facts).releases.get(releaseId);
      return release && verifyRelease(release)
        ? ok(release)
        : fail("not_found");
    } catch {
      return fail("invalid_state");
    }
  }

  snapshot(runId: string): Result<RunView> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const run = reduceFacts(snapshot.value.facts).runs.get(runId);
      if (!run) return fail("not_found");
      const row = snapshot.value.projections.find(
        ({ family, entityId }) => family === "run" && entityId === runId,
      );
      if (!row) return fail("not_found");
      const authoritative = view(run);
      return row.sourceFactSeq === snapshot.value.headSeq &&
        digestJson(row.payload) === digestJson(authoritative)
        ? ok(authoritative)
        : fail("invalid_state");
    } catch {
      return fail("invalid_state");
    }
  }

  sourceFacts(): Result<readonly SourceFact[]> {
    const snapshot = this.#store.readSnapshot();
    return snapshot.ok ? ok(snapshot.value.facts) : snapshot;
  }

  ensureProjections(): Result<null> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const expected = project(
        reduceFacts(snapshot.value.facts),
        snapshot.value.headSeq,
      );
      return digestJson(snapshot.value.projections) === digestJson(expected)
        ? ok(null)
        : this.#store.replaceProjections(snapshot.value.headSeq, expected);
    } catch {
      return fail("invalid_state");
    }
  }

  rebuildProjections(): Result<null> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      return this.#store.replaceProjections(
        snapshot.value.headSeq,
        project(reduceFacts(snapshot.value.facts), snapshot.value.headSeq),
      );
    } catch {
      return fail("invalid_state");
    }
  }

  requestControlCommandDelivery(
    meta: CommandMeta,
    input: ControlCommandDeliveryInput,
  ): Result<ControlCommandDeliveryResult> {
    const raw = exactRecord(input, [
      "connectorInstanceId",
      "serviceAuthorityId",
      "updateId",
      "updateOccurrenceKey",
      "claimsDigest",
      "rawUpdateDigest",
      "controlInteractionIdentity",
      "deliveryKey",
      "deliveryGeneration",
      "mappingVersion",
      "target",
      "deliveryOperation",
      "responseKind",
      "payloadBytes",
      "payloadDigest",
    ]);
    const stringFields = [
      "connectorInstanceId",
      "serviceAuthorityId",
      "updateId",
      "updateOccurrenceKey",
      "claimsDigest",
      "rawUpdateDigest",
      "controlInteractionIdentity",
      "deliveryKey",
      "target",
      "deliveryOperation",
      "responseKind",
      "payloadDigest",
    ] as const;
    if (
      !raw ||
      stringFields.some(
        (field) => typeof raw[field] !== "string" || raw[field].length === 0,
      ) ||
      !(raw.payloadBytes instanceof Uint8Array) ||
      raw.payloadBytes.byteLength > 16_384 ||
      !Number.isSafeInteger(raw.deliveryGeneration) ||
      (raw.deliveryGeneration as number) < 0 ||
      !Number.isSafeInteger(raw.mappingVersion) ||
      (raw.mappingVersion as number) < 0
    )
      return fail("invalid_input");
    const decoded = input;
    if (
      ![
        decoded.updateOccurrenceKey,
        decoded.claimsDigest,
        decoded.rawUpdateDigest,
        decoded.controlInteractionIdentity,
        decoded.deliveryKey,
        decoded.payloadDigest,
      ].every((value) => HEX_64.test(value)) ||
      decoded.updateOccurrenceKey !==
        controlDeliveryOccurrenceKey(
          decoded.connectorInstanceId,
          decoded.serviceAuthorityId,
          decoded.updateId,
        )
    )
      return fail("invalid_input");
    let normalized: Readonly<Record<string, JsonValue>>;
    try {
      normalized = normalizeControlDeliveryInput(decoded);
    } catch {
      return fail("invalid_input");
    }
    const decodedMeta = matchingCommandMeta(
      meta,
      "request-control-delivery",
      decoded.controlInteractionIdentity,
      normalized,
    );
    if (
      !decodedMeta ||
      decodedMeta.idempotencyKey !==
        controlDeliveryIdempotencyKey(decoded.updateOccurrenceKey)
    )
      return fail("invalid_input");
    return this.#transact<ControlCommandDeliveryResult>(
      decodedMeta,
      normalized,
      (snapshot) => {
        const state = reduceFacts(snapshot.facts);
        const occurrence = state.telegramOccurrences.get(
          decoded.updateOccurrenceKey,
        );
        if (
          occurrence &&
          (occurrence.claimsDigest !== decoded.claimsDigest ||
            occurrence.rawUpdateDigest !== decoded.rawUpdateDigest)
        ) {
          const facts = occurrence.quarantined
            ? []
            : [
                {
                  aggregateId: decoded.updateOccurrenceKey,
                  factKind: "telegram-occurrence-quarantined",
                  payload: asPayload({
                    updateOccurrenceKey: decoded.updateOccurrenceKey,
                    observedClaimsDigest: decoded.claimsDigest,
                    observedRawUpdateDigest: decoded.rawUpdateDigest,
                  }),
                },
              ];
          return plan(snapshot, facts, {
            status: "denied" as const,
            error: "channel_evidence_conflict" as const,
          });
        }
        if (
          this.#options.controlCommandPolicy?.(decoded) !== "allow" ||
          this.#options.controlDeliveryFenceValid?.({
            connectorInstanceId: decoded.connectorInstanceId,
            serviceAuthorityId: decoded.serviceAuthorityId,
            deliveryGeneration: decoded.deliveryGeneration,
            mappingVersion: decoded.mappingVersion,
          }) === false
        )
          return plan(snapshot, [], {
            status: "denied" as const,
            error: "forbidden" as const,
          });
        const effectId = digestJson([
          "control-command-effect-v1",
          decoded.controlInteractionIdentity,
          decoded.deliveryKey,
          decoded.deliveryGeneration,
        ]);
        const existing = state.controlEffects.get(effectId);
        if (existing)
          return plan(snapshot, [], {
            status: "effect" as const,
            effectId,
            state: existing.state,
            outcome: existing.outcome ?? null,
          });
        const facts: FactDraft[] = [];
        if (!occurrence)
          facts.push({
            aggregateId: decoded.updateOccurrenceKey,
            factKind: "telegram-occurrence-bound",
            payload: asPayload({
              updateOccurrenceKey: decoded.updateOccurrenceKey,
              claimsDigest: decoded.claimsDigest,
              rawUpdateDigest: decoded.rawUpdateDigest,
            }),
          });
        const payloadBase64url = Buffer.from(decoded.payloadBytes).toString(
          "base64url",
        );
        facts.push({
          aggregateId: effectId,
          factKind: "control-command-effect-created",
          payload: asPayload({
            effectId,
            state: "approved",
            connectorInstanceId: decoded.connectorInstanceId,
            serviceAuthorityId: decoded.serviceAuthorityId,
            updateOccurrenceKey: decoded.updateOccurrenceKey,
            controlInteractionIdentity: decoded.controlInteractionIdentity,
            deliveryKey: decoded.deliveryKey,
            deliveryGeneration: decoded.deliveryGeneration,
            mappingVersion: decoded.mappingVersion,
            target: decoded.target,
            payloadBase64url,
            payloadDigest: decoded.payloadDigest,
            deliveryOperation: decoded.deliveryOperation,
            responseKind: decoded.responseKind,
            claimsDigest: decoded.claimsDigest,
            rawUpdateDigest: decoded.rawUpdateDigest,
          }),
        });
        return plan(snapshot, facts, {
          status: "effect" as const,
          effectId,
          state: "approved" as const,
          outcome: null,
        });
      },
    );
  }

  controlCommandDispatchInput(
    authority: symbol,
    effectId: string,
  ): Result<{
    target: string;
    payloadBytes: Uint8Array;
    payloadDigest: string;
    deliveryOperation: string;
    responseKind: string;
  }> {
    if (authority !== GATEWAY) return fail("forbidden");
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const effect = reduceFacts(snapshot.value.facts).controlEffects.get(
        effectId,
      );
      return effect
        ? ok({
            target: effect.target,
            payloadBytes: Buffer.from(effect.payloadBase64url, "base64url"),
            payloadDigest: effect.payloadDigest,
            deliveryOperation: effect.deliveryOperation,
            responseKind: effect.responseKind,
          })
        : fail("not_found");
    } catch {
      return fail("invalid_state");
    }
  }

  readControlCommandDelivery(
    effectId: string,
  ): Result<ControlCommandDeliveryResult> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const effect = reduceFacts(snapshot.value.facts).controlEffects.get(
        effectId,
      );
      return effect
        ? ok({
            status: "effect",
            effectId,
            state: effect.state,
            outcome: effect.outcome ?? null,
          })
        : fail("not_found");
    } catch {
      return fail("invalid_state");
    }
  }

  pendingControlCommandDeliveries(
    authority: symbol,
  ): Result<readonly ControlCommandDeliveryResult[]> {
    if (authority !== GATEWAY) return fail("forbidden");
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      return ok(
        [...reduceFacts(snapshot.value.facts).controlEffects.values()]
          .filter((effect) =>
            ["approved", "claimed", "dispatch-started", "unknown"].includes(
              effect.state,
            ),
          )
          .map((effect) => ({
            status: "effect" as const,
            effectId: effect.effectId,
            state: effect.state,
            outcome: effect.outcome ?? null,
          })),
      );
    } catch {
      return fail("invalid_state");
    }
  }

  beginControlCommandDispatch(
    authority: symbol,
    meta: CommandMeta,
    effectId: string,
  ): Result<"dispatch-started" | "fence-revoked"> {
    if (authority !== GATEWAY) return fail("forbidden");
    const input = { effectId };
    const decodedMeta = matchingCommandMeta(
      meta,
      "dispatch-control-effect",
      effectId,
      input,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, input, (snapshot) => {
      const effect = reduceFacts(snapshot.facts).controlEffects.get(effectId);
      if (!effect) return fail("not_found");
      if (effect.state !== "approved") return fail("invalid_state");
      if (
        this.#options.controlDeliveryFenceValid?.({
          connectorInstanceId: effect.connectorInstanceId,
          serviceAuthorityId: effect.serviceAuthorityId,
          deliveryGeneration: effect.deliveryGeneration,
          mappingVersion: effect.mappingVersion,
        }) === false
      )
        return plan(
          snapshot,
          [
            {
              aggregateId: effectId,
              factKind: "control-effect-outcome",
              payload: asPayload({ effectId, outcome: "not-committed" }),
            },
          ],
          "fence-revoked" as const,
        );
      return plan(
        snapshot,
        [
          {
            aggregateId: effectId,
            factKind: "control-effect-claimed",
            payload: asPayload({ effectId }),
          },
          {
            aggregateId: effectId,
            factKind: "control-effect-dispatch-started",
            payload: asPayload({ effectId }),
          },
        ],
        "dispatch-started" as const,
      );
    });
  }

  markControlCommandUnknown(
    authority: symbol,
    meta: CommandMeta,
    effectId: string,
  ): Result<null> {
    if (authority !== GATEWAY) return fail("forbidden");
    const input = { effectId };
    const decodedMeta = matchingCommandMeta(
      meta,
      "mark-control-effect-unknown",
      effectId,
      input,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, input, (snapshot) => {
      const effect = reduceFacts(snapshot.facts).controlEffects.get(effectId);
      if (!effect || effect.state !== "dispatch-started")
        return fail("invalid_state");
      return plan(
        snapshot,
        [
          {
            aggregateId: effectId,
            factKind: "control-effect-unknown",
            payload: asPayload({ effectId }),
          },
        ],
        null,
      );
    });
  }

  recordControlCommandOutcome(
    authority: symbol,
    meta: CommandMeta,
    effectId: string,
    outcome: "committed" | "not-committed",
  ): Result<null> {
    if (authority !== GATEWAY) return fail("forbidden");
    const input = { effectId, outcome };
    const decodedMeta = matchingCommandMeta(
      meta,
      "record-control-effect-outcome",
      effectId,
      input,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, input, (snapshot) => {
      const effect = reduceFacts(snapshot.facts).controlEffects.get(effectId);
      if (!effect || !["dispatch-started", "unknown"].includes(effect.state))
        return fail("invalid_state");
      return plan(
        snapshot,
        [
          {
            aggregateId: effectId,
            factKind: "control-effect-outcome",
            payload: asPayload({ effectId, outcome }),
          },
        ],
        null,
      );
    });
  }

  decideApprovalByIdFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: { approvalId: string; decision: "approved" | "denied" },
  ) {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const run = [...reduceFacts(snapshot.value.facts).runs.values()].find(
        (candidate) => candidate.effects.has(input.approvalId),
      );
      if (!run) return fail("not_found");
      return this.decideApprovalFromWire(authority, idempotencyKey, ifMatch, {
        runId: run.runId,
        ...input,
      });
    } catch {
      return fail("invalid_state");
    }
  }

  decideApprovalFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: {
      runId: string;
      approvalId: string;
      decision: "approved" | "denied";
    },
  ) {
    const current = this.readRun(authority, input.runId);
    if (!current.ok) return current;
    const approval = current.value.value.pendingApprovals.find(
      ({ approvalId }) => approvalId === input.approvalId,
    );
    if (approval && digestJson(current.value.value) !== ifMatch)
      return fail("stale_epoch");
    const actor = actorSubjectId(authority);
    return this.decideApproval(
      commandMeta(
        actor,
        "decide-approval",
        input.approvalId,
        idempotencyKey,
        input,
        { expectedApprovalDigest: ifMatch },
        digestJson(authority),
      ),
      input,
    );
  }

  decideApproval(
    meta: CommandMeta,
    input: {
      runId: string;
      approvalId: string;
      decision: "approved" | "denied";
    },
  ): Result<{
    approvalId: string;
    state: "approved" | "denied" | "expired";
    result: "accepted" | "stored";
  }> {
    const value = exactRecord(input, ["runId", "approvalId", "decision"]);
    if (
      !value ||
      typeof value.runId !== "string" ||
      typeof value.approvalId !== "string" ||
      !["approved", "denied"].includes(String(value.decision))
    )
      return fail("invalid_input");
    const decoded = {
      runId: value.runId,
      approvalId: value.approvalId,
      decision: value.decision as "approved" | "denied",
    };
    const decodedMeta = matchingCommandMeta(
      meta,
      "decide-approval",
      decoded.approvalId,
      decoded,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, decoded, (snapshot) => {
      const state = reduceFacts(snapshot.facts);
      const run = state.runs.get(decoded.runId);
      const effect = run?.effects.get(decoded.approvalId);
      if (!run || !effect) return fail("not_found");
      if (run.cancelRequested) return fail("terminal_conflict");
      if (effect.approvalDecision)
        return plan(snapshot, [], {
          approvalId: decoded.approvalId,
          state: effect.approvalDisposition ?? effect.approvalDecision,
          result: "stored" as const,
        });
      const expiresAtUnixMs = effect.approvalExpiresAtUnixMs;
      if (!expiresAtUnixMs) return fail("invalid_state");
      if (this.#now() >= expiresAtUnixMs) {
        return plan(
          snapshot,
          [
            {
              aggregateId: decoded.runId,
              factKind: "approval-decided",
              payload: asPayload({
                runId: decoded.runId,
                effectId: decoded.approvalId,
                decision: "denied",
                disposition: "expired",
              }),
            },
            {
              aggregateId: decoded.runId,
              factKind: "local-dispatch-result",
              payload: asPayload({
                runId: decoded.runId,
                effectId: decoded.approvalId,
                status: "claim-expired",
              }),
            },
          ],
          {
            approvalId: decoded.approvalId,
            state: "expired" as const,
            result: "accepted" as const,
          },
        );
      }
      if (decoded.decision === "denied")
        return plan(
          snapshot,
          [
            {
              aggregateId: decoded.runId,
              factKind: "approval-decided",
              payload: asPayload({
                runId: decoded.runId,
                effectId: decoded.approvalId,
                decision: "denied",
              }),
            },
            {
              aggregateId: decoded.runId,
              factKind: "local-dispatch-result",
              payload: asPayload({
                runId: decoded.runId,
                effectId: decoded.approvalId,
                status: "denied",
              }),
            },
          ],
          {
            approvalId: decoded.approvalId,
            state: "denied" as const,
            result: "accepted" as const,
          },
        );
      const approval: InternalApproval = {
        decision: "approved",
        releaseId: run.releaseId,
        activationEpoch: run.activationEpoch,
        expiresAtUnixMs,
        actorSubjectId: decodedMeta.actorSubjectId,
      };
      return plan(
        snapshot,
        [
          {
            aggregateId: decoded.runId,
            factKind: "approval-decided",
            payload: asPayload({
              runId: decoded.runId,
              effectId: decoded.approvalId,
              decision: "approved",
              approval,
            }),
          },
          {
            aggregateId: decoded.runId,
            factKind: "gateway-wake",
            payload: asPayload({
              runId: decoded.runId,
              effectId: decoded.approvalId,
            }),
          },
        ],
        {
          approvalId: decoded.approvalId,
          state: "approved" as const,
          result: "accepted" as const,
        },
      );
    });
  }

  gatewayWakes(
    authority: symbol,
  ): Result<readonly { runId: string; effectId: string }[]> {
    if (authority !== GATEWAY) return fail("forbidden");
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const wakes: { runId: string; effectId: string }[] = [];
      for (const run of reduceFacts(snapshot.value.facts).runs.values())
        for (const [effectId, effect] of run.effects)
          if (effect.gatewayWake && effect.state === "approved")
            wakes.push({ runId: run.runId, effectId });
      return ok(
        wakes.sort((left, right) =>
          `${left.runId}\0${left.effectId}`.localeCompare(
            `${right.runId}\0${right.effectId}`,
          ),
        ),
      );
    } catch {
      return fail("invalid_state");
    }
  }

  approveEffect(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
    effectId: string,
    approval: EffectApprovalInput,
  ): Result<null> {
    const value = exactRecord(approval, [
      "decision",
      "releaseId",
      "activationEpoch",
      "expiresAtUnixMs",
    ]);
    if (
      authority !== GATEWAY ||
      !value ||
      value.decision !== "approved" ||
      typeof value.releaseId !== "string" ||
      !Number.isSafeInteger(value.activationEpoch) ||
      !Number.isSafeInteger(value.expiresAtUnixMs)
    )
      return fail("invalid_input");
    const decoded: EffectApprovalInput = {
      decision: "approved",
      releaseId: value.releaseId,
      activationEpoch: value.activationEpoch as number,
      expiresAtUnixMs: value.expiresAtUnixMs as number,
    };
    const decodedMeta = matchingCommandMeta(meta, "approve-effect", runId, {
      runId,
      effectId,
      approval: decoded,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(
      decodedMeta,
      { runId, effectId, approval: decoded },
      (snapshot) => {
        const state = reduceFacts(snapshot.facts);
        const run = state.runs.get(runId);
        const effect = run?.effects.get(effectId);
        if (!run || !effect) return fail("not_found");
        if (run.cancelRequested) return fail("terminal_conflict");
        if (!currentActivation(state, run)) return fail("stale_epoch");
        if (
          decoded.decision !== "approved" ||
          effect.state !== "pending" ||
          decoded.releaseId !== run.releaseId ||
          decoded.activationEpoch !== run.activationEpoch ||
          decoded.expiresAtUnixMs <= this.#now()
        )
          return fail("invalid_state");
        const binding: InternalApproval = {
          ...decoded,
          actorSubjectId: decodedMeta.actorSubjectId,
        };
        return plan(
          snapshot,
          [
            {
              aggregateId: runId,
              factKind: "effect-approved",
              payload: asPayload({ runId, effectId, approval: binding }),
            },
          ],
          null,
        );
      },
    );
  }

  beginEffectDispatch(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
    effectId: string,
  ): Result<"dispatch-started" | "claim-revoked" | "claim-expired"> {
    if (authority !== GATEWAY) return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(meta, "dispatch-effect", runId, {
      runId,
      effectId,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(
      decodedMeta,
      { runId, effectId },
      (snapshot) => {
        const state = reduceFacts(snapshot.facts);
        const run = state.runs.get(runId);
        const effect = run?.effects.get(effectId);
        if (!run || !effect) return fail("not_found");
        if (run.cancelRequested) return fail("terminal_conflict");
        if (effect.state !== "approved" || !effect.approval)
          return currentActivation(state, run)
            ? fail("invalid_state")
            : fail("stale_epoch");
        const expired = effect.approval.expiresAtUnixMs <= this.#now();
        const authorityValid =
          currentActivation(state, run) &&
          effect.approval.releaseId === run.releaseId &&
          effect.approval.activationEpoch === run.activationEpoch &&
          this.#options.effectAuthorityValid?.(runId, effectId) !== false;
        if (expired || !authorityValid) {
          const status = expired ? "claim-expired" : "claim-revoked";
          return plan(
            snapshot,
            [
              {
                aggregateId: runId,
                factKind: "local-dispatch-result",
                payload: asPayload({ runId, effectId, status }),
              },
              {
                aggregateId: runId,
                factKind: "gateway-wake-consumed",
                payload: asPayload({ runId, effectId }),
              },
            ],
            status,
          );
        }
        return plan(
          snapshot,
          [
            {
              aggregateId: runId,
              factKind: "gateway-wake-consumed",
              payload: asPayload({ runId, effectId }),
            },
            {
              aggregateId: runId,
              factKind: "effect-claimed",
              payload: asPayload({ runId, effectId }),
            },
            {
              aggregateId: runId,
              factKind: "effect-dispatch-started",
              payload: asPayload({ runId, effectId }),
            },
          ],
          "dispatch-started" as const,
        );
      },
      { rejectReplay: true },
    );
  }

  markEffectUnknown(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
    effectId: string,
  ): Result<null> {
    return this.#effectFact(
      authority,
      meta,
      runId,
      effectId,
      "mark-effect-unknown",
      "dispatch-started",
      "effect-unknown",
    );
  }

  recordEffectOutcome(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
    effectId: string,
    outcome: "committed" | "not-committed",
  ): Result<null> {
    if (
      authority !== GATEWAY ||
      !["committed", "not-committed"].includes(outcome)
    )
      return fail("invalid_input");
    const decoded = decodeCommandMeta(meta);
    if (
      !decoded ||
      !["record-effect-outcome", "reconcile-effect"].includes(
        decoded.commandKind,
      )
    )
      return fail("invalid_input");
    const commandInput =
      decoded.commandKind === "record-effect-outcome"
        ? { runId, effectId }
        : { runId, effectId, outcome };
    const decodedMeta = matchingCommandMeta(
      decoded,
      decoded.commandKind,
      runId,
      commandInput,
    );
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(decodedMeta, commandInput, (snapshot) => {
      const run = reduceFacts(snapshot.facts).runs.get(runId);
      const effect = run?.effects.get(effectId);
      const allowed =
        decodedMeta.commandKind === "record-effect-outcome"
          ? effect?.state === "dispatch-started"
          : effect?.state === "unknown";
      if (!allowed) return fail("invalid_state");
      return plan(
        snapshot,
        [
          {
            aggregateId: runId,
            factKind: "effect-outcome",
            payload: asPayload({ runId, effectId, outcome }),
          },
        ],
        null,
      );
    });
  }

  #effectFact(
    authority: symbol,
    meta: CommandMeta,
    runId: string,
    effectId: string,
    commandKind: string,
    expected: EffectState,
    factKind: string,
  ): Result<null> {
    if (authority !== GATEWAY) return fail("invalid_input");
    const decodedMeta = matchingCommandMeta(meta, commandKind, runId, {
      runId,
      effectId,
    });
    if (!decodedMeta) return fail("invalid_input");
    return this.#transact(
      decodedMeta,
      { runId, effectId },
      (snapshot) => {
        const state = reduceFacts(snapshot.facts);
        const run = state.runs.get(runId);
        const effect = run?.effects.get(effectId);
        if (!effect || !run) return fail("not_found");
        if (effect.state !== expected) return fail("invalid_state");
        if (
          factKind === "effect-dispatch-started" &&
          !currentActivation(state, run)
        )
          return fail("stale_epoch");
        return plan(
          snapshot,
          [
            {
              aggregateId: runId,
              factKind,
              payload: asPayload({ runId, effectId }),
            },
          ],
          null,
        );
      },
      factKind === "effect-dispatch-started"
        ? { rejectReplay: true }
        : undefined,
    );
  }
}

export interface EventCursorOptions {
  readonly heartbeatMs?: number;
  readonly maxPendingWakeups?: number;
  readonly maxBatchBytes?: number;
}

/**
 * Per-connection cursor: notifications only wake it; every batch rereads the
 * committed head through Control, reauthorizes, then advances its serialized
 * send cursor. No in-memory offset is authoritative.
 */
export class ControlEventCursor {
  readonly #control: Control;
  readonly #authority: AuthorityContext;
  readonly #runId: string;
  readonly #heartbeatMs: number;
  readonly #maxPendingWakeups: number;
  readonly #maxBatchBytes: number;
  readonly #unsubscribe: () => void;
  #cursor: string | null;
  #ready?: QueryEnvelope<RunEventPage>;
  #pendingWakeups = 0;
  #waiter?: () => void;
  #closed = false;
  #overflow = false;
  #reading = false;

  constructor(
    control: Control,
    subscribe: (listener: () => void) => () => void,
    authority: AuthorityContext,
    runId: string,
    cursor: string | null,
    options: EventCursorOptions,
  ) {
    this.#control = control;
    this.#authority = authority;
    this.#runId = runId;
    this.#cursor = cursor;
    this.#heartbeatMs = options.heartbeatMs ?? 5_000;
    this.#maxPendingWakeups = options.maxPendingWakeups ?? 256;
    this.#maxBatchBytes = options.maxBatchBytes ?? 1024 * 1024;
    this.#unsubscribe = subscribe(() => {
      if (this.#closed) return;
      this.#pendingWakeups += 1;
      if (this.#pendingWakeups > this.#maxPendingWakeups) {
        this.#overflow = true;
        this.#closed = true;
        this.#unsubscribe();
      }
      this.#waiter?.();
    });
  }

  initialize(): Result<null> {
    if (
      !Number.isSafeInteger(this.#heartbeatMs) ||
      this.#heartbeatMs < 1 ||
      !Number.isSafeInteger(this.#maxPendingWakeups) ||
      this.#maxPendingWakeups < 1 ||
      !Number.isSafeInteger(this.#maxBatchBytes) ||
      this.#maxBatchBytes < 1
    )
      return fail("invalid_input");
    const initial = this.#control.readRunEvents(
      this.#authority,
      this.#runId,
      this.#cursor,
    );
    if (!initial.ok) return initial;
    this.#ready = initial.value;
    return ok(null);
  }

  async next(): Promise<Result<QueryEnvelope<RunEventPage>>> {
    if (this.#closed)
      return fail(this.#overflow ? "invalid_state" : "invalid_state");
    if (this.#reading) return fail("invalid_state");
    this.#reading = true;
    try {
      if (this.#ready) {
        const page = this.#ready;
        this.#ready = undefined;
        if (page.value.events.length > 0) return this.#deliver(page);
      }
      if (this.#pendingWakeups === 0) await this.#waitForWakeOrHeartbeat();
      if (this.#overflow || this.#closed) return fail("invalid_state");
      this.#pendingWakeups = 0;
      const page = this.#control.readRunEvents(
        this.#authority,
        this.#runId,
        this.#cursor,
      );
      if (!page.ok) {
        this.close();
        return page;
      }
      return this.#deliver(page.value);
    } finally {
      this.#reading = false;
    }
  }

  #deliver(
    page: QueryEnvelope<RunEventPage>,
  ): Result<QueryEnvelope<RunEventPage>> {
    if (JSON.stringify(page).length > this.#maxBatchBytes) {
      this.#overflow = true;
      this.close();
      return fail("invalid_state");
    }
    this.#cursor = page.value.nextCursor;
    return ok(page);
  }

  #waitForWakeOrHeartbeat(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        resolve();
      }, this.#heartbeatMs);
      this.#waiter = () => {
        clearTimeout(timer);
        this.#waiter = undefined;
        resolve();
      };
      // Closes the check→wait race: a notification may have arrived after the
      // caller checked pendingWakeups but before waiter assignment.
      if (this.#pendingWakeups > 0 || this.#closed) this.#waiter();
    });
  }

  close(): void {
    if (this.#closed && !this.#waiter) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#waiter?.();
  }
}

class TrustedOutcomeAcceptor implements OutcomeAcceptor {
  readonly #control: Control;

  constructor(control: Control) {
    this.#control = control;
  }

  accept(
    meta: CommandMeta,
    input: { runId: string; attempt: number; artifactDigest: string },
  ): Result<null> {
    const decoded = decodeCommandMeta(meta);
    const matched = decoded
      ? matchingCommandMeta(decoded, "accept-outcome", input?.runId, input)
      : undefined;
    return matched
      ? this.#control.recordOutcomeAcceptance(OUTCOME_OWNER, matched, input)
      : fail("invalid_input");
  }
}

export function createControl(
  store: ControlStore,
  options: ControlOptions = {},
): { control: Control; outcomes: OutcomeAcceptor } {
  const control = new Control(store, options);
  return { control, outcomes: new TrustedOutcomeAcceptor(control) };
}

export class TrustedProcessController {
  readonly #control: Control;

  constructor(control: Control) {
    this.#control = control;
  }

  register(
    meta: CommandMeta,
    token: AttemptToken,
    process: ProcessIdentity,
  ): Result<null> {
    const bound = bindCommandMeta(meta, process, token);
    return bound.ok
      ? this.#control.registerProcess(
          PROCESS_OWNER,
          bound.value,
          token,
          process,
        )
      : bound;
  }

  technicalExit(
    meta: CommandMeta,
    token: AttemptToken,
    exitCode: number,
  ): Result<null> {
    const bound = bindCommandMeta(meta, { exitCode }, token);
    return bound.ok
      ? this.#control.recordTechnicalExit(
          PROCESS_OWNER,
          bound.value,
          token,
          exitCode,
        )
      : bound;
  }

  reaped(meta: CommandMeta, token: AttemptToken): Result<null> {
    const bound = bindCommandMeta(
      meta,
      { factKind: "containment-reaped" },
      token,
    );
    return bound.ok
      ? this.#control.markContainmentReaped(PROCESS_OWNER, bound.value, token)
      : bound;
  }

  revoke(meta: CommandMeta, token: AttemptToken): Result<null> {
    const bound = bindCommandMeta(meta, { factKind: "grant-revoked" }, token);
    return bound.ok
      ? this.#control.revokeGrant(PROCESS_OWNER, bound.value, token)
      : bound;
  }
}

export const createTrustedProcessController = (
  control: Control,
): TrustedProcessController => new TrustedProcessController(control);

export class TrustedPiCleanupController {
  readonly #control: Control;

  constructor(control: Control) {
    this.#control = control;
  }

  commit(
    meta: CommandMeta,
    token: AttemptToken,
    evidence: HarnessCleanupEvidence,
  ) {
    return this.#control.recordPiCleanup(PI_CHILD_OWNER, meta, token, evidence);
  }

  terminalize(meta: CommandMeta, runId: string, cause: "succeeded" | "failed") {
    return this.#control.terminalize(meta, {
      runId,
      state: cause === "succeeded" ? "completed" : "failed",
    });
  }
}

export const createTrustedPiCleanupController = (
  control: Control,
): TrustedPiCleanupController => new TrustedPiCleanupController(control);

export class TrustedCancelController {
  readonly #control: Control;

  constructor(control: Control) {
    this.#control = control;
  }

  settle(
    meta: CommandMeta,
    runId: string,
  ): Result<{ runId: string; state: "cancelled" }> {
    return this.#control.recordCancelCleanup(CANCEL_OWNER, meta, runId);
  }
}

export const createTrustedCancelController = (
  control: Control,
): TrustedCancelController => new TrustedCancelController(control);

export type Connector = () => Promise<"committed" | "not-committed">;
export type ControlCommandConnector = (input: {
  readonly target: string;
  readonly payloadBytes: Uint8Array;
  readonly payloadDigest: string;
  readonly deliveryOperation: string;
  readonly responseKind: string;
}) => Promise<"committed" | "not-committed">;

function gatewayMeta(
  meta: CommandMeta,
  commandKind: string,
  runId: string,
  input: unknown,
): Result<CommandMeta> {
  const matched = matchingCommandMeta(meta, commandKind, runId, input);
  return matched ? ok(matched) : fail("invalid_input");
}

export class EffectGateway {
  readonly #control: Control;

  constructor(control: Control) {
    this.#control = control;
  }

  requestControlDelivery(
    meta: CommandMeta,
    input: ControlCommandDeliveryInput,
  ): Result<ControlCommandDeliveryResult> {
    return this.#control.requestControlCommandDelivery(meta, input);
  }

  readControlDelivery(effectId: string): Result<ControlCommandDeliveryResult> {
    return this.#control.readControlCommandDelivery(effectId);
  }

  pendingControlDeliveries(): Result<readonly ControlCommandDeliveryResult[]> {
    return this.#control.pendingControlCommandDeliveries(GATEWAY);
  }

  async dispatchControl(
    meta: { start: CommandMeta; outcome: CommandMeta; unknown: CommandMeta },
    effectId: string,
    connector: ControlCommandConnector,
  ): Promise<Result<null>> {
    const payload = this.#control.controlCommandDispatchInput(
      GATEWAY,
      effectId,
    );
    if (!payload.ok) return payload;
    const started = this.#control.beginControlCommandDispatch(
      GATEWAY,
      meta.start,
      effectId,
    );
    if (!started.ok) return started;
    if (started.value !== "dispatch-started") return fail("forbidden");
    try {
      const outcome = await connector(payload.value);
      return this.#control.recordControlCommandOutcome(
        GATEWAY,
        meta.outcome,
        effectId,
        outcome,
      );
    } catch {
      const marked = this.#control.markControlCommandUnknown(
        GATEWAY,
        meta.unknown,
        effectId,
      );
      return marked.ok ? fail("unknown_effect") : marked;
    }
  }

  reconcileControl(
    meta: CommandMeta,
    effectId: string,
    outcome: "committed" | "not-committed",
  ): Result<null> {
    return this.#control.recordControlCommandOutcome(
      GATEWAY,
      meta,
      effectId,
      outcome,
    );
  }

  pendingWakes(): Result<readonly { runId: string; effectId: string }[]> {
    return this.#control.gatewayWakes(GATEWAY);
  }

  approve(
    meta: CommandMeta,
    runId: string,
    effectId: string,
    approval: EffectApprovalInput,
  ): Result<null> {
    const bound = gatewayMeta(meta, "approve-effect", runId, {
      runId,
      effectId,
      approval,
    });
    return bound.ok
      ? this.#control.approveEffect(
          GATEWAY,
          bound.value,
          runId,
          effectId,
          approval,
        )
      : bound;
  }

  async dispatch(
    meta: { start: CommandMeta; outcome: CommandMeta; unknown: CommandMeta },
    runId: string,
    effectId: string,
    connector: Connector,
  ): Promise<Result<null>> {
    const startMeta = gatewayMeta(meta?.start, "dispatch-effect", runId, {
      runId,
      effectId,
    });
    const unknownMeta = gatewayMeta(
      meta?.unknown,
      "mark-effect-unknown",
      runId,
      { runId, effectId },
    );
    const outcomeProbe = gatewayMeta(
      meta?.outcome,
      "record-effect-outcome",
      runId,
      { runId, effectId },
    );
    if (!startMeta.ok) return startMeta;
    if (!unknownMeta.ok) return unknownMeta;
    if (!outcomeProbe.ok) return outcomeProbe;
    const started = this.#control.beginEffectDispatch(
      GATEWAY,
      startMeta.value,
      runId,
      effectId,
    );
    if (!started.ok) return started;
    if (started.value !== "dispatch-started")
      return fail(started.value === "claim-expired" ? "expired" : "forbidden");
    try {
      const outcome = await connector();
      if (!["committed", "not-committed"].includes(outcome)) {
        const marked = this.#control.markEffectUnknown(
          GATEWAY,
          unknownMeta.value,
          runId,
          effectId,
        );
        return marked.ok ? fail("unknown_effect") : marked;
      }
      const recorded = this.#control.recordEffectOutcome(
        GATEWAY,
        outcomeProbe.value,
        runId,
        effectId,
        outcome,
      );
      if (recorded.ok) return recorded;
      const marked = this.#control.markEffectUnknown(
        GATEWAY,
        unknownMeta.value,
        runId,
        effectId,
      );
      return marked.ok ? fail("unknown_effect") : recorded;
    } catch {
      const marked = this.#control.markEffectUnknown(
        GATEWAY,
        unknownMeta.value,
        runId,
        effectId,
      );
      return marked.ok ? fail("unknown_effect") : marked;
    }
  }

  recoverUnknown(
    meta: CommandMeta,
    runId: string,
    effectId: string,
  ): Result<null> {
    const bound = gatewayMeta(meta, "mark-effect-unknown", runId, {
      runId,
      effectId,
    });
    return bound.ok
      ? this.#control.markEffectUnknown(GATEWAY, bound.value, runId, effectId)
      : bound;
  }

  reconcile(
    meta: CommandMeta,
    runId: string,
    effectId: string,
    outcome: "committed" | "not-committed",
  ): Result<null> {
    const bound = gatewayMeta(meta, "reconcile-effect", runId, {
      runId,
      effectId,
      outcome,
    });
    return bound.ok
      ? this.#control.recordEffectOutcome(
          GATEWAY,
          bound.value,
          runId,
          effectId,
          outcome,
        )
      : bound;
  }
}

export const createEffectGateway = (control: Control): EffectGateway =>
  new EffectGateway(control);

class ControlHarnessAdapter implements HarnessAdapterPort {
  readonly #control: Control;
  readonly #session: HarnessSession;
  readonly #gateway: EffectGateway;
  readonly #outcomes: OutcomeAcceptor;
  readonly #cleanup: TrustedPiCleanupController;
  readonly #token: AttemptToken;
  readonly #actorSubjectId: string;

  constructor(control: Control, token: AttemptToken, actorSubjectId: string) {
    this.#control = control;
    this.#token = token;
    this.#actorSubjectId = actorSubjectId;
    this.#session = control.harness(token);
    this.#gateway = new EffectGateway(control);
    this.#outcomes = new TrustedOutcomeAcceptor(control);
    this.#cleanup = new TrustedPiCleanupController(control);
  }

  submit(idempotencyKey: string, input: PassiveHarnessInput): Result<null>;
  submit(
    idempotencyKey: string,
    input: OutcomeHarnessInput,
  ): Result<{ readonly outcomeAccepted: true }>;
  submit(
    idempotencyKey: string,
    input: PassiveHarnessInput | OutcomeHarnessInput,
  ): Result<null | { readonly outcomeAccepted: true }> {
    const commandKind =
      input.type === "action"
        ? "register-action"
        : input.type === "tool-observation"
          ? "tool-observation"
          : input.type === "checkpoint"
            ? "checkpoint"
            : "outcome-proposal";
    const submitted = this.#session.submit(
      commandMeta(
        this.#actorSubjectId,
        commandKind,
        this.#token.runId,
        idempotencyKey,
        input,
        this.#token,
      ),
      input,
    );
    if (!submitted.ok || input.type !== "outcome-proposal") return submitted;
    const outcome = {
      runId: this.#token.runId,
      attempt: this.#token.attempt,
      artifactDigest: input.proposal.artifactDigest,
    };
    const accepted = this.#outcomes.accept(
      commandMeta(
        this.#actorSubjectId,
        "accept-outcome",
        this.#token.runId,
        `${idempotencyKey}-accept`,
        outcome,
      ),
      outcome,
    );
    return accepted.ok ? ok({ outcomeAccepted: true as const }) : accepted;
  }

  async submitEffect(
    idempotencyKey: string,
    input: EffectHarnessInput,
  ): Promise<Result<null>> {
    const submitted = this.#session.submit(
      commandMeta(
        this.#actorSubjectId,
        "effect-intent",
        this.#token.runId,
        idempotencyKey,
        input,
        this.#token,
      ),
      input,
    );
    if (!submitted.ok) return submitted;
    const run = this.#control.snapshot(this.#token.runId);
    if (!run.ok) return run;
    const effectId = submitted.value.effectId;
    const approval = {
      decision: "approved" as const,
      releaseId: run.value.releaseId,
      activationEpoch: run.value.activationEpoch,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
    };
    const approvalInput = { runId: this.#token.runId, effectId, approval };
    const approved = this.#gateway.approve(
      commandMeta(
        this.#actorSubjectId,
        "approve-effect",
        this.#token.runId,
        `${idempotencyKey}-approve`,
        approvalInput,
      ),
      this.#token.runId,
      effectId,
      approval,
    );
    if (!approved.ok) return approved;
    const dispatchInput = { runId: this.#token.runId, effectId };
    const dispatched = await this.#gateway.dispatch(
      {
        start: commandMeta(
          this.#actorSubjectId,
          "dispatch-effect",
          this.#token.runId,
          `${idempotencyKey}-start`,
          dispatchInput,
        ),
        outcome: commandMeta(
          this.#actorSubjectId,
          "record-effect-outcome",
          this.#token.runId,
          `${idempotencyKey}-outcome`,
          dispatchInput,
        ),
        unknown: commandMeta(
          this.#actorSubjectId,
          "mark-effect-unknown",
          this.#token.runId,
          `${idempotencyKey}-unknown`,
          dispatchInput,
        ),
      },
      this.#token.runId,
      effectId,
      async () => {
        throw new Error("fixture response lost");
      },
    );
    return !dispatched.ok && dispatched.error === "unknown_effect"
      ? ok(null)
      : dispatched;
  }

  recordFault(idempotencyKey: string): Result<null> {
    const input = { reasonCode: "adapter-fault" as const };
    return this.#control.recordHarnessFault(
      PI_CHILD_OWNER,
      commandMeta(
        this.#actorSubjectId,
        "harness-fault",
        this.#token.runId,
        idempotencyKey,
        input,
        this.#token,
      ),
      this.#token,
    );
  }

  commitCleanup(
    idempotencyKey: string,
    evidence: HarnessCleanupEvidence,
  ): Result<{ readonly cause: "succeeded" | "failed" }> {
    const committed = this.#cleanup.commit(
      commandMeta(
        this.#actorSubjectId,
        "pi-cleanup",
        this.#token.runId,
        idempotencyKey,
        { evidence },
        this.#token,
      ),
      this.#token,
      evidence,
    );
    return committed.ok ? ok({ cause: committed.value.state }) : committed;
  }
}

export const createHarnessAdapterPort = (
  control: Control,
  token: AttemptToken,
  actorSubjectId: string,
): HarnessAdapterPort =>
  new ControlHarnessAdapter(control, token, actorSubjectId);

export const newSessionId = (): string => randomUUID();
