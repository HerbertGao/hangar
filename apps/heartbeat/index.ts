import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  digestJson,
  fail,
  ok,
  type AttemptToken,
  type ErrorKind,
  type ExecutionClosure,
  type HarnessInput,
  type ProcessIdentity,
  type Result,
} from "../../packages/contracts/index.ts";
import {
  type Control,
  commandMeta,
  createTrustedProcessController,
  type HarnessSession,
  type OutcomeAcceptor,
  type OutcomeGate,
} from "../../packages/control-core/index.ts";
import { readHeartbeatArtifact } from "./tool.ts";

export type HarnessMode = "fake" | "legacy-process" | "fail";

export interface HarnessExecution {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostQualification {
  readonly status: "unverified-claim";
  readonly productionEligible: false;
  readonly reason: "process-group-allows-setsid-escape";
}

export interface ContainedTree {
  readonly identity: ProcessIdentity;
  readonly leafPid: number;
  readonly settled: Promise<Result<HarnessExecution>>;
  reap(): Promise<Result<HarnessExecution>>;
}

const appPath = (file: string): string =>
  join(process.cwd(), "apps/heartbeat", file);
const childPath = (): string => appPath("child.ts");
const digestCache = new Map<string, { fingerprint: string; digest: string }>();
const fileDigest = (path: string): string => {
  const stat = statSync(path, { bigint: true });
  // SAFETY: Node 22 BigIntStats always carries size/mtimeNs at runtime; some
  // hoisted @types/node resolutions narrow the bigint overload, so pin the
  // observed shape without changing behavior.
  const fp = stat as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  };
  const fingerprint = `${fp.dev}:${fp.ino}:${fp.size}:${fp.mtimeNs}`;
  const cached = digestCache.get(path);
  if (cached?.fingerprint === fingerprint) return cached.digest;
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  digestCache.set(path, { fingerprint, digest });
  return digest;
};

export function heartbeatExecutionClosure(): ExecutionClosure {
  return {
    entryId: "heartbeat-child",
    executable: process.execPath,
    executableDigest: fileDigest(process.execPath),
    members: [
      { id: "heartbeat-adapter", digest: fileDigest(appPath("index.ts")) },
      { id: "heartbeat-child", digest: fileDigest(childPath()) },
      { id: "heartbeat-tool", digest: fileDigest(appPath("tool.ts")) },
    ],
  };
}

export const heartbeatOutcomeGate: OutcomeGate = ({
  release,
  artifactDigest,
  toolObservations,
}) =>
  release.spec.capabilities.includes("tool.read") &&
  artifactDigest === readHeartbeatArtifact() &&
  toolObservations.some(
    (observation) =>
      observation.toolId === "tool.read" &&
      observation.outputDigest === artifactDigest,
  );

const errorCode = (error: unknown): string | undefined => {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

function startFingerprint(pid: number): string {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout?.trim()
    ? result.stdout.trim()
    : `unverified:${pid}`;
}

function signalGroup(processGroupId: number, signal: string | number): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (["ESRCH", "EPERM"].includes(errorCode(error) ?? "")) return false;
    throw error;
  }
}

function signalPid(pid: number, signal: string | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

async function reapProcessGroup(
  processGroupId: number,
  knownPids: readonly number[],
): Promise<void> {
  const groupSignaled = signalGroup(processGroupId, "SIGTERM");
  if (!groupSignaled) for (const pid of knownPids) signalPid(pid, "SIGTERM");
  const survivors = () =>
    processGroupExists(processGroupId) || knownPids.some(pidExists);
  const graceDeadline = Date.now() + 100;
  while (survivors() && Date.now() < graceDeadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  if (survivors()) {
    const groupKilled = signalGroup(processGroupId, "SIGKILL");
    if (!groupKilled) for (const pid of knownPids) signalPid(pid, "SIGKILL");
  }
  const deadline = Date.now() + 2_000;
  while (survivors()) {
    if (Date.now() >= deadline) throw new Error("containment_reap_timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function collect(child: ChildProcess): {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exit: Promise<{ exitCode: number; signal: string | null }>;
} {
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  child.stdout?.on("data", (chunk) => {
    stdout += stdoutDecoder.decode(chunk, { stream: true });
  });
  child.stderr?.on("data", (chunk) => {
    stderr += stderrDecoder.decode(chunk, { stream: true });
  });
  const exit = new Promise<{ exitCode: number; signal: string | null }>(
    (resolve) => {
      let resolved = false;
      const finish = (exitCode: number, signal: string | null) => {
        if (resolved) return;
        resolved = true;
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
        resolve({ exitCode, signal });
      };
      child.on("close", (code, signal) =>
        finish(
          typeof code === "number" ? code : 1,
          typeof signal === "string" ? signal : null,
        ),
      );
      child.on("error", () => finish(1, null));
    },
  );
  return { stdout: () => stdout, stderr: () => stderr, exit };
}

function command(
  token: AttemptToken,
  kind: string,
  suffix: string,
  input: unknown,
) {
  return commandMeta(
    "heartbeat-adapter",
    kind,
    token.runId,
    `${token.sessionId}:${suffix}`,
    input,
    token,
  );
}

function decodeHarnessOutput(
  mode: "fake" | "legacy-process",
  stdout: string,
  inputDigest: string,
  actionId: string,
  grantGeneration: number,
): HarnessInput[] {
  const artifactDigest = readHeartbeatArtifact();
  const mapped: HarnessInput[] = [
    {
      type: "action",
      action: { actionId, kind: "tool", inputDigest },
    },
    {
      type: "tool-observation",
      observation: {
        actionId,
        toolId: "tool.read",
        outputDigest: artifactDigest,
        grantGeneration,
      },
    },
    {
      type: "outcome-proposal",
      proposal: { artifactDigest },
    },
  ];
  if (mode === "legacy-process") {
    const match = stdout.match(/^HEARTBEAT ([0-9a-f]{64}) ([0-9a-f]{64})\n$/);
    if (!match || match[1] !== inputDigest || match[2] !== artifactDigest)
      throw new Error("invalid_legacy_output");
    return mapped;
  }
  const lines = stdout.trim().split("\n");
  if (lines.length !== 3) throw new Error("invalid_fake_output");
  let action: unknown;
  let observation: unknown;
  let proposal: unknown;
  try {
    action = JSON.parse(lines[0]);
    observation = JSON.parse(lines[1]);
    proposal = JSON.parse(lines[2]);
  } catch {
    throw new Error("invalid_fake_output");
  }
  if (
    !action ||
    typeof action !== "object" ||
    Object.keys(action).sort().join(",") !== "actionId,inputDigest,type" ||
    (action as { type?: unknown }).type !== "action" ||
    (action as { actionId?: unknown }).actionId !== "heartbeat-action" ||
    (action as { inputDigest?: unknown }).inputDigest !== inputDigest ||
    !observation ||
    typeof observation !== "object" ||
    Object.keys(observation).sort().join(",") !==
      "actionId,outputDigest,toolId,type" ||
    (observation as { type?: unknown }).type !== "tool-observation" ||
    (observation as { actionId?: unknown }).actionId !== "heartbeat-action" ||
    (observation as { toolId?: unknown }).toolId !== "tool.read" ||
    (observation as { outputDigest?: unknown }).outputDigest !==
      artifactDigest ||
    !proposal ||
    typeof proposal !== "object" ||
    Object.keys(proposal).sort().join(",") !== "artifactDigest,type" ||
    (proposal as { type?: unknown }).type !== "outcome-proposal" ||
    (proposal as { artifactDigest?: unknown }).artifactDigest !== artifactDigest
  )
    throw new Error("invalid_fake_output");
  return mapped;
}

function authorizeRelease(
  control: Control,
  token: AttemptToken,
  mode: HarnessMode | "tree",
): Result<null> {
  const release = control.authorizeLaunch(token);
  if (!release.ok) return release;
  const expectedHarness = mode === "legacy-process" ? "legacy-process" : "fake";
  try {
    return release.value.spec.harnessKind === expectedHarness &&
      digestJson(release.value.closure) ===
        digestJson(heartbeatExecutionClosure())
      ? ok(null)
      : fail("invalid_input");
  } catch {
    return fail("invalid_state");
  }
}

function start(
  mode: string,
  inputDigest: string,
): {
  child: ChildProcess;
  identity: ProcessIdentity;
  output: ReturnType<typeof collect>;
} {
  const child = spawn(process.execPath, [childPath(), mode, inputDigest], {
    detached: true,
    cwd: process.cwd(),
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("spawn_failed");
  const identity: ProcessIdentity = {
    pid: child.pid,
    processGroupId: child.pid,
    startFingerprint: startFingerprint(child.pid),
    containmentGeneration: 1,
  };
  return { child, identity, output: collect(child) };
}

function submit(
  session: HarnessSession,
  token: AttemptToken,
  input: HarnessInput,
): Result<null> {
  if (input.type === "action")
    return session.submit(
      command(
        token,
        "register-action",
        `action:${input.action.actionId}`,
        input,
      ),
      input,
    );
  if (input.type === "tool-observation")
    return session.submit(
      command(
        token,
        "tool-observation",
        `tool:${input.observation.actionId}`,
        input,
      ),
      input,
    );
  if (input.type === "outcome-proposal")
    return session.submit(
      command(token, "outcome-proposal", "outcome", input),
      input,
    );
  return fail("invalid_input");
}

async function finishProcess(
  control: Control,
  token: AttemptToken,
  identity: ProcessIdentity,
  output: ReturnType<typeof collect>,
  knownPids: readonly number[],
  exitOverride?: number,
): Promise<Result<HarnessExecution>> {
  try {
    await reapProcessGroup(identity.processGroupId, knownPids);
  } catch {
    return fail("invalid_state");
  }
  const exited = await output.exit;
  const exitCode = exitOverride ?? exited.exitCode;
  const processOwner = createTrustedProcessController(control);
  let firstError: ErrorKind | undefined;
  const current = control.snapshot(token.runId);
  if (!current.ok) return current;
  if (current.value.attemptState === "running") {
    const settled = processOwner.technicalExit(
      command(token, "technical-exit", "technical-exit", {
        exitCode,
      }),
      token,
      exitCode,
    );
    if (!settled.ok) firstError = settled.error;
  }
  const reaped = processOwner.reaped(
    command(token, "reap-containment", "reap", {
      factKind: "containment-reaped",
    }),
    token,
  );
  if (!reaped.ok && !firstError) firstError = reaped.error;
  const revoked = processOwner.revoke(
    command(token, "revoke-grant", "revoke", {
      factKind: "grant-revoked",
    }),
    token,
  );
  if (!revoked.ok && !firstError) firstError = revoked.error;
  if (firstError) return fail(firstError);
  return ok({
    exitCode,
    signal: exited.signal,
    stdout: output.stdout(),
    stderr: output.stderr(),
  });
}

export async function executeHeartbeat(
  control: Control,
  outcomes: OutcomeAcceptor,
  token: AttemptToken,
  mode: HarnessMode,
  inputDigest: string,
): Promise<Result<HarnessExecution>> {
  const authorization = authorizeRelease(control, token, mode);
  if (!authorization.ok) return authorization;
  let started: ReturnType<typeof start>;
  try {
    started = start(mode, inputDigest);
  } catch {
    return fail("invalid_state");
  }
  const { child, identity, output } = started;
  const processOwner = createTrustedProcessController(control);
  const registered = processOwner.register(
    command(token, "register-process", "process", identity),
    token,
    identity,
  );
  if (!registered.ok) {
    await reapProcessGroup(identity.processGroupId, [identity.pid]);
    return registered;
  }
  child.stdin?.write("GO\n");
  child.stdin?.end();
  const exited = await output.exit;
  let protocolExit = exited.exitCode;
  let protocolInvalid = false;
  let proposalDigest: string | undefined;
  if (mode !== "fail") {
    try {
      for (const input of decodeHarnessOutput(
        mode,
        output.stdout(),
        inputDigest,
        `heartbeat-action:${token.attempt}`,
        token.generation,
      )) {
        const submitted = submit(control.harness(token), token, input);
        if (!submitted.ok) {
          protocolExit = 1;
          protocolInvalid = true;
          break;
        }
        if (input.type === "outcome-proposal")
          proposalDigest = input.proposal.artifactDigest;
      }
      if (!protocolInvalid && proposalDigest) {
        const accepted = outcomes.accept(
          command(token, "accept-outcome", "accept-outcome", {
            runId: token.runId,
            attempt: token.attempt,
            artifactDigest: proposalDigest,
          }),
          {
            runId: token.runId,
            attempt: token.attempt,
            artifactDigest: proposalDigest,
          },
        );
        if (!accepted.ok) {
          protocolExit = 1;
          protocolInvalid = true;
        }
      }
    } catch {
      protocolExit = 1;
      protocolInvalid = true;
    }
  }
  const finished = await finishProcess(
    control,
    token,
    identity,
    output,
    [identity.pid],
    protocolExit,
  );
  if (!finished.ok) return finished;
  return protocolInvalid ? fail("invalid_input") : finished;
}

export async function launchContainedTree(
  control: Control,
  token: AttemptToken,
): Promise<Result<ContainedTree>> {
  const authorization = authorizeRelease(control, token, "tree");
  if (!authorization.ok) return authorization;
  let started: ReturnType<typeof start>;
  try {
    started = start("tree", "");
  } catch {
    return fail("invalid_state");
  }
  const { child, identity, output } = started;
  const processOwner = createTrustedProcessController(control);
  const registered = processOwner.register(
    command(token, "register-process", "process", identity),
    token,
    identity,
  );
  if (!registered.ok) {
    await reapProcessGroup(identity.processGroupId, [identity.pid]);
    return registered;
  }
  child.stdin?.write("GO\n");
  child.stdin?.end();
  const cleanupFailure = async (error: ErrorKind) => {
    const cleaned = await finishProcess(
      control,
      token,
      identity,
      output,
      [identity.pid],
      1,
    );
    return cleaned.ok ? fail<ContainedTree>(error) : cleaned;
  };
  const deadline = Date.now() + 2_000;
  let leafPid: number | undefined;
  while (leafPid === undefined && Date.now() < deadline) {
    const line = output.stdout().split("\n")[0];
    if (line) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { type?: unknown }).type === "tree" &&
          typeof (parsed as { leafPid?: unknown }).leafPid === "number"
        )
          leafPid = (parsed as { leafPid: number }).leafPid;
        else return cleanupFailure("invalid_input");
      } catch {
        return cleanupFailure("invalid_input");
      }
    }
    if (leafPid === undefined)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (leafPid === undefined) return cleanupFailure("invalid_state");

  let cleanup: Promise<Result<HarnessExecution>> | undefined;
  const settle = (exitCode: number) => {
    cleanup ??= finishProcess(
      control,
      token,
      identity,
      output,
      [identity.pid, leafPid],
      exitCode,
    );
    return cleanup;
  };
  const settled = output.exit.then(({ exitCode }) =>
    settle(exitCode === 0 ? 1 : exitCode),
  );
  return ok({
    identity,
    leafPid,
    settled,
    reap: () => settle(1),
  });
}

export const hostQualification = (): HostQualification => ({
  status: "unverified-claim",
  productionEligible: false,
  reason: "process-group-allows-setsid-escape",
});
