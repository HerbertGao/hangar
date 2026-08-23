import { requireVerifiedEvidence } from "./evidence-verifier.mjs";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

// Legacy proof shims remain fail-closed so old callers cannot bypass the
// caller-context verifier in evidence-verifier.mjs.
export function signRecoveryAuthorityEvidence() {
  fail("legacy_evidence_verifier_disabled");
}

export function cleanRestartContinuationAllowed() {
  fail("legacy_evidence_verifier_disabled");
}

export function targetAuthorityClosedProofValid() {
  fail("legacy_evidence_verifier_disabled");
}

export class RecoveryAuthorityFixture {
  constructor(manifest) {
    this.manifest = manifest;
    this.expectedIssuer = Object.freeze({
      issuerId: "recovery-authority",
      keyVersion: "key-v1",
    });
    this.expectedAuthority = Object.freeze({
      authorityId: "recovery-authority",
      authorityVersion: "v1",
    });
    this.sessions = new Map();
    this.sessionIdentities = new Map();
    this.openDatabaseSessions = new Map();
    this.attempts = new Map();
    this.openAttempts = new Map();
    this.certificates = new Map();
    this.permits = new Map();
    this.epochHighWatermarks = new Map();
    this.registries = new Map();
    this.invalidatedAgentTargets = new Set();
  }

  registerSession(input) {
    const identity = JSON.stringify([
      input.databaseIdentity,
      input.sourceControlInstanceId,
      input.backupDigest,
    ]);
    const existingId = this.sessionIdentities.get(identity);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (
        existing.commandDigest !== input.commandDigest ||
        existing.targetControlInstanceId !== input.targetControlInstanceId
      ) {
        fail("target_mismatch");
      }
      return existing;
    }
    const open = this.openDatabaseSessions.get(input.databaseIdentity);
    if (open) fail("recovery_in_progress");
    const session = {
      ...input,
      state: "pending",
      generation: 0,
      certificate: null,
    };
    this.sessions.set(input.recoverySessionId, session);
    this.sessionIdentities.set(identity, input.recoverySessionId);
    this.openDatabaseSessions.set(
      input.databaseIdentity,
      input.recoverySessionId,
    );
    return session;
  }

  initializeSession(sessionId, expectedGeneration) {
    const session = this.sessions.get(sessionId);
    if (session.state === "initializing-awaiting-local")
      return session.certificate;
    if (
      session.state !== "pending" ||
      session.generation !== expectedGeneration
    )
      fail("invalid_state");
    session.state = "initializing-awaiting-local";
    session.generation += 1;
    session.certificate = {
      certificateId: `session-init:${sessionId}:${session.generation}`,
      recoverySessionId: sessionId,
      targetControlInstanceId: session.targetControlInstanceId,
      agentSetDigest: session.agentSetDigest,
      generation: session.generation,
    };
    return session.certificate;
  }

  abortSession(sessionId, expectedGeneration) {
    const session = this.sessions.get(sessionId);
    if (session.state === "retiring-awaiting-local") return session.generation;
    if (
      session.state !== "pending" ||
      session.generation !== expectedGeneration
    )
      fail("invalid_state");
    session.state = "retiring-awaiting-local";
    session.generation += 1;
    return session.generation;
  }

  acknowledgeSession(sessionId, localState) {
    const session = this.sessions.get(sessionId);
    if (
      session.state === "initializing-awaiting-local" &&
      localState === "initialized"
    )
      session.state = "initialized";
    else if (
      session.state === "retiring-awaiting-local" &&
      localState === "retired"
    ) {
      session.state = "retired";
      this.openDatabaseSessions.delete(session.databaseIdentity);
    } else fail("invalid_state");
    return session.state;
  }

  reserveEpoch(databaseIdentity, agentId) {
    const key = `${databaseIdentity}\0${agentId}`;
    const next = (this.epochHighWatermarks.get(key) ?? 0) + 1;
    this.epochHighWatermarks.set(key, next);
    return next;
  }

  startAgentAttempt(input) {
    const invalidatedTarget = `${input.recoverySessionId}\0${input.agentId}\0${input.targetControlInstanceId}`;
    if (this.invalidatedAgentTargets.has(invalidatedTarget))
      fail("invalid_state");
    const key = `${input.recoverySessionId}\0${input.agentId}\0${input.qualificationGeneration}`;
    const openId = this.openAttempts.get(key);
    if (
      openId &&
      !["aborted", "consumed", "invalidated"].includes(
        this.attempts.get(openId).state,
      )
    ) {
      fail("recovery_in_progress");
    }
    const attempt = { ...input, state: "executing", generation: 0 };
    this.attempts.set(input.agentAttemptId, attempt);
    this.openAttempts.set(key, input.agentAttemptId);
    return attempt;
  }

  abortAgentAttempt(attemptId, expectedGeneration) {
    const attempt = this.attempts.get(attemptId);
    if (attempt.state === "aborted-awaiting-local") return attempt;
    if (
      attempt.state !== "executing" ||
      attempt.generation !== expectedGeneration
    )
      fail("invalid_state");
    attempt.state = "aborted-awaiting-local";
    attempt.generation += 1;
    return attempt;
  }

  acknowledgeAgentAbort(attemptId) {
    const attempt = this.attempts.get(attemptId);
    if (attempt.state !== "aborted-awaiting-local") fail("invalid_state");
    attempt.state = "aborted";
    return attempt;
  }

  bind(attemptId, expectedGeneration, evidence, command) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) fail("invalid_state");
    const verifiedArtifact = requireVerifiedEvidence(
      evidence,
      "recovery-artifact",
      attempt.expectedArtifactContext,
      this.expectedIssuer,
    );
    const artifact = verifiedArtifact.claims;
    if (
      artifact.agentAttemptId !== attemptId ||
      artifact.recoverySessionId !== attempt.recoverySessionId ||
      artifact.agentId !== attempt.agentId ||
      artifact.qualificationGeneration !== attempt.qualificationGeneration ||
      artifact.targetControlInstanceId !== attempt.targetControlInstanceId ||
      command.targetControlInstanceId !== attempt.targetControlInstanceId ||
      artifact.commandDigest !== command.commandDigest
    )
      fail("target_mismatch");
    if (attempt.state === "bound") {
      const certificate = this.certificates.get(attempt.certificateId);
      if (
        certificate.commandId !== command.commandId ||
        certificate.commandDigest !== command.commandDigest ||
        certificate.artifactId !== artifact.artifactId ||
        certificate.evidenceDigest !== verifiedArtifact.envelopeDigest
      )
        fail("target_mismatch");
      return certificate;
    }
    if (
      attempt.state !== "executing" ||
      attempt.generation !== expectedGeneration
    )
      fail("invalid_state");
    verifiedArtifact.consume();
    attempt.state = "bound";
    attempt.generation += 1;
    attempt.certificateId = `binding:${attemptId}:${attempt.generation}`;
    const certificate = {
      certificateId: attempt.certificateId,
      attemptId,
      commandId: command.commandId,
      commandDigest: command.commandDigest,
      artifactId: artifact.artifactId,
      targetControlInstanceId: attempt.targetControlInstanceId,
      reservedEpoch: artifact.reservedEpoch,
      evidenceDigest: verifiedArtifact.envelopeDigest,
      recoverySessionId: attempt.recoverySessionId,
      agentId: attempt.agentId,
      qualificationGeneration: attempt.qualificationGeneration,
      state: "bound",
      permitGeneration: 0,
    };
    this.certificates.set(certificate.certificateId, certificate);
    return certificate;
  }

  issuePermit(certificateId, evidence) {
    const certificate = this.certificates.get(certificateId);
    if (!certificate || certificate.state !== "bound") fail("stale_authority");
    const expectedContext = {
      authorityId: this.expectedAuthority.authorityId,
      authorityVersion: this.expectedAuthority.authorityVersion,
      certificateId,
      commandId: certificate.commandId,
      targetControlInstanceId: certificate.targetControlInstanceId,
      reservedEpoch: certificate.reservedEpoch,
      artifactEvidenceDigest: certificate.evidenceDigest,
      permitGeneration: certificate.permitGeneration + 1,
    };
    const verifiedPermit = requireVerifiedEvidence(
      evidence,
      "activation-permit",
      expectedContext,
      this.expectedIssuer,
    );
    const claims = verifiedPermit.claims;
    if (
      claims.certificateId !== certificateId ||
      claims.commandId !== certificate.commandId ||
      claims.targetControlInstanceId !== certificate.targetControlInstanceId ||
      claims.reservedEpoch !== certificate.reservedEpoch ||
      claims.artifactEvidenceDigest !== certificate.evidenceDigest ||
      claims.permitGeneration !== certificate.permitGeneration + 1
    )
      fail("stale_authority");
    verifiedPermit.consume();
    const current = this.permits.get(certificateId);
    if (current?.state === "issued") current.state = "superseded";
    certificate.permitGeneration = claims.permitGeneration;
    const permit = {
      ...claims,
      generation: claims.permitGeneration,
      state: "issued",
    };
    this.permits.set(certificateId, permit);
    return permit;
  }

  invalidateBinding(certificateId, evidence, expectedContext) {
    const verifiedConflict = requireVerifiedEvidence(
      evidence,
      "bound-conflict",
      expectedContext,
      this.expectedIssuer,
    );
    const certificate = this.certificates.get(certificateId);
    if (!certificate) fail("stale_authority");
    const attempt = this.attempts.get(certificate.attemptId);
    if (certificate.state === "binding-invalidated-awaiting-local")
      return certificate;
    if (certificate.state !== "bound") fail("stale_authority");
    const conflict = verifiedConflict.claims;
    if (
      !this.manifest.boundConflict.allowedKinds.includes(conflict.kind) ||
      conflict.certificateId !== certificateId ||
      conflict.commandId !== certificate.commandId ||
      conflict.artifactEvidenceDigest !== certificate.evidenceDigest ||
      conflict.recoverySessionId !== attempt.recoverySessionId ||
      conflict.agentId !== attempt.agentId ||
      conflict.qualificationGeneration !== attempt.qualificationGeneration ||
      conflict.targetControlInstanceId !== attempt.targetControlInstanceId ||
      !conflict.recoveryOperationId
    )
      fail("stale_authority");
    verifiedConflict.consume();
    certificate.state = "binding-invalidated-awaiting-local";
    attempt.state = "binding-invalidated-awaiting-local";
    const permit = this.permits.get(certificateId);
    if (permit) permit.state = "revoked";
    return certificate;
  }

  acknowledgeBindingInvalidated(certificateId) {
    const certificate = this.certificates.get(certificateId);
    if (certificate.state !== "binding-invalidated-awaiting-local")
      fail("invalid_state");
    certificate.state = "invalidated";
    const attempt = this.attempts.get(certificate.attemptId);
    attempt.state = "invalidated";
    this.invalidatedAgentTargets.add(
      `${attempt.recoverySessionId}\0${attempt.agentId}\0${attempt.targetControlInstanceId}`,
    );
    return certificate;
  }

  consumeBinding(
    certificateId,
    {
      nowUtcMs,
      currentAuthorityGeneration,
      currentBootId,
      currentStartupCycleId,
      currentHostAttestationId,
      currentHostGeneration,
      currentTimeEvidenceId,
      currentTimeGeneration,
    },
  ) {
    const certificate = this.certificates.get(certificateId);
    const permit = this.permits.get(certificateId);
    if (
      certificate.state !== "bound" ||
      permit?.state !== "issued" ||
      permit.authorityGeneration !== currentAuthorityGeneration ||
      permit.bootId !== currentBootId ||
      permit.startupCycleId !== currentStartupCycleId ||
      permit.hostAttestationId !== currentHostAttestationId ||
      permit.hostGeneration !== currentHostGeneration ||
      permit.timeEvidenceId !== currentTimeEvidenceId ||
      permit.timeGeneration !== currentTimeGeneration ||
      permit.issuedAtUtcMs > nowUtcMs ||
      nowUtcMs >= permit.expiresAtUtcMs
    )
      fail("invalid_state");
    permit.state = "consumed";
    certificate.state = "consumed";
    this.attempts.get(certificate.attemptId).state = "consumed";
    return certificate;
  }

  registry(instanceId) {
    if (!this.registries.has(instanceId))
      this.registries.set(instanceId, {
        sequence: 0,
        closed: false,
        members: [],
      });
    return this.registries.get(instanceId);
  }

  registerAuthority(instanceId, member) {
    const registry = this.registry(instanceId);
    if (registry.closed) fail("stale_authority");
    registry.sequence += 1;
    registry.members.push({ ...member, sequence: registry.sequence });
    return registry.sequence;
  }

  closeRegistration(instanceId) {
    const registry = this.registry(instanceId);
    if (registry.closed)
      return { sequence: registry.sequence, members: [...registry.members] };
    registry.sequence += 1;
    registry.closed = true;
    return { sequence: registry.sequence, members: [...registry.members] };
  }
}
