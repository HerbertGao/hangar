import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const coreUrl = new URL(
  "../../contracts/v2/control/core-objects.json",
  import.meta.url,
);
const durableUrl = new URL(
  "../../contracts/v2/control/durable-data.json",
  import.meta.url,
);

function sanitize(value, sanitizer) {
  if (sanitizer.algorithm === "replace-c0-and-del-with-space-collapse-trim") {
    return value
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (sanitizer.algorithm === "remove-c0-and-del-trim") {
    return value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  }
  throw Object.assign(new Error("unknown_sanitizer"), {
    code: "unknown_sanitizer",
  });
}

function closedRef(value, schema) {
  assert.equal(typeof value, "object");
  assert.deepEqual(Object.keys(value).sort(), [...schema.fields].sort());
  return value;
}

function serializer(core, durable, schemaId, boundary, payload) {
  const schema = core.objectSchemas.find(({ id }) => id === schemaId);
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  const allowed = new Set(durable.boundaryAllowlist[boundary]);
  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    const field = fields.get(key);
    if (!field)
      throw Object.assign(new Error("unknown_field"), {
        code: "unknown_field",
      });
    if (field.dataClass === "runtime-only") continue;
    if (!allowed.has(field.dataClass)) {
      throw Object.assign(new Error("class_not_allowed"), {
        code: "class_not_allowed",
      });
    }
    if (field.dataClass === "artifact-ref") {
      output[key] = Array.isArray(value)
        ? value.map((entry) => closedRef(entry, durable.artifactRefSchema))
        : closedRef(value, durable.artifactRefSchema);
      continue;
    }
    if (field.dataClass === "secret-ref") {
      output[key] = Array.isArray(value)
        ? value.map((entry) => closedRef(entry, durable.secretRefSchema))
        : closedRef(value, durable.secretRefSchema);
      continue;
    }
    if (field.dataClass === "safe-text") {
      const declaration = durable.safeTextFields.find(
        ({ schemaPath }) =>
          schemaPath === `objectSchemas.${schemaId}.fields.${key}`,
      );
      const sanitizer = durable.sanitizerRegistry.find(
        ({ id, version }) =>
          id === declaration?.sanitizerId &&
          version === declaration?.sanitizerVersion,
      );
      if (!declaration || !sanitizer) {
        throw Object.assign(new Error("unknown_sanitizer"), {
          code: "unknown_sanitizer",
        });
      }
      const clean = sanitize(value, sanitizer);
      if (Buffer.byteLength(clean, "utf8") > declaration.maxUtf8Bytes) {
        throw Object.assign(new Error("safe_text_too_large"), {
          code: "safe_text_too_large",
        });
      }
      output[key] = clean;
      continue;
    }
    output[key] = value;
  }
  return output;
}

test("every durable field class and safe-text sanitizer is closed", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  const durable = JSON.parse(await readFile(durableUrl, "utf8"));
  const classes = new Set(durable.classes);
  for (const schema of core.objectSchemas) {
    for (const field of schema.fields)
      assert.ok(classes.has(field.dataClass), `${schema.id}.${field.id}`);
  }
  for (const field of durable.safeTextFields) {
    assert.ok(
      Number.isSafeInteger(field.maxUtf8Bytes) && field.maxUtf8Bytes > 0,
    );
    assert.ok(
      durable.sanitizerRegistry.some(
        ({ id, version }) =>
          id === field.sanitizerId && version === field.sanitizerVersion,
      ),
    );
  }
  for (const boundary of [
    "source-fact",
    "trace",
    "command-result",
    "client-projection",
  ]) {
    assert.ok(!durable.boundaryAllowlist[boundary].includes("runtime-only"));
    assert.ok(!durable.boundaryAllowlist[boundary].includes("secret-ref"));
  }
});

test.scenarios(
  [
    "v2c.core-objects.case-ee282e108b929d7a",
    "v2c.durable-data.case-059b139162921d92",
    "v2c.durable-data.case-3bad4dd6e919014e",
    "v2c.durable-data.case-a58f530be73f5ba8"
  ],
  "runtime-only values are dropped and unknown or inline values fail closed", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  const durable = JSON.parse(await readFile(durableUrl, "utf8"));
  const request = serializer(core, durable, "HarnessRequest", "trace", {
    releaseId: "release-1",
    runtimeInput: "must-not-persist",
  });
  assert.deepEqual(request, { releaseId: "release-1" });
  assert.throws(
    () =>
      serializer(core, durable, "RunEvent", "source-fact", {
        runId: "run-1",
        emailBody: "inline",
      }),
    ({ code }) => code === "unknown_field",
  );
  assert.throws(
    () =>
      serializer(core, durable, "AgentRelease", "release", {
        secretRefs: [
          {
            secretRefId: "ref",
            purpose: "tool",
            audience: "broker",
            secretValue: "resolved",
          },
        ],
      }),
    assert.AssertionError,
  );
});

test.scenarios(
  [
    "v2c.durable-data.case-0d99e7b6fbcd8fc8"
  ],
  "safe text is sanitized, then measured in UTF-8 bytes", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  const durable = JSON.parse(await readFile(durableUrl, "utf8"));
  const output = serializer(core, durable, "HealthFact", "client-projection", {
    subjectId: "subject-1",
    reason: " first\n\u0000second ",
  });
  assert.equal(output.reason, "first second");
  assert.throws(
    () =>
      serializer(core, durable, "HealthFact", "client-projection", {
        reason: "界".repeat(100),
      }),
    ({ code }) => code === "safe_text_too_large",
  );

  const broken = structuredClone(durable);
  broken.safeTextFields[0].sanitizerVersion += 1;
  assert.throws(
    () =>
      serializer(core, broken, "HealthFact", "client-projection", {
        reason: "safe",
      }),
    ({ code }) => code === "unknown_sanitizer",
  );
});
