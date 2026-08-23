import { readFile } from "node:fs/promises";

import { createEvidenceFixture } from "./evidence-verifier.mjs";

const registryUrl = new URL(
  "../../contracts/v2/runtime/evidence-profiles.json",
  import.meta.url,
);
const digest = (character) => character.repeat(64);

export async function recoveryEvidenceHarness() {
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  return { registry, evidence: createEvidenceFixture(registry) };
}

export function contexts(registry, profileId, claims, currentPatch = {}) {
  const profile = registry.profiles.find(({ id }) => id === profileId);
  return {
    expectedContext: Object.fromEntries(
      profile.expectedContextFields.map((field) => [field, claims[field]]),
    ),
    currentState: {
      ...Object.fromEntries(
        profile.currentStateFields.map((field) => [field, claims[field]]),
      ),
      nowUtcMs: 50,
      ...currentPatch,
    },
  };
}

export function recoveryAttemptInput(harness, input, artifactClaims) {
  return {
    ...input,
    expectedArtifactContext: contexts(
      harness.registry,
      "recovery-artifact",
      artifactClaims,
    ).expectedContext,
  };
}

export function verifyClaims(
  harness,
  profileId,
  claims,
  { expectedPatch = {}, currentPatch = {} } = {},
) {
  const { expectedContext, currentState } = contexts(
    harness.registry,
    profileId,
    claims,
    currentPatch,
  );
  return harness.evidence.verify(
    harness.evidence.issue(profileId, claims),
    { ...expectedContext, ...expectedPatch },
    currentState,
  );
}

export function recoveryArtifactClaims(input, patch = {}) {
  return {
    evidenceId: `artifact-evidence-${input.agentAttemptId}`,
    authorityId: "recovery-authority",
    authorityVersion: "v1",
    authorityGeneration: 1,
    issuedAtUtcMs: 10,
    expiresAtUtcMs: 100,
    artifactId: input.artifactId ?? "artifact-1",
    recoverySessionId: input.recoverySessionId,
    agentAttemptId: input.agentAttemptId,
    attemptChallenge: input.attemptChallenge ?? "challenge-1",
    agentId: input.agentId,
    qualificationGeneration: input.qualificationGeneration,
    releaseId: input.releaseId ?? digest("1"),
    activationId: input.activationId ?? "activation-1",
    databaseIdentity: input.databaseIdentity ?? "database-1",
    sourceControlInstanceId: input.sourceControlInstanceId ?? "source-1",
    targetControlInstanceId: input.targetControlInstanceId,
    agentSetDigest: input.agentSetDigest ?? digest("2"),
    lineageSetDigest: input.lineageSetDigest ?? digest("3"),
    authoritySetDigest: input.authoritySetDigest ?? digest("4"),
    backupDigest: input.backupDigest ?? digest("5"),
    sourceFactHead: input.sourceFactHead ?? digest("6"),
    executionClosureDigest: input.executionClosureDigest ?? digest("7"),
    timeEvidenceId: "time-1",
    timeEvidenceDigest: digest("8"),
    timeGeneration: 1,
    hostAttestationId: "attestation-1",
    hostAttestationDigest: digest("9"),
    hostAttestationGeneration: 1,
    registrationClosureDigest: input.registrationClosureDigest ?? digest("a"),
    dispatchDenominatorDigest: input.dispatchDenominatorDigest ?? digest("b"),
    finalOutcomeDigest: input.finalOutcomeDigest ?? digest("c"),
    reservedEpoch: input.reservedEpoch,
    commandDigest: input.commandDigest,
    ...patch,
  };
}

export function activationPermitClaims(certificate, generation, patch = {}) {
  return {
    evidenceId: `permit-evidence-${certificate.certificateId}-${generation}`,
    authorityId: "recovery-authority",
    authorityVersion: "v1",
    authorityGeneration: 1,
    issuedAtUtcMs: generation === 1 ? 10 : 60,
    expiresAtUtcMs: generation === 1 ? 55 : 120,
    certificateId: certificate.certificateId,
    commandId: certificate.commandId,
    targetControlInstanceId: certificate.targetControlInstanceId,
    reservedEpoch: certificate.reservedEpoch,
    artifactEvidenceDigest: certificate.evidenceDigest,
    permitGeneration: generation,
    bootId: generation === 1 ? "boot-1" : "boot-2",
    startupCycleId: generation === 1 ? "cycle-1" : "cycle-2",
    hostAttestationId: generation === 1 ? "attestation-1" : "attestation-2",
    hostAttestationDigest: generation === 1 ? digest("d") : digest("e"),
    hostGeneration: generation,
    timeEvidenceId: generation === 1 ? "time-1" : "time-2",
    timeEvidenceDigest: generation === 1 ? digest("f") : digest("0"),
    timeGeneration: generation,
    ...patch,
  };
}

export async function recoverySqlEvidence(permitGenerations = [1]) {
  const harness = await recoveryEvidenceHarness();
  const artifactClaims = recoveryArtifactClaims(
    {
      artifactId: "artifact-1",
      agentAttemptId: "recovery-attempt-1",
      recoverySessionId: "session-1",
      targetControlInstanceId: "target-1",
      agentId: "agent-1",
      qualificationGeneration: 0,
      commandDigest: digest("4"),
      dispatchDenominatorDigest: digest("8"),
      reservedEpoch: 2,
    },
    {
      hostAttestationDigest: digest("d"),
      timeEvidenceDigest: digest("f"),
    },
  );
  const artifact = verifyClaims(harness, "recovery-artifact", artifactClaims);
  const certificate = {
    certificateId: "certificate-1",
    commandId: "command-activate",
    targetControlInstanceId: "target-1",
    reservedEpoch: 2,
    evidenceDigest: artifact.envelopeDigest,
    recoverySessionId: "session-1",
    agentId: "agent-1",
    qualificationGeneration: 0,
  };
  const permits = new Map(
    permitGenerations.map((generation) => {
      const claims = activationPermitClaims(certificate, generation);
      return [
        generation,
        {
          claims,
          verified: verifyClaims(harness, "activation-permit", claims, {
            currentPatch: { nowUtcMs: generation === 1 ? 50 : 80 },
          }),
        },
      ];
    }),
  );
  return { harness, artifactClaims, artifact, certificate, permits };
}

export function targetClosureClaims(patch = {}) {
  return {
    evidenceId: "target-closure-1",
    authorityId: "recovery-authority",
    authorityVersion: "v1",
    authorityGeneration: 1,
    issuedAtUtcMs: 45,
    expiresAtUtcMs: 100,
    databaseIdentity: "database-1",
    targetControlInstanceId: "target-1",
    casIdentity: "database-1:target-1",
    registrationClosureWatermark: 8,
    continuationClosureWatermark: 9,
    revokedMemberSetDigest: digest("9"),
    invalidatedAttestationDigest: digest("a"),
    maxGrantExpiryUtcMs: 40,
    observedAtUtcMs: 50,
    timeEvidenceDigest: digest("b"),
    dispatchObligationDigest: digest("c"),
    discoveryObligationDigest: digest("d"),
    obligationDigest: digest("e"),
    targetRetired: true,
    ...patch,
  };
}

export function boundConflictClaims(certificate, kind, patch = {}) {
  return {
    evidenceId: `conflict-evidence-${certificate.certificateId}-${kind}`,
    authorityId: "recovery-authority",
    authorityVersion: "v1",
    authorityGeneration: 1,
    issuedAtUtcMs: 10,
    expiresAtUtcMs: 100,
    kind,
    certificateId: certificate.certificateId,
    commandId: certificate.commandId,
    artifactEvidenceDigest: certificate.evidenceDigest,
    recoveryOperationId: "operation-1",
    recoverySessionId: certificate.recoverySessionId,
    agentId: certificate.agentId,
    qualificationGeneration: certificate.qualificationGeneration,
    targetControlInstanceId: certificate.targetControlInstanceId,
    conflictGeneration: 1,
    registryProofDigest: digest("a"),
    authenticationEvidenceDigest: digest("b"),
    ...patch,
  };
}
