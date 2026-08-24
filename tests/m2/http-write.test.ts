import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "node:net";
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
import { RecoveryAuthority } from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const bearer = "Bearer cli-write-token";

const cookieValue = (header: string, name: string): string => {
  const match = new RegExp(`${name}=([^;]+)`).exec(header);
  if (!match) throw new Error(`missing ${name}`);
  return match[1];
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-http-write-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-http-write", "target-http-write"));
  let now = 1_000;
  let crashAfter = false;
  const secrets = new Map([["key-ref-1", "secret-1"]]);
  const composition = createHangarServerComposition({
    tls: false,
    secureCookies: false,
    controlPath: join(directory, "control.sqlite"),
    controlStore: {
      authorityPath,
      fence,
      afterCommitBeforeAck: () => {
        if (crashAfter) {
          crashAfter = false;
          throw new Error("simulated HTTP ACK loss");
        }
      },
    },
    controlOptions: {
      timeAuthority: { nowUnixMs: () => now },
      approvalTtlMs: 1_000,
      productionEligible: () => false,
    },
    authPath: join(directory, "auth.sqlite"),
    authOptions: {
      nowUnixMs: () => now,
      resolveSecret: (ref) => secrets.get(ref),
      origin: "http://127.0.0.1:8787",
      sessionTtlMs: 1_000,
      renewalGraceMs: 5_000,
    },
  });
  composition.auth.putHmacKey(1, "key-ref-1", true);
  composition.auth.putCredential({
    rawToken: "bootstrap-write",
    kind: "bootstrap",
    generation: 1,
    principalId: "operator",
    scopes: [
      "agent:read",
      "release:read",
      "run-start",
      "run:read",
      "approval:read",
      "health:read",
    ],
  });
  composition.auth.putCredential({
    rawToken: "cli-write-token",
    kind: "cli_bearer",
    generation: 1,
    principalId: "operator",
    scopes: [
      "agent:read",
      "release:read",
      "run-start",
      "run:read",
      "approval:read",
      "health:read",
    ],
  });
  const spec: AgentSpec = {
    agentId: "agent-write",
    goal: "exercise HTTP writes",
    harnessKind: "fake",
    checkpointSchema: "checkpoint-v1",
    capabilities: [],
    effectOperations: ["fixture.commit"],
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
          id: "result",
          version: "1",
          digest: "b".repeat(64),
        },
      },
    ],
  };
  const closure: ExecutionClosure = {
    entryId: "http-write",
    executable: process.execPath,
    executableDigest: sha("exe"),
    members: [],
  };
  const release = compileRelease(spec, closure);
  const control = composition.control.control;
  value(
    control.publish(
      commandMeta("owner", "publish-release", release.releaseId, "publish", release),
      release,
    ),
  );
  value(
    control.activateMode(
      commandMeta(
        "owner",
        "activate-mode",
        spec.agentId,
        "activate-shadow",
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

  // Separate legacy Run with one pending Approval for the decision route.
  const approvalRunId = "run-approval-http";
  const admitInput = {
    runId: approvalRunId,
    agentId: spec.agentId,
    releaseId: release.releaseId,
    activationEpoch: 1,
  };
  const token = value(
    control.admit(
      commandMeta("owner", "admit", approvalRunId, "admit-approval", admitInput, {
        releaseId: release.releaseId,
        activationEpoch: 1,
      }),
      admitInput,
    ),
  );
  const action = {
    type: "action" as const,
    action: {
      actionId: "approval-action",
      kind: "tool" as const,
      inputDigest: "c".repeat(64),
    },
  };
  value(
    control.harness(token).submit(
      commandMeta("owner", "register-action", approvalRunId, "approval-action", action, token),
      action,
    ),
  );
  const effect = {
    type: "effect-intent" as const,
    effect: {
      effectId: "approval-http",
      actionId: "approval-action",
      intentKey: "approval-http",
      intentGeneration: 1,
      operation: "fixture.commit",
      payloadDigest: "d".repeat(64),
    },
  };
  value(
    control.harness(token).submit(
      commandMeta("owner", "effect-intent", approvalRunId, "approval-effect", effect, token),
      effect,
    ),
  );

  const server = createHangarReadServer(composition, {
    heartbeatMs: 25,
    guardDeadlines: { headersDeadlineMs: 100, bodyDeadlineMs: 75 },
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, () => resolve(server.address()!.port)),
  );
  return {
    directory,
    owner,
    composition,
    server,
    port,
    release,
    approvalRunId,
    setNow: (value: number) => {
      now = value;
    },
    setCrashAfter: () => {
      crashAfter = true;
    },
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

const get = async (port: number, path: string) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: bearer },
  });
  return { response, body: JSON.parse(await response.text()) as Record<string, unknown> };
};

const post = async (
  port: number,
  path: string,
  body: unknown,
  idempotencyKey: string,
  ifMatch: string,
  headers: Record<string, string> = { Authorization: bearer },
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "If-Match": ifMatch,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

const rawStatus = (
  port: number,
  payload: string,
  end = true,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = connect(port);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(data));
    }, 2_000);
    socket.on("data", (chunk: Uint8Array) => {
      data += Buffer.from(chunk).toString("utf8");
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on("error", reject);
    socket.write(payload);
    if (end) socket.end();
  });

test("auth session route is bootstrap-only and emits one 204 cookie header block", async () => {
  const f = await setup();
  try {
    const response = await fetch(`http://127.0.0.1:${f.port}/auth/session`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bootstrap-write",
        Origin: "http://127.0.0.1:8787",
        "X-Hangar-Session-Action": "establish",
        Cookie: "hangar_session=ambient_old; hangar_csrf=ambient_old; hangar_session_hint=ambient_old",
      },
    });
    assert.equal(response.status, 204);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("hangar_session="));
    assert.ok(setCookie.includes("hangar_csrf="));
    assert.ok(setCookie.includes("hangar_session_hint="));
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await f.close();
  }
});

test("intent and cancel routes enforce credential/idempotency/precondition and cookie CSRF", async () => {
  const f = await setup();
  try {
    const releases = await get(f.port, "/v1/agents/agent-write/releases");
    assert.equal(releases.response.status, 200, JSON.stringify(releases.body));
    const release = (releases.body.releases as Array<{ etag: string }>)[0];
    const intentBody = {
      descriptorVersion: 1,
      executionMode: "shadow-evaluator",
      input: { trigger: "manual" },
    };
    const first = await post(
      f.port,
      "/v1/agents/agent-write/intents/emit",
      intentBody,
      "intent-key",
      release.etag,
    );
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const replay = await post(
      f.port,
      "/v1/agents/agent-write/intents/emit",
      intentBody,
      "intent-key",
      release.etag,
    );
    assert.equal(replay.response.status, 201);
    assert.deepEqual(replay.body, first.body);

    f.setCrashAfter();
    const lost = await post(
      f.port,
      "/v1/agents/agent-write/intents/emit",
      intentBody,
      "intent-ack-loss",
      release.etag,
    );
    assert.equal(lost.response.status, 409);
    const recovered = await post(
      f.port,
      "/v1/agents/agent-write/intents/emit",
      intentBody,
      "intent-ack-loss",
      release.etag,
    );
    assert.equal(recovered.response.status, 201);
    assert.match(String(recovered.body.runId), /^[0-9a-f]{64}$/);

    assert.equal(
      (
        await post(
          f.port,
          "/v1/agents/agent-write/intents/emit",
          { ...intentBody, input: { trigger: "changed" } },
          "intent-key",
          release.etag,
        )
      ).response.status,
      409,
    );
    assert.equal(
      (
        await post(
          f.port,
          "/v1/agents/agent-write/intents/emit",
          { ...intentBody, actor: "forged" },
          "forged",
          release.etag,
        )
      ).response.status,
      400,
    );
    assert.equal(
      (
        await post(
          f.port,
          "/v1/agents/agent-write/intents/emit",
          intentBody,
          "stale",
          `"${"0".repeat(64)}"`,
        )
      ).response.status,
      412,
    );

    const runId = (first.body.runId as string);
    const run = await get(f.port, `/v1/runs/${runId}`);
    const runEtag = run.response.headers.get("etag")!;
    const session = f.composition.auth.exchangeSession({
      action: "establish",
      bootstrapToken: "bootstrap-write",
      origin: "http://127.0.0.1:8787",
    });
    assert.ok(session.ok);
    const cookieHeaders = session.ok ? session.headers.setCookie : [];
    const sessionCookie = cookieValue(cookieHeaders[0], "hangar_session");
    const csrf = cookieValue(cookieHeaders[1], "hangar_csrf");
    const cancel = await post(
      f.port,
      `/v1/runs/${runId}/cancel`,
      { reasonCode: "user-requested" },
      "cancel-key",
      runEtag,
      {
        Cookie: `hangar_session=${sessionCookie}; hangar_csrf=${csrf}`,
        Origin: "http://127.0.0.1:8787",
        "X-Hangar-CSRF": csrf,
      },
    );
    assert.equal(cancel.response.status, 202);
    assert.equal(
      (
        await post(
          f.port,
          `/v1/runs/${runId}/cancel`,
          { reasonCode: "user-requested" },
          "cancel-no-csrf",
          runEtag,
          { Cookie: `hangar_session=${sessionCookie}; hangar_csrf=${csrf}` },
        )
      ).response.status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("approval opposite decisions converge on one stored winner; same key payload conflict", async () => {
  const f = await setup();
  try {
    const run = await get(f.port, `/v1/runs/${f.approvalRunId}`);
    const etag = run.response.headers.get("etag")!;
    const [approved, denied] = await Promise.all([
      post(
        f.port,
        "/v1/approvals/approval-http/decision",
        { decision: "approved" },
        "decision-a",
        etag,
      ),
      post(
        f.port,
        "/v1/approvals/approval-http/decision",
        { decision: "denied" },
        "decision-b",
        etag,
      ),
    ]);
    assert.equal(approved.response.status, 200);
    assert.equal(denied.response.status, 200);
    assert.equal(approved.body.state, denied.body.state);
    const loserDecision = approved.body.state === "approved" ? "denied" : "approved";
    assert.equal(
      (
        await post(
          f.port,
          "/v1/approvals/approval-http/decision",
          { decision: loserDecision },
          approved.body.state === "approved" ? "decision-a" : "decision-b",
          etag,
        )
      ).response.status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("real server rejects CL/TE, short/zero/oversize bodies before command", async () => {
  const f = await setup();
  try {
    const base =
      `POST /v1/agents/agent-write/intents/emit HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${f.port}\r\n` +
      `Authorization: ${bearer}\r\n` +
      `Content-Type: application/json\r\n` +
      `Idempotency-Key: raw\r\n` +
      `If-Match: "${f.release.releaseId}"\r\n`;
    assert.equal(
      await rawStatus(
        f.port,
        `${base}Content-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
      ),
      400,
    );
    assert.equal(
      await rawStatus(f.port, `${base}Content-Length: 10\r\n\r\nshort`),
      400,
    );
    assert.equal(
      await rawStatus(f.port, `${base}Content-Length: 5\r\n\r\n`, false),
      408,
    );
    const oversize = await fetch(
      `http://127.0.0.1:${f.port}/v1/agents/agent-write/intents/emit`,
      {
        method: "POST",
        headers: {
          Authorization: bearer,
          "Content-Type": "application/json",
          "Idempotency-Key": "oversize",
          "If-Match": `"${f.release.releaseId}"`,
        },
        body: "x".repeat(64 * 1024 + 1),
      },
    );
    assert.equal(oversize.status, 413);
  } finally {
    await f.close();
  }
});
