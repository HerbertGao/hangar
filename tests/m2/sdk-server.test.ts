import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHangarReadServer,
  createHangarServerComposition,
} from "../../apps/hangar-server/index.ts";
import {
  compileRelease,
  type AgentSpec,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import { commandMeta } from "../../packages/control-core/index.ts";
import {
  ControlSdk,
  ControlSdkError,
  decodeSseRecord,
} from "../../packages/control-sdk/index.ts";
import { RecoveryAuthority } from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-sdk-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-sdk", "target-sdk"));
  const composition = createHangarServerComposition({
    tls: false,
    secureCookies: false,
    controlPath: join(directory, "control.sqlite"),
    controlStore: { authorityPath, fence },
    controlOptions: {
      timeAuthority: { nowUnixMs: () => 1_000 },
      approvalTtlMs: 60_000,
    },
    authPath: join(directory, "auth.sqlite"),
    authOptions: {
      nowUnixMs: () => 1_000,
      resolveSecret: () => "unused",
      origin: "http://127.0.0.1",
    },
  });
  composition.auth.putCredential({
    rawToken: "sdk-token",
    kind: "cli_bearer",
    generation: 1,
    principalId: "sdk-user",
    scopes: [
      "agent:read",
      "release:read",
      "run-start",
      "run:read",
      "approval:read",
      "event:read",
      "health:read",
    ],
  });
  const spec: AgentSpec = {
    agentId: "agent-sdk",
    goal: "exercise generated SDK",
    harnessKind: "fake",
    checkpointSchema: "checkpoint-v1",
    capabilities: [],
    effectOperations: ["fixture.commit"],
    intentDescriptors: [
      {
        intentId: "emit",
        descriptorVersion: 1,
        inputSchema: { id: "metadata", version: "1", digest: "a".repeat(64) },
        scope: "run-start",
        policyId: "shadow",
        resultSchema: { id: "result", version: "1", digest: "b".repeat(64) },
      },
    ],
  };
  const closure: ExecutionClosure = {
    entryId: "sdk",
    executable: process.execPath,
    executableDigest: sha("sdk"),
    members: [],
  };
  const release = compileRelease(spec, closure);
  const control = composition.control.control;
  value(
    control.publish(
      commandMeta(
        "owner",
        "publish-release",
        release.releaseId,
        "publish",
        release,
      ),
      release,
    ),
  );
  value(
    control.activateMode(
      commandMeta(
        "owner",
        "activate-mode",
        spec.agentId,
        "activate",
        {
          agentId: spec.agentId,
          releaseId: release.releaseId,
          epoch: 1,
          activationMode: "shadow",
        },
        { expectedCurrentEpoch: null },
      ),
      {
        agentId: spec.agentId,
        releaseId: release.releaseId,
        epoch: 1,
        activationMode: "shadow",
      },
    ),
  );
  const approvalRun = "run-sdk-approval";
  const admit = {
    runId: approvalRun,
    agentId: spec.agentId,
    releaseId: release.releaseId,
    activationEpoch: 1,
  };
  const token = value(
    control.admit(
      commandMeta("owner", "admit", approvalRun, "admit", admit, {
        releaseId: release.releaseId,
        activationEpoch: 1,
      }),
      admit,
    ),
  );
  const action = {
    type: "action" as const,
    action: {
      actionId: "a",
      kind: "tool" as const,
      inputDigest: "c".repeat(64),
    },
  };
  value(
    control
      .harness(token)
      .submit(
        commandMeta(
          "owner",
          "register-action",
          approvalRun,
          "a",
          action,
          token,
        ),
        action,
      ),
  );
  const effect = {
    type: "effect-intent" as const,
    effect: {
      actionId: "a",
      intentKey: "i",
      intentGeneration: 1,
      operation: "fixture.commit",
      payloadDigest: "d".repeat(64),
    },
  };
  const approvalId = value(
    control
      .harness(token)
      .submit(
        commandMeta("owner", "effect-intent", approvalRun, "e", effect, token),
        effect,
      ),
  ).effectId;
  const server = createHangarReadServer(composition, { heartbeatMs: 25 });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, () => resolve(server.address()!.port)),
  );
  const sdk = new ControlSdk({
    baseUrl: `http://127.0.0.1:${port}`,
    credentialHeaders: () => ({ Authorization: "Bearer sdk-token" }),
  });
  return {
    directory,
    owner,
    composition,
    server,
    sdk,
    release,
    approvalRun,
    approvalId,
    close: async () => {
      (
        server as unknown as { closeAllConnections(): void }
      ).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      composition.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("generated SDK exercises all eight Control routes and SSE through real server", async () => {
  const f = await setup();
  try {
    const agents = await f.sdk.listAgents();
    assert.equal((agents.data as { agents: unknown[] }).agents.length, 1);
    const releases = await f.sdk.listReleases("agent-sdk");
    const release = (releases.data as { releases: Array<{ etag: string }> })
      .releases[0];
    const admitted = await f.sdk.submitIntent(
      "agent-sdk",
      "emit",
      {
        descriptorVersion: 1,
        executionMode: "shadow-evaluator",
        input: { trigger: "sdk" },
      },
      { idempotencyKey: "sdk-intent", ifMatch: release.etag },
    );
    const runId = (admitted.data as { runId: string }).runId;
    const run = await f.sdk.getRun(runId);
    assert.ok(run.etag);
    assert.equal((await f.sdk.health()).status, 200);

    const abort = new AbortController();
    const events = f.sdk.events(runId, { signal: abort.signal });
    const first = await events.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.runId, runId);
    abort.abort();
    await events.return(undefined);

    const cancelled = await f.sdk.cancelRun(runId, {
      idempotencyKey: "sdk-cancel",
      ifMatch: run.etag!,
    });
    assert.equal(cancelled.status, 202);

    const approvalRun = await f.sdk.getRun(f.approvalRun);
    const decided = await f.sdk.decideApproval(f.approvalId, "approved", {
      idempotencyKey: "sdk-decision",
      ifMatch: approvalRun.etag!,
    });
    assert.equal(decided.status, 200);
  } finally {
    await f.close();
  }
});

test("SDK rejects unknown response/event fields and never retries a write with a new key", async () => {
  const extraResponseSdk = new ControlSdk({
    baseUrl: "http://unused",
    credentialHeaders: () => ({ Authorization: "Bearer x" }),
    fetchImpl: async () =>
      new Response(JSON.stringify({ agents: [], unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    () => extraResponseSdk.listAgents(),
    (error) => error instanceof ControlSdkError && error.kind === "protocol",
  );
  assert.throws(
    () =>
      decodeSseRecord(
        'id: 1\nevent: run-admitted\ndata: {"id":"1","runId":"r","eventKind":"run-admitted","extra":true}',
        "r",
      ),
    /unknown SSE response field/,
  );

  let calls = 0;
  const noRetry = new ControlSdk({
    baseUrl: "http://unused",
    credentialHeaders: () => ({ Authorization: "Bearer x" }),
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            schemaVersion: "wire-error-v1",
            kind: "idempotency_conflict",
            message: "conflict",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(() =>
    noRetry.submitIntent(
      "a",
      "i",
      {
        descriptorVersion: 1,
        executionMode: "shadow-evaluator",
        input: { trigger: "x" },
      },
      { idempotencyKey: "caller-owned", ifMatch: `"${"a".repeat(64)}"` },
    ),
  );
  assert.equal(calls, 1);
});
