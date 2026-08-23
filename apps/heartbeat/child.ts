import { spawn } from "node:child_process";

import { readHeartbeatArtifact } from "./tool.ts";

const [mode, inputDigest = ""] = process.argv.slice(2);

if (mode === "leaf") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", (chunk) => {
    if (chunk.trim() !== "GO") process.exit(2);
    if (mode === "fake") {
      const artifactDigest = readHeartbeatArtifact();
      process.stdout.write(
        `${JSON.stringify({
          type: "action",
          actionId: "heartbeat-action",
          inputDigest,
        })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({
          type: "tool-observation",
          actionId: "heartbeat-action",
          toolId: "tool.read",
          outputDigest: artifactDigest,
        })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({
          type: "outcome-proposal",
          artifactDigest,
        })}\n`,
      );
    } else if (mode === "legacy-process") {
      process.stdout.write(
        `HEARTBEAT ${inputDigest} ${readHeartbeatArtifact()}\n`,
      );
    } else if (mode === "tree") {
      const leaf = spawn(process.execPath, [process.argv[1], "leaf"], {
        detached: false,
        stdio: "ignore",
        env: {},
      });
      spawn(process.execPath, [process.argv[1], "leaf"], {
        detached: false,
        stdio: "ignore",
        env: {},
      });
      process.stdout.write(
        `${JSON.stringify({ type: "tree", leafPid: leaf.pid })}\n`,
      );
      setInterval(() => {}, 60_000);
    } else {
      process.stderr.write("fixture failure\n");
      process.exit(3);
    }
  });
}
