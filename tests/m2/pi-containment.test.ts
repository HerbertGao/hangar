import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PI_CHILD_QUALIFICATION,
  PiChildLauncher,
  buildIsolatedChildEnvironment,
} from "../../packages/pi-harness/launcher.ts";
import { createIsolatedPiSession } from "../../packages/pi-harness/sdk-session.ts";
import { VirtualCorpus } from "../../packages/pi-harness/virtual-corpus.ts";

const hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const childPath = fileURLToPath(
  new URL("../../apps/pi-sdk-child/child.ts", import.meta.url),
);

test("virtual corpus is immutable/bounded and host paths are not expressible", () => {
  const bytes = Buffer.from("alpha sentinel-free text");
  const corpus = new VirtualCorpus([
    {
      relativePath: "docs/a.txt",
      kind: "regular",
      bytes,
      digest: hex(bytes),
    },
  ]);
  assert.deepEqual(corpus.list(), { ok: true, value: ["docs/a.txt"] });
  assert.equal(corpus.read("/etc/passwd").ok, false);
  assert.equal(corpus.read("../secret").ok, false);
  assert.equal(corpus.read("docs/../../secret").ok, false);
  assert.equal(corpus.read("host-random-sentinel").ok, false);
  assert.equal(corpus.search("alpha").ok, true);
  assert.throws(
    () =>
      new VirtualCorpus([
        {
          relativePath: "link",
          kind: "symlink",
          bytes,
          digest: hex(bytes),
        } as never,
      ]),
    /invalid_virtual_corpus/,
  );
  assert.throws(
    () =>
      new VirtualCorpus([
        {
          relativePath: "docs/a.txt",
          kind: "regular",
          bytes,
          digest: "0".repeat(64),
        },
      ]),
    /invalid_virtual_corpus/,
  );
});

test("virtual tool/session modules import no filesystem and expose only three tools", async () => {
  for (const path of [
    fileURLToPath(
      new URL("../../packages/pi-harness/virtual-corpus.ts", import.meta.url),
    ),
    fileURLToPath(
      new URL("../../packages/pi-harness/sdk-session.ts", import.meta.url),
    ),
  ]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:fs/);
    assert.doesNotMatch(
      source,
      /createReadTool|createBashTool|createEditTool|createWriteTool/,
    );
  }
  const { session, qualification } = await createIsolatedPiSession(
    new VirtualCorpus([]),
  );
  try {
    assert.deepEqual(qualification, PI_CHILD_QUALIFICATION);
    assert.deepEqual(session.agent.state.tools.map(({ name }) => name).sort(), [
      "virtual_list",
      "virtual_read",
      "virtual_search",
    ]);
    assert.equal(session.sessionFile, undefined);
  } finally {
    session.dispose();
  }
});

test("child environment contains one provider credential and no ambient authority", () => {
  const env = buildIsolatedChildEnvironment({
    environmentVariable: "OPENAI_API_KEY",
    value: "provider-canary",
  });
  assert.equal(env.OPENAI_API_KEY, "provider-canary");
  for (const forbidden of [
    "HOME",
    "PATH",
    "ANTHROPIC_API_KEY",
    "HANGAR_GATEWAY_CREDENTIAL",
    "HANGAR_CONTROL_DB",
    "PI_SESSION_FILE",
    "NODE_OPTIONS",
  ])
    assert.equal(forbidden in env, false, forbidden);
  assert.deepEqual(Object.keys(env).sort(), [
    "HANGAR_PI_CHILD",
    "OPENAI_API_KEY",
    "PI_CODING_AGENT_DIR",
    "PI_OFFLINE",
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
  ]);
});

test("real SDK child proves qualification and whole process group reaps", async () => {
  const launcher = new PiChildLauncher(childPath, {
    environmentVariable: "OPENAI_API_KEY",
    value: "provider-secret-canary",
  });
  assert.deepEqual(await launcher.launch(15_000), PI_CHILD_QUALIFICATION);
  const pid = launcher.pid!;
  assert.ok(pid > 1);
  const reaped = await launcher.reap();
  assert.deepEqual(reaped, {
    wholeTreeReaped: true,
    grantRevoked: true,
    stdoutDrained: true,
    stderrDrained: true,
  });
  assert.equal(launcher.state, "terminal(cancelled)");
  const diagnostics = launcher.diagnostics();
  if (diagnostics.stdout.ok)
    assert.equal(
      diagnostics.stdout.value.summary.includes("provider-secret-canary"),
      false,
    );
  if (diagnostics.stderr.ok)
    assert.equal(
      diagnostics.stderr.value.summary.includes("provider-secret-canary"),
      false,
    );
  assert.throws(() => process.kill(pid, 0));
});

test("parent death closes IPC and leaves no orphan child", async () => {
  const launcherUrl = new URL(
    "../../packages/pi-harness/launcher.ts",
    import.meta.url,
  ).href;
  const script = `
    import { PiChildLauncher } from ${JSON.stringify(launcherUrl)};
    const launcher = new PiChildLauncher(${JSON.stringify(childPath)}, {
      environmentVariable: "OPENAI_API_KEY",
      value: "parent-death-canary"
    });
    await launcher.launch(15000);
    console.log(launcher.pid);
    process.exit(0);
  `;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  parent.stdout!.on("data", (chunk: Uint8Array) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  await once(parent, "exit");
  const pid = Number(output.trim().split("\n").at(-1));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, output);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `orphan child pid=${pid}`);
});
