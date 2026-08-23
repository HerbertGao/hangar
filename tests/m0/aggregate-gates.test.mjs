import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  aggregateGateResults,
  expectedAggregateGates,
} from "../../scripts/validate-m0.mjs";

const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);
const authorityUrl = new URL(
  "../../oracles/m0/authority-map.json",
  import.meta.url,
);
const casesUrl = new URL("../../oracles/m0/cases.json", import.meta.url);
const matrixUrl = new URL(
  "../../oracles/m0/fault-matrix.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const basisByType = {
  "local-subcommand": "local",
  "external-validator": "external",
  "requirement-definition": "definition",
  "scenario-definition": "definition",
  "closed-dimension-definition": "definition",
  "recovery-race-definition": "definition",
};
const pass = (gate) => {
  const basis = basisByType[gate.type];
  return {
    gateId: gate.id,
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
};

test("aggregate gate manifest is topological with unique gates and members", async () => {
  const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
  const seenGates = new Set();
  const seenMembers = new Set();
  for (const gate of manifest.gates) {
    assert.ok(!seenGates.has(gate.id));
    assert.ok(gate.dependsOn.every((dependency) => seenGates.has(dependency)));
    seenGates.add(gate.id);
    for (const member of gate.members) {
      assert.ok(!seenMembers.has(member));
      seenMembers.add(member);
    }
  }
  assert.equal(
    manifest.requiredMemberDigest,
    sha256(JSON.stringify([...seenMembers])),
  );
  assert.equal(
    manifest.gateOrderDigest,
    sha256(JSON.stringify(manifest.gates.map(({ id }) => id))),
  );
  assert.equal(
    manifest.gates.length,
    manifest.frozenDenominator.aggregateGates,
  );
  assert.equal(manifest.completePassToken, "M0 advisory: READY");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        manifest.gates.reduce((counts, gate) => {
          counts[gate.type] = (counts[gate.type] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([left], [right]) => left.localeCompare(right)),
    ),
    {
      "closed-dimension-definition":
        manifest.frozenDenominator.closedDimensionMembers,
      "external-validator": manifest.frozenDenominator.externalGates,
      "local-subcommand": manifest.frozenDenominator.localGates,
      "recovery-race-definition": manifest.frozenDenominator.recoveryRaceCells,
      "requirement-definition": manifest.frozenDenominator.requirements,
      "scenario-definition": manifest.frozenDenominator.scenarios,
    },
  );
});

test("gate type/id/member tuples derive from frozen definitions", async () => {
  const [manifest, authority, cases, matrix] = await Promise.all([
    readFile(gatesUrl, "utf8").then(JSON.parse),
    readFile(authorityUrl, "utf8").then(JSON.parse),
    readFile(casesUrl, "utf8").then(JSON.parse),
    readFile(matrixUrl, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(
    manifest.gates,
    expectedAggregateGates(
      authority,
      cases,
      matrix,
      manifest.frozenDenominator,
    ),
  );
  const swapped = structuredClone(manifest.gates);
  [swapped[12].type, swapped[13].type] = [swapped[13].type, swapped[12].type];
  assert.notDeepEqual(
    swapped,
    expectedAggregateGates(
      authority,
      cases,
      matrix,
      manifest.frozenDenominator,
    ),
  );
});

test("complete executed pass succeeds and any unrun gate without blocker is invalid", async () => {
  const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
  const complete = aggregateGateResults(
    manifest,
    manifest.gates.map((gate) => pass(gate)),
  );
  assert.equal(complete.primaryKind, "pass");
  assert.ok(
    complete.findings.every(
      ({ executed, kind }) => executed && kind === "pass",
    ),
  );
  assert.equal(
    aggregateGateResults(manifest, []).primaryKind,
    "invalid_invocation",
  );
});

test("aggregate rejects fixture basis for definition gates", async () => {
  const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
  const results = manifest.gates.map((gate) => pass(gate));
  const index = manifest.gates.findIndex(
    ({ type }) => type === "scenario-definition",
  );
  results[index].basis = "fixture";
  assert.equal(
    aggregateGateResults(manifest, results).primaryKind,
    "invalid_invocation",
  );
  const extras = manifest.gates.map((gate) => pass(gate));
  extras[index].candidateReceipt = { forged: true };
  assert.equal(
    aggregateGateResults(manifest, extras).primaryKind,
    "invalid_invocation",
  );
});

test("aggregate rejects pass-first severity supplied by its mutable manifest", async () => {
  const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
  manifest.kindPrecedence = [
    "pass",
    "evidence_failure",
    "contract_failure",
    "missing_source",
    "prerequisite_missing",
    "invalid_invocation",
  ];
  const results = manifest.gates.map((gate) => pass(gate));
  results[0] = {
    gateId: manifest.gates[0].id,
    executed: true,
    kind: "prerequisite_missing",
    basis: "local",
    findings: [{ code: "missing" }],
  };
  const output = aggregateGateResults(manifest, results);
  assert.equal(output.primaryKind, "invalid_invocation");
  assert.ok(
    output.findings.some(({ findings }) =>
      findings.some(({ code }) => code === "aggregate_manifest_invalid"),
    ),
  );
});

test.scenarios(
  ["m0o.reproducibility.case-96e26a5ef39b00d7"],
  "blockedBy chooses highest kind precedence then manifest order",
  () => {
    const manifest = {
      kindPrecedence: [
        "invalid_invocation",
        "prerequisite_missing",
        "missing_source",
        "contract_failure",
        "evidence_failure",
        "pass",
      ],
      gates: [
        {
          id: "a",
          type: "local-subcommand",
          members: ["a"],
          dependsOn: [],
        },
        {
          id: "b",
          type: "local-subcommand",
          members: ["b"],
          dependsOn: [],
        },
        {
          id: "c",
          type: "local-subcommand",
          members: ["c"],
          dependsOn: ["a", "b"],
        },
      ],
    };
    const output = aggregateGateResults(manifest, [
      {
        gateId: "a",
        executed: true,
        kind: "evidence_failure",
        basis: "local",
        findings: [],
      },
      {
        gateId: "b",
        executed: true,
        kind: "contract_failure",
        basis: "local",
        findings: [],
      },
    ]);
    assert.equal(output.primaryKind, "contract_failure");
    assert.deepEqual(output.findings[2], {
      gateId: "c",
      executed: false,
      kind: "contract_failure",
      findings: [],
      blockedBy: "b",
    });
  },
);

test.scenarios(
  ["m0o.reproducibility.case-fc380c34a21ceed1"],
  "a failed prerequisite blocks its dependent with the same kind",
  () => {
    const manifest = {
      kindPrecedence: [
        "invalid_invocation",
        "prerequisite_missing",
        "contract_failure",
        "pass",
      ],
      gates: [
        {
          id: "prerequisite",
          type: "local-subcommand",
          members: ["a"],
          dependsOn: [],
        },
        {
          id: "dependent",
          type: "local-subcommand",
          members: ["b"],
          dependsOn: ["prerequisite"],
        },
      ],
    };
    const output = aggregateGateResults(manifest, [
      {
        gateId: "prerequisite",
        executed: true,
        kind: "prerequisite_missing",
        basis: "local",
        findings: [],
      },
    ]);
    assert.deepEqual(output.findings[1], {
      gateId: "dependent",
      executed: false,
      kind: "prerequisite_missing",
      findings: [],
      blockedBy: "prerequisite",
    });
  },
);

test.scenarios(
  ["m0o.reproducibility.case-37a353c8dd03bb26"],
  "removing one declared aggregate member breaks the frozen digest",
  async () => {
    const manifest = JSON.parse(await readFile(gatesUrl, "utf8"));
    const members = manifest.gates.flatMap(({ members: owned }) => owned);
    assert.equal(
      sha256(JSON.stringify(members)),
      manifest.requiredMemberDigest,
    );
    members.pop();
    assert.notEqual(
      sha256(JSON.stringify(members)),
      manifest.requiredMemberDigest,
    );
  },
);

test("cycle/forward dependency and unexecuted pass are invalid invocation", () => {
  const cyclic = {
    kindPrecedence: ["invalid_invocation", "contract_failure", "pass"],
    gates: [
      {
        id: "a",
        type: "local-subcommand",
        members: ["a"],
        dependsOn: ["b"],
      },
      {
        id: "b",
        type: "local-subcommand",
        members: ["b"],
        dependsOn: ["a"],
      },
    ],
  };
  assert.equal(
    aggregateGateResults(cyclic, []).primaryKind,
    "invalid_invocation",
  );
  const simple = {
    kindPrecedence: cyclic.kindPrecedence,
    gates: [
      {
        id: "a",
        type: "local-subcommand",
        members: ["a"],
        dependsOn: [],
      },
    ],
  };
  assert.equal(
    aggregateGateResults(simple, [
      {
        gateId: "a",
        executed: false,
        kind: "pass",
        basis: "local",
        findings: [],
      },
    ]).primaryKind,
    "invalid_invocation",
  );
});
