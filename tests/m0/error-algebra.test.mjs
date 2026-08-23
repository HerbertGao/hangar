import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { checkSafeErrors } from "../../scripts/validate-m0.mjs";

const errorsUrl = new URL(
  "../../contracts/v2/control/errors.json",
  import.meta.url,
);

function serialize(manifest, candidate) {
  const error = manifest.errors.find(({ kind }) => kind === candidate.kind);
  if (!error) throw new Error("unknown_error_kind");
  const schema = manifest.detailSchemas.find(
    ({ id, version }) =>
      id === error.detailSchemaId && version === error.detailSchemaVersion,
  );
  const details = candidate.details ?? {};
  const allowed = new Set(schema.fields.map(({ id }) => id));
  if (Object.keys(details).some((key) => !allowed.has(key)))
    throw new Error("unknown_detail_field");
  for (const field of schema.fields) {
    if (
      field.allowedValues &&
      (!Object.hasOwn(details, field.id) ||
        !field.allowedValues.includes(details[field.id]))
    )
      throw new Error("invalid_detail_value");
  }
  return {
    kind: error.kind,
    messageTemplateId: error.messageTemplateId,
    message: error.message,
    retryability: error.retryability,
    details,
  };
}

test.scenarios(
  [
    "v2c.errors.case-31c2ab6bd682eda5"
  ],
  "error algebra is closed, bounded, and safe", async () => {
  const manifest = JSON.parse(await readFile(errorsUrl, "utf8"));
  const kinds = new Set(manifest.errors.map(({ kind }) => kind));
  assert.equal(kinds.size, manifest.errors.length);
  for (const required of [
    "unsupported_schedule",
    "idempotency_conflict",
    "terminal_conflict",
    "stale_epoch",
    "stale_generation",
    "stale_attempt",
    "recovery_in_progress",
    "recovery_aborted",
    "recovery_evidence_conflict",
    "recovery_artifact_expired",
    "stale_authority",
    "target_mismatch",
  ]) {
    assert.ok(kinds.has(required), required);
  }
  for (const error of manifest.errors) {
    assert.ok(manifest.retryabilityKinds.includes(error.retryability));
    assert.ok(
      Buffer.byteLength(error.message, "utf8") <= manifest.messageMaxUtf8Bytes,
    );
    assert.ok(
      !/stack|traceback|credential|secret|host path|filesystem path|raw provider/i.test(
        error.message,
      ),
    );
  }
  const result = await checkSafeErrors();
  assert.equal(result.kind, "pass", JSON.stringify(result.findings));
});

test.scenarios(
  [
    "v2c.errors.case-2b2be212349bab76"
  ],
  "unknown kinds and detail fields are rejected without forwarding internals", async () => {
  const manifest = JSON.parse(await readFile(errorsUrl, "utf8"));
  assert.throws(
    () => serialize(manifest, { kind: "future_error" }),
    /unknown_error_kind/,
  );
  assert.throws(
    () =>
      serialize(manifest, {
        kind: "protocol_failure",
        details: { stack: "internal", hostPath: "/private/runtime" },
      }),
    /unknown_detail_field/,
  );
  assert.throws(
    () =>
      serialize(manifest, {
        kind: "contract_failure",
        details: { reason: "/private/runtime secret=value" },
      }),
    /unknown_detail_field/,
  );
  assert.deepEqual(
    serialize(manifest, {
      kind: "contract_failure",
      details: { reasonCode: "contract-mismatch" },
    }).details,
    { reasonCode: "contract-mismatch" },
  );
  assert.throws(
    () =>
      serialize(manifest, {
        kind: "contract_failure",
        details: { reasonCode: "/private/runtime" },
      }),
    /invalid_detail_value/,
  );
  assert.deepEqual(serialize(manifest, { kind: "protocol_failure" }), {
    kind: "protocol_failure",
    messageTemplateId: "protocol-failure-v1",
    message: "The adapter protocol failed.",
    retryability: "after-adapter-fix",
    details: {},
  });
});
