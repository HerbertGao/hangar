import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileRelease,
  digestJson,
  type AgentSpec,
  type AuthorityContext,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
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
  agentId: "agent-approval",
  goal: "exercise durable Approval",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: [],
  effectOperations: ["fixture.commit", "fixture.alternate"],
  intentDescriptors: [],
};
const closure: ExecutionClosure = {
  entryId: "approval-fixture",
  executable: process.execPath,
  executableDigest: "a".repeat(64),
  members: [],
};
const queryAuthority: AuthorityContext = {
  issuerNamespaceId: "issuer",
  principalId: "principal",
  representedSubjectId: "subject",
  audience: "hangar-control",
  issuerVersion: "policy-v1",
  authenticatedMethod: "test",
  delegationChainDigest: "e".repeat(64),
  effectiveScope: ["run:read", "approval:read"],
  effectiveOperation: "read-run",
  issuedAtUtcMs: 1,
  expiresAtUtcMs: 10_000,
  revocationVersion: "rev-1",
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-approval-"));
  const authorityPath = join(directory, "authority.sqlite");
  const controlPath = join(directory, "control.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-approval", "target-approval"));
  let now = 1_000;
  let authorityValid = true;
  let crashAfter = false;
  const storeOptions = {
    authorityPath,
    fence,
    afterCommitBeforeAck: () => {
      if (crashAfter) {
        crashAfter = false;
        throw new Error("simulated ACK loss");
      }
    },
  };
  const controlOptions = {
    timeAuthority: { nowUnixMs: () => now },
    approvalTtlMs: 100,
    effectAuthorityValid: () => authorityValid,
  };
  let runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
  let closed = false;
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
  const runId = "run-approval";
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
    runId,
    controlPath,
    token,
    effect,
    effectId,
    release,
    get runtime() {
      return runtime;
    },
    get gateway() {
      return createEffectGateway(runtime.control);
    },
    setNow: (value: number) => {
      now = value;
    },
    setAuthorityValid: (value: boolean) => {
      authorityValid = value;
    },
    setCrashAfter: () => {
      crashAfter = true;
    },
    closeRuntime: () => {
      if (!closed) runtime.close();
      closed = true;
    },
    reopen: () => {
      if (!closed) throw new Error("runtime still open");
      runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
      closed = false;
    },
    close: async () => {
      if (!closed) runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type ApprovalFixture = { runId: string; effectId: string };
const decisionInput = (
  fixture: ApprovalFixture,
  decision: "approved" | "denied",
) => ({
  runId: fixture.runId,
  approvalId: fixture.effectId,
  decision,
});
const decisionMeta = (
  fixture: ApprovalFixture,
  key: string,
  decision: "approved" | "denied",
) =>
  commandMeta(
    "operator",
    "decide-approval",
    fixture.effectId,
    key,
    decisionInput(fixture, decision),
  );

const dispatchMeta = (fixture: ApprovalFixture, prefix: string) => {
  const runId = fixture.runId;
  const input = { runId, effectId: fixture.effectId };
  return {
    start: commandMeta(
      "gateway",
      "dispatch-effect",
      runId,
      `${prefix}-start`,
      input,
    ),
    outcome: commandMeta(
      "gateway",
      "record-effect-outcome",
      runId,
      `${prefix}-outcome`,
      input,
    ),
    unknown: commandMeta(
      "gateway",
      "mark-effect-unknown",
      runId,
      `${prefix}-unknown`,
      input,
    ),
  };
};

test("approved decision is durable, wakes Gateway, and authorized loser sees stored state", async () => {
  const f = await setup();
  try {
    const pending = value(f.runtime.control.readRun(queryAuthority, f.runId));
    assert.equal(pending.value.pendingApprovals[0].expiresAtUnixMs, 1_100);

    const approved = decisionInput(f, "approved");
    const meta = decisionMeta(f, "approve-ack", "approved");
    f.setCrashAfter();
    assert.deepEqual(f.runtime.control.decideApproval(meta, approved), {
      ok: false,
      error: "invalid_state",
    });
    assert.deepEqual(f.runtime.control.decideApproval(meta, approved), {
      ok: true,
      value: { approvalId: f.effectId, state: "approved", result: "accepted" },
    });
    assert.deepEqual(f.gateway.pendingWakes(), {
      ok: true,
      value: [{ runId: f.runId, effectId: f.effectId }],
    });

    // Different command identity racing with opposite decision gets stored winner.
    assert.deepEqual(
      f.runtime.control.decideApproval(
        decisionMeta(f, "deny-loser", "denied"),
        decisionInput(f, "denied"),
      ),
      {
        ok: true,
        value: { approvalId: f.effectId, state: "approved", result: "stored" },
      },
    );
    // Same key but changed payload remains idempotency conflict.
    assert.deepEqual(
      f.runtime.control.decideApproval(
        decisionMeta(f, "approve-ack", "denied"),
        decisionInput(f, "denied"),
      ),
      { ok: false, error: "idempotency_conflict" },
    );

    f.closeRuntime();
    f.reopen();
    assert.deepEqual(f.gateway.pendingWakes(), {
      ok: true,
      value: [{ runId: f.runId, effectId: f.effectId }],
    });
  } finally {
    await f.close();
  }
});

test("deny and TimeAuthority expiry create final local results without dispatch", async () => {
  const denied = await setup();
  try {
    assert.equal(
      value(
        denied.runtime.control.decideApproval(
          decisionMeta(denied, "deny", "denied"),
          decisionInput(denied, "denied"),
        ),
      ).state,
      "denied",
    );
    assert.equal(
      value(denied.runtime.control.snapshot(denied.runId)).effects[denied.effectId],
      "not-committed",
    );
    assert.deepEqual(denied.gateway.pendingWakes(), { ok: true, value: [] });
  } finally {
    await denied.close();
  }

  const expired = await setup();
  try {
    expired.setNow(1_100);
    assert.equal(
      value(
        expired.runtime.control.decideApproval(
          decisionMeta(expired, "expired", "approved"),
          decisionInput(expired, "approved"),
        ),
      ).state,
      "expired",
    );
    assert.equal(
      value(expired.runtime.control.snapshot(expired.runId)).effects[
        expired.effectId
      ],
      "not-committed",
    );
  } finally {
    await expired.close();
  }
});

test("dispatch preflight revokes invalid authority, expires stale claim, and claims at most once", async () => {
  const revoked = await setup();
  try {
    value(
      revoked.runtime.control.decideApproval(
        decisionMeta(revoked, "approve", "approved"),
        decisionInput(revoked, "approved"),
      ),
    );
    revoked.setAuthorityValid(false);
    let calls = 0;
    assert.deepEqual(
      await revoked.gateway.dispatch(
        dispatchMeta(revoked, "revoked"),
        revoked.runId,
        revoked.effectId,
        async () => {
          calls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "forbidden" },
    );
    assert.equal(calls, 0);
    assert.deepEqual(revoked.gateway.pendingWakes(), { ok: true, value: [] });
    assert.equal(
      value(revoked.runtime.control.snapshot(revoked.runId)).effects[
        revoked.effectId
      ],
      "not-committed",
    );
  } finally {
    await revoked.close();
  }

  const staleEpoch = await setup();
  try {
    value(
      staleEpoch.runtime.control.decideApproval(
        decisionMeta(staleEpoch, "approve", "approved"),
        decisionInput(staleEpoch, "approved"),
      ),
    );
    value(
      staleEpoch.runtime.control.activate(
        commandMeta(
          "actor",
          "activate",
          spec.agentId,
          "activate-epoch-2",
          {
            agentId: spec.agentId,
            releaseId: staleEpoch.release.releaseId,
            epoch: 2,
          },
          { expectedCurrentEpoch: 1 },
        ),
        {
          agentId: spec.agentId,
          releaseId: staleEpoch.release.releaseId,
          epoch: 2,
        },
      ),
    );
    let calls = 0;
    assert.deepEqual(
      await staleEpoch.gateway.dispatch(
        dispatchMeta(staleEpoch, "stale-epoch"),
        staleEpoch.runId,
        staleEpoch.effectId,
        async () => {
          calls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "forbidden" },
    );
    assert.equal(calls, 0);
  } finally {
    await staleEpoch.close();
  }

  const expired = await setup();
  try {
    value(
      expired.runtime.control.decideApproval(
        decisionMeta(expired, "approve", "approved"),
        decisionInput(expired, "approved"),
      ),
    );
    expired.setNow(1_100);
    let calls = 0;
    assert.deepEqual(
      await expired.gateway.dispatch(
        dispatchMeta(expired, "expired"),
        expired.runId,
        expired.effectId,
        async () => {
          calls += 1;
          return "committed";
        },
      ),
      { ok: false, error: "expired" },
    );
    assert.equal(calls, 0);
  } finally {
    await expired.close();
  }

  const once = await setup();
  try {
    value(
      once.runtime.control.decideApproval(
        decisionMeta(once, "approve", "approved"),
        decisionInput(once, "approved"),
      ),
    );
    let calls = 0;
    assert.deepEqual(
      await once.gateway.dispatch(
        dispatchMeta(once, "first"),
        once.runId,
        once.effectId,
        async () => {
          calls += 1;
          return "committed";
        },
      ),
      { ok: true, value: null },
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await once.gateway.dispatch(
          dispatchMeta(once, "second"),
          once.runId,
          once.effectId,
          async () => {
            calls += 1;
            return "committed";
          },
        )
      ).ok,
      false,
    );
    assert.equal(calls, 1);
  } finally {
    await once.close();
  }
});

test("Control exclusively issues stable Effect identity", async () => {
  const f = await setup();
  try {
    assert.equal(
      f.effectId,
      digestJson(["effect-v1", f.runId, "intent-1", 1]),
    );

    const ackLostEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "action-1",
        intentKey: "ack-lost",
        intentGeneration: 2,
        operation: "fixture.commit",
        payloadDigest: "d".repeat(64),
      },
    };
    const ackLostMeta = commandMeta(
      "actor",
      "effect-intent",
      f.runId,
      "effect-ack-lost",
      ackLostEffect,
      f.token,
    );
    f.setCrashAfter();
    assert.deepEqual(
      f.runtime.control.harness(f.token).submit(ackLostMeta, ackLostEffect),
      { ok: false, error: "invalid_state" },
    );
    const recoveredId = value(
      f.runtime.control.harness(f.token).submit(ackLostMeta, ackLostEffect),
    ).effectId;
    assert.equal(
      recoveredId,
      digestJson(["effect-v1", f.runId, "ack-lost", 2]),
    );

    const operationConflict = {
      ...ackLostEffect,
      effect: {
        ...ackLostEffect.effect,
        operation: "fixture.alternate",
      },
    };
    assert.deepEqual(
      f.runtime.control.harness(f.token).submit(
        commandMeta(
          "actor",
          "effect-intent",
          f.runId,
          "effect-operation-conflict",
          operationConflict,
          f.token,
        ),
        operationConflict,
      ),
      { ok: false, error: "idempotency_conflict" },
    );

    const digestConflict = {
      ...ackLostEffect,
      effect: {
        ...ackLostEffect.effect,
        payloadDigest: "e".repeat(64),
      },
    };
    assert.deepEqual(
      f.runtime.control.harness(f.token).submit(
        commandMeta(
          "actor",
          "effect-intent",
          f.runId,
          "effect-digest-conflict",
          digestConflict,
          f.token,
        ),
        digestConflict,
      ),
      { ok: false, error: "idempotency_conflict" },
    );

    const callerChosen = {
      ...ackLostEffect,
      effect: { ...ackLostEffect.effect, effectId: "caller-chosen" },
    };
    assert.deepEqual(
      f.runtime.control.harness(f.token).submit(
        commandMeta(
          "actor",
          "effect-intent",
          f.runId,
          "caller-chosen-effect",
          callerChosen,
          f.token,
        ),
        callerChosen as never,
      ),
      { ok: false, error: "invalid_input" },
    );

    const otherRunId = "run-approval-other";
    const otherAdmit = {
      runId: otherRunId,
      agentId: spec.agentId,
      releaseId: f.release.releaseId,
      activationEpoch: 1,
    };
    const otherToken = value(
      f.runtime.control.admit(
        commandMeta("actor", "admit", otherRunId, "admit-other", otherAdmit, {
          releaseId: f.release.releaseId,
          activationEpoch: 1,
        }),
        otherAdmit,
      ),
    );
    const otherAction = {
      type: "action" as const,
      action: {
        actionId: "action-1",
        kind: "tool" as const,
        inputDigest: "b".repeat(64),
      },
    };
    value(
      f.runtime.control.harness(otherToken).submit(
        commandMeta(
          "actor",
          "register-action",
          otherRunId,
          "action-other",
          otherAction,
          otherToken,
        ),
        otherAction,
      ),
    );
    const otherEffectId = value(
      f.runtime.control.harness(otherToken).submit(
        commandMeta(
          "actor",
          "effect-intent",
          otherRunId,
          "effect-other",
          f.effect,
          otherToken,
        ),
        f.effect,
      ),
    ).effectId;
    assert.equal(
      otherEffectId,
      digestJson(["effect-v1", otherRunId, "intent-1", 1]),
    );
    assert.notEqual(otherEffectId, f.effectId);

    f.closeRuntime();
    const rawDb = new DatabaseSync(f.controlPath);
    try {
      assert.throws(
        () =>
          rawDb
            .prepare(
              "INSERT INTO effects(" +
                "effect_identity,effect_id,subject_kind,owner_id,run_id,action_id," +
                "intent_key,intent_generation,payload_digest,state" +
                ") VALUES (?,?,'run-action',?,?,?,?,?,?,'pending')",
            )
            .run(
              "run-action:forged:duplicate-effect-id",
              f.effectId,
              "forged-run",
              "forged-run",
              "forged-action",
              "forged-intent",
              0,
              "f".repeat(64),
            ),
        /UNIQUE constraint failed: effects\.effect_id/,
      );
    } finally {
      rawDb.close();
    }
  } finally {
    await f.close();
  }
});
