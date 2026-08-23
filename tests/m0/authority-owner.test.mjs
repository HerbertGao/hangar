import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "./scenario-owner.mjs";

const root = new URL("../../", import.meta.url);
const mapUrl = new URL("../../oracles/m0/authority-map.json", import.meta.url);
const gatesUrl = new URL(
  "../../oracles/m0/aggregate-gates.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function filesBelow(path) {
  const absolute = join(root.pathname, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(relative)));
    else files.push(relative);
  }
  return files;
}

test.scenarios(
  ["m0o.format.case-ee5bd570739cae05"],
  "Requirement and Scenario authority mapping is complete and unique",
  async () => {
    const [authority, aggregate] = await Promise.all([
      readFile(mapUrl, "utf8").then(JSON.parse),
      readFile(gatesUrl, "utf8").then(JSON.parse),
    ]);
    const denominator = aggregate.frozenDenominator;
    assert.equal(authority.requirements.length, denominator.requirements);
    assert.equal(
      authority.requirements.reduce(
        (sum, requirement) => sum + requirement.scenarios.length,
        0,
      ),
      denominator.scenarios,
    );

    const requirementIds = new Set();
    const requirementTitles = new Set();
    const scenarioIds = new Set();
    const scenarioTitles = new Set();
    const slugs = new Set();
    const requirementSet = [];
    const scenarioSet = [];
    for (const requirement of authority.requirements) {
      assert.ok(!requirementIds.has(requirement.requirementId));
      assert.ok(!requirementTitles.has(requirement.title));
      requirementIds.add(requirement.requirementId);
      requirementTitles.add(requirement.title);
      requirementSet.push({
        requirementId: requirement.requirementId,
        title: requirement.title,
      });

      for (const scenario of requirement.scenarios) {
        assert.match(scenario.slug, /^case-[0-9a-f]{16}$/);
        assert.equal(
          scenario.scenarioId,
          `${requirement.requirementId}.${scenario.slug}`,
        );
        assert.ok(authority.coverageClasses.includes(scenario.coverageClass));
        assert.ok(!scenarioIds.has(scenario.scenarioId));
        assert.ok(!slugs.has(scenario.slug));
        assert.ok(
          !scenarioTitles.has(
            `${requirement.requirementId}\0${scenario.title}`,
          ),
        );
        scenarioIds.add(scenario.scenarioId);
        slugs.add(scenario.slug);
        scenarioTitles.add(`${requirement.requirementId}\0${scenario.title}`);
        scenarioSet.push({
          scenarioId: scenario.scenarioId,
          requirementId: requirement.requirementId,
          title: scenario.title,
          coverageClass: scenario.coverageClass,
        });
      }
    }
    assert.equal(
      authority.requirementSetDigest,
      sha256(JSON.stringify(requirementSet)),
    );
    assert.equal(
      authority.scenarioSetDigest,
      sha256(JSON.stringify(scenarioSet)),
    );

    const referenceFiles = [
      "CLAUDE.md",
      "DESIGN.md",
      "ROADMAP.md",
      ...(await filesBelow("contracts/v2")),
      ...(await filesBelow("oracles/m0")),
    ];
    for (const path of referenceFiles) {
      const text = await readFile(join(root.pathname, path), "utf8");
      for (const match of text.matchAll(
        /(?:^|[^a-z0-9.-])((?:v2c|v2s|m0o)\.[a-z0-9-]+)/g,
      ))
        assert.ok(
          requirementIds.has(match[1]),
          `unresolved ${match[1]} in ${basename(path)}`,
        );
    }
  },
);
