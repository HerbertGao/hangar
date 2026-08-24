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
const bearer = { Authorization: "Bearer cli-read-token" };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-http-read-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-http", "target-http"));
  let visible = true;
  let suppressNotification = false;
  const composition = createHangarServerComposition({
    tls: false,
    secureCookies: false,
    controlPath: join(directory, "control.sqlite"),
    controlStore: {
      authorityPath,
      fence,
      suppressCommitNotification: () => suppressNotification,
    },
    controlOptions: {
      authorizeQuery: () => visible,
    },
    authPath: join(directory, "auth.sqlite"),
    authOptions: {
      nowUnixMs: () => 1_000,
      resolveSecret: () => "unused",
      origin: "http://127.0.0.1",
    },
  });
  composition.auth.putCredential({
    rawToken: "cli-read-token",
    kind: "cli_bearer",
    generation: 1,
    principalId: "reader",
    scopes: [
      "agent:read",
      "release:read",
      "run:read",
      "approval:read",
      "event:read",
      "health:read",
    ],
  });
  const spec: AgentSpec = {
    agentId: "agent-http",
    goal: "serve read projections",
    harnessKind: "fake",
    checkpointSchema: "checkpoint-v1",
    capabilities: [],
    effectOperations: [],
    intentDescriptors: [],
  };
  const closure: ExecutionClosure = {
    entryId: "http",
    executable: process.execPath,
    executableDigest: sha("exe"),
    members: [],
  };
  const release = compileRelease(spec, closure);
  const control = composition.control.control;
  value(
    control.publish(
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
    control.activate(
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
      control.admit(
        commandMeta("actor", "admit", runId, `admit-${runId}`, input, {
          releaseId: release.releaseId,
          activationEpoch: 1,
        }),
        input,
      ),
    );
  };
  const token1 = admit("run-http-1");
  admit("run-http-2");
  let action = 0;
  const addAction = () => {
    action += 1;
    const input = {
      type: "action" as const,
      action: {
        actionId: `action-${action}`,
        kind: "tool" as const,
        inputDigest: action.toString(16).padStart(64, "0"),
      },
    };
    return control
      .harness(token1)
      .submit(
        commandMeta(
          "actor",
          "register-action",
          "run-http-1",
          `action-${action}`,
          input,
          token1,
        ),
        input,
      );
  };
  const server = createHangarReadServer(composition, { heartbeatMs: 25 });
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
    addAction,
    setVisible: (next: boolean) => {
      visible = next;
    },
    setSuppress: (next: boolean) => {
      suppressNotification = next;
    },
    close: async () => {
      // SAFETY: Node HTTP Server exposes closeAllConnections; local minimal
      // ambient shim omits it. Tests must not hang on failed SSE assertions.
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

const json = async (
  port: number,
  path: string,
  headers: Record<string, string> = bearer,
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return {
    response,
    body: JSON.parse(await response.text()) as Record<string, unknown>,
  };
};

const rawSse = (
  port: number,
  path: string,
  extraHeaders: readonly [string, string][] = [],
  afterWrite?: () => void,
): Promise<{
  data: string;
  close: () => void;
  waitForClose: () => Promise<void>;
  getData: () => string;
}> =>
  new Promise((resolve, reject) => {
    const socket = connect(port);
    let data = "";
    let resolved = false;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SSE timeout: ${data}`));
    }, 2_000);
    socket.on("data", (chunk: Uint8Array) => {
      data += Buffer.from(chunk).toString("utf8");
      if (
        !resolved &&
        (data.includes("\ndata: ") || data.includes(": heartbeat"))
      ) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          data,
          close: () => socket.destroy(),
          waitForClose: () => closed,
          getData: () => data,
        });
      }
    });
    socket.on("close", () => {
      resolveClosed();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          data,
          close: () => {},
          waitForClose: () => closed,
          getData: () => data,
        });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Authorization: Bearer cli-read-token",
      "Accept: text/event-stream",
      ...extraHeaders.map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ];
    socket.write(lines.join("\r\n"));
    afterWrite?.();
  });

test("real HTTP read routes return only registry-validated projections", async () => {
  const f = await setup();
  try {
    const agents = await json(f.port, "/v1/agents");
    assert.equal(agents.response.status, 200);
    assert.equal((agents.body.agents as unknown[]).length, 1);

    const releases = await json(f.port, "/v1/agents/agent-http/releases");
    assert.equal(releases.response.status, 200);
    assert.match(
      releases.response.headers.get("etag") ?? "",
      /^"[0-9a-f]{64}"$/,
    );

    const run = await json(f.port, "/v1/runs/run-http-1");
    assert.equal(run.response.status, 200);
    const serialized = JSON.stringify(run.body);
    for (const forbidden of [
      "source_facts",
      "sessionId",
      "processGroupId",
      "payload_json",
    ])
      assert.equal(serialized.includes(forbidden), false, forbidden);

    const health = await json(f.port, "/v1/health");
    assert.equal(health.response.status, 200);
    assert.equal((health.body.health as { status: string }).status, "healthy");

    assert.equal(
      (await json(f.port, "/v1/agents?unknown=1")).response.status,
      404,
    );
    assert.equal((await json(f.port, "/v1/unknown")).response.status, 404);
    assert.equal(
      (await json(f.port, "/v1/health", { Authorization: "Bearer bad" }))
        .response.status,
      401,
    );
    f.setVisible(false);
    assert.equal(
      (await json(f.port, "/v1/runs/run-http-1")).response.status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("SSE reconnects from durable cursor; notification loss delays one heartbeat", async () => {
  const f = await setup();
  try {
    const page = value(
      f.composition.control.control.readRunEvents(
        f.composition.auth.authenticateBearer("cli-read-token")!,
        "run-http-1",
      ),
    );
    const last = page.value.events.at(-1)!.id;
    const first = await rawSse(
      f.port,
      "/v1/runs/run-http-1/events",
      [["Last-Event-ID", last]],
      () => value(f.addAction()),
    );
    const firstId = Number(/\nid: (\d+)/.exec(first.data)?.[1]);
    assert.ok(firstId > Number(last), first.data);
    assert.ok(first.data.includes("event: action-registered"));
    first.close();

    const nextLast = value(
      f.composition.control.control.readRunEvents(
        f.composition.auth.authenticateBearer("cli-read-token")!,
        "run-http-1",
      ),
    ).value.events.at(-1)!.id;
    f.setSuppress(true);
    const started = Date.now();
    const lost = await rawSse(
      f.port,
      "/v1/runs/run-http-1/events",
      [["Last-Event-ID", nextLast]],
      () => value(f.addAction()),
    );
    assert.ok(Date.now() - started < 250);
    const lostId = Number(/\nid: (\d+)/.exec(lost.data)?.[1]);
    assert.ok(lostId > Number(nextLast), lost.data);
    lost.close();
  } finally {
    await f.close();
  }
});

test("SSE cursor failures converge; revocation closes stream and disconnect never cancels Run", async () => {
  const f = await setup();
  try {
    const auth = f.composition.auth.authenticateBearer("cli-read-token")!;
    const run2Cursor = value(
      f.composition.control.control.readRunEvents(auth, "run-http-2"),
    ).value.events[0].id;
    for (const invalid of ["01", "+1", "-1", "1.0", "9007199254740992"])
      assert.equal(
        (
          await json(f.port, "/v1/runs/run-http-1/events", {
            ...bearer,
            "Last-Event-ID": invalid,
          })
        ).response.status,
        400,
      );
    for (const unavailable of [run2Cursor, "9007199254740991"])
      assert.equal(
        (
          await json(f.port, "/v1/runs/run-http-1/events", {
            ...bearer,
            "Last-Event-ID": unavailable,
          })
        ).response.status,
        404,
      );

    const stream = await rawSse(f.port, "/v1/runs/run-http-1/events");
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      value(f.composition.control.control.snapshot("run-http-1")).state,
      "running",
    );

    const revoked = await rawSse(
      f.port,
      "/v1/runs/run-http-1/events",
    );
    f.composition.auth.revokeCredential("cli_bearer", 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(revoked.getData().endsWith("0\r\n\r\n"), revoked.getData());
    revoked.close();
    assert.equal(
      value(f.composition.control.control.snapshot("run-http-1")).state,
      "running",
    );
  } finally {
    await f.close();
  }
});
