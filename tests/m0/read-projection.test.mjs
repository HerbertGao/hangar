import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const projectionsUrl = new URL(
    "../../contracts/v2/control/projections.json",
    import.meta.url,
);

function authorize(manifest, familyId, scopes) {
    const family = manifest.families.find(({ id }) => id === familyId);
    if (!family) return false;
    const granted = new Set(scopes);
    return family.requiredScopes.every((scope) => granted.has(scope));
}

test("projection families and read scopes are closed", async () => {
    const manifest = JSON.parse(await readFile(projectionsUrl, "utf8"));
    assert.deepEqual(
        manifest.families.map(({ id }) => id),
        [
            "agent",
            "release",
            "activation",
            "run",
            "attempt",
            "event",
            "approval",
            "effect",
            "health",
            "recovery",
            "command-result",
        ],
    );
    assert.ok(
        manifest.families.every(
            ({ requiredScopes }) => requiredScopes.length > 0,
        ),
    );
    assert.equal(manifest.unknownFamilyPolicy, "reject");
    assert.equal(manifest.unknownViewPolicy, "reject");
    assert.equal(manifest.unknownScopePolicy, "reject");
});

test.scenarios(
  [
    "v2c.control-boundary.case-486639fde4261c9e",
    "v2c.control-boundary.case-a580797d2bbf9851"
  ],
  "unknown families and missing scopes fail closed", async () => {
    const manifest = JSON.parse(await readFile(projectionsUrl, "utf8"));
    assert.equal(authorize(manifest, "run", ["run:read"]), true);
    assert.equal(authorize(manifest, "run", ["event:read"]), false);
    assert.equal(authorize(manifest, "future-family", ["admin"]), false);
    assert.equal(manifest.writeBoundary.directStorage, false);
    assert.equal(manifest.writeBoundary.httpRoutes, false);
    assert.equal(manifest.policyVersionRequired, true);
});
