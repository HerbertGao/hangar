import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]+$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IPC_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CORPUS_ENTRIES = 256;
const MAX_CORPUS_ENTRY_BYTES = 64 * 1024;
const MAX_CORPUS_BYTES = 1024 * 1024;

const identityShape = {
  requestId: z.string().regex(ID).max(128),
  runId: z.string().regex(ID).max(128),
  attempt: z.number().int().min(0),
  sessionId: z.string().regex(ID).max(128),
  inputDigest: z.string().regex(HEX64),
} as const;

const corpusEntry = z.strictObject({
  relativePath: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.split("/").some((part) => part === ".." || part === ""),
    ),
  bytes: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= MAX_CORPUS_ENTRY_BYTES),
  digest: z.string().regex(HEX64),
});

export const PROMPT_REQUEST_SCHEMA = z
  .strictObject({
    schemaVersion: z.literal("hangar-pi-ipc-v1"),
    type: z.literal("prompt-request"),
    ...identityShape,
    grantGeneration: z.number().int().min(0),
    releaseId: z.string().regex(HEX64),
    canonicalPrompt: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= MAX_TEXT_BYTES),
    promptDigest: z.string().regex(HEX64),
    promptText: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= MAX_TEXT_BYTES),
    virtualCorpus: z.array(corpusEntry).max(MAX_CORPUS_ENTRIES),
    brokerHandle: z.string().regex(ID).max(128),
  })
  .superRefine((value, context) => {
    const total = value.virtualCorpus.reduce(
      (sum, entry) => sum + entry.bytes.byteLength,
      0,
    );
    if (total > MAX_CORPUS_BYTES)
      context.addIssue({
        code: "custom",
        message: "virtual corpus exceeds 1MiB",
      });
    const paths = value.virtualCorpus.map(({ relativePath }) => relativePath);
    if (new Set(paths).size !== paths.length)
      context.addIssue({ code: "custom", message: "duplicate corpus path" });
  });

export type PromptRequest = z.infer<typeof PROMPT_REQUEST_SCHEMA>;

const promptIdentitySchema = z.strictObject({
  schemaVersion: z.literal("hangar-pi-ipc-v1"),
  ...identityShape,
  grantGeneration: z.number().int().min(0),
  releaseId: z.string().regex(HEX64),
  promptDigest: z.string().regex(HEX64),
});

export const PARENT_TO_CHILD_SCHEMA = z.discriminatedUnion("type", [
  PROMPT_REQUEST_SCHEMA,
  z.strictObject({
    schemaVersion: z.literal("hangar-pi-ipc-v1"),
    type: z.literal("abort"),
    requestId: z.string().regex(ID),
    runId: z.string().regex(ID),
    attempt: z.number().int().min(0),
    reason: z.enum(["cancelled", "timeout", "protocol-fault"]),
  }),
  z.strictObject({
    schemaVersion: z.literal("hangar-pi-ipc-v1"),
    type: z.literal("shutdown"),
  }),
]);

export const CHILD_TO_PARENT_SCHEMA = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal("hangar-pi-ipc-v1"),
    type: z.literal("ready"),
    childInstanceId: z.string().regex(ID),
  }),
  promptIdentitySchema.extend({ type: z.literal("prompt-accepted") }),
  promptIdentitySchema.extend({
    type: z.literal("sanitized-action-or-tool-event"),
    eventKind: z.enum(["action", "tool-start", "tool-end"]),
    actionId: z.string().regex(ID),
    toolId: z.union([z.string().regex(ID), z.null()]),
    payloadDigest: z.string().regex(HEX64),
  }),
  promptIdentitySchema.extend({
    type: z.literal("fixture-effect-intent"),
    actionId: z.string().regex(ID),
    operation: z.literal("fixture.disposable"),
    intentKey: z.string().regex(ID),
    intentGeneration: z.number().int().min(0),
    payloadDigest: z.string().regex(HEX64),
  }),
  promptIdentitySchema.extend({
    type: z.literal("outcome-artifact"),
    actionId: z.string().regex(ID),
    toolId: z.string().regex(ID),
    schemaId: z.string().regex(ID),
    schemaVersionId: z.string().regex(ID),
    artifactBytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= MAX_TEXT_BYTES),
    artifactDigest: z.string().regex(HEX64),
  }),
  promptIdentitySchema.extend({
    type: z.literal("settled"),
    settlement: z.enum(["resolved", "provider-failed", "aborted"]),
  }),
  z.strictObject({
    schemaVersion: z.literal("hangar-pi-ipc-v1"),
    type: z.literal("protocol-fault"),
    faultKind: z.enum([
      "unknown-sdk-event",
      "provider-fault",
      "tool-fault",
      "invalid-frame",
    ]),
    diagnosticDigest: z.string().regex(HEX64),
  }),
]);

export type ParentToChildMessage = z.infer<typeof PARENT_TO_CHILD_SCHEMA>;
export type ChildToParentMessage = z.infer<typeof CHILD_TO_PARENT_SCHEMA>;
export type TerminalCause = "succeeded" | "cancelled" | "failed";
export type AdapterState =
  | "starting"
  | "ready"
  | "active(requested)"
  | "active(accepted)"
  | "draining(settled-pending-cleanup)"
  | "stopping(cancelled)"
  | "stopping(exit-pending-drain)"
  | "stopping(failed-pending-drain)"
  | `terminal(${TerminalCause})`;

export interface ProtocolResult {
  readonly ok: boolean;
  readonly state: AdapterState;
  readonly invokePrompt?: boolean;
  readonly storedAcceptance?: boolean;
  readonly ignored?: boolean;
  readonly error?: "rejected_transition" | "protocol_fault" | "invalid_frame";
}

export interface CleanupEvidence {
  readonly ipcDrained: boolean;
  readonly stdoutDrained: boolean;
  readonly stderrDrained: boolean;
  readonly wholeTreeReaped: boolean;
  readonly grantRevoked: boolean;
  readonly durableCancelRequested: boolean;
  readonly outcomeAccepted: boolean;
}

const canonicalFrameBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const samePrompt = (left: PromptRequest, right: PromptRequest): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const matchesPrompt = (
  request: PromptRequest,
  frame: Pick<
    ChildToParentMessage & Record<string, unknown>,
    | "requestId"
    | "runId"
    | "attempt"
    | "sessionId"
    | "inputDigest"
    | "promptDigest"
    | "releaseId"
    | "grantGeneration"
  >,
): boolean =>
  request.requestId === frame.requestId &&
  request.runId === frame.runId &&
  request.attempt === frame.attempt &&
  request.sessionId === frame.sessionId &&
  request.inputDigest === frame.inputDigest &&
  request.promptDigest === frame.promptDigest &&
  request.releaseId === frame.releaseId &&
  request.grantGeneration === frame.grantGeneration;

/** Pure parent-side state table. It never calls Pi or a model. */
export class PiChildProtocolMachine {
  #state: AdapterState = "starting";
  #request?: PromptRequest;
  #accepted = false;
  #settled = false;
  #cancelled = false;
  #fault = false;
  #ipcClosed = false;

  get state(): AdapterState {
    return this.#state;
  }

  parentFrame(frame: unknown): ProtocolResult {
    if (canonicalFrameBytes(frame) > MAX_IPC_FRAME_BYTES)
      return this.#protocolFault("invalid_frame");
    const parsed = PARENT_TO_CHILD_SCHEMA.safeParse(frame);
    if (!parsed.success) return this.#protocolFault("invalid_frame");
    const message = parsed.data;
    if (message.type === "abort") return this.cancel();
    if (message.type === "shutdown") {
      if (this.#state.startsWith("terminal("))
        return { ok: true, state: this.#state, ignored: true };
      return this.#reject();
    }
    if (this.#state === "ready") {
      this.#request = message;
      this.#state = "active(requested)";
      return { ok: true, state: this.#state, invokePrompt: true };
    }
    if (this.#request && samePrompt(this.#request, message))
      return {
        ok: true,
        state: this.#state,
        invokePrompt: false,
        storedAcceptance: this.#accepted,
      };
    if (this.#state.startsWith("terminal(")) return this.#reject();
    return this.#protocolFault("protocol_fault");
  }

  childFrame(frame: unknown): ProtocolResult {
    if (this.#state.startsWith("terminal("))
      return { ok: true, state: this.#state, ignored: true };
    if (this.#ipcClosed || canonicalFrameBytes(frame) > MAX_IPC_FRAME_BYTES)
      return this.#protocolFault("invalid_frame");
    const parsed = CHILD_TO_PARENT_SCHEMA.safeParse(frame);
    if (!parsed.success) return this.#protocolFault("invalid_frame");
    const message = parsed.data;
    if (message.type === "ready") {
      if (this.#state !== "starting") return this.#reject();
      this.#state = "ready";
      return { ok: true, state: this.#state };
    }
    if (message.type === "protocol-fault")
      return this.#protocolFault("protocol_fault");
    if (!this.#request || !matchesPrompt(this.#request, message))
      return this.#protocolFault("protocol_fault");
    if (message.type === "prompt-accepted") {
      if (
        this.#state !== "active(requested)" &&
        !this.#state.startsWith("stopping(")
      )
        return this.#accepted
          ? { ok: true, state: this.#state }
          : this.#reject();
      this.#accepted = true;
      if (this.#state === "active(requested)") this.#state = "active(accepted)";
      return { ok: true, state: this.#state };
    }
    if (message.type === "settled") {
      if (!this.#accepted) return this.#protocolFault("protocol_fault");
      this.#settled = true;
      if (this.#state === "active(accepted)")
        this.#state = "draining(settled-pending-cleanup)";
      return { ok: true, state: this.#state };
    }
    if (!this.#accepted) return this.#protocolFault("protocol_fault");
    return { ok: true, state: this.#state };
  }

  cancel(): ProtocolResult {
    if (this.#state.startsWith("terminal("))
      return { ok: true, state: this.#state };
    this.#cancelled = true;
    this.#state = "stopping(cancelled)";
    return { ok: true, state: this.#state };
  }

  processExitOrFault(fault = false): ProtocolResult {
    if (this.#state.startsWith("terminal("))
      return { ok: true, state: this.#state, ignored: true };
    this.#fault ||= fault;
    if (!this.#cancelled)
      this.#state = fault
        ? "stopping(failed-pending-drain)"
        : "stopping(exit-pending-drain)";
    return { ok: true, state: this.#state };
  }

  closeIpc(): ProtocolResult {
    this.#ipcClosed = true;
    return { ok: true, state: this.#state };
  }

  cleanupComplete(evidence: CleanupEvidence): ProtocolResult {
    if (this.#state.startsWith("terminal("))
      return { ok: true, state: this.#state };
    if (
      !evidence.ipcDrained ||
      !evidence.stdoutDrained ||
      !evidence.stderrDrained ||
      !evidence.wholeTreeReaped ||
      !evidence.grantRevoked
    )
      return this.#reject();
    if (
      this.#state === "ready" ||
      this.#state === "active(requested)" ||
      this.#state === "active(accepted)"
    )
      return this.#reject();
    const cause: TerminalCause =
      evidence.durableCancelRequested || this.#cancelled
        ? "cancelled"
        : this.#fault ||
            !this.#request ||
            !this.#accepted ||
            !this.#settled ||
            !evidence.outcomeAccepted
          ? "failed"
          : "succeeded";
    this.#state = `terminal(${cause})`;
    return { ok: true, state: this.#state };
  }

  #reject(): ProtocolResult {
    return { ok: false, state: this.#state, error: "rejected_transition" };
  }

  #protocolFault(error: "protocol_fault" | "invalid_frame"): ProtocolResult {
    this.#fault = true;
    if (!this.#cancelled) this.#state = "stopping(failed-pending-drain)";
    return { ok: false, state: this.#state, error };
  }
}

export interface DiagnosticResult {
  readonly digest: string;
  readonly summary: string;
  readonly byteLength: number;
}

/** Bounded diagnostic pipe; it never interprets JSON-looking output as IPC. */
export class DiagnosticDrain {
  readonly #secretCanaries: readonly string[];
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #fault?: "overflow" | "invalid_utf8" | "secret";

  constructor(secretCanaries: readonly string[] = []) {
    this.#secretCanaries = secretCanaries;
  }

  append(chunk: Uint8Array): boolean {
    if (this.#fault) return false;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_TEXT_BYTES) {
      this.#fault = "overflow";
      return false;
    }
    this.#chunks.push(chunk);
    return true;
  }

  close():
    | { readonly ok: true; readonly value: DiagnosticResult }
    | {
        readonly ok: false;
        readonly error: "overflow" | "invalid_utf8" | "secret";
      } {
    if (this.#fault) return { ok: false, error: this.#fault };
    const bytes = Buffer.concat(this.#chunks);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: "invalid_utf8" };
    }
    if (this.#secretCanaries.some((secret) => secret && text.includes(secret)))
      return { ok: false, error: "secret" };
    const safe = [...text]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 && character !== "\n" && character !== "\t"
          ? "�"
          : character;
      })
      .join("")
      .slice(0, 512);
    return {
      ok: true,
      value: {
        digest: createHash("sha256").update(bytes).digest("hex"),
        summary: safe,
        byteLength: bytes.byteLength,
      },
    };
  }
}
