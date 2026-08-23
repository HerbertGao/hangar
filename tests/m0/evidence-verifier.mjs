import { generateKeyPairSync, sign, verify } from "node:crypto";

import { canonicalDigest, canonicalize } from "../../scripts/validate-m0.mjs";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

const verifiedEvidenceCapabilities = new WeakSet();
const issuedEvidenceIdsByKey = new WeakMap();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

export function requireVerifiedEvidence(
  value,
  profileId,
  expectedContext,
  expectedIssuer,
) {
  if (
    !value ||
    !verifiedEvidenceCapabilities.has(value) ||
    value.profileId !== profileId ||
    !expectedIssuer ||
    value.issuerId !== expectedIssuer.issuerId ||
    value.keyVersion !== expectedIssuer.keyVersion ||
    !expectedContext ||
    typeof expectedContext !== "object" ||
    value.casPredicates.expectedContextDigest !==
      canonicalDigest(expectedContext)
  )
    fail("stale_authority");
  return value;
}

function profile(registry, profileId) {
  const matches = registry.profiles.filter(({ id }) => id === profileId);
  if (matches.length !== 1) fail("unknown_evidence_profile");
  return matches[0];
}

function exactFields(value, fields) {
  return (
    value &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...fields].sort())
  );
}

function equal(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function validateProfileClaim(definition, claims) {
  if (!exactFields(claims, definition.claimFields))
    fail("evidence_claim_schema_mismatch");
  if (
    typeof claims.evidenceId !== "string" ||
    !Number.isSafeInteger(claims.authorityGeneration) ||
    claims.authorityGeneration < 0 ||
    !Number.isSafeInteger(claims.issuedAtUtcMs) ||
    !Number.isSafeInteger(claims.expiresAtUtcMs) ||
    claims.expiresAtUtcMs <= claims.issuedAtUtcMs
  )
    fail("evidence_claim_invalid");
  for (const [field, value] of Object.entries(claims)) {
    if (field.endsWith("Digest") && !/^[0-9a-f]{64}$/.test(value))
      fail("evidence_digest_invalid");
  }
  if (definition.requiredProbeIds) {
    if (!Array.isArray(claims.probeResults)) fail("probe_set_incomplete");
    const results = new Map(
      claims.probeResults.map((entry) => [entry.id, entry]),
    );
    if (
      results.size !== claims.probeResults.length ||
      results.size !== definition.requiredProbeIds.length ||
      definition.requiredProbeIds.some((id) => !results.has(id)) ||
      claims.probeResults.some(
        ({ definitionDigest, outcome }) =>
          !/^[0-9a-f]{64}$/.test(definitionDigest) || outcome !== "verified",
      )
    )
      fail("probe_set_incomplete");
    const wholeTree = results.get("whole-tree-containment")?.observation;
    if (
      !exactFields(wholeTree, definition.wholeTreeFields) ||
      wholeTree.containmentId !== claims.containmentId ||
      wholeTree.containmentGeneration !== claims.containmentGeneration ||
      ![
        "descendantMembershipEnforced",
        "descendantEscapePrevented",
        "allMembersEnumerable",
        "hardReapWholeTree",
      ].every((field) => wholeTree[field] === true)
    )
      fail("whole_tree_probe_invalid");
  }
}

export function issueEvidence(
  registry,
  { profileId, issuerId, keyVersion, privateKey, claims },
) {
  const definition = profile(registry, profileId);
  const immutableClaims = deepFreeze(structuredClone(claims));
  validateProfileClaim(definition, immutableClaims);
  const issuedEvidenceIds = issuedEvidenceIdsByKey.get(privateKey) ?? new Set();
  if (issuedEvidenceIds.has(immutableClaims.evidenceId))
    fail("stale_authority");
  const payload = [
    registry.canonicalDomain,
    profileId,
    issuerId,
    keyVersion,
    immutableClaims,
  ];
  const envelope = {
    schemaVersion: registry.schemaVersion,
    profileId,
    issuerId,
    keyVersion,
    algorithm: registry.algorithm,
    claims: immutableClaims,
    signature: sign(
      null,
      Buffer.from(canonicalize(payload)),
      privateKey,
    ).toString("base64"),
  };
  issuedEvidenceIds.add(immutableClaims.evidenceId);
  issuedEvidenceIdsByKey.set(privateKey, issuedEvidenceIds);
  return deepFreeze(envelope);
}

export function createEvidenceFixture(
  registry,
  {
    issuerId = "recovery-authority",
    keyVersion = "key-v1",
    authorityGeneration = 1,
  } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trustedIssuers = new Map([
    [issuerId, { keyVersion, publicKey, authorityGeneration, revoked: false }],
  ]);
  const consumedEvidenceIds = new Set();
  return {
    issuerId,
    keyVersion,
    trustedIssuers,
    consumedEvidenceIds,
    issue(profileId, claims) {
      return issueEvidence(registry, {
        profileId,
        issuerId,
        keyVersion,
        privateKey,
        claims,
      });
    },
    verify(envelope, expectedContext, currentState) {
      return verifyEvidenceForCommit({
        registry,
        envelope,
        expectedContext,
        currentState,
        expectedIssuer: { issuerId, keyVersion },
        trustedIssuers,
        consumedEvidenceIds,
      });
    },
  };
}

export function verifyEvidenceForCommit({
  registry,
  envelope,
  expectedContext,
  currentState,
  expectedIssuer,
  trustedIssuers,
  consumedEvidenceIds,
}) {
  const definition = profile(registry, envelope?.profileId);
  validateProfileClaim(definition, envelope.claims);
  if (
    envelope.schemaVersion !== registry.schemaVersion ||
    envelope.algorithm !== registry.algorithm ||
    !exactFields(expectedIssuer, ["issuerId", "keyVersion"]) ||
    envelope.issuerId !== expectedIssuer.issuerId ||
    envelope.keyVersion !== expectedIssuer.keyVersion ||
    !exactFields(expectedContext, definition.expectedContextFields) ||
    !currentState ||
    typeof currentState !== "object" ||
    !definition.currentStateFields.every((field) =>
      Object.hasOwn(currentState, field),
    ) ||
    !Number.isSafeInteger(currentState.nowUtcMs)
  )
    fail("evidence_context_invalid");
  const issuer = trustedIssuers.get(envelope.issuerId);
  if (
    !issuer ||
    issuer.revoked ||
    issuer.keyVersion !== envelope.keyVersion ||
    issuer.authorityGeneration !== envelope.claims.authorityGeneration
  )
    fail("stale_authority");
  const payload = [
    registry.canonicalDomain,
    envelope.profileId,
    envelope.issuerId,
    envelope.keyVersion,
    envelope.claims,
  ];
  if (
    !verify(
      null,
      Buffer.from(canonicalize(payload)),
      issuer.publicKey,
      Buffer.from(envelope.signature, "base64"),
    )
  )
    fail("evidence_signature_invalid");
  for (const field of definition.expectedContextFields) {
    if (!equal(envelope.claims[field], expectedContext[field]))
      fail("evidence_context_mismatch");
  }
  for (const field of definition.currentStateFields) {
    if (!equal(envelope.claims[field], currentState[field]))
      fail("stale_authority");
  }
  if (
    envelope.claims.issuedAtUtcMs > currentState.nowUtcMs ||
    currentState.nowUtcMs >= envelope.claims.expiresAtUtcMs ||
    (definition.singleUse &&
      consumedEvidenceIds.has(envelope.claims.evidenceId))
  )
    fail("stale_authority");
  const envelopeDigest = canonicalDigest(envelope);
  let consumed = false;
  const capability = {
    kind: "VerifiedEvidence",
    profileId: envelope.profileId,
    evidenceId: envelope.claims.evidenceId,
    issuerId: envelope.issuerId,
    keyVersion: envelope.keyVersion,
    envelope: deepFreeze(structuredClone(envelope)),
    envelopeDigest,
    authorizedPayloadDigest: canonicalDigest(envelope.claims),
    casPredicates: deepFreeze({
      expectedContextDigest: canonicalDigest(expectedContext),
      currentStateDigest: canonicalDigest(
        Object.fromEntries([
          ...definition.currentStateFields.map((field) => [
            field,
            currentState[field],
          ]),
          ["nowUtcMs", currentState.nowUtcMs],
        ]),
      ),
    }),
    claims: deepFreeze(structuredClone(envelope.claims)),
    consume() {
      if (!definition.singleUse) return;
      if (consumed || consumedEvidenceIds.has(envelope.claims.evidenceId))
        fail("stale_authority");
      consumedEvidenceIds.add(envelope.claims.evidenceId);
      consumed = true;
    },
  };
  verifiedEvidenceCapabilities.add(capability);
  return Object.freeze(capability);
}
