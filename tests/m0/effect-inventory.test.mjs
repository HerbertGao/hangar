import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "./scenario-owner.mjs";

const inventoryUrl = new URL(
  "../../oracles/m0/effect-inventory.json",
  import.meta.url,
);
const sourcesUrl = new URL("../../oracles/m0/sources.json", import.meta.url);
const root = new URL("../../", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const patterns = {
  "credential-reference": /process\.env|token|secret|password|authJson|oauth/i,
  "external-mutation-call":
    /markRead|mark.*read|sendMessage|sendDigest|modify\(|addLabel|removeLabel|setFlags|messageFlagsAdd/i,
  "filesystem-write": /writeFile|appendFile|rename\(|unlink\(|mkdir\(/i,
  "subprocess-launch": /spawn\(|execFile|exec\(/i,
};

function git(cwd, args, encoding = null) {
  const output = spawnSync("git", ["-C", cwd, ...args], {
    encoding,
    maxBuffer: 50 * 1024 * 1024,
  });
  assert.equal(output.status, 0, output.stderr?.toString());
  return output.stdout;
}

function selected(paths, selector) {
  return paths.filter((path) => {
    const base =
      (selector.files ?? []).includes(path) ||
      (selector.prefixes ?? []).some((prefix) => path.startsWith(prefix));
    return (
      base &&
      (!selector.suffixes ||
        selector.suffixes.some((suffix) => path.endsWith(suffix)))
    );
  });
}

test.scenarios(
  [
    "m0o.effect-inventory.case-410902198ca99c22"
  ],
  "every pinned runtime member has reproducible scan evidence and disposition", async () => {
  const [inventory, sources] = await Promise.all([
    readFile(inventoryUrl, "utf8").then(JSON.parse),
    readFile(sourcesUrl, "utf8").then(JSON.parse),
  ]);
  const members = [];
  for (const [repositoryId, setId] of [
    ["hangar-main-v0", "v0-runtime-source"],
    ["inbox-upstream", "inbox-runtime-source"],
  ]) {
    const repository = sources.repositories.find(
      ({ id }) => id === repositoryId,
    );
    const cwd = resolve(root.pathname, repository.checkoutPath);
    const memberSet = repository.memberSets.find(({ id }) => id === setId);
    const paths = git(cwd, [
      "ls-tree",
      "-rz",
      "--name-only",
      repository.revision,
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const path of selected(paths, memberSet.selector)) {
      const bytes = git(cwd, [
        "cat-file",
        "blob",
        `${repository.revision}:${path}`,
      ]);
      const text = bytes.toString("utf8");
      const matchedClasses = inventory.scanner.classes
        .filter(({ id, pattern }) => {
          assert.equal(patterns[id].source, pattern);
          return patterns[id].test(text);
        })
        .map(({ id }) => id);
      members.push({
        memberId: `${repositoryId}:${path}`,
        repositoryId,
        revision: repository.revision,
        path,
        contentDigest: sha256(bytes),
        scanEvidence: {
          scannerVersion: inventory.scanner.version,
          matchedClasses,
        },
        disposition: matchedClasses.length
          ? "reviewed-reference-or-mutation-surface"
          : "no-mutation-or-holder-pattern",
      });
    }
  }
  assert.deepEqual(inventory.members, members);
  assert.equal(
    inventory.memberDenominatorDigest,
    sha256(JSON.stringify(members)),
  );
});

test.scenarios(
  [
    "m0o.effect-inventory.case-c28ee66fe30ba8fe",
    "m0o.effect-inventory.case-fb3b8bf7a10d892a"
  ],
  "direct entries and holder references contain no resolved values and never qualify M0/M1", async () => {
  const inventory = JSON.parse(await readFile(inventoryUrl, "utf8"));
  const memberIds = new Set(inventory.members.map(({ memberId }) => memberId));
  assert.ok(
    inventory.directEntries.every(
      ({ location, operations, recoveryDiscoveryMethod }) =>
        memberIds.has(location) &&
        operations.length > 0 &&
        recoveryDiscoveryMethod,
    ),
  );
  assert.ok(
    inventory.sensitiveHolders.every(
      ({ location, referenceKinds }) =>
        memberIds.has(location) && referenceKinds.length > 0,
    ),
  );
  assert.deepEqual(
    new Set(inventory.exceptions.map(({ inventoryId }) => inventoryId)),
    new Set(inventory.directEntries.map(({ inventoryId }) => inventoryId)),
  );
  assert.equal(inventory.resolvedValuesIncluded, false);
  assert.equal(inventory.m0M1ProductionEligible, false);
  assert.ok(inventory.afterDirectCount <= inventory.beforeDirectCount);
  for (const forbiddenKey of [
    "resolvedValue",
    "secretValue",
    "tokenValue",
    "passwordValue",
    "contentSnippet",
  ]) {
    assert.ok(!JSON.stringify(inventory).includes(`"${forbiddenKey}"`));
  }
});
