import { appendFile } from "node:fs/promises";

import { compileRelease } from "../../packages/contracts/index.ts";
import {
  commandMeta,
  createEffectGateway,
} from "../../packages/control-core/index.ts";
import { openSqliteControl } from "../../packages/control-store-sqlite/index.ts";

const [
  mode,
  databasePath,
  authorityPath,
  databaseIdentity,
  targetId,
  ...extra
] = process.argv.slice(2);
if (!databasePath || !authorityPath || !databaseIdentity || !targetId)
  process.exit(2);

const fence = { databaseIdentity, targetId, generation: 0 };

if (["precommit", "postcommit"].includes(mode)) {
  const runtime = openSqliteControl(databasePath, {
    authorityPath,
    fence,
    ...(mode === "precommit"
      ? { beforeCommit: () => process.kill(process.pid, "SIGKILL") }
      : { afterCommitBeforeAck: () => process.kill(process.pid, "SIGKILL") }),
  });
  const release = compileRelease(
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
  const result = runtime.control.publish(
    commandMeta(
      "m1-worker",
      "publish-release",
      release.releaseId,
      "fault-command",
      release,
    ),
    release,
  );
  runtime.close();
  process.exit(result.ok ? 0 : 1);
} else if (mode === "effect-crash") {
  const [runId, effectId, externalMarker] = extra;
  if (!runId || !effectId || !externalMarker) process.exit(2);
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", (chunk) => {
    if (chunk.trim() !== "GO") process.exit(2);
    void (async () => {
      const store = openSqliteControl(databasePath, { authorityPath, fence });
      const gateway = createEffectGateway(store.control);
      await gateway.dispatch(
        {
          start: commandMeta(
            "m1-effect-worker",
            "dispatch-effect",
            runId,
            "dispatch",
            { runId, effectId },
          ),
          outcome: commandMeta(
            "m1-effect-worker",
            "record-effect-outcome",
            runId,
            "outcome",
            { runId, effectId },
          ),
          unknown: commandMeta(
            "m1-effect-worker",
            "mark-effect-unknown",
            runId,
            "unknown",
            { runId, effectId },
          ),
        },
        runId,
        effectId,
        async () => {
          await appendFile(externalMarker, "committed\n");
          process.kill(process.pid, "SIGKILL");
          return "committed";
        },
      );
      store.close();
      process.exit(1);
    })();
  });
} else {
  process.exit(2);
}
