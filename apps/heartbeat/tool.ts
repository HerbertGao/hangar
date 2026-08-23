import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function readHeartbeatArtifact(): string {
  const fd = openSync(process.execPath, "r");
  try {
    const bytes = Buffer.alloc(4096);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    return createHash("sha256")
      .update("heartbeat.read\0")
      .update(String(fstatSync(fd).size))
      .update("\0")
      .update(bytes.subarray(0, length))
      .digest("hex");
  } finally {
    closeSync(fd);
  }
}
