import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { evaluateRecoveryRaceCells } from "../../scripts/validate-m0.mjs";

const matrixUrl = new URL(
  "../../oracles/m0/fault-matrix.json",
  import.meta.url,
);
const contractsUrl = new URL(
  "../../oracles/m0/recovery-race-contracts.json",
  import.meta.url,
);
const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function artifacts() {
  return Promise.all(
    [matrixUrl, contractsUrl].map((url) =>
      readFile(url, "utf8").then(JSON.parse),
    ),
  );
}

test.scenarios(
  ["m0o.fault-matrix.case-b9d6b63610c48b96"],
  "recovery race points define the complete Cartesian product",
  async () => {
    const [[matrix, contracts], aggregate] = await Promise.all([
      artifacts(),
      readFile(gatesUrl, "utf8").then(JSON.parse),
    ]);
    const denominator = aggregate.frozenDenominator;
    assert.equal(
      matrix.recoveryRacePoints.length * matrix.dispositions.length,
      denominator.recoveryRaceCells,
    );
    assert.deepEqual(matrix.dispositions, [
      "crash-before",
      "crash-after",
      "response-loss",
      "competing-command",
    ]);
    assert.equal(
      matrix.recoveryRaceCells.length,
      denominator.recoveryRaceCells,
    );
    const pairs = new Set(
      matrix.recoveryRaceCells.map(
        ({ recoveryRacePoint, disposition }) =>
          `${recoveryRacePoint}\0${disposition}`,
      ),
    );
    assert.equal(pairs.size, denominator.recoveryRaceCells);
    assert.equal(
      new Set(matrix.recoveryRaceCells.map(({ caseId }) => caseId)).size,
      denominator.recoveryRaceCells,
    );
    assert.equal(
      new Set(matrix.recoveryRaceCells.map(({ requiredGate }) => requiredGate))
        .size,
      denominator.recoveryRaceCells,
    );
    assert.ok(
      matrix.recoveryRaceCells.every(
        ({ candidateExecutionRequired, excluded }) =>
          candidateExecutionRequired && !excluded,
      ),
    );
    assert.ok(
      matrix.recoveryRaceCells.every((cell) => !("expected" in cell)),
      "the typed per-cell contract is the only race expectation owner",
    );
    assert.equal(
      contracts.results.filter(
        ({ disposition, observation }) =>
          disposition !== "crash-before" &&
          observation.mutationAuthorityCallCount === 0,
      ).length,
      24,
    );
    assert.equal(
      matrix.recoveryRaceCellDigest,
      sha256(JSON.stringify(matrix.recoveryRaceCells)),
    );
    const evaluation = evaluateRecoveryRaceCells(matrix, contracts);
    assert.deepEqual(evaluation.findings, []);
    assert.equal(evaluation.results.size, denominator.recoveryRaceCells);
    assert.ok(
      [...evaluation.results.values()].every(
        ({ basis, definitionStatus, kind }) =>
          basis === "definition" &&
          definitionStatus === "definition-valid" &&
          kind === "pass",
      ),
    );
  },
);

test.scenarios(
  ["m0o.fault-matrix.case-be01590a4db2a18e"],
  "recomputed garbage recovery expectations cannot pass",
  async () => {
    const [matrix, contracts] = await artifacts();
    const garbage = structuredClone(contracts);
    garbage.results[0].observation.externalState = "garbage";
    garbage.resultSetDigest = sha256(JSON.stringify(garbage.results));
    const evaluation = evaluateRecoveryRaceCells(matrix, garbage);
    assert.notEqual(
      evaluation.results.get(`recovery-race:${garbage.results[0].caseId}`).kind,
      "pass",
    );
  },
);

test.scenarios(
  ["m0o.fault-matrix.case-1c1a29207a85d888"],
  "generic race expectations and exact authority-call contradictions fail",
  async () => {
    const [matrix, contracts] = await artifacts();
    const redundant = structuredClone(matrix);
    redundant.recoveryRaceCells[0].expected = {
      mutationAuthorityCallObserved: true,
    };
    redundant.recoveryRaceCellDigest = sha256(
      JSON.stringify(redundant.recoveryRaceCells),
    );
    assert.notEqual(
      evaluateRecoveryRaceCells(redundant, contracts).results.get(
        `recovery-race:${redundant.recoveryRaceCells[0].caseId}`,
      ).kind,
      "pass",
    );

    const contradictory = structuredClone(contracts);
    const zeroCall = contradictory.results.find(
      ({ disposition, observation }) =>
        disposition !== "crash-before" &&
        observation.mutationAuthorityCallCount === 0,
    );
    zeroCall.observation.mutationAuthorityCallCount = 1;
    contradictory.resultSetDigest = sha256(
      JSON.stringify(contradictory.results),
    );
    assert.notEqual(
      evaluateRecoveryRaceCells(matrix, contradictory).results.get(
        `recovery-race:${zeroCall.caseId}`,
      ).kind,
      "pass",
    );

    const renamed = structuredClone(matrix);
    const renamedContracts = structuredClone(contracts);
    const originalPoint = renamed.recoveryRacePoints[0];
    const replacementPoint = `${originalPoint}-renamed`;
    renamed.recoveryRacePoints[0] = replacementPoint;
    for (const cell of renamed.recoveryRaceCells)
      if (cell.recoveryRacePoint === originalPoint)
        cell.recoveryRacePoint = replacementPoint;
    renamed.recoveryRaceCellDigest = sha256(
      JSON.stringify(renamed.recoveryRaceCells),
    );
    renamedContracts.pointContracts[0].id = replacementPoint;
    for (const result of renamedContracts.results)
      if (result.recoveryRacePoint === originalPoint)
        result.recoveryRacePoint = replacementPoint;
    renamedContracts.resultSetDigest = sha256(
      JSON.stringify(renamedContracts.results),
    );
    assert.ok(
      evaluateRecoveryRaceCells(renamed, renamedContracts).findings.length > 0,
    );
  },
);
