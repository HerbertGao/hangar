#!/usr/bin/env node
// M2 burn ledger library + CLI - task 0.1 of implement-m2-pi-control-slice.
//
// Independent re-implementation of the m2ha.budget ledger rules used to:
//   - validate ledger/m2-burn-ledger.json (hash chain, canonical bytes,
//     per-kind balance equations, state machine, nullness patterns);
//   - append records with expected-head CAS under an exclusive lockfile.
//
// Crash recovery: if a process dies while holding <ledger>.lock, delete the
// stale lockfile by hand (it contains the holder pid) once no such process
// exists; the ledger itself is only ever replaced via atomic rename.
// The genesis one-shot (scripts/bootstrap-m2-burn-ledger.mjs) computes the
// genesis hash with its own embedded copy of these rules; this library is the
// independent verifier (tests assert both agree on the real ledger).
//
// CLI:
//   node scripts/m2-burn-ledger.mjs validate <ledger.json>
//   node scripts/m2-burn-ledger.mjs append <ledger.json> --kind reserve|actual|settle-crashed-reservation|enter-closure|stop \
//     --expected-head <hash> --actor <name> [--bucket product|closure] [--task-group <g>]
//     [--reservation-id <id>] [--reserved <hours>] [--actual <hours>] [--start <iso>] [--end <iso>] [--evidence-ref <ref>]
//
// Node stdlib only.

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ZERO_HASH = "0".repeat(64);
export const DOMAIN = "m2-burn-record-v1";
export const SCHEMA_VERSION = "m2-burn-ledger-v1";
export const RECORD_KINDS = [
  "planning-backfill",
  "reserve",
  "actual",
  "settle-crashed-reservation",
  "enter-closure",
  "stop",
];
export const APPEND_KINDS = [
  "reserve",
  "actual",
  "settle-crashed-reservation",
  "enter-closure",
  "stop",
];
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]?[1-9])?$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRODUCT_BUDGET = 72;
const TOTAL_BUDGET = 80;
const RECORD_FIELDS = [
  "recordId",
  "previousRecordHash",
  "kind",
  "bucket",
  "reservationId",
  "taskGroup",
  "actor",
  "start",
  "end",
  "reservedPersonHours",
  "actualPersonHours",
  "productRemaining",
  "closureRemaining",
  "evidenceRef",
  "recordHash",
];

export function isCanonicalHours(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    CANONICAL_DECIMAL.test(String(value))
  );
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!isCanonicalHours(value))
      throw new TypeError(`non-canonical number: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  throw new TypeError(`non-canonical value: ${typeof value}`);
}

export function computeRecordHash(previousRecordHash, recordWithoutHash) {
  return createHash("sha256")
    .update(canonical([DOMAIN, previousRecordHash, recordWithoutHash]))
    .digest("hex");
}

// Scan raw JSON text outside strings; every number token must be a canonical
// non-negative decimal (no sign, no leading zeros, <=2 fraction digits, no
// trailing fraction zero, no exponent). Detects drift JSON.parse would erase.
export function scanRawNumberTokens(text) {
  const errors = [];
  let token = "";
  const flush = () => {
    if (token !== "" && !CANONICAL_DECIMAL.test(token)) {
      errors.push(`non-canonical number token "${token}"`);
    }
    token = "";
  };
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      flush();
      inString = true;
    } else if (
      /[0-9]/.test(ch) ||
      (ch === "-" && token === "") ||
      (token !== "" && /[0-9.eE+-]/.test(ch))
    ) {
      token += ch;
    } else {
      flush();
    }
  }
  flush();
  return errors;
}

const recordIdFor = (index) => `m2br-${String(index + 1).padStart(4, "0")}`;
const reservationIdFor = (count) => `m2r-${String(count + 1).padStart(4, "0")}`;

function checkCommonFields(record, errors) {
  if (typeof record.actor !== "string" || record.actor.length === 0)
    errors.push("actor must be a non-empty string");
  if (
    record.start !== null &&
    (typeof record.start !== "string" || !ISO_MS.test(record.start))
  )
    errors.push("start must be canonical ISO-8601 UTC milliseconds or null");
  if (
    record.end !== null &&
    (typeof record.end !== "string" || !ISO_MS.test(record.end))
  )
    errors.push("end must be canonical ISO-8601 UTC milliseconds or null");
  if (
    record.start !== null &&
    record.end !== null &&
    typeof record.start === "string" &&
    typeof record.end === "string" &&
    Date.parse(record.start) > Date.parse(record.end)
  ) {
    errors.push("start must not be after end");
  }
  if (record.evidenceRef !== null && typeof record.evidenceRef !== "string")
    errors.push("evidenceRef must be a string or null");
  for (const field of [
    "reservedPersonHours",
    "actualPersonHours",
    "productRemaining",
    "closureRemaining",
  ]) {
    if (record[field] !== null && !isCanonicalHours(record[field]))
      errors.push(`${field} must be a canonical non-negative decimal or null`);
  }
}

function requireNull(record, field, errors) {
  if (record[field] !== null)
    errors.push(`${field} must be null for kind ${record.kind}`);
}

// Walk records: structural checks + state machine. Returns fold state.
function walkLedger(records) {
  const errors = [];
  const reservations = new Map(); // id -> {bucket, reserved, taskGroup, closed}
  let reservationCount = 0;
  let state = null; // product | closure | stopped (null until genesis seen)
  let product = null;
  let closure = null;

  records.forEach((record, index) => {
    const where = `record ${index + 1}`;
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      errors.push(`${where}: not a plain object`);
      return;
    }
    const unknownFields = Object.keys(record).filter(
      (k) => !RECORD_FIELDS.includes(k),
    );
    if (unknownFields.length > 0)
      errors.push(`${where}: unknown fields ${unknownFields.join(",")}`);
    if (record.recordId !== recordIdFor(index))
      errors.push(`${where}: recordId must be ${recordIdFor(index)}`);
    checkCommonFields(record, errors);
    if (
      index > 0 &&
      record.previousRecordHash !== records[index - 1]?.recordHash
    ) {
      errors.push(
        `${where}: previousRecordHash does not match prior recordHash`,
      );
    }
    const withoutHash = {};
    for (const field of RECORD_FIELDS)
      if (field !== "recordHash") withoutHash[field] = record[field];
    if (
      typeof record.recordHash === "string" &&
      typeof record.previousRecordHash === "string"
    ) {
      try {
        const expected = computeRecordHash(
          record.previousRecordHash,
          withoutHash,
        );
        if (record.recordHash !== expected)
          errors.push(`${where}: recordHash mismatch (expected ${expected})`);
      } catch {
        errors.push(
          `${where}: record contains non-canonical values; hash cannot be recomputed`,
        );
      }
    } else {
      errors.push(`${where}: recordHash/previousRecordHash must be strings`);
    }

    if (state === "stopped" && record.kind !== "planning-backfill") {
      errors.push(`${where}: record after stop`);
    }

    // Forced transitions when a bucket is exhausted and nothing is open.
    const hasOpen = [...reservations.values()].some((r) => !r.closed);
    if (
      state === "product" &&
      product === 0 &&
      !hasOpen &&
      record.kind !== "enter-closure" &&
      record.kind !== "planning-backfill"
    ) {
      errors.push(
        `${where}: product budget exhausted with no open reservations; must enter-closure`,
      );
    }
    if (
      state === "closure" &&
      closure === 0 &&
      !hasOpen &&
      record.kind !== "stop" &&
      record.kind !== "planning-backfill"
    ) {
      errors.push(
        `${where}: closure budget exhausted with no open reservations; must stop`,
      );
    }

    if (record.kind === "planning-backfill") {
      if (index !== 0) {
        errors.push(
          `${where}: planning-backfill is only valid as the genesis record`,
        );
      } else if (record.previousRecordHash !== ZERO_HASH) {
        errors.push(
          `${where}: genesis previousRecordHash must be 64 ASCII '0'`,
        );
      }
      requireNull(record, "bucket", errors);
      requireNull(record, "reservationId", errors);
      requireNull(record, "reservedPersonHours", errors);
      if (record.taskGroup === null || typeof record.taskGroup !== "string")
        errors.push(`${where}: taskGroup must be a string for genesis`);
      if (record.evidenceRef === null)
        errors.push(`${where}: genesis evidenceRef must be a non-null string`);
      const B = record.actualPersonHours;
      if (!isCanonicalHours(B) || B <= 0) {
        errors.push(
          `${where}: genesis actualPersonHours must be a positive canonical decimal (backfill must not be 0)`,
        );
      } else {
        const expectedProduct = Math.max(0, PRODUCT_BUDGET - B);
        const expectedClosure = Math.max(
          0,
          TOTAL_BUDGET - Math.max(B, PRODUCT_BUDGET),
        );
        if (record.productRemaining !== expectedProduct)
          errors.push(
            `${where}: productRemaining must be max(0,72-B)=${expectedProduct}`,
          );
        if (record.closureRemaining !== expectedClosure)
          errors.push(
            `${where}: closureRemaining must be max(0,80-max(B,72))=${expectedClosure}`,
          );
        product = expectedProduct;
        closure = expectedClosure;
        state =
          B >= TOTAL_BUDGET
            ? "stopped"
            : B >= PRODUCT_BUDGET
              ? "closure"
              : "product";
      }
      return;
    }

    if (index === 0) {
      errors.push(
        `${where}: first record must be the planning-backfill genesis`,
      );
      return;
    }
    if (!RECORD_KINDS.includes(record.kind)) {
      errors.push(`${where}: unknown kind ${JSON.stringify(record.kind)}`);
      return;
    }
    if (product === null) return; // genesis was invalid; balance checks below are meaningless

    if (record.kind === "reserve") {
      const id = reservationIdFor(reservationCount);
      if (record.reservationId !== id)
        errors.push(`${where}: reservationId must be ${id}`);
      if (record.bucket !== "product" && record.bucket !== "closure")
        errors.push(`${where}: reserve bucket must be product|closure`);
      if (record.bucket === "product" && state !== "product")
        errors.push(`${where}: product reserve requires state product`);
      if (record.bucket === "closure" && state !== "closure")
        errors.push(`${where}: closure reserve requires state closure`);
      requireNull(record, "actualPersonHours", errors);
      if (record.end !== null)
        errors.push(`${where}: reserve end must be null`);
      if (typeof record.taskGroup !== "string" || record.taskGroup.length === 0)
        errors.push(`${where}: reserve taskGroup must be a non-empty string`);
      const reserved = record.reservedPersonHours;
      if (!isCanonicalHours(reserved) || reserved <= 0) {
        errors.push(
          `${where}: reserve reservedPersonHours must be a positive canonical decimal`,
        );
      } else if (record.bucket === "product" || record.bucket === "closure") {
        const balance = record.bucket === "product" ? product : closure;
        if (reserved > balance)
          errors.push(
            `${where}: reserve ${reserved}h exceeds ${record.bucket} remaining ${balance}h`,
          );
        if (record.bucket === "product") product -= reserved;
        else closure -= reserved;
        reservations.set(id, {
          bucket: record.bucket,
          reserved,
          taskGroup: record.taskGroup,
          closed: false,
        });
        reservationCount += 1;
      }
    } else if (
      record.kind === "actual" ||
      record.kind === "settle-crashed-reservation"
    ) {
      const reservation = reservations.get(record.reservationId);
      if (reservation === undefined) {
        errors.push(
          `${where}: ${record.reservationId} does not reference a known reservation`,
        );
      } else if (reservation.closed) {
        errors.push(
          `${where}: reservation ${record.reservationId} is already closed`,
        );
      } else {
        if (record.bucket !== reservation.bucket)
          errors.push(
            `${where}: bucket must match reservation bucket ${reservation.bucket}`,
          );
        if (record.taskGroup !== reservation.taskGroup)
          errors.push(`${where}: taskGroup must match reservation taskGroup`);
        reservation.closed = true;
        if (record.kind === "actual") {
          requireNull(record, "reservedPersonHours", errors);
          const actual = record.actualPersonHours;
          if (isCanonicalHours(actual)) {
            const refund = reservation.reserved - actual;
            if (reservation.bucket === "product") {
              product += refund;
              if (product < 0)
                errors.push(`${where}: product remaining would go negative`);
            } else {
              closure += refund;
              if (closure < 0)
                errors.push(`${where}: closure remaining would go negative`);
            }
          } else {
            errors.push(
              `${where}: actual must be a canonical non-negative decimal`,
            );
          }
        } else {
          requireNull(record, "reservedPersonHours", errors);
          if (record.actualPersonHours !== reservation.reserved) {
            errors.push(
              `${where}: settle actualPersonHours must equal reserved ${reservation.reserved}`,
            );
          }
          if (record.end !== null)
            errors.push(`${where}: settle end must be null`);
        }
      }
    } else if (record.kind === "enter-closure") {
      if (state !== "product")
        errors.push(`${where}: enter-closure requires state product`);
      if ([...reservations.values()].some((r) => !r.closed))
        errors.push(`${where}: enter-closure with open reservations`);
      requireNull(record, "bucket", errors);
      requireNull(record, "reservationId", errors);
      requireNull(record, "reservedPersonHours", errors);
      requireNull(record, "actualPersonHours", errors);
      if (record.taskGroup !== null)
        errors.push(`${where}: enter-closure taskGroup must be null`);
      if (record.end !== null)
        errors.push(`${where}: enter-closure end must be null`);
      product = 0;
      state = "closure";
    } else if (record.kind === "stop") {
      if ([...reservations.values()].some((r) => !r.closed))
        errors.push(`${where}: stop with open reservations`);
      requireNull(record, "bucket", errors);
      requireNull(record, "reservationId", errors);
      requireNull(record, "reservedPersonHours", errors);
      requireNull(record, "actualPersonHours", errors);
      if (record.taskGroup !== null)
        errors.push(`${where}: stop taskGroup must be null`);
      if (record.end !== null) errors.push(`${where}: stop end must be null`);
      state = "stopped";
    }

    if (record.productRemaining !== product)
      errors.push(`${where}: productRemaining must be ${product}`);
    if (record.closureRemaining !== closure)
      errors.push(`${where}: closureRemaining must be ${closure}`);
  });

  return { errors, state, product, closure, reservations, reservationCount };
}

export function validateLedgerText(rawText) {
  const errors = [...scanRawNumberTokens(rawText)];
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      errors: [
        ...errors,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [...errors, "ledger root must be an object"] };
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    return {
      ok: false,
      errors: [...errors, "records must be a non-empty array"],
    };
  }
  const walk = walkLedger(parsed.records);
  errors.push(...walk.errors);
  return {
    ok: errors.length === 0,
    errors,
    state: walk.state,
    head: parsed.records.at(-1)?.recordHash,
    records: parsed.records,
  };
}

export function serializeLedger(ledger) {
  return JSON.stringify(ledger, null, 2) + "\n";
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = openSync(tmp, "wx");
  try {
    writeFileSync(fd, data, "utf8");
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

// Append one record under expected-head CAS. Only the coordinator calls this.
export function appendRecord(ledgerPath, expectedHead, input) {
  if (!APPEND_KINDS.includes(input.kind)) {
    throw new Error(
      `kind must be one of ${APPEND_KINDS.join("|")} (genesis only via bootstrap one-shot)`,
    );
  }
  if (typeof input.actor !== "string" || input.actor.length === 0)
    throw new Error("actor is required");
  const lockPath = `${ledgerPath}.lock`;
  const lockFd = openSync(lockPath, "wx");
  writeSync(lockFd, `${process.pid}\n`);
  try {
    const raw = readFileSync(ledgerPath, "utf8");
    const current = validateLedgerText(raw);
    if (!current.ok)
      throw new Error(`current ledger invalid: ${current.errors.join("; ")}`);
    const records = current.records;
    const head = records.at(-1).recordHash;
    if (expectedHead !== head)
      throw new Error(
        `head CAS mismatch: expected ${expectedHead}, ledger head is ${head}`,
      );
    const walk = walkLedger(records);
    if (walk.errors.length > 0)
      throw new Error(`current ledger walk failed: ${walk.errors.join("; ")}`);

    const start = input.start ?? new Date().toISOString();
    const record = {
      recordId: recordIdFor(records.length),
      previousRecordHash: head,
      kind: input.kind,
      bucket: null,
      reservationId: null,
      taskGroup: null,
      actor: input.actor,
      start,
      end: null,
      reservedPersonHours: null,
      actualPersonHours: null,
      productRemaining: walk.product,
      closureRemaining: walk.closure,
      evidenceRef: input.evidenceRef ?? null,
    };
    let product = walk.product;
    let closure = walk.closure;

    if (input.kind === "reserve") {
      if (input.bucket !== "product" && input.bucket !== "closure")
        throw new Error("reserve requires --bucket product|closure");
      if (!isCanonicalHours(input.reserved) || input.reserved <= 0)
        throw new Error(
          "reserve requires --reserved as a positive canonical decimal",
        );
      if (typeof input.taskGroup !== "string" || input.taskGroup.length === 0)
        throw new Error("reserve requires --task-group");
      const balance = input.bucket === "product" ? product : closure;
      if (input.reserved > balance)
        throw new Error(
          `reserve ${input.reserved}h exceeds ${input.bucket} remaining ${balance}h`,
        );
      record.bucket = input.bucket;
      record.reservationId = reservationIdFor(walk.reservationCount);
      record.taskGroup = input.taskGroup;
      record.reservedPersonHours = input.reserved;
      if (input.bucket === "product") product -= input.reserved;
      else closure -= input.reserved;
    } else if (
      input.kind === "actual" ||
      input.kind === "settle-crashed-reservation"
    ) {
      const reservation = walk.reservations.get(input.reservationId);
      if (reservation === undefined)
        throw new Error(`unknown reservation ${input.reservationId}`);
      if (reservation.closed)
        throw new Error(`reservation ${input.reservationId} is already closed`);
      if (
        input.taskGroup !== undefined &&
        input.taskGroup !== reservation.taskGroup
      )
        throw new Error(
          `taskGroup must match reservation taskGroup ${reservation.taskGroup}`,
        );
      record.bucket = reservation.bucket;
      record.reservationId = input.reservationId;
      record.taskGroup = reservation.taskGroup;
      if (input.kind === "actual") {
        if (!isCanonicalHours(input.actual))
          throw new Error(
            "actual requires --actual as a canonical non-negative decimal",
          );
        record.actualPersonHours = input.actual;
        record.end = input.end ?? new Date().toISOString();
        const refund = reservation.reserved - input.actual;
        if (reservation.bucket === "product") {
          if (product + refund < 0)
            throw new Error("actual would make product remaining negative");
          product += refund;
        } else {
          if (closure + refund < 0)
            throw new Error("actual would make closure remaining negative");
          closure += refund;
        }
      } else {
        record.actualPersonHours = reservation.reserved;
      }
    } else if (input.kind === "enter-closure") {
      if (walk.state !== "product")
        throw new Error("enter-closure requires state product");
      if ([...walk.reservations.values()].some((r) => !r.closed))
        throw new Error("enter-closure with open reservations");
      product = 0;
    } else if (input.kind === "stop") {
      if ([...walk.reservations.values()].some((r) => !r.closed))
        throw new Error("stop with open reservations");
    }

    record.productRemaining = product;
    record.closureRemaining = closure;
    record.recordHash = computeRecordHash(
      head,
      (() => {
        const { recordHash, ...rest } = record;
        return rest;
      })(),
    );
    const proposed = {
      schemaVersion: SCHEMA_VERSION,
      records: [...records, record],
    };
    const proposedRaw = serializeLedger(proposed);
    const check = validateLedgerText(proposedRaw);
    if (!check.ok)
      throw new Error(`proposed append invalid: ${check.errors.join("; ")}`);
    atomicWrite(ledgerPath, proposedRaw);
    return {
      recordId: record.recordId,
      recordHash: record.recordHash,
      productRemaining: product,
      closureRemaining: closure,
    };
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

function parseHoursArg(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    !CANONICAL_DECIMAL.test(String(parsed))
  ) {
    throw new Error(
      `--value "${value}" is not a canonical non-negative decimal`,
    );
  }
  return parsed;
}

function cli() {
  const [command, ledgerArg, ...rest] = process.argv.slice(2);
  if (!command || !ledgerArg || !["validate", "append"].includes(command)) {
    process.stderr.write(
      "usage: m2-burn-ledger.mjs validate <ledger.json> | append <ledger.json> --kind ... --expected-head ...\n",
    );
    process.exit(2);
  }
  const ledgerPath = path.resolve(ledgerArg);
  if (command === "validate") {
    let raw;
    try {
      raw = readFileSync(ledgerPath, "utf8");
    } catch (error) {
      process.stderr.write(
        `error: cannot read ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
    const result = validateLedgerText(raw);
    if (result.ok) {
      process.stdout.write(
        `ok state=${result.state} head=${result.head} records=${result.records.length}\n`,
      );
      return;
    }
    result.errors.forEach((e) => process.stderr.write(`invalid: ${e}\n`));
    process.exit(1);
  }
  const input = {
    kind: undefined,
    bucket: undefined,
    taskGroup: undefined,
    actor: undefined,
    reservationId: undefined,
    reserved: undefined,
    actual: undefined,
    start: undefined,
    end: undefined,
    evidenceRef: undefined,
  };
  let expectedHead;
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      process.stderr.write(`usage error near ${key ?? "(end)"}\n`);
      process.exit(2);
    }
    switch (key) {
      case "--kind":
        input.kind = value;
        break;
      case "--expected-head":
        expectedHead = value;
        break;
      case "--bucket":
        input.bucket = value;
        break;
      case "--task-group":
        input.taskGroup = value;
        break;
      case "--actor":
        input.actor = value;
        break;
      case "--reservation-id":
        input.reservationId = value;
        break;
      case "--reserved":
        input.reserved = parseHoursArg(value);
        break;
      case "--actual":
        input.actual = parseHoursArg(value);
        break;
      case "--start":
        input.start = value;
        break;
      case "--end":
        input.end = value;
        break;
      case "--evidence-ref":
        input.evidenceRef = value;
        break;
      default:
        process.stderr.write(`unknown option ${key}\n`);
        process.exit(2);
    }
  }
  if (expectedHead === undefined) {
    process.stderr.write("append requires --expected-head (head CAS)\n");
    process.exit(2);
  }
  try {
    const result = appendRecord(ledgerPath, expectedHead, input);
    process.stdout.write(
      `appended ${result.recordId} head=${result.recordHash} productRemaining=${result.productRemaining} closureRemaining=${result.closureRemaining}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `append failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

let invokedAsScript = false;
try {
  invokedAsScript =
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
} catch {
  invokedAsScript = false;
}
if (invokedAsScript) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
