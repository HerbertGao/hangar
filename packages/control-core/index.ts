import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  digestJson,
  fail,
  ok,
  verifyRelease,
  type ActionInput,
  type AgentRelease,
  type AttemptState,
  type AttemptToken,
  type CheckpointInput,
  type CommandMeta,
  type EffectApprovalInput,
  type EffectIntentInput,
  type EffectState,
  type HarnessInput,
  type OutcomeProposalInput,
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
  readonly family: "release" | "activation" | "run";
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
  close(): void;
}

interface InternalApproval extends EffectApprovalInput {
  actorSubjectId: string;
}

interface InternalEffect {
  state: EffectState;
  approval?: InternalApproval;
  operation: string;
  actionId: string;
  originAttempt: number;
  intentKey: string;
  intentGeneration: number;
  payloadDigest: string;
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
  processes: Map<number, ProcessIdentity>;
  reaped: Set<number>;
  revoked: Set<number>;
  quiesced: Map<number, AttemptFence>;
}

interface ControlState {
  releases: Map<string, AgentRelease>;
  activations: Map<string, { releaseId: string; epoch: number }>;
  runs: Map<string, InternalRun>;
}

const GATEWAY = Symbol("effect-gateway");
const OUTCOME_OWNER = Symbol("domain-outcome-owner");
const PROCESS_OWNER = Symbol("trusted-process-owner");
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
        }>(fact);
        state.activations.set(value.agentId, {
          releaseId: value.releaseId,
          epoch: value.epoch,
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
        }>(fact);
        state.runs.set(value.runId, {
          runId: value.runId,
          agentId: value.agentId,
          releaseId: value.releaseId,
          activationEpoch: value.activationEpoch,
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
          processes: new Map(),
          reaped: new Set(),
          revoked: new Set(),
          quiesced: new Map(),
        });
        break;
      }
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
        state.runs.get(value.runId)!.quiesced.set(value.attempt, {
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
): CommandMeta {
  return {
    actorSubjectId,
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

export class HarnessSession {
  readonly #control: Control;
  readonly #token: AttemptToken;

  constructor(control: Control, token: AttemptToken) {
    this.#control = control;
    this.#token = token;
  }

  submit(meta: CommandMeta, input: HarnessInput): Result<null> {
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
        commandKind: value.commandKind,
        targetId: value.targetId,
        idempotencyKey: value.idempotencyKey,
        payloadDigest: canonicalPayloadDigest,
        precondition: value.precondition as JsonValue,
        preconditionDigest: canonicalPreconditionDigest,
      },
      decide,
      options,
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
  ): Result<null> {
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
        "effectId",
        "actionId",
        "intentKey",
        "intentGeneration",
        "operation",
        "payloadDigest",
      ]);
      if (
        !value ||
        ![
          value.effectId,
          value.actionId,
          value.intentKey,
          value.operation,
          value.payloadDigest,
        ].every((part) => typeof part === "string" && part.length > 0) ||
        !Number.isSafeInteger(value.intentGeneration)
      )
        return fail("invalid_input");
      const effect: EffectIntentInput = {
        effectId: value.effectId as string,
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
      if (!validToken(run, token)) return fail("stale_attempt");
      if (!currentActivation(state, run!)) return fail("stale_epoch");
      const drafts: FactDraft[] = [];
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
        const prior = run!.effects.get(decoded.effect.effectId);
        const sameIntent = [...run!.effects.entries()].find(
          ([, effect]) =>
            effect.intentKey === decoded.effect.intentKey &&
            effect.intentGeneration === decoded.effect.intentGeneration,
        );
        if (prior) {
          const exact =
            prior.intentKey === decoded.effect.intentKey &&
            prior.intentGeneration === decoded.effect.intentGeneration &&
            prior.operation === decoded.effect.operation &&
            prior.payloadDigest === decoded.effect.payloadDigest;
          return exact
            ? plan(snapshot, [], null)
            : fail("idempotency_conflict");
        }
        if (sameIntent) return fail("idempotency_conflict");
        drafts.push({
          aggregateId: token.runId,
          factKind: "effect-intent",
          payload: asPayload({
            runId: token.runId,
            attempt: token.attempt,
            ...decoded.effect,
          }),
        });
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
      return plan(snapshot, drafts, null);
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
        if (!run || run.state !== "running") return fail("invalid_state");
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
      if (["completed", "failed", "cancelled"].includes(run.state))
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

  authorizeLaunch(token: AttemptToken): Result<AgentRelease> {
    const snapshot = this.#store.readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      const state = reduceFacts(snapshot.value.facts);
      const run = state.runs.get(token.runId);
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
        if (!currentActivation(state, run)) return fail("stale_epoch");
        if (
          effect.state !== "pending" ||
          decoded.releaseId !== run.releaseId ||
          decoded.activationEpoch !== run.activationEpoch ||
          decoded.expiresAtUnixMs <= Date.now()
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
  ): Result<null> {
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
        if (!currentActivation(state, run)) return fail("stale_epoch");
        if (
          effect.state !== "approved" ||
          !effect.approval ||
          effect.approval.releaseId !== run.releaseId ||
          effect.approval.activationEpoch !== run.activationEpoch ||
          effect.approval.expiresAtUnixMs <= Date.now()
        )
          return fail("invalid_state");
        return plan(
          snapshot,
          [
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
          null,
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

export type Connector = () => Promise<"committed" | "not-committed">;

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

export const newSessionId = (): string => randomUUID();
