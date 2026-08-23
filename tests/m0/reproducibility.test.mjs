import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

import { checkPrerequisites } from "../../scripts/validate-m0.mjs";

const resultUrl = new URL(
  "../../oracles/m0/result-schema.json",
  import.meta.url,
);
const scopeUrl = new URL("../../contracts/v2/scope.json", import.meta.url);

test.scenarios(
  ["m0o.reproducibility.case-baf58ef8254d52b9"],
  "typed result kinds, precedence, and exit codes are closed",
  async () => {
    const manifest = JSON.parse(await readFile(resultUrl, "utf8"));
    assert.deepEqual(manifest.resultKinds, [
      "pass",
      "contract_failure",
      "evidence_failure",
      "prerequisite_missing",
      "missing_source",
      "invalid_invocation",
    ]);
    assert.deepEqual(manifest.kindPrecedence, [
      "invalid_invocation",
      "prerequisite_missing",
      "missing_source",
      "contract_failure",
      "evidence_failure",
      "pass",
    ]);
    assert.equal(manifest.passRequiresExecuted, true);
    assert.equal(manifest.unrunRequiresBlockedBy, true);
    assert.equal(manifest.aggregateOwner, "all");
  },
);

test("local subcommands emit typed JSON and never emit the aggregate PASS token", async () => {
  const resultManifest = JSON.parse(await readFile(resultUrl, "utf8"));
  const run = spawnSync("node", ["scripts/validate-m0.mjs", "prerequisites"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.kind, "pass");
  assert.notEqual(run.stdout.trim(), resultManifest.completePassToken);
});

test("prerequisite commands are verifier-owned", async () => {
  const source = new URL(
    "../../contracts/v2/prerequisites.json",
    import.meta.url,
  );
  const manifest = JSON.parse(await readFile(source, "utf8"));
  manifest.requirements[0].command = "node";
  manifest.requirements[0].versionArgs = ["-e", "process.exit(0)"];
  const directory = await mkdtemp(join(tmpdir(), "hangar-prerequisite-"));
  const path = join(directory, "prerequisites.json");
  try {
    await writeFile(path, JSON.stringify(manifest));
    const output = await checkPrerequisites(path);
    assert.equal(output.kind, "contract_failure");
    assert.ok(
      output.findings.some(
        ({ code }) => code === "prerequisite_constitution_mismatch",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenSpec is only an external validator", async () => {
  const [source, prerequisites] = await Promise.all([
    readFile(new URL("../../scripts/validate-m0.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../../contracts/v2/prerequisites.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.doesNotMatch(source, /openspec[\\/]/iu);
  assert.ok(prerequisites.requirements.every(({ id }) => id !== "openspec-cn"));
});

test("M0 scope adds no package manager dependency or product package", async () => {
  const scope = JSON.parse(await readFile(scopeUrl, "utf8"));
  assert.equal(scope.requirements.dependencies, false);
  assert.equal(scope.requirements.productPackages, false);
  assert.equal(scope.requirements.externalWrites, false);
});
