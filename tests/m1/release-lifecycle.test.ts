import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  compileRelease,
  verifyRelease,
  type AgentSpec,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createTrustedProcessController,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const digest = "a".repeat(64);
const spec: AgentSpec = {
  agentId: "agent-heartbeat",
  goal: "emit one heartbeat artifact",
  harnessKind: "fake",
  checkpointSchema: "heartbeat-checkpoint-v1",
  capabilities: ["tool.read", "artifact.write"],
  effectOperations: ["fixture.commit"],
};
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const meta = (
  kind: string,
  target: string,
  key: string,
  input: unknown,
  precondition: unknown = null,
) => commandMeta("m1-test", kind, target, key, input, precondition);

const closure: ExecutionClosure = {
  entryId: "heartbeat-child",
  executable: process.execPath,
  executableDigest: digest,
  members: [
    { id: "child", digest },
    { id: "contracts", digest: "b".repeat(64) },
  ],
};

test("release compilation is canonical and deeply immutable", () => {
  const release = compileRelease(spec, closure);
  const reordered = compileRelease(
    {
      ...spec,
      capabilities: [...spec.capabilities].reverse(),
      effectOperations: [...spec.effectOperations].reverse(),
    },
    { ...closure, members: [...closure.members].reverse() },
  );
  assert.equal(release.releaseId, reordered.releaseId);
  assert.equal(verifyRelease(release), true);
  assert.equal(Object.isFrozen(release), true);
  assert.equal(Object.isFrozen(release.spec.capabilities), true);
  assert.throws(
    () => (release.spec.capabilities as string[]).push("tool.write"),
    TypeError,
  );
  assert.deepEqual(release.trustedDirectEffects, []);
});

test("release compiler rejects drift and non-contract fields", () => {
  const release = compileRelease(spec, closure);
  assert.equal(verifyRelease({ ...release, releaseId: "0".repeat(64) }), false);
  assert.equal(
    // @ts-expect-error exercises runtime release-version validation.
    verifyRelease({ ...release, schemaVersion: "forged-release" }),
    false,
  );
  assert.equal(
    // @ts-expect-error exercises runtime direct-Effect rejection.
    verifyRelease({ ...release, trustedDirectEffects: ["mutation"] }),
    false,
  );
  assert.throws(
    () =>
      compileRelease({ ...spec, mutableWorkspace: {} } as AgentSpec, closure),
    /invalid_agent_spec/,
  );
  assert.throws(
    () => canonicalJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 }),
    /invalid_number/,
  );
});

test("Control admission cannot forge an unregistered process exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m1-lifecycle-"));
  const authority = new RecoveryAuthority(join(directory, "authority.sqlite"));
  const fence = value(
    authority.initialize("database-lifecycle", "target-source"),
  );
  const store = openSqliteControl(join(directory, "control.sqlite"), {
    authorityPath: join(directory, "authority.sqlite"),
    fence,
  });
  try {
    const control = store.control;
    const release = compileRelease(spec, closure);
    assert.deepEqual(control.publish(null as never, release), {
      ok: false,
      error: "invalid_input",
    });
    const publishMeta = meta(
      "publish-release",
      release.releaseId,
      "publish",
      release,
    );
    assert.deepEqual(
      control.publish(
        { ...publishMeta, payloadDigest: "0".repeat(64) },
        release,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(value(control.sourceFacts()).length, 0);
    value(control.publish(publishMeta, release));
    assert.deepEqual(
      control.resume(null as never, { runId: "missing", checkpointId: "none" }),
      { ok: false, error: "invalid_input" },
    );
    const cyclicResume = {
      runId: "missing",
      checkpointId: "none",
    } as { runId: string; checkpointId: string; cycle?: unknown };
    cyclicResume.cycle = cyclicResume;
    assert.deepEqual(
      control.resume(
        commandMeta("m1-lifecycle-test", "resume", "missing", "cyclic-resume", {
          runId: "missing",
          checkpointId: "none",
        }),
        cyclicResume,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.publish(
        commandMeta(
          "",
          "publish-release",
          release.releaseId,
          "empty-actor",
          release,
        ),
        release,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.publish(
        commandMeta(
          "m1-lifecycle-test",
          "publish-release",
          release.releaseId,
          "",
          release,
        ),
        release,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.activate(
        meta("activate", "different-agent", "wrong-agent", { epoch: 1 }),
        {
          agentId: "different-agent",
          releaseId: release.releaseId,
          epoch: 1,
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    const activationInput = {
      agentId: spec.agentId,
      releaseId: release.releaseId,
      epoch: 1,
    };
    assert.deepEqual(control.activate(null as never, activationInput), {
      ok: false,
      error: "invalid_input",
    });
    assert.deepEqual(
      control.activate(
        commandMeta(
          "m1-lifecycle-test",
          "activate",
          spec.agentId,
          "malformed-activation",
          { ...activationInput, epoch: "1" },
          { expectedCurrentEpoch: null },
        ),
        { ...activationInput, epoch: "1" } as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.activate(
        commandMeta(
          "m1-lifecycle-test",
          "activate",
          spec.agentId,
          "extra-activation-field",
          { ...activationInput, extra: true },
          { expectedCurrentEpoch: null },
        ),
        { ...activationInput, extra: true } as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(value(control.sourceFacts()).length, 1);
    const activationMeta = commandMeta(
      "m1-lifecycle-test",
      "activate",
      spec.agentId,
      "activate",
      activationInput,
      { expectedCurrentEpoch: null },
    );
    const accessorActivation = Object.defineProperties(
      {},
      {
        agentId: { enumerable: true, value: spec.agentId },
        releaseId: { enumerable: true, value: release.releaseId },
        epoch: { enumerable: true, get: () => 1 },
      },
    );
    assert.deepEqual(
      control.activate(activationMeta, accessorActivation as never),
      { ok: false, error: "invalid_input" },
    );
    const accessorPrecondition = Object.defineProperty(
      {},
      "expectedCurrentEpoch",
      { enumerable: true, get: () => null },
    );
    assert.deepEqual(
      control.activate(
        { ...activationMeta, precondition: accessorPrecondition as never },
        activationInput,
      ),
      { ok: false, error: "invalid_input" },
    );
    let metadataGetterRuns = 0;
    const throwingMeta = Object.defineProperty(
      { ...activationMeta },
      "commandKind",
      {
        enumerable: true,
        get: () => {
          metadataGetterRuns += 1;
          throw new Error("getter_ran");
        },
      },
    );
    assert.deepEqual(control.activate(throwingMeta, activationInput), {
      ok: false,
      error: "invalid_input",
    });
    assert.equal(metadataGetterRuns, 0);
    assert.deepEqual(
      control.activate(new Proxy(activationMeta, {}), activationInput),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.activate(
        { ...activationMeta, payloadDigest: "0".repeat(64) },
        activationInput,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.activate(
        { ...activationMeta, precondition: { expectedCurrentEpoch: 0 } },
        activationInput,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.activate(Object.create(activationMeta) as never, activationInput),
      { ok: false, error: "invalid_input" },
    );
    value(control.activate(activationMeta, activationInput));
    assert.deepEqual(
      control.activate(
        commandMeta(
          "m1-lifecycle-test",
          "activate",
          spec.agentId,
          "activate",
          activationInput,
          { expectedCurrentEpoch: 0 },
        ),
        activationInput,
      ),
      { ok: false, error: "idempotency_conflict" },
    );
    assert.deepEqual(
      control.activate(
        commandMeta(
          "m1-lifecycle-test",
          "activate",
          spec.agentId,
          "activate",
          { agentId: spec.agentId, releaseId: release.releaseId, epoch: 2 },
          { expectedCurrentEpoch: null },
        ),
        { agentId: spec.agentId, releaseId: release.releaseId, epoch: 2 },
      ),
      { ok: false, error: "idempotency_conflict" },
    );
    const admissionInput = {
      runId: "run-lifecycle",
      agentId: spec.agentId,
      releaseId: release.releaseId,
      activationEpoch: 1,
    };
    assert.deepEqual(
      control.admit(
        meta(
          "admit",
          admissionInput.runId,
          "malformed-admission",
          {},
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        { ...admissionInput, activationEpoch: "1" } as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.admit(
        meta(
          "admit",
          "",
          "empty-run",
          {},
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        { ...admissionInput, runId: "" },
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(value(control.sourceFacts()).length, 2);
    assert.deepEqual(control.admit(null as never, admissionInput), {
      ok: false,
      error: "invalid_input",
    });
    const admissionMeta = meta(
      "admit",
      "run-lifecycle",
      "admit",
      admissionInput,
      { releaseId: release.releaseId, activationEpoch: 1 },
    );
    assert.deepEqual(
      control.admit(
        { ...admissionMeta, payloadDigest: "0".repeat(64) },
        admissionInput,
      ),
      { ok: false, error: "invalid_input" },
    );
    const token = value(control.admit(admissionMeta, admissionInput));
    assert.deepEqual(
      control.admit(
        meta("admit", "run-lifecycle", "admit", admissionInput, {
          releaseId: release.releaseId,
          activationEpoch: 0,
        }),
        admissionInput,
      ),
      { ok: false, error: "idempotency_conflict" },
    );
    assert.equal(token.attempt, 0);
    const cyclicHarnessInput = { type: "action" } as {
      type: "action";
      action?: unknown;
    };
    cyclicHarnessInput.action = cyclicHarnessInput;
    assert.deepEqual(
      control
        .harness(token)
        .submit(
          meta("register-action", token.runId, "cyclic-action", {}),
          cyclicHarnessInput as never,
        ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.harness(token).submit(
        meta(
          "outcome-proposal",
          token.runId,
          "unknown-union",
          {
            type: "future-output",
            proposal: { artifactDigest: digest },
          } as never,
          token,
        ),
        {
          type: "future-output",
          proposal: { artifactDigest: digest },
        } as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(value(control.sourceFacts()).length, 3);
    const subagentInput = {
      type: "action" as const,
      action: {
        actionId: "subagent-action",
        kind: "subagent" as const,
        inputDigest: digest,
      },
    };
    const subagentMeta = meta(
      "register-action",
      token.runId,
      "subagent-action",
      subagentInput,
      token,
    );
    assert.deepEqual(
      control
        .harness(token)
        .submit(
          { ...subagentMeta, payloadDigest: "0".repeat(64) },
          subagentInput,
        ),
      { ok: false, error: "invalid_input" },
    );
    value(control.harness(token).submit(subagentMeta, subagentInput));
    assert.deepEqual(
      control.harness(token).submit(
        meta(
          "tool-observation",
          token.runId,
          "forged-tool-observation",
          {
            type: "tool-observation",
            observation: {
              actionId: "subagent-action",
              toolId: "tool.read",
              outputDigest: digest,
              grantGeneration: token.generation,
            },
          },
          token,
        ),
        {
          type: "tool-observation",
          observation: {
            actionId: "subagent-action",
            toolId: "tool.read",
            outputDigest: digest,
            grantGeneration: token.generation,
          },
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    value(
      control.harness(token).submit(
        meta(
          "outcome-proposal",
          token.runId,
          "proposal",
          {
            type: "outcome-proposal",
            proposal: { artifactDigest: digest },
          },
          token,
        ),
        {
          type: "outcome-proposal",
          proposal: { artifactDigest: digest },
        },
      ),
    );
    assert.equal(
      value(control.snapshot(token.runId)).outcomeArtifactDigest,
      undefined,
    );
    assert.deepEqual(
      store.outcomes.accept(
        meta("accept-outcome", token.runId, "extra-outcome", {
          runId: token.runId,
          attempt: token.attempt,
          artifactDigest: digest,
          extra: true,
        } as never),
        {
          runId: token.runId,
          attempt: token.attempt,
          artifactDigest: digest,
          extra: true,
        } as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.recordOutcomeAcceptance(
        Symbol("forged-outcome-owner"),
        meta("accept-outcome", token.runId, "untrusted-accept", {}),
        { runId: token.runId, attempt: token.attempt, artifactDigest: digest },
      ),
      { ok: false, error: "invalid_input" },
    );
    const processController = createTrustedProcessController(control);
    assert.deepEqual(
      processController.technicalExit(
        meta(
          "technical-exit",
          token.runId,
          "null-exit",
          { exitCode: null as never },
          token,
        ),
        token,
        null as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      processController.technicalExit(
        meta("technical-exit", token.runId, "exit", { exitCode: 0 }, token),
        token,
        0,
      ),
      { ok: false, error: "invalid_state" },
    );
    const run = value(control.snapshot(token.runId));
    assert.equal(run.state, "running");
    assert.equal(run.attemptState, "running");
    assert.deepEqual(
      control.terminalize(
        meta("terminalize", token.runId, "complete", { state: "completed" }),
        { runId: token.runId, state: "completed" },
      ),
      { ok: false, error: "invalid_state" },
    );
    assert.equal(value(control.sourceFacts()).length, 5);
  } finally {
    store.close();
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
