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
import { wireError } from "../../packages/control-api/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const context: AuthorityContext = {
  issuerNamespaceId: "issuer",
  principalId: "reader",
  representedSubjectId: "subject",
  audience: "hangar-control",
  issuerVersion: "policy-v1",
  authenticatedMethod: "token",
  delegationChainDigest: "d".repeat(64),
  effectiveScope: ["run:read", "approval:read", "event:read"],
  effectiveOperation: "read",
  issuedAtUtcMs: 1,
  expiresAtUtcMs: 10_000,
  revocationVersion: "rev-1",
};

test("public Run/event projections default-drop tokens, raw facts, secrets, paths and stacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-redaction-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(
    owner.initialize("database-redaction", "target-redaction"),
  );
  const runtime = openSqliteControl(join(directory, "control.sqlite"), {
    authorityPath,
    fence,
  });
  try {
    const spec: AgentSpec = {
      agentId: "agent-redaction",
      goal: "redaction fixture",
      harnessKind: "fake",
      checkpointSchema: "checkpoint-v1",
      capabilities: [],
      effectOperations: [],
      intentDescriptors: [],
    };
    const closure: ExecutionClosure = {
      entryId: "redaction",
      executable: process.execPath,
      executableDigest: "a".repeat(64),
      members: [],
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
    const input = {
      runId: "run-redaction",
      agentId: spec.agentId,
      releaseId: release.releaseId,
      activationEpoch: 1,
    };
    value(
      runtime.control.admit(
        commandMeta("actor", "admit", input.runId, "admit", input, {
          releaseId: release.releaseId,
          activationEpoch: 1,
        }),
        input,
      ),
    );
    const run = value(runtime.control.readRun(context, input.runId));
    const events = value(runtime.control.readRunEvents(context, input.runId));
    const output = JSON.stringify({ run, events });
    for (const forbidden of [
      "sessionId",
      "grantGeneration",
      "processGroupId",
      "payload_json",
      "sourceFacts",
      "secret",
      "stack",
      "/Users/",
    ])
      assert.equal(output.includes(forbidden), false, forbidden);
    assert.deepEqual(Object.keys(events.value.events[0]).sort(), [
      "eventKind",
      "id",
      "runId",
    ]);
    assert.deepEqual(wireError("not_found", "not found"), {
      error: {
        schemaVersion: "wire-error-v1",
        kind: "not_found",
        message: "not found",
      },
    });
  } finally {
    runtime.close();
    owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown projection family/scope and malformed AuthorityContext fail closed", () => {
  assert.deepEqual(requiredScopeForProjection("future-family"), {
    ok: false,
    error: "invalid_input",
  });
  assert.equal(context.effectiveScope.includes("future:read"), false);
});
