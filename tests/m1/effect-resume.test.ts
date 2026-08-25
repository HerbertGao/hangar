import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileRelease,
  digestJson,
  type AttemptToken,
  type ProcessIdentity,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
  createTrustedProcessController,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
  type SQLiteControlRuntime,
} from "../../packages/control-store-sqlite/index.ts";
import {
  executeHeartbeat,
  heartbeatExecutionClosure,
  heartbeatOutcomeGate,
} from "../../apps/heartbeat/index.ts";

const worker = join(process.cwd(), "tests/m1/worker.ts");
const fixtureDigest = (id: string): string => digestJson({ fixture: id });
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const meta = (
  kind: string,
  runId: string,
  key: string,
  input: unknown,
  token?: AttemptToken,
  precondition: unknown = null,
) =>
  commandMeta("m1-effect-test", kind, runId, key, input, token ?? precondition);

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: string | null }> =>
  new Promise((resolve) => {
    child.on("exit", (code, signal) =>
      resolve({
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
      }),
    );
    child.on("error", () => resolve({ code: 1, signal: null }));
  });

test("ambiguous Effect is never redispatched and resume fences the old session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m1-effect-"));
  const authorityPath = join(directory, "authority.sqlite");
  const databasePath = join(directory, "control.sqlite");
  const externalMarker = join(directory, "external-commit.txt");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(authority.initialize("database-effect", "target-source"));
  let store: SQLiteControlRuntime | undefined = openSqliteControl(
    databasePath,
    { authorityPath, fence },
    { outcomeGate: heartbeatOutcomeGate },
  );
  try {
    let control = store.control;
    let processOwner = createTrustedProcessController(control);
    const release = compileRelease(
      {
        agentId: "agent-effect",
        goal: "resume after one external effect",
        harnessKind: "fake",
        checkpointSchema: "checkpoint-v1",
        capabilities: ["tool.read"],
        effectOperations: ["fixture.commit"],
        intentDescriptors: [],
      },
      heartbeatExecutionClosure(),
    );
    value(
      control.publish(
        meta("publish-release", release.releaseId, "publish", release),
        release,
      ),
    );
    value(
      control.activate(
        meta(
          "activate",
          release.spec.agentId,
          "activate",
          {
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            epoch: 1,
          },
          undefined,
          { expectedCurrentEpoch: null },
        ),
        {
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          epoch: 1,
        },
      ),
    );
    const token0 = value(
      control.admit(
        meta(
          "admit",
          "run-effect",
          "admit",
          {
            runId: "run-effect",
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            activationEpoch: 1,
          },
          undefined,
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        {
          runId: "run-effect",
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          activationEpoch: 1,
        },
      ),
    );
    const approval = {
      decision: "approved" as const,
      releaseId: release.releaseId,
      activationEpoch: 1,
      expiresAtUnixMs: Date.now() + 600_000,
    };
    const session0 = control.harness(token0);
    value(
      session0.submit(
        meta(
          "register-action",
          token0.runId,
          "action",
          {
            type: "action",
            action: {
              actionId: "effect-action",
              kind: "tool",
              inputDigest: fixtureDigest("initial-action"),
            },
          },
          token0,
        ),
        {
          type: "action",
          action: {
            actionId: "effect-action",
            kind: "tool",
            inputDigest: fixtureDigest("initial-action"),
          },
        },
      ),
    );
    const initialEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "effect-action",
        intentKey: "commit",
        intentGeneration: 0,
        operation: "fixture.commit",
        payloadDigest: fixtureDigest("initial-effect"),
      },
    };
    const effect1 = value(
      session0.submit(
        meta("effect-intent", token0.runId, "intent", initialEffect, token0),
        initialEffect,
      ),
    ).effectId;
    const unapprovedGateway = createEffectGateway(control);
    let unapprovedCalls = 0;
    assert.deepEqual(
      await unapprovedGateway.dispatch(
        {
          start: meta(
            "dispatch-effect",
            token0.runId,
            "unapproved",
            { runId: token0.runId, effectId: effect1 },
            token0,
          ),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "unapproved-outcome",
            { runId: token0.runId, effectId: effect1 },
            token0,
          ),
          unknown: meta(
            "mark-effect-unknown",
            token0.runId,
            "unapproved-unknown",
            { runId: token0.runId, effectId: effect1 },
            token0,
          ),
        },
        token0.runId,
        effect1,
        async () => {
          unapprovedCalls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "invalid_state" },
    );
    assert.equal(unapprovedCalls, 0);
    assert.deepEqual(
      session0.submit(
        meta(
          "effect-intent",
          token0.runId,
          "duplicate-intent",
          initialEffect,
          token0,
        ),
        initialEffect,
      ),
      { ok: true, value: { effectId: effect1 } },
    );
    value(
      session0.submit(
        meta(
          "checkpoint",
          token0.runId,
          "checkpoint",
          {
            type: "checkpoint",
            checkpoint: {
              checkpointId: "checkpoint-1",
              producerActionId: "effect-action",
              schema: "checkpoint-v1",
              artifactDigest: fixtureDigest("checkpoint"),
              obligationOwner: "effect-gateway",
              obligationGeneration: 0,
              effectId: effect1,
            },
          },
          token0,
        ),
        {
          type: "checkpoint",
          checkpoint: {
            checkpointId: "checkpoint-1",
            producerActionId: "effect-action",
            schema: "checkpoint-v1",
            artifactDigest: fixtureDigest("checkpoint"),
            obligationOwner: "effect-gateway",
            obligationGeneration: 0,
            effectId: effect1,
          },
        },
      ),
    );
    const checkpointFactCount = value(control.sourceFacts()).length;
    assert.deepEqual(
      session0.submit(
        meta(
          "checkpoint",
          token0.runId,
          "checkpoint-rebind",
          {
            type: "checkpoint",
            checkpoint: {
              checkpointId: "checkpoint-1",
              producerActionId: "effect-action",
              schema: "checkpoint-v1",
              artifactDigest: fixtureDigest("different-checkpoint"),
              obligationOwner: "effect-gateway",
              obligationGeneration: 0,
              effectId: effect1,
            },
          },
          token0,
        ),
        {
          type: "checkpoint",
          checkpoint: {
            checkpointId: "checkpoint-1",
            producerActionId: "effect-action",
            schema: "checkpoint-v1",
            artifactDigest: fixtureDigest("different-checkpoint"),
            obligationOwner: "effect-gateway",
            obligationGeneration: 0,
            effectId: effect1,
          },
        },
      ),
      { ok: false, error: "idempotency_conflict" },
    );
    assert.equal(value(control.sourceFacts()).length, checkpointFactCount);
    let gateway = unapprovedGateway;
    const expiredApproval = { ...approval, expiresAtUnixMs: Date.now() - 1 };
    assert.deepEqual(
      gateway.approve(
        meta(
          "approve-effect",
          token0.runId,
          "expired-approval",
          {
            runId: token0.runId,
            effectId: effect1,
            approval: expiredApproval,
          },
          token0,
        ),
        token0.runId,
        effect1,
        expiredApproval,
      ),
      { ok: false, error: "invalid_state" },
    );
    const approvalMeta = meta(
      "approve-effect",
      token0.runId,
      "approve-effect-1",
      { runId: token0.runId, effectId: effect1, approval },
      token0,
    );
    assert.deepEqual(
      gateway.approve(
        { ...approvalMeta, payloadDigest: "0".repeat(64) },
        token0.runId,
        effect1,
        approval,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      gateway.approve(
        { ...approvalMeta, preconditionDigest: "0".repeat(64) },
        token0.runId,
        effect1,
        approval,
      ),
      { ok: false, error: "invalid_input" },
    );
    value(gateway.approve(approvalMeta, token0.runId, effect1, approval));
    assert.deepEqual(
      gateway.approve(
        meta(
          "approve-effect",
          token0.runId,
          "duplicate-approval",
          { runId: token0.runId, effectId: effect1, approval: approval },
          token0,
        ),
        token0.runId,
        effect1,
        approval,
      ),
      { ok: false, error: "invalid_state" },
    );
    const approvalFact = value(control.sourceFacts()).find(
      ({ factKind }) => factKind === "effect-approved",
    );
    const approvalBinding = approvalFact?.payload.approval as
      | {
          actorSubjectId?: unknown;
          releaseId?: unknown;
          activationEpoch?: unknown;
        }
      | undefined;
    assert.equal(approvalBinding?.actorSubjectId, "m1-effect-test");
    assert.equal(approvalBinding?.releaseId, release.releaseId);
    assert.equal(approvalBinding?.activationEpoch, 1);

    const child = spawn(
      process.execPath,
      [
        worker,
        "effect-crash",
        databasePath,
        authorityPath,
        fence.databaseIdentity,
        fence.targetId,
        token0.runId,
        effect1,
        externalMarker,
      ],
      {
        detached: true,
        cwd: process.cwd(),
        env: {},
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    if (!child.pid) throw new Error("spawn_failed");
    const processIdentity: ProcessIdentity = {
      pid: child.pid,
      processGroupId: child.pid,
      startFingerprint: `worker:${child.pid}`,
      containmentGeneration: 1,
    };
    value(
      processOwner.register(
        meta(
          "register-process",
          token0.runId,
          "process",
          processIdentity,
          token0,
        ),
        token0,
        processIdentity,
      ),
    );
    store.close();
    store = undefined;
    const exited = waitForExit(child);
    child.stdin?.write("GO\n");
    child.stdin?.end();
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    assert.equal(await readFile(externalMarker, "utf8"), "committed\n");

    store = openSqliteControl(
      databasePath,
      { authorityPath, fence },
      { outcomeGate: heartbeatOutcomeGate },
    );
    control = store.control;
    processOwner = createTrustedProcessController(control);
    let run = value(control.snapshot(token0.runId));
    assert.equal(run.effects[effect1], "dispatch-started");
    gateway = createEffectGateway(control);
    value(
      gateway.recoverUnknown(
        meta("mark-effect-unknown", token0.runId, "recover-unknown", {
          runId: token0.runId,
          effectId: effect1,
        }),
        token0.runId,
        effect1,
      ),
    );
    let redispatches = 0;
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token0.runId, "redispatch", {
            runId: token0.runId,
            effectId: effect1,
          }),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "redispatch-outcome",
            { runId: token0.runId, effectId: effect1 },
          ),
          unknown: meta(
            "mark-effect-unknown",
            token0.runId,
            "redispatch-unknown",
            { runId: token0.runId, effectId: effect1 },
          ),
        },
        token0.runId,
        effect1,
        async () => {
          redispatches += 1;
          return "committed";
        },
      ),
      { ok: false, error: "invalid_state" },
    );
    assert.equal(redispatches, 0);
    assert.deepEqual(
      gateway.reconcile(
        meta("reconcile-effect", token0.runId, "invalid-reconcile", {
          runId: token0.runId,
          effectId: effect1,
          outcome: "pending",
        }),
        token0.runId,
        effect1,
        // @ts-expect-error exercises runtime outcome validation.
        "pending",
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      (await readFile(externalMarker, "utf8")).trim().split("\n"),
      ["committed"],
    );
    value(
      gateway.reconcile(
        meta("reconcile-effect", token0.runId, "reconcile", {
          runId: token0.runId,
          effectId: effect1,
          outcome: "committed",
        }),
        token0.runId,
        effect1,
        "committed",
      ),
    );
    const secondEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "effect-action",
        intentKey: "commit-2",
        intentGeneration: 0,
        operation: "fixture.commit",
        payloadDigest: fixtureDigest("second-effect"),
      },
    };
    const effect2 = value(
      control
        .harness(token0)
        .submit(
          meta("effect-intent", token0.runId, "intent-2", secondEffect, token0),
          secondEffect,
        ),
    ).effectId;
    value(
      gateway.approve(
        meta(
          "approve-effect",
          token0.runId,
          "approve-effect-2",
          { runId: token0.runId, effectId: effect2, approval: approval },
          token0,
        ),
        token0.runId,
        effect2,
        approval,
      ),
    );
    let nullMetadataCalls = 0;
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token0.runId, "null-meta-start", {
            runId: token0.runId,
            effectId: effect2,
          }),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "null-meta-outcome",
            { runId: token0.runId, effectId: effect2 },
          ),
          unknown: null as never,
        },
        token0.runId,
        effect2,
        async () => {
          nullMetadataCalls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(nullMetadataCalls, 0);
    let wrongEffectCalls = 0;
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: commandMeta(
            "m1-effect-worker",
            "dispatch-effect",
            token0.runId,
            "dispatch",
            { runId: token0.runId, effectId: effect1 },
          ),
          outcome: meta("record-effect-outcome", token0.runId, "o2", {
            runId: token0.runId,
            effectId: effect2,
          }),
          unknown: meta("mark-effect-unknown", token0.runId, "u2", {
            runId: token0.runId,
            effectId: effect2,
          }),
        },
        token0.runId,
        effect2,
        async () => {
          wrongEffectCalls += 1;
          await appendFile(externalMarker, "unexpected\n");
          return "committed";
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(wrongEffectCalls, 0);
    let secondEffectCalls = 0;
    value(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token0.runId, "effect-2-dispatch", {
            runId: token0.runId,
            effectId: effect2,
          }),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "effect-2-outcome",
            { runId: token0.runId, effectId: effect2 },
          ),
          unknown: meta(
            "mark-effect-unknown",
            token0.runId,
            "effect-2-unknown",
            { runId: token0.runId, effectId: effect2 },
          ),
        },
        token0.runId,
        effect2,
        async () => {
          secondEffectCalls += 1;
          return "not-committed";
        },
      ),
    );
    assert.equal(secondEffectCalls, 1);
    assert.deepEqual(
      (await readFile(externalMarker, "utf8")).trim().split("\n"),
      ["committed"],
    );
    const thirdEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "effect-action",
        intentKey: "commit-3",
        intentGeneration: 0,
        operation: "fixture.commit",
        payloadDigest: fixtureDigest("third-effect"),
      },
    };
    const effect3 = value(
      control
        .harness(token0)
        .submit(
          meta("effect-intent", token0.runId, "intent-3", thirdEffect, token0),
          thirdEffect,
        ),
    ).effectId;
    value(
      gateway.approve(
        meta(
          "approve-effect",
          token0.runId,
          "approve-effect-3",
          { runId: token0.runId, effectId: effect3, approval: approval },
          token0,
        ),
        token0.runId,
        effect3,
        approval,
      ),
    );
    value(
      processOwner.technicalExit(
        meta("technical-exit", token0.runId, "exit-0", { exitCode: 0 }, token0),
        token0,
        0,
      ),
    );
    value(
      processOwner.reaped(
        meta(
          "reap-containment",
          token0.runId,
          "reap-0",
          { factKind: "containment-reaped" },
          token0,
        ),
        token0,
      ),
    );
    value(
      processOwner.revoke(
        meta(
          "revoke-grant",
          token0.runId,
          "revoke-0",
          { factKind: "grant-revoked" },
          token0,
        ),
        token0,
      ),
    );
    const forgedToken = { ...token0, sessionId: "forged-session" };
    assert.deepEqual(
      control.quiesce(
        meta("quiesce", token0.runId, "null-checkpoint", {
          checkpointId: null,
        }),
        token0,
        null as never,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.quiesce(
        meta("quiesce", token0.runId, "forged-quiesce", {
          checkpointId: "checkpoint-1",
        }),
        forgedToken,
        "checkpoint-1",
      ),
      { ok: false, error: "stale_attempt" },
    );
    assert.deepEqual(
      control.quiesce(
        meta("quiesce", token0.runId, "pending-effect-quiesce", {
          checkpointId: "checkpoint-1",
        }),
        token0,
        "checkpoint-1",
      ),
      { ok: false, error: "invalid_state" },
    );
    let invalidOutcomeCalls = 0;
    const invalidConnector = async (): Promise<
      "committed" | "not-committed"
    > => {
      invalidOutcomeCalls += 1;
      return "pending" as never;
    };
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token0.runId, "effect-3-dispatch", {
            runId: token0.runId,
            effectId: effect3,
          }),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "effect-3-outcome",
            { runId: token0.runId, effectId: effect3 },
          ),
          unknown: meta(
            "mark-effect-unknown",
            token0.runId,
            "effect-3-unknown",
            { runId: token0.runId, effectId: effect3 },
          ),
        },
        token0.runId,
        effect3,
        invalidConnector,
      ),
      { ok: false, error: "unknown_effect" },
    );
    assert.equal(invalidOutcomeCalls, 1);
    let invalidOutcomeRedispatches = 0;
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token0.runId, "effect-3-retry", {
            runId: token0.runId,
            effectId: effect3,
          }),
          outcome: meta(
            "record-effect-outcome",
            token0.runId,
            "effect-3-retry-outcome",
            { runId: token0.runId, effectId: effect3 },
          ),
          unknown: meta(
            "mark-effect-unknown",
            token0.runId,
            "effect-3-retry-unknown",
            { runId: token0.runId, effectId: effect3 },
          ),
        },
        token0.runId,
        effect3,
        async () => {
          invalidOutcomeRedispatches += 1;
          return "not-committed";
        },
      ),
      { ok: false, error: "invalid_state" },
    );
    assert.equal(invalidOutcomeRedispatches, 0);
    value(
      gateway.reconcile(
        meta("reconcile-effect", token0.runId, "effect-3-reconcile", {
          runId: token0.runId,
          effectId: effect3,
          outcome: "not-committed",
        }),
        token0.runId,
        effect3,
        "not-committed",
      ),
    );
    value(
      control.quiesce(
        meta("quiesce", token0.runId, "quiesce", {
          checkpointId: "checkpoint-1",
        }),
        token0,
        "checkpoint-1",
      ),
    );
    const quiescence = value(control.sourceFacts()).find(
      ({ factKind }) => factKind === "attempt-quiesced",
    );
    assert.equal(quiescence?.payload.sessionId, token0.sessionId);
    assert.equal(quiescence?.payload.containmentGeneration, 1);
    assert.equal(quiescence?.payload.grantGeneration, token0.generation);
    assert.match(
      String(quiescence?.payload.obligationDigest),
      /^[0-9a-f]{64}$/,
    );
    assert.match(String(quiescence?.payload.fenceDigest), /^[0-9a-f]{64}$/);
    value(
      control.quiesce(
        meta(
          "quiesce",
          token0.runId,
          "quiesce-replay",
          { checkpointId: "checkpoint-1" },
          token0,
        ),
        token0,
        "checkpoint-1",
      ),
    );
    assert.equal(
      value(control.sourceFacts()).filter(
        ({ factKind }) => factKind === "attempt-quiesced",
      ).length,
      1,
    );
    const resumeInput = {
      runId: token0.runId,
      checkpointId: "checkpoint-1",
    };
    const resumeMeta = meta("resume", token0.runId, "resume", {
      checkpointId: "checkpoint-1",
    });
    const beforeResumeFacts = value(control.sourceFacts()).length;
    assert.deepEqual(
      control.resume(resumeMeta, { ...resumeInput, extra: true } as never),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.resume(
        { ...resumeMeta, payloadDigest: "0".repeat(64) },
        resumeInput,
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.equal(value(control.sourceFacts()).length, beforeResumeFacts);
    const token1 = value(control.resume(resumeMeta, resumeInput));
    assert.equal(token1.attempt, 1);
    assert.equal(
      value(control.sourceFacts()).filter(
        ({ factKind }) => factKind === "quiescence-consumed",
      ).length,
      1,
    );
    assert.deepEqual(
      control.harness(token0).submit(
        meta(
          "register-action",
          token0.runId,
          "late-action",
          {
            type: "action",
            action: {
              actionId: "late-action",
              kind: "tool",
              inputDigest: fixtureDigest("late-action"),
            },
          },
          token0,
        ),
        {
          type: "action",
          action: {
            actionId: "late-action",
            kind: "tool",
            inputDigest: fixtureDigest("late-action"),
          },
        },
      ),
      { ok: false, error: "stale_attempt" },
    );
    const predictedToken = {
      runId: token1.runId,
      attempt: token1.attempt,
      sessionId: `${token1.runId}:session:${token1.attempt}`,
      generation: token1.attempt + 1,
    };
    assert.deepEqual(
      control.harness(predictedToken).submit(
        meta(
          "register-action",
          token1.runId,
          "predicted-token",
          {
            type: "action",
            action: {
              actionId: "predicted-token-action",
              kind: "tool",
              inputDigest: fixtureDigest("predicted-token"),
            },
          },
          predictedToken,
        ),
        {
          type: "action",
          action: {
            actionId: "predicted-token-action",
            kind: "tool",
            inputDigest: fixtureDigest("predicted-token"),
          },
        },
      ),
      { ok: false, error: "stale_attempt" },
    );
    assert.deepEqual(
      control.harness(token1).submit(
        meta(
          "effect-intent",
          token1.runId,
          "cross-attempt-effect",
          {
            type: "effect-intent",
            effect: {
              actionId: "effect-action",
              intentKey: "cross-attempt",
              intentGeneration: 0,
              operation: "fixture.commit",
              payloadDigest: fixtureDigest("cross-attempt-effect"),
            },
          },
          token1,
        ),
        {
          type: "effect-intent",
          effect: {
            actionId: "effect-action",
            intentKey: "cross-attempt",
            intentGeneration: 0,
            operation: "fixture.commit",
            payloadDigest: fixtureDigest("cross-attempt-effect"),
          },
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    assert.deepEqual(
      control.harness(token1).submit(
        meta(
          "checkpoint",
          token1.runId,
          "cross-attempt-checkpoint",
          {
            type: "checkpoint",
            checkpoint: {
              checkpointId: "cross-attempt-checkpoint",
              producerActionId: "effect-action",
              schema: "checkpoint-v1",
              artifactDigest: fixtureDigest("cross-attempt-checkpoint"),
              obligationOwner: "effect-gateway",
              obligationGeneration: 0,
              effectId: effect1,
            },
          },
          token1,
        ),
        {
          type: "checkpoint",
          checkpoint: {
            checkpointId: "cross-attempt-checkpoint",
            producerActionId: "effect-action",
            schema: "checkpoint-v1",
            artifactDigest: fixtureDigest("cross-attempt-checkpoint"),
            obligationOwner: "effect-gateway",
            obligationGeneration: 0,
            effectId: effect1,
          },
        },
      ),
      { ok: false, error: "invalid_input" },
    );
    value(
      control.harness(token1).submit(
        meta(
          "register-action",
          token1.runId,
          "replay-action",
          {
            type: "action",
            action: {
              actionId: "replay-action",
              kind: "tool",
              inputDigest: fixtureDigest("replay-action"),
            },
          },
          token1,
        ),
        {
          type: "action",
          action: {
            actionId: "replay-action",
            kind: "tool",
            inputDigest: fixtureDigest("replay-action"),
          },
        },
      ),
    );
    const effectFactCount = value(control.sourceFacts()).filter(
      ({ factKind }) => factKind === "effect-intent",
    ).length;
    assert.equal(
      value(
        control.harness(token1).submit(
          meta(
            "effect-intent",
            token1.runId,
            "exact-effect-replay",
            {
              type: "effect-intent",
              effect: {
                actionId: "replay-action",
                intentKey: "commit",
                intentGeneration: 0,
                operation: "fixture.commit",
                payloadDigest: fixtureDigest("initial-effect"),
              },
            },
            token1,
          ),
          {
            type: "effect-intent",
            effect: {
              actionId: "replay-action",
              intentKey: "commit",
              intentGeneration: 0,
              operation: "fixture.commit",
              payloadDigest: fixtureDigest("initial-effect"),
            },
          },
        ),
      ).effectId,
      effect1,
    );
    assert.equal(
      value(control.sourceFacts()).filter(
        ({ factKind }) => factKind === "effect-intent",
      ).length,
      effectFactCount,
    );

    value(
      await executeHeartbeat(
        control,
        store!.outcomes,
        token1,
        "fake",
        fixtureDigest("resumed-heartbeat"),
      ),
    );
    const terminal = value(
      control.terminalize(
        meta("terminalize", token1.runId, "complete", { state: "completed" }),
        { runId: token1.runId, state: "completed" },
      ),
    );
    assert.equal(terminal.state, "completed");
    run = value(control.snapshot(token1.runId));
    assert.equal(run.currentAttempt, 1);
    assert.equal(run.effects[effect1], "committed");
    for (const factKind of [
      "effect-approved",
      "effect-claimed",
      "effect-dispatch-started",
    ])
      assert.equal(
        value(control.sourceFacts()).filter(
          (fact) =>
            fact.factKind === factKind && fact.payload.effectId === effect1,
        ).length,
        1,
      );

    const staleResumeToken = value(
      control.admit(
        meta(
          "admit",
          "run-stale-resume",
          "admit-stale-resume",
          {
            runId: "run-stale-resume",
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            activationEpoch: 1,
          },
          undefined,
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        {
          runId: "run-stale-resume",
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          activationEpoch: 1,
        },
      ),
    );
    const staleResumeSession = control.harness(staleResumeToken);
    value(
      staleResumeSession.submit(
        meta(
          "register-action",
          staleResumeToken.runId,
          "stale-resume-action",
          {
            type: "action",
            action: {
              actionId: "stale-resume-action",
              kind: "tool",
              inputDigest: fixtureDigest("stale-resume-action"),
            },
          },
          staleResumeToken,
        ),
        {
          type: "action",
          action: {
            actionId: "stale-resume-action",
            kind: "tool",
            inputDigest: fixtureDigest("stale-resume-action"),
          },
        },
      ),
    );
    value(
      staleResumeSession.submit(
        meta(
          "checkpoint",
          staleResumeToken.runId,
          "stale-resume-checkpoint",
          {
            type: "checkpoint",
            checkpoint: {
              checkpointId: "stale-resume-checkpoint",
              producerActionId: "stale-resume-action",
              schema: "checkpoint-v1",
              artifactDigest: fixtureDigest("stale-resume-checkpoint"),
              obligationOwner: "control-core",
              obligationGeneration: staleResumeToken.generation,
            },
          },
          staleResumeToken,
        ),
        {
          type: "checkpoint",
          checkpoint: {
            checkpointId: "stale-resume-checkpoint",
            producerActionId: "stale-resume-action",
            schema: "checkpoint-v1",
            artifactDigest: fixtureDigest("stale-resume-checkpoint"),
            obligationOwner: "control-core",
            obligationGeneration: staleResumeToken.generation,
          },
        },
      ),
    );
    const staleResumeChild = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},60000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!staleResumeChild.pid) throw new Error("spawn_failed");
    const staleResumeProcess: ProcessIdentity = {
      pid: staleResumeChild.pid,
      processGroupId: staleResumeChild.pid,
      startFingerprint: `stale-resume:${staleResumeChild.pid}`,
      containmentGeneration: 1,
    };
    value(
      processOwner.register(
        meta(
          "register-process",
          staleResumeToken.runId,
          "stale-resume-process",
          staleResumeProcess,
          staleResumeToken,
        ),
        staleResumeToken,
        staleResumeProcess,
      ),
    );
    const staleResumeExit = waitForExit(staleResumeChild);
    process.kill(-staleResumeChild.pid, "SIGKILL");
    await staleResumeExit;
    value(
      processOwner.technicalExit(
        meta(
          "technical-exit",
          staleResumeToken.runId,
          "stale-resume-exit",
          { exitCode: 0 },
          staleResumeToken,
        ),
        staleResumeToken,
        0,
      ),
    );
    value(
      processOwner.reaped(
        meta(
          "reap-containment",
          staleResumeToken.runId,
          "stale-resume-reap",
          { factKind: "containment-reaped" },
          staleResumeToken,
        ),
        staleResumeToken,
      ),
    );
    value(
      processOwner.revoke(
        meta(
          "revoke-grant",
          staleResumeToken.runId,
          "stale-resume-revoke",
          { factKind: "grant-revoked" },
          staleResumeToken,
        ),
        staleResumeToken,
      ),
    );
    value(
      control.quiesce(
        meta(
          "quiesce",
          staleResumeToken.runId,
          "stale-resume-quiesce",
          { checkpointId: "stale-resume-checkpoint" },
          staleResumeToken,
        ),
        staleResumeToken,
        "stale-resume-checkpoint",
      ),
    );

    const staleToken = value(
      control.admit(
        meta(
          "admit",
          "run-stale-epoch",
          "admit-stale",
          {
            runId: "run-stale-epoch",
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            activationEpoch: 1,
          },
          undefined,
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        {
          runId: "run-stale-epoch",
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          activationEpoch: 1,
        },
      ),
    );
    const staleSession = control.harness(staleToken);
    value(
      staleSession.submit(
        meta(
          "register-action",
          staleToken.runId,
          "stale-action",
          {
            type: "action",
            action: {
              actionId: "stale-action",
              kind: "tool",
              inputDigest: fixtureDigest("stale-action"),
            },
          },
          staleToken,
        ),
        {
          type: "action",
          action: {
            actionId: "stale-action",
            kind: "tool",
            inputDigest: fixtureDigest("stale-action"),
          },
        },
      ),
    );
    const staleEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "stale-action",
        intentKey: "stale",
        intentGeneration: 0,
        operation: "fixture.commit",
        payloadDigest: fixtureDigest("stale-effect"),
      },
    };
    const staleEffectId = value(
      staleSession.submit(
        meta(
          "effect-intent",
          staleToken.runId,
          "stale-intent",
          staleEffect,
          staleToken,
        ),
        staleEffect,
      ),
    ).effectId;
    value(
      control.activate(
        meta(
          "activate",
          release.spec.agentId,
          "activate-epoch-2",
          {
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            epoch: 2,
          },
          undefined,
          { expectedCurrentEpoch: 1 },
        ),
        {
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          epoch: 2,
        },
      ),
    );
    const staleFactCount = value(control.sourceFacts()).length;
    assert.deepEqual(
      await executeHeartbeat(
        control,
        store!.outcomes,
        staleToken,
        "fake",
        fixtureDigest("stale-heartbeat"),
      ),
      { ok: false, error: "stale_epoch" },
    );
    assert.deepEqual(
      staleSession.submit(
        meta(
          "register-action",
          staleToken.runId,
          "stale-late-action",
          {
            type: "action",
            action: {
              actionId: "stale-late-action",
              kind: "tool",
              inputDigest: fixtureDigest("stale-late-action"),
            },
          },
          staleToken,
        ),
        {
          type: "action",
          action: {
            actionId: "stale-late-action",
            kind: "tool",
            inputDigest: fixtureDigest("stale-late-action"),
          },
        },
      ),
      { ok: false, error: "stale_epoch" },
    );
    assert.deepEqual(
      processOwner.register(
        meta(
          "register-process",
          staleToken.runId,
          "stale-process",
          {
            pid: process.pid,
            processGroupId: process.pid,
            startFingerprint: "stale",
            containmentGeneration: 1,
          },
          staleToken,
        ),
        staleToken,
        {
          pid: process.pid,
          processGroupId: process.pid,
          startFingerprint: "stale",
          containmentGeneration: 1,
        },
      ),
      { ok: false, error: "stale_epoch" },
    );
    assert.equal(value(control.sourceFacts()).length, staleFactCount);
    assert.equal(value(control.snapshot(staleToken.runId)).process, undefined);
    assert.deepEqual(
      control.resume(
        meta("resume", staleResumeToken.runId, "stale-resume", {
          checkpointId: "stale-resume-checkpoint",
        }),
        {
          runId: staleResumeToken.runId,
          checkpointId: "stale-resume-checkpoint",
        },
      ),
      { ok: false, error: "stale_epoch" },
    );
    assert.equal(
      value(control.sourceFacts()).filter(
        ({ factKind, aggregateId }) =>
          factKind === "quiescence-consumed" &&
          aggregateId === staleResumeToken.runId,
      ).length,
      0,
    );
    let staleDispatchCalls = 0;
    assert.deepEqual(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", staleToken.runId, "stale-dispatch", {
            runId: staleToken.runId,
            effectId: staleEffectId,
          }),
          outcome: meta(
            "record-effect-outcome",
            staleToken.runId,
            "stale-outcome",
            { runId: staleToken.runId, effectId: staleEffectId },
          ),
          unknown: meta(
            "mark-effect-unknown",
            staleToken.runId,
            "stale-unknown",
            { runId: staleToken.runId, effectId: staleEffectId },
          ),
        },
        staleToken.runId,
        staleEffectId,
        async () => {
          staleDispatchCalls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "stale_epoch" },
    );
    assert.equal(staleDispatchCalls, 0);
  } finally {
    store?.close();
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
