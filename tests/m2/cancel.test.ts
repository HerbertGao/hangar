import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileRelease,
  type AgentSpec,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
  createTrustedCancelController,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const spec: AgentSpec = {
  agentId: "agent-cancel",
  goal: "exercise durable cancel",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: ["tool.read"],
  effectOperations: ["fixture.commit"],
  intentDescriptors: [],
};
const closure: ExecutionClosure = {
  entryId: "cancel-fixture",
  executable: process.execPath,
  executableDigest: "a".repeat(64),
  members: [],
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-cancel-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-cancel", "target-cancel"));
  let crashAfter = false;
  const runtime = openSqliteControl(join(directory, "control.sqlite"), {
    authorityPath,
    fence,
    afterCommitBeforeAck: () => {
      if (crashAfter) {
        crashAfter = false;
        throw new Error("simulated ACK loss");
      }
    },
  });
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
  const runId = "run-cancel";
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
  const action = {
    type: "action" as const,
    action: {
      actionId: "action-1",
      kind: "tool" as const,
      inputDigest: "b".repeat(64),
    },
  };
  value(
    runtime.control
      .harness(token)
      .submit(
        commandMeta("actor", "register-action", runId, "action", action, token),
        action,
      ),
  );
  const effect = {
    type: "effect-intent" as const,
    effect: {
      actionId: "action-1",
      intentKey: "intent-1",
      intentGeneration: 1,
      operation: "fixture.commit",
      payloadDigest: "c".repeat(64),
    },
  };
  const effectId = value(
    runtime.control
      .harness(token)
      .submit(
        commandMeta("actor", "effect-intent", runId, "effect", effect, token),
        effect,
      ),
  ).effectId;
  return {
    runtime,
    effectId,
    owner,
    runId,
    token,
    release,
    gateway: createEffectGateway(runtime.control),
    cleanup: createTrustedCancelController(runtime.control),
    setCrashAfter: () => {
      crashAfter = true;
    },
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const cancelInput = (runId: string) => ({
  runId,
  reasonCode: "user-requested" as const,
});
const cancelMeta = (runId: string, key: string) =>
  commandMeta("actor", "cancel-run", runId, key, cancelInput(runId));
const cleanupMeta = (runId: string, key: string) =>
  commandMeta("cleanup", "cancel-cleanup", runId, key, { runId });

test("cancel atomically revokes predispatch obligation, fences late work, then cleanup terminalizes", async () => {
  const f = await setup();
  try {
    const result = value(
      f.runtime.control.cancel(
        cancelMeta(f.runId, "cancel-1"),
        cancelInput(f.runId),
      ),
    );
    assert.equal(result.cancelStatus, "cleanup-pending");
    const facts = value(f.runtime.control.sourceFacts()).filter(
      ({ aggregateId }) => aggregateId === f.runId,
    );
    for (const kind of [
      "cancel-requested",
      "approval-superseded",
      "local-dispatch-result",
    ])
      assert.equal(
        facts.some(({ factKind }) => factKind === kind),
        true,
        kind,
      );
    assert.equal(
      facts.filter(({ factKind }) => factKind === "local-dispatch-result")
        .length,
      1,
    );

    const lateAction = {
      type: "action" as const,
      action: {
        actionId: "late",
        kind: "tool" as const,
        inputDigest: "d".repeat(64),
      },
    };
    assert.deepEqual(
      f.runtime.control
        .harness(f.token)
        .submit(
          commandMeta(
            "actor",
            "register-action",
            f.runId,
            "late",
            lateAction,
            f.token,
          ),
          lateAction,
        ),
      { ok: false, error: "terminal_conflict" },
    );
    assert.deepEqual(f.runtime.control.authorizeLaunch(f.token), {
      ok: false,
      error: "terminal_conflict",
    });
    const lateApproval = {
      decision: "approved" as const,
      releaseId: f.release.releaseId,
      activationEpoch: 1,
      expiresAtUnixMs: Date.now() + 60_000,
    };
    assert.deepEqual(
      f.gateway.approve(
        commandMeta("gateway", "approve-effect", f.runId, "late-approval", {
          runId: f.runId,
          effectId: f.effectId,
          approval: lateApproval,
        }),
        f.runId,
        f.effectId,
        lateApproval,
      ),
      { ok: false, error: "terminal_conflict" },
    );
    assert.deepEqual(
      f.runtime.control.terminalize(
        commandMeta("actor", "terminalize", f.runId, "forged-cancel", {
          state: "cancelled",
        }),
        { runId: f.runId, state: "cancelled" },
      ),
      { ok: false, error: "terminal_conflict" },
    );

    const cleanup = cleanupMeta(f.runId, "cleanup-1");
    f.setCrashAfter();
    assert.deepEqual(f.cleanup.settle(cleanup, f.runId), {
      ok: false,
      error: "invalid_state",
    });
    assert.deepEqual(f.cleanup.settle(cleanup, f.runId), {
      ok: true,
      value: { runId: f.runId, state: "cancelled" },
    });
    assert.equal(value(f.runtime.control.snapshot(f.runId)).state, "cancelled");
    assert.equal(
      value(f.runtime.control.snapshot(f.runId)).effects[f.effectId],
      "not-committed",
    );
    // Exact replay stays stored even after terminal; another cancel is conflict.
    assert.equal(
      value(
        f.runtime.control.cancel(
          cancelMeta(f.runId, "cancel-1"),
          cancelInput(f.runId),
        ),
      ).fenceGeneration,
      1,
    );
    assert.deepEqual(
      f.runtime.control.cancel(
        cancelMeta(f.runId, "cancel-2"),
        cancelInput(f.runId),
      ),
      { ok: false, error: "terminal_conflict" },
    );
  } finally {
    await f.close();
  }
});

test("started unknown effect keeps Run pending until real reconciliation final", async () => {
  const f = await setup();
  try {
    const approval = {
      decision: "approved" as const,
      releaseId: f.release.releaseId,
      activationEpoch: 1,
      expiresAtUnixMs: Date.now() + 60_000,
    };
    value(
      f.gateway.approve(
        commandMeta("gateway", "approve-effect", f.runId, "approve", {
          runId: f.runId,
          effectId: f.effectId,
          approval,
        }),
        f.runId,
        f.effectId,
        approval,
      ),
    );
    const dispatchInput = { runId: f.runId, effectId: f.effectId };
    assert.deepEqual(
      await f.gateway.dispatch(
        {
          start: commandMeta(
            "gateway",
            "dispatch-effect",
            f.runId,
            "start",
            dispatchInput,
          ),
          outcome: commandMeta(
            "gateway",
            "record-effect-outcome",
            f.runId,
            "outcome",
            dispatchInput,
          ),
          unknown: commandMeta(
            "gateway",
            "mark-effect-unknown",
            f.runId,
            "unknown",
            dispatchInput,
          ),
        },
        f.runId,
        f.effectId,
        async () => {
          throw new Error("transport outcome lost");
        },
      ),
      { ok: false, error: "unknown_effect" },
    );

    const cancelled = value(
      f.runtime.control.cancel(
        cancelMeta(f.runId, "cancel-unknown"),
        cancelInput(f.runId),
      ),
    );
    assert.equal(cancelled.cancelStatus, "cancel-pending-reconciliation");
    assert.equal(
      value(f.runtime.control.sourceFacts()).some(
        ({ aggregateId, factKind }) =>
          aggregateId === f.runId && factKind === "reconciliation-wake",
      ),
      true,
    );
    assert.deepEqual(
      f.cleanup.settle(cleanupMeta(f.runId, "cleanup-too-early"), f.runId),
      { ok: false, error: "invalid_state" },
    );
    value(
      f.gateway.reconcile(
        commandMeta("gateway", "reconcile-effect", f.runId, "reconcile", {
          runId: f.runId,
          effectId: f.effectId,
          outcome: "not-committed",
        }),
        f.runId,
        f.effectId,
        "not-committed",
      ),
    );
    value(
      f.cleanup.settle(cleanupMeta(f.runId, "cleanup-after-final"), f.runId),
    );
    assert.equal(value(f.runtime.control.snapshot(f.runId)).state, "cancelled");
  } finally {
    await f.close();
  }
});

test("cancel accepted result survives ACK loss and conflicting payload does not duplicate facts", async () => {
  const f = await setup();
  try {
    const meta = cancelMeta(f.runId, "cancel-ack-loss");
    f.setCrashAfter();
    assert.deepEqual(f.runtime.control.cancel(meta, cancelInput(f.runId)), {
      ok: false,
      error: "invalid_state",
    });
    assert.equal(
      value(f.runtime.control.cancel(meta, cancelInput(f.runId)))
        .fenceGeneration,
      1,
    );
    const changed = { runId: f.runId, reasonCode: "other" } as never;
    const changedMeta = commandMeta(
      "actor",
      "cancel-run",
      f.runId,
      "cancel-ack-loss",
      changed,
    );
    assert.deepEqual(f.runtime.control.cancel(changedMeta, changed), {
      ok: false,
      error: "invalid_input",
    });
    assert.equal(
      value(f.runtime.control.sourceFacts()).filter(
        ({ aggregateId, factKind }) =>
          aggregateId === f.runId && factKind === "cancel-requested",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});
