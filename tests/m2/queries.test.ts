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
  requiredScopeForProjection,
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
  agentId: "agent-query",
  goal: "exercise sanitized query ports",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: ["tool.read"],
  effectOperations: ["fixture.commit"],
  intentDescriptors: [],
};
const closure: ExecutionClosure = {
  entryId: "query-fixture",
  executable: process.execPath,
  executableDigest: "a".repeat(64),
  members: [],
};
const authority: AuthorityContext = {
  issuerNamespaceId: "issuer-test",
  principalId: "principal-test",
  representedSubjectId: "subject-test",
  audience: "hangar-control",
  issuerVersion: "policy-v1",
  authenticatedMethod: "test-key",
  delegationChainDigest: "d".repeat(64),
  effectiveScope: [
    "agent:read",
    "release:read",
    "run:read",
    "approval:read",
    "event:read",
    "health:read",
  ],
  effectiveOperation: "read",
  issuedAtUtcMs: 1,
  expiresAtUtcMs: 10_000,
  revocationVersion: "rev-1",
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-query-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-query", "target-query"));
  const hidden = new Set<string>();
  const runtime = openSqliteControl(
    join(directory, "control.sqlite"),
    { authorityPath, fence },
    {
      authorizeQuery: (_context, _family, entityId) =>
        entityId === null || !hidden.has(entityId),
    },
  );
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
  const admit = (runId: string) => {
    const input = {
      runId,
      agentId: spec.agentId,
      releaseId: release.releaseId,
      activationEpoch: 1,
    };
    return value(
      runtime.control.admit(
        commandMeta("actor", "admit", runId, `admit-${runId}`, input, {
          releaseId: release.releaseId,
          activationEpoch: 1,
        }),
        input,
      ),
    );
  };
  const token1 = admit("run-1");
  admit("run-2");

  // One pending Effect becomes the minimal pending Approval projection.
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
      .harness(token1)
      .submit(
        commandMeta(
          "actor",
          "register-action",
          "run-1",
          "action-1",
          action,
          token1,
        ),
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
      .harness(token1)
      .submit(
        commandMeta(
          "actor",
          "effect-intent",
          "run-1",
          "effect-submit",
          effect,
          token1,
        ),
        effect,
      ),
  ).effectId;
  return {
    runtime,
    effectId,
    owner,
    hidden,
    release,
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("projection family manifest and scope gate default-deny", async () => {
  const f = await setup();
  try {
    assert.deepEqual(requiredScopeForProjection("run"), {
      ok: true,
      value: "run:read",
    });
    assert.deepEqual(requiredScopeForProjection("future-family"), {
      ok: false,
      error: "invalid_input",
    });
    const noScopes = { ...authority, effectiveScope: ["future:read"] };
    assert.deepEqual(f.runtime.control.listAgents(noScopes), {
      ok: false,
      error: "forbidden",
    });
    assert.equal(
      value(f.runtime.control.listAgents(authority)).value.length,
      1,
    );
    const releases = value(
      f.runtime.control.listReleases(authority, spec.agentId),
    );
    assert.equal(releases.policyVersion, "policy-v1");
    assert.equal(releases.value[0].releaseId, f.release.releaseId);
    assert.match(releases.value[0].etag, /^"[0-9a-f]{64}"$/);
  } finally {
    await f.close();
  }
});

test("run query returns minimal committed projection with pending approvals", async () => {
  const f = await setup();
  try {
    const result = value(f.runtime.control.readRun(authority, "run-1"));
    assert.equal(result.value.run.runId, "run-1");
    assert.equal(result.value.pendingApprovals.length, 1);
    const pending = result.value.pendingApprovals[0];
    assert.deepEqual(
      {
        approvalId: pending.approvalId,
        runId: pending.runId,
        state: pending.state,
        operation: pending.operation,
      },
      {
        approvalId: f.effectId,
        runId: "run-1",
        state: "pending",
        operation: "fixture.commit",
      },
    );
    assert.ok(
      Number.isSafeInteger(pending.expiresAtUnixMs) &&
        pending.expiresAtUnixMs! > 0,
    );
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "sessionId",
      "processGroupId",
      "payloadDigest",
      "grantGeneration",
    ])
      assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.deepEqual(f.runtime.control.readRun(authority, "missing"), {
      ok: false,
      error: "not_found",
    });
    f.hidden.add("run-1");
    assert.deepEqual(f.runtime.control.readRun(authority, "run-1"), {
      ok: false,
      error: "not_found",
    });
  } finally {
    await f.close();
  }
});

test("run-event cursor is canonical and cross-run/future/invisible failures converge", async () => {
  const f = await setup();
  try {
    const run1 = value(f.runtime.control.readRunEvents(authority, "run-1"));
    const run2 = value(f.runtime.control.readRunEvents(authority, "run-2"));
    assert.ok(run1.value.events.length >= 1);
    assert.ok(run2.value.events.length >= 1);
    assert.deepEqual(Object.keys(run1.value.events[0]).sort(), [
      "eventKind",
      "id",
      "runId",
    ]);

    const invalid = ["01", "+1", "-1", "1.0", "1e1", " 1", "9007199254740992"];
    for (const cursor of invalid)
      assert.deepEqual(
        f.runtime.control.readRunEvents(authority, "run-1", cursor),
        { ok: false, error: "invalid_input" },
        cursor,
      );

    const unavailable = [
      run2.value.events[0].id, // valid cursor owned by another aggregate
      String(Number(run1.value.durableHead) + 1), // future
      "9007199254740991", // canonical but unknown
    ];
    for (const cursor of unavailable)
      assert.deepEqual(
        f.runtime.control.readRunEvents(authority, "run-1", cursor),
        { ok: false, error: "cursor_unavailable" },
      );

    f.hidden.add("run-1");
    assert.deepEqual(
      f.runtime.control.readRunEvents(
        authority,
        "run-1",
        run1.value.events[0].id,
      ),
      { ok: false, error: "cursor_unavailable" },
    );
    f.hidden.delete("run-1");
    const resumed = value(
      f.runtime.control.readRunEvents(
        authority,
        "run-1",
        run1.value.events[0].id,
      ),
    );
    assert.ok(resumed.value.events.every(({ runId }) => runId === "run-1"));
    assert.equal(
      value(f.runtime.control.readHealth(authority)).value.status,
      "healthy",
    );
  } finally {
    await f.close();
  }
});
