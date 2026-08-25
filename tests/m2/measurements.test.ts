import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const metricIds = [
  "T_ready",
  "C_platform",
  "C_enable",
  "glue_LOC",
  "cold_start",
  "idle_RSS",
  "peak_RSS",
  "disk",
  "process_count",
  "TCO_12_month",
] as const;

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

test("M2 measurement roots cover every delivered component and terminal Mastra N/A", async () => {
  const [evidence, ledger, disposition] = await Promise.all([
    readJson("measurements/evidence.json"),
    readJson("measurements/ledger.json"),
    readJson("evidence/m2-mastra-preflight.json"),
  ]);
  const source = evidence.sources.m2ControlSlice;
  assert.deepEqual(source.environment, {
    os: "darwin",
    architecture: "arm64",
    node: "v22.23.1",
    productionEligible: false,
  });
  assert.equal(source.sharedPlatform.personHours, 28.5);
  assert.equal(source.sharedPlatform.personMilliseconds, 102_600_000);
  assert.deepEqual(source.appendIntegrity, {
    historicalRecordsPreserved: 132,
    historicalPrefixSha256:
      "03b9aa0f773889c119f5a2ea41cf94c8367a5d497d180a08cff4ebc3d729485f",
    recordsAppended: 63,
    totalRecords: 195,
  });

  for (const name of ["pi", "server", "cli", "web", "telegram"]) {
    const component = source.components[name];
    assert.equal(component.status, "measured", name);
    for (const field of [
      "boundaries",
      "deployment",
      "exitCost",
      "licenseBoundary",
      "selfHostedManaged",
      "tcoScope",
      "sourceScope",
    ])
      assert.ok(component[field], `${name}.${field}`);
    const records = ledger.records.filter(
      ({ environmentId }: { environmentId: string }) =>
        environmentId === component.environmentId,
    );
    assert.deepEqual(
      [
        ...new Set(
          records.map(({ metricId }: { metricId: string }) => metricId),
        ),
      ].sort(),
      [...metricIds].sort(),
      name,
    );
    for (const metricId of metricIds) {
      const chain = records.filter(
        (record: { metricId: string }) => record.metricId === metricId,
      );
      assert.equal(
        chain.filter(
          ({ supersedesRecordId }: { supersedesRecordId: unknown }) =>
            supersedesRecordId === null,
        ).length,
        1,
        `${name}.${metricId}.root`,
      );
      const latest = chain.find(
        ({ recordId }: { recordId: string }) =>
          !chain.some(
            ({ supersedesRecordId }: { supersedesRecordId: string | null }) =>
              supersedesRecordId === recordId,
          ),
      );
      assert.deepEqual(
        latest?.value,
        component.metricCorrections?.[metricId]?.value ??
          component.metrics[metricId],
        `${name}.${metricId}`,
      );
    }
  }

  const mastra = source.components.mastra;
  assert.equal(mastra.status, "N/A");
  assert.equal(mastra.disposition, "retain-harness-pi");
  assert.equal(mastra.dispositionEvidence, "evidence/m2-mastra-preflight.json");
  assert.equal(disposition.disposition, "retain-harness-pi");
  assert.ok(Object.values(mastra.metrics).every((value) => value === "N/A"));
  const mastraRecords = ledger.records.filter(
    ({ environmentId }: { environmentId: string }) =>
      environmentId === mastra.environmentId,
  );
  assert.equal(mastraRecords.length, metricIds.length);
  assert.ok(
    mastraRecords.every(
      ({ value, quality }: { value: unknown; quality: string }) =>
        value === "N/A" && quality === "not-run-terminal-retain-harness-pi",
    ),
  );
});
