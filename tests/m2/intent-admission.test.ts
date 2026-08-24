import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileRelease,
  digestJson,
  type AgentSpec,
  type AuthorityContext,
  type ExecutionClosure,
  type IntentAdmissionInput,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  actorSubjectId,
  commandMeta,
  intentRunId,
} from "../../packages/control-core/index.ts";
import {
  RecoveryAuthority,
  openSqliteControl,
} from "../../packages/control-store-sqlite/index.ts";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const schemaDigest = "a".repeat(64);
const spec: AgentSpec = {
  agentId: "agent-intent",
  goal: "emit a deterministic artifact",
  harnessKind: "fake",
  checkpointSchema: "checkpoint-v1",
  capabilities: [],
  effectOperations: [],
  intentDescriptors: [
    {
      intentId: "emit",
      descriptorVersion: 1,
      inputSchema: {
        id: "control-metadata",
        version: "1",
        digest: schemaDigest,
      },
      scope: "run-start",
      policyId: "shadow-only",
      resultSchema: {
        id: "artifact-result",
        version: "1",
        digest: "b".repeat(64),
      },
    },
  ],
};
const closure: ExecutionClosure = {
  entryId: "intent-fixture",
  executable: process.execPath,
  executableDigest: "c".repeat(64),
  members: [{ id: "virtual-resource", digest: "d".repeat(64) }],
};
const authority: AuthorityContext = {
  issuerNamespaceId: "issuer-test",
  principalId: "principal-test",
  representedSubjectId: "subject-test",
  audience: "hangar-control",
  issuerVersion: "policy-v1",
  authenticatedMethod: "test-key",
  delegationChainDigest: "e".repeat(64),
  effectiveScope: ["run-start", "run:read", "approval:read"],
  effectiveOperation: "admit-intent",
  issuedAtUtcMs: 1,
  expiresAtUtcMs: 10_000,
  revocationVersion: "rev-1",
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-intent-"));
  const authorityPath = join(directory, "authority.sqlite");
  const owner = new RecoveryAuthority(authorityPath);
  const fence = value(owner.initialize("database-intent", "target-intent"));
  let crashAfter = false;
  let productionEligible = false;
  const runtime = openSqliteControl(
    join(directory, "control.sqlite"),
    {
      authorityPath,
      fence,
      afterCommitBeforeAck: () => {
        if (crashAfter) {
          crashAfter = false;
          throw new Error("simulated ACK loss");
        }
      },
    },
    { productionEligible: () => productionEligible },
  );
  const release = compileRelease(spec, closure);
  value(
    runtime.control.publish(
      commandMeta(
        "owner",
        "publish-release",
        release.releaseId,
        "publish",
        release,
      ),
      release,
    ),
  );
  value(
    runtime.control.activateMode(
      commandMeta(
        "owner",
        "activate-mode",
        spec.agentId,
        "activate-shadow",
        {
          agentId: spec.agentId,
          releaseId: release.releaseId,
          epoch: 1,
          activationMode: "shadow",
        },
        { expectedCurrentEpoch: null },
      ),
      {
        agentId: spec.agentId,
        releaseId: release.releaseId,
        epoch: 1,
        activationMode: "shadow",
      },
    ),
  );
  const request = (
    key: string,
    overrides: Partial<IntentAdmissionInput> = {},
    context: AuthorityContext = authority,
  ) => {
    const input: IntentAdmissionInput = {
      agentId: spec.agentId,
      intentId: "emit",
      descriptorVersion: 1,
      executionMode: "shadow-evaluator",
      input: { trigger: "manual" },
      ...overrides,
    };
    const actor = actorSubjectId(context);
    const runId = intentRunId(actor, input.agentId, input.intentId, key);
    const meta = commandMeta(
      actor,
      "admit-intent",
      runId,
      key,
      input,
      {
        releaseId: release.releaseId,
        activationEpoch: 1,
        inputSchemaDigest: schemaDigest,
      },
      digestJson(context),
    );
    return { input, meta, runId, context };
  };
  return {
    runtime,
    owner,
    release,
    request,
    setCrashAfter: () => {
      crashAfter = true;
    },
    setProductionEligible: (value: boolean) => {
      productionEligible = value;
    },
    close: async () => {
      runtime.close();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("shadow-evaluator admission binds release intent/input/prompt atomically", async () => {
  const f = await setup();
  try {
    const command = f.request("shadow-happy");
    const result = value(
      f.runtime.control.admitIntent(
        command.context,
        command.meta,
        command.input,
      ),
    );
    assert.equal(result.runId, command.runId);
    assert.equal(result.releaseId, f.release.releaseId);
    assert.equal(result.executionMode, "shadow-evaluator");
    assert.equal(result.inputDigest, digestJson({ trigger: "manual" }));
    assert.match(result.promptDigest, /^[0-9a-f]{64}$/);
    const run = value(f.runtime.control.readRun(authority, result.runId));
    assert.equal(run.value.run.executionMode, "shadow-evaluator");

    const facts = value(f.runtime.control.sourceFacts()).filter(
      ({ aggregateId }) => aggregateId === result.runId,
    );
    assert.deepEqual(
      facts.map(({ factKind }) => factKind),
      ["run-admitted", "attempt-prompt-bound"],
    );
    const serialized = JSON.stringify(facts);
    assert.ok(serialized.includes('"controlMetadata":{"trigger":"manual"}'));
    assert.ok(serialized.includes(result.promptDigest));
  } finally {
    await f.close();
  }
});

test("unknown/stale intent, body, scope and unqualified production fail with zero Run facts", async () => {
  const f = await setup();
  try {
    const beforeRuns = value(f.runtime.control.sourceFacts()).filter(
      ({ factKind }) => factKind === "run-admitted",
    ).length;
    const cases = [
      f.request("unknown", { intentId: "missing" }),
      f.request("stale-version", { descriptorVersion: 2 }),
      f.request("production-on-shadow", { executionMode: "production" }),
      f.request(
        "scope-denied",
        {},
        { ...authority, effectiveScope: ["run:read", "approval:read"] },
      ),
    ];
    for (const command of cases)
      assert.equal(
        f.runtime.control.admitIntent(
          command.context,
          command.meta,
          command.input,
        ).ok,
        false,
      );

    const body = f.request("body");
    const bodyInput = {
      ...body.input,
      input: { trigger: "manual", promptBody: "forbidden" },
    } as never;
    const bodyMeta = commandMeta(
      body.meta.actorSubjectId,
      "admit-intent",
      body.runId,
      "body",
      bodyInput,
      body.meta.precondition,
      body.meta.authorityContextDigest,
    );
    assert.deepEqual(
      f.runtime.control.admitIntent(authority, bodyMeta, bodyInput),
      { ok: false, error: "invalid_input" },
    );
    // Production activation exists, but host-attestation owner still denies it.
    value(
      f.runtime.control.activateMode(
        commandMeta(
          "owner",
          "activate-mode",
          spec.agentId,
          "activate-production",
          {
            agentId: spec.agentId,
            releaseId: f.release.releaseId,
            epoch: 2,
            activationMode: "active",
          },
          { expectedCurrentEpoch: 1 },
        ),
        {
          agentId: spec.agentId,
          releaseId: f.release.releaseId,
          epoch: 2,
          activationMode: "active",
        },
      ),
    );
    const productionInput: IntentAdmissionInput = {
      agentId: spec.agentId,
      intentId: "emit",
      descriptorVersion: 1,
      executionMode: "production",
      input: { trigger: "production" },
    };
    const actor = actorSubjectId(authority);
    const productionRun = intentRunId(
      actor,
      spec.agentId,
      "emit",
      "production-host-denied",
    );
    const productionMeta = commandMeta(
      actor,
      "admit-intent",
      productionRun,
      "production-host-denied",
      productionInput,
      {
        releaseId: f.release.releaseId,
        activationEpoch: 2,
        inputSchemaDigest: schemaDigest,
      },
      digestJson(authority),
    );
    assert.deepEqual(
      f.runtime.control.admitIntent(authority, productionMeta, productionInput),
      { ok: false, error: "forbidden" },
    );

    // A shadow release carrying any mutation-capable grant is rejected.
    const mutationRelease = compileRelease(
      { ...spec, effectOperations: ["external.send"] },
      closure,
    );
    value(
      f.runtime.control.publish(
        commandMeta(
          "owner",
          "publish-release",
          mutationRelease.releaseId,
          "publish-mutation",
          mutationRelease,
        ),
        mutationRelease,
      ),
    );
    value(
      f.runtime.control.activateMode(
        commandMeta(
          "owner",
          "activate-mode",
          spec.agentId,
          "activate-mutation-shadow",
          {
            agentId: spec.agentId,
            releaseId: mutationRelease.releaseId,
            epoch: 3,
            activationMode: "shadow",
          },
          { expectedCurrentEpoch: 2 },
        ),
        {
          agentId: spec.agentId,
          releaseId: mutationRelease.releaseId,
          epoch: 3,
          activationMode: "shadow",
        },
      ),
    );
    const mutationInput = {
      ...productionInput,
      executionMode: "shadow-evaluator" as const,
      input: { trigger: "mutation-shadow" },
    };
    const mutationRun = intentRunId(
      actor,
      spec.agentId,
      "emit",
      "mutation-shadow",
    );
    const mutationMeta = commandMeta(
      actor,
      "admit-intent",
      mutationRun,
      "mutation-shadow",
      mutationInput,
      {
        releaseId: mutationRelease.releaseId,
        activationEpoch: 3,
        inputSchemaDigest: schemaDigest,
      },
      digestJson(authority),
    );
    assert.deepEqual(
      f.runtime.control.admitIntent(authority, mutationMeta, mutationInput),
      { ok: false, error: "forbidden" },
    );

    const afterRuns = value(f.runtime.control.sourceFacts()).filter(
      ({ factKind }) => factKind === "run-admitted",
    ).length;
    assert.equal(afterRuns, beforeRuns);
  } finally {
    await f.close();
  }
});

test("intent admission ACK loss replays same Run; changed payload conflicts", async () => {
  const f = await setup();
  try {
    const command = f.request("ack-loss");
    f.setCrashAfter();
    assert.deepEqual(
      f.runtime.control.admitIntent(
        command.context,
        command.meta,
        command.input,
      ),
      { ok: false, error: "invalid_state" },
    );
    const replay = value(
      f.runtime.control.admitIntent(
        command.context,
        command.meta,
        command.input,
      ),
    );
    assert.equal(replay.runId, command.runId);
    const changedInput = { ...command.input, input: { trigger: "changed" } };
    const changedMeta = commandMeta(
      command.meta.actorSubjectId,
      "admit-intent",
      command.runId,
      "ack-loss",
      changedInput,
      command.meta.precondition,
      command.meta.authorityContextDigest,
    );
    assert.deepEqual(
      f.runtime.control.admitIntent(authority, changedMeta, changedInput),
      { ok: false, error: "idempotency_conflict" },
    );
    assert.equal(
      value(f.runtime.control.sourceFacts()).filter(
        ({ factKind }) => factKind === "run-admitted",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});
