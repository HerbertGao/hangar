import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  PiChildProtocolMachine,
  type ChildToParentMessage,
  type ParentToChildMessage,
  type PromptRequest,
} from "../pi-child-protocol/index.ts";

export type ChildFrameEmitter = (frame: ChildToParentMessage) => void;

export type AgentSessionDriverSurface = Pick<
  AgentSession,
  "prompt" | "abort" | "dispose" | "subscribe"
>;

export interface SessionDriver {
  prompt(request: PromptRequest, emit: ChildFrameEmitter): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

type PromptAcceptedFrame = Extract<
  ChildToParentMessage,
  { type: "prompt-accepted" }
>;

const acceptedFrame = (request: PromptRequest): PromptAcceptedFrame => ({
  schemaVersion: "hangar-pi-ipc-v1",
  type: "prompt-accepted",
  requestId: request.requestId,
  runId: request.runId,
  attempt: request.attempt,
  sessionId: request.sessionId,
  inputDigest: request.inputDigest,
  grantGeneration: request.grantGeneration,
  releaseId: request.releaseId,
  promptDigest: request.promptDigest,
});

/** Production driver: public Pi AgentSession only; prompt resolve is neutral settled. */
const KNOWN_SDK_EVENTS = new Set([
  "message_update",
  "message_start",
  "message_end",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

export class SdkSessionDriver implements SessionDriver {
  readonly #session: AgentSessionDriverSurface;

  constructor(session: AgentSessionDriverSurface) {
    this.#session = session;
  }

  async prompt(request: PromptRequest, emit: ChildFrameEmitter): Promise<void> {
    let accepted = false;
    let sdkFault = false;
    const unsubscribe = this.#session.subscribe((event) => {
      if (!KNOWN_SDK_EVENTS.has(event.type)) {
        sdkFault = true;
        emit({
          schemaVersion: "hangar-pi-ipc-v1",
          type: "protocol-fault",
          faultKind: "unknown-sdk-event",
          diagnosticDigest: "0".repeat(64),
        });
      }
    });
    try {
      await this.#session.prompt(request.promptText, {
        expandPromptTemplates: false,
        preflightResult: (success) => {
          if (success && !accepted) {
            accepted = true;
            emit(acceptedFrame(request));
          }
        },
      });
      if (sdkFault) return;
      if (!accepted) {
        emit({
          schemaVersion: "hangar-pi-ipc-v1",
          type: "protocol-fault",
          faultKind: "provider-fault",
          diagnosticDigest: "0".repeat(64),
        });
        return;
      }
      emit({
        ...acceptedFrame(request),
        type: "settled",
        settlement: "resolved",
      });
    } catch {
      emit({
        schemaVersion: "hangar-pi-ipc-v1",
        type: "protocol-fault",
        faultKind: "provider-fault",
        diagnosticDigest: "0".repeat(64),
      });
    } finally {
      unsubscribe();
    }
  }

  abort(): Promise<void> {
    return this.#session.abort();
  }

  dispose(): void {
    this.#session.dispose();
  }
}

/** Standard injected driver for deterministic fixtures; no Control access. */
export class DeterministicSessionDriver implements SessionDriver {
  readonly #frames: readonly ChildToParentMessage[];
  #aborted = false;

  constructor(frames: readonly ChildToParentMessage[]) {
    this.#frames = frames;
  }

  async prompt(
    _request: PromptRequest,
    emit: ChildFrameEmitter,
  ): Promise<void> {
    for (const frame of this.#frames) {
      if (this.#aborted) break;
      emit(frame);
      await Promise.resolve();
    }
  }

  async abort(): Promise<void> {
    this.#aborted = true;
  }

  dispose(): void {
    this.#aborted = true;
  }
}

export type SessionDriverFactory = (
  request: PromptRequest,
) => Promise<SessionDriver>;

/** Child runtime; driver outputs still pass the same closed state machine. */
export class PiChildRuntime {
  readonly #machine = new PiChildProtocolMachine();
  readonly #factory: SessionDriverFactory;
  readonly #send: ChildFrameEmitter;
  #driver?: SessionDriver;

  constructor(factory: SessionDriverFactory, send: ChildFrameEmitter) {
    this.#factory = factory;
    this.#send = send;
  }

  get state() {
    return this.#machine.state;
  }

  childReady(childInstanceId: string): void {
    this.#emit({
      schemaVersion: "hangar-pi-ipc-v1",
      type: "ready",
      childInstanceId,
    });
  }

  async handle(message: ParentToChildMessage): Promise<void> {
    const transition = this.#machine.parentFrame(message);
    if (!transition.ok) {
      this.#emitFault("invalid-frame");
      return;
    }
    if (message.type === "abort") {
      await this.#driver?.abort();
      return;
    }
    if (message.type === "shutdown") {
      this.dispose();
      return;
    }
    if (transition.storedAcceptance) {
      this.#emit(acceptedFrame(message));
      return;
    }
    if (!transition.invokePrompt) return;
    try {
      this.#driver = await this.#factory(message);
      await this.#driver.prompt(message, (frame) => this.#emit(frame));
    } catch {
      this.#emitFault("provider-fault");
    }
  }

  processExitOrFault(): void {
    this.#machine.processExitOrFault(true);
  }

  closeIpc(): void {
    this.#machine.closeIpc();
  }

  dispose(): void {
    this.#driver?.dispose();
  }

  #emit(frame: ChildToParentMessage): void {
    const result = this.#machine.childFrame(frame);
    if (result.ok) this.#send(frame);
    else if (frame.type !== "protocol-fault") this.#emitFault("invalid-frame");
  }

  #emitFault(faultKind: "invalid-frame" | "provider-fault"): void {
    const frame: ChildToParentMessage = {
      schemaVersion: "hangar-pi-ipc-v1",
      type: "protocol-fault",
      faultKind,
      diagnosticDigest: "0".repeat(64),
    };
    this.#machine.childFrame(frame);
    this.#send(frame);
  }
}
