export function machineCell(manifest, machineId, state, event) {
  const machine = manifest.machines.find(({ id }) => id === machineId);
  const cells = machine.table.filter(
    (entry) => entry.state === state && entry.event === event,
  );
  if (cells.length !== 1) throw new Error("state_cell_missing_or_duplicate");
  return cells[0].outcome;
}

export function registerAction(store, action) {
  const key = `${action.runId}\0${action.actionId}`;
  const previous = store.get(key);
  const binding = JSON.stringify({
    originRunAttempt: action.originRunAttempt,
    actionKind: action.actionKind,
    parentActionId: action.parentActionId ?? null,
    inputArtifactDigest: action.inputArtifactDigest,
    commandIdentity: action.commandIdentity,
  });
  if (previous) {
    if (previous.binding !== binding)
      throw Object.assign(new Error("idempotency_conflict"), {
        code: "idempotency_conflict",
      });
    return previous.action;
  }
  if (action.parentActionId) {
    const parent = store.get(`${action.runId}\0${action.parentActionId}`);
    if (!parent)
      throw Object.assign(new Error("invalid_parent"), {
        code: "invalid_parent",
      });
  }
  const stored = { ...action, ordinal: store.size + 1 };
  store.set(key, { binding, action: stored });
  return stored;
}

export function obligationKey(obligation, fields) {
  return JSON.stringify(fields.map((field) => obligation[field]));
}

export function validateCheckpoint(
  checkpoint,
  harness,
  actionStore,
  currentOwners,
) {
  const allowedFields = new Set(harness.checkpoint.requiredFields);
  if (Object.keys(checkpoint).some((field) => !allowedFields.has(field))) {
    throw Object.assign(new Error("unknown_checkpoint_field"), {
      code: "unknown_checkpoint_field",
    });
  }
  if (
    !harness.checkpoint.allowedBoundaryKinds.includes(checkpoint.boundaryKind)
  ) {
    throw Object.assign(new Error("invalid_checkpoint_boundary"), {
      code: "invalid_checkpoint_boundary",
    });
  }
  const producer = actionStore.get(
    `${checkpoint.runId}\0${checkpoint.producerActionId}`,
  )?.action;
  if (!producer || producer.originRunAttempt !== checkpoint.producerAttempt) {
    throw Object.assign(new Error("invalid_checkpoint_producer"), {
      code: "invalid_checkpoint_producer",
    });
  }
  const orderKeys = [];
  const collisionKeys = new Set();
  for (const obligation of checkpoint.outstandingObligations) {
    const schema = harness.obligations.kinds.find(
      ({ kind }) => kind === obligation.kind,
    );
    if (
      !schema ||
      JSON.stringify(Object.keys(obligation).sort()) !==
        JSON.stringify([...schema.requiredFields].sort())
    ) {
      throw Object.assign(new Error("invalid_obligation"), {
        code: "invalid_obligation",
      });
    }
    if (
      !Number.isSafeInteger(obligation.subjectGeneration) ||
      !Number.isSafeInteger(obligation.ownerGeneration) ||
      !harness.obligations.ownerKinds.includes(obligation.ownerKind)
    ) {
      throw Object.assign(new Error("invalid_obligation_owner"), {
        code: "invalid_obligation_owner",
      });
    }
    const collision = obligationKey(
      obligation,
      harness.obligations.collisionKey,
    );
    if (collisionKeys.has(collision))
      throw Object.assign(new Error("obligation_collision"), {
        code: "obligation_collision",
      });
    collisionKeys.add(collision);
    const owner = currentOwners.get(collision);
    if (
      !owner ||
      owner.kind !== obligation.ownerKind ||
      owner.generation !== obligation.ownerGeneration
    ) {
      throw Object.assign(new Error("stale_obligation_owner"), {
        code: "stale_obligation_owner",
      });
    }
    orderKeys.push(
      obligationKey(obligation, harness.obligations.canonicalOrder),
    );
  }
  if (JSON.stringify(orderKeys) !== JSON.stringify([...orderKeys].sort())) {
    throw Object.assign(new Error("obligations_not_canonical"), {
      code: "obligations_not_canonical",
    });
  }
  return true;
}

export function resolveOwnerChain(reference, transfers) {
  let current = {
    kind: reference.ownerKind,
    generation: reference.ownerGeneration,
  };
  const seen = new Set([`${current.kind}\0${current.generation}`]);
  for (;;) {
    const successors = transfers.filter(
      (transfer) =>
        transfer.kind === reference.kind &&
        transfer.subjectId === reference.subjectId &&
        transfer.subjectGeneration === reference.subjectGeneration &&
        transfer.fromOwnerKind === current.kind &&
        transfer.fromOwnerGeneration === current.generation,
    );
    if (successors.length > 1)
      throw Object.assign(new Error("owner_chain_branch"), {
        code: "owner_chain_branch",
      });
    if (successors.length === 0) return current;
    const successor = successors[0];
    const key = `${successor.toOwnerKind}\0${successor.toOwnerGeneration}`;
    if (seen.has(key))
      throw Object.assign(new Error("owner_chain_cycle"), {
        code: "owner_chain_cycle",
      });
    if (
      !Number.isSafeInteger(successor.toOwnerGeneration) ||
      successor.toOwnerGeneration !== current.generation + 1
    ) {
      throw Object.assign(new Error("owner_chain_gap"), {
        code: "owner_chain_gap",
      });
    }
    seen.add(key);
    current = {
      kind: successor.toOwnerKind,
      generation: successor.toOwnerGeneration,
    };
  }
}

export function allocationMatches(quiescence, current) {
  return (
    quiescence.priorAttemptTerminal === current.priorAttemptTerminal &&
    quiescence.currentAttemptNumber === current.currentAttemptNumber &&
    quiescence.containmentGeneration === current.containmentGeneration &&
    quiescence.grantRevocationGeneration ===
      current.grantRevocationGeneration &&
    quiescence.obligationSetDigest === current.obligationSetDigest &&
    quiescence.checkpointOwnerChainHead === current.checkpointOwnerChainHead &&
    current.containmentSealed === true
  );
}
