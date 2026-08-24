import { createHash } from "node:crypto";

import { canonicalJson, type AgentRelease } from "../contracts/index.ts";
import type { PromptRequest } from "../pi-child-protocol/index.ts";

export interface ExpectedArtifact {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface ExpectedArtifactDeriver {
  derive(
    release: AgentRelease,
    intentId: string,
    request: PromptRequest,
  ): ExpectedArtifact;
}

const artifact = (value: unknown): ExpectedArtifact => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};

export const HEARTBEAT_EXPECTED_ARTIFACT: ExpectedArtifactDeriver = {
  derive: (release, intentId, request) =>
    artifact({
      schemaVersion: "heartbeat-artifact-v1",
      agentId: release.spec.agentId,
      intentId,
      inputDigest: request.inputDigest,
      heartbeat: "ok",
    }),
};

export const REPO_INSPECTOR_EXPECTED_ARTIFACT: ExpectedArtifactDeriver = {
  derive: (release, intentId, request) =>
    artifact({
      schemaVersion: "repo-inspector-artifact-v1",
      agentId: release.spec.agentId,
      intentId,
      inputDigest: request.inputDigest,
      files: request.virtualCorpus
        .map(({ relativePath, digest, bytes }) => ({
          relativePath,
          digest,
          bytes: bytes.byteLength,
        }))
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        ),
    }),
};
