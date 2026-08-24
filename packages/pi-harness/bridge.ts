import { createHash } from "node:crypto";

import {
  commandMeta,
  type EffectGateway,
  type HarnessSession,
  type OutcomeAcceptor,
  type TrustedPiCleanupController,
} from "../control-core/index.ts";
import type { AgentRelease, AttemptToken, Result } from "../contracts/index.ts";
import {
  PiChildProtocolMachine,
  type ChildToParentMessage,
  type CleanupEvidence,
  type PromptRequest,
} from "../pi-child-protocol/index.ts";
import type { ExpectedArtifactDeriver } from "./expected-artifact.ts";

export interface PiHarnessBridgeOptions {
  readonly actorSubjectId: string;
  readonly intentId: string;
  readonly outcomeToolId: string;
  readonly outcomeActionId: string;
  readonly activationEpoch: number;
}

export class PiHarnessBridge {
  readonly #machine = new PiChildProtocolMachine();
  readonly #session: HarnessSession;
  readonly #gateway: EffectGateway;
  readonly #outcomes: OutcomeAcceptor;
  readonly #cleanup: TrustedPiCleanupController;
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
    session: HarnessSession,
    gateway: EffectGateway,
    outcomes: OutcomeAcceptor,
    cleanup: TrustedPiCleanupController,
    token: AttemptToken,
    release: AgentRelease,
    request: PromptRequest,
    expected: ExpectedArtifactDeriver,
    options: PiHarnessBridgeOptions,
  ) {
    this.#session = session;
    this.#gateway = gateway;
    this.#outcomes = outcomes;
    this.#cleanup = cleanup;
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

  processExitOrFault(fault = false): void {
    this.#fault ||= fault;
    this.#machine.processExitOrFault(fault);
  }

  closeIpc(): void {
    this.#machine.closeIpc();
  }

  async handle(frame: ChildToParentMessage): Promise<Result<null>> {
    const transition = this.#machine.childFrame(frame);
    if (!transition.ok) {
      this.#fault = true;
      return { ok: false, error: "invalid_state" };
    }
    if (transition.ignored) return { ok: true, value: null };
    if (frame.type === "protocol-fault") {
      this.#fault = true;
      return { ok: false, error: "invalid_state" };
    }
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
    terminalize = true,
  ): Result<{ cause: "succeeded" | "failed" }> {
    const completed = this.#machine.cleanupComplete({
      ...evidence,
      durableCancelRequested: false,
      outcomeAccepted: this.#outcomeAccepted && !this.#fault,
    });
    const cause =
      completed.state === "terminal(succeeded)" ? "succeeded" : "failed";
    if (!completed.ok || !completed.state.startsWith("terminal("))
      return { ok: false, error: "invalid_state" };
    const cleanupEvidence = {
      ipcDrained: evidence.ipcDrained,
      stdoutDrained: evidence.stdoutDrained,
      stderrDrained: evidence.stderrDrained,
      wholeTreeReaped: evidence.wholeTreeReaped,
      grantRevoked: evidence.grantRevoked,
      outcomeAccepted: this.#outcomeAccepted && !this.#fault,
    };
    const committed = this.#cleanup.commit(
      commandMeta(
        this.#options.actorSubjectId,
        "pi-cleanup",
        this.#token.runId,
        `pi-cleanup-${this.#token.attempt}`,
        { cause, evidence: cleanupEvidence },
        this.#token,
      ),
      this.#token,
      cause,
      cleanupEvidence,
    );
    if (!committed.ok) return committed;
    if (terminalize) {
      const state = cause === "succeeded" ? "completed" : "failed";
      const terminal = this.#cleanup.terminalize(
        commandMeta(
          this.#options.actorSubjectId,
          "terminalize",
          this.#token.runId,
          `pi-terminal-${this.#token.attempt}`,
          { state },
        ),
        this.#token.runId,
        cause,
      );
      if (!terminal.ok) return terminal;
    }
    return { ok: true, value: { cause } };
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
      const result = this.#session.submit(
        commandMeta(
          this.#options.actorSubjectId,
          "register-action",
          this.#token.runId,
          `pi-action-${frame.actionId}`,
          input,
          this.#token,
        ),
        input,
      );
      if (result.ok) this.#actions.add(frame.actionId);
      return result;
    }
    if (!this.#actions.has(frame.actionId)) {
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "invalid_state" };
    }
    if (
      frame.toolId === null ||
      !this.#release.spec.capabilities.includes(frame.toolId)
    ) {
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "forbidden" };
    }
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
    ) {
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "forbidden" };
    }
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
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "idempotency_conflict" };
    }
    this.#fixtureEffects.set(frame.intentKey, signature);
    const effectId = createHash("sha256")
      .update(
        `${this.#token.runId}\0${frame.intentKey}\0${frame.intentGeneration}`,
      )
      .digest("hex");
    const intent = {
      type: "effect-intent" as const,
      effect: {
        effectId,
        actionId: frame.actionId,
        intentKey: frame.intentKey,
        intentGeneration: frame.intentGeneration,
        operation: frame.operation,
        payloadDigest: frame.payloadDigest,
      },
    };
    const submitted = this.#session.submit(
      commandMeta(
        this.#options.actorSubjectId,
        "effect-intent",
        this.#token.runId,
        `pi-effect-${frame.intentKey}`,
        intent,
        this.#token,
      ),
      intent,
    );
    if (!submitted.ok) return submitted;
    const approval = {
      decision: "approved" as const,
      releaseId: this.#release.releaseId,
      activationEpoch: this.#options.activationEpoch,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
    };
    const approved = this.#gateway.approve(
      commandMeta(
        this.#options.actorSubjectId,
        "approve-effect",
        this.#token.runId,
        `pi-effect-approve-${frame.intentKey}`,
        { runId: this.#token.runId, effectId, approval },
      ),
      this.#token.runId,
      effectId,
      approval,
    );
    if (!approved.ok) return approved;
    const binding = { runId: this.#token.runId, effectId };
    const dispatched = await this.#gateway.dispatch(
      {
        start: commandMeta(
          this.#options.actorSubjectId,
          "dispatch-effect",
          this.#token.runId,
          `pi-effect-start-${frame.intentKey}`,
          binding,
        ),
        outcome: commandMeta(
          this.#options.actorSubjectId,
          "record-effect-outcome",
          this.#token.runId,
          `pi-effect-outcome-${frame.intentKey}`,
          binding,
        ),
        unknown: commandMeta(
          this.#options.actorSubjectId,
          "mark-effect-unknown",
          this.#token.runId,
          `pi-effect-unknown-${frame.intentKey}`,
          binding,
        ),
      },
      this.#token.runId,
      effectId,
      async () => {
        throw new Error("fixture response lost");
      },
    );
    return !dispatched.ok && dispatched.error === "unknown_effect"
      ? { ok: true, value: null }
      : dispatched;
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
    ) {
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "invalid_input" };
    }
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
    if (expected.digest !== frame.artifactDigest || !exactBytes) {
      this.#fault = true;
      this.#machine.processExitOrFault(true);
      return { ok: false, error: "invalid_state" };
    }
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
    const observed = this.#session.submit(
      commandMeta(
        this.#options.actorSubjectId,
        "tool-observation",
        this.#token.runId,
        `pi-observation-${frame.actionId}`,
        observation,
        this.#token,
      ),
      observation,
    );
    if (!observed.ok) return observed;
    const proposal = {
      type: "outcome-proposal" as const,
      proposal: { artifactDigest: frame.artifactDigest },
    };
    const proposed = this.#session.submit(
      commandMeta(
        this.#options.actorSubjectId,
        "outcome-proposal",
        this.#token.runId,
        `pi-proposal-${frame.actionId}`,
        proposal,
        this.#token,
      ),
      proposal,
    );
    if (!proposed.ok) return proposed;
    const accepted = this.#outcomes.accept(
      commandMeta(
        this.#options.actorSubjectId,
        "accept-outcome",
        this.#token.runId,
        `pi-accept-${frame.actionId}`,
        {
          runId: this.#token.runId,
          attempt: this.#token.attempt,
          artifactDigest: frame.artifactDigest,
        },
      ),
      {
        runId: this.#token.runId,
        attempt: this.#token.attempt,
        artifactDigest: frame.artifactDigest,
      },
    );
    if (accepted.ok) this.#outcomeAccepted = true;
    return accepted.ok ? { ok: true, value: null } : accepted;
  }
}
