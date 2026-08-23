import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const scopeUrl = new URL("../../contracts/v2/scope.json", import.meta.url);

async function filesBelow(path) {
  let entries;
  try {
    entries = await readdir(join(root.pathname, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = join(path, entry.name);
    const stat = await lstat(join(root.pathname, relative));
    assert.ok(
      !stat.isSymbolicLink(),
      `M0 output cannot be a symlink: ${relative}`,
    );
    if (entry.isDirectory()) files.push(...(await filesBelow(relative)));
    else files.push(relative);
  }
  return files;
}

function compactIdentifier(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("");
}

function assertNoForbiddenSchema(
  value,
  forbidden,
  ignoredContainers,
  path = [],
) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoForbiddenSchema(entry, forbidden, ignoredContainers, [
        ...path,
        index,
      ]),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "negativeEvidenceContainers" || ignoredContainers.has(key))
        continue;
      assertNoForbiddenSchema(key, forbidden, ignoredContainers, [
        ...path,
        key,
        "<key>",
      ]);
      assertNoForbiddenSchema(entry, forbidden, ignoredContainers, [
        ...path,
        key,
      ]);
    }
    return;
  }
  if (typeof value !== "string") return;
  const compact = compactIdentifier(value);
  for (const identifier of forbidden) {
    assert.notEqual(
      compact,
      compactIdentifier(identifier),
      `forbidden schema identifier at ${path.join(".")}`,
    );
  }
}

test("M0 outputs stay in the contract/oracle-only scope", async () => {
  const scope = JSON.parse(await readFile(scopeUrl, "utf8"));
  assert.deepEqual(scope.allowedOutputRoots, [
    "contracts/v2/",
    "oracles/m0/",
    "measurements/",
    "scripts/validate-m0.mjs",
    "tests/m0/",
  ]);
  assert.deepEqual(scope.requirements, {
    productPackages: false,
    externalWrites: false,
    dependencies: false,
    runtimeDaemons: false,
  });

  const files = [
    ...(await filesBelow("contracts/v2")),
    ...(await filesBelow("oracles/m0")),
    ...(await filesBelow("measurements")),
    ...(await filesBelow("tests/m0")),
    "scripts/validate-m0.mjs",
  ];
  assert.ok(files.length > 0);
  for (const path of files) {
    assert.ok(
      scope.allowedOutputRoots.some(
        (allowed) => path === allowed || path.startsWith(allowed),
      ),
    );
    assert.ok(
      ![
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
      ].includes(basename(path)),
    );
    assert.ok(
      !scope.forbiddenProductRoots.some((prefix) => path.startsWith(prefix)),
    );
  }
});

test("contract schemas do not prebuild deferred concepts", async () => {
  const scope = JSON.parse(await readFile(scopeUrl, "utf8"));
  const ignoredContainers = new Set(scope.negativeEvidenceContainers);
  for (const path of await filesBelow("contracts/v2")) {
    const text = await readFile(join(root.pathname, path), "utf8");
    if (path.endsWith(".json")) {
      assertNoForbiddenSchema(
        JSON.parse(text),
        scope.forbiddenSchemaIdentifiers,
        ignoredContainers,
      );
      continue;
    }
    const compact = compactIdentifier(text);
    for (const identifier of scope.forbiddenSchemaIdentifiers) {
      assert.ok(
        !compact.includes(compactIdentifier(identifier)),
        `${identifier} appears in ${path}`,
      );
    }
  }
});
