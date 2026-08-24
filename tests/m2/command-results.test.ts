import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileRelease,
  type AgentSpec,
  type ExecutionClosure,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  commandMeta,
  type ControlOptions,
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
  agentId: "agent-safe-rejection",
  goal: "exercise durable safe rejection",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: [],
  effectOperations: [],
  intentDescriptors: [],
};
const closure: ExecutionClosure = {
  entryId: "safe-rejection",
  executable: process.execPath,
  executableDigest: "a".repeat(64),
  members: [],
};

async function fixture(
  hooks: {
    beforeCommit?: () => void;
    afterCommitBeforeAck?: () => void;
  } = {},
  controlOptions: ControlOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-command-result-"));
  const authorityPath = join(directory, "authority.sqlite");
  const controlPath = join(directory, "control.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const fence = value(
    authority.initialize("database-command-result", "target-command-result"),
  );
  const storeOptions = { authorityPath, fence, ...hooks };
  let runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
  let runtimeClosed = false;
  const release = compileRelease(spec, closure);
  value(
    runtime.control.publish(
      commandMeta(
        "actor-1",
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
        "actor-1",
        "activate",
        spec.agentId,
        "activate-1",
        { agentId: spec.agentId, releaseId: release.releaseId, epoch: 1 },
        { expectedCurrentEpoch: null },
      ),
      { agentId: spec.agentId, releaseId: release.releaseId, epoch: 1 },
    ),
  );
  return {
    directory,
    controlPath,
    get runtime() {
      return runtime;
    },
    authority,
    release,
    closeRuntime: () => {
      if (runtimeClosed) return;
      runtime.close();
      runtimeClosed = true;
    },
    reopen: () => {
      if (!runtimeClosed) throw new Error("runtime still open");
      runtime = openSqliteControl(controlPath, storeOptions, controlOptions);
      runtimeClosed = false;
      return runtime;
    },
    close: async () => {
      if (!runtimeClosed) runtime.close();
      authority.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const staleActivation = (releaseId: string, key: string, epoch = 1) => {
  const input = { agentId: spec.agentId, releaseId, epoch };
  return {
    input,
    meta: commandMeta("actor-1", "activate", spec.agentId, key, input, {
      expectedCurrentEpoch: 1,
    }),
  };
};

const commandRow = (path: string, key: string) => {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        `SELECT command_state, authority_context_digest, result_json
         FROM commands WHERE idempotency_key = ?`,
      )
      .get(key);
  } finally {
    db.close();
  }
};

test("eligible stale-epoch rejection survives ACK loss as completed replay", async () => {
  let crashAfter = false;
  const f = await fixture({
    afterCommitBeforeAck: () => {
      if (crashAfter) {
        crashAfter = false;
        throw new Error("simulated ACK loss");
      }
    },
  });
  try {
    const stale = staleActivation(f.release.releaseId, "stale-ack-loss");
    crashAfter = true;
    // Commit happened, but caller sees transport-local failure.
    assert.deepEqual(f.runtime.control.activate(stale.meta, stale.input), {
      ok: false,
      error: "invalid_state",
    });
    // Exact replay returns the stored safe rejection without re-running state.
    assert.deepEqual(f.runtime.control.activate(stale.meta, stale.input), {
      ok: false,
      error: "stale_epoch",
    });
    f.closeRuntime();
    const row = commandRow(f.controlPath, "stale-ack-loss");
    assert.equal(row?.command_state, "completed");
    assert.match(String(row?.authority_context_digest), /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(String(row?.result_json)), {
      ok: false,
      error: "stale_epoch",
    });
  } finally {
    await f.close();
  }
});

test("rejection transaction crash before commit is absent, retry becomes complete", async () => {
  let crashBefore = false;
  const f = await fixture({
    beforeCommit: () => {
      if (crashBefore) {
        crashBefore = false;
        throw new Error("simulated pre-commit crash");
      }
    },
  });
  try {
    const stale = staleActivation(f.release.releaseId, "stale-before-commit");
    crashBefore = true;
    assert.deepEqual(f.runtime.control.activate(stale.meta, stale.input), {
      ok: false,
      error: "invalid_state",
    });
    f.closeRuntime();
    assert.equal(commandRow(f.controlPath, "stale-before-commit"), undefined);
    const restarted = f.reopen();
    assert.deepEqual(restarted.control.activate(stale.meta, stale.input), {
      ok: false,
      error: "stale_epoch",
    });
    f.closeRuntime();
    assert.equal(
      commandRow(f.controlPath, "stale-before-commit")?.command_state,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("current disclosure authorization gates exact replay and payload conflict", async () => {
  let admit = true;
  let disclose = true;
  const f = await fixture(
    {},
    {
      authorizeCommandAdmission: () =>
        admit ? { ok: true, value: null } : { ok: false, error: "forbidden" },
      authorizeCommandDisclosure: () =>
        disclose
          ? { ok: true, value: null }
          : { ok: false, error: "forbidden" },
    },
  );
  try {
    const denied = staleActivation(f.release.releaseId, "scope-denied", 2);
    admit = false;
    assert.deepEqual(f.runtime.control.activate(denied.meta, denied.input), {
      ok: false,
      error: "forbidden",
    });
    // Conflict must not disclose that the key exists while current read auth fails.
    disclose = false;
    const changed = staleActivation(f.release.releaseId, "scope-denied", 3);
    assert.deepEqual(f.runtime.control.activate(changed.meta, changed.input), {
      ok: false,
      error: "forbidden",
    });
    assert.deepEqual(f.runtime.control.activate(denied.meta, denied.input), {
      ok: false,
      error: "forbidden",
    });

    // Once authorized, exact replay reveals the stored rejection; changed
    // payload reveals only the typed idempotency conflict.
    disclose = true;
    assert.deepEqual(f.runtime.control.activate(denied.meta, denied.input), {
      ok: false,
      error: "forbidden",
    });
    assert.deepEqual(f.runtime.control.activate(changed.meta, changed.input), {
      ok: false,
      error: "idempotency_conflict",
    });
    f.closeRuntime();
    assert.equal(
      commandRow(f.controlPath, "scope-denied")?.command_state,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("malformed command metadata remains unregistered", async () => {
  const f = await fixture();
  try {
    const stale = staleActivation(f.release.releaseId, "malformed-no-row");
    assert.deepEqual(
      f.runtime.control.activate(
        { ...stale.meta, payloadDigest: "0".repeat(64) },
        stale.input,
      ),
      { ok: false, error: "invalid_input" },
    );
    f.closeRuntime();
    assert.equal(commandRow(f.controlPath, "malformed-no-row"), undefined);
  } finally {
    await f.close();
  }
});
