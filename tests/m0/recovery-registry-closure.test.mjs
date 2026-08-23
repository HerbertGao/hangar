import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { RecoveryAuthorityFixture } from "./recovery-helper.mjs";

const restoreUrl = new URL(
  "../../contracts/v2/storage/restore.json",
  import.meta.url,
);

test.scenarios(
  [
    "v2s.restore.case-7866356202adaca5"
  ],
  "an authority-only lineage member cannot disappear from the denominator", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  authority.registerAuthority("source-1", {
    id: "registry-only-member",
    type: "direct-mutation-authority",
  });
  const closure = authority.closeRegistration("source-1");
  const sinkEnumeratedMembers = new Set();
  assert.equal(
    closure.members.every(({ id }) => sinkEnumeratedMembers.has(id)),
    false,
  );
  assert.deepEqual(
    closure.members.map(({ id }) => id),
    ["registry-only-member"],
  );
});

test.scenarios(
  [
    "v2s.restore.case-3d641c3edf847bef",
    "v2s.restore.case-ef2a0d13845e9fce"
  ],
  "registration and closure race leaves every member on exactly one side", async () => {
  const manifest = JSON.parse(await readFile(restoreUrl, "utf8"));
  const authority = new RecoveryAuthorityFixture(manifest);
  assert.equal(
    authority.registerAuthority("source-1", {
      id: "member-1",
      type: "gateway-claim",
    }),
    1,
  );
  const closure = authority.closeRegistration("source-1");
  assert.equal(closure.sequence, 2);
  assert.deepEqual(
    closure.members.map(({ id }) => id),
    ["member-1"],
  );
  assert.throws(
    () =>
      authority.registerAuthority("source-1", {
        id: "member-2",
        type: "runtime-grant",
      }),
    (error) => error?.code === "stale_authority",
  );
  assert.deepEqual(authority.closeRegistration("source-1"), closure);
});
