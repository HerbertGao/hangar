import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileRelease,
  type AgentRelease,
  type AgentSpec,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
  createTrustedPiCleanupController,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";
import { PiHarnessBridge } from "../../packages/pi-harness/bridge.ts";
import {
  HEARTBEAT_EXPECTED_ARTIFACT,
  type ExpectedArtifactDeriver,
} from "../../packages/pi-harness/expected-artifact.ts";
import {
  DeterministicSessionDriver,
  PiChildRuntime,
} from "../../packages/pi-harness/session-driver.ts";
import type {
  ChildToParentMessage,
  PromptRequest,
} from "../../packages/pi-child-protocol/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

async function setup(
  harnessKind: AgentSpec["harnessKind"],
  deriver: ExpectedArtifactDeriver = HEARTBEAT_EXPECTED_ARTIFACT,
) {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-parity-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(
    owner.initialize(`database-${harnessKind}`, `target-${harnessKind}`),
  );
  let acceptedDigest = "";
  const runtime = openSqliteControl(
    join(directory, "control.sqlite"),
    { authorityPath, fence },
    { outcomeGate: ({ artifactDigest }) => artifactDigest === acceptedDigest },
  );
  const spec: AgentSpec = {
    agentId: "agent-heartbeat",
    goal: "emit deterministic heartbeat",
    harnessKind,
    checkpointSchema: "checkpoint-v1",
    capabilities: ["outcome-submit"],
    effectOperations: ["fixture.disposable"],
    intentDescriptors: [
      {
        intentId: "emit",
        descriptorVersion: 1,
        inputSchema: {
          id: "control-metadata",
          version: "1",
          digest: "a".repeat(64),
        },
        scope: "run-start",
        policyId: "shadow-only",
        resultSchema: {
          id: "heartbeat-result",
          version: "1",
          digest: "b".repeat(64),
        },
      },
    ],
  };
  const closure: ExecutionClosure = {
    entryId: `${harnessKind}-entry`,
    executable: process.execPath,
    executableDigest: hex(`${harnessKind}-executable`),
    members: [{ id: "pinned-resource", digest: hex("resource") }],
  };
  const release = compileRelease(spec, closure);
  value(
    runtime.control.publish(
      commandMeta(
        "actor",
        "publish-release",
        release.releaseId,
        "publish",
        release,
      ),
      release,
    ),
  );
  value(
    runtime.control.activate(
      commandMeta(
        "actor",
        "activate",
        spec.agentId,
        "activate",
        { agentId: spec.agentId, releaseId: release.releaseId, epoch: 1 },
        { expectedCurrentEpoch: null },
      ),
      { agentId: spec.agentId, releaseId: release.releaseId, epoch: 1 },
    ),
  );
  const runId = `run-${harnessKind}`;
  const admitInput = {
    runId,
    agentId: spec.agentId,
    releaseId: release.releaseId,
    activationEpoch: 1,
  };
  const token = value(
    runtime.control.admit(
      commandMeta("actor", "admit", runId, "admit", admitInput, {
        releaseId: release.releaseId,
        activationEpoch: 1,
      }),
      admitInput,
    ),
  );
  const request: PromptRequest = {
    schemaVersion: "hangar-pi-ipc-v1",
    type: "prompt-request",
    requestId: `request-${harnessKind}`,
    runId,
    attempt: token.attempt,
    sessionId: token.sessionId,
    inputDigest: hex("same-persisted-input"),
    grantGeneration: token.generation,
    releaseId: release.releaseId,
    canonicalPrompt: "canonical heartbeat prompt",
    promptDigest: hex("canonical heartbeat prompt"),
    promptText: "emit heartbeat",
    virtualCorpus: [],
    brokerHandle: "provider-handle",
  };
  const expected = deriver.derive(release, "emit", request);
  acceptedDigest = expected.digest;
  const bridge = new PiHarnessBridge(
    runtime.control.harness(token),
    createEffectGateway(runtime.control),
    runtime.outcomes,
    createTrustedPiCleanupController(runtime.control),
    token,
    release,
    request,
    deriver,
    {
      actorSubjectId: "actor",
      intentId: "emit",
      outcomeToolId: "outcome-submit",
      outcomeActionId: "outcome-action",
      activationEpoch: 1,
    },
  );
  return {
    runtime,
    owner,
    release,
    token,
    request,
    expected,
    bridge,
    runId,
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const identity = (request: PromptRequest) => ({
  schemaVersion: "hangar-pi-ipc-v1" as const,
  requestId: request.requestId,
  runId: request.runId,
  attempt: request.attempt,
  sessionId: request.sessionId,
  inputDigest: request.inputDigest,
  grantGeneration: request.grantGeneration,
  releaseId: request.releaseId,
  promptDigest: request.promptDigest,
});

const happyFrames = (
  release: AgentRelease,
  request: PromptRequest,
  bytes: Uint8Array,
): ChildToParentMessage[] => [
  { ...identity(request), type: "prompt-accepted" },
  {
    ...identity(request),
    type: "sanitized-action-or-tool-event",
    eventKind: "action",
    actionId: "outcome-action",
    toolId: null,
    payloadDigest: hex("outcome-input"),
  },
  {
    ...identity(request),
    type: "sanitized-action-or-tool-event",
    eventKind: "tool-end",
    actionId: "outcome-action",
    toolId: "outcome-submit",
    payloadDigest: hex(bytes),
  },
  {
    ...identity(request),
    type: "outcome-artifact",
    actionId: "outcome-action",
    toolId: "outcome-submit",
    schemaId: release.spec.intentDescriptors[0].resultSchema.id,
    schemaVersionId: release.spec.intentDescriptors[0].resultSchema.version,
    artifactBytes: Uint8Array.from(bytes),
    artifactDigest: hex(bytes),
  },
  { ...identity(request), type: "settled", settlement: "resolved" },
];

async function drive(
  request: PromptRequest,
  bridge: PiHarnessBridge,
  frames: readonly ChildToParentMessage[],
) {
  const emitted: ChildToParentMessage[] = [];
  const runtime = new PiChildRuntime(
    async () => new DeterministicSessionDriver(frames),
    (frame) => emitted.push(frame),
  );
  runtime.childReady("deterministic-child");
  await runtime.handle(request);
  for (const frame of emitted)
    if (frame.type !== "ready") await bridge.handle(frame);
}

const cleanupEvidence = {
  ipcDrained: true,
  stdoutDrained: true,
  stderrDrained: true,
  wholeTreeReaped: true,
  grantRevoked: true,
};

test("fake and Pi releases differ in identity but produce parity facts/outcome", async () => {
  const fake = await setup("fake");
  const pi = await setup("pi-sdk");
  try {
    assert.notEqual(fake.release.releaseId, pi.release.releaseId);
    assert.deepEqual([...fake.expected.bytes], [...pi.expected.bytes]);
    await drive(
      fake.request,
      fake.bridge,
      happyFrames(fake.release, fake.request, fake.expected.bytes),
    );
    await drive(
      pi.request,
      pi.bridge,
      happyFrames(pi.release, pi.request, pi.expected.bytes),
    );
    assert.deepEqual(fake.bridge.cleanup(cleanupEvidence), {
      ok: true,
      value: { cause: "succeeded" },
    });
    assert.deepEqual(pi.bridge.cleanup(cleanupEvidence), {
      ok: true,
      value: { cause: "succeeded" },
    });
    assert.equal(
      value(fake.runtime.control.snapshot(fake.runId)).state,
      "completed",
    );
    assert.equal(
      value(pi.runtime.control.snapshot(pi.runId)).state,
      "completed",
    );
    const facts = (runtime: typeof fake.runtime, runId: string) =>
      value(runtime.control.sourceFacts())
        .filter(({ aggregateId }) => aggregateId === runId)
        .map(({ factKind }) => factKind);
    assert.deepEqual(
      facts(fake.runtime, fake.runId),
      facts(pi.runtime, pi.runId),
    );
  } finally {
    await fake.close();
    await pi.close();
  }
});

test("settled without outcome, forged and plausible-wrong artifacts end failed", async () => {
  for (const variant of [
    "missing",
    "forged",
    "plausible-wrong",
    "conflicting",
  ] as const) {
    const fixture = await setup("pi-sdk");
    try {
      const frames = happyFrames(
        fixture.release,
        fixture.request,
        fixture.expected.bytes,
      );
      if (variant === "missing") frames.splice(3, 1);
      if (variant === "forged") {
        const artifact = frames[3] as Extract<
          ChildToParentMessage,
          { type: "outcome-artifact" }
        >;
        frames[3] = { ...artifact, artifactDigest: "0".repeat(64) };
      }
      if (variant === "plausible-wrong") {
        const wrongBytes = Buffer.from(
          '{"schemaVersion":"heartbeat-artifact-v1","heartbeat":"ok"}',
        );
        const artifact = frames[3] as Extract<
          ChildToParentMessage,
          { type: "outcome-artifact" }
        >;
        frames[3] = {
          ...artifact,
          artifactBytes: wrongBytes,
          artifactDigest: hex(wrongBytes),
        };
      }
      if (variant === "conflicting") {
        const wrongBytes = Buffer.from("different-second-artifact");
        const artifact = frames[3] as Extract<
          ChildToParentMessage,
          { type: "outcome-artifact" }
        >;
        frames.splice(4, 0, {
          ...artifact,
          artifactBytes: wrongBytes,
          artifactDigest: hex(wrongBytes),
        });
      }
      await drive(fixture.request, fixture.bridge, frames);
      assert.deepEqual(fixture.bridge.cleanup(cleanupEvidence), {
        ok: true,
        value: { cause: "failed" },
      });
      assert.equal(
        value(fixture.runtime.control.snapshot(fixture.runId)).state,
        "failed",
        variant,
      );
    } finally {
      await fixture.close();
    }
  }
});

test("fixture EffectIntent uses real Gateway unknown once and duplicate frame does not redispatch", async () => {
  const fixture = await setup("pi-sdk");
  try {
    const frames: ChildToParentMessage[] = [
      { ...identity(fixture.request), type: "prompt-accepted" },
      {
        ...identity(fixture.request),
        type: "sanitized-action-or-tool-event",
        eventKind: "action",
        actionId: "effect-action",
        toolId: null,
        payloadDigest: hex("effect-input"),
      },
      {
        ...identity(fixture.request),
        type: "fixture-effect-intent",
        actionId: "effect-action",
        operation: "fixture.disposable",
        intentKey: "fixture-once",
        intentGeneration: 1,
        payloadDigest: hex("effect-payload"),
      },
      { ...identity(fixture.request), type: "settled", settlement: "resolved" },
    ];
    await drive(fixture.request, fixture.bridge, frames);
    const duplicate = frames[2];
    await fixture.bridge.handle(duplicate);
    const facts = value(fixture.runtime.control.sourceFacts());
    assert.equal(
      facts.filter(({ factKind }) => factKind === "effect-dispatch-started")
        .length,
      1,
    );
    assert.equal(
      Object.values(
        value(fixture.runtime.control.snapshot(fixture.runId)).effects,
      )[0],
      "unknown",
    );
  } finally {
    await fixture.close();
  }
});

test("ambiguous prompt acceptance fails once; terminal ignores all late child frames", async () => {
  const fixture = await setup("pi-sdk");
  try {
    // Prompt was sent by bridge constructor, but IPC dies before accepted.
    fixture.bridge.processExitOrFault(false);
    fixture.bridge.closeIpc();
    assert.deepEqual(fixture.bridge.cleanup(cleanupEvidence), {
      ok: true,
      value: { cause: "failed" },
    });
    assert.equal(
      value(fixture.runtime.control.snapshot(fixture.runId)).state,
      "failed",
    );
    const before = value(fixture.runtime.control.sourceFacts()).length;
    const late = happyFrames(
      fixture.release,
      fixture.request,
      fixture.expected.bytes,
    )[1];
    assert.deepEqual(await fixture.bridge.handle(late), {
      ok: true,
      value: null,
    });
    assert.equal(value(fixture.runtime.control.sourceFacts()).length, before);
  } finally {
    await fixture.close();
  }
});

test("cleanup Attempt commit and terminalization are separate restart-safe transactions", async () => {
  const fixture = await setup("pi-sdk");
  try {
    await drive(
      fixture.request,
      fixture.bridge,
      happyFrames(fixture.release, fixture.request, fixture.expected.bytes),
    );
    assert.deepEqual(fixture.bridge.cleanup(cleanupEvidence, false), {
      ok: true,
      value: { cause: "succeeded" },
    });
    assert.equal(
      value(fixture.runtime.control.snapshot(fixture.runId)).attemptState,
      "succeeded",
    );
    assert.equal(
      value(fixture.runtime.control.snapshot(fixture.runId)).state,
      "running",
    );
    const state = "completed" as const;
    value(
      fixture.runtime.control.terminalize(
        commandMeta("actor", "terminalize", fixture.runId, "restart-terminal", {
          state,
        }),
        { runId: fixture.runId, state },
      ),
    );
    assert.equal(
      value(fixture.runtime.control.snapshot(fixture.runId)).state,
      "completed",
    );
  } finally {
    await fixture.close();
  }
});
