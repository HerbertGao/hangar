import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "./scenario-owner.mjs";

const processUrl = new URL(
  "../../contracts/v2/runtime/process-lifecycle.json",
  import.meta.url,
);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function processGroup(pid) {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

async function runProcessGroupProbe() {
  if (process.platform === "win32") {
    return {
      executed: true,
      status: "unsupported",
      reason: "no-posix-process-group",
    };
  }
  const childProgram = `
    const { spawn } = require("node:child_process");
    const sleeper = "setInterval(() => {}, 1000)";
    const contained = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore" });
    const escaped = spawn(process.execPath, ["-e", sleeper], { detached: true, stdio: "ignore" });
    escaped.unref();
    process.stdout.write(JSON.stringify({ rootPid: process.pid, containedPid: contained.pid, escapedPid: escaped.pid }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const root = spawn(process.execPath, ["-e", childProgram], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let escapedPid;
  try {
    const pids = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("probe_timeout")),
        2_000,
      );
      let stdout = "";
      root.stdout.setEncoding("utf8");
      root.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timeout);
          resolve(JSON.parse(stdout.slice(0, newline)));
        }
      });
      root.once("error", reject);
    });
    escapedPid = pids.escapedPid;
    const rootGroup = processGroup(pids.rootPid);
    const containedGroup = processGroup(pids.containedPid);
    const escapedGroup = processGroup(pids.escapedPid);
    process.kill(-root.pid, "SIGKILL");
    const groupReaped = await waitUntil(
      () => !alive(pids.rootPid) && !alive(pids.containedPid),
    );
    const escapedAfterGroupReap = alive(pids.escapedPid);
    return {
      executed: true,
      status: "unverified-claim",
      descendantMembershipEnforced:
        rootGroup === root.pid && containedGroup === rootGroup,
      descendantEscapePrevented: !escapedAfterGroupReap,
      allMembersEnumerable: escapedGroup === rootGroup,
      hardReapWholeTree: groupReaped && !escapedAfterGroupReap,
    };
  } finally {
    if (alive(root.pid)) {
      try {
        process.kill(-root.pid, "SIGKILL");
      } catch {}
    }
    if (escapedPid && alive(escapedPid)) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {}
    }
  }
}

function qualifies(manifest, observation) {
  return (
    observation.executed === true &&
    observation.status === manifest.qualification.requiredStatus &&
    manifest.qualification.requiredObservations.every(
      (field) => observation[field] === true,
    )
  );
}

test.scenarios(
  [
    "m0o.process-fixture.case-ac1ff343c450afd0"
  ],
  "local process-group probe executes and cannot claim whole-tree qualification", async () => {
  const manifest = JSON.parse(await readFile(processUrl, "utf8"));
  const observation = await runProcessGroupProbe();
  assert.equal(observation.executed, true);
  assert.equal(qualifies(manifest, observation), false);
  assert.equal(manifest.qualification.selfReportedEvidenceAccepted, false);
  assert.ok(
    manifest.qualificationProfiles.every(
      ({ productionEligible }) => productionEligible === false,
    ),
  );
  if (process.platform !== "win32") {
    assert.equal(observation.status, "unverified-claim");
    assert.equal(observation.descendantEscapePrevented, false);
    assert.equal(observation.hardReapWholeTree, false);
  }
});

test.scenarios(
  [
    "v2c.process-lifecycle.case-15d245ccca1f060a"
  ],
  "direct-child-only evidence never obtains production qualification", async () => {
  const manifest = JSON.parse(await readFile(processUrl, "utf8"));
  assert.equal(
    qualifies(manifest, {
      executed: true,
      status: "verified",
      descendantMembershipEnforced: true,
      descendantEscapePrevented: false,
      allMembersEnumerable: false,
      hardReapWholeTree: false,
    }),
    false,
  );
  assert.equal(manifest.containment.directChildOnlySufficient, false);
});

test("hard-reap transitions target the whole containment rather than only the root PID", async () => {
  const manifest = JSON.parse(await readFile(processUrl, "utf8"));
  for (const state of manifest.states.filter(
    (state) => !["reaped", "failed-before-entry"].includes(state),
  )) {
    const outcome = manifest.table.find(
      (entry) => entry.state === state && entry.event === "hard-reap",
    ).outcome;
    assert.equal(outcome.nextState, "reaped");
    assert.equal(outcome.scope, "whole-containment");
  }
});
