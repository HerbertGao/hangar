import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileRelease,
  digestJson,
  type AgentRelease,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
  createTrustedProcessController,
} from "../../packages/control-core/index.ts";
import { heartbeatOutcomeGate } from "../../apps/heartbeat/index.ts";
import { readHeartbeatArtifact } from "../../apps/heartbeat/tool.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const worker = join(process.cwd(), "tests/m1/worker.ts");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const meta = (
  kind: string,
  target: string,
  key: string,
  input: unknown,
  precondition: unknown = null,
) => commandMeta("m1-storage-test", kind, target, key, input, precondition);
const faultRelease = (): AgentRelease =>
  compileRelease(
    {
      agentId: "agent-fault",
      goal: "exercise an atomic Control command",
      harnessKind: "fake",
      checkpointSchema: "checkpoint-v1",
      capabilities: ["tool.read"],
      effectOperations: [],
        intentDescriptors: [],
    },
    {
      entryId: "fault-worker",
      executable: process.execPath,
      executableDigest: "a".repeat(64),
      members: [],
    },
  );

const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });

async function crashCase(mode: "precommit" | "postcommit"): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `hangar-m1-${mode}-`));
  const authorityPath = join(directory, "authority.sqlite");
  const databasePath = join(directory, "control.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(
    authority.initialize(`database-${mode}`, "target-source"),
  );
  try {
    const child = spawnSync(
      process.execPath,
      [
        worker,
        mode,
        databasePath,
        authorityPath,
        fence.databaseIdentity,
        fence.targetId,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, null);
    assert.equal(child.signal, "SIGKILL");

    const runtime = openSqliteControl(databasePath, { authorityPath, fence });
    const release = faultRelease();
    try {
      const before = value(runtime.readSnapshot());
      assert.equal(before.facts.length, mode === "precommit" ? 0 : 1);
      assert.equal(before.projections.length, mode === "precommit" ? 0 : 1);
      value(
        runtime.control.publish(
          commandMeta(
            "m1-worker",
            "publish-release",
            release.releaseId,
            "fault-command",
            release,
          ),
          release,
        ),
      );
      const after = value(runtime.readSnapshot());
      assert.equal(after.facts.length, 1);
      assert.equal(after.projections.length, 1);
      value(
        runtime.control.publish(
          commandMeta(
            "m1-worker",
            "publish-release",
            release.releaseId,
            "fault-command",
            release,
          ),
          release,
        ),
      );
      assert.equal(value(runtime.readSnapshot()).facts.length, 1);
    } finally {
      runtime.close();
    }
    const inspection = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });
    try {
      assert.equal(
        inspection.prepare("SELECT count(*) AS n FROM commands").get()?.n,
        1,
      );
      assert.equal(
        inspection.prepare("SELECT count(*) AS n FROM source_facts").get()?.n,
        1,
      );
      assert.equal(
        inspection.prepare("SELECT count(*) AS n FROM projections").get()?.n,
        1,
      );
    } finally {
      inspection.close();
    }
  } finally {
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("pre-commit process crash leaves no fact, command, or projection", () =>
  crashCase("precommit"));

test("post-commit acknowledgement loss preserves the full idempotent bundle", () =>
  crashCase("postcommit"));

test("restart rebuilds a complete lifecycle projection from facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m1-rebuild-"));
  const authorityPath = join(directory, "authority.sqlite");
  const databasePath = join(directory, "control.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(
    authority.initialize("database-rebuild", "target-source"),
  );
  let runtime = openSqliteControl(
    databasePath,
    { authorityPath, fence },
    { outcomeGate: heartbeatOutcomeGate },
  );
  try {
    const release = compileRelease(
      {
        agentId: "agent-rebuild",
        goal: "rebuild a complete projection",
        harnessKind: "fake",
        checkpointSchema: "checkpoint-v1",
        capabilities: ["tool.read"],
                effectOperations: ["fixture.commit"],
        intentDescriptors: [],
      },
      {
        entryId: "rebuild",
        executable: process.execPath,
        executableDigest: "b".repeat(64),
        members: [],
      },
    );
    const control = runtime.control;
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
        {
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          epoch: 1,
        },
      ),
    );
    const token = value(
      control.admit(
        meta(
          "admit",
          "run-rebuild",
          "admit",
          {
            runId: "run-rebuild",
            agentId: release.spec.agentId,
            releaseId: release.releaseId,
            activationEpoch: 1,
          },
          { releaseId: release.releaseId, activationEpoch: 1 },
        ),
        {
          runId: "run-rebuild",
          agentId: release.spec.agentId,
          releaseId: release.releaseId,
          activationEpoch: 1,
        },
      ),
    );
    value(
      control.harness(token).submit(
        meta(
          "register-action",
          token.runId,
          "action",
          {
            type: "action",
            action: {
              actionId: "rebuild-action",
              kind: "tool",
              inputDigest: digestJson({ input: "rebuild" }),
            },
          },
          token,
        ),
        {
          type: "action",
          action: {
            actionId: "rebuild-action",
            kind: "tool",
            inputDigest: digestJson({ input: "rebuild" }),
          },
        },
      ),
    );
    const rebuildEffect = {
      type: "effect-intent" as const,
      effect: {
        actionId: "rebuild-action",
        intentKey: "commit",
        intentGeneration: 0,
        operation: "fixture.commit",
        payloadDigest: digestJson({ payload: "rebuild" }),
      },
    };
    const rebuildEffectId = value(
      control.harness(token).submit(
        meta(
          "effect-intent",
          token.runId,
          "effect",
          rebuildEffect,
          token,
        ),
        rebuildEffect,
      ),
    ).effectId;
    const gateway = createEffectGateway(control);
    const rebuildApproval = {
      decision: "approved" as const,
      releaseId: release.releaseId,
      activationEpoch: 1,
      expiresAtUnixMs: Date.now() + 60_000,
    };
    value(
      gateway.approve(
        meta("approve-effect", token.runId, "approve", {
          runId: token.runId,
          effectId: rebuildEffectId,
          approval: rebuildApproval,
        }),
        token.runId,
        rebuildEffectId,
        rebuildApproval,
      ),
    );
    value(
      await gateway.dispatch(
        {
          start: meta("dispatch-effect", token.runId, "dispatch", {
            runId: token.runId,
            effectId: rebuildEffectId,
          }),
          outcome: meta("record-effect-outcome", token.runId, "outcome", {
            runId: token.runId,
            effectId: rebuildEffectId,
          }),
          unknown: meta("mark-effect-unknown", token.runId, "unknown", {
            runId: token.runId,
            effectId: rebuildEffectId,
          }),
        },
        token.runId,
        rebuildEffectId,
        async () => "committed",
      ),
    );
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("spawn_failed");
    const exited = waitForExit(child);
    const processOwner = createTrustedProcessController(control);
    value(
      processOwner.register(
        meta(
          "register-process",
          token.runId,
          "process",
          {
            pid: child.pid,
            processGroupId: child.pid,
            startFingerprint: `rebuild:${child.pid}`,
            containmentGeneration: 1,
          },
          token,
        ),
        token,
        {
          pid: child.pid,
          processGroupId: child.pid,
          startFingerprint: `rebuild:${child.pid}`,
          containmentGeneration: 1,
        },
      ),
    );
    process.kill(-child.pid, "SIGKILL");
    await exited;
    const artifactDigest = readHeartbeatArtifact();
    value(
      control.harness(token).submit(
        meta(
          "tool-observation",
          token.runId,
          "observation",
          {
            type: "tool-observation",
            observation: {
              actionId: "rebuild-action",
              toolId: "tool.read",
              outputDigest: artifactDigest,
              grantGeneration: token.generation,
            },
          },
          token,
        ),
        {
          type: "tool-observation",
          observation: {
            actionId: "rebuild-action",
            toolId: "tool.read",
            outputDigest: artifactDigest,
            grantGeneration: token.generation,
          },
        },
      ),
    );
    value(
      control.harness(token).submit(
        meta(
          "outcome-proposal",
          token.runId,
          "proposal",
          {
            type: "outcome-proposal",
            proposal: { artifactDigest },
          },
          token,
        ),
        {
          type: "outcome-proposal",
          proposal: { artifactDigest },
        },
      ),
    );
    value(
      runtime.outcomes.accept(
        meta("accept-outcome", token.runId, "accept", {
          runId: token.runId,
          attempt: token.attempt,
          artifactDigest,
        }),
        { runId: token.runId, attempt: token.attempt, artifactDigest },
      ),
    );
    value(
      processOwner.technicalExit(
        meta("technical-exit", token.runId, "exit", { exitCode: 0 }, token),
        token,
        0,
      ),
    );
    value(
      processOwner.reaped(
        meta(
          "reap-containment",
          token.runId,
          "reaped",
          { factKind: "containment-reaped" },
          token,
        ),
        token,
      ),
    );
    value(
      processOwner.revoke(
        meta(
          "revoke-grant",
          token.runId,
          "revoke",
          { factKind: "grant-revoked" },
          token,
        ),
        token,
      ),
    );
    value(
      control.terminalize(
        meta("terminalize", token.runId, "complete", { state: "completed" }),
        {
          runId: token.runId,
          state: "completed",
        },
      ),
    );

    const before = value(runtime.readSnapshot());
    const projections = before.projections;
    const factCount = before.facts.length;
    value(runtime.clearProjections());
    assert.deepEqual(control.snapshot(token.runId), {
      ok: false,
      error: "not_found",
    });
    runtime.close();
    runtime = openSqliteControl(
      databasePath,
      { authorityPath, fence },
      { outcomeGate: heartbeatOutcomeGate },
    );
    const rebuilt = value(runtime.readSnapshot());
    assert.deepEqual(rebuilt.projections, projections);
    assert.equal(rebuilt.facts.length, factCount);
    assert.equal(
      value(runtime.control.snapshot(token.runId)).state,
      "completed",
    );

    runtime.close();
    const tampered = new DatabaseSync(databasePath);
    tampered
      .prepare(
        "UPDATE projections SET source_fact_seq = 1 WHERE family = 'run' AND entity_id = ?",
      )
      .run(token.runId);
    tampered.close();
    runtime = openSqliteControl(
      databasePath,
      { authorityPath, fence },
      { outcomeGate: heartbeatOutcomeGate },
    );
    assert.equal(
      value(runtime.control.snapshot(token.runId)).state,
      "completed",
    );
  } finally {
    runtime.close();
    authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite writer, authority identity, and bootstrap are fail-closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m1-store-fence-"));
  const authorityPath = join(directory, "authority.sqlite");
  const databasePath = join(directory, "control.sqlite");
  const clonePath = join(directory, "clone.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(authority.initialize("database-fence", "target-source"));
  const runtime = openSqliteControl(databasePath, { authorityPath, fence });
  try {
    assert.throws(
      () => openSqliteControl(databasePath, { authorityPath, fence }),
      /database is locked/,
    );
    await runtime.backupTo(clonePath);
    const otherAuthorityPath = join(directory, "other-authority.sqlite");
    const otherAuthority = new RecoveryAuthority(otherAuthorityPath);
    try {
      value(otherAuthority.initialize("database-fence", "target-source"));
      const otherFence = value(
        otherAuthority.claimRestore("database-fence", 0, "target-clone"),
      );
      assert.throws(
        () =>
          openSqliteControl(clonePath, {
            authorityPath: otherAuthorityPath,
            fence: otherFence,
          }),
        /authority_identity_mismatch/,
      );
    } finally {
      otherAuthority.close();
    }
  } finally {
    runtime.close();
  }

  const bootstrapFence = value(
    authority.initialize("database-bootstrap", "target-bootstrap"),
  );
  const authorityDb = new DatabaseSync(authorityPath);
  authorityDb.exec(`
    CREATE TRIGGER abort_bootstrap AFTER UPDATE ON writer_heads
    WHEN NEW.database_identity = 'database-bootstrap'
    BEGIN SELECT RAISE(ABORT, 'bootstrap-fault'); END;
  `);
  authorityDb.close();
  const bootstrapPath = join(directory, "bootstrap.sqlite");
  assert.throws(
    () =>
      openSqliteControl(bootstrapPath, {
        authorityPath,
        fence: bootstrapFence,
      }),
    /bootstrap-fault/,
  );
  const partial = new DatabaseSync(bootstrapPath);
  assert.equal(
    partial
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      )
      .get()?.n,
    0,
  );
  partial.close();
  const authorityAfter = new DatabaseSync(authorityPath);
  assert.equal(
    authorityAfter
      .prepare(
        "SELECT adopted_physical_id FROM writer_heads WHERE database_identity = 'database-bootstrap'",
      )
      .get()?.adopted_physical_id,
    null,
  );
  authorityAfter.close();
  authority.close();
  await rm(directory, { recursive: true, force: true });
});
