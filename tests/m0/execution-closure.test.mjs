import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { resolveExecutionClosure } from "../../scripts/validate-m0.mjs";

const closureUrl = new URL(
  "../../contracts/v2/release/execution-closure.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2c.release-identity.case-e494a1dffa986843"
  ],
  "ExecutionClosure resolution table and vectors fail closed", async () => {
  const manifest = JSON.parse(await readFile(closureUrl, "utf8"));
  assert.deepEqual(
    manifest.resolutionTable.map(({ edgeType }) => edgeType),
    [
      "static-module",
      "package",
      "native-artifact",
      "dynamic-import",
      "dynamic-require",
      "plugin",
      "loader",
      "subprocess",
    ],
  );
  for (const row of manifest.resolutionTable)
    assert.equal(row.requiresPinnedTarget, true);
  for (const vector of manifest.vectors) {
    if (vector.expected === "accepted") {
      assert.deepEqual(
        resolveExecutionClosure(vector.graph),
        vector.expectedClosure,
        vector.id,
      );
    } else {
      assert.throws(
        () => resolveExecutionClosure(vector.graph),
        (error) => error?.code === vector.expectedError,
        vector.id,
      );
    }
  }
});

test.scenarios(
  [
    "v2c.release-identity.case-534d149bf165353d"
  ],
  "closure byte drift and undeclared members cannot launch", async () => {
  const manifest = JSON.parse(await readFile(closureUrl, "utf8"));
  assert.notEqual(
    manifest.byteDriftVector.expectedDigest,
    manifest.byteDriftVector.observedDigest,
  );
  assert.equal(manifest.byteDriftVector.expected, "closure_digest_mismatch");

  const accepted = structuredClone(
    manifest.vectors.find(({ id }) => id === "static-transitive").graph,
  );
  accepted.members.push({
    id: "unreachable",
    mode: "module",
    digest: "f".repeat(64),
    dependencies: [],
  });
  assert.throws(
    () => resolveExecutionClosure(accepted),
    (error) => error?.code === "closure_member_unreachable",
  );

  accepted.members.pop();
  accepted.members[1].digest = "e".repeat(64);
  assert.throws(
    () => resolveExecutionClosure(accepted),
    (error) => error?.code === "closure_digest_mismatch",
  );
});

test("unknown execution edge kinds are rejected", () => {
  const digest = "a".repeat(64);
  assert.throws(
    () =>
      resolveExecutionClosure({
        entryId: "entry",
        members: [
          {
            id: "entry",
            mode: "legacy-process",
            digest,
            dependencies: [
              {
                type: "future-loader",
                target: "child",
                resolution: "pinned",
                expectedDigest: digest,
              },
            ],
          },
          { id: "child", mode: "child-executable", digest, dependencies: [] },
        ],
      }),
    (error) => error?.code === "closure_member_unresolved",
  );
});
