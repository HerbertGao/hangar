PRAGMA foreign_keys = ON;

CREATE TABLE storage_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_identity TEXT NOT NULL UNIQUE,
  current_control_instance_id TEXT,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('enabled', 'recovery-only', 'read-only'))
) STRICT;

CREATE TABLE control_instance_ids (
  control_instance_id TEXT PRIMARY KEY,
  database_identity TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('proposed', 'active', 'historical', 'retired')),
  FOREIGN KEY (database_identity) REFERENCES storage_identity(database_identity),
  UNIQUE (control_instance_id, database_identity)
) STRICT;

CREATE TABLE control_instances (
  control_instance_id TEXT PRIMARY KEY,
  database_identity TEXT NOT NULL,
  incarnation_kind TEXT NOT NULL CHECK (incarnation_kind IN ('genesis', 'resumed', 'recovery-target', 'historical')),
  state TEXT NOT NULL CHECK (state IN ('writable', 'quarantined', 'closed', 'retired')),
  boot_id TEXT,
  startup_cycle_id TEXT,
  continuation_authority_scope_id TEXT,
  continuation_proof_digest TEXT,
  continuation_evidence_id TEXT,
  resumed_fact_seq INTEGER,
  FOREIGN KEY (control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (database_identity) REFERENCES storage_identity(database_identity),
  FOREIGN KEY (continuation_evidence_id) REFERENCES authenticated_evidence(evidence_id),
  UNIQUE (database_identity, control_instance_id),
  CHECK (
    (continuation_authority_scope_id IS NULL AND continuation_proof_digest IS NULL AND continuation_evidence_id IS NULL AND resumed_fact_seq IS NULL) OR
    (continuation_authority_scope_id IS NOT NULL AND continuation_proof_digest IS NOT NULL AND continuation_evidence_id IS NOT NULL AND resumed_fact_seq IS NOT NULL)
  )
) STRICT;

CREATE TABLE source_fact_kinds (
  fact_kind TEXT PRIMARY KEY
) STRICT;

INSERT INTO source_fact_kinds(fact_kind) VALUES
  ('database-genesis'),
  ('control-instance-resumed'),
  ('release-published'),
  ('time-observed'),
  ('activation-changed'),
  ('activation-quarantined'),
  ('run-admitted'),
  ('run-attempt-allocated'),
  ('run-attempt-state'),
  ('run-health'),
  ('run-terminal'),
  ('attempt-quiesced'),
  ('harness-session-started'),
  ('action-registered'),
  ('action-event'),
  ('checkpoint-appended'),
  ('obligation-owner-transferred'),
  ('outcome-proposed'),
  ('process-registered'),
  ('process-signal'),
  ('process-exit'),
  ('process-reaped'),
  ('approval-requested'),
  ('approval-decided'),
  ('effect-intent'),
  ('effect-claim'),
  ('effect-dispatch-started'),
  ('local-dispatch-result'),
  ('external-receipt'),
  ('post-final-conflict'),
  ('reconciliation-claim'),
  ('reconciliation-observation'),
  ('external-outcome'),
  ('launch-attestation'),
  ('launch-attestation-invalidated'),
  ('command-result'),
  ('mutation-authority-registered'),
  ('mutation-authority-revoked'),
  ('registration-closed'),
  ('target-authority-closed'),
  ('recovery-session'),
  ('recovery-qualification'),
  ('recovery-operation-discovered'),
  ('recovery-operation-claim'),
  ('recovery-operation-outcome'),
  ('recovery-post-final-conflict'),
  ('recovery-agent-binding-conflict'),
  ('recovery-binding-invalidated'),
  ('binding-certificate'),
  ('activation-permit-evidence');

CREATE TRIGGER source_fact_kinds_no_update
BEFORE UPDATE ON source_fact_kinds BEGIN
  SELECT RAISE(ABORT, 'fact_kind_catalog_append_only');
END;

CREATE TRIGGER source_fact_kinds_no_delete
BEFORE DELETE ON source_fact_kinds BEGIN
  SELECT RAISE(ABORT, 'fact_kind_catalog_append_only');
END;

CREATE TABLE source_facts (
  fact_seq INTEGER PRIMARY KEY CHECK (fact_seq > 0),
  database_identity TEXT NOT NULL,
  previous_fact_hash TEXT NOT NULL CHECK (length(previous_fact_hash) = 64),
  fact_hash TEXT NOT NULL UNIQUE CHECK (length(fact_hash) = 64),
  fact_kind TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  producer_proof_digest TEXT NOT NULL CHECK (length(producer_proof_digest) = 64),
  FOREIGN KEY (database_identity) REFERENCES storage_identity(database_identity),
  FOREIGN KEY (fact_kind) REFERENCES source_fact_kinds(fact_kind)
) STRICT;

CREATE TRIGGER source_facts_contiguous
BEFORE INSERT ON source_facts BEGIN
  SELECT CASE
    WHEN NEW.fact_seq != COALESCE((SELECT MAX(fact_seq) + 1 FROM source_facts), 1)
    THEN RAISE(ABORT, 'fact_seq_gap')
  END;
  SELECT CASE
    WHEN NEW.previous_fact_hash != COALESCE(
      (SELECT fact_hash FROM source_facts ORDER BY fact_seq DESC LIMIT 1),
      '0000000000000000000000000000000000000000000000000000000000000000'
    )
    THEN RAISE(ABORT, 'previous_fact_hash_mismatch')
  END;
END;

CREATE TRIGGER source_facts_no_update
BEFORE UPDATE ON source_facts BEGIN
  SELECT RAISE(ABORT, 'source_facts_append_only');
END;

CREATE TRIGGER source_facts_no_delete
BEFORE DELETE ON source_facts BEGIN
  SELECT RAISE(ABORT, 'source_facts_append_only');
END;

CREATE TABLE authenticated_evidence (
  evidence_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (profile_id IN ('production-child', 'clean-restart', 'recovery-artifact', 'activation-permit', 'bound-conflict', 'target-authority-closed')),
  issuer_id TEXT NOT NULL,
  authority_version TEXT NOT NULL,
  key_version TEXT NOT NULL,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  signature_base64 TEXT NOT NULL,
  envelope_digest TEXT NOT NULL UNIQUE CHECK (length(envelope_digest) = 64),
  authorized_payload_digest TEXT NOT NULL CHECK (length(authorized_payload_digest) = 64),
  expected_context_digest TEXT NOT NULL CHECK (length(expected_context_digest) = 64),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  issued_at_utc_ms INTEGER NOT NULL,
  expires_at_utc_ms INTEGER NOT NULL CHECK (expires_at_utc_ms > issued_at_utc_ms),
  single_use INTEGER NOT NULL CHECK (single_use IN (0, 1)),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  UNIQUE (evidence_id, profile_id, envelope_digest)
) STRICT;

CREATE TRIGGER authenticated_evidence_fact_kind_guard
BEFORE INSERT ON authenticated_evidence BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_facts
    WHERE fact_seq = NEW.fact_seq
      AND fact_kind = CASE NEW.profile_id
        WHEN 'production-child' THEN 'launch-attestation'
        WHEN 'clean-restart' THEN 'control-instance-resumed'
        WHEN 'recovery-artifact' THEN 'binding-certificate'
        WHEN 'activation-permit' THEN 'activation-permit-evidence'
        WHEN 'bound-conflict' THEN 'recovery-agent-binding-conflict'
        WHEN 'target-authority-closed' THEN 'target-authority-closed'
      END
  ) THEN RAISE(ABORT, 'authenticated_evidence_fact_kind_mismatch') END;
END;

CREATE TRIGGER authenticated_evidence_no_update
BEFORE UPDATE ON authenticated_evidence BEGIN
  SELECT RAISE(ABORT, 'authenticated_evidence_immutable');
END;

CREATE TRIGGER authenticated_evidence_no_delete
BEFORE DELETE ON authenticated_evidence BEGIN
  SELECT RAISE(ABORT, 'authenticated_evidence_immutable');
END;

CREATE TRIGGER control_instance_continuation_evidence_insert_guard
BEFORE INSERT ON control_instances
WHEN NEW.continuation_evidence_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_evidence AS evidence
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'control-instance-resume'
     AND consumption.consumer_id = NEW.control_instance_id
     AND consumption.consumption_generation = json_extract(evidence.envelope_json, '$.claims.continuationGeneration')
     AND consumption.fact_seq = evidence.fact_seq
    JOIN evidence_authority_heads AS authority
      ON authority.authority_scope_id = NEW.continuation_authority_scope_id
     AND authority.authority_generation = evidence.authority_generation
     AND authority.current_state_digest = evidence.current_state_digest
    WHERE evidence.evidence_id = NEW.continuation_evidence_id
      AND evidence.profile_id = 'clean-restart'
      AND json_extract(evidence.envelope_json, '$.claims.authorityId') = evidence.issuer_id
      AND json_extract(evidence.envelope_json, '$.claims.authorityVersion') = evidence.authority_version
      AND evidence.envelope_digest = NEW.continuation_proof_digest
      AND evidence.fact_seq = NEW.resumed_fact_seq
  ) THEN RAISE(ABORT, 'continuation_evidence_context_mismatch') END;
END;

CREATE TRIGGER control_instance_continuation_evidence_update_guard
BEFORE UPDATE OF
  continuation_authority_scope_id,
  continuation_proof_digest,
  continuation_evidence_id,
  resumed_fact_seq
ON control_instances
WHEN NEW.continuation_evidence_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_evidence AS evidence
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'control-instance-resume'
     AND consumption.consumer_id = NEW.control_instance_id
     AND consumption.consumption_generation = json_extract(evidence.envelope_json, '$.claims.continuationGeneration')
     AND consumption.fact_seq = evidence.fact_seq
    JOIN evidence_authority_heads AS authority
      ON authority.authority_scope_id = NEW.continuation_authority_scope_id
     AND authority.authority_generation = evidence.authority_generation
     AND authority.current_state_digest = evidence.current_state_digest
    WHERE evidence.evidence_id = NEW.continuation_evidence_id
      AND evidence.profile_id = 'clean-restart'
      AND json_extract(evidence.envelope_json, '$.claims.authorityId') = evidence.issuer_id
      AND json_extract(evidence.envelope_json, '$.claims.authorityVersion') = evidence.authority_version
      AND evidence.envelope_digest = NEW.continuation_proof_digest
      AND evidence.fact_seq = NEW.resumed_fact_seq
      AND json_extract(evidence.envelope_json, '$.claims.databaseIdentity') = NEW.database_identity
      AND json_extract(evidence.envelope_json, '$.claims.targetControlInstanceId') = NEW.control_instance_id
      AND json_extract(evidence.envelope_json, '$.claims.priorIncarnationState') = OLD.state
      AND json_extract(evidence.envelope_json, '$.claims.bootId') = NEW.boot_id
      AND json_extract(evidence.envelope_json, '$.claims.startupCycleId') = NEW.startup_cycle_id
  ) THEN RAISE(ABORT, 'continuation_evidence_context_mismatch') END;
END;

CREATE TABLE authenticated_evidence_consumptions (
  evidence_id TEXT PRIMARY KEY,
  consumer_kind TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  consumption_generation INTEGER NOT NULL CHECK (consumption_generation >= 0),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (evidence_id) REFERENCES authenticated_evidence(evidence_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TRIGGER authenticated_evidence_consumption_single_use_guard
BEFORE INSERT ON authenticated_evidence_consumptions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_evidence
    WHERE evidence_id = NEW.evidence_id
      AND single_use = 1
      AND fact_seq = NEW.fact_seq
      AND profile_id = CASE NEW.consumer_kind
        WHEN 'production-child' THEN 'production-child'
        WHEN 'control-instance-resume' THEN 'clean-restart'
        WHEN 'recovery-artifact' THEN 'recovery-artifact'
        WHEN 'activation-permit' THEN 'activation-permit'
        WHEN 'bound-conflict' THEN 'bound-conflict'
      END
  ) THEN RAISE(ABORT, 'evidence_consumption_profile_mismatch') END;
END;

CREATE TRIGGER authenticated_evidence_consumptions_no_update
BEFORE UPDATE ON authenticated_evidence_consumptions BEGIN
  SELECT RAISE(ABORT, 'authenticated_evidence_consumption_immutable');
END;

CREATE TRIGGER authenticated_evidence_consumptions_no_delete
BEFORE DELETE ON authenticated_evidence_consumptions BEGIN
  SELECT RAISE(ABORT, 'authenticated_evidence_consumption_immutable');
END;

CREATE TABLE evidence_authority_heads (
  authority_scope_id TEXT PRIMARY KEY,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  boot_id TEXT NOT NULL,
  startup_cycle_id TEXT NOT NULL,
  host_attestation_id TEXT NOT NULL,
  host_attestation_digest TEXT NOT NULL CHECK (length(host_attestation_digest) = 64),
  host_generation INTEGER NOT NULL CHECK (host_generation >= 0),
  time_evidence_id TEXT NOT NULL,
  time_evidence_digest TEXT NOT NULL CHECK (length(time_evidence_digest) = 64),
  time_generation INTEGER NOT NULL CHECK (time_generation >= 0),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  UNIQUE (
    authority_scope_id,
    authority_generation,
    boot_id,
    startup_cycle_id,
    host_attestation_id,
    host_attestation_digest,
    host_generation,
    time_evidence_id,
    time_evidence_digest,
    time_generation
  )
) STRICT;

CREATE TRIGGER evidence_authority_heads_monotonic
BEFORE UPDATE ON evidence_authority_heads BEGIN
  SELECT CASE WHEN
    NEW.authority_scope_id != OLD.authority_scope_id OR
    NEW.authority_generation < OLD.authority_generation OR
    NEW.host_generation < OLD.host_generation OR
    NEW.time_generation < OLD.time_generation OR
    NEW.fact_seq <= OLD.fact_seq
  THEN RAISE(ABORT, 'evidence_authority_head_not_monotonic') END;
END;

CREATE TRIGGER evidence_authority_heads_no_delete
BEFORE DELETE ON evidence_authority_heads BEGIN
  SELECT RAISE(ABORT, 'evidence_authority_head_immutable');
END;

CREATE TRIGGER database_identity_immutable
BEFORE UPDATE OF database_identity ON storage_identity BEGIN
  SELECT RAISE(ABORT, 'database_identity_immutable');
END;

CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY
) STRICT;

CREATE TABLE agent_releases (
  release_id TEXT PRIMARY KEY CHECK (length(release_id) = 64),
  agent_id TEXT NOT NULL,
  release_json TEXT NOT NULL CHECK (json_valid(release_json)),
  execution_closure_digest TEXT NOT NULL CHECK (length(execution_closure_digest) = 64),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  UNIQUE (agent_id, release_id)
) STRICT;

CREATE TRIGGER agent_releases_no_update
BEFORE UPDATE ON agent_releases BEGIN
  SELECT RAISE(ABORT, 'agent_release_immutable');
END;

CREATE TRIGGER agent_releases_no_delete
BEFORE DELETE ON agent_releases BEGIN
  SELECT RAISE(ABORT, 'agent_release_immutable');
END;

CREATE TABLE activations (
  activation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('inactive', 'shadow', 'active', 'draining', 'quarantined')),
  production_attestation_generation INTEGER,
  FOREIGN KEY (agent_id, release_id) REFERENCES agent_releases(agent_id, release_id),
  UNIQUE (agent_id, activation_id),
  UNIQUE (agent_id, activation_id, release_id),
  UNIQUE (agent_id, activation_id, release_id, epoch),
  UNIQUE (agent_id, epoch)
) STRICT;

CREATE UNIQUE INDEX activations_one_production_owner
ON activations(agent_id) WHERE state = 'active';

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  activation_epoch INTEGER NOT NULL CHECK (activation_epoch >= 0),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'intent', 'evaluator')),
  trigger_id TEXT NOT NULL,
  trigger_input_digest TEXT NOT NULL CHECK (length(trigger_input_digest) = 64),
  authority_context_digest TEXT NOT NULL CHECK (length(authority_context_digest) = 64),
  admission_attestation_digest TEXT NOT NULL CHECK (length(admission_attestation_digest) = 64),
  FOREIGN KEY (agent_id, release_id) REFERENCES agent_releases(agent_id, release_id),
  FOREIGN KEY (agent_id, activation_id) REFERENCES activations(agent_id, activation_id),
  UNIQUE (run_id, release_id),
  UNIQUE (run_id, release_id, activation_epoch)
) STRICT;

CREATE TRIGGER activations_identity_immutable
BEFORE UPDATE OF agent_id, activation_id, release_id ON activations BEGIN
  SELECT RAISE(ABORT, 'activation_identity_immutable');
END;

CREATE TRIGGER activations_epoch_monotonic
BEFORE UPDATE OF epoch ON activations
WHEN NEW.epoch < OLD.epoch BEGIN
  SELECT RAISE(ABORT, 'activation_epoch_rollback');
END;

CREATE TRIGGER runs_activation_binding
BEFORE INSERT ON runs BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM activations
    WHERE agent_id = NEW.agent_id
      AND activation_id = NEW.activation_id
      AND release_id = NEW.release_id
      AND epoch = NEW.activation_epoch
  ) THEN RAISE(ABORT, 'run_activation_binding_mismatch') END;
END;

CREATE TRIGGER runs_no_update
BEFORE UPDATE ON runs BEGIN
  SELECT RAISE(ABORT, 'run_identity_immutable');
END;

CREATE TRIGGER runs_no_delete
BEFORE DELETE ON runs BEGIN
  SELECT RAISE(ABORT, 'run_identity_immutable');
END;

CREATE TABLE run_events (
  run_id TEXT NOT NULL,
  run_seq INTEGER NOT NULL CHECK (run_seq > 0),
  fact_seq INTEGER NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,
  PRIMARY KEY (run_id, run_seq),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TRIGGER run_events_contiguous
BEFORE INSERT ON run_events BEGIN
  SELECT CASE
    WHEN NEW.run_seq != COALESCE((SELECT MAX(run_seq) + 1 FROM run_events WHERE run_id = NEW.run_id), 1)
    THEN RAISE(ABORT, 'run_seq_gap')
  END;
END;

CREATE TABLE run_attempts (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  harness_session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('created', 'starting', 'running', 'quiescing', 'checkpointed', 'succeeded', 'failed', 'cancelled')),
  runtime_identity_digest TEXT NOT NULL CHECK (length(runtime_identity_digest) = 64),
  deadline_utc_ms INTEGER NOT NULL,
  input_checkpoint_id TEXT,
  PRIMARY KEY (run_id, attempt),
  UNIQUE (run_id, attempt, harness_session_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (run_id, input_checkpoint_id)
    REFERENCES checkpoints(run_id, checkpoint_id)
) STRICT;

CREATE TABLE attempt_quiescence (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  quiescence_generation INTEGER NOT NULL CHECK (quiescence_generation >= 0),
  harness_session_id TEXT NOT NULL,
  containment_id TEXT NOT NULL,
  containment_generation INTEGER NOT NULL CHECK (containment_generation >= 0),
  grant_revocation_generation INTEGER NOT NULL CHECK (grant_revocation_generation >= 0),
  obligation_set_digest TEXT NOT NULL CHECK (length(obligation_set_digest) = 64),
  fact_seq INTEGER NOT NULL UNIQUE,
  consumed_by_attempt INTEGER,
  PRIMARY KEY (run_id, attempt, quiescence_generation),
  FOREIGN KEY (run_id, attempt, harness_session_id)
    REFERENCES run_attempts(run_id, attempt, harness_session_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  FOREIGN KEY (run_id, consumed_by_attempt) REFERENCES run_attempts(run_id, attempt),
  CHECK (
    consumed_by_attempt IS NULL
    OR consumed_by_attempt = attempt + 1
  )
) STRICT;

CREATE UNIQUE INDEX attempt_quiescence_single_consumption
ON attempt_quiescence(run_id, consumed_by_attempt) WHERE consumed_by_attempt IS NOT NULL;

CREATE TABLE actions (
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  origin_attempt INTEGER NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('tool', 'subagent', 'provider', 'effect-origin')),
  parent_action_id TEXT,
  input_artifact_digest TEXT NOT NULL CHECK (length(input_artifact_digest) = 64),
  command_id TEXT NOT NULL,
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, action_id),
  UNIQUE (run_id, action_id, origin_attempt),
  FOREIGN KEY (run_id, origin_attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY (run_id, parent_action_id) REFERENCES actions(run_id, action_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  CHECK (parent_action_id IS NULL OR parent_action_id != action_id)
) STRICT;

CREATE TABLE action_events (
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_event_seq INTEGER NOT NULL CHECK (action_event_seq > 0),
  producer_attempt INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('action-started', 'action-progress', 'inner-retry', 'tool-result', 'subagent-result', 'action-succeeded', 'action-failed', 'action-skipped')),
  actual_identity_digest TEXT NOT NULL CHECK (length(actual_identity_digest) = 64),
  effective_grant_digest TEXT NOT NULL CHECK (length(effective_grant_digest) = 64),
  inner_retry_ordinal INTEGER CHECK (inner_retry_ordinal IS NULL OR inner_retry_ordinal >= 0),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, action_id, action_event_seq),
  FOREIGN KEY (run_id, action_id) REFERENCES actions(run_id, action_id),
  FOREIGN KEY (run_id, producer_attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  CHECK (
    (event_kind = 'inner-retry' AND inner_retry_ordinal IS NOT NULL)
    OR (event_kind != 'inner-retry' AND inner_retry_ordinal IS NULL)
  )
) STRICT;

CREATE TRIGGER action_events_contiguous
BEFORE INSERT ON action_events BEGIN
  SELECT CASE
    WHEN NEW.action_event_seq != COALESCE(
      (SELECT MAX(action_event_seq) + 1 FROM action_events WHERE run_id = NEW.run_id AND action_id = NEW.action_id),
      1
    )
    THEN RAISE(ABORT, 'action_event_seq_gap')
  END;
END;

CREATE TABLE checkpoints (
  run_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  producer_attempt INTEGER NOT NULL,
  producer_action_id TEXT NOT NULL,
  checkpoint_schema_id TEXT NOT NULL,
  checkpoint_schema_version INTEGER NOT NULL CHECK (checkpoint_schema_version >= 0),
  artifact_ref_json TEXT NOT NULL CHECK (json_valid(artifact_ref_json)),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('human', 'effect', 'external-input')),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, checkpoint_id),
  FOREIGN KEY (run_id, release_id) REFERENCES runs(run_id, release_id),
  FOREIGN KEY (release_id) REFERENCES agent_releases(release_id),
  FOREIGN KEY (run_id, producer_attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY (run_id, producer_action_id, producer_attempt)
    REFERENCES actions(run_id, action_id, origin_attempt),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  intent_generation INTEGER NOT NULL CHECK (intent_generation >= 0),
  operation TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  first_origin_attempt INTEGER NOT NULL,
  first_origin_action_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent-recorded', 'approval-pending', 'authorized', 'claimed', 'dispatch-started', 'unknown', 'committed', 'not-committed', 'conflicted')),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (run_id, first_origin_attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY (run_id, first_origin_action_id, first_origin_attempt)
    REFERENCES actions(run_id, action_id, origin_attempt),
  UNIQUE (run_id, intent_key, intent_generation),
  UNIQUE (effect_id, intent_generation),
  UNIQUE (effect_id, run_id, intent_generation, operation)
) STRICT;

CREATE TRIGGER effects_first_origin_immutable
BEFORE UPDATE OF run_id, intent_key, intent_generation, operation, intent_digest, first_origin_attempt, first_origin_action_id
ON effects BEGIN
  SELECT RAISE(ABORT, 'effect_identity_immutable');
END;

CREATE TABLE checkpoint_obligations (
  run_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  obligation_kind TEXT NOT NULL CHECK (obligation_kind IN ('effect', 'human', 'external-input')),
  subject_id TEXT NOT NULL,
  subject_generation INTEGER NOT NULL CHECK (subject_generation >= 0),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('control', 'effect-gateway', 'reconciliation')),
  owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
  effect_id TEXT,
  intent_generation INTEGER,
  PRIMARY KEY (run_id, checkpoint_id, obligation_kind, subject_id, subject_generation),
  FOREIGN KEY (run_id, checkpoint_id) REFERENCES checkpoints(run_id, checkpoint_id),
  FOREIGN KEY (effect_id, intent_generation) REFERENCES effects(effect_id, intent_generation),
  CHECK (
    (obligation_kind = 'effect' AND effect_id IS NOT NULL AND intent_generation IS NOT NULL)
    OR (obligation_kind != 'effect' AND effect_id IS NULL AND intent_generation IS NULL)
  )
) STRICT;

CREATE TABLE obligation_owner_transfers (
  run_id TEXT NOT NULL,
  obligation_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_generation INTEGER NOT NULL CHECK (subject_generation >= 0),
  from_owner_kind TEXT NOT NULL,
  from_owner_generation INTEGER NOT NULL CHECK (from_owner_generation >= 0),
  to_owner_kind TEXT NOT NULL,
  to_owner_generation INTEGER NOT NULL CHECK (to_owner_generation >= 0),
  transfer_authority_digest TEXT NOT NULL CHECK (length(transfer_authority_digest) = 64),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, obligation_kind, subject_id, subject_generation, from_owner_kind, from_owner_generation),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  CHECK (to_owner_generation = from_owner_generation + 1)
) STRICT;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
  policy_version TEXT NOT NULL,
  authority_context_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'deciding', 'approved', 'rejected', 'expired', 'superseded')),
  expires_at_utc_ms INTEGER NOT NULL,
  FOREIGN KEY (effect_id) REFERENCES effects(effect_id)
) STRICT;

CREATE TABLE effect_claims (
  effect_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
  intent_generation INTEGER NOT NULL CHECK (intent_generation >= 0),
  release_id TEXT NOT NULL,
  activation_epoch INTEGER NOT NULL CHECK (activation_epoch >= 0),
  sink TEXT NOT NULL,
  operation TEXT NOT NULL,
  audience TEXT NOT NULL,
  expires_at_utc_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'used', 'revoked', 'expired')),
  PRIMARY KEY (effect_id, claim_generation),
  FOREIGN KEY (effect_id, intent_generation) REFERENCES effects(effect_id, intent_generation),
  FOREIGN KEY (release_id) REFERENCES agent_releases(release_id),
  UNIQUE (
    effect_id,
    claim_generation,
    intent_generation,
    release_id,
    activation_epoch,
    sink,
    operation
  )
) STRICT;

CREATE TABLE effect_dispatches (
  effect_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation >= 0),
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
  database_identity TEXT NOT NULL,
  control_instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  intent_generation INTEGER NOT NULL CHECK (intent_generation >= 0),
  release_id TEXT NOT NULL,
  activation_epoch INTEGER NOT NULL CHECK (activation_epoch >= 0),
  connector_id TEXT NOT NULL,
  sink TEXT NOT NULL,
  operation TEXT NOT NULL,
  external_request_id TEXT NOT NULL,
  discovery_key TEXT NOT NULL,
  launch_attestation_id TEXT NOT NULL,
  launch_attestation_digest TEXT NOT NULL CHECK (length(launch_attestation_digest) = 64),
  launch_attestation_generation INTEGER NOT NULL CHECK (launch_attestation_generation >= 0),
  launch_attestation_mode TEXT NOT NULL CHECK (launch_attestation_mode = 'effect-dispatch'),
  launch_attestation_status TEXT NOT NULL CHECK (launch_attestation_status = 'verified'),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (effect_id, dispatch_generation),
  FOREIGN KEY (effect_id, run_id, intent_generation, operation)
    REFERENCES effects(effect_id, run_id, intent_generation, operation),
  FOREIGN KEY (run_id, release_id, activation_epoch)
    REFERENCES runs(run_id, release_id, activation_epoch),
  FOREIGN KEY (
    effect_id,
    claim_generation,
    intent_generation,
    release_id,
    activation_epoch,
    sink,
    operation
  ) REFERENCES effect_claims(
    effect_id,
    claim_generation,
    intent_generation,
    release_id,
    activation_epoch,
    sink,
    operation
  ),
  FOREIGN KEY (control_instance_id, database_identity)
    REFERENCES control_instance_ids(control_instance_id, database_identity),
  FOREIGN KEY (
    launch_attestation_id,
    launch_attestation_digest,
    launch_attestation_generation,
    launch_attestation_mode,
    launch_attestation_status
  ) REFERENCES launch_attestations(
    launch_attestation_id,
    evidence_digest,
    generation,
    mode,
    status
  ),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  UNIQUE (effect_id, dispatch_generation, connector_id),
  UNIQUE (control_instance_id, sink, discovery_key)
) STRICT;

CREATE TABLE external_receipts (
  effect_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed', 'rejected', 'failed-not-committed')),
  connector_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  authority_type TEXT NOT NULL CHECK (authority_type = 'connector-authority'),
  authority_version TEXT NOT NULL,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  authentication_evidence_digest TEXT NOT NULL CHECK (length(authentication_evidence_digest) = 64),
  proof_ref TEXT NOT NULL,
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (effect_id, dispatch_generation),
  FOREIGN KEY (effect_id, dispatch_generation, connector_id)
    REFERENCES effect_dispatches(effect_id, dispatch_generation, connector_id),
  FOREIGN KEY (authority_id, authority_type, authority_version, authority_generation)
    REFERENCES mutation_authorities(authority_id, authority_type, authority_version, generation),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TABLE external_outcomes (
  effect_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'committed', 'not-committed', 'conflicted')),
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('pending', 'claimed', 'resolved-committed', 'resolved-not-committed', 'unresolved')),
  owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (effect_id) REFERENCES effects(effect_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TABLE launch_attestations (
  launch_attestation_id TEXT PRIMARY KEY,
  launch_attempt_id TEXT NOT NULL UNIQUE,
  challenge_digest TEXT NOT NULL UNIQUE CHECK (length(challenge_digest) = 64),
  host_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('production-control', 'production-child', 'effect-dispatch', 'recovery-control', 'mutation-disabled-evaluator')),
  startup_cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('verified', 'unverified-claim', 'unsupported')),
  verifier_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
  subject_binding_json TEXT NOT NULL CHECK (json_valid(subject_binding_json)),
  subject_identity_digest TEXT NOT NULL CHECK (length(subject_identity_digest) = 64),
  control_results_json TEXT NOT NULL CHECK (json_valid(control_results_json)),
  control_results_digest TEXT NOT NULL CHECK (length(control_results_digest) = 64),
  source_fact_payload_digest TEXT NOT NULL CHECK (length(source_fact_payload_digest) = 64),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  issued_at_utc_ms INTEGER NOT NULL,
  expires_at_utc_ms INTEGER NOT NULL CHECK (expires_at_utc_ms > issued_at_utc_ms),
  expected_context_digest TEXT CHECK (expected_context_digest IS NULL OR length(expected_context_digest) = 64),
  current_state_digest TEXT CHECK (current_state_digest IS NULL OR length(current_state_digest) = 64),
  authenticated_evidence_id TEXT,
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (authenticated_evidence_id) REFERENCES authenticated_evidence(evidence_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  UNIQUE (host_id, profile_id, mode, startup_cycle_id, generation),
  UNIQUE (launch_attestation_id, evidence_digest, generation, mode, status),
  CHECK (
    mode != 'production-child' OR
    (authenticated_evidence_id IS NOT NULL AND expected_context_digest IS NOT NULL AND current_state_digest IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER launch_attestation_evidence_profile_guard
BEFORE INSERT ON launch_attestations
WHEN NEW.mode = 'production-child' BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_evidence AS evidence
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'production-child'
     AND consumption.consumer_id = NEW.launch_attestation_id
     AND consumption.consumption_generation = NEW.generation
     AND consumption.fact_seq = evidence.fact_seq
    WHERE evidence.evidence_id = NEW.authenticated_evidence_id
      AND evidence.profile_id = 'production-child'
      AND evidence.envelope_digest = NEW.evidence_digest
      AND evidence.expected_context_digest = NEW.expected_context_digest
      AND evidence.current_state_digest = NEW.current_state_digest
      AND json_extract(evidence.envelope_json, '$.claims.hostId') = NEW.host_id
      AND json_extract(envelope_json, '$.claims.profileId') = NEW.profile_id
      AND json_extract(envelope_json, '$.claims.mode') = NEW.mode
      AND json_extract(envelope_json, '$.claims.launchAttemptId') = NEW.launch_attempt_id
      AND json_extract(envelope_json, '$.claims.challengeDigest') = NEW.challenge_digest
      AND json_extract(envelope_json, '$.claims.startupCycleId') = NEW.startup_cycle_id
      AND json_extract(envelope_json, '$.claims.authorityGeneration') = NEW.generation
      AND json_extract(envelope_json, '$.claims.issuedAtUtcMs') = NEW.issued_at_utc_ms
      AND json_extract(envelope_json, '$.claims.expiresAtUtcMs') = NEW.expires_at_utc_ms
      AND json_extract(NEW.subject_binding_json, '$.releaseId') = json_extract(envelope_json, '$.claims.releaseId')
      AND json_extract(NEW.subject_binding_json, '$.activationEpoch') = json_extract(envelope_json, '$.claims.activationEpoch')
      AND json_extract(NEW.subject_binding_json, '$.runId') = json_extract(envelope_json, '$.claims.runId')
      AND json_extract(NEW.subject_binding_json, '$.attempt') = json_extract(envelope_json, '$.claims.attempt')
      AND json_extract(NEW.subject_binding_json, '$.containmentId') = json_extract(envelope_json, '$.claims.containmentId')
      AND json_extract(NEW.subject_binding_json, '$.containmentGeneration') = json_extract(envelope_json, '$.claims.containmentGeneration')
  ) THEN RAISE(ABORT, 'launch_evidence_context_mismatch') END;
END;

CREATE TABLE process_ownership (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  containment_id TEXT NOT NULL,
  containment_generation INTEGER NOT NULL CHECK (containment_generation >= 0),
  host_boot_id TEXT NOT NULL,
  startup_cycle_id TEXT NOT NULL,
  root_pid INTEGER NOT NULL CHECK (root_pid > 0),
  root_start_time_fingerprint TEXT NOT NULL,
  launch_attestation_id TEXT NOT NULL,
  launch_attestation_digest TEXT NOT NULL CHECK (length(launch_attestation_digest) = 64),
  launch_attestation_generation INTEGER NOT NULL CHECK (launch_attestation_generation >= 0),
  launch_attestation_mode TEXT NOT NULL CHECK (launch_attestation_mode = 'production-child'),
  launch_attestation_status TEXT NOT NULL CHECK (launch_attestation_status = 'verified'),
  state TEXT NOT NULL CHECK (state IN ('bootstrap-gated', 'registered', 'attested', 'running', 'terminating', 'reaped', 'failed-before-entry')),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (run_id, attempt),
  UNIQUE (containment_id, containment_generation),
  FOREIGN KEY (run_id, attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY (
    launch_attestation_id,
    launch_attestation_digest,
    launch_attestation_generation,
    launch_attestation_mode,
    launch_attestation_status
  ) REFERENCES launch_attestations(
    launch_attestation_id,
    evidence_digest,
    generation,
    mode,
    status
  ),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  actor_subject_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  target_aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_schema_version TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL,
  first_authority_context_digest TEXT NOT NULL CHECK (length(first_authority_context_digest) = 64),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  precondition_digest TEXT NOT NULL CHECK (length(precondition_digest) = 64),
  preflight_time_evidence_digest TEXT CHECK (preflight_time_evidence_digest IS NULL OR length(preflight_time_evidence_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending-coordination', 'completed')),
  safe_result_json TEXT CHECK (safe_result_json IS NULL OR json_valid(safe_result_json)),
  recovery_session_id TEXT,
  proposed_target_control_instance_id TEXT,
  backup_digest TEXT,
  agent_set_digest TEXT,
  UNIQUE (actor_subject_id, command_kind, target_aggregate_id, idempotency_key),
  CHECK (
    status = 'completed'
    OR command_kind IN ('restore-init', 'abort-recovery', 'recover-activate')
  ),
  CHECK ((status = 'completed') OR safe_result_json IS NULL)
) STRICT;

CREATE TABLE schedule_series (
  agent_id TEXT NOT NULL,
  schedule_series_id TEXT NOT NULL,
  canonical_trigger_digest TEXT NOT NULL CHECK (length(canonical_trigger_digest) = 64),
  PRIMARY KEY (agent_id, schedule_series_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
) STRICT;

CREATE TABLE release_schedule_series (
  release_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  schedule_series_id TEXT NOT NULL,
  PRIMARY KEY (release_id, schedule_series_id),
  FOREIGN KEY (release_id) REFERENCES agent_releases(release_id),
  FOREIGN KEY (agent_id, schedule_series_id) REFERENCES schedule_series(agent_id, schedule_series_id)
) STRICT;

CREATE TABLE schedule_occurrences (
  agent_id TEXT NOT NULL,
  schedule_series_id TEXT NOT NULL,
  scheduled_for_utc_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, schedule_series_id, scheduled_for_utc_ms),
  FOREIGN KEY (agent_id, schedule_series_id) REFERENCES schedule_series(agent_id, schedule_series_id)
) STRICT;

CREATE TABLE recovery_sessions (
  recovery_session_id TEXT PRIMARY KEY,
  file_scope INTEGER NOT NULL DEFAULT 1 CHECK (file_scope = 1),
  database_identity TEXT NOT NULL,
  source_control_instance_id TEXT NOT NULL,
  backup_digest TEXT NOT NULL CHECK (length(backup_digest) = 64),
  agent_set_digest TEXT NOT NULL CHECK (length(agent_set_digest) = 64),
  proposed_target_control_instance_id TEXT NOT NULL UNIQUE,
  target_control_instance_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending-target', 'initialized', 'retired')),
  init_command_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (database_identity) REFERENCES storage_identity(database_identity),
  FOREIGN KEY (source_control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (proposed_target_control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (target_control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (init_command_id) REFERENCES commands(command_id),
  UNIQUE (recovery_session_id, proposed_target_control_instance_id),
  UNIQUE (recovery_session_id, target_control_instance_id),
  CHECK (
    (state = 'pending-target' AND target_control_instance_id IS NULL)
    OR (state = 'initialized' AND target_control_instance_id = proposed_target_control_instance_id)
    OR (state = 'retired' AND (target_control_instance_id IS NULL OR target_control_instance_id = proposed_target_control_instance_id))
  )
) STRICT;

CREATE UNIQUE INDEX recovery_sessions_one_open_file
ON recovery_sessions(file_scope) WHERE state != 'retired';

CREATE TABLE recovery_qualifications (
  recovery_session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  qualification_generation INTEGER NOT NULL CHECK (qualification_generation >= 0),
  target_control_instance_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('quarantined', 'fencing', 'enumerating', 'reconciling', 'ready', 'invalidating', 'aborted', 'qualified', 'invalidated')),
  reserved_epoch INTEGER,
  PRIMARY KEY (recovery_session_id, agent_id, qualification_generation),
  FOREIGN KEY (recovery_session_id, target_control_instance_id)
    REFERENCES recovery_sessions(recovery_session_id, target_control_instance_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (target_control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (agent_id, activation_id, release_id)
    REFERENCES activations(agent_id, activation_id, release_id)
) STRICT;

CREATE UNIQUE INDEX recovery_qualifications_one_open_agent
ON recovery_qualifications(recovery_session_id, agent_id)
WHERE state NOT IN ('aborted', 'qualified', 'invalidated');

CREATE TABLE recovery_agent_attempts (
  recovery_attempt_id TEXT PRIMARY KEY,
  recovery_session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  qualification_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'aborted-awaiting-local', 'aborted', 'bound', 'binding-invalidated-awaiting-local', 'consumed', 'invalidated')),
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  UNIQUE (recovery_session_id, agent_id, qualification_generation, recovery_attempt_id),
  UNIQUE (recovery_attempt_id, agent_id),
  FOREIGN KEY (recovery_session_id, agent_id, qualification_generation)
    REFERENCES recovery_qualifications(recovery_session_id, agent_id, qualification_generation)
) STRICT;

CREATE UNIQUE INDEX recovery_agent_attempts_one_unfinished
ON recovery_agent_attempts(recovery_session_id, agent_id, qualification_generation)
WHERE state NOT IN ('aborted', 'consumed', 'invalidated');

CREATE TABLE recovery_discovered_operations (
  recovery_operation_id TEXT PRIMARY KEY,
  database_identity TEXT NOT NULL,
  actual_control_instance_id TEXT NOT NULL,
  sink TEXT NOT NULL,
  discovery_key TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  member_digest TEXT NOT NULL CHECK (length(member_digest) = 64),
  external_outcome TEXT NOT NULL CHECK (external_outcome IN ('unknown', 'committed', 'not-committed', 'conflicted')),
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('pending', 'claimed', 'resolved-committed', 'resolved-not-committed', 'unresolved')),
  owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
  FOREIGN KEY (database_identity) REFERENCES storage_identity(database_identity),
  FOREIGN KEY (actual_control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  FOREIGN KEY (owner_agent_id) REFERENCES agents(agent_id),
  UNIQUE (database_identity, actual_control_instance_id, sink, discovery_key),
  UNIQUE (recovery_operation_id, owner_agent_id)
) STRICT;

CREATE TABLE recovery_operation_memberships (
  recovery_attempt_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  recovery_operation_id TEXT NOT NULL,
  registry_sequence INTEGER NOT NULL CHECK (registry_sequence >= 0),
  registry_proof_digest TEXT NOT NULL CHECK (length(registry_proof_digest) = 64),
  PRIMARY KEY (recovery_attempt_id, agent_id, recovery_operation_id),
  FOREIGN KEY (recovery_attempt_id, agent_id)
    REFERENCES recovery_agent_attempts(recovery_attempt_id, agent_id),
  FOREIGN KEY (recovery_operation_id, agent_id)
    REFERENCES recovery_discovered_operations(recovery_operation_id, owner_agent_id)
) STRICT;

CREATE TABLE recovery_artifacts (
  artifact_id TEXT PRIMARY KEY,
  recovery_attempt_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  authenticated_evidence_id TEXT NOT NULL,
  expected_context_digest TEXT NOT NULL CHECK (length(expected_context_digest) = 64),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  authority_scope_id TEXT NOT NULL,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  host_attestation_id TEXT NOT NULL,
  host_attestation_digest TEXT NOT NULL CHECK (length(host_attestation_digest) = 64),
  host_generation INTEGER NOT NULL CHECK (host_generation >= 0),
  time_evidence_id TEXT NOT NULL,
  time_evidence_digest TEXT NOT NULL CHECK (length(time_evidence_digest) = 64),
  time_generation INTEGER NOT NULL CHECK (time_generation >= 0),
  command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
  denominator_digest TEXT NOT NULL CHECK (length(denominator_digest) = 64),
  reserved_epoch INTEGER NOT NULL CHECK (reserved_epoch >= 0),
  expires_at_utc_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'bound', 'consumed', 'expired', 'stale', 'invalidated')),
  FOREIGN KEY (recovery_attempt_id) REFERENCES recovery_agent_attempts(recovery_attempt_id),
  FOREIGN KEY (authenticated_evidence_id) REFERENCES authenticated_evidence(evidence_id)
) STRICT;

CREATE TRIGGER recovery_artifact_evidence_profile_guard
BEFORE INSERT ON recovery_artifacts BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_evidence AS evidence
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'recovery-artifact'
     AND consumption.consumer_id = NEW.artifact_id
     AND consumption.consumption_generation = evidence.authority_generation
     AND consumption.fact_seq = evidence.fact_seq
    WHERE evidence.evidence_id = NEW.authenticated_evidence_id
      AND evidence.profile_id = 'recovery-artifact'
      AND json_extract(evidence.envelope_json, '$.claims.authorityId') = evidence.issuer_id
      AND json_extract(evidence.envelope_json, '$.claims.authorityVersion') = evidence.authority_version
      AND evidence.envelope_digest = NEW.evidence_digest
      AND evidence.expected_context_digest = NEW.expected_context_digest
      AND evidence.current_state_digest = NEW.current_state_digest
      AND json_extract(evidence.envelope_json, '$.claims.artifactId') = NEW.artifact_id
      AND json_extract(evidence.envelope_json, '$.claims.agentAttemptId') = NEW.recovery_attempt_id
      AND json_extract(evidence.envelope_json, '$.claims.reservedEpoch') = NEW.reserved_epoch
      AND json_extract(evidence.envelope_json, '$.claims.expiresAtUtcMs') = NEW.expires_at_utc_ms
      AND json_extract(evidence.envelope_json, '$.claims.commandDigest') = NEW.command_digest
      AND json_extract(evidence.envelope_json, '$.claims.dispatchDenominatorDigest') = NEW.denominator_digest
      AND json_extract(evidence.envelope_json, '$.claims.authorityGeneration') = NEW.authority_generation
  ) THEN RAISE(ABORT, 'recovery_artifact_evidence_profile_mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_authority_heads
    WHERE authority_scope_id = NEW.authority_scope_id
      AND authority_generation = NEW.authority_generation
      AND host_attestation_id = NEW.host_attestation_id
      AND host_attestation_digest = NEW.host_attestation_digest
      AND host_generation = NEW.host_generation
      AND time_evidence_id = NEW.time_evidence_id
      AND time_evidence_digest = NEW.time_evidence_digest
      AND time_generation = NEW.time_generation
  ) THEN RAISE(ABORT, 'recovery_artifact_current_state_mismatch') END;
END;

CREATE TRIGGER recovery_artifact_bind_current_state_guard
BEFORE UPDATE OF state ON recovery_artifacts
WHEN NEW.state = 'bound' BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_authority_heads
    WHERE authority_scope_id = NEW.authority_scope_id
      AND authority_generation = NEW.authority_generation
      AND host_attestation_id = NEW.host_attestation_id
      AND host_attestation_digest = NEW.host_attestation_digest
      AND host_generation = NEW.host_generation
      AND time_evidence_id = NEW.time_evidence_id
      AND time_evidence_digest = NEW.time_evidence_digest
      AND time_generation = NEW.time_generation
  ) THEN RAISE(ABORT, 'recovery_artifact_stale_current_state') END;
END;

CREATE TABLE binding_certificates (
  certificate_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL UNIQUE,
  recovery_attempt_id TEXT NOT NULL,
  target_control_instance_id TEXT NOT NULL,
  reserved_epoch INTEGER NOT NULL CHECK (reserved_epoch >= 0),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  binding_state TEXT NOT NULL CHECK (binding_state IN ('bound', 'binding-invalidated-awaiting-local', 'consumed', 'invalidated')),
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  FOREIGN KEY (artifact_id) REFERENCES recovery_artifacts(artifact_id),
  FOREIGN KEY (command_id) REFERENCES commands(command_id),
  FOREIGN KEY (recovery_attempt_id) REFERENCES recovery_agent_attempts(recovery_attempt_id),
  FOREIGN KEY (target_control_instance_id) REFERENCES control_instance_ids(control_instance_id)
) STRICT;

CREATE TRIGGER binding_certificate_context_guard
BEFORE INSERT ON binding_certificates BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_artifacts AS artifact
    JOIN commands AS command ON command.command_id = NEW.command_id
    JOIN recovery_agent_attempts AS attempt
      ON attempt.recovery_attempt_id = NEW.recovery_attempt_id
    JOIN recovery_sessions AS session
      ON session.recovery_session_id = attempt.recovery_session_id
    WHERE artifact.artifact_id = NEW.artifact_id
      AND artifact.recovery_attempt_id = NEW.recovery_attempt_id
      AND artifact.command_digest = command.payload_digest
      AND artifact.reserved_epoch = NEW.reserved_epoch
      AND artifact.evidence_digest = NEW.evidence_digest
      AND session.target_control_instance_id = NEW.target_control_instance_id
  ) THEN RAISE(ABORT, 'binding_certificate_context_mismatch') END;
END;

CREATE TABLE activation_permit_evidence (
  certificate_id TEXT NOT NULL,
  permit_generation INTEGER NOT NULL CHECK (permit_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('issued', 'superseded', 'expired', 'consumed', 'revoked')),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  authenticated_evidence_id TEXT NOT NULL,
  expected_context_digest TEXT NOT NULL CHECK (length(expected_context_digest) = 64),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  authority_scope_id TEXT NOT NULL,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  boot_id TEXT NOT NULL,
  startup_cycle_id TEXT NOT NULL,
  host_attestation_id TEXT NOT NULL,
  host_attestation_digest TEXT NOT NULL CHECK (length(host_attestation_digest) = 64),
  host_generation INTEGER NOT NULL CHECK (host_generation >= 0),
  time_evidence_id TEXT NOT NULL,
  time_evidence_digest TEXT NOT NULL CHECK (length(time_evidence_digest) = 64),
  time_generation INTEGER NOT NULL CHECK (time_generation >= 0),
  expires_at_utc_ms INTEGER NOT NULL,
  PRIMARY KEY (certificate_id, permit_generation),
  FOREIGN KEY (certificate_id) REFERENCES binding_certificates(certificate_id),
  FOREIGN KEY (authenticated_evidence_id) REFERENCES authenticated_evidence(evidence_id)
) STRICT;

CREATE TRIGGER activation_permit_evidence_profile_guard
BEFORE INSERT ON activation_permit_evidence BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_evidence AS evidence
    JOIN binding_certificates AS certificate
      ON certificate.certificate_id = NEW.certificate_id
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'activation-permit'
     AND consumption.consumer_id = NEW.certificate_id || '/' || NEW.permit_generation
     AND consumption.consumption_generation = NEW.permit_generation
     AND consumption.fact_seq = evidence.fact_seq
    WHERE evidence.evidence_id = NEW.authenticated_evidence_id
      AND evidence.profile_id = 'activation-permit'
      AND json_extract(evidence.envelope_json, '$.claims.authorityId') = evidence.issuer_id
      AND json_extract(evidence.envelope_json, '$.claims.authorityVersion') = evidence.authority_version
      AND evidence.envelope_digest = NEW.evidence_digest
      AND evidence.expected_context_digest = NEW.expected_context_digest
      AND evidence.current_state_digest = NEW.current_state_digest
      AND json_extract(evidence.envelope_json, '$.claims.certificateId') = NEW.certificate_id
      AND json_extract(evidence.envelope_json, '$.claims.commandId') = certificate.command_id
      AND json_extract(evidence.envelope_json, '$.claims.targetControlInstanceId') = certificate.target_control_instance_id
      AND json_extract(evidence.envelope_json, '$.claims.reservedEpoch') = certificate.reserved_epoch
      AND json_extract(evidence.envelope_json, '$.claims.artifactEvidenceDigest') = certificate.evidence_digest
      AND json_extract(evidence.envelope_json, '$.claims.permitGeneration') = NEW.permit_generation
      AND json_extract(evidence.envelope_json, '$.claims.authorityGeneration') = NEW.authority_generation
      AND json_extract(evidence.envelope_json, '$.claims.bootId') = NEW.boot_id
      AND json_extract(evidence.envelope_json, '$.claims.startupCycleId') = NEW.startup_cycle_id
      AND json_extract(evidence.envelope_json, '$.claims.hostAttestationId') = NEW.host_attestation_id
      AND json_extract(evidence.envelope_json, '$.claims.hostAttestationDigest') = NEW.host_attestation_digest
      AND json_extract(evidence.envelope_json, '$.claims.hostGeneration') = NEW.host_generation
      AND json_extract(evidence.envelope_json, '$.claims.timeEvidenceId') = NEW.time_evidence_id
      AND json_extract(evidence.envelope_json, '$.claims.timeEvidenceDigest') = NEW.time_evidence_digest
      AND json_extract(evidence.envelope_json, '$.claims.timeGeneration') = NEW.time_generation
      AND json_extract(evidence.envelope_json, '$.claims.expiresAtUtcMs') = NEW.expires_at_utc_ms
  ) THEN RAISE(ABORT, 'activation_permit_evidence_profile_mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_authority_heads
    WHERE authority_scope_id = NEW.authority_scope_id
      AND authority_generation = NEW.authority_generation
      AND boot_id = NEW.boot_id
      AND startup_cycle_id = NEW.startup_cycle_id
      AND host_attestation_id = NEW.host_attestation_id
      AND host_attestation_digest = NEW.host_attestation_digest
      AND host_generation = NEW.host_generation
      AND time_evidence_id = NEW.time_evidence_id
      AND time_evidence_digest = NEW.time_evidence_digest
      AND time_generation = NEW.time_generation
  ) THEN RAISE(ABORT, 'activation_permit_current_state_mismatch') END;
END;

CREATE TRIGGER activation_permit_consume_current_state_guard
BEFORE UPDATE OF status ON activation_permit_evidence
WHEN NEW.status = 'consumed' BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_authority_heads
    WHERE authority_scope_id = NEW.authority_scope_id
      AND authority_generation = NEW.authority_generation
      AND boot_id = NEW.boot_id
      AND startup_cycle_id = NEW.startup_cycle_id
      AND host_attestation_id = NEW.host_attestation_id
      AND host_attestation_digest = NEW.host_attestation_digest
      AND host_generation = NEW.host_generation
      AND time_evidence_id = NEW.time_evidence_id
      AND time_evidence_digest = NEW.time_evidence_digest
      AND time_generation = NEW.time_generation
  ) THEN RAISE(ABORT, 'activation_permit_stale_current_state') END;
END;

CREATE UNIQUE INDEX activation_permit_one_issued
ON activation_permit_evidence(certificate_id) WHERE status = 'issued';

CREATE TABLE recovery_conflict_heads (
  recovery_operation_id TEXT PRIMARY KEY,
  conflict_generation INTEGER NOT NULL CHECK (conflict_generation >= 0),
  registry_proof_digest TEXT NOT NULL CHECK (length(registry_proof_digest) = 64),
  authentication_evidence_digest TEXT NOT NULL CHECK (length(authentication_evidence_digest) = 64),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  UNIQUE (
    recovery_operation_id,
    conflict_generation,
    registry_proof_digest,
    authentication_evidence_digest
  )
) STRICT;

CREATE TRIGGER recovery_conflict_heads_monotonic
BEFORE UPDATE ON recovery_conflict_heads BEGIN
  SELECT CASE WHEN
    NEW.recovery_operation_id != OLD.recovery_operation_id OR
    NEW.conflict_generation <= OLD.conflict_generation OR
    NEW.fact_seq <= OLD.fact_seq
  THEN RAISE(ABORT, 'recovery_conflict_head_not_monotonic') END;
END;

CREATE TRIGGER recovery_conflict_heads_no_delete
BEFORE DELETE ON recovery_conflict_heads BEGIN
  SELECT RAISE(ABORT, 'recovery_conflict_head_immutable');
END;

CREATE TABLE binding_conflict_evidence (
  certificate_id TEXT NOT NULL,
  conflict_generation INTEGER NOT NULL CHECK (conflict_generation >= 0),
  conflict_kind TEXT NOT NULL CHECK (conflict_kind IN ('RecoveryPostFinalConflict', 'RecoveryAgentBindingConflict')),
  recovery_operation_id TEXT NOT NULL,
  registry_proof_digest TEXT NOT NULL CHECK (length(registry_proof_digest) = 64),
  authentication_evidence_digest TEXT NOT NULL CHECK (length(authentication_evidence_digest) = 64),
  authenticated_evidence_id TEXT NOT NULL UNIQUE,
  evidence_digest TEXT NOT NULL UNIQUE CHECK (length(evidence_digest) = 64),
  expected_context_digest TEXT NOT NULL CHECK (length(expected_context_digest) = 64),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  fact_seq INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (certificate_id, conflict_generation),
  FOREIGN KEY (certificate_id) REFERENCES binding_certificates(certificate_id),
  FOREIGN KEY (authenticated_evidence_id) REFERENCES authenticated_evidence(evidence_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq)
) STRICT;

CREATE TRIGGER binding_conflict_evidence_context_guard
BEFORE INSERT ON binding_conflict_evidence BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM authenticated_evidence AS evidence
    JOIN binding_certificates AS certificate
      ON certificate.certificate_id = NEW.certificate_id
    JOIN recovery_agent_attempts AS attempt
      ON attempt.recovery_attempt_id = certificate.recovery_attempt_id
    JOIN recovery_conflict_heads AS conflict
      ON conflict.recovery_operation_id = NEW.recovery_operation_id
     AND conflict.conflict_generation = NEW.conflict_generation
     AND conflict.registry_proof_digest = NEW.registry_proof_digest
     AND conflict.authentication_evidence_digest = NEW.authentication_evidence_digest
    JOIN authenticated_evidence_consumptions AS consumption
      ON consumption.evidence_id = evidence.evidence_id
     AND consumption.consumer_kind = 'bound-conflict'
     AND consumption.consumer_id = NEW.certificate_id || '/' || NEW.conflict_generation
     AND consumption.consumption_generation = NEW.conflict_generation
     AND consumption.fact_seq = evidence.fact_seq
    WHERE evidence.evidence_id = NEW.authenticated_evidence_id
      AND evidence.profile_id = 'bound-conflict'
      AND json_extract(evidence.envelope_json, '$.claims.authorityId') = evidence.issuer_id
      AND json_extract(evidence.envelope_json, '$.claims.authorityVersion') = evidence.authority_version
      AND evidence.envelope_digest = NEW.evidence_digest
      AND evidence.expected_context_digest = NEW.expected_context_digest
      AND evidence.current_state_digest = NEW.current_state_digest
      AND json_extract(evidence.envelope_json, '$.claims.kind') = NEW.conflict_kind
      AND json_extract(evidence.envelope_json, '$.claims.recoveryOperationId') = NEW.recovery_operation_id
      AND json_extract(evidence.envelope_json, '$.claims.recoverySessionId') = attempt.recovery_session_id
      AND json_extract(evidence.envelope_json, '$.claims.agentId') = attempt.agent_id
      AND json_extract(evidence.envelope_json, '$.claims.qualificationGeneration') = attempt.qualification_generation
      AND json_extract(evidence.envelope_json, '$.claims.targetControlInstanceId') = certificate.target_control_instance_id
      AND json_extract(evidence.envelope_json, '$.claims.certificateId') = certificate.certificate_id
      AND json_extract(evidence.envelope_json, '$.claims.commandId') = certificate.command_id
      AND json_extract(evidence.envelope_json, '$.claims.artifactEvidenceDigest') = certificate.evidence_digest
      AND json_extract(evidence.envelope_json, '$.claims.conflictGeneration') = NEW.conflict_generation
      AND json_extract(evidence.envelope_json, '$.claims.registryProofDigest') = NEW.registry_proof_digest
      AND json_extract(evidence.envelope_json, '$.claims.authenticationEvidenceDigest') = NEW.authentication_evidence_digest
  ) THEN RAISE(ABORT, 'binding_conflict_evidence_context_mismatch') END;
END;

CREATE TRIGGER binding_conflict_evidence_no_update
BEFORE UPDATE ON binding_conflict_evidence BEGIN
  SELECT RAISE(ABORT, 'binding_conflict_evidence_immutable');
END;

CREATE TRIGGER binding_conflict_evidence_no_delete
BEFORE DELETE ON binding_conflict_evidence BEGIN
  SELECT RAISE(ABORT, 'binding_conflict_evidence_immutable');
END;

CREATE TABLE mutation_authorities (
  authority_id TEXT NOT NULL,
  control_instance_id TEXT NOT NULL,
  authority_type TEXT NOT NULL CHECK (authority_type IN ('admission-owner', 'gateway-claim', 'connector-authority', 'direct-mutation-authority', 'runtime-grant', 'control-submission-grant', 'restricted-child-authority')),
  authority_version TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  registry_sequence INTEGER NOT NULL UNIQUE CHECK (registry_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'fenced')),
  PRIMARY KEY (authority_id, authority_version, generation),
  FOREIGN KEY (control_instance_id) REFERENCES control_instance_ids(control_instance_id),
  UNIQUE (control_instance_id, authority_id, authority_version, generation),
  UNIQUE (authority_id, authority_type, authority_version, generation)
) STRICT;

CREATE TRIGGER mutation_authority_identity_immutable
BEFORE UPDATE OF
  authority_id,
  control_instance_id,
  authority_type,
  authority_version,
  generation,
  registry_sequence
ON mutation_authorities BEGIN
  SELECT RAISE(ABORT, 'mutation_authority_identity_immutable');
END;

CREATE TABLE registration_closures (
  control_instance_id TEXT PRIMARY KEY,
  closure_sequence INTEGER NOT NULL CHECK (closure_sequence >= 0),
  closure_generation INTEGER NOT NULL CHECK (closure_generation >= 0),
  proof_digest TEXT NOT NULL CHECK (length(proof_digest) = 64),
  FOREIGN KEY (control_instance_id) REFERENCES control_instance_ids(control_instance_id)
) STRICT;

CREATE TABLE target_authority_closures (
  target_control_instance_id TEXT PRIMARY KEY,
  database_identity TEXT NOT NULL,
  proof_id TEXT NOT NULL UNIQUE,
  authority_id TEXT NOT NULL,
  authority_version TEXT NOT NULL,
  authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
  cas_identity TEXT NOT NULL,
  registration_closure_watermark INTEGER NOT NULL CHECK (registration_closure_watermark >= 0),
  continuation_closure_watermark INTEGER NOT NULL CHECK (continuation_closure_watermark >= 0),
  revoked_member_set_digest TEXT NOT NULL CHECK (length(revoked_member_set_digest) = 64),
  invalidated_attestation_digest TEXT NOT NULL CHECK (length(invalidated_attestation_digest) = 64),
  max_grant_expiry_utc_ms INTEGER NOT NULL,
  observed_at_utc_ms INTEGER NOT NULL CHECK (observed_at_utc_ms >= max_grant_expiry_utc_ms),
  time_evidence_digest TEXT NOT NULL CHECK (length(time_evidence_digest) = 64),
  dispatch_obligation_digest TEXT NOT NULL CHECK (length(dispatch_obligation_digest) = 64),
  discovery_obligation_digest TEXT NOT NULL CHECK (length(discovery_obligation_digest) = 64),
  obligation_digest TEXT NOT NULL CHECK (length(obligation_digest) = 64),
  expected_context_digest TEXT NOT NULL CHECK (length(expected_context_digest) = 64),
  current_state_digest TEXT NOT NULL CHECK (length(current_state_digest) = 64),
  proof_evidence_digest TEXT NOT NULL CHECK (length(proof_evidence_digest) = 64),
  issued_at_utc_ms INTEGER NOT NULL,
  target_retired INTEGER NOT NULL CHECK (target_retired = 1),
  fact_seq INTEGER NOT NULL UNIQUE,
  FOREIGN KEY (target_control_instance_id, database_identity)
    REFERENCES control_instance_ids(control_instance_id, database_identity),
  FOREIGN KEY (proof_id) REFERENCES authenticated_evidence(evidence_id),
  FOREIGN KEY (fact_seq) REFERENCES source_facts(fact_seq),
  CHECK (cas_identity = database_identity || ':' || target_control_instance_id)
) STRICT;

CREATE TRIGGER target_authority_closure_evidence_profile_guard
BEFORE INSERT ON target_authority_closures BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authenticated_evidence
    WHERE evidence_id = NEW.proof_id
      AND profile_id = 'target-authority-closed'
      AND issuer_id = NEW.authority_id
      AND authority_version = NEW.authority_version
      AND json_extract(envelope_json, '$.claims.authorityId') = NEW.authority_id
      AND json_extract(envelope_json, '$.claims.authorityVersion') = NEW.authority_version
      AND envelope_digest = NEW.proof_evidence_digest
      AND expected_context_digest = NEW.expected_context_digest
      AND current_state_digest = NEW.current_state_digest
      AND authority_generation = NEW.authority_generation
      AND json_extract(envelope_json, '$.claims.databaseIdentity') = NEW.database_identity
      AND json_extract(envelope_json, '$.claims.targetControlInstanceId') = NEW.target_control_instance_id
      AND json_extract(envelope_json, '$.claims.casIdentity') = NEW.cas_identity
      AND json_extract(envelope_json, '$.claims.registrationClosureWatermark') = NEW.registration_closure_watermark
      AND json_extract(envelope_json, '$.claims.continuationClosureWatermark') = NEW.continuation_closure_watermark
      AND json_extract(envelope_json, '$.claims.revokedMemberSetDigest') = NEW.revoked_member_set_digest
      AND json_extract(envelope_json, '$.claims.invalidatedAttestationDigest') = NEW.invalidated_attestation_digest
      AND json_extract(envelope_json, '$.claims.maxGrantExpiryUtcMs') = NEW.max_grant_expiry_utc_ms
      AND json_extract(envelope_json, '$.claims.observedAtUtcMs') = NEW.observed_at_utc_ms
      AND json_extract(envelope_json, '$.claims.timeEvidenceDigest') = NEW.time_evidence_digest
      AND json_extract(envelope_json, '$.claims.dispatchObligationDigest') = NEW.dispatch_obligation_digest
      AND json_extract(envelope_json, '$.claims.discoveryObligationDigest') = NEW.discovery_obligation_digest
      AND json_extract(envelope_json, '$.claims.obligationDigest') = NEW.obligation_digest
      AND json_extract(envelope_json, '$.claims.targetRetired') = NEW.target_retired
      AND json_extract(envelope_json, '$.claims.issuedAtUtcMs') = NEW.issued_at_utc_ms
  ) THEN RAISE(ABORT, 'target_closure_evidence_context_mismatch') END;
END;

CREATE TRIGGER target_authority_closures_no_update
BEFORE UPDATE ON target_authority_closures BEGIN
  SELECT RAISE(ABORT, 'target_authority_closure_immutable');
END;

CREATE TRIGGER target_authority_closures_no_delete
BEFORE DELETE ON target_authority_closures BEGIN
  SELECT RAISE(ABORT, 'target_authority_closure_immutable');
END;

CREATE TABLE run_projection (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  latest_run_seq INTEGER NOT NULL CHECK (latest_run_seq >= 0),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
) STRICT;

CREATE TABLE action_projection (
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  parent_action_id TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY (run_id, action_id),
  FOREIGN KEY (run_id, action_id) REFERENCES actions(run_id, action_id)
) STRICT;
