import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  recoveryEvidenceHarness,
  targetClosureClaims,
  verifyClaims,
} from "./recovery-evidence-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.restore.case-d680f1a82c9712d0"
  ],
  "TargetAuthorityClosed evidence compares complete signed claims with the current registry snapshot", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const harness = await recoveryEvidenceHarness();
  const claims = targetClosureClaims();
  const verified = verifyClaims(harness, "target-authority-closed", claims, {
    currentPatch: { nowUtcMs: 60 },
  });
  assert.equal(verified.kind, "VerifiedEvidence");

  for (const field of manifest.targetAuthorityClosed.requiredProof) {
    const incomplete = targetClosureClaims({
      evidenceId: `missing-${field}`,
    });
    delete incomplete[field];
    assert.throws(() =>
      verifyClaims(harness, "target-authority-closed", incomplete, {
        currentPatch: { nowUtcMs: 60 },
      }),
    );
  }
  assert.throws(
    () =>
      verifyClaims(
        harness,
        "target-authority-closed",
        targetClosureClaims({ evidenceId: "wrong-target-proof" }),
        {
          expectedPatch: {
            targetControlInstanceId: "target-2",
            casIdentity: "database-1:target-2",
          },
          currentPatch: { nowUtcMs: 60 },
        },
      ),
    (error) => error?.code === "evidence_context_mismatch",
  );
  assert.throws(
    () =>
      verifyClaims(
        harness,
        "target-authority-closed",
        targetClosureClaims({ evidenceId: "stale-member-set-proof" }),
        {
          currentPatch: {
            nowUtcMs: 60,
            revokedMemberSetDigest: "f".repeat(64),
          },
        },
      ),
    (error) => error?.code === "stale_authority",
  );
  assert.equal(manifest.targetAuthorityClosed.irreversible, true);
  assert.equal(manifest.targetAuthorityClosed.replacesLocalAck, true);
  assert.equal(manifest.targetAuthorityClosed.targetProductionEverAgain, false);
});
