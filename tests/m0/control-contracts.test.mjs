import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { actorSubjectId, identifierViews } from "../../scripts/validate-m0.mjs";

const coreUrl = new URL(
  "../../contracts/v2/control/core-objects.json",
  import.meta.url,
);
const authorityUrl = new URL(
  "../../contracts/v2/control/authority-policy.json",
  import.meta.url,
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function rejected(identifier, manifest) {
  const views = identifierViews(identifier);
  return (
    views.tokens.some((token) => manifest.tokens.includes(token)) ||
    manifest.compactForms.includes(views.compact)
  );
}

function declarations(core) {
  const output = [];
  for (const object of core.objectSchemas) {
    output.push({
      schemaPath: `objectSchemas.${object.id}`,
      identifier: object.id,
      kind: "type",
    });
    for (const field of object.fields) {
      output.push({
        schemaPath: `objectSchemas.${object.id}.fields.${field.id}`,
        identifier: field.id,
        kind: "field",
      });
    }
  }
  for (const enumeration of core.enums) {
    output.push({
      schemaPath: `enums.${enumeration.id}`,
      identifier: enumeration.id,
      kind: "enum",
    });
    for (const value of enumeration.values) {
      output.push({
        schemaPath: `enums.${enumeration.id}.${value}`,
        identifier: value,
        kind: "enum-value",
      });
    }
  }
  return output;
}

test.scenarios(
  [
    "m0o.inbox.case-7d62d5d7f62e5761",
    "v2c.core-objects.case-99c6189cd103b295"
  ],
  "core object schemas are closed, domain-neutral, and fully attested", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  assert.deepEqual(core.requirementIds, [
    "v2c.core-objects",
    "v2c.durable-data",
  ]);
  assert.deepEqual(
    core.objectSchemas.map(({ id }) => id),
    [
      "AgentSpec",
      "AgentRelease",
      "Activation",
      "Run",
      "RunAttempt",
      "HarnessRequest",
      "HarnessEvent",
      "ActionEvent",
      "CheckpointRef",
      "RunEvent",
      "Approval",
      "Effect",
      "HealthFact",
      "AuthorityEvidence",
      "ErrorEnvelope",
    ],
  );
  assert.ok(core.objectSchemas.every(({ closed }) => closed));
  assert.equal(
    core.knownDomainTerms.digest,
    sha256(
      JSON.stringify({
        tokens: core.knownDomainTerms.tokens,
        compactForms: core.knownDomainTerms.compactForms,
      }),
    ),
  );

  const expected = declarations(core);
  assert.equal(core.identifierAttestations.length, expected.length);
  const attestations = new Map(
    core.identifierAttestations.map((entry) => [
      `${entry.schemaPath}\0${entry.identifier}\0${entry.kind}`,
      entry,
    ]),
  );
  assert.equal(attestations.size, expected.length);
  for (const declaration of expected) {
    assert.ok(
      !rejected(declaration.identifier, core.knownDomainTerms),
      declaration.identifier,
    );
    const attestation = attestations.get(
      `${declaration.schemaPath}\0${declaration.identifier}\0${declaration.kind}`,
    );
    assert.ok(attestation, declaration.schemaPath);
    assert.equal(attestation.manifestVersion, core.knownDomainTerms.version);
    assert.equal(attestation.manifestDigest, core.knownDomainTerms.digest);
    assert.equal(attestation.owner, "hangar-owner");
    assert.equal(attestation.decision, "domain-neutral");
    assert.ok(core.rationaleRegistry[attestation.rationaleCode]);
  }
});

test.scenarios(
  [
    "v2c.core-objects.case-b1e6225e0bc92246"
  ],
  "known domain terms reject token and compact matches without fuzzy matching", async () => {
  const { knownDomainTerms } = JSON.parse(await readFile(coreUrl, "utf8"));
  for (const identifier of [
    "emailAddress",
    "e-mail",
    "repositoryId",
    "slideDeck",
    "newsItem",
    "pricingRule",
    "emailmessage",
  ]) {
    assert.ok(rejected(identifier, knownDomainTerms), identifier);
  }
  assert.ok(
    !rejected("mailer", knownDomainTerms),
    "no stemming or prefix inference",
  );
  assert.ok(
    !rejected("sourceFact", knownDomainTerms),
    "generic control source remains allowed",
  );
});

test("closed Run, action, checkpoint, and authority schemas retain normative bindings", async () => {
  const [core, authority] = await Promise.all([
    readFile(coreUrl, "utf8").then(JSON.parse),
    readFile(authorityUrl, "utf8").then(JSON.parse),
  ]);
  const fields = (id) =>
    new Set(
      core.objectSchemas
        .find((schema) => schema.id === id)
        .fields.map((field) => field.id),
    );
  for (const field of [
    "activationId",
    "activationEpoch",
    "triggerKind",
    "triggerId",
    "triggerInputDigest",
    "authorityContextDigest",
  ])
    assert.ok(fields("Run").has(field), `Run.${field}`);
  assert.ok(fields("ActionEvent").has("innerRetryOrdinal"));
  assert.ok(fields("CheckpointRef").has("boundaryKind"));
  const evidenceFields = fields("AuthorityEvidence");
  for (const field of [...authority.authorityContext.fields, "actorSubjectId"])
    assert.ok(evidenceFields.has(field), `AuthorityEvidence.${field}`);
  assert.equal(
    actorSubjectId(authority.sampleAuthorityContext),
    authority.sampleActorSubjectId,
  );
});

test.scenarios(
  [
    "v2c.core-objects.case-f74dd5de6847249e"
  ],
  "AgentRelease membership excludes mutable evidence and deferred protocols", async () => {
  const core = JSON.parse(await readFile(coreUrl, "utf8"));
  const release = core.objectSchemas.find(({ id }) => id === "AgentRelease");
  const fields = new Set(release.fields.map(({ id }) => id));
  for (const required of [
    "executionClosureDigest",
    "approvedSkillDigests",
    "checkpointSchemaDigests",
    "requiredCapabilities",
    "requiredOperations",
    "trustedDirectEffects",
    "hostDeclarationDigest",
    "secretRefs",
  ]) {
    assert.ok(fields.has(required));
  }
  for (const forbidden of [
    "releaseId",
    "activationState",
    "agentOwnedState",
    "checkpointBody",
    "launchProbeResult",
    "workspaceSchema",
    "capabilityRegistration",
  ]) {
    assert.ok(!fields.has(forbidden));
  }
});
