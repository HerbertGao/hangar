import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DiagnosticDrain,
  PiChildProtocolMachine,
  type CleanupEvidence,
  type PromptRequest,
} from "../../packages/pi-child-protocol/index.ts";
import {
  SdkSessionDriver,
  type AgentSessionDriverSurface,
} from "../../packages/pi-harness/session-driver.ts";

const hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const request = (overrides: Partial<PromptRequest> = {}): PromptRequest => ({
  schemaVersion: "hangar-pi-ipc-v1",
  type: "prompt-request",
  requestId: "request-1",
  runId: "run-1",
  attempt: 0,
  sessionId: "session-1",
  inputDigest: hex("input"),
  grantGeneration: 1,
  releaseId: hex("release"),
  canonicalPrompt: "canonical prompt",
  promptDigest: hex("canonical prompt"),
  promptText: "prompt",
  virtualCorpus: [
    {
      relativePath: "docs/readme.txt",
      bytes: Buffer.from("hello"),
      digest: hex("hello"),
    },
  ],
  brokerHandle: "provider-handle-1",
  ...overrides,
});
const accepted = (value = request()) => ({
  schemaVersion: "hangar-pi-ipc-v1" as const,
  type: "prompt-accepted" as const,
  requestId: value.requestId,
  runId: value.runId,
  attempt: value.attempt,
  sessionId: value.sessionId,
  inputDigest: value.inputDigest,
  grantGeneration: value.grantGeneration,
  releaseId: value.releaseId,
  promptDigest: value.promptDigest,
});
const settled = (value = request()) => ({
  ...accepted(value),
  type: "settled" as const,
  settlement: "resolved" as const,
});
const ready = {
  schemaVersion: "hangar-pi-ipc-v1" as const,
  type: "ready" as const,
  childInstanceId: "child-1",
};
const cleanup = (
  overrides: Partial<CleanupEvidence> = {},
): CleanupEvidence => ({
  ipcDrained: true,
  stdoutDrained: true,
  stderrDrained: true,
  wholeTreeReaped: true,
  grantRevoked: true,
  durableCancelRequested: false,
  outcomeAccepted: true,
  ...overrides,
});

test("first prompt invokes once; exact duplicate returns stored acceptance; conflict faults", () => {
  const machine = new PiChildProtocolMachine();
  assert.equal(machine.childFrame(ready).state, "ready");
  assert.deepEqual(machine.parentFrame(request()), {
    ok: true,
    state: "active(requested)",
    invokePrompt: true,
  });
  assert.deepEqual(machine.parentFrame(request()), {
    ok: true,
    state: "active(requested)",
    invokePrompt: false,
    storedAcceptance: false,
  });
  assert.equal(machine.childFrame(accepted()).state, "active(accepted)");
  assert.deepEqual(machine.parentFrame(request()), {
    ok: true,
    state: "active(accepted)",
    invokePrompt: false,
    storedAcceptance: true,
  });

  const conflicting = request({ promptText: "changed but same identity" });
  assert.deepEqual(machine.parentFrame(conflicting), {
    ok: false,
    state: "stopping(failed-pending-drain)",
    error: "protocol_fault",
  });
});

test("closed IPC union rejects credential/unknown/oversize and spontaneous frames", () => {
  const credential = new PiChildProtocolMachine();
  credential.childFrame(ready);
  assert.equal(
    credential.parentFrame({ ...request(), providerCredential: "secret" })
      .error,
    "invalid_frame",
  );

  const oversized = new PiChildProtocolMachine();
  oversized.childFrame(ready);
  assert.equal(
    oversized.parentFrame(request({ promptText: "x".repeat(64 * 1024 + 1) }))
      .error,
    "invalid_frame",
  );

  const unknown = new PiChildProtocolMachine();
  assert.equal(
    unknown.childFrame({
      schemaVersion: "hangar-pi-ipc-v1",
      type: "future-sdk-event",
    }).error,
    "invalid_frame",
  );

  const spontaneous = new PiChildProtocolMachine();
  spontaneous.childFrame(ready);
  assert.equal(spontaneous.childFrame(settled()).error, "protocol_fault");

  const mismatched = new PiChildProtocolMachine();
  mismatched.childFrame(ready);
  mismatched.parentFrame(request());
  assert.equal(
    mismatched.childFrame(accepted(request({ requestId: "other" }))).error,
    "protocol_fault",
  );
});

test("process exit is non-terminal; buffered accepted/settled frames drain before cleanup", () => {
  const machine = new PiChildProtocolMachine();
  machine.childFrame(ready);
  machine.parentFrame(request());
  assert.equal(
    machine.processExitOrFault().state,
    "stopping(exit-pending-drain)",
  );
  assert.equal(machine.state.startsWith("terminal("), false);
  assert.equal(machine.childFrame(accepted()).ok, true);
  assert.equal(machine.childFrame(settled()).ok, true);
  machine.closeIpc();
  assert.deepEqual(machine.cleanupComplete(cleanup()), {
    ok: true,
    state: "terminal(succeeded)",
  });
  assert.equal(machine.childFrame(settled()).ignored, true);
  assert.equal(machine.parentFrame(request()).storedAcceptance, true);
});

test("cleanup needs every drain/reap/revoke proof and cause precedence is closed", () => {
  const incomplete = new PiChildProtocolMachine();
  incomplete.childFrame(ready);
  incomplete.parentFrame(request());
  incomplete.childFrame(accepted());
  incomplete.childFrame(settled());
  assert.equal(
    incomplete.cleanupComplete(cleanup({ wholeTreeReaped: false })).ok,
    false,
  );
  assert.equal(incomplete.state.startsWith("terminal("), false);

  const cancelled = new PiChildProtocolMachine();
  cancelled.childFrame(ready);
  cancelled.parentFrame(request());
  cancelled.cancel();
  cancelled.processExitOrFault(true);
  cancelled.closeIpc();
  assert.equal(
    cancelled.cleanupComplete(
      cleanup({ durableCancelRequested: true, outcomeAccepted: false }),
    ).state,
    "terminal(cancelled)",
  );

  const missingOutcome = new PiChildProtocolMachine();
  missingOutcome.childFrame(ready);
  missingOutcome.parentFrame(request());
  missingOutcome.childFrame(accepted());
  missingOutcome.childFrame(settled());
  missingOutcome.processExitOrFault();
  missingOutcome.closeIpc();
  assert.equal(
    missingOutcome.cleanupComplete(cleanup({ outcomeAccepted: false })).state,
    "terminal(failed)",
  );
});

test("SDK retry/compaction stay internal; unknown SDK event faults without settled", async () => {
  const frames: unknown[] = [];
  let listener: ((event: never) => void) | undefined;
  const knownSession: AgentSessionDriverSurface = {
    subscribe: (next) => {
      listener = next as (event: never) => void;
      return () => {
        listener = undefined;
      };
    },
    prompt: async (_text, options) => {
      options?.preflightResult?.(true);
      listener?.({ type: "auto_retry_start" } as never);
      listener?.({ type: "compaction_end" } as never);
    },
    abort: async () => {},
    dispose: () => {},
  };
  await new SdkSessionDriver(knownSession).prompt(request(), (frame) =>
    frames.push(frame),
  );
  assert.deepEqual(
    frames.map((frame) => (frame as { type: string }).type),
    ["prompt-accepted", "settled"],
  );

  const unknownFrames: unknown[] = [];
  const unknownSession: AgentSessionDriverSurface = {
    subscribe: (next) => {
      listener = next as (event: never) => void;
      return () => {
        listener = undefined;
      };
    },
    prompt: async (_text, options) => {
      options?.preflightResult?.(true);
      listener?.({ type: "future_sdk_event" } as never);
    },
    abort: async () => {},
    dispose: () => {},
  };
  await new SdkSessionDriver(unknownSession).prompt(request(), (frame) =>
    unknownFrames.push(frame),
  );
  assert.deepEqual(
    unknownFrames.map((frame) => (frame as { type: string }).type),
    ["prompt-accepted", "protocol-fault"],
  );
});

test("stdout/stderr are bounded diagnostics, never protocol frames", () => {
  const raw = new DiagnosticDrain(["SECRET-CANARY"]);
  assert.equal(raw.append(Buffer.from('{"type":"ready"}')), true);
  assert.equal(raw.append(Buffer.from('{"type":"settled"}')), true);
  const result = raw.close();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value.digest, /^[0-9a-f]{64}$/);
    assert.ok(result.value.summary.includes('"type":"ready"'));
  }

  const invalidUtf8 = new DiagnosticDrain();
  invalidUtf8.append(Buffer.from([0xff]));
  assert.deepEqual(invalidUtf8.close(), {
    ok: false,
    error: "invalid_utf8",
  });

  const secret = new DiagnosticDrain(["SECRET-CANARY"]);
  secret.append(Buffer.from("prefix SECRET-CANARY suffix"));
  assert.deepEqual(secret.close(), { ok: false, error: "secret" });

  const overflow = new DiagnosticDrain();
  assert.equal(overflow.append(Buffer.alloc(64 * 1024 + 1)), false);
  assert.deepEqual(overflow.close(), { ok: false, error: "overflow" });
});
