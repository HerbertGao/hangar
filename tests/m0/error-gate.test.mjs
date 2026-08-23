import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checkSafeErrors } from "../../scripts/validate-m0.mjs";

const errorsUrl = new URL(
  "../../contracts/v2/control/errors.json",
  import.meta.url,
);

test("named safe-error gate evaluates every error kind and detail schema", async () => {
  const manifest = JSON.parse(await readFile(errorsUrl, "utf8"));
  const kinds = new Set();
  const schemas = new Map(
    manifest.detailSchemas.map((schema) => [
      `${schema.id}\0${schema.version}`,
      schema,
    ]),
  );
  for (const error of manifest.errors) {
    assert.ok(!kinds.has(error.kind));
    kinds.add(error.kind);
    assert.ok(
      schemas.has(`${error.detailSchemaId}\0${error.detailSchemaVersion}`),
    );
    assert.ok(manifest.retryabilityKinds.includes(error.retryability));
    assert.ok(
      Buffer.byteLength(error.message, "utf8") <= manifest.messageMaxUtf8Bytes,
    );
  }
  assert.equal(kinds.size, manifest.errors.length);
  const result = await checkSafeErrors();
  assert.equal(result.kind, "pass", JSON.stringify(result.findings));
  assert.equal(result.checks[0].members, manifest.errors.length);
});
