import { spawn, type ChildProcess } from "node:child_process";

import {
  DiagnosticDrain,
  PiChildProtocolMachine,
  type ParentToChildMessage,
} from "../pi-child-protocol/index.ts";
import type { PiIsolationQualification } from "./sdk-session.ts";

export interface ProviderCredential {
  readonly environmentVariable:
    | "OPENAI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "GEMINI_API_KEY";
  readonly value: string;
}

export function buildIsolatedChildEnvironment(
  credential: ProviderCredential,
): Readonly<Record<string, string>> {
  if (credential.value.length === 0)
    throw new TypeError("empty_provider_credential");
  return Object.freeze({
    PI_CODING_AGENT_DIR: "/hangar/empty-agent",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    HANGAR_PI_CHILD: "1",
    [credential.environmentVariable]: credential.value,
  });
}

export const PI_CHILD_QUALIFICATION: PiIsolationQualification = {
  qualification: "fixture-readonly-reference",
  sdkVersion: "0.84.2",
  tools: ["virtual_list", "virtual_read", "virtual_search"],
  globalResources: 0,
  projectResources: 0,
  slashCommands: 0,
  persistentSession: false,
  liveWorkspaceEligible: false,
  productionEligible: false,
  mutationCapable: false,
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PiChildLauncher {
  readonly #childPath: string;
  readonly #credential: ProviderCredential;
  readonly #machine = new PiChildProtocolMachine();
  readonly #stdout: DiagnosticDrain;
  readonly #stderr: DiagnosticDrain;
  #child?: ChildProcess;
  #exit?: Promise<void>;
  #stdoutClosed = false;
  #stderrClosed = false;

  constructor(childPath: string, credential: ProviderCredential) {
    this.#childPath = childPath;
    this.#credential = credential;
    this.#stdout = new DiagnosticDrain([credential.value]);
    this.#stderr = new DiagnosticDrain([credential.value]);
  }

  get state() {
    return this.#machine.state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async launch(timeoutMs = 10_000): Promise<typeof PI_CHILD_QUALIFICATION> {
    if (this.#child) throw new Error("child_already_launched");
    const child = spawn(process.execPath, [this.#childPath], {
      cwd: "/",
      detached: true,
      env: buildIsolatedChildEnvironment(this.#credential),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#child = child;
    child.stdout?.on("data", (chunk: Uint8Array) => {
      if (!this.#stdout.append(chunk)) void this.reap();
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (!this.#stderr.append(chunk)) void this.reap();
    });
    child.stdout?.on("close", () => {
      this.#stdoutClosed = true;
    });
    child.stderr?.on("close", () => {
      this.#stderrClosed = true;
    });
    this.#exit = new Promise((resolve) => {
      child.on("exit", () => {
        this.#machine.processExitOrFault(false);
        resolve();
      });
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.reap();
        reject(new Error("pi_child_ready_timeout"));
      }, timeoutMs);
      child.on("message", (message: unknown) => {
        const result = this.#machine.childFrame(message);
        if (result.ok && result.state === "ready") {
          clearTimeout(timer);
          resolve(PI_CHILD_QUALIFICATION);
        } else if (!result.ok) {
          clearTimeout(timer);
          void this.reap();
          reject(new Error(result.error));
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        if (this.#machine.state !== "ready") {
          clearTimeout(timer);
          reject(new Error(`pi_child_exited_before_ready:${code}`));
        }
      });
    });
  }

  send(message: ParentToChildMessage): void {
    if (!this.#child?.connected) throw new Error("pi_child_not_connected");
    this.#child.send(message);
  }

  async reap(graceMs = 500): Promise<{
    readonly wholeTreeReaped: boolean;
    readonly grantRevoked: true;
    readonly stdoutDrained: boolean;
    readonly stderrDrained: boolean;
  }> {
    const child = this.#child;
    if (!child?.pid)
      return {
        wholeTreeReaped: true,
        grantRevoked: true,
        stdoutDrained: true,
        stderrDrained: true,
      };
    this.#machine.cancel();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([this.#exit ?? Promise.resolve(), wait(graceMs)]);
    if (this.#processGroupExists(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await (this.#exit ?? Promise.resolve());
    }
    for (
      let tries = 0;
      tries < 100 && (!this.#stdoutClosed || !this.#stderrClosed);
      tries += 1
    )
      await wait(5);
    const reaped = !this.#processGroupExists(child.pid);
    this.#machine.closeIpc();
    this.#machine.cleanupComplete({
      ipcDrained: true,
      stdoutDrained: this.#stdoutClosed,
      stderrDrained: this.#stderrClosed,
      wholeTreeReaped: reaped,
      grantRevoked: true,
      durableCancelRequested: true,
      outcomeAccepted: false,
    });
    return {
      wholeTreeReaped: reaped,
      grantRevoked: true,
      stdoutDrained: this.#stdoutClosed,
      stderrDrained: this.#stderrClosed,
    };
  }

  diagnostics() {
    return { stdout: this.#stdout.close(), stderr: this.#stderr.close() };
  }

  #processGroupExists(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
