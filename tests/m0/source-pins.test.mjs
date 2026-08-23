import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "./scenario-owner.mjs";

import { checkSources } from "../../scripts/validate-m0.mjs";

const manifestUrl = new URL("../../oracles/m0/sources.json", import.meta.url);

test("pinned SOT and Git-object source members are readable and unchanged", {
  timeout: 30_000,
}, async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.deepEqual(
    manifest.runtimeApps.map(({ id }) => id),
    ["heartbeat", "inbox"],
  );
  assert.ok(
    manifest.repositories.every(({ revision }) =>
      /^[0-9a-f]{40}$/.test(revision),
    ),
  );

  const output = await checkSources();
  assert.equal(output.kind, "pass", JSON.stringify(output.findings));
  assert.ok(output.checks.length > 0);
  assert.ok(output.checks.every(({ status }) => status === "ok"));
});

test("required SOT membership cannot be rehashed away", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  manifest.v2SotFiles = manifest.v2SotFiles.filter(
    ({ path }) => path !== "CLAUDE.md",
  );
  const directory = await mkdtemp(join(tmpdir(), "hangar-sot-membership-"));
  const path = join(directory, "sources.json");
  try {
    await writeFile(path, JSON.stringify(manifest));
    const output = await checkSources(path);
    assert.equal(output.kind, "missing_source");
    assert.ok(
      output.findings.some(
        ({ code }) => code === "source_constitution_mismatch",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.scenarios(
  ["m0o.reproducibility.case-e33f51b9983a4a44"],
  "an unavailable pinned revision returns missing_source",
  {
    timeout: 10_000,
  },
  async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    manifest.repositories[0].revision = "0".repeat(40);

    const directory = await mkdtemp(join(tmpdir(), "hangar-m0-sources-"));
    const path = join(directory, "sources.json");
    try {
      await writeFile(path, JSON.stringify(manifest));
      const output = await checkSources(path);
      assert.equal(output.kind, "missing_source");
      assert.deepEqual(
        output.findings
          .filter(({ code }) => code === "revision_unavailable")
          .map(({ subject }) => subject),
        [manifest.repositories[0].id],
      );
      const laterRepositoryIds = new Set(
        manifest.repositories.slice(1).map(({ id }) => id),
      );
      assert.ok(
        output.checks.every(
          ({ id }) =>
            !id.startsWith("source-set:") &&
            !id.startsWith("runtime-app:") &&
            ![...laterRepositoryIds].some(
              (repositoryId) => id === `repository:${repositoryId}`,
            ),
        ),
      );
      assert.ok(
        output.findings.every(
          ({ code, subject }) =>
            code !== "runtime_app_source_missing" &&
            !laterRepositoryIds.has(subject) &&
            ![...laterRepositoryIds].some((repositoryId) =>
              subject.startsWith(`${repositoryId}:`),
            ),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
