import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

import {
  actorSubjectId,
  canonicalDigest,
  commandIdentityDigest,
  parseStrictJson,
  validateSafeIntegerFields,
} from "../../scripts/validate-m0.mjs";

const commandsUrl = new URL(
  "../../contracts/v2/control/commands.json",
  import.meta.url,
);
const authorityUrl = new URL(
  "../../contracts/v2/control/authority-policy.json",
  import.meta.url,
);

function register(
  store,
  command,
  payloadSource,
  preconditionSource,
  safeIntegerFields = new Set(),
) {
  const payload = parseStrictJson(payloadSource);
  const precondition = parseStrictJson(preconditionSource);
  validateSafeIntegerFields(payload, safeIntegerFields);
  validateSafeIntegerFields(precondition, safeIntegerFields);
  const identity = commandIdentityDigest(command);
  const payloadDigest = canonicalDigest(payload);
  const preconditionDigest = canonicalDigest(precondition);
  const previous = store.get(identity);
  if (previous) {
    if (
      previous.payloadDigest !== payloadDigest ||
      previous.preconditionDigest !== preconditionDigest
    ) {
      return { kind: "idempotency_conflict" };
    }
    return previous.result;
  }
  const result = { kind: "stored", resultId: `result-${store.size + 1}` };
  store.set(identity, { payloadDigest, preconditionDigest, result });
  return result;
}

test.scenarios(
  [
    "v2c.command-idempotency.case-0884a95354e80e88",
    "v2c.command-idempotency.case-44d0defb2c3ee6e8",
    "v2c.command-idempotency.case-8faa0ad96119dcd3",
    "v2s.command-results.case-4a248d5e73b2514f"
  ],
  "command identity and replay are stable across credential refresh", async () => {
  const authority = JSON.parse(await readFile(authorityUrl, "utf8"));
  const actor = actorSubjectId(authority.sampleAuthorityContext);
  const command = {
    actorSubjectId: actor,
    commandKind: "admit-run",
    targetAggregateId: "run-preallocated-1",
    idempotencyKey: "key-1",
  };
  const refreshed = {
    ...authority.sampleAuthorityContext,
    issuerVersion: "issuer-v4",
    authenticatedMethod: "rotated-key",
    revocationVersion: "rev-8",
  };
  assert.equal(actorSubjectId(refreshed), actor);

  const store = new Map();
  const first = register(
    store,
    command,
    '{"input":"ref-1","limit":0}',
    '{"epoch":1}',
    new Set(["limit", "epoch"]),
  );
  const replay = register(
    store,
    command,
    '{"limit":-0,"input":"ref-1"}',
    '{"epoch":1.0}',
    new Set(["limit", "epoch"]),
  );
  assert.deepEqual(replay, first);
  assert.equal(store.size, 1);
  assert.equal(
    register(store, command, '{"input":"ref-2","limit":0}', '{"epoch":1}').kind,
    "idempotency_conflict",
  );
});

test.scenarios(
  [
    "v2c.command-idempotency.case-06f0de1c613562f0",
    "v2c.command-idempotency.case-c040b2b65fbdf156"
  ],
  "all command kinds have pre-mutation targets and only recovery commands coordinate", async () => {
  const manifest = JSON.parse(await readFile(commandsUrl, "utf8"));
  assert.ok(
    manifest.commands.every(({ targetDerivation }) => targetDerivation),
  );
  const coordination = manifest.commands.filter(
    ({ mode }) => mode === "coordination",
  );
  assert.deepEqual(
    coordination.map(({ kind }) => kind),
    ["restore-init", "abort-recovery", "recover-activate"],
  );
  assert.ok(
    coordination.every(
      ({ coordinationOwner }) => coordinationOwner === "recovery-authority",
    ),
  );
  assert.equal(manifest.coordinationRules.normalCommandMayBePending, false);
  assert.equal(manifest.coordinationRules.sideCommandIds, false);
  assert.equal(manifest.replayRules.mutationReexecution, false);
});

test.scenarios(
  [
    "v2c.command-idempotency.case-7e2850f96e70f7f2"
  ],
  "strict command parsing rejects duplicate keys and unsafe integers before registration", () => {
  assert.throws(
    () => parseStrictJson('{"epoch":1,"epoch":2}'),
    (error) => error?.code === "duplicate_key",
  );
  assert.throws(
    () =>
      validateSafeIntegerFields(
        { epoch: Number.MAX_SAFE_INTEGER + 1 },
        new Set(["epoch"]),
      ),
    (error) => error?.code === "unsafe_integer",
  );
});
