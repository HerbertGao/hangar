#!/usr/bin/env node
// M2 burn ledger genesis one-shot — task 0.1 of implement-m2-pi-control-slice.
//
// Single-purpose: atomically create ledger/m2-burn-ledger.json with exactly
// one canonical genesis record (kind=planning-backfill) plus its evidence file.
// Refuses to run twice. Node stdlib only; no product code, no external calls.
// The bootstrap effort itself (writing/running this script) is included in the
// backfilled hours. After genesis exists, all further ledger changes go through
// scripts/m2-burn-ledger.mjs (append-only, head-CAS).
//
// Canonical rules (m2ha.budget):
//   recordHash = sha256(canonical(['m2-burn-record-v1', previousRecordHash, record-without-recordHash]))
//   genesis previousRecordHash = 64 ASCII '0'
//   numbers = finite non-negative decimal, at most 2 fraction digits, no
//   leading/trailing fraction zeros, no exponent (unique canonical form)
//   optional fields are explicit null, never omitted
//   genesis balances: productRemaining=max(0,72-B), closureRemaining=max(0,80-max(B,72))
//
// Backfill owner decision (stable, evidence-bound): B is the wall-clock window
// from M2 planning change creation (openspec/changes/implement-m2-pi-control-slice/.openspec.yaml
// mtime) to this bootstrap execution, rounded UP to the next quarter hour.
// Sources are recorded in evidence/m2-burn-ledger.json.

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER_PATH = path.join(REPO_ROOT, "ledger/m2-burn-ledger.json");
const EVIDENCE_PATH = path.join(REPO_ROOT, "evidence/m2-burn-ledger.json");
const ZERO_HASH = "0".repeat(64);
const DOMAIN = "m2-burn-record-v1";
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]?[1-9])?$/;

const PLANNING_START_ISO = "2026-08-23T01:35:19.587Z"; // .openspec.yaml mtime = M2 planning change creation
const PRODUCT_BUDGET_HOURS = 72;
const TOTAL_BUDGET_HOURS = 80;

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !CANONICAL_DECIMAL.test(String(value)))
      throw new TypeError(`non-canonical number: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  throw new TypeError(`non-canonical value: ${typeof value}`);
}

function recordHash(previousRecordHash, recordWithoutHash) {
  return createHash("sha256")
    .update(canonical([DOMAIN, previousRecordHash, recordWithoutHash]))
    .digest("hex");
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function fail(message) {
  process.stderr.write(`bootstrap-m2-burn-ledger: ${message}\n`);
  process.exit(1);
}

if (existsSync(LEDGER_PATH)) {
  fail(
    `refusing to run: ledger already exists at ${LEDGER_PATH} (one-shot; append via scripts/m2-burn-ledger.mjs)`,
  );
}

const executedAt = new Date();
const executedAtIso = executedAt.toISOString();
const planningStartMs = Date.parse(PLANNING_START_ISO);
if (!Number.isFinite(planningStartMs))
  fail("internal error: invalid PLANNING_START_ISO constant");
const wallClockHours = (executedAt.getTime() - planningStartMs) / 3_600_000;
if (wallClockHours <= 0)
  fail("internal error: bootstrap execution predates embedded planning start");
const backfilledHours = Math.ceil(wallClockHours * 4) / 4; // conservative: round up to next quarter hour

const productRemaining = Math.max(0, PRODUCT_BUDGET_HOURS - backfilledHours);
const closureRemaining = Math.max(
  0,
  TOTAL_BUDGET_HOURS - Math.max(backfilledHours, PRODUCT_BUDGET_HOURS),
);

let scriptSha256;
try {
  scriptSha256 = createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
} catch (error) {
  fail(
    `cannot hash own source: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const evidence = {
  schemaVersion: "m2-burn-ledger-evidence-v1",
  bootstrap: {
    command: "node scripts/bootstrap-m2-burn-ledger.mjs",
    nodeVersion: process.version,
    scriptSha256,
    executedAtUtc: executedAtIso,
    oneShotGuard: "refuses when ledger/m2-burn-ledger.json already exists",
  },
  backfillDecision: {
    ownerDecision:
      "B = wall-clock window from M2 planning change creation to bootstrap execution, " +
      "rounded up to the next quarter hour (conservative upper bound); covers all M2 planning, " +
      "review-loop, and this bootstrap one-shot effort",
    planningStartUtc: PLANNING_START_ISO,
    bootstrapEndUtc: executedAtIso,
    wallClockHours: Math.round(wallClockHours * 100) / 100,
    backfilledPersonHours: backfilledHours,
    productBudgetHours: PRODUCT_BUDGET_HOURS,
    totalBudgetHours: TOTAL_BUDGET_HOURS,
    productRemaining,
    closureRemaining,
    state:
      backfilledHours >= TOTAL_BUDGET_HOURS
        ? "stopped"
        : backfilledHours >= PRODUCT_BUDGET_HOURS
          ? "closure"
          : "product",
  },
  sources: [
    {
      kind: "git-commit",
      ref: "4b7b459c5223564fbb92df4373257a5204e73431",
      observed: "2026-08-23T01:27:36Z",
      note: "M1 completion commit immediately preceding M2 planning",
    },
    {
      kind: "file-mtime",
      path: "openspec/changes/implement-m2-pi-control-slice/.openspec.yaml",
      observed: PLANNING_START_ISO,
      note: "M2 planning change creation — planning window start",
    },
    {
      kind: "file-mtime",
      path: "openspec/changes/implement-m2-pi-control-slice/tasks.md",
      observed: "2026-08-23T07:35:47.460Z",
      note: "last M2 planning artifact edit (design 07:29, specs 07:38)",
    },
    {
      kind: "session-files",
      path: "*-pi-automode.jsonl (ignored; 78 files)",
      observed: "2026-08-23T01:41:24Z..2026-08-23T07:38:20Z",
      note: "planning/review agent session activity window",
    },
    {
      kind: "review-loop",
      ref: "CR 0cf5a050-aa34-4b1 APPROVE + RC 2c473f6c-2af9-409 APPROVE",
      observed: "2026-08-23T07:38Z (final closure; no post-approval edits)",
      note: "final planning review state — planning/review complete before apply",
    },
  ],
};

const genesisWithoutHash = {
  recordId: "m2br-0001",
  previousRecordHash: ZERO_HASH,
  kind: "planning-backfill",
  bucket: null,
  reservationId: null,
  taskGroup: "m2-planning-review",
  actor: "herbertgao",
  start: PLANNING_START_ISO,
  end: executedAtIso,
  reservedPersonHours: null,
  actualPersonHours: backfilledHours,
  productRemaining,
  closureRemaining,
  evidenceRef: "evidence/m2-burn-ledger.json",
};

const genesis = {
  ...genesisWithoutHash,
  recordHash: recordHash(ZERO_HASH, genesisWithoutHash),
};
const ledger = { schemaVersion: "m2-burn-ledger-v1", records: [genesis] };

// Evidence first: ledger file presence is the one-shot completion marker.
atomicWriteJson(EVIDENCE_PATH, evidence);
atomicWriteJson(LEDGER_PATH, ledger);

process.stdout.write(
  [
    `genesis written: ${LEDGER_PATH}`,
    `  backfilledPersonHours B = ${backfilledHours} (wall clock ${Math.round(wallClockHours * 100) / 100}h, rounded up to quarter hour)`,
    `  productRemaining = ${productRemaining}, closureRemaining = ${closureRemaining}, state = ${evidence.backfillDecision.state}`,
    `  head = ${genesis.recordHash}`,
    `evidence written: ${EVIDENCE_PATH}`,
  ].join("\n") + "\n",
);
