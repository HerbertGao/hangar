import { randomUUID } from "node:crypto";

import type { ParentToChildMessage } from "../../packages/pi-child-protocol/index.ts";
import { createIsolatedPiSession } from "../../packages/pi-harness/sdk-session.ts";
import {
  PiChildRuntime,
  SdkSessionDriver,
} from "../../packages/pi-harness/session-driver.ts";
import { VirtualCorpus } from "../../packages/pi-harness/virtual-corpus.ts";

const send = (message: unknown): void => {
  if (!process.send) throw new Error("missing_dedicated_ipc");
  process.send(message);
};

const runtime = new PiChildRuntime(async (request) => {
  const corpus = new VirtualCorpus(
    request.virtualCorpus.map((entry) => ({
      ...entry,
      kind: "regular" as const,
    })),
  );
  const isolated = await createIsolatedPiSession(corpus);
  return new SdkSessionDriver(isolated.session);
}, send);

try {
  // Positive startup proof uses the same public SDK factory, but never prompts.
  const probe = await createIsolatedPiSession(new VirtualCorpus([]));
  probe.session.dispose();
  runtime.childReady(randomUUID());
} catch (error) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(error instanceof Error ? error.name : "startup"),
  );
  send({
    schemaVersion: "hangar-pi-ipc-v1",
    type: "protocol-fault",
    faultKind: "tool-fault",
    diagnosticDigest: Buffer.from(digest).toString("hex"),
  });
  process.exitCode = 1;
}

process.on("message", (message: unknown) => {
  // SAFETY: PiChildRuntime immediately routes this value through the closed
  // parent-frame Zod/state boundary before reading any arm fields.
  void runtime.handle(message as ParentToChildMessage);
});

process.on("disconnect", () => {
  runtime.dispose();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runtime.dispose();
  process.exit(0);
});
