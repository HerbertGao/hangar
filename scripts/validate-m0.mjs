#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exitCode = {
  pass: 0,
  contract_failure: 1,
  evidence_failure: 1,
  prerequisite_missing: 2,
  missing_source: 2,
  invalid_invocation: 2,
};
const validatedBundleResults = new WeakMap();
const canonicalKindPrecedence = Object.freeze([
  "invalid_invocation",
  "prerequisite_missing",
  "missing_source",
  "contract_failure",
  "evidence_failure",
  "pass",
]);

function parseVersion(value) {
  const parts = value.split(".").map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger) ? parts : null;
}

function extractVersion(output, prefix) {
  if (typeof prefix !== "string" || !output.startsWith(prefix)) return null;
  const version = output.slice(prefix.length).split(/\s/, 1)[0];
  return parseVersion(version) ? version : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function supports(version, range) {
  const actual = parseVersion(version);
  if (!actual) return false;
  if (range.exact)
    return compareVersion(actual, parseVersion(range.exact)) === 0;
  if (
    range.minInclusive &&
    compareVersion(actual, parseVersion(range.minInclusive)) < 0
  )
    return false;
  return (
    !range.maxExclusive ||
    compareVersion(actual, parseVersion(range.maxExclusive)) < 0
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function hasExactFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalize(Object.keys(value).sort()) === canonicalize([...fields].sort())
  );
}

const RETIRED_M0_AUTHORITY_PATHS = Object.freeze([
  "oracles/m0/fixture-plan.json",
  "tests/m0/fixture-runner.mjs",
  "tests/m0/fixture-runner.test.mjs",
  "tests/m0/scenario-gates.mjs",
  "tests/m0/scenario-gates-m0o.mjs",
  "tests/m0/scenario-gates-v2c-declaration.mjs",
  "tests/m0/scenario-gates-v2c-lifecycle.mjs",
  "tests/m0/scenario-gates-v2s-recovery.mjs",
  "tests/m0/scenario-gates-v2s-storage.mjs",
  "tests/m0/scenario-gates.test.mjs",
  "tests/m0/scenario-gates-adversarial.test.mjs",
]);
const REQUIRED_V2_SOT_PATHS = Object.freeze([
  "CLAUDE.md",
  "DESIGN.md",
  "ROADMAP.md",
]);
const PREREQUISITE_COMMANDS = Object.freeze([
  {
    id: "node",
    access: "PATH",
    command: "node",
    versionArgs: ["--version"],
    versionPrefix: "v",
  },
  {
    id: "sqlite3",
    access: "PATH",
    command: "sqlite3",
    versionArgs: ["--version"],
    versionPrefix: "",
  },
  {
    id: "git",
    access: "PATH",
    command: "git",
    versionArgs: ["--version"],
    versionPrefix: "git version ",
  },
]);
const EXPECTED_EVALUATOR_REGISTRY_DIGEST =
  "f71d1ac37d5aad2882ce0484857dddefec07723c4bee2515fa74a448e0c65b2e";
const EXPECTED_APPLICABILITY_DIGEST =
  "15d6c490ffbd413fc9903de987bb2250e562e96fadd167b7986a63376fa2d41d";
const EXPECTED_SCENARIO_COVERAGE_DIGEST =
  "037fdb9200f1bba8ab8714dfa887fb48a5e21690220976afea3deb42f596d09d";
const EXPECTED_MEASUREMENT_MANIFEST_DIGEST =
  "aad3e678e917f270f0625f25349ca8930efdc9ec648721a4a604ab8bdc89d78a";
const RECOVERY_RACE_POINTS = Object.freeze([
  "session-recorded",
  "session-init-cas",
  "session-abort-cas",
  "session-local-init",
  "session-local-retire",
  "agent-abort-cas",
  "agent-local-abort",
  "prebind-finalization",
  "binding-cas",
  "recovery-conflict-fact",
  "binding-invalidation-cas",
  "binding-invalidation-local",
  "activation-success-cas",
  "session-init-local-ack",
  "session-retire-local-ack",
  "agent-abort-local-ack",
  "activation-success-local-ack",
  "binding-invalidation-local-ack",
  "agent-binding-conflict-target-ack",
  "target-authority-close-cas",
  "target-authority-closed-proof",
  "agent-binding-conflict",
]);
const RECOVERY_RACE_DISPOSITIONS = Object.freeze([
  "crash-before",
  "crash-after",
  "response-loss",
  "competing-command",
]);
const DIMENSION_OWNERS = Object.freeze({
  controlCommand: "v2c.control-taxonomy",
  runEvent: "v2c.control-taxonomy",
  harnessEvent: "v2c.control-taxonomy",
  actionEvent: "v2c.control-taxonomy",
  sourceFact: "v2s.source-facts",
  activationState: "v2c.activation",
  runState: "v2c.run",
  runAttemptState: "v2c.run-attempt",
  approvalState: "v2c.approval",
  effectState: "v2c.effect",
  reconciliationState: "v2c.effect",
  recoverySessionState: "v2s.restore",
  recoveryQualificationState: "v2s.restore",
  recoveryAgentAttemptState: "v2s.restore",
  recoveryOperationState: "v2s.source-facts",
  bindingCertificateState: "v2s.restore",
  activationPermitState: "v2s.restore",
  mutationAuthorityType: "v2s.restore",
  hostStatus: "v2c.host-attestation",
  hostMode: "v2c.host-attestation",
  projectionFamily: "v2c.control-boundary",
});
const COVERAGE_POLICY = Object.freeze({
  "evaluator-self-test": {
    inputFixtureId: "evaluator-self-test-v1",
    observationSchemaId: "evaluator-result-observation-v1",
    applicabilityPredicateId: "evaluator-required-v1",
    qualificationProfiles: ["m0-evaluator"],
    exclusionCodes: [],
  },
  "neutral-control-storage": {
    inputFixtureId: "neutral-control-storage-v1",
    observationSchemaId: "public-control-storage-observation-v1",
    applicabilityPredicateId: "always-required-v1",
    qualificationProfiles: ["all"],
    exclusionCodes: [],
  },
  "named-tenant": {
    inputFixtureId: "inbox-tenant-fixture-v1",
    observationSchemaId: "tenant-public-observation-v1",
    applicabilityPredicateId: "selected-tenant-v1",
    qualificationProfiles: ["inbox"],
    exclusionCodes: ["tenant-not-selected"],
  },
  "named-process-host": {
    inputFixtureId: "process-host-fixture-v1",
    observationSchemaId: "process-host-observation-v1",
    applicabilityPredicateId: "selected-process-host-v1",
    qualificationProfiles: ["process-host"],
    exclusionCodes: ["host-not-selected"],
  },
});

function runGit(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: null,
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalizeRemote(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
}

function selectMembers(paths, selector) {
  return paths.filter((path) => {
    const selected =
      (selector.files ?? []).includes(path) ||
      (selector.prefixes ?? []).some((prefix) => path.startsWith(prefix));
    if (!selected) return false;
    if (
      selector.suffixes &&
      !selector.suffixes.some((suffix) => path.endsWith(suffix))
    )
      return false;
    return !(selector.excludeSuffixes ?? []).some((suffix) =>
      path.endsWith(suffix),
    );
  });
}

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        invalid("lone_surrogate");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid("lone_surrogate");
    }
  }
}

export function parseStrictJson(input) {
  let text;
  try {
    text = Buffer.isBuffer(input)
      ? new TextDecoder("utf-8", { fatal: true }).decode(input)
      : String(input);
  } catch {
    invalid("malformed_utf8");
  }
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && " \t\r\n".includes(text[offset]))
      offset += 1;
  };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code < 0x20) invalid("invalid_json");
      if (text[offset] === "\\") {
        offset += 1;
        if (!'"\\/bfnrtu'.includes(text[offset])) invalid("invalid_json");
        if (text[offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5)))
            invalid("invalid_json");
          offset += 4;
        }
      } else if (text[offset] === '"') {
        offset += 1;
        let value;
        try {
          value = JSON.parse(text.slice(start, offset));
        } catch {
          invalid("invalid_json");
        }
        assertUnicodeScalars(value);
        return value;
      }
      offset += 1;
    }
    invalid("invalid_json");
  };
  const value = (depth = 0) => {
    if (depth > 100) invalid("json_depth_exceeded");
    whitespace();
    const token = text[offset];
    if (token === '"') return string();
    if (token === "{") {
      offset += 1;
      whitespace();
      const output = {};
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return output;
      }
      while (offset < text.length) {
        if (text[offset] !== '"') invalid("invalid_json");
        const key = string();
        if (keys.has(key)) invalid("duplicate_key");
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") invalid("invalid_json");
        output[key] = value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return output;
        }
        if (text[offset++] !== ",") invalid("invalid_json");
        whitespace();
      }
      invalid("invalid_json");
    }
    if (token === "[") {
      offset += 1;
      whitespace();
      const output = [];
      if (text[offset] === "]") {
        offset += 1;
        return output;
      }
      while (offset < text.length) {
        output.push(value(depth + 1));
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return output;
        }
        if (text[offset++] !== ",") invalid("invalid_json");
      }
      invalid("invalid_json");
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const number = text
      .slice(offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) invalid("invalid_json");
    offset += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) invalid("non_finite_number");
    return parsed;
  };
  const output = value();
  whitespace();
  if (offset !== text.length) invalid("invalid_json");
  return output;
}

export function canonicalize(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("non_finite_number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid("unsupported_json_value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      assertUnicodeScalars(key);
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    })
    .join(",")}}`;
}

export function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalize(value), "utf8"));
}

export function validateSafeIntegerFields(value, fieldNames) {
  if (Array.isArray(value)) {
    for (const entry of value) validateSafeIntegerFields(entry, fieldNames);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (fieldNames.has(key) && !Number.isSafeInteger(entry))
      invalid("unsafe_integer");
    validateSafeIntegerFields(entry, fieldNames);
  }
}

export function identifierViews(identifier) {
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) invalid("invalid_identifier");
  const tokens = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
  return { tokens, compact: tokens.join("") };
}

export function resolveExecutionClosure(graph) {
  const members = new Map(
    (graph.members ?? []).map((member) => [member.id, member]),
  );
  if (
    members.size !== (graph.members ?? []).length ||
    !members.has(graph.entryId)
  )
    invalid("closure_member_conflict");
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    const member = members.get(id);
    if (!member || !/^[0-9a-f]{64}$/.test(member.digest))
      invalid("closure_member_unresolved");
    visited.add(id);
    for (const edge of member.dependencies ?? []) {
      if (
        ![
          "static-module",
          "package",
          "native-artifact",
          "dynamic-import",
          "dynamic-require",
          "plugin",
          "loader",
          "subprocess",
        ].includes(edge.type)
      ) {
        invalid("closure_member_unresolved");
      }
      if (edge.optionalAtRuntime || edge.resolution !== "pinned")
        invalid("closure_member_unresolved");
      if (
        [
          "dynamic-import",
          "dynamic-require",
          "plugin",
          "loader",
          "subprocess",
        ].includes(edge.type) &&
        !edge.declared
      ) {
        invalid("undeclared_dynamic_execution");
      }
      const target = members.get(edge.target);
      if (!target) invalid("closure_member_unresolved");
      if (target.digest !== edge.expectedDigest)
        invalid("closure_digest_mismatch");
      visit(edge.target);
    }
  };
  visit(graph.entryId);
  if (visited.size !== members.size) invalid("closure_member_unreachable");
  const closure = [...visited].sort().map((id) => ({
    id,
    digest: members.get(id).digest,
    mode: members.get(id).mode,
  }));
  return { members: closure, digest: canonicalDigest(closure) };
}

export function actorSubjectId(context) {
  return canonicalDigest([
    "actor-subject-v1",
    context.issuerNamespaceId,
    context.principalId,
    context.representedSubjectId,
    context.audience,
  ]);
}

export function composePolicy(registry, release, riskRanks) {
  const allowed = new Set([
    "deny",
    "risk",
    "allowedAudiences",
    "allowedOperations",
    "requiredApprovals",
    "expiresAtUtcMs",
  ]);
  for (const policy of [registry, release]) {
    if (Object.keys(policy).some((key) => !allowed.has(key)))
      invalid("incomparable_policy");
    if (
      !riskRanks.includes(policy.risk) ||
      !Number.isSafeInteger(policy.expiresAtUtcMs)
    ) {
      invalid("incomparable_policy");
    }
  }
  const intersection = (left, right) =>
    [...new Set(left)].filter((value) => new Set(right).has(value)).sort();
  const allowedAudiences = intersection(
    registry.allowedAudiences,
    release.allowedAudiences,
  );
  const allowedOperations = intersection(
    registry.allowedOperations,
    release.allowedOperations,
  );
  return {
    deny:
      registry.deny ||
      release.deny ||
      allowedAudiences.length === 0 ||
      allowedOperations.length === 0,
    risk: riskRanks[
      Math.max(
        riskRanks.indexOf(registry.risk),
        riskRanks.indexOf(release.risk),
      )
    ],
    allowedAudiences,
    allowedOperations,
    requiredApprovals: [
      ...new Set([...registry.requiredApprovals, ...release.requiredApprovals]),
    ].sort(),
    expiresAtUtcMs: Math.min(registry.expiresAtUtcMs, release.expiresAtUtcMs),
  };
}

export function evaluateTrustedTime({
  sampleUtcMs,
  priorWatermarkUtcMs,
  maxBackwardSkewMs,
}) {
  if (
    ![sampleUtcMs, priorWatermarkUtcMs, maxBackwardSkewMs].every(
      Number.isSafeInteger,
    ) ||
    maxBackwardSkewMs < 0
  ) {
    invalid("invalid_time");
  }
  if (sampleUtcMs >= priorWatermarkUtcMs) {
    return {
      status: "ok",
      effectiveUtcMs: sampleUtcMs,
      watermarkUtcMs: sampleUtcMs,
    };
  }
  if (priorWatermarkUtcMs - sampleUtcMs <= maxBackwardSkewMs) {
    return {
      status: "clamped",
      effectiveUtcMs: priorWatermarkUtcMs,
      watermarkUtcMs: priorWatermarkUtcMs,
    };
  }
  return {
    status: "rollback",
    effectiveUtcMs: null,
    watermarkUtcMs: priorWatermarkUtcMs,
  };
}

export function isExpired(nowUtcMs, expiryUtcMs) {
  if (!Number.isSafeInteger(nowUtcMs) || !Number.isSafeInteger(expiryUtcMs))
    invalid("invalid_time");
  return nowUtcMs >= expiryUtcMs;
}

export function commandIdentityDigest(command) {
  return canonicalDigest([
    "command-identity-v1",
    command.actorSubjectId,
    command.commandKind,
    command.targetAggregateId,
    command.idempotencyKey,
  ]);
}

export function runExternalValidator(definition, cwd = root) {
  const execution = spawnSync(definition.command, definition.args, {
    cwd,
    encoding: "utf8",
    timeout: definition.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const executionEvidence = {
    exitStatus: execution.status,
    signal: execution.signal,
    stdoutDigest: sha256(execution.stdout ?? ""),
    stderrDigest: sha256(execution.stderr ?? ""),
  };
  if (
    execution.error?.code === "ETIMEDOUT" ||
    (execution.status === null && execution.signal)
  ) {
    return {
      gateId: definition.id,
      executed: true,
      kind: definition.timeoutKind,
      findings: [{ code: "external_timeout" }],
      execution: executionEvidence,
    };
  }
  if (execution.error) {
    return {
      gateId: definition.id,
      executed: true,
      kind: definition.spawnFailureKind,
      findings: [{ code: "external_spawn_failed" }],
      execution: executionEvidence,
    };
  }
  if (execution.status !== definition.success.exitStatus) {
    return {
      gateId: definition.id,
      executed: true,
      kind: definition.failureKind,
      findings: [{ code: "external_nonzero_exit" }],
      execution: executionEvidence,
    };
  }
  let parsed;
  try {
    parsed = parseStrictJson(execution.stdout);
  } catch {
    return {
      gateId: definition.id,
      executed: true,
      kind: definition.malformedOutputKind,
      findings: [{ code: "external_malformed_output" }],
      execution: executionEvidence,
    };
  }
  let selected = parsed;
  for (const segment of definition.success.jsonPath)
    selected = selected?.[segment];
  if (selected !== definition.success.equals) {
    return {
      gateId: definition.id,
      executed: true,
      kind: definition.failureKind,
      findings: [{ code: "external_contract_failed" }],
      execution: executionEvidence,
    };
  }
  return {
    gateId: definition.id,
    executed: true,
    kind: "pass",
    findings: [],
    execution: executionEvidence,
  };
}

export function aggregateGateResults(manifest, suppliedResults) {
  const gateIndex = new Map();
  const memberSet = new Set();
  const basisByType = new Map([
    ["local-subcommand", "local"],
    ["external-validator", "external"],
    ["requirement-definition", "definition"],
    ["scenario-definition", "definition"],
    ["closed-dimension-definition", "definition"],
    ["recovery-race-definition", "definition"],
  ]);
  let manifestInvalid =
    JSON.stringify(manifest.kindPrecedence) !==
    JSON.stringify(canonicalKindPrecedence);
  for (const [index, gate] of manifest.gates.entries()) {
    if (gateIndex.has(gate.id) || !basisByType.has(gate.type))
      manifestInvalid = true;
    if (gate.dependsOn.some((dependency) => !gateIndex.has(dependency)))
      manifestInvalid = true;
    gateIndex.set(gate.id, index);
    for (const member of gate.members) {
      if (memberSet.has(member)) manifestInvalid = true;
      memberSet.add(member);
    }
  }
  const supplied = new Map(
    suppliedResults.map((entry) => [entry.gateId, entry]),
  );
  if (supplied.size !== suppliedResults.length) manifestInvalid = true;
  const completed = new Map();
  const order = new Map(manifest.gates.map((gate, index) => [gate.id, index]));
  const priority = (kind) => canonicalKindPrecedence.indexOf(kind);
  const failedDependency = (gate) =>
    gate.dependsOn
      .map((id) => completed.get(id))
      .filter((entry) => entry?.kind !== "pass")
      .sort(
        (left, right) =>
          priority(left.kind) - priority(right.kind) ||
          order.get(left.gateId) - order.get(right.gateId),
      )[0];

  for (const gate of manifest.gates) {
    const blocker = failedDependency(gate);
    let entry = supplied.get(gate.id);
    let expectedFields = [
      "gateId",
      "executed",
      "kind",
      "findings",
      "blockedBy",
    ];
    if (entry?.executed) {
      expectedFields = ["gateId", "executed", "kind", "basis", "findings"];
      if (entry.basis === "external") expectedFields.splice(4, 0, "execution");
    }
    const externalExecutionValid =
      entry?.basis !== "external" ||
      hasExactFields(entry.execution, [
        "exitStatus",
        "signal",
        "stdoutDigest",
        "stderrDigest",
      ]);
    if (
      entry &&
      (entry.gateId !== gate.id ||
        priority(entry.kind) < 0 ||
        typeof entry.executed !== "boolean" ||
        !Array.isArray(entry.findings) ||
        !hasExactFields(entry, expectedFields) ||
        !externalExecutionValid ||
        (entry.executed && entry.basis !== basisByType.get(gate.type)))
    ) {
      entry = {
        gateId: gate.id,
        executed: false,
        kind: "invalid_invocation",
        findings: [{ code: "invalid_gate_result" }],
      };
    }
    if (!entry) {
      entry = blocker
        ? {
            gateId: gate.id,
            executed: false,
            kind: blocker.kind,
            findings: [],
            blockedBy: blocker.gateId,
          }
        : {
            gateId: gate.id,
            executed: false,
            kind: "invalid_invocation",
            findings: [{ code: "required_gate_unrun" }],
          };
    }
    if (blocker && entry.executed) {
      entry = {
        gateId: gate.id,
        executed: false,
        kind: "invalid_invocation",
        findings: [{ code: "executed_with_failed_dependency" }],
        blockedBy: blocker.gateId,
      };
    } else if (!entry.executed) {
      if (
        !blocker ||
        entry.blockedBy !== blocker.gateId ||
        entry.kind !== blocker.kind ||
        entry.kind === "pass"
      ) {
        entry = {
          gateId: gate.id,
          executed: false,
          kind: "invalid_invocation",
          findings: [{ code: "invalid_blocked_by" }],
        };
        if (blocker) entry.blockedBy = blocker.gateId;
      }
    } else if (entry.kind === "pass" && entry.executed !== true) {
      entry = {
        gateId: gate.id,
        executed: false,
        kind: "invalid_invocation",
        findings: [{ code: "unexecuted_pass" }],
      };
    }
    completed.set(gate.id, entry);
  }
  if (
    manifestInvalid ||
    [...supplied.keys()].some((id) => !gateIndex.has(id))
  ) {
    const first = manifest.gates[0]?.id ?? "manifest";
    completed.set(first, {
      gateId: first,
      executed: false,
      kind: "invalid_invocation",
      findings: [{ code: "aggregate_manifest_invalid" }],
    });
  }
  const findings = manifest.gates.map((gate) => completed.get(gate.id));
  const primaryKind = findings.reduce(
    (selected, entry) =>
      priority(entry.kind) < priority(selected) ? entry.kind : selected,
    "pass",
  );
  return { primaryKind, findings };
}

function result(subcommand, kind, checks = [], findings = []) {
  return {
    schemaVersion: "m0-result-v1",
    subcommand,
    executed: true,
    kind,
    checks,
    findings,
  };
}

export async function checkPrerequisites(
  manifestPath = new URL("../contracts/v2/prerequisites.json", import.meta.url),
) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return result(
      "prerequisites",
      "contract_failure",
      [],
      [
        {
          code: "invalid_prerequisite_manifest",
          subject: "contracts/v2/prerequisites.json",
        },
      ],
    );
  }
  const commandDefinitions = (manifest.requirements ?? []).map(
    ({ id, access, command, versionArgs, versionPrefix }) => ({
      id,
      access,
      command,
      versionArgs,
      versionPrefix,
    }),
  );
  const rangesValid = (manifest.requirements ?? []).every(
    ({ supportedVersion }) =>
      hasExactFields(supportedVersion, ["minInclusive", "maxExclusive"]) &&
      parseVersion(supportedVersion.minInclusive) &&
      parseVersion(supportedVersion.maxExclusive) &&
      compareVersion(
        parseVersion(supportedVersion.minInclusive),
        parseVersion(supportedVersion.maxExclusive),
      ) < 0,
  );
  if (
    manifest.schemaVersion !== "m0-prerequisites-v1" ||
    canonicalize(commandDefinitions) !== canonicalize(PREREQUISITE_COMMANDS) ||
    !rangesValid ||
    canonicalize(manifest.revisionAccess) !==
      canonicalize({
        commandId: "git",
        method: "git-cat-file",
        probeArgs: ["cat-file", "-e", "HEAD^{commit}"],
      })
  )
    return result(
      "prerequisites",
      "contract_failure",
      [],
      [
        {
          code: "prerequisite_constitution_mismatch",
          subject: "contracts/v2/prerequisites.json",
        },
      ],
    );

  const checks = [];
  const findings = [];
  const requirements = new Map();
  for (const requirement of manifest.requirements ?? []) {
    requirements.set(requirement.id, requirement);
    const run = spawnSync(requirement.command, requirement.versionArgs, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    const version =
      run.status === 0 && !run.error
        ? extractVersion(output, requirement.versionPrefix)
        : null;
    if (!version || !supports(version, requirement.supportedVersion)) {
      checks.push({ id: requirement.id, status: "missing" });
      const finding = {
        code: version ? "unsupported_version" : "executable_unavailable",
        subject: requirement.id,
      };
      if (version) finding.actualVersion = version;
      findings.push(finding);
      continue;
    }
    checks.push({
      id: requirement.id,
      status: "ok",
      version,
      access: requirement.access,
    });
  }

  const revision = manifest.revisionAccess;
  const revisionTool = requirements.get(revision?.commandId);
  if (revisionTool) {
    const probe = spawnSync(revisionTool.command, revision.probeArgs, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    const status = probe.status === 0 && !probe.error ? "ok" : "missing";
    checks.push({
      id: "external-source-revision",
      status,
      method: revision.method,
    });
    if (status !== "ok")
      findings.push({
        code: "revision_access_unavailable",
        subject: revision.method,
      });
  } else {
    findings.push({
      code: "revision_access_tool_missing",
      subject: revision?.commandId ?? "unknown",
    });
  }

  return result(
    "prerequisites",
    findings.length === 0 ? "pass" : "prerequisite_missing",
    checks,
    findings,
  );
}

export async function checkSources(
  manifestPath = new URL("../oracles/m0/sources.json", import.meta.url),
) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return result(
      "sources",
      "contract_failure",
      [],
      [{ code: "invalid_source_manifest", subject: "oracles/m0/sources.json" }],
    );
  }

  if (
    manifest.schemaVersion !== "m0-sources-v1" ||
    manifest.digestAlgorithm !== "sha256" ||
    canonicalize((manifest.v2SotFiles ?? []).map(({ path }) => path)) !==
      canonicalize(REQUIRED_V2_SOT_PATHS)
  )
    return result(
      "sources",
      "missing_source",
      [],
      [
        {
          code: "source_constitution_mismatch",
          subject: "oracles/m0/sources.json",
        },
      ],
    );
  const checks = [];
  const findings = [];
  for (const source of manifest.v2SotFiles ?? []) {
    if (RETIRED_M0_AUTHORITY_PATHS.includes(source.path)) {
      findings.push({
        code: "retired_authority_source",
        subject: source.path,
      });
      continue;
    }
    const absolute = resolve(root, source.path);
    if (!absolute.startsWith(`${root}${sep}`)) {
      findings.push({ code: "source_path_outside_root", subject: source.path });
      continue;
    }
    try {
      const digest = sha256(await readFile(absolute));
      const status = digest === source.sha256 ? "ok" : "missing";
      checks.push({ id: `sot:${source.path}`, status });
      if (status !== "ok")
        findings.push({ code: "source_digest_mismatch", subject: source.path });
    } catch {
      checks.push({ id: `sot:${source.path}`, status: "missing" });
      findings.push({ code: "source_unavailable", subject: source.path });
    }
  }

  const repositorySets = new Map();
  for (const repository of manifest.repositories ?? []) {
    const cwd = resolve(root, repository.checkoutPath);
    const revision = runGit(cwd, [
      "cat-file",
      "-e",
      `${repository.revision}^{commit}`,
    ]);
    if (revision.status !== 0 || revision.error) {
      checks.push({ id: `repository:${repository.id}`, status: "missing" });
      findings.push({ code: "revision_unavailable", subject: repository.id });
      return result("sources", "missing_source", checks, findings);
    }
    const tree = runGit(cwd, ["rev-parse", `${repository.revision}^{tree}`]);
    const remote = runGit(cwd, ["remote", "get-url", "origin"]);
    if (
      tree.status !== 0 ||
      tree.stdout.toString("utf8").trim() !== repository.tree ||
      remote.status !== 0 ||
      normalizeRemote(remote.stdout.toString("utf8")) !== repository.remote
    ) {
      checks.push({ id: `repository:${repository.id}`, status: "missing" });
      findings.push({
        code: "repository_identity_mismatch",
        subject: repository.id,
      });
      continue;
    }
    checks.push({
      id: `repository:${repository.id}`,
      status: "ok",
      revision: repository.revision,
    });

    const listing = runGit(cwd, [
      "ls-tree",
      "-rz",
      "--name-only",
      repository.revision,
    ]);
    if (listing.status !== 0) {
      findings.push({
        code: "source_tree_unavailable",
        subject: repository.id,
      });
      continue;
    }
    const paths = listing.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const blobDigests = new Map();
    const setIds = new Set();
    for (const memberSet of repository.memberSets ?? []) {
      setIds.add(memberSet.id);
      const members = [];
      let readable = true;
      for (const path of selectMembers(paths, memberSet.selector)) {
        if (!blobDigests.has(path)) {
          const blob = runGit(cwd, [
            "cat-file",
            "blob",
            `${repository.revision}:${path}`,
          ]);
          if (blob.status !== 0) {
            readable = false;
            break;
          }
          blobDigests.set(path, sha256(blob.stdout));
        }
        members.push({ path, sha256: blobDigests.get(path) });
      }
      const digest = sha256(JSON.stringify(members));
      const status =
        readable &&
        members.length === memberSet.memberCount &&
        digest === memberSet.contentDigest
          ? "ok"
          : "missing";
      checks.push({
        id: `source-set:${repository.id}:${memberSet.id}`,
        status,
        members: members.length,
      });
      if (status !== "ok")
        findings.push({
          code: "source_set_mismatch",
          subject: `${repository.id}:${memberSet.id}`,
        });
    }
    repositorySets.set(repository.id, setIds);
  }

  const appIds = new Set();
  for (const app of manifest.runtimeApps ?? []) {
    const valid =
      !appIds.has(app.id) &&
      repositorySets.get(app.repositoryId)?.has(app.sourceSetId) &&
      repositorySets.get(app.repositoryId)?.has(app.entrypointSetId);
    appIds.add(app.id);
    checks.push({
      id: `runtime-app:${app.id}`,
      status: valid ? "ok" : "missing",
    });
    if (!valid)
      findings.push({ code: "runtime_app_source_missing", subject: app.id });
  }
  if (
    sha256(JSON.stringify(manifest.runtimeApps ?? [])) !==
    manifest.runtimeAppSetDigest
  ) {
    findings.push({ code: "runtime_app_set_mismatch", subject: "runtimeApps" });
  }

  return result(
    "sources",
    findings.length === 0 ? "pass" : "missing_source",
    checks,
    findings,
  );
}

export async function checkSourceFacts() {
  try {
    const [manifest, schema] = await Promise.all([
      readFile(
        new URL("../contracts/v2/storage/source-facts.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL("../contracts/v2/storage/schema.sql", import.meta.url),
        "utf8",
      ),
    ]);
    const findings = [];
    const catalogBlock =
      schema.match(
        /INSERT INTO source_fact_kinds\(fact_kind\) VALUES([\s\S]*?);/,
      )?.[1] ?? "";
    const catalog = [...catalogBlock.matchAll(/\('([^']+)'\)/g)].map(
      (match) => match[1],
    );
    if (
      new Set(manifest.factKinds).size !== manifest.factKinds.length ||
      JSON.stringify(manifest.factKinds) !== JSON.stringify(catalog)
    ) {
      findings.push({
        code: "source_fact_union_mismatch",
        subject: "factKinds",
      });
    }
    const lifecycle = manifest.recoveryOperation.lifecycle;
    const cells = new Set(
      lifecycle.table.map(({ state, event }) => `${state}\0${event}`),
    );
    if (
      cells.size !== lifecycle.states.length * lifecycle.events.length ||
      lifecycle.table.some(
        ({ state, event }) =>
          !lifecycle.states.includes(state) ||
          !lifecycle.events.includes(event),
      )
    ) {
      findings.push({
        code: "recovery_operation_lifecycle_incomplete",
        subject: "RecoveryDiscoveredOperation",
      });
    }
    if (
      manifest.rawActivationPermitPersisted ||
      manifest.recoveryOperation.dispatchAuthority
    ) {
      findings.push({
        code: "source_fact_authority_escape",
        subject: "recovery",
      });
    }
    return result(
      "source-facts",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "source-fact-union",
          status: findings.length === 0 ? "ok" : "failed",
          members: catalog.length,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "source-facts",
      "contract_failure",
      [],
      [
        {
          code: "invalid_source_fact_manifest",
          subject: "contracts/v2/storage/source-facts.json",
        },
      ],
    );
  }
}

export async function checkTransactions() {
  try {
    const [manifest, errors] = await Promise.all(
      [
        "../contracts/v2/storage/transactions.json",
        "../contracts/v2/control/errors.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const findings = [];
    const required = [
      "database-genesis",
      "run-admission",
      "attempt-quiesced",
      "run-attempt-allocation",
      "action-registration",
      "checkpoint-append",
      "process-registration",
      "dispatch-start",
      "receipt-admission",
      "recovery-operation-discovery",
      "recovery-operation-outcome",
      "post-final-conflict",
      "recovery-binding-invalidation",
      "target-authority-close",
      "recovery-activation",
    ];
    const operationIds = new Set(manifest.operations.map(({ id }) => id));
    if (
      operationIds.size !== manifest.operations.length ||
      required.some((id) => !operationIds.has(id)) ||
      manifest.operations.some(
        ({ members }) =>
          new Set(members).size !== members.length || members.length < 2,
      )
    ) {
      findings.push({
        code: "transaction_set_incomplete",
        subject: "operations",
      });
    }
    const errorKinds = new Set(errors.errors.map(({ kind }) => kind));
    if (
      manifest.zeroRowMaySucceed ||
      new Set(manifest.fencedCas.map(({ id }) => id)).size !==
        manifest.fencedCas.length ||
      manifest.fencedCas.some(
        ({ zeroRowKinds }) =>
          zeroRowKinds.length === 0 ||
          zeroRowKinds.some((kind) => !errorKinds.has(kind)),
      )
    ) {
      findings.push({ code: "fenced_cas_invalid", subject: "fencedCas" });
    }
    if (
      manifest.externalCallPolicy.insideSqliteTransaction ||
      manifest.externalCallPolicy.automaticRedispatch ||
      manifest.runAttemptAllocationCas.zeroRowSuccess
    ) {
      findings.push({
        code: "transaction_external_boundary_invalid",
        subject: "externalCallPolicy",
      });
    }
    return result(
      "transactions",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "transaction-sets",
          status: findings.length === 0 ? "ok" : "failed",
          members: operationIds.size,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "transactions",
      "contract_failure",
      [],
      [
        {
          code: "invalid_transaction_manifest",
          subject: "contracts/v2/storage/transactions.json",
        },
      ],
    );
  }
}

export async function checkStateMachines() {
  try {
    const [manifest, effectManifest, processManifest, errors, authority] =
      await Promise.all(
        [
          "../contracts/v2/control/state-machines.json",
          "../contracts/v2/control/effect-state-machines.json",
          "../contracts/v2/runtime/process-lifecycle.json",
          "../contracts/v2/control/errors.json",
          "../oracles/m0/authority-map.json",
        ].map(async (path) =>
          JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
        ),
      );
    const findings = [];
    const errorKinds = new Set(errors.errors.map(({ kind }) => kind));
    const requirementIds = new Set(
      authority.requirements.map(({ requirementId }) => requirementId),
    );
    const machineIds = new Set();
    const processMachine = { id: "ProcessLifecycle", ...processManifest };
    for (const machine of [
      ...manifest.machines,
      ...effectManifest.machines,
      processMachine,
    ]) {
      if (
        machineIds.has(machine.id) ||
        new Set(machine.states).size !== machine.states.length ||
        new Set(machine.events).size !== machine.events.length
      ) {
        findings.push({
          code: "state_machine_dimension_conflict",
          subject: machine.id,
        });
      }
      machineIds.add(machine.id);
      const cells = new Set();
      for (const entry of machine.table) {
        const key = `${entry.state}\0${entry.event}`;
        const outcome = entry.outcome;
        if (
          cells.has(key) ||
          !machine.states.includes(entry.state) ||
          !machine.events.includes(entry.event) ||
          !["transition", "idempotent", "allow", "reject", "delegate"].includes(
            outcome.kind,
          ) ||
          (["transition", "idempotent", "allow"].includes(outcome.kind) &&
            !machine.states.includes(outcome.nextState)) ||
          (outcome.kind === "reject" && !errorKinds.has(outcome.errorKind)) ||
          (outcome.kind === "delegate" &&
            !requirementIds.has(outcome.ownerRequirementId))
        ) {
          findings.push({
            code: "state_machine_cell_invalid",
            subject: `${machine.id}:${key}`,
          });
        }
        cells.add(key);
      }
      if (cells.size !== machine.states.length * machine.events.length) {
        findings.push({
          code: "state_machine_incomplete",
          subject: machine.id,
        });
      }
    }
    return result(
      "state-machines",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "state-machine-cells",
          status: findings.length === 0 ? "ok" : "failed",
          machines: machineIds.size,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "state-machines",
      "contract_failure",
      [],
      [
        {
          code: "invalid_state_machine_manifest",
          subject: "contracts/v2/control/state-machines.json",
        },
      ],
    );
  }
}

export async function checkHarness() {
  try {
    const [harness, taxonomy] = await Promise.all(
      [
        "../contracts/v2/control/harness.json",
        "../contracts/v2/control/taxonomy.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const findings = [];
    const actionEvents = taxonomy.unions.find(
      ({ id }) => id === "action-event",
    )?.members;
    if (
      !harness.session.uniquePerRunAttempt ||
      harness.session.mayCreateRun ||
      harness.session.mayCreateRunAttempt ||
      harness.session.maySubmitTerminal ||
      JSON.stringify(harness.actionEvents.kinds) !==
        JSON.stringify(actionEvents)
    ) {
      findings.push({
        code: "harness_owner_boundary_invalid",
        subject: "session",
      });
    }
    if (
      JSON.stringify(harness.checkpoint.allowedBoundaryKinds) !==
        JSON.stringify(["human", "effect", "external-input"]) ||
      !harness.checkpoint.artifactRefOnly ||
      !harness.checkpoint.resumeCreatesNewAttempt
    ) {
      findings.push({
        code: "checkpoint_boundary_invalid",
        subject: "checkpoint",
      });
    }
    const obligationKinds = harness.obligations.kinds.map(({ kind }) => kind);
    if (
      JSON.stringify(obligationKinds) !==
        JSON.stringify(["effect", "human", "external-input"]) ||
      new Set(harness.obligations.ownerKinds).size !==
        harness.obligations.ownerKinds.length ||
      !harness.ownerTransfer.singleSuccessor ||
      !harness.ownerTransfer.forbidBranch ||
      !harness.ownerTransfer.forbidCycle
    ) {
      findings.push({
        code: "obligation_contract_invalid",
        subject: "obligations",
      });
    }
    if (
      !harness.attemptQuiescence.allocationConsumesFact ||
      new Set(harness.attemptQuiescence.fencedAttemptInputs).size !==
        harness.attemptQuiescence.fencedAttemptInputs.length ||
      harness.attemptQuiescence.lateInputsScheduleWork
    ) {
      findings.push({
        code: "attempt_quiescence_invalid",
        subject: "AttemptQuiesced",
      });
    }
    return result(
      "harness",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "harness-contract",
          status: findings.length === 0 ? "ok" : "failed",
        },
      ],
      findings,
    );
  } catch {
    return result(
      "harness",
      "contract_failure",
      [],
      [
        {
          code: "invalid_harness_manifest",
          subject: "contracts/v2/control/harness.json",
        },
      ],
    );
  }
}

export async function checkTaxonomy() {
  try {
    const [taxonomy, commands, projections, errors] = await Promise.all(
      [
        "../contracts/v2/control/taxonomy.json",
        "../contracts/v2/control/commands.json",
        "../contracts/v2/control/projections.json",
        "../contracts/v2/control/errors.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const findings = [];
    const unions = new Map();
    for (const union of taxonomy.unions) {
      if (
        unions.has(union.id) ||
        new Set(union.members).size !== union.members.length
      ) {
        findings.push({ code: "taxonomy_member_conflict", subject: union.id });
      }
      unions.set(union.id, new Set(union.members));
    }
    const commandMembers = [...unions.get("control-command")];
    if (
      JSON.stringify(commandMembers) !==
      JSON.stringify(commands.commands.map(({ kind }) => kind))
    ) {
      findings.push({
        code: "command_taxonomy_mismatch",
        subject: "control-command",
      });
    }
    if (
      JSON.stringify(taxonomy.projectionFamilies) !==
      JSON.stringify(projections.families.map(({ id }) => id))
    ) {
      findings.push({
        code: "projection_family_mismatch",
        subject: "projectionFamilies",
      });
    }
    const fanout = new Set();
    for (const entry of taxonomy.fanout) {
      const key = `${entry.unionId}\0${entry.member}`;
      if (
        fanout.has(key) ||
        !unions.get(entry.unionId)?.has(entry.member) ||
        entry.families.length === 0 ||
        new Set(entry.families).size !== entry.families.length ||
        entry.families.some(
          (family) => !taxonomy.projectionFamilies.includes(family),
        )
      ) {
        findings.push({ code: "fanout_invalid", subject: key });
      }
      fanout.add(key);
    }
    const expectedFanout = [...unions.values()].reduce(
      (sum, members) => sum + members.size,
      0,
    );
    if (fanout.size !== expectedFanout)
      findings.push({ code: "fanout_incomplete", subject: "taxonomy" });
    const errorKinds = new Set(errors.errors.map(({ kind }) => kind));
    for (const errorKind of Object.values(taxonomy.rejections)) {
      if (!errorKinds.has(errorKind))
        findings.push({ code: "unknown_taxonomy_error", subject: errorKind });
    }
    return result(
      "taxonomy",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "closed-taxonomy",
          status: findings.length === 0 ? "ok" : "failed",
        },
      ],
      findings,
    );
  } catch {
    return result(
      "taxonomy",
      "contract_failure",
      [],
      [{ code: "invalid_taxonomy_manifest", subject: "contracts/v2/control" }],
    );
  }
}

export async function checkSafeErrors() {
  try {
    const [errors, durable, taxonomy] = await Promise.all(
      [
        "../contracts/v2/control/errors.json",
        "../contracts/v2/control/durable-data.json",
        "../contracts/v2/control/taxonomy.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const findings = [];
    const schemas = new Map(
      errors.detailSchemas.map((schema) => [
        `${schema.id}\0${schema.version}`,
        schema,
      ]),
    );
    const kinds = new Set();
    for (const error of errors.errors) {
      if (kinds.has(error.kind))
        findings.push({ code: "duplicate_error_kind", subject: error.kind });
      kinds.add(error.kind);
      const schema = schemas.get(
        `${error.detailSchemaId}\0${error.detailSchemaVersion}`,
      );
      if (
        !schema ||
        !errors.retryabilityKinds.includes(error.retryability) ||
        Buffer.byteLength(error.message, "utf8") > errors.messageMaxUtf8Bytes ||
        /stack|traceback|credential|secret|host path|filesystem path|raw provider/i.test(
          error.message,
        )
      ) {
        findings.push({ code: "unsafe_error_contract", subject: error.kind });
      }
    }
    for (const schema of errors.detailSchemas) {
      for (const field of schema.fields) {
        if (
          field.dataClass === "runtime-only" ||
          field.dataClass === "secret-ref"
        ) {
          findings.push({
            code: "unsafe_error_detail",
            subject: `${schema.id}.${field.id}`,
          });
        }
        if (
          field.allowedValues &&
          (field.allowedValues.length === 0 ||
            new Set(field.allowedValues).size !== field.allowedValues.length ||
            field.allowedValues.some((value) => typeof value !== "string"))
        ) {
          findings.push({
            code: "unsafe_error_detail",
            subject: `${schema.id}.${field.id}`,
          });
        }
        if (field.dataClass === "safe-text") {
          const sanitizer = durable.sanitizerRegistry.find(
            ({ id, version }) =>
              id === field.sanitizerId && version === field.sanitizerVersion,
          );
          if (
            !sanitizer ||
            !Number.isSafeInteger(field.maxUtf8Bytes) ||
            field.maxUtf8Bytes <= 0
          ) {
            findings.push({
              code: "unsafe_error_detail",
              subject: `${schema.id}.${field.id}`,
            });
          }
        }
      }
    }
    for (const kind of Object.values(taxonomy.rejections)) {
      if (!kinds.has(kind))
        findings.push({ code: "missing_error_kind", subject: kind });
    }
    return result(
      "safe-errors",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "closed-error-algebra",
          status: findings.length === 0 ? "ok" : "failed",
          members: kinds.size,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "safe-errors",
      "contract_failure",
      [],
      [
        {
          code: "invalid_error_manifest",
          subject: "contracts/v2/control/errors.json",
        },
      ],
    );
  }
}

async function outputFilesBelow(path) {
  const files = [];
  for (const entry of await readdir(resolve(root, path), {
    withFileTypes: true,
  })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await outputFilesBelow(relative)));
    else files.push(relative);
  }
  return files;
}

export async function checkOutputManifest(dirtyPaths = []) {
  try {
    const manifestPath = resolve(root, "oracles/m0/output-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const actual = [
      ...(await outputFilesBelow("contracts/v2")),
      ...(await outputFilesBelow("oracles/m0")),
      ...(await outputFilesBelow("measurements")),
      ...(await outputFilesBelow("tests/m0")),
      "scripts/validate-m0.mjs",
    ].sort();
    const findings = [];
    if (
      canonicalize(manifest.outputs.map(({ path }) => path)) !==
      canonicalize(actual)
    )
      findings.push({ code: "output_manifest_members_mismatch" });
    for (const output of manifest.outputs) {
      if (RETIRED_M0_AUTHORITY_PATHS.includes(output.path)) {
        findings.push({
          code: "retired_authority_output",
          subject: output.path,
        });
      } else if (output.path === "oracles/m0/output-manifest.json") {
        if (output.digestPolicy !== "self-schema-only")
          findings.push({ code: "output_manifest_self_policy_invalid" });
      } else if (
        sha256(readFileSync(resolve(root, output.path))) !== output.sha256
      )
        findings.push({
          code: "declared_output_digest_mismatch",
          subject: output.path,
        });
    }
    if (
      sha256(readFileSync(resolve(root, manifest.sourceManifestPath))) !==
      manifest.sourceManifestDigest
    )
      findings.push({ code: "source_manifest_digest_mismatch" });
    const declared = new Set(manifest.outputs.map(({ path }) => path));
    const ignoredDirtyPaths = dirtyPaths.filter((path) => !declared.has(path));
    return result(
      "output-manifest",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "declared-outputs",
          status: findings.length === 0 ? "ok" : "failed",
          members: actual.length,
          ignoredDirtyPaths,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "output-manifest",
      "contract_failure",
      [],
      [{ code: "output_manifest_invalid" }],
    );
  }
}

export function validateMeasurementLedger(manifest, ledger, evidence) {
  const findings = [];
  if (
    canonicalDigest(manifest) !== EXPECTED_MEASUREMENT_MANIFEST_DIGEST ||
    !hasExactFields(ledger, ["schemaVersion", "manifest", "records"]) ||
    ledger.manifest !== "measurements/manifest.json"
  )
    findings.push({
      code: "measurement_constitution_mismatch",
      subject: "measurements/manifest.json",
    });
  const metrics = new Set(manifest.metrics.map(({ id }) => id));
  const records = new Map();
  const successor = new Map();
  const roots = new Map();
  for (const record of ledger.records ?? []) {
    const key = `${record.metricId}\0${record.environmentId}`;
    let valid =
      hasExactFields(record, manifest.recordRequiredFields) &&
      typeof record.recordId === "string" &&
      metrics.has(record.metricId) &&
      typeof record.environmentId === "string" &&
      Number.isSafeInteger(record.recordedAtUtcMs) &&
      !records.has(record.recordId) &&
      typeof record.rawEvidenceRef === "string" &&
      record.rawEvidenceRef.startsWith("measurements/evidence.json#") &&
      getJsonPointer(
        evidence,
        record.rawEvidenceRef.slice("measurements/evidence.json#".length),
      ) !== undefined;
    if (record.supersedesRecordId === null) {
      roots.set(key, (roots.get(key) ?? 0) + 1);
    } else {
      const parent = records.get(record.supersedesRecordId);
      valid &&=
        parent?.metricId === record.metricId &&
        parent?.environmentId === record.environmentId &&
        parent.recordedAtUtcMs < record.recordedAtUtcMs &&
        !successor.has(parent.recordId);
      if (parent) successor.set(parent.recordId, record.recordId);
    }
    records.set(record.recordId, record);
    if (!valid)
      findings.push({
        code: "measurement_chain_invalid",
        subject: record.recordId,
      });
  }
  for (const [key, count] of roots)
    if (count !== 1)
      findings.push({
        code: "measurement_root_count_invalid",
        subject: key,
      });
  return { findings, recordCount: records.size };
}

export async function checkMeasurementLedger() {
  try {
    const [manifest, ledger, evidence] = await Promise.all(
      [
        "../measurements/manifest.json",
        "../measurements/ledger.json",
        "../measurements/evidence.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const validation = validateMeasurementLedger(manifest, ledger, evidence);
    return result(
      "measurements",
      validation.findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "measurement-records",
          status: validation.findings.length === 0 ? "ok" : "failed",
          members: validation.recordCount,
        },
      ],
      validation.findings,
    );
  } catch {
    return result(
      "measurements",
      "contract_failure",
      [],
      [{ code: "invalid_measurement_ledger", subject: "measurements" }],
    );
  }
}

export async function checkContracts() {
  const localChecks = [
    await checkPrerequisites(),
    await checkSources(),
    await checkTaxonomy(),
    await checkSafeErrors(),
    await checkSourceFacts(),
    await checkTransactions(),
    await checkHarness(),
    await checkStateMachines(),
    await checkFaultMatrix(),
    await checkFanout(),
    await checkOutputManifest(),
    await checkMeasurementLedger(),
  ];
  const testFileNames = await readdir(new URL("../tests/m0", import.meta.url));
  const testFiles = testFileNames
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) =>
      fileURLToPath(new URL(`../tests/m0/${name}`, import.meta.url)),
    );
  const tests = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  let testKind = "pass";
  let testCode;
  if (
    tests.error?.code === "ETIMEDOUT" ||
    (tests.status === null && tests.signal)
  ) {
    testKind = "evidence_failure";
    testCode = "m0_tests_timeout";
  } else if (tests.error) {
    testKind = "prerequisite_missing";
    testCode = "m0_tests_spawn_failed";
  } else if (tests.status !== 0) {
    testKind = "contract_failure";
    testCode = "m0_tests_failed";
  }
  const precedence = [
    "invalid_invocation",
    "prerequisite_missing",
    "missing_source",
    "contract_failure",
    "evidence_failure",
    "pass",
  ];
  const kinds = [...localChecks.map(({ kind }) => kind), testKind];
  const primaryKind = kinds.reduce(
    (selected, kind) =>
      precedence.indexOf(kind) < precedence.indexOf(selected) ? kind : selected,
    "pass",
  );
  return result(
    "contracts",
    primaryKind,
    [
      ...localChecks.map((entry) => ({
        id: entry.subcommand,
        status: entry.kind === "pass" ? "ok" : "failed",
        kind: entry.kind,
      })),
      {
        id: "m0-tests",
        status: testKind === "pass" ? "ok" : "failed",
        kind: testKind,
        members: testFiles.length,
        stdoutDigest: sha256(tests.stdout ?? ""),
        stderrDigest: sha256(tests.stderr ?? ""),
      },
    ],
    [
      ...localChecks.flatMap((entry) =>
        entry.findings.map((finding) => ({
          ...finding,
          subcommand: entry.subcommand,
        })),
      ),
      ...(testCode ? [{ code: testCode, subject: "tests/m0" }] : []),
    ],
  );
}

export async function evaluateOracleCases(
  authority,
  cases,
  registry,
  expectationManifest,
) {
  const findings = [];
  const results = new Map();
  const fixtures = new Map(registry.fixtures.map((entry) => [entry.id, entry]));
  const schemas = new Map(
    registry.observationSchemas.map((entry) => [entry.id, entry]),
  );
  const predicates = new Map(
    registry.applicabilityPredicates.map((entry) => [entry.id, entry]),
  );
  const typedExpectations = new Map(
    expectationManifest.expectations.map((entry) => [entry.caseId, entry]),
  );
  const coverageProjection = authority.requirements.flatMap((requirement) =>
    requirement.scenarios.map(({ scenarioId, coverageClass }) => ({
      scenarioId,
      coverageClass,
    })),
  );
  const constitutionValid =
    hasExactFields(cases, [
      "schemaVersion",
      "requirementId",
      "typedExpectationManifest",
      "frozenBeforeCandidateExecution",
      "caseUniverseDigest",
      "cases",
    ]) &&
    cases.frozenBeforeCandidateExecution === true &&
    canonicalDigest(coverageProjection) === EXPECTED_SCENARIO_COVERAGE_DIGEST &&
    canonicalDigest(registry) === EXPECTED_EVALUATOR_REGISTRY_DIGEST &&
    registry.fixturePassIsCandidateEvidence === false &&
    registry.candidateExecutionOwner === "m1+";
  if (!constitutionValid) {
    findings.push({
      code: "oracle_constitution_invalid",
      subject: "authority-registry",
    });
    return { findings, results };
  }
  if (
    cases.typedExpectationManifest !==
      "oracles/m0/scenario-expectations.json" ||
    expectationManifest.executorId !== registry.executor.id ||
    expectationManifest.expectationSetDigest !==
      sha256(JSON.stringify(expectationManifest.expectations)) ||
    typedExpectations.size !== expectationManifest.expectations.length ||
    typedExpectations.size !== cases.cases.length ||
    fixtures.size !== registry.fixtures.length ||
    schemas.size !== registry.observationSchemas.length ||
    predicates.size !== registry.applicabilityPredicates.length ||
    registry.executor.id !== "normative-scenario-compiler-v1" ||
    registry.executor.mode !== "definition-compiler" ||
    registry.executor.candidateInternalsAllowed ||
    registry.mode !== "definition-only" ||
    registry.m0ExecutesCandidate !== false
  ) {
    findings.push({ code: "oracle_registry_invalid", subject: "registry" });
  }

  const definitions = new Map(
    authority.requirements.flatMap((requirement) =>
      requirement.scenarios.map((scenario) => [
        scenario.scenarioId,
        {
          requirementId: requirement.requirementId,
        },
      ]),
    ),
  );

  const caseFields = [
    "caseId",
    "requirementId",
    "scenarioId",
    "inputFixtureId",
    "observationSchemaId",
    "expected",
    "applicabilityPredicateId",
    "qualificationProfiles",
    "exclusionCodes",
    "coverageClass",
  ];
  const seenCases = new Set();
  const seenScenarios = new Set();
  for (const oracleCase of cases.cases) {
    const definition = definitions.get(oracleCase.scenarioId);
    const fixture = fixtures.get(oracleCase.inputFixtureId);
    const schema = schemas.get(oracleCase.observationSchemaId);
    const predicate = predicates.get(oracleCase.applicabilityPredicateId);
    const typedExpectation = typedExpectations.get(oracleCase.caseId);
    const requiredFields = registry.scenarioObservationRequiredFields;
    const expectedFields = Object.keys(typedExpectation?.observation ?? {});
    const coveragePolicy = COVERAGE_POLICY[oracleCase.coverageClass];
    const projectedPolicy = {
      inputFixtureId: oracleCase.inputFixtureId,
      observationSchemaId: oracleCase.observationSchemaId,
      applicabilityPredicateId: oracleCase.applicabilityPredicateId,
      qualificationProfiles: oracleCase.qualificationProfiles,
      exclusionCodes: oracleCase.exclusionCodes,
    };
    const valid = Boolean(
      definition &&
        hasExactFields(oracleCase, caseFields) &&
        coveragePolicy &&
        canonicalize(projectedPolicy) === canonicalize(coveragePolicy) &&
        fixture &&
        schema &&
        predicate &&
        !seenCases.has(oracleCase.caseId) &&
        !seenScenarios.has(oracleCase.scenarioId) &&
        fixture.coverageClass === oracleCase.coverageClass &&
        fixture.executorId === registry.executor.id &&
        fixture.definitionOwnerId === "m0o.format" &&
        schema.kind === registry.executor.outputKind &&
        schema.closed === true &&
        definition.requirementId === oracleCase.requirementId &&
        oracleCase.expected?.kind === "owner-scenario-outcome" &&
        oracleCase.expected.ownerScenarioId === oracleCase.scenarioId &&
        typedExpectation?.scenarioId === oracleCase.scenarioId &&
        expectedFields.length === requiredFields.length &&
        requiredFields.every((field) => expectedFields.includes(field)) &&
        registry.outcomeClasses.includes(
          typedExpectation.observation.outcomeClass,
        ) &&
        typedExpectation.observation.requiredEvidenceKinds.length > 0 &&
        typedExpectation.observation.requiredEvidenceKinds.every((kind) =>
          registry.evidenceKinds.includes(kind),
        ) &&
        [
          typedExpectation.observation.sourceFactState,
          typedExpectation.observation.commandState,
          typedExpectation.observation.externalState,
          typedExpectation.observation.mutationAuthorityState,
        ].every((state) => registry.stateClasses.includes(state)),
    );
    seenCases.add(oracleCase.caseId);
    seenScenarios.add(oracleCase.scenarioId);
    const entry = {
      basis: "definition",
      definitionStatus: valid ? "definition-valid" : "definition-invalid",
      kind: valid ? "pass" : "contract_failure",
      findings: valid
        ? []
        : [
            {
              code: "oracle_case_evaluation_failed",
              subject: oracleCase.caseId,
            },
          ],
    };
    results.set(`scenario:${oracleCase.scenarioId}`, entry);
    if (!valid) findings.push(...entry.findings);
  }

  for (const requirement of authority.requirements) {
    const owned = requirement.scenarios.map(({ scenarioId }) =>
      results.get(`scenario:${scenarioId}`),
    );
    const valid =
      owned.length > 0 && owned.every((entry) => entry?.kind === "pass");
    results.set(`requirement:${requirement.requirementId}`, {
      basis: "definition",
      definitionStatus: valid ? "definition-valid" : "definition-invalid",
      kind: valid ? "pass" : "contract_failure",
      findings: valid
        ? []
        : [
            {
              code: "requirement_oracle_evaluation_failed",
              subject: requirement.requirementId,
            },
          ],
    });
  }
  return { findings, results };
}

export function expectedRecoveryRaceObservation(point, disposition) {
  if (disposition === "crash-before") {
    return {
      kind: "recovery-race-observation-v1",
      sourceFacts: { required: [], forbidden: [point.sourceFactKind] },
      commandState: "unchanged",
      externalState: "not-called",
      mutationAuthorityState: "unchanged",
      mutationAuthorityCallCount: 0,
      replayState: "not-applicable",
    };
  }
  const mutationAuthorityCallCount = point.mutationAuthorityCallAfter ? 1 : 0;
  if (disposition === "crash-after") {
    return {
      kind: "recovery-race-observation-v1",
      sourceFacts: { required: [point.sourceFactKind], forbidden: [] },
      commandState: point.commandAfterState,
      externalState: point.externalAfterState,
      mutationAuthorityState: point.mutationAuthorityAfterState,
      mutationAuthorityCallCount,
      replayState: "resume-local-completion",
    };
  }
  if (disposition === "response-loss") {
    return {
      kind: "recovery-race-observation-v1",
      sourceFacts: { required: [point.sourceFactKind], forbidden: [] },
      commandState: point.commandAfterState,
      externalState: point.externalAfterState,
      mutationAuthorityState: point.mutationAuthorityAfterState,
      mutationAuthorityCallCount,
      replayState: "same-command-replay",
    };
  }
  if (disposition === "competing-command") {
    return {
      kind: "recovery-race-observation-v1",
      sourceFacts: { required: [point.sourceFactKind], forbidden: [] },
      commandState: "single-winner-loser-finalized",
      externalState: "single-cas-winner",
      mutationAuthorityState: "single-generation-winner",
      mutationAuthorityCallCount,
      replayState: "loser-observes-winner",
    };
  }
  invalid("unknown_recovery_race_disposition");
}

export function evaluateRecoveryRaceCells(matrix, contractManifest) {
  const findings = [];
  const results = new Map();
  const points = new Map(
    contractManifest.pointContracts.map((point) => [point.id, point]),
  );
  const typedResults = new Map(
    contractManifest.results.map((entry) => [entry.caseId, entry]),
  );
  const schema = contractManifest.observationSchema;
  if (
    matrix.typedRecoveryRaceManifest !==
      "oracles/m0/recovery-race-contracts.json" ||
    contractManifest.resultSetDigest !==
      sha256(JSON.stringify(contractManifest.results)) ||
    points.size !== contractManifest.pointContracts.length ||
    typedResults.size !== contractManifest.results.length ||
    points.size !== matrix.recoveryRacePoints.length ||
    typedResults.size !== matrix.recoveryRaceCells.length ||
    canonicalize(matrix.recoveryRacePoints) !==
      canonicalize(RECOVERY_RACE_POINTS) ||
    canonicalize(matrix.dispositions) !==
      canonicalize(RECOVERY_RACE_DISPOSITIONS) ||
    matrix.recoveryRacePoints.some((id) => !points.has(id))
  ) {
    findings.push({
      code: "recovery_race_point_contract_invalid",
      subject: "points",
    });
  }
  const cellFields = [
    "candidateExecutionRequired",
    "caseId",
    "disposition",
    "excluded",
    "recoveryRacePoint",
    "requiredGate",
  ];
  for (const cell of matrix.recoveryRaceCells) {
    const point = points.get(cell.recoveryRacePoint);
    const typed = typedResults.get(cell.caseId);
    let valid = false;
    if (point && typed) {
      const expected = expectedRecoveryRaceObservation(point, cell.disposition);
      const fields = Object.keys(typed.observation);
      valid = Boolean(
        cell.caseId ===
          `recovery-race.${cell.recoveryRacePoint}.${cell.disposition}` &&
          cell.requiredGate ===
            `gate.recovery-race.${cell.recoveryRacePoint}.${cell.disposition}` &&
          cell.candidateExecutionRequired === true &&
          cell.excluded === false &&
          typed.recoveryRacePoint === cell.recoveryRacePoint &&
          typed.disposition === cell.disposition &&
          fields.length === schema.requiredFields.length &&
          schema.requiredFields.every((field) => fields.includes(field)) &&
          typed.observation.kind === schema.kind &&
          schema.commandStates.includes(typed.observation.commandState) &&
          schema.externalStates.includes(typed.observation.externalState) &&
          schema.mutationAuthorityStates.includes(
            typed.observation.mutationAuthorityState,
          ) &&
          schema.replayStates.includes(typed.observation.replayState) &&
          [0, 1].includes(typed.observation.mutationAuthorityCallCount) &&
          canonicalize(typed.observation) === canonicalize(expected) &&
          canonicalize(Object.keys(cell).sort()) === canonicalize(cellFields),
      );
    }
    const entry = {
      basis: "definition",
      definitionStatus: valid ? "definition-valid" : "definition-invalid",
      kind: valid ? "pass" : "contract_failure",
      findings: valid
        ? []
        : [{ code: "recovery_race_evaluation_failed", subject: cell.caseId }],
    };
    results.set(`recovery-race:${cell.caseId}`, entry);
    if (!valid) findings.push(...entry.findings);
  }
  return { findings, results };
}

function getJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (value, part) =>
        value !== null && typeof value === "object" && part in value
          ? value[part]
          : undefined,
      document,
    );
}

function readDimensionLocus(locus) {
  if (
    !locus ||
    typeof locus.sourcePath !== "string" ||
    locus.sourcePath.includes("..")
  )
    return null;
  const absolute = resolve(root, locus.sourcePath);
  if (!absolute.startsWith(`${root}${sep}`)) return null;
  let sourceText;
  try {
    sourceText = readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  if (locus.sourceDigest !== sha256(sourceText)) return null;
  if (locus.kind === "json-pointer") {
    if (!locus.sourcePath.endsWith(".json")) return null;
    let value;
    try {
      value = getJsonPointer(JSON.parse(sourceText), locus.pointer);
    } catch {
      return null;
    }
    return {
      expected: value,
      publicState: {
        kind: locus.kind,
        sourcePath: locus.sourcePath,
        sourceDigest: locus.sourceDigest,
        pointer: locus.pointer,
        role: locus.role,
        value,
      },
    };
  }
  if (
    !locus.sourcePath.endsWith(".sql") ||
    ![
      "sqlite-table",
      "sqlite-column",
      "sqlite-constraint",
      "sqlite-trigger",
      "sqlite-transition",
    ].includes(locus.kind)
  )
    return null;
  const identifier = (value) =>
    typeof value === "string" && /^[a-z][a-z0-9_]*$/u.test(value);
  if (!identifier(locus.table)) return null;
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  let query;
  if (locus.kind === "sqlite-column") {
    query = `SELECT name, type, "notnull" AS notNull, pk, dflt_value AS defaultValue FROM pragma_table_info(${literal(locus.table)}) WHERE name=${literal(locus.column)};`;
  } else {
    const objectType =
      locus.kind === "sqlite-trigger" || locus.kind === "sqlite-transition"
        ? "trigger"
        : "table";
    const objectName = objectType === "trigger" ? locus.name : locus.table;
    if (!identifier(objectName)) return null;
    query = `SELECT name, tbl_name AS tableName, sql FROM sqlite_schema WHERE type=${literal(objectType)} AND name=${literal(objectName)};`;
  }
  const run = spawnSync("sqlite3", ["-json", ":memory:"], {
    input: `${sourceText}\n${query}\n`,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) return null;
  let rows;
  try {
    rows = run.stdout.trim() ? JSON.parse(run.stdout) : [];
  } catch {
    return null;
  }
  const [row] = rows;
  if (!row) return null;
  let value;
  if (locus.kind === "sqlite-table")
    value = { name: row.name, sqlDigest: sha256(row.sql) };
  else if (locus.kind === "sqlite-column")
    value = {
      name: row.name,
      type: row.type,
      notNull: row.notNull,
      primaryKey: row.pk,
      defaultValue: row.defaultValue,
    };
  else if (locus.kind === "sqlite-constraint") {
    if (!identifier(locus.column)) return null;
    const prefix = `${locus.column} TEXT NOT NULL CHECK (${locus.column} IN (`;
    const start = row.sql.indexOf(prefix);
    const end = start < 0 ? -1 : row.sql.indexOf("))", start + prefix.length);
    if (start < 0 || end < 0) return null;
    const valuesText = row.sql.slice(start + prefix.length, end);
    const values = [...valuesText.matchAll(/'([^']+)'/gu)].map(
      (match) => match[1],
    );
    if (typeof locus.value !== "string" || !values.includes(locus.value))
      return null;
    value = {
      table: locus.table,
      column: locus.column,
      values,
      contains: locus.value,
    };
  } else if (locus.kind === "sqlite-trigger")
    value = {
      name: row.name,
      table: row.tableName,
      sqlDigest: sha256(row.sql),
    };
  else {
    if (
      !Array.isArray(locus.requiredFragments) ||
      locus.requiredFragments.some(
        (fragment) =>
          typeof fragment !== "string" || !row.sql.includes(fragment),
      )
    )
      return null;
    value = {
      name: row.name,
      table: row.tableName,
      requiredFragments: locus.requiredFragments,
      sqlDigest: sha256(row.sql),
    };
  }
  return {
    expected: value,
    publicState: {
      kind: locus.kind,
      sourcePath: locus.sourcePath,
      sourceDigest: locus.sourceDigest,
      role: locus.role,
      value,
    },
  };
}

const fixtureJsonCache = new Map();
function fixtureJson(path) {
  if (!fixtureJsonCache.has(path)) {
    const text = readFileSync(resolve(root, path), "utf8");
    let document = null;
    try {
      document = JSON.parse(text);
    } catch {
      // A malformed owner artifact invalidates every derived locus below.
    }
    fixtureJsonCache.set(path, { document, digest: sha256(text) });
  }
  return fixtureJsonCache.get(path);
}

function jsonDimensionLocus(path, parts, role) {
  const { document, digest } = fixtureJson(path);
  let value = document;
  for (const part of parts) value = value?.[part];
  const pointer = `/${parts
    .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
  return {
    kind: "json-pointer",
    sourcePath: path,
    sourceDigest: digest,
    pointer,
    role,
    expected: value,
  };
}

function transitionConsumerIndexes(table, value) {
  return table
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) => row.state === value || row.outcome?.nextState === value,
    )
    .map(({ index }) => index);
}

function deriveDimensionLoci(dimensionId, value) {
  const unionIds = {
    controlCommand: "control-command",
    runEvent: "run-event",
    harnessEvent: "harness-event",
    actionEvent: "action-event",
  };
  if (unionIds[dimensionId]) {
    const path = "contracts/v2/control/taxonomy.json";
    const { document } = fixtureJson(path);
    const unionIndex = document.unions.findIndex(
      ({ id }) => id === unionIds[dimensionId],
    );
    const memberIndex = document.unions[unionIndex]?.members.indexOf(value);
    const consumers = document.fanout
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          row.unionId === unionIds[dimensionId] && row.member === value,
      )
      .map(({ index }) => index);
    if (unionIndex < 0 || memberIndex < 0 || consumers.length === 0)
      return null;
    return [
      jsonDimensionLocus(
        path,
        ["unions", unionIndex, "members", memberIndex],
        "declaration",
      ),
      ...consumers.map((index) =>
        jsonDimensionLocus(path, ["fanout", index], "consumer"),
      ),
    ];
  }
  const machines = {
    activationState: ["contracts/v2/control/state-machines.json", "Activation"],
    runState: ["contracts/v2/control/state-machines.json", "Run"],
    runAttemptState: ["contracts/v2/control/state-machines.json", "RunAttempt"],
    approvalState: [
      "contracts/v2/control/effect-state-machines.json",
      "Approval",
    ],
    effectState: ["contracts/v2/control/effect-state-machines.json", "Effect"],
  };
  if (machines[dimensionId]) {
    const [path, machineId] = machines[dimensionId];
    const { document } = fixtureJson(path);
    const machineIndex = document.machines.findIndex(
      ({ id }) => id === machineId,
    );
    const machine = document.machines[machineIndex];
    const stateIndex = machine?.states.indexOf(value);
    const consumers = transitionConsumerIndexes(machine?.table ?? [], value);
    if (machineIndex < 0 || stateIndex < 0 || consumers.length === 0)
      return null;
    return [
      jsonDimensionLocus(
        path,
        ["machines", machineIndex, "states", stateIndex],
        "declaration",
      ),
      ...consumers.map((index) =>
        jsonDimensionLocus(
          path,
          ["machines", machineIndex, "table", index],
          "consumer",
        ),
      ),
    ];
  }
  if (dimensionId === "recoveryOperationState") {
    const path = "contracts/v2/storage/source-facts.json";
    const { document } = fixtureJson(path);
    const lifecycle = document.recoveryOperation.lifecycle;
    const stateIndex = lifecycle.states.indexOf(value);
    const consumers = transitionConsumerIndexes(lifecycle.table, value);
    if (stateIndex < 0 || consumers.length === 0) return null;
    return [
      jsonDimensionLocus(
        path,
        ["recoveryOperation", "lifecycle", "states", stateIndex],
        "declaration",
      ),
      ...consumers.map((index) =>
        jsonDimensionLocus(
          path,
          ["recoveryOperation", "lifecycle", "table", index],
          "consumer",
        ),
      ),
    ];
  }
  if (dimensionId === "projectionFamily") {
    const path = "contracts/v2/control/projections.json";
    const taxonomyPath = "contracts/v2/control/taxonomy.json";
    const projection = fixtureJson(path).document;
    const taxonomy = fixtureJson(taxonomyPath).document;
    const familyIndex = projection.families.findIndex(({ id }) => id === value);
    const taxonomyIndex = taxonomy.projectionFamilies.indexOf(value);
    if (familyIndex < 0 || taxonomyIndex < 0) return null;
    return [
      jsonDimensionLocus(path, ["families", familyIndex, "id"], "declaration"),
      jsonDimensionLocus(
        taxonomyPath,
        ["projectionFamilies", taxonomyIndex],
        "consumer",
      ),
    ];
  }
  if (dimensionId === "reconciliationState") {
    const path = "contracts/v2/control/effect.json";
    const states = fixtureJson(path).document.reconciliationStates;
    const index = states.indexOf(value);
    const schemaPath = "contracts/v2/storage/schema.sql";
    const schemaText = readFileSync(resolve(root, schemaPath), "utf8");
    const tableSql = schemaText.match(
      /CREATE TABLE recovery_discovered_operations \([\s\S]*?\n\) STRICT;/u,
    )?.[0];
    const valuesText = tableSql?.match(
      /reconciliation_state TEXT NOT NULL CHECK \(reconciliation_state IN \(([^)]*)\)\)/u,
    )?.[1];
    const values = valuesText
      ? [...valuesText.matchAll(/'([^']+)'/gu)].map((match) => match[1])
      : [];
    if (index < 0 || !values.includes(value)) return null;
    return [
      jsonDimensionLocus(path, ["reconciliationStates", index], "declaration"),
      {
        kind: "sqlite-constraint",
        sourcePath: schemaPath,
        sourceDigest: sha256(schemaText),
        table: "recovery_discovered_operations",
        column: "reconciliation_state",
        value,
        role: "consumer",
        expected: {
          table: "recovery_discovered_operations",
          column: "reconciliation_state",
          values,
          contains: value,
        },
      },
    ];
  }
  const arrays = {
    sourceFact: ["contracts/v2/storage/source-facts.json", ["factKinds"]],
    recoverySessionState: [
      "contracts/v2/storage/restore.json",
      ["session", "states"],
    ],
    recoveryQualificationState: [
      "contracts/v2/storage/restore.json",
      ["qualification", "states"],
    ],
    recoveryAgentAttemptState: [
      "contracts/v2/storage/restore.json",
      ["agentAttempt", "states"],
    ],
    bindingCertificateState: [
      "contracts/v2/storage/restore.json",
      ["bindingCertificate", "states"],
    ],
    activationPermitState: [
      "contracts/v2/storage/restore.json",
      ["activationPermit", "states"],
    ],
    mutationAuthorityType: [
      "contracts/v2/storage/restore.json",
      ["mutationAuthorityTypes"],
    ],
    hostStatus: ["contracts/v2/runtime/host-attestation.json", ["statuses"]],
    hostMode: ["contracts/v2/runtime/host-attestation.json", ["modes"]],
  };
  const descriptor = arrays[dimensionId];
  if (!descriptor) return null;
  const [path, parts] = descriptor;
  let values = fixtureJson(path).document;
  for (const part of parts) values = values[part];
  const index = values.indexOf(value);
  return index < 0
    ? null
    : [jsonDimensionLocus(path, [...parts, index], "declaration")];
}

export function evaluateClosedDimensionDefinitions(authority, matrix) {
  const findings = [];
  const results = new Map();
  const requirementIds = new Set(
    authority.requirements.map(({ requirementId }) => requirementId),
  );
  const dimensionIds = new Set();
  for (const dimension of matrix.closedDimensions) {
    const dimensionValid =
      !dimensionIds.has(dimension.id) &&
      requirementIds.has(dimension.ownerRequirementId) &&
      DIMENSION_OWNERS[dimension.id] === dimension.ownerRequirementId &&
      Array.isArray(dimension.values) &&
      dimension.values.length > 0 &&
      new Set(dimension.values).size === dimension.values.length;
    dimensionIds.add(dimension.id);
    for (const value of dimension.values ?? []) {
      const memberId = `dimension:${dimension.id}:${value}`;
      let valid = dimensionValid;
      let loci = [];
      try {
        loci = deriveDimensionLoci(dimension.id, value);
      } catch {
        valid = false;
      }
      valid &&= Array.isArray(loci) && loci.length > 0;
      for (const locus of loci) {
        const actual = readDimensionLocus(locus);
        valid &&=
          actual !== null &&
          canonicalize(actual.expected) === canonicalize(locus.expected);
      }
      const entry = {
        executed: true,
        basis: "definition",
        definitionStatus: valid ? "definition-valid" : "definition-invalid",
        kind: valid ? "pass" : "contract_failure",
        findings: valid
          ? []
          : [{ code: "closed_dimension_evaluation_failed", subject: memberId }],
      };
      results.set(memberId, entry);
      if (!valid) findings.push(...entry.findings);
    }
  }
  if (
    canonicalize(matrix.closedDimensions.map(({ id }) => id)) !==
    canonicalize(Object.keys(DIMENSION_OWNERS))
  )
    findings.push({
      code: "closed_dimension_constitution_mismatch",
      subject: "closedDimensions",
    });
  return { findings, results };
}

function combineDefinitionResults(
  authority,
  cases,
  matrix,
  caseDefinitions,
  dimensionDefinitions,
  raceDefinitions,
) {
  const results = new Map();
  const add = (memberId, definition) => {
    const valid = definition?.kind === "pass";
    results.set(memberId, {
      executed: true,
      basis: "definition",
      kind: valid ? "pass" : "contract_failure",
      findings: valid
        ? []
        : (definition?.findings ?? [
            { code: "definition_missing", subject: memberId },
          ]),
    });
  };
  for (const oracleCase of cases.cases) {
    const memberId = `scenario:${oracleCase.scenarioId}`;
    add(memberId, caseDefinitions.get(memberId));
  }
  for (const dimension of matrix.closedDimensions)
    for (const value of dimension.values) {
      const memberId = `dimension:${dimension.id}:${value}`;
      add(memberId, dimensionDefinitions.get(memberId));
    }
  for (const cell of matrix.recoveryRaceCells) {
    const memberId = `recovery-race:${cell.caseId}`;
    add(memberId, raceDefinitions.get(memberId));
  }
  for (const requirement of authority.requirements) {
    const memberId = `requirement:${requirement.requirementId}`;
    add(memberId, caseDefinitions.get(memberId));
  }
  return results;
}

export async function checkFaultMatrix() {
  try {
    const [
      matrix,
      cases,
      authority,
      oracleSchema,
      evaluatorRegistry,
      applicability,
      scenarioExpectations,
      recoveryRaceContracts,
    ] = await Promise.all(
      [
        "../oracles/m0/fault-matrix.json",
        "../oracles/m0/cases.json",
        "../oracles/m0/authority-map.json",
        "../oracles/m0/schema.json",
        "../oracles/m0/evaluator-registry.json",
        "../oracles/m0/applicability.json",
        "../oracles/m0/scenario-expectations.json",
        "../oracles/m0/recovery-race-contracts.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const findings = [];
    if (canonicalDigest(applicability) !== EXPECTED_APPLICABILITY_DIGEST)
      findings.push({
        code: "applicability_constitution_mismatch",
        subject: "oracles/m0/applicability.json",
      });
    const [caseEvaluation, dimensionEvaluation, raceEvaluation] =
      await Promise.all([
        evaluateOracleCases(
          authority,
          cases,
          evaluatorRegistry,
          scenarioExpectations,
        ),
        Promise.resolve(evaluateClosedDimensionDefinitions(authority, matrix)),
        Promise.resolve(
          evaluateRecoveryRaceCells(matrix, recoveryRaceContracts),
        ),
      ]);
    findings.push(
      ...caseEvaluation.findings,
      ...dimensionEvaluation.findings,
      ...raceEvaluation.findings,
    );
    const scenarios = authority.requirements.flatMap(
      ({ requirementId, scenarios: owned }) =>
        owned.map((scenario) => ({ requirementId, ...scenario })),
    );
    const scenarioIds = new Set();
    const caseIds = new Set();
    for (const oracleCase of cases.cases) {
      if (
        caseIds.has(oracleCase.caseId) ||
        scenarioIds.has(oracleCase.scenarioId) ||
        !oracleSchema.coverageClasses.includes(oracleCase.coverageClass) ||
        !hasExactFields(oracleCase, oracleSchema.caseRequiredFields)
      ) {
        findings.push({
          code: "oracle_case_invalid",
          subject: oracleCase.caseId,
        });
      }
      caseIds.add(oracleCase.caseId);
      scenarioIds.add(oracleCase.scenarioId);
    }
    if (
      cases.cases.length !== scenarios.length ||
      scenarios.some(({ scenarioId }) => !scenarioIds.has(scenarioId)) ||
      cases.caseUniverseDigest !== sha256(JSON.stringify(cases.cases))
    ) {
      findings.push({ code: "oracle_universe_incomplete", subject: "cases" });
    }
    if (
      matrix.closedDimensionsDigest !==
        sha256(JSON.stringify(matrix.closedDimensions)) ||
      matrix.closedDimensions.some(
        ({ values }) =>
          values.length === 0 || new Set(values).size !== values.length,
      )
    ) {
      findings.push({
        code: "closed_dimension_invalid",
        subject: "closedDimensions",
      });
    }
    const pairKeys = new Set();
    const raceCaseIds = new Set();
    const gates = new Set();
    for (const cell of matrix.recoveryRaceCells) {
      pairKeys.add(`${cell.recoveryRacePoint}\0${cell.disposition}`);
      raceCaseIds.add(cell.caseId);
      gates.add(cell.requiredGate);
      if (!cell.candidateExecutionRequired || cell.excluded) {
        findings.push({
          code: "recovery_race_cell_excluded",
          subject: cell.caseId,
        });
      }
    }
    const expectedCells =
      matrix.recoveryRacePoints.length * matrix.dispositions.length;
    if (
      matrix.recoveryRacePoints.length !== 22 ||
      matrix.dispositions.length !== 4 ||
      pairKeys.size !== expectedCells ||
      raceCaseIds.size !== expectedCells ||
      gates.size !== expectedCells ||
      matrix.recoveryRaceCells.length !== expectedCells ||
      matrix.recoveryRaceCellDigest !==
        sha256(JSON.stringify(matrix.recoveryRaceCells))
    ) {
      findings.push({
        code: "recovery_race_matrix_incomplete",
        subject: "recoveryRaceCells",
      });
    }
    for (const required of [
      "run-attempt-checkpoint-allocation",
      "checkpoint-obligation-owner-chain",
      "attempt-quiesced-late-input",
      "retry-owner-overlap",
      "single-operation-effect",
      "containment-registration-descendant",
      "recovery-session-target-multi-agent",
      "recovery-discovery-membership",
      "target-authority-closed",
      "binding-permit-invalidation",
      "safe-error-details",
      "aggregate-gate-completeness",
    ]) {
      if (!matrix.regressionClasses.includes(required)) {
        findings.push({ code: "regression_class_missing", subject: required });
      }
    }
    return result(
      "fault-matrix",
      findings.length === 0 ? "pass" : "contract_failure",
      [
        {
          id: "oracle-cases",
          status: findings.length === 0 ? "ok" : "failed",
          members: caseIds.size,
        },
        {
          id: "closed-dimension-members",
          status: findings.length === 0 ? "ok" : "failed",
          members: dimensionEvaluation.results.size,
        },
        {
          id: "recovery-race-cells",
          status: findings.length === 0 ? "ok" : "failed",
          members: pairKeys.size,
        },
      ],
      findings,
    );
  } catch {
    return result(
      "fault-matrix",
      "contract_failure",
      [],
      [
        {
          code: "invalid_fault_matrix_manifest",
          subject: "oracles/m0/fault-matrix.json",
        },
      ],
    );
  }
}

export async function checkFanout() {
  const output = await checkTaxonomy();
  return { ...output, subcommand: "fanout" };
}

export function formatAllOutput(output) {
  const gateResults = output?.aggregateResult?.findings;
  const basisCounts = new Map();
  if (Array.isArray(gateResults))
    for (const entry of gateResults)
      basisCounts.set(entry.basis, (basisCounts.get(entry.basis) ?? 0) + 1);
  const issued = validatedBundleResults.get(output);
  const denominator = issued?.denominator;
  const validPass = Boolean(
    issued &&
      issued.digest === canonicalDigest(output) &&
      hasExactFields(output, [
        "schemaVersion",
        "subcommand",
        "scope",
        "executed",
        "kind",
        "aggregateResult",
        "findings",
      ]) &&
      output.schemaVersion === "m0-all-result-v2" &&
      output.subcommand === "all" &&
      output.scope === "advisory-only" &&
      output.executed === true &&
      output.kind === "pass" &&
      hasExactFields(output.aggregateResult, ["primaryKind", "findings"]) &&
      output.aggregateResult.primaryKind === "pass" &&
      Array.isArray(output.findings) &&
      output.findings.length === 0 &&
      Array.isArray(gateResults) &&
      gateResults.length === denominator.aggregateGates &&
      new Set(gateResults.map(({ gateId }) => gateId)).size ===
        denominator.aggregateGates &&
      gateResults.every(
        (entry) =>
          hasExactFields(
            entry,
            entry.basis === "external"
              ? ["gateId", "executed", "kind", "basis", "execution", "findings"]
              : ["gateId", "executed", "kind", "basis", "findings"],
          ) &&
          entry.executed === true &&
          entry.kind === "pass" &&
          Array.isArray(entry.findings) &&
          (entry.basis !== "external" ||
            hasExactFields(entry.execution, [
              "exitStatus",
              "signal",
              "stdoutDigest",
              "stderrDigest",
            ])),
      ) &&
      basisCounts.size === 3 &&
      basisCounts.get("local") === denominator.localGates &&
      basisCounts.get("external") === denominator.externalGates &&
      basisCounts.get("definition") === denominator.definitionGates,
  );
  return validPass ? "M0 advisory: READY\n" : `${JSON.stringify(output)}\n`;
}

export function expectedAggregateGates(authority, cases, matrix, denominator) {
  const scenarioCount = authority.requirements.reduce(
    (total, requirement) => total + requirement.scenarios.length,
    0,
  );
  const dimensionCount = matrix.closedDimensions.reduce(
    (total, dimension) => total + dimension.values.length,
    0,
  );
  if (
    !denominator ||
    authority.requirements.length !== denominator.requirements ||
    scenarioCount !== denominator.scenarios ||
    cases.cases.length !== denominator.scenarios ||
    dimensionCount !== denominator.closedDimensionMembers ||
    matrix.recoveryRaceCells.length !== denominator.recoveryRaceCells ||
    scenarioCount + dimensionCount + matrix.recoveryRaceCells.length !==
      denominator.scenarioDimensionRaceMembers ||
    authority.requirements.length +
      scenarioCount +
      dimensionCount +
      matrix.recoveryRaceCells.length !==
      denominator.definitionGates
  )
    return [];
  const gates = [
    {
      id: "local.prerequisites",
      type: "local-subcommand",
      members: ["subcommand:prerequisites"],
      dependsOn: [],
    },
    {
      id: "local.sources",
      type: "local-subcommand",
      members: ["subcommand:sources"],
      dependsOn: ["local.prerequisites"],
    },
    {
      id: "local.taxonomy",
      type: "local-subcommand",
      members: ["subcommand:taxonomy"],
      dependsOn: ["local.prerequisites"],
    },
    {
      id: "local.safe-errors",
      type: "local-subcommand",
      members: ["subcommand:safe-errors"],
      dependsOn: ["local.taxonomy"],
    },
    {
      id: "local.source-facts",
      type: "local-subcommand",
      members: ["subcommand:source-facts"],
      dependsOn: ["local.prerequisites"],
    },
    {
      id: "local.transactions",
      type: "local-subcommand",
      members: ["subcommand:transactions"],
      dependsOn: ["local.source-facts"],
    },
    {
      id: "local.harness",
      type: "local-subcommand",
      members: ["subcommand:harness"],
      dependsOn: ["local.taxonomy"],
    },
    {
      id: "local.state-machines",
      type: "local-subcommand",
      members: ["subcommand:state-machines"],
      dependsOn: ["local.taxonomy"],
    },
    {
      id: "local.fanout",
      type: "local-subcommand",
      members: ["subcommand:fanout"],
      dependsOn: ["local.taxonomy"],
    },
    {
      id: "local.fault-matrix",
      type: "local-subcommand",
      members: ["subcommand:fault-matrix"],
      dependsOn: [
        "local.sources",
        "local.safe-errors",
        "local.transactions",
        "local.state-machines",
        "local.fanout",
      ],
    },
    {
      id: "local.contracts",
      type: "local-subcommand",
      members: ["subcommand:contracts"],
      dependsOn: [
        "local.sources",
        "local.safe-errors",
        "local.transactions",
        "local.harness",
        "local.state-machines",
        "local.fault-matrix",
      ],
    },
    {
      id: "external.openspec-strict",
      type: "external-validator",
      members: ["external:openspec-strict"],
      dependsOn: ["local.prerequisites"],
    },
  ];
  for (const requirement of authority.requirements) {
    gates.push({
      id: `requirement.${requirement.requirementId}`,
      type: "requirement-definition",
      members: [`requirement:${requirement.requirementId}`],
      dependsOn: ["local.contracts"],
    });
    for (const scenario of requirement.scenarios) {
      gates.push({
        id: `scenario.${scenario.scenarioId.split(".").at(-1)}`,
        type: "scenario-definition",
        members: [`scenario:${scenario.scenarioId}`],
        dependsOn: ["local.contracts"],
      });
    }
  }
  for (const dimension of matrix.closedDimensions)
    for (const value of dimension.values)
      gates.push({
        id: `dimension.${dimension.id}.${sha256(value).slice(0, 12)}`,
        type: "closed-dimension-definition",
        members: [`dimension:${dimension.id}:${value}`],
        dependsOn: ["local.contracts"],
      });
  for (const cell of matrix.recoveryRaceCells)
    gates.push({
      id: cell.requiredGate,
      type: "recovery-race-definition",
      members: [`recovery-race:${cell.caseId}`],
      dependsOn: ["local.fault-matrix", "local.contracts"],
    });
  return gates;
}

export function externalValidatorManifestValid(manifest) {
  return (
    canonicalize(manifest) ===
    canonicalize({
      schemaVersion: "m0-external-validators-v1",
      requirementId: "m0o.reproducibility",
      validators: [
        {
          id: "openspec-strict",
          command: "openspec-cn",
          args: ["validate", "--specs", "--strict", "--json"],
          timeoutMs: 30000,
          success: {
            exitStatus: 0,
            jsonPath: ["summary", "totals", "failed"],
            equals: 0,
          },
          failureKind: "contract_failure",
          spawnFailureKind: "prerequisite_missing",
          timeoutKind: "evidence_failure",
          malformedOutputKind: "invalid_invocation",
          suppressRawSuccessText: true,
        },
      ],
    })
  );
}

export async function checkAll() {
  const invalidAll = (code, subject) => ({
    schemaVersion: "m0-all-result-v2",
    subcommand: "all",
    scope: "advisory-only",
    executed: true,
    kind: "invalid_invocation",
    aggregateResult: {
      primaryKind: "invalid_invocation",
      findings: [
        {
          gateId: "manifest",
          executed: false,
          kind: "invalid_invocation",
          findings: [{ code }],
        },
      ],
    },
    findings: [{ code, subject }],
  });
  try {
    const [
      manifest,
      authority,
      matrix,
      externalManifest,
      cases,
      evaluatorRegistry,
      applicability,
      scenarioExpectations,
      recoveryRaceContracts,
      resultSchema,
    ] = await Promise.all(
      [
        "../oracles/m0/aggregate-gates.json",
        "../oracles/m0/authority-map.json",
        "../oracles/m0/fault-matrix.json",
        "../oracles/m0/external-validators.json",
        "../oracles/m0/cases.json",
        "../oracles/m0/evaluator-registry.json",
        "../oracles/m0/applicability.json",
        "../oracles/m0/scenario-expectations.json",
        "../oracles/m0/recovery-race-contracts.json",
        "../oracles/m0/result-schema.json",
      ].map(async (path) =>
        JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
      ),
    );
    const members = manifest.gates.flatMap(
      ({ members: gateMembers }) => gateMembers,
    );
    const denominator = manifest.frozenDenominator;
    const expectedGates = expectedAggregateGates(
      authority,
      cases,
      matrix,
      denominator,
    );
    const typeCounts = manifest.gates.reduce(
      (counts, gate) => counts.set(gate.type, (counts.get(gate.type) ?? 0) + 1),
      new Map(),
    );
    const expectedTypeCounts = new Map([
      ["local-subcommand", denominator?.localGates],
      ["external-validator", denominator?.externalGates],
      ["requirement-definition", denominator?.requirements],
      ["scenario-definition", denominator?.scenarios],
      ["closed-dimension-definition", denominator?.closedDimensionMembers],
      ["recovery-race-definition", denominator?.recoveryRaceCells],
    ]);
    const definitionGateCount = [...typeCounts]
      .filter(([type]) => type.endsWith("-definition"))
      .reduce((total, [, count]) => total + count, 0);
    if (
      manifest.schemaVersion !== "m0-aggregate-gates-v2" ||
      resultSchema.schemaVersion !== "m0-result-schema-v2" ||
      manifest.scope !== "advisory-only" ||
      resultSchema.scope !== "advisory-only" ||
      evaluatorRegistry.mode !== "definition-only" ||
      evaluatorRegistry.m0ExecutesCandidate !== false ||
      canonicalDigest(applicability) !== EXPECTED_APPLICABILITY_DIGEST ||
      !externalValidatorManifestValid(externalManifest) ||
      canonicalize(manifest.gates) !== canonicalize(expectedGates) ||
      manifest.requiredMemberDigest !== sha256(JSON.stringify(members)) ||
      manifest.gateOrderDigest !==
        sha256(JSON.stringify(manifest.gates.map(({ id }) => id))) ||
      JSON.stringify(manifest.kindPrecedence) !==
        JSON.stringify(resultSchema.kindPrecedence) ||
      JSON.stringify(resultSchema.kindPrecedence) !==
        JSON.stringify(canonicalKindPrecedence) ||
      JSON.stringify(resultSchema.exitCodes) !== JSON.stringify(exitCode) ||
      JSON.stringify(resultSchema.gateResultBases) !==
        JSON.stringify(["local", "external", "definition", "aggregate"]) ||
      canonicalize(resultSchema.gateResultExactFields) !==
        canonicalize({
          local: ["gateId", "executed", "kind", "basis", "findings"],
          external: [
            "gateId",
            "executed",
            "kind",
            "basis",
            "execution",
            "findings",
          ],
          definition: ["gateId", "executed", "kind", "basis", "findings"],
          unexecuted: ["gateId", "executed", "kind", "findings", "blockedBy"],
        }) ||
      canonicalize(resultSchema.externalExecutionFields) !==
        canonicalize([
          "exitStatus",
          "signal",
          "stdoutDigest",
          "stderrDigest",
        ]) ||
      resultSchema.candidateFieldsAllowed !== false ||
      manifest.completePassToken !== "M0 advisory: READY" ||
      resultSchema.completePassToken !== manifest.completePassToken ||
      manifest.gates.length !== denominator?.aggregateGates ||
      definitionGateCount !== denominator?.definitionGates ||
      typeCounts.size !== expectedTypeCounts.size ||
      [...expectedTypeCounts].some(
        ([type, count]) => typeCounts.get(type) !== count,
      )
    )
      return invalidAll(
        "aggregate_manifest_digest_mismatch",
        "aggregate-gates",
      );

    const localExecutors = new Map([
      ["local.prerequisites", checkPrerequisites],
      ["local.sources", checkSources],
      ["local.taxonomy", checkTaxonomy],
      ["local.safe-errors", checkSafeErrors],
      ["local.source-facts", checkSourceFacts],
      ["local.transactions", checkTransactions],
      ["local.harness", checkHarness],
      ["local.state-machines", checkStateMachines],
      ["local.fanout", checkFanout],
      ["local.fault-matrix", checkFaultMatrix],
      ["local.contracts", checkContracts],
    ]);
    const [caseEvaluation, dimensionEvaluation, raceEvaluation] =
      await Promise.all([
        evaluateOracleCases(
          authority,
          cases,
          evaluatorRegistry,
          scenarioExpectations,
        ),
        Promise.resolve(evaluateClosedDimensionDefinitions(authority, matrix)),
        Promise.resolve(
          evaluateRecoveryRaceCells(matrix, recoveryRaceContracts),
        ),
      ]);
    const definitionResults = combineDefinitionResults(
      authority,
      cases,
      matrix,
      caseEvaluation.results,
      dimensionEvaluation.results,
      raceEvaluation.results,
    );
    if (definitionResults.size !== denominator.definitionGates)
      return invalidAll("definition_denominator_incomplete", "definitions");

    const externalDefinitions = new Map(
      externalManifest.validators.map((definition) => [
        `external.${definition.id}`,
        definition,
      ]),
    );
    const completed = new Map();
    const supplied = [];
    for (const gate of manifest.gates) {
      if (
        gate.dependsOn.some(
          (dependency) => completed.get(dependency)?.kind !== "pass",
        )
      )
        continue;
      let gateResult;
      const local = localExecutors.get(gate.id);
      if (local) {
        const output = await local();
        gateResult = {
          gateId: gate.id,
          executed: true,
          kind: output.kind,
          basis: "local",
          findings: output.findings,
        };
      } else if (externalDefinitions.has(gate.id)) {
        gateResult = runExternalValidator(externalDefinitions.get(gate.id));
        gateResult.gateId = gate.id;
        gateResult.basis = "external";
      } else {
        const derived =
          gate.members.length === 1
            ? definitionResults.get(gate.members[0])
            : undefined;
        gateResult = derived
          ? { gateId: gate.id, ...derived }
          : {
              gateId: gate.id,
              executed: true,
              kind: "contract_failure",
              basis: "definition",
              findings: [{ code: "aggregate_member_unresolved" }],
            };
      }
      completed.set(gate.id, gateResult);
      supplied.push(gateResult);
    }
    const aggregateResult = aggregateGateResults(manifest, supplied);
    const output = {
      schemaVersion: "m0-all-result-v2",
      subcommand: "all",
      scope: "advisory-only",
      executed: true,
      kind: aggregateResult.primaryKind,
      aggregateResult,
      findings: aggregateResult.findings
        .filter(({ kind }) => kind !== "pass")
        .flatMap(({ gateId, findings }) =>
          findings.map((finding) => ({ ...finding, gateId })),
        ),
    };
    const frozen = deepFreeze(output);
    validatedBundleResults.set(frozen, {
      digest: canonicalDigest(frozen),
      denominator: structuredClone(denominator),
    });
    return frozen;
  } catch {
    return invalidAll("aggregate_input_invalid", "all");
  }
}

const handlers = {
  prerequisites: checkPrerequisites,
  sources: checkSources,
  taxonomy: checkTaxonomy,
  "safe-errors": checkSafeErrors,
  "source-facts": checkSourceFacts,
  transactions: checkTransactions,
  harness: checkHarness,
  "state-machines": checkStateMachines,
  contracts: checkContracts,
  "fault-matrix": checkFaultMatrix,
  fanout: checkFanout,
  all: checkAll,
};

async function main() {
  const requested = process.argv.slice(2);
  if (
    requested.length === 0 ||
    requested.some((subcommand) => !handlers[subcommand]) ||
    (requested.includes("all") && requested.length !== 1)
  ) {
    const subject =
      requested.find((subcommand) => !handlers[subcommand]) ?? "missing";
    const output = result(
      requested.join(" "),
      "invalid_invocation",
      [],
      [{ code: "unknown_or_malformed_subcommand", subject }],
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = exitCode[output.kind];
    return;
  }
  const outputs = [];
  for (const subcommand of requested)
    outputs.push(await handlers[subcommand]());
  let output = outputs[0];
  if (outputs.length > 1) {
    const precedence = [
      "pass",
      "evidence_failure",
      "contract_failure",
      "missing_source",
      "prerequisite_missing",
      "invalid_invocation",
    ];
    const kind = outputs.reduce(
      (selected, candidate) =>
        precedence.indexOf(candidate.kind) > precedence.indexOf(selected)
          ? candidate.kind
          : selected,
      "pass",
    );
    output = result(
      "batch",
      kind,
      outputs.map((entry) => ({
        id: entry.subcommand,
        status: entry.kind === "pass" ? "ok" : "failed",
        kind: entry.kind,
      })),
      outputs.flatMap((entry) =>
        entry.findings.map((finding) => ({
          ...finding,
          subcommand: entry.subcommand,
        })),
      ),
    );
  }
  process.stdout.write(
    output.subcommand === "all"
      ? formatAllOutput(output)
      : `${JSON.stringify(output)}\n`,
  );
  process.exitCode = exitCode[output.kind];
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    const output = result(
      "main",
      "invalid_invocation",
      [],
      [{ code: "validator_main_failed", subject: "validate-m0" }],
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = exitCode[output.kind];
  });
