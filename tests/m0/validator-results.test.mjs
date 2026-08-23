import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  aggregateGateResults,
  checkAll,
  formatAllOutput,
} from "../../scripts/validate-m0.mjs";

const resultUrl = new URL(
  "../../oracles/m0/result-schema.json",
  import.meta.url,
);
const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);

test("only complete aggregate pass formats the exact success token", async () => {
  const schema = JSON.parse(await readFile(resultUrl, "utf8"));
  assert.equal(schema.completePassToken, "M0 advisory: READY");
  assert.deepEqual(schema.gateResultBases, [
    "local",
    "external",
    "definition",
    "aggregate",
  ]);
  const pass = await checkAll();
  assert.equal(pass.kind, "pass");
  assert.equal(Object.isFrozen(pass), true);
  assert.equal(Object.isFrozen(pass.aggregateResult.findings), true);
  assert.throws(() => {
    pass.kind = "contract_failure";
  }, TypeError);
  assert.equal(formatAllOutput(pass), `${schema.completePassToken}\n`);
  const forged = structuredClone(pass);
  forged.aggregateResult.findings[12].candidateObservation = { pass: true };
  assert.notEqual(formatAllOutput(forged), `${schema.completePassToken}\n`);
  const plain = structuredClone(pass);
  assert.notEqual(formatAllOutput(plain), `${schema.completePassToken}\n`);
  const failure = {
    ...plain,
    kind: "contract_failure",
    aggregateResult: { primaryKind: "contract_failure", findings: [] },
  };
  const formatted = formatAllOutput(failure);
  assert.notEqual(formatted, `${schema.completePassToken}\n`);
  assert.equal(JSON.parse(formatted).kind, "contract_failure");
});

test("aggregate findings retain manifest order and strict OpenSpec is required", async () => {
  const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
  assert.ok(
    manifest.gates.some(
      ({ id, members }) =>
        id === "external.openspec-strict" &&
        members[0] === "external:openspec-strict",
    ),
  );
  const results = manifest.gates.map(({ id, type }) => {
    const basis =
      type === "local-subcommand"
        ? "local"
        : type === "external-validator"
          ? "external"
          : "definition";
    return {
      gateId: id,
      executed: true,
      kind: "pass",
      basis,
      ...(basis === "external"
        ? {
            execution: {
              exitStatus: 0,
              signal: null,
              stdoutDigest: "a".repeat(64),
              stderrDigest: "b".repeat(64),
            },
          }
        : {}),
      findings: [],
    };
  });
  const output = aggregateGateResults(manifest, results);
  assert.equal(output.primaryKind, "pass");
  assert.deepEqual(
    output.findings.map(({ gateId }) => gateId),
    manifest.gates.map(({ id }) => id),
  );
});

test.scenarios(
  ["m0o.reproducibility.case-3ac58b3cb06fae04"],
  "unrun causative kinds participate in exit-code precedence",
  async () => {
    const schema = JSON.parse(await readFile(resultUrl, "utf8"));
    assert.deepEqual(schema.exitCodes, {
      pass: 0,
      contract_failure: 1,
      evidence_failure: 1,
      prerequisite_missing: 2,
      missing_source: 2,
      invalid_invocation: 2,
    });
    assert.equal(schema.exitCodes[schema.kindPrecedence[0]], 2);
  },
);
