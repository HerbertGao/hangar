import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schemaUrl = new URL(
  "../../contracts/v2/storage/schema.sql",
  import.meta.url,
);
export const digest = (character) => character.repeat(64);

export function sqlite(
  databasePath,
  sql,
  { json = false, allowFailure = false } = {},
) {
  const args = ["-batch", "-bail"];
  if (json) args.push("-json");
  args.push(databasePath);
  const result = spawnSync("sqlite3", args, {
    input: `PRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || "sqlite_failure");
  }
  return result;
}

export function query(databasePath, sql) {
  const output = sqlite(databasePath, sql, { json: true }).stdout.trim();
  return output ? JSON.parse(output) : [];
}

export async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), "hangar-v2-storage-"));
  const databasePath = join(directory, "control.sqlite");
  try {
    sqlite(databasePath, await readFile(schemaUrl, "utf8"));
    return await callback(databasePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function seedRecoverySql({ twoAgents = false } = {}) {
  return `
BEGIN;
INSERT INTO storage_identity VALUES (1, 'database-1', 'target-1', 'recovery-only');
INSERT INTO control_instance_ids VALUES ('source-1', 'database-1', 'historical');
INSERT INTO control_instance_ids VALUES ('target-1', 'database-1', 'active');
INSERT INTO control_instances VALUES ('target-1', 'database-1', 'recovery-target', 'quarantined', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO source_facts VALUES (1, 'database-1', '${digest("0")}', '${digest("a")}', 'database-genesis', 'v1', '{}', '${digest("1")}');
INSERT INTO commands VALUES ('command-init', 'actor-1', 'restore-init', 'restore-target-1', 'key-1', 'control-command-v1', 'canonical-json-v1', 'sha256', '${digest("1")}', '${digest("2")}', '${digest("3")}', '${digest("4")}', 'completed', '{}', 'session-1', 'target-1', '${digest("5")}', '${digest("6")}');
INSERT INTO recovery_sessions VALUES ('session-1', 1, 'database-1', 'source-1', '${digest("5")}', '${digest("6")}', 'target-1', 'target-1', 'initialized', 'command-init');
INSERT INTO agents VALUES ('agent-1');
INSERT INTO agent_releases VALUES ('${digest("b")}', 'agent-1', '{}', '${digest("c")}');
INSERT INTO activations VALUES ('activation-1', 'agent-1', '${digest("b")}', 1, 'quarantined', NULL);
INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-1', 0, 'target-1', 'activation-1', '${digest("b")}', 'enumerating', 2);
INSERT INTO recovery_agent_attempts VALUES ('recovery-attempt-1', 'session-1', 'agent-1', 0, 'executing', 1);
${
  twoAgents
    ? `INSERT INTO agents VALUES ('agent-2');
INSERT INTO agent_releases VALUES ('${digest("d")}', 'agent-2', '{}', '${digest("e")}');
INSERT INTO activations VALUES ('activation-2', 'agent-2', '${digest("d")}', 1, 'quarantined', NULL);
INSERT INTO recovery_qualifications VALUES ('session-1', 'agent-2', 0, 'target-1', 'activation-2', '${digest("d")}', 'enumerating', 3);
INSERT INTO recovery_agent_attempts VALUES ('recovery-attempt-2', 'session-1', 'agent-2', 0, 'executing', 1);`
    : ""
}
COMMIT;`;
}

export function seedRunSql() {
  return `
BEGIN;
INSERT INTO storage_identity VALUES (1, 'database-1', 'instance-1', 'enabled');
INSERT INTO control_instance_ids VALUES ('instance-1', 'database-1', 'active');
INSERT INTO control_instances VALUES ('instance-1', 'database-1', 'genesis', 'writable', 'boot-1', 'cycle-1', NULL, NULL, NULL, NULL);
INSERT INTO source_facts VALUES (1, 'database-1', '${digest("0")}', '${digest("a")}', 'database-genesis', 'v1', '{}', '${digest("1")}');
INSERT INTO agents VALUES ('agent-1');
INSERT INTO agent_releases VALUES ('${digest("2")}', 'agent-1', '{}', '${digest("3")}');
INSERT INTO activations VALUES ('activation-1', 'agent-1', '${digest("2")}', 1, 'active', 1);
INSERT INTO runs VALUES ('run-1', 'agent-1', '${digest("2")}', 'activation-1', 1, 'manual', 'manual-1', '${digest("4")}', '${digest("5")}', '${digest("6")}');
INSERT INTO source_facts VALUES (2, 'database-1', '${digest("a")}', '${digest("b")}', 'run-admitted', 'v1', '{}', '${digest("6")}');
INSERT INTO run_events VALUES ('run-1', 1, 2, 'run.admitted');
INSERT INTO run_attempts VALUES ('run-1', 0, 'session-0', 'running', '${digest("7")}', 10000, NULL);
COMMIT;`;
}
