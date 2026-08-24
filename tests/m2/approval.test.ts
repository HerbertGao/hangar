import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileRelease,
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
  effectOperations: ["fixture.commit"],
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
      effectId: "effect-1",
      actionId: "action-1",
      intentKey: "intent-1",
      intentGeneration: 1,
      operation: "fixture.commit",
      payloadDigest: "c".repeat(64),
    },
  };
  value(
    runtime.control
      .harness(token)
      .submit(
        commandMeta("actor", "effect-intent", runId, "effect", effect, token),
        effect,
      ),
  );
  return {
    runId,
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

const decisionInput = (runId: string, decision: "approved" | "denied") => ({
  runId,
  approvalId: "effect-1",
  decision,
});
const decisionMeta = (
  runId: string,
  key: string,
  decision: "approved" | "denied",
) =>
  commandMeta(
    "operator",
    "decide-approval",
    "effect-1",
    key,
    decisionInput(runId, decision),
  );

const dispatchMeta = (runId: string, prefix: string) => {
  const input = { runId, effectId: "effect-1" };
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

    const approved = decisionInput(f.runId, "approved");
    const meta = decisionMeta(f.runId, "approve-ack", "approved");
    f.setCrashAfter();
    assert.deepEqual(f.runtime.control.decideApproval(meta, approved), {
      ok: false,
      error: "invalid_state",
    });
    assert.deepEqual(f.runtime.control.decideApproval(meta, approved), {
      ok: true,
      value: { approvalId: "effect-1", state: "approved", result: "accepted" },
    });
    assert.deepEqual(f.gateway.pendingWakes(), {
      ok: true,
      value: [{ runId: f.runId, effectId: "effect-1" }],
    });

    // Different command identity racing with opposite decision gets stored winner.
    assert.deepEqual(
      f.runtime.control.decideApproval(
        decisionMeta(f.runId, "deny-loser", "denied"),
        decisionInput(f.runId, "denied"),
      ),
      {
        ok: true,
        value: { approvalId: "effect-1", state: "approved", result: "stored" },
      },
    );
    // Same key but changed payload remains idempotency conflict.
    assert.deepEqual(
      f.runtime.control.decideApproval(
        decisionMeta(f.runId, "approve-ack", "denied"),
        decisionInput(f.runId, "denied"),
      ),
      { ok: false, error: "idempotency_conflict" },
    );

    f.closeRuntime();
    f.reopen();
    assert.deepEqual(f.gateway.pendingWakes(), {
      ok: true,
      value: [{ runId: f.runId, effectId: "effect-1" }],
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
          decisionMeta(denied.runId, "deny", "denied"),
          decisionInput(denied.runId, "denied"),
        ),
      ).state,
      "denied",
    );
    assert.equal(
      value(denied.runtime.control.snapshot(denied.runId)).effects["effect-1"],
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
          decisionMeta(expired.runId, "expired", "approved"),
          decisionInput(expired.runId, "approved"),
        ),
      ).state,
      "expired",
    );
    assert.equal(
      value(expired.runtime.control.snapshot(expired.runId)).effects[
        "effect-1"
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
        decisionMeta(revoked.runId, "approve", "approved"),
        decisionInput(revoked.runId, "approved"),
      ),
    );
    revoked.setAuthorityValid(false);
    let calls = 0;
    assert.deepEqual(
      await revoked.gateway.dispatch(
        dispatchMeta(revoked.runId, "revoked"),
        revoked.runId,
        "effect-1",
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
        "effect-1"
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
        decisionMeta(staleEpoch.runId, "approve", "approved"),
        decisionInput(staleEpoch.runId, "approved"),
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
        dispatchMeta(staleEpoch.runId, "stale-epoch"),
        staleEpoch.runId,
        "effect-1",
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
        decisionMeta(expired.runId, "approve", "approved"),
        decisionInput(expired.runId, "approved"),
      ),
    );
    expired.setNow(1_100);
    let calls = 0;
    assert.deepEqual(
      await expired.gateway.dispatch(
        dispatchMeta(expired.runId, "expired"),
        expired.runId,
        "effect-1",
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
        decisionMeta(once.runId, "approve", "approved"),
        decisionInput(once.runId, "approved"),
      ),
    );
    let calls = 0;
    assert.deepEqual(
      await once.gateway.dispatch(
        dispatchMeta(once.runId, "first"),
        once.runId,
        "effect-1",
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
          dispatchMeta(once.runId, "second"),
          once.runId,
          "effect-1",
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
