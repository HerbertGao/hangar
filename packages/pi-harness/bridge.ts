import { createHash } from "node:crypto";

import type {
  AgentRelease,
  AttemptToken,
  ErrorKind,
  HarnessAdapterPort,
  Result,
} from "../contracts/index.ts";
import {
  PiChildProtocolMachine,
  type ChildToParentMessage,
  type CleanupEvidence,
  type PromptRequest,
} from "../pi-child-protocol/index.ts";
import type { ExpectedArtifactDeriver } from "./expected-artifact.ts";

export interface PiHarnessBridgeOptions {
  readonly intentId: string;
  readonly outcomeToolId: string;
  readonly outcomeActionId: string;
}

export class PiHarnessBridge {
  readonly #machine = new PiChildProtocolMachine();
  readonly #port: HarnessAdapterPort;
  readonly #token: AttemptToken;
  readonly #release: AgentRelease;
  readonly #request: PromptRequest;
  readonly #expected: ExpectedArtifactDeriver;
  readonly #options: PiHarnessBridgeOptions;
  readonly #actions = new Set<string>();
  readonly #completedTools = new Map<string, string>();
  readonly #artifacts = new Map<string, string>();
  readonly #fixtureEffects = new Map<string, string>();
  #outcomeAccepted = false;
  #fault = false;

  constructor(
    port: HarnessAdapterPort,
    token: AttemptToken,
    release: AgentRelease,
    request: PromptRequest,
    expected: ExpectedArtifactDeriver,
    options: PiHarnessBridgeOptions,
  ) {
    this.#port = port;
    this.#token = token;
    this.#release = release;
    this.#request = request;
    this.#expected = expected;
    this.#options = options;
    const ready = this.#machine.childFrame({
      schemaVersion: "hangar-pi-ipc-v1",
      type: "ready",
      childInstanceId: "bridge-child",
    });
    const started = this.#machine.parentFrame(request);
    if (!ready.ok || !started.ok) throw new Error("bridge_start_failed");
  }

  get state() {
    return this.#machine.state;
  }

  get outcomeAccepted(): boolean {
    return this.#outcomeAccepted;
  }

  processExitOrFault(fault = false): Result<null> {
    const recorded = fault
      ? this.#recordFault()
      : ({ ok: true, value: null } as const);
    this.#machine.processExitOrFault(fault);
    return recorded;
  }

  closeIpc(): void {
    this.#machine.closeIpc();
  }

  async handle(frame: ChildToParentMessage): Promise<Result<null>> {
    const transition = this.#machine.childFrame(frame);
    if (!transition.ok) return this.#faultResult("invalid_state");
    if (transition.ignored) return { ok: true, value: null };
    if (frame.type === "protocol-fault")
      return this.#faultResult("invalid_state");
    if (frame.type === "prompt-accepted" || frame.type === "settled")
      return { ok: true, value: null };
    if (frame.type === "sanitized-action-or-tool-event")
      return this.#handleToolEvent(frame);
    if (frame.type === "fixture-effect-intent")
      return this.#handleFixtureEffect(frame);
    if (frame.type === "outcome-artifact") return this.#handleArtifact(frame);
    return { ok: false, error: "invalid_input" };
  }

  cleanup(
    evidence: Omit<
      CleanupEvidence,
      "outcomeAccepted" | "durableCancelRequested"
    >,
  ): Result<{ cause: "succeeded" | "failed" }> {
    if (this.#fault) {
      const recorded = this.#recordFault();
      if (!recorded.ok) return recorded;
    }
    const completed = this.#machine.cleanupComplete({
      ...evidence,
      durableCancelRequested: false,
      outcomeAccepted: this.#outcomeAccepted && !this.#fault,
    });
    if (!completed.ok || !completed.state.startsWith("terminal("))
      return { ok: false, error: "invalid_state" };
    return this.#port.commitCleanup(
      `pi-cleanup-${this.#token.attempt}`,
      {
        ipcDrained: evidence.ipcDrained,
        stdoutDrained: evidence.stdoutDrained,
        stderrDrained: evidence.stderrDrained,
        wholeTreeReaped: evidence.wholeTreeReaped,
        grantRevoked: evidence.grantRevoked,
      },
    );
  }

  #recordFault(): Result<null> {
    this.#fault = true;
    return this.#port.recordFault(`pi-fault-${this.#token.attempt}`);
  }

  #faultResult(error: ErrorKind): Result<null> {
    const recorded = this.#recordFault();
    this.#machine.processExitOrFault(true);
    return recorded.ok ? { ok: false, error } : recorded;
  }

  #handleToolEvent(
    frame: Extract<
      ChildToParentMessage,
      { type: "sanitized-action-or-tool-event" }
    >,
  ): Result<null> {
    if (frame.eventKind === "action") {
      const input = {
        type: "action" as const,
        action: {
          actionId: frame.actionId,
          kind: "tool" as const,
          inputDigest: frame.payloadDigest,
        },
      };
      const result = this.#port.submit(
        `pi-action-${frame.actionId}`,
        input,
      );
      if (result.ok) this.#actions.add(frame.actionId);
      return result;
    }
    if (!this.#actions.has(frame.actionId))
      return this.#faultResult("invalid_state");
    if (
      frame.toolId === null ||
      !this.#release.spec.capabilities.includes(frame.toolId)
    )
      return this.#faultResult("forbidden");
    if (frame.eventKind === "tool-end")
      this.#completedTools.set(frame.actionId, frame.toolId);
    return { ok: true, value: null };
  }

  async #handleFixtureEffect(
    frame: Extract<ChildToParentMessage, { type: "fixture-effect-intent" }>,
  ): Promise<Result<null>> {
    if (
      !this.#actions.has(frame.actionId) ||
      !this.#release.spec.effectOperations.includes(frame.operation)
    )
      return this.#faultResult("forbidden");
    const signature = createHash("sha256")
      .update(
        JSON.stringify({
          actionId: frame.actionId,
          operation: frame.operation,
          intentKey: frame.intentKey,
          intentGeneration: frame.intentGeneration,
          payloadDigest: frame.payloadDigest,
        }),
      )
      .digest("hex");
    const prior = this.#fixtureEffects.get(frame.intentKey);
    if (prior) {
      if (prior === signature) return { ok: true, value: null };
      return this.#faultResult("idempotency_conflict");
    }
    this.#fixtureEffects.set(frame.intentKey, signature);
    const intent = {
      type: "effect-intent" as const,
      effect: {
        actionId: frame.actionId,
        intentKey: frame.intentKey,
        intentGeneration: frame.intentGeneration,
        operation: frame.operation,
        payloadDigest: frame.payloadDigest,
      },
    };
    return this.#port.submitEffect(
      `pi-effect-${frame.intentKey}`,
      intent,
    );
  }

  #handleArtifact(
    frame: Extract<ChildToParentMessage, { type: "outcome-artifact" }>,
  ): Result<null> {
    const childDigest = createHash("sha256")
      .update(frame.artifactBytes)
      .digest("hex");
    const descriptor = this.#release.spec.intentDescriptors.find(
      ({ intentId }) => intentId === this.#options.intentId,
    );
    const prior = this.#artifacts.get(frame.actionId);
    if (
      !descriptor ||
      !this.#actions.has(frame.actionId) ||
      this.#completedTools.get(frame.actionId) !== frame.toolId ||
      frame.actionId !== this.#options.outcomeActionId ||
      frame.toolId !== this.#options.outcomeToolId ||
      !this.#release.spec.capabilities.includes(frame.toolId) ||
      frame.schemaId !== descriptor.resultSchema.id ||
      frame.schemaVersionId !== descriptor.resultSchema.version ||
      childDigest !== frame.artifactDigest ||
      (prior !== undefined && prior !== frame.artifactDigest)
    )
      return this.#faultResult("invalid_input");
    const expected = this.#expected.derive(
      this.#release,
      this.#options.intentId,
      this.#request,
    );
    const exactBytes =
      expected.bytes.byteLength === frame.artifactBytes.byteLength &&
      expected.bytes.every(
        (byte, index) => byte === frame.artifactBytes[index],
      );
    if (expected.digest !== frame.artifactDigest || !exactBytes)
      return this.#faultResult("invalid_state");
    if (prior === frame.artifactDigest) return { ok: true, value: null };
    this.#artifacts.set(frame.actionId, frame.artifactDigest);
    const observation = {
      type: "tool-observation" as const,
      observation: {
        actionId: frame.actionId,
        toolId: frame.toolId,
        outputDigest: frame.artifactDigest,
        grantGeneration: this.#request.grantGeneration,
      },
    };
    const observed = this.#port.submit(
      `pi-observation-${frame.actionId}`,
      observation,
    );
    if (!observed.ok) return observed;
    const proposal = {
      type: "outcome-proposal" as const,
      proposal: { artifactDigest: frame.artifactDigest },
    };
    const proposed = this.#port.submit(
      `pi-proposal-${frame.actionId}`,
      proposal,
    );
    if (!proposed.ok) return proposed;
    this.#outcomeAccepted = proposed.value.outcomeAccepted;
    return { ok: true, value: null };
  }
}
