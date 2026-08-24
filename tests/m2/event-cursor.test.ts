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
import { commandMeta } from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const spec: AgentSpec = {
  agentId: "agent-cursor",
  goal: "exercise durable event cursor",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: [],
  effectOperations: [],
  intentDescriptors: [],
};
const closure: ExecutionClosure = {
  entryId: "cursor-fixture",
  executable: process.execPath,
  executableDigest: "a".repeat(64),
  members: [],
};
const authority: AuthorityContext = {
  issuerNamespaceId: "issuer",
  principalId: "principal",
  representedSubjectId: "subject",
  audience: "hangar-control",
  issuerVersion: "policy-v1",
  authenticatedMethod: "test",
  delegationChainDigest: "b".repeat(64),
  effectiveScope: ["event:read"],
  effectiveOperation: "read-events",
  issuedAtUtcMs: 1,
  expiresAtUtcMs: 10_000,
  revocationVersion: "rev-1",
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-cursor-"));
  const authorityPath = join(directory, "authority.sqlite");
  const controlPath = join(directory, "control.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-cursor", "target-cursor"));
  let suppress = false;
  let visible = true;
  const storeOptions = {
    authorityPath,
    fence,
    suppressCommitNotification: () => suppress,
  };
  const controlOptions = {
    authorizeQuery: () => visible,
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
  const runId = "run-cursor";
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
  let actionNumber = 0;
  const addAction = () => {
    actionNumber += 1;
    const action = {
      type: "action" as const,
      action: {
        actionId: `action-${actionNumber}`,
        kind: "tool" as const,
        inputDigest: actionNumber.toString(16).padStart(64, "0"),
      },
    };
    return runtime.control
      .harness(token)
      .submit(
        commandMeta(
          "actor",
          "register-action",
          runId,
          `action-${actionNumber}`,
          action,
          token,
        ),
        action,
      );
  };
  const headCursor = () => {
    const page = value(runtime.control.readRunEvents(authority, runId));
    return page.value.events.at(-1)!.id;
  };
  return {
    runId,
    get runtime() {
      return runtime;
    },
    addAction,
    headCursor,
    setSuppress: (value: boolean) => {
      suppress = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
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

test("subscribe-before-head closes read/subscribe race and advances serialized cursor", async () => {
  const f = await setup();
  try {
    const cursor = value(
      f.runtime.control.openRunEventCursor(authority, f.runId, f.headCursor(), {
        heartbeatMs: 1_000,
      }),
    );
    value(f.addAction()); // commits after subscribe, before next()
    const page = value(await cursor.next());
    assert.equal(page.value.events.length, 1);
    assert.equal(page.value.events[0].eventKind, "action-registered");
    const sent = page.value.nextCursor;
    value(f.addAction());
    const second = value(await cursor.next());
    assert.equal(Number(second.value.events[0].id), Number(sent) + 1);
    cursor.close();
  } finally {
    await f.close();
  }
});

test("permanent notification loss delays only one heartbeat and reauthorizes", async () => {
  const f = await setup();
  try {
    f.setSuppress(true);
    const cursor = value(
      f.runtime.control.openRunEventCursor(authority, f.runId, f.headCursor(), {
        heartbeatMs: 25,
      }),
    );
    const waiting = cursor.next();
    value(f.addAction());
    const started = Date.now();
    const page = value(await waiting);
    assert.equal(page.value.events.length, 1);
    assert.ok(Date.now() - started < 250);

    const nextWaiting = cursor.next();
    f.setVisible(false);
    value(f.addAction());
    assert.deepEqual(await nextWaiting, {
      ok: false,
      error: "cursor_unavailable",
    });
    cursor.close();
  } finally {
    await f.close();
  }
});

test("slow consumer bound closes cursor; restart resumes from durable last id", async () => {
  const f = await setup();
  try {
    const start = f.headCursor();
    const slow = value(
      f.runtime.control.openRunEventCursor(authority, f.runId, start, {
        heartbeatMs: 1_000,
        maxPendingWakeups: 2,
      }),
    );
    value(f.addAction());
    value(f.addAction());
    value(f.addAction());
    assert.deepEqual(await slow.next(), { ok: false, error: "invalid_state" });

    const last = f.headCursor();
    f.closeRuntime();
    f.reopen();
    const resumed = value(
      f.runtime.control.openRunEventCursor(authority, f.runId, last, {
        heartbeatMs: 1_000,
      }),
    );
    value(f.addAction());
    const page = value(await resumed.next());
    assert.equal(page.value.events.length, 1);
    assert.equal(Number(page.value.events[0].id), Number(last) + 1);
    resumed.close();
  } finally {
    await f.close();
  }
});
