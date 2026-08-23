import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  externalValidatorManifestValid,
  runExternalValidator,
} from "../../scripts/validate-m0.mjs";

const validatorsUrl = new URL(
  "../../oracles/m0/external-validators.json",
  import.meta.url,
);

function nodeDefinition(code, patch = {}) {
  return {
    id: "fixture",
    command: "node",
    args: ["-e", code],
    timeoutMs: 1000,
    success: { exitStatus: 0, jsonPath: ["valid"], equals: true },
    failureKind: "contract_failure",
    spawnFailureKind: "prerequisite_missing",
    timeoutKind: "evidence_failure",
    malformedOutputKind: "invalid_invocation",
    suppressRawSuccessText: true,
    ...patch,
  };
}

test("strict OpenSpec external validator is captured as one typed pass", async () => {
  const manifest = JSON.parse(await readFile(validatorsUrl, "utf8"));
  const result = runExternalValidator(manifest.validators[0]);
  assert.equal(result.kind, "pass", JSON.stringify(result.findings));
  assert.equal(result.executed, true);
  assert.ok(result.execution.stdoutDigest);
  assert.ok(!("stdout" in result.execution));
  assert.equal(externalValidatorManifestValid(manifest), true);
  const injected = structuredClone(manifest);
  injected.validators[0].command = "node";
  injected.validators[0].args = ["tests/m0/scenario-gates.mjs"];
  assert.equal(externalValidatorManifestValid(injected), false);
});

test.scenarios(
  ["m0o.reproducibility.case-1ec16be1f59ecc47"],
  "raw success text, malformed output, nonzero exit, timeout, and spawn failure never pass",
  () => {
    const noisy = runExternalValidator(
      nodeDefinition(
        "console.log('PASS'); console.log(JSON.stringify({valid:true}))",
      ),
    );
    assert.equal(noisy.kind, "invalid_invocation");
    const malformed = runExternalValidator(
      nodeDefinition("console.log('not-json')"),
    );
    assert.equal(malformed.kind, "invalid_invocation");
    const nonzero = runExternalValidator(
      nodeDefinition(
        "console.log(JSON.stringify({valid:true})); process.exit(1)",
      ),
    );
    assert.equal(nonzero.kind, "contract_failure");
    const timeout = runExternalValidator(
      nodeDefinition("setTimeout(()=>{}, 1000)", { timeoutMs: 20 }),
    );
    assert.equal(timeout.kind, "evidence_failure");
    const missing = runExternalValidator({
      ...nodeDefinition(""),
      command: "definitely-missing-validator",
    });
    assert.equal(missing.kind, "prerequisite_missing");
    for (const result of [noisy, malformed, nonzero, timeout, missing]) {
      assert.ok(!JSON.stringify(result).includes("M0 advisory: READY"));
    }
  },
);
