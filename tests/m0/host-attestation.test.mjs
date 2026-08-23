import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import { canonicalDigest } from "../../scripts/validate-m0.mjs";
import {
  issueEvidence,
  verifyEvidenceForCommit,
} from "./evidence-verifier.mjs";
import { digest, seedRunSql, sqlite, withDatabase } from "./sqlite-helper.mjs";

const load = (path) =>
  readFile(new URL(`../../contracts/v2/${path}`, import.meta.url), "utf8").then(
    JSON.parse,
  );

function context() {
  return {
    hostId: "host-1",
    profileId: "profile-1",
    mode: "production-child",
    launchAttemptId: "launch-1",
    challengeDigest: canonicalDigest("challenge-1"),
    releaseId: digest("1"),
    activationEpoch: 1,
    runId: "run-1",
    attempt: 0,
    containmentId: "containment-1",
    containmentGeneration: 1,
  };
}

function probeResults(boundary, expected) {
  return boundary.positiveProbeControls.map((id) => ({
    id,
    definitionDigest: canonicalDigest({ id, version: 1 }),
    outcome: "verified",
    observation:
      id === "whole-tree-containment"
        ? {
            containmentId: expected.containmentId,
            containmentGeneration: expected.containmentGeneration,
            descendantMembershipEnforced: true,
            descendantEscapePrevented: true,
            allMembersEnumerable: true,
            hardReapWholeTree: true,
          }
        : { observed: true },
  }));
}

function claims(boundary, expected, patch = {}) {
  return {
    evidenceId: "host-evidence-1",
    authorityGeneration: 1,
    issuedAtUtcMs: 10,
    expiresAtUtcMs: 100,
    ...expected,
    bootId: "boot-1",
    startupCycleId: "cycle-1",
    timeGeneration: 1,
    probeResults: probeResults(boundary, expected),
    ...patch,
  };
}

function currentState(patch = {}) {
  return {
    authorityGeneration: 1,
    bootId: "boot-1",
    startupCycleId: "cycle-1",
    timeGeneration: 1,
    nowUtcMs: 50,
    ...patch,
  };
}

test("production-child profile requires every runtime probe and whole-tree observation", async () => {
  const [host, boundary, registry] = await Promise.all([
    load("runtime/host-attestation.json"),
    load("runtime/boundary.json"),
    load("runtime/evidence-profiles.json"),
  ]);
  const profile = registry.profiles.find(({ id }) => id === "production-child");
  assert.deepEqual(profile.requiredProbeIds, boundary.positiveProbeControls);
  assert.equal(
    host.evidenceProfileRegistry,
    "contracts/v2/runtime/evidence-profiles.json",
  );
  assert.equal(host.modeEvidenceProfiles["production-child"], profile.id);
});

test.scenarios(
  [
    "v2c.host-attestation.case-50cb629942f03c42",
    "v2c.host-attestation.case-da5dd9ee5328835c",
    "v2c.host-attestation.case-dcbef2eddf546aa9"
  ],
  "verification rejects validly re-signed cross-context, partial-probe, replay, and stale-current evidence", async () => {
  const [boundary, registry] = await Promise.all([
    load("runtime/boundary.json"),
    load("runtime/evidence-profiles.json"),
  ]);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuer = {
    issuerId: "launcher-authority",
    keyVersion: "key-v1",
    privateKey,
  };
  const expectedIssuer = {
    issuerId: issuer.issuerId,
    keyVersion: issuer.keyVersion,
  };
  const trustedIssuers = new Map([
    [
      issuer.issuerId,
      {
        keyVersion: issuer.keyVersion,
        publicKey,
        authorityGeneration: 1,
        revoked: false,
      },
    ],
  ]);
  const consumedEvidenceIds = new Set();
  const expectedContext = context();
  const hostClaims = claims(boundary, expectedContext);
  const envelope = issueEvidence(registry, {
    profileId: "production-child",
    ...issuer,
    claims: hostClaims,
  });
  assert.throws(
    () =>
      issueEvidence(registry, {
        profileId: "production-child",
        ...issuer,
        claims: hostClaims,
      }),
    (error) => error?.code === "stale_authority",
  );
  const verified = verifyEvidenceForCommit({
    registry,
    envelope,
    expectedContext,
    currentState: currentState(),
    expectedIssuer,
    trustedIssuers,
    consumedEvidenceIds,
  });
  assert.equal(verified.kind, "VerifiedEvidence");
  assert.throws(
    () =>
      verifyEvidenceForCommit({
        registry,
        envelope,
        expectedContext,
        currentState: currentState(),
        expectedIssuer: { issuerId: "other-launcher", keyVersion: "key-v1" },
        trustedIssuers,
        consumedEvidenceIds,
      }),
    (error) => error?.code === "evidence_context_invalid",
  );

  const wrongContext = { ...expectedContext, runId: "run-other" };
  const reSignedWrong = issueEvidence(registry, {
    profileId: "production-child",
    ...issuer,
    claims: claims(boundary, wrongContext, { evidenceId: "host-evidence-2" }),
  });
  assert.throws(
    () =>
      verifyEvidenceForCommit({
        registry,
        envelope: reSignedWrong,
        expectedContext,
        currentState: currentState(),
        expectedIssuer,
        trustedIssuers,
        consumedEvidenceIds,
      }),
    (error) => error?.code === "evidence_context_mismatch",
  );

  const incomplete = claims(boundary, expectedContext, {
    evidenceId: "host-evidence-3",
  });
  incomplete.probeResults = incomplete.probeResults.slice(1);
  assert.throws(
    () =>
      issueEvidence(registry, {
        profileId: "production-child",
        ...issuer,
        claims: incomplete,
      }),
    (error) => error?.code === "probe_set_incomplete",
  );
  const escaped = claims(boundary, expectedContext, {
    evidenceId: "host-evidence-4",
  });
  escaped.probeResults.find(
    ({ id }) => id === "whole-tree-containment",
  ).observation.descendantEscapePrevented = false;
  assert.throws(
    () =>
      issueEvidence(registry, {
        profileId: "production-child",
        ...issuer,
        claims: escaped,
      }),
    (error) => error?.code === "whole_tree_probe_invalid",
  );
  assert.throws(
    () =>
      verifyEvidenceForCommit({
        registry,
        envelope,
        expectedContext,
        currentState: currentState({ bootId: "boot-2" }),
        expectedIssuer,
        trustedIssuers,
        consumedEvidenceIds,
      }),
    (error) => error?.code === "stale_authority",
  );
  const concurrent = verifyEvidenceForCommit({
    registry,
    envelope,
    expectedContext,
    currentState: currentState(),
    expectedIssuer,
    trustedIssuers,
    consumedEvidenceIds,
  });
  verified.consume();
  assert.throws(
    () => concurrent.consume(),
    (error) => error?.code === "stale_authority",
  );
  assert.throws(
    () =>
      verifyEvidenceForCommit({
        registry,
        envelope,
        expectedContext,
        currentState: currentState(),
        expectedIssuer,
        trustedIssuers,
        consumedEvidenceIds,
      }),
    (error) => error?.code === "stale_authority",
  );
});

test("verified LaunchAttestation storage binds the exact envelope, context, and source fact", async () => {
  const [boundary, registry] = await Promise.all([
    load("runtime/boundary.json"),
    load("runtime/evidence-profiles.json"),
  ]);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const expectedContext = context();
  const hostClaims = claims(boundary, expectedContext, {
    evidenceId: "host-evidence-sql",
  });
  const envelope = issueEvidence(registry, {
    profileId: "production-child",
    issuerId: "launcher-authority",
    keyVersion: "key-v1",
    privateKey,
    claims: hostClaims,
  });
  const verified = verifyEvidenceForCommit({
    registry,
    envelope,
    expectedContext,
    currentState: currentState(),
    expectedIssuer: {
      issuerId: "launcher-authority",
      keyVersion: "key-v1",
    },
    trustedIssuers: new Map([
      [
        "launcher-authority",
        {
          keyVersion: "key-v1",
          publicKey,
          authorityGeneration: 1,
          revoked: false,
        },
      ],
    ]),
    consumedEvidenceIds: new Set(),
  });
  const envelopeJson = JSON.stringify(verified.envelope).replaceAll("'", "''");
  const subject = JSON.stringify(expectedContext);
  const controls = JSON.stringify(hostClaims.probeResults);
  const launchSql = (factSeq) => `INSERT INTO launch_attestations (
    launch_attestation_id, launch_attempt_id, challenge_digest, host_id,
    profile_id, mode, startup_cycle_id, generation, status, verifier_id,
    verifier_version, signature_algorithm, subject_binding_json,
    subject_identity_digest, control_results_json, control_results_digest,
    source_fact_payload_digest, evidence_digest, issued_at_utc_ms,
    expires_at_utc_ms, expected_context_digest, current_state_digest,
    authenticated_evidence_id, fact_seq
  ) VALUES (
    'attestation-1', '${expectedContext.launchAttemptId}', '${expectedContext.challengeDigest}',
    '${expectedContext.hostId}', '${expectedContext.profileId}',
    '${expectedContext.mode}', '${hostClaims.startupCycleId}',
    ${hostClaims.authorityGeneration}, 'verified', 'launcher-authority',
    'key-v1', 'Ed25519', '${subject}', '${canonicalDigest(expectedContext)}',
    '${controls}', '${canonicalDigest(hostClaims.probeResults)}', '${digest("4")}',
    '${verified.envelopeDigest}', ${hostClaims.issuedAtUtcMs},
    ${hostClaims.expiresAtUtcMs}, '${verified.casPredicates.expectedContextDigest}',
    '${verified.casPredicates.currentStateDigest}', '${hostClaims.evidenceId}',
    ${factSeq}
  )`;

  await withDatabase((databasePath) => {
    sqlite(databasePath, seedRunSql());
    sqlite(
      databasePath,
      `INSERT INTO source_facts VALUES (3, 'database-1', '${digest("b")}', '${digest("c")}', 'launch-attestation', 'v1', '{}', '${digest("d")}');
       INSERT INTO authenticated_evidence VALUES (
         '${hostClaims.evidenceId}', 'production-child', 'launcher-authority',
         'v1', 'key-v1', 1, '${envelopeJson}', '${verified.envelope.signature}',
         '${verified.envelopeDigest}', '${verified.authorizedPayloadDigest}',
         '${verified.casPredicates.expectedContextDigest}',
         '${verified.casPredicates.currentStateDigest}', ${hostClaims.issuedAtUtcMs},
         ${hostClaims.expiresAtUtcMs}, 1, 3
       );`,
    );
    assert.notEqual(
      sqlite(databasePath, launchSql(3), { allowFailure: true }).status,
      0,
    );
    sqlite(
      databasePath,
      `INSERT INTO authenticated_evidence_consumptions VALUES (
         '${hostClaims.evidenceId}', 'production-child', 'attestation-1',
         ${hostClaims.authorityGeneration}, 3
       );`,
    );
    assert.notEqual(
      sqlite(databasePath, launchSql(99), { allowFailure: true }).status,
      0,
    );
    sqlite(databasePath, launchSql(3));
  });
});
