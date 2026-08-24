import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileRelease,
  type AgentRelease,
  type AgentSpec,
  type AttemptToken,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  type Control,
  createTrustedProcessController,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
  type SQLiteControlRuntime,
  type WriteFence,
} from "../../packages/control-store-sqlite/index.ts";
import {
  executeHeartbeat,
  heartbeatExecutionClosure,
  heartbeatOutcomeGate,
  hostQualification,
  launchContainedTree,
  type ContainedTree,
  type HarnessMode,
} from "../../apps/heartbeat/index.ts";
import { readHeartbeatArtifact } from "../../apps/heartbeat/tool.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

async function fixture(
  harnessKind: AgentSpec["harnessKind"],
  runId: string,
  executable = process.execPath,
  entryId = "heartbeat-child",
  closure: ExecutionClosure = heartbeatExecutionClosure(),
): Promise<{
  directory: string;
  authorityPath: string;
  databasePath: string;
  authority: RecoveryAuthority;
  fence: WriteFence;
  store: SQLiteControlRuntime;
  control: Control;
  release: AgentRelease;
  token: AttemptToken;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m1-process-"));
  const authorityPath = join(directory, "authority.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(
    authority.initialize(`database-${runId}`, "target-source"),
  );
  const store = openSqliteControl(
    join(directory, "control.sqlite"),
    { authorityPath, fence },
    { outcomeGate: heartbeatOutcomeGate },
  );
  const control = store.control;
  const release = compileRelease(
    {
      agentId: `agent-${runId}`,
      goal: "emit one heartbeat artifact",
      harnessKind,
      checkpointSchema: "checkpoint-v1",
      capabilities: ["tool.read"],
      effectOperations: ["fixture.commit"],
      intentDescriptors: [],
    },
    { ...closure, entryId, executable },
  );
  const meta = (
    kind: string,
    target: string,
    key: string,
    input: unknown,
    precondition: unknown = null,
  ) => commandMeta("m1-process-test", kind, target, key, input, precondition);
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
        { expectedCurrentEpoch: null },
      ),
      { agentId: release.spec.agentId, releaseId: release.releaseId, epoch: 1 },
    ),
  );
  const token = value(
    control.admit(
      meta(
        "admit",
        runId,
        "admit",
        {
          runId,
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          activationEpoch: 1,
        },
        { releaseId: release.releaseId, activationEpoch: 1 },
      ),
      {
        runId,
        agentId: release.spec.agentId,
        releaseId: release.releaseId,
        activationEpoch: 1,
      },
    ),
  );
  return {
    directory,
    authorityPath,
    databasePath: join(directory, "control.sqlite"),
    authority,
    fence,
    store,
    control,
    release,
    token,
    async close() {
      store.close();
      authority.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    )
      return false;
    throw error;
  }
};

for (const mode of [
  "fake",
  "legacy-process",
] as const satisfies readonly HarnessMode[]) {
  test(`${mode} child maps through one Control lifecycle`, async () => {
    const current = await fixture(mode, `run-${mode}`);
    try {
      const artifactDigest = "c".repeat(64);
      const execution = value(
        await executeHeartbeat(
          current.control,
          current.store.outcomes,
          current.token,
          mode,
          artifactDigest,
        ),
      );
      assert.equal(execution.exitCode, 0);
      const beforeTerminal = value(
        current.control.snapshot(current.token.runId),
      );
      assert.equal(beforeTerminal.state, "running");
      assert.equal(beforeTerminal.attemptState, "succeeded");
      assert.deepEqual(beforeTerminal.toolObservations, [
        {
          actionId: "heartbeat-action:0",
          toolId: "tool.read",
          outputDigest: readHeartbeatArtifact(),
          grantGeneration: current.token.generation,
        },
      ]);
      assert.equal(
        value(current.control.sourceFacts()).filter(
          ({ factKind }) => factKind === "tool-observed",
        ).length,
        1,
      );
      assert.equal(
        beforeTerminal.outcomeArtifactDigest,
        readHeartbeatArtifact(),
      );
      assert.equal(beforeTerminal.containmentReaped, true);
      assert.equal(beforeTerminal.grantRevoked, true);
      assert.deepEqual(
        current.control.terminalize(
          commandMeta(
            "m1-process-test",
            "terminalize",
            current.token.runId,
            "invalid-terminal",
            { state: "bogus" },
          ),
          // @ts-expect-error exercises the runtime closed terminal union.
          { runId: current.token.runId, state: "bogus" },
        ),
        { ok: false, error: "invalid_input" },
      );
      assert.equal(
        value(current.control.sourceFacts()).filter(
          ({ factKind }) => factKind === "run-terminal",
        ).length,
        0,
      );
      for (const state of ["failed", "cancelled"] as const)
        assert.deepEqual(
          current.control.terminalize(
            commandMeta(
              "m1-process-test",
              "terminalize",
              current.token.runId,
              `mismatched-${state}`,
              { state },
            ),
            { runId: current.token.runId, state },
          ),
          { ok: false, error: "invalid_state" },
        );
      const terminal = value(
        current.control.terminalize(
          commandMeta(
            "m1-process-test",
            "terminalize",
            current.token.runId,
            "complete",
            { state: "completed" },
          ),
          { runId: current.token.runId, state: "completed" },
        ),
      );
      assert.equal(terminal.state, "completed");
      assert.deepEqual(
        current.control.terminalize(
          commandMeta(
            "m1-process-test",
            "terminalize",
            current.token.runId,
            "second-terminal",
            { state: "failed" },
          ),
          { runId: current.token.runId, state: "failed" },
        ),
        { ok: false, error: "terminal_conflict" },
      );
    } finally {
      await current.close();
    }
  });
}

test("launcher rejects release harness and closure drift before spawn", async () => {
  const closure = heartbeatExecutionClosure();
  const cases = [
    {
      current: await fixture(
        "legacy-process",
        "run-executable-drift",
        "/bin/false",
      ),
      mode: "legacy-process" as const,
    },
    {
      current: await fixture("legacy-process", "run-harness-drift"),
      mode: "fake" as const,
    },
    {
      current: await fixture(
        "fake",
        "run-entry-drift",
        process.execPath,
        "wrong-entry",
      ),
      mode: "fake" as const,
    },
    {
      current: await fixture(
        "fake",
        "run-member-drift",
        process.execPath,
        "heartbeat-child",
        {
          ...closure,
          members: closure.members.map((member, index) =>
            index === 0 ? { ...member, digest: "0".repeat(64) } : member,
          ),
        },
      ),
      mode: "fake" as const,
    },
  ];
  for (const { current, mode } of cases) {
    try {
      assert.deepEqual(
        await executeHeartbeat(
          current.control,
          current.store.outcomes,
          current.token,
          mode,
          "1".repeat(64),
        ),
        { ok: false, error: "invalid_input" },
      );
      assert.equal(
        value(current.control.snapshot(current.token.runId)).process,
        undefined,
      );
    } finally {
      await current.close();
    }
  }
});

test("empty heartbeat artifact is rejected and cannot complete the Run", async () => {
  const current = await fixture("fake", "run-empty-artifact");
  try {
    assert.deepEqual(
      await executeHeartbeat(
        current.control,
        current.store.outcomes,
        current.token,
        "fake",
        "",
      ),
      { ok: false, error: "invalid_input" },
    );
    const run = value(current.control.snapshot(current.token.runId));
    assert.equal(run.attemptState, "failed");
    assert.equal(run.outcomeArtifactDigest, undefined);
    assert.equal(run.containmentReaped, true);
    assert.equal(run.grantRevoked, true);
    assert.deepEqual(
      current.control.terminalize(
        commandMeta(
          "m1-process-test",
          "terminalize",
          current.token.runId,
          "empty-complete",
          { state: "completed" },
        ),
        { runId: current.token.runId, state: "completed" },
      ),
      { ok: false, error: "invalid_state" },
    );
  } finally {
    await current.close();
  }
});

test("nonzero child exit is observed and cannot complete the Run", async () => {
  const current = await fixture("fake", "run-failure");
  try {
    const execution = value(
      await executeHeartbeat(
        current.control,
        current.store.outcomes,
        current.token,
        "fail",
        "d".repeat(64),
      ),
    );
    assert.equal(execution.exitCode, 3);
    assert.equal(
      value(current.control.snapshot(current.token.runId)).attemptState,
      "failed",
    );
    assert.deepEqual(
      current.control.terminalize(
        commandMeta(
          "m1-process-test",
          "terminalize",
          current.token.runId,
          "complete",
          { state: "completed" },
        ),
        { runId: current.token.runId, state: "completed" },
      ),
      { ok: false, error: "invalid_state" },
    );
  } finally {
    await current.close();
  }
});

test("parent death triggers automatic process-group reap but remains non-production", async () => {
  const current = await fixture("fake", "run-tree");
  let tree: ContainedTree | undefined;
  try {
    tree = value(await launchContainedTree(current.control, current.token));
    assert.equal(processExists(tree.identity.pid), true);
    assert.equal(processExists(tree.leafPid), true);
    const forgedOwner = Symbol("forged-process-owner");
    assert.deepEqual(
      current.control.markContainmentReaped(
        forgedOwner,
        commandMeta(
          "m1-process-test",
          "reap-containment",
          current.token.runId,
          "forged-reap",
          {},
        ),
        current.token,
      ),
      { ok: false, error: "invalid_input" },
    );
    const publicController = createTrustedProcessController(current.control);
    assert.deepEqual(
      publicController.technicalExit(
        commandMeta(
          "m1-process-test",
          "technical-exit",
          current.token.runId,
          "live-exit",
          { exitCode: 1 },
          current.token,
        ),
        current.token,
        1,
      ),
      { ok: false, error: "invalid_state" },
    );
    assert.deepEqual(
      publicController.reaped(
        commandMeta(
          "m1-process-test",
          "reap-containment",
          current.token.runId,
          "live-reap",
          { factKind: "containment-reaped" },
          current.token,
        ),
        current.token,
      ),
      { ok: false, error: "invalid_state" },
    );
    process.kill(tree.identity.pid, "SIGKILL");
    const execution = value(await tree.settled);
    assert.ok(execution.signal || execution.exitCode !== 0);
    assert.equal(processExists(tree.identity.pid), false);
    assert.equal(processExists(tree.leafPid), false);
    value(
      publicController.reaped(
        commandMeta(
          "m1-process-test",
          "reap-containment",
          current.token.runId,
          "reap-replay",
          { factKind: "containment-reaped" },
          current.token,
        ),
        current.token,
      ),
    );
    value(
      publicController.revoke(
        commandMeta(
          "m1-process-test",
          "revoke-grant",
          current.token.runId,
          "revoke-replay",
          { factKind: "grant-revoked" },
          current.token,
        ),
        current.token,
      ),
    );
    for (const factKind of ["containment-reaped", "grant-revoked"])
      assert.equal(
        value(current.control.sourceFacts()).filter(
          (fact) => fact.factKind === factKind,
        ).length,
        1,
      );
    assert.equal(
      value(
        current.control.terminalize(
          commandMeta(
            "m1-process-test",
            "terminalize",
            current.token.runId,
            "terminal-after-parent-death",
            { state: "failed" },
          ),
          { runId: current.token.runId, state: "failed" },
        ),
      ).state,
      "failed",
    );
    assert.deepEqual(hostQualification(), {
      status: "unverified-claim",
      productionEligible: false,
      reason: "process-group-allows-setsid-escape",
    });
  } finally {
    if (tree) await tree.reap().catch(() => undefined);
    await current.close();
  }
});

test("independent restore authority fences source and competing target", async () => {
  const current = await fixture("fake", "run-restore");
  const targetPath = join(current.directory, "target.sqlite");
  const competingPath = join(current.directory, "target-competing.sqlite");
  let targetStore: SQLiteControlRuntime | undefined;
  let competingStore: SQLiteControlRuntime | undefined;
  try {
    const secondSourcePath = join(current.directory, "second-source.sqlite");
    assert.throws(
      () =>
        openSqliteControl(secondSourcePath, {
          authorityPath: current.authorityPath,
          fence: current.fence,
        }),
      /physical_instance_mismatch/,
    );
    const secondSource = new DatabaseSync(secondSourcePath);
    assert.equal(
      secondSource
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .get()?.count,
      0,
    );
    secondSource.close();
    const wrongDatabaseFence = value(
      current.authority.initialize("database-other", "target-other"),
    );
    const partialPath = join(current.directory, "partial.sqlite");
    const partial = new DatabaseSync(partialPath);
    partial.exec(
      "CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY, database_identity TEXT NOT NULL); INSERT INTO store_meta VALUES (1, 'database-partial')",
    );
    const tablesBefore = partial
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    partial.close();
    assert.throws(
      () =>
        openSqliteControl(partialPath, {
          authorityPath: current.authorityPath,
          fence: wrongDatabaseFence,
        }),
      /migration_required/,
    );
    const partialAfter = new DatabaseSync(partialPath);
    assert.deepEqual(
      partialAfter
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
      tablesBefore,
    );
    partialAfter.close();
    const unidentifiedPath = join(current.directory, "unidentified.sqlite");
    const unidentified = new DatabaseSync(unidentifiedPath);
    unidentified.exec("CREATE TABLE unrelated(value TEXT)");
    unidentified.close();
    assert.throws(
      () =>
        openSqliteControl(unidentifiedPath, {
          authorityPath: current.authorityPath,
          fence: current.fence,
        }),
      /missing_database_identity/,
    );
    const unidentifiedAfter = new DatabaseSync(unidentifiedPath);
    assert.deepEqual(
      unidentifiedAfter
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
      ["unrelated"],
    );
    unidentifiedAfter.close();
    const triggeredPath = join(current.directory, "triggered.sqlite");
    await current.store.backupTo(triggeredPath);
    const triggered = new DatabaseSync(triggeredPath);
    triggered.exec(
      "CREATE TRIGGER unauthorized AFTER UPDATE ON store_meta BEGIN SELECT 1; END",
    );
    triggered.close();
    assert.throws(
      () =>
        openSqliteControl(triggeredPath, {
          authorityPath: current.authorityPath,
          fence: current.fence,
        }),
      /unknown_schema_object/,
    );
    await current.store.backupTo(targetPath);
    await current.store.backupTo(competingPath);
    const missingProjection = new DatabaseSync(targetPath);
    missingProjection.exec("DELETE FROM projections");
    missingProjection.close();
    const winner = value(
      current.authority.claimRestore(
        current.fence.databaseIdentity,
        current.fence.generation,
        "target-restored",
      ),
    );
    assert.deepEqual(
      current.authority.claimRestore(
        current.fence.databaseIdentity,
        current.fence.generation,
        "target-loser",
      ),
      { ok: false, error: "stale_authority" },
    );

    assert.deepEqual(
      current.control.publish(
        commandMeta(
          "m1-process-test",
          "publish-release",
          current.release.releaseId,
          "publish",
          current.release,
        ),
        current.release,
      ),
      { ok: false, error: "stale_authority" },
    );
    assert.deepEqual(
      current.control.activate(
        commandMeta(
          "m1-restore-test",
          "activate",
          current.release.spec.agentId,
          "stale-source-write",
          {
            agentId: current.release.spec.agentId,
            releaseId: current.release.releaseId,
            epoch: 2,
          },
          { expectedCurrentEpoch: 1 },
        ),
        {
          agentId: current.release.spec.agentId,
          releaseId: current.release.releaseId,
          epoch: 2,
        },
      ),
      { ok: false, error: "stale_authority" },
    );
    assert.throws(
      () =>
        openSqliteControl(targetPath, {
          authorityPath: current.authorityPath,
          fence: {
            databaseIdentity: current.fence.databaseIdentity,
            targetId: "target-loser",
            generation: winner.generation,
          },
        }),
      /stale_authority/,
    );

    targetStore = openSqliteControl(targetPath, {
      authorityPath: current.authorityPath,
      fence: winner,
    });
    competingStore = openSqliteControl(competingPath, {
      authorityPath: current.authorityPath,
      fence: winner,
    });
    value(targetStore.adoptFence(current.fence, winner));
    assert.equal(
      value(targetStore.control.snapshot(current.token.runId)).releaseId,
      current.release.releaseId,
    );
    assert.deepEqual(competingStore.adoptFence(current.fence, winner), {
      ok: false,
      error: "stale_authority",
    });
    const loserRevision = value(competingStore.readSnapshot()).revision;
    assert.deepEqual(competingStore.control.rebuildProjections(), {
      ok: false,
      error: "stale_authority",
    });
    assert.equal(value(competingStore.readSnapshot()).revision, loserRevision);
    const adoptedClonePath = join(current.directory, "adopted-clone.sqlite");
    await targetStore.backupTo(adoptedClonePath);
    assert.throws(
      () =>
        openSqliteControl(adoptedClonePath, {
          authorityPath: current.authorityPath,
          fence: winner,
        }),
      /physical_instance_mismatch/,
    );
    const restored = targetStore.control;
    assert.equal(
      value(restored.snapshot(current.token.runId)).releaseId,
      current.release.releaseId,
    );
    value(
      restored.activate(
        commandMeta(
          "m1-restore-test",
          "activate",
          current.release.spec.agentId,
          "target-write",
          {
            agentId: current.release.spec.agentId,
            releaseId: current.release.releaseId,
            epoch: 2,
          },
          { expectedCurrentEpoch: 1 },
        ),
        {
          agentId: current.release.spec.agentId,
          releaseId: current.release.releaseId,
          epoch: 2,
        },
      ),
    );
    assert.equal(
      value(restored.sourceFacts()).length,
      value(current.control.sourceFacts()).length + 1,
    );
  } finally {
    competingStore?.close();
    targetStore?.close();
    await current.close();
  }
});
