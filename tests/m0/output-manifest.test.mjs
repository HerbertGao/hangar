import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

const root = new URL("../../", import.meta.url);
const outputUrl = new URL(
  "../../oracles/m0/output-manifest.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function filesBelow(path) {
  const files = [];
  for (const entry of await readdir(join(root.pathname, path), {
    withFileTypes: true,
  })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(relative)));
    else files.push(relative);
  }
  return files;
}

test.scenarios(
  ["m0o.reproducibility.case-4704830eebf87e0f"],
  "output manifest enumerates every and only declared M0 artifact",
  async () => {
    const manifest = JSON.parse(await readFile(outputUrl, "utf8"));
    const actual = [
      ...(await filesBelow("contracts/v2")),
      ...(await filesBelow("oracles/m0")),
      ...(await filesBelow("measurements")),
      ...(await filesBelow("tests/m0")),
      "scripts/validate-m0.mjs",
    ].sort();
    assert.deepEqual(
      manifest.outputs.map(({ path }) => path),
      actual,
    );
    assert.equal(new Set(actual).size, actual.length);
    for (const retired of [
      "oracles/m0/fixture-plan.json",
      "tests/m0/fixture-runner.mjs",
      "tests/m0/scenario-gates.mjs",
      "measurements/scenario-assertion-authority-review.json",
    ])
      assert.equal(actual.includes(retired), false, retired);
    for (const output of manifest.outputs) {
      assert.ok(
        ["contract", "oracle", "measurement", "validator", "test"].includes(
          output.category,
        ),
      );
      if (output.path === "oracles/m0/output-manifest.json") {
        assert.equal(output.digestPolicy, "self-schema-only");
      } else {
        assert.equal(
          output.sha256,
          sha256(await readFile(join(root.pathname, output.path))),
          output.path,
        );
      }
    }
    assert.equal("planningMembers" in manifest, false);
    assert.equal("planningDigest" in manifest, false);
    assert.ok(
      actual.includes("measurements/scenario-assertion-authority-summary.json"),
    );
    assert.equal(manifest.sourceManifestPath, "oracles/m0/sources.json");
    assert.equal(
      manifest.sourceManifestDigest,
      sha256(await readFile(join(root.pathname, manifest.sourceManifestPath))),
    );
  },
);
