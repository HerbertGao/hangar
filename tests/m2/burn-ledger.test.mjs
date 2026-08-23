// Task 0.1 tests for implement-m2-pi-control-slice: m2ha.budget burn ledger.
//
// Covers every m2ha.budget scenario against the real ledger and synthetic
// ledgers: genesis clamp rules, record-hash preimage drift, CAS append,
// per-kind balance equations, forced transitions, settle semantics, and the
// bootstrap one-shot replay refusal.
//
// Run: node --test tests/m2/burn-ledger.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZERO_HASH,
  SCHEMA_VERSION,
  appendRecord,
  computeRecordHash,
  serializeLedger,
  validateLedgerText,
} from "../../scripts/m2-burn-ledger.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REAL_LEDGER = path.join(REPO_ROOT, "ledger/m2-burn-ledger.json");
const REAL_HEAD =
  "9bb075c599ef03fb34c99f7ef8ea475b166ebd8528c86e7e05ec3e2347e36074";
const T0 = "2026-08-23T01:35:19.587Z";
const T1 = "2026-08-23T10:00:00.000Z";
const T2 = "2026-08-23T11:00:00.000Z";
const T3 = "2026-08-23T12:00:00.000Z";
const ACTOR = "coordinator";

function genesisRecord({
  B = 8.25,
  actor = ACTOR,
  taskGroup = "m2-planning-review",
  start = T0,
  end = T1,
} = {}) {
  const record = {
    recordId: "m2br-0001",
    previousRecordHash: ZERO_HASH,
    kind: "planning-backfill",
    bucket: null,
    reservationId: null,
    taskGroup,
    actor,
    start,
    end,
    reservedPersonHours: null,
    actualPersonHours: B,
    productRemaining: Math.max(0, 72 - B),
    closureRemaining: Math.max(0, 80 - Math.max(B, 72)),
    evidenceRef: "evidence/m2-burn-ledger.json",
  };
  record.recordHash = computeRecordHash(ZERO_HASH, record);
  return record;
}

function newLedger(dir, genesisOptions) {
  const file = path.join(
    mkdtempSync(path.join(dir, "ledger-")),
    "m2-burn-ledger.json",
  );
  writeFileSync(
    file,
    serializeLedger({
      schemaVersion: SCHEMA_VERSION,
      records: [genesisRecord(genesisOptions)],
    }),
  );
  return file;
}

function headOf(file) {
  return JSON.parse(readFileSync(file, "utf8")).records.at(-1).recordHash;
}

function appendOk(file, input) {
  return appendRecord(file, headOf(file), { actor: ACTOR, ...input });
}

function assertAppendFails(file, input, messagePattern) {
  const before = readFileSync(file, "utf8");
  assert.throws(
    () => appendRecord(file, headOf(file), { actor: ACTOR, ...input }),
    (error) => messagePattern.test(error.message),
    `expected append failure matching ${messagePattern}`,
  );
  assert.equal(
    readFileSync(file, "utf8"),
    before,
    "failed append must not modify the ledger",
  );
  assert.equal(
    existsSync(`${file}.lock`),
    false,
    "failed append must release the lockfile",
  );
}

function assertInvalid(rawText, messagePattern) {
  const result = validateLedgerText(rawText);
  assert.equal(
    result.ok,
    false,
    `expected invalid ledger: ${rawText.slice(0, 120)}`,
  );
  const matches =
    typeof messagePattern === "string"
      ? (e) => e.includes(messagePattern)
      : (e) => messagePattern.test(e);
  assert.ok(
    result.errors.some(matches),
    `expected an error matching ${messagePattern}, got: ${result.errors.join(" | ")}`,
  );
}

function tampered(file, mutate) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  mutate(parsed);
  return serializeLedger(parsed);
}

// ---------------------------------------------------------------------------
// Scenario: real ledger + independent recomputation
// ---------------------------------------------------------------------------

test("real genesis ledger validates; independent lib hash matches the one-shot output", () => {
  const result = validateLedgerText(readFileSync(REAL_LEDGER, "utf8"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.state, "product");
  assert.equal(result.head, REAL_HEAD);
  const records = result.records;
  assert.equal(records.length, 1);
  const genesis = records[0];
  assert.equal(genesis.kind, "planning-backfill");
  assert.equal(genesis.actualPersonHours, 8.25);
  assert.equal(genesis.productRemaining, 63.75);
  assert.equal(genesis.closureRemaining, 8);
  // Independent recomputation: the lib re-derives every hash with its own
  // canonical encoder and the fixed domain tag, so agreement with the
  // bootstrap one-shot pins the domain tag against drift in either copy.
  assert.equal(
    computeRecordHash(
      genesis.previousRecordHash,
      (() => {
        const { recordHash, ...pre } = genesis;
        return pre;
      })(),
    ),
    REAL_HEAD,
  );
});

test("bootstrap one-shot refuses to replay once the ledger exists", () => {
  let status = 0;
  let stderr = "";
  try {
    execFileSync(
      "node",
      [path.join(REPO_ROOT, "scripts/bootstrap-m2-burn-ledger.mjs")],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  } catch (error) {
    status = error.status ?? 1;
    stderr = String(error.stderr);
  }
  assert.notEqual(status, 0, "one-shot replay must exit non-zero");
  assert.match(stderr, /refusing to run: ledger already exists/);
});

// ---------------------------------------------------------------------------
// Scenario: planning backfill exceeds product bucket (B clamp rules)
// ---------------------------------------------------------------------------

test("genesis clamps balances and derives state for B in {8.25, 72, 75, 80, 90}", () => {
  const cases = [
    { B: 8.25, product: 63.75, closure: 8, state: "product" },
    { B: 72, product: 0, closure: 8, state: "closure" },
    { B: 75, product: 0, closure: 5, state: "closure" },
    { B: 80, product: 0, closure: 0, state: "stopped" },
    { B: 90, product: 0, closure: 0, state: "stopped" },
  ];
  for (const { B, product, closure, state } of cases) {
    const result = validateLedgerText(
      serializeLedger({
        schemaVersion: SCHEMA_VERSION,
        records: [genesisRecord({ B })],
      }),
    );
    assert.equal(result.ok, true, `B=${B}: ${result.errors.join("; ")}`);
    assert.equal(result.state, state, `B=${B} state`);
    const genesis = result.records[0];
    assert.equal(genesis.productRemaining, product, `B=${B} productRemaining`);
    assert.equal(genesis.closureRemaining, closure, `B=${B} closureRemaining`);
  }
});

test("genesis without planning backfill is rejected", () => {
  // Planning person-hours must not be recorded as 0 (no backfill) or null.
  assertInvalid(
    serializeLedger({
      schemaVersion: SCHEMA_VERSION,
      records: [genesisRecord({ B: 0 })],
    }),
    /genesis actualPersonHours must be a positive canonical decimal/,
  );
  const nullBackfill = genesisRecord();
  nullBackfill.actualPersonHours = null;
  nullBackfill.recordHash = computeRecordHash(
    ZERO_HASH,
    (() => {
      const { recordHash, ...pre } = nullBackfill;
      return pre;
    })(),
  );
  assertInvalid(
    serializeLedger({ schemaVersion: SCHEMA_VERSION, records: [nullBackfill] }),
    /genesis actualPersonHours must be a positive canonical decimal/,
  );
});

// ---------------------------------------------------------------------------
// Scenario: record hash exclusion / rule drift
// ---------------------------------------------------------------------------

test("recordHash computed over a non-canonical preimage is rejected", () => {
  const file = newLedger(tmpdir());

  // 1. Writer includes recordHash itself in the preimage.
  let raw = tampered(file, (ledger) => {
    const g = ledger.records[0];
    g.recordHash = computeRecordHash(g.previousRecordHash, { ...g });
  });
  assertInvalid(raw, /recordHash mismatch/);

  // 2. Writer omits null fields from the preimage.
  raw = tampered(file, (ledger) => {
    const g = ledger.records[0];
    const pre = Object.fromEntries(
      Object.entries(g).filter(([, v]) => v !== null),
    );
    g.recordHash = computeRecordHash(g.previousRecordHash, pre);
  });
  assertInvalid(raw, /recordHash mismatch/);

  // 3. Writer changes the genesis previousRecordHash away from 64 ASCII '0'.
  raw = tampered(file, (ledger) => {
    const g = ledger.records[0];
    g.previousRecordHash = "f".repeat(64);
    const { recordHash, ...pre } = g;
    g.recordHash = computeRecordHash(g.previousRecordHash, pre);
  });
  assertInvalid(raw, /genesis previousRecordHash must be 64 ASCII '0'/);

  // 4. Writer mutates a hashed field after the fact.
  raw = tampered(file, (ledger) => {
    ledger.records[0].actor = "attacker";
  });
  assertInvalid(raw, /recordHash mismatch/);
});

test("non-canonical number tokens in raw text are rejected even when JSON.parse accepts them", () => {
  const variants = ["8.0", "08", "1e1", "-1", "8.250"];
  for (const bad of variants) {
    const file = newLedger(tmpdir());
    // Replace the genesis actualPersonHours value in the raw text; the
    // JSON-level value stays a valid number, only the raw token is wrong.
    const raw = readFileSync(file, "utf8").replace(
      '"actualPersonHours": 8.25',
      `"actualPersonHours": ${bad}`,
    );
    assert.ok(raw.includes(bad), `variant ${bad} was not injected`);
    assertInvalid(raw, `non-canonical number token "${bad}"`);
  }
});

// ---------------------------------------------------------------------------
// Scenario: two parallel workers compete for reservation (head CAS)
// ---------------------------------------------------------------------------

test("second append against a stale head fails CAS and leaves the ledger untouched", () => {
  const dir = tmpdir();
  const file = newLedger(dir);
  const staleHead = headOf(file);
  const winner = appendRecord(file, staleHead, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 5,
    actor: ACTOR,
    start: T1,
  });
  assert.equal(winner.recordId, "m2br-0002");
  assert.equal(winner.recordHash, headOf(file));

  const before = readFileSync(file, "utf8");
  assert.throws(
    () =>
      appendRecord(file, staleHead, {
        kind: "reserve",
        bucket: "product",
        taskGroup: "t-2",
        reserved: 5,
        actor: ACTOR,
        start: T1,
      }),
    /head CAS mismatch/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  // Loser re-reads the new head and may reserve from the real remaining balance.
  appendRecord(file, headOf(file), {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-2",
    reserved: 5,
    actor: ACTOR,
    start: T2,
  });
  const result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.records[2].productRemaining, 53.75);
});

test("reserve beyond the remaining balance is rejected", () => {
  const file = newLedger(tmpdir());
  assertAppendFails(
    file,
    { kind: "reserve", bucket: "product", taskGroup: "t-1", reserved: 63.76 },
    /exceeds product remaining/,
  );
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 63.75,
    start: T1,
  });
  assertAppendFails(
    file,
    { kind: "reserve", bucket: "product", taskGroup: "t-2", reserved: 0.01 },
    /exceeds product remaining/,
  );
});

// ---------------------------------------------------------------------------
// Record-kind balance equations
// ---------------------------------------------------------------------------

test("reserve deducts at append time; actual refunds reserved-actual; overrun allowed while non-negative", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 10,
    start: T1,
  });
  let result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(
    result.records.at(-1).productRemaining,
    53.75,
    "reserve deducts first",
  );

  appendOk(file, {
    kind: "actual",
    reservationId: "m2r-0001",
    actual: 6,
    start: T1,
    end: T2,
  });
  result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(
    result.records.at(-1).productRemaining,
    57.75,
    "actual refunds reserved-actual",
  );

  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-2",
    reserved: 10,
    start: T2,
  });
  appendOk(file, {
    kind: "actual",
    reservationId: "m2r-0002",
    actual: 12,
    start: T2,
    end: T3,
  });
  result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(
    result.records.at(-1).productRemaining,
    45.75,
    "overrun keeps the balance non-negative",
  );
});

test("actual that would drive the balance negative is rejected", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 63.75,
    start: T1,
  });
  assertAppendFails(
    file,
    {
      kind: "actual",
      reservationId: "m2r-0001",
      actual: 64,
      start: T1,
      end: T2,
    },
    /negative/,
  );
});

test("settle-crashed-reservation keeps the reserve-debited balance and never double-debits", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 10,
    start: T1,
  });
  const settled = appendOk(file, {
    kind: "settle-crashed-reservation",
    reservationId: "m2r-0001",
    start: T2,
  });
  assert.equal(settled.productRemaining, 53.75, "settle must not debit again");
  const result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(
    result.records.at(-1).actualPersonHours,
    10,
    "settle records actual=reserved",
  );
  assert.equal(result.records.at(-1).end, null, "settle end stays null");

  // Reservation is closed: neither actual nor a second settle may touch it.
  assertAppendFails(
    file,
    {
      kind: "actual",
      reservationId: "m2r-0001",
      actual: 5,
      start: T2,
      end: T3,
    },
    /already closed/,
  );
  assertAppendFails(
    file,
    {
      kind: "settle-crashed-reservation",
      reservationId: "m2r-0001",
      start: T3,
    },
    /already closed/,
  );

  // settle with actual != reserved is structurally invalid in a written record.
  const raw = tampered(file, (ledger) => {
    ledger.records[2].actualPersonHours = 9;
  });
  assertInvalid(raw, /settle actualPersonHours must equal reserved/);
});

test("actual/settle must reference a known open reservation with matching taskGroup and bucket", () => {
  const file = newLedger(tmpdir());
  assertAppendFails(
    file,
    {
      kind: "actual",
      reservationId: "m2r-9999",
      actual: 1,
      start: T1,
      end: T2,
    },
    /unknown reservation/,
  );
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 5,
    start: T1,
  });
  appendOk(file, {
    kind: "settle-crashed-reservation",
    reservationId: "m2r-0001",
    start: T2,
  });
  // Rewrite the reserve's taskGroup and rehash the chain so the failure is
  // the taskGroup mismatch itself, not hash drift.
  const raw = tampered(file, (ledger) => {
    ledger.records[1].taskGroup = "t-other";
    ledger.records[1].recordHash = computeRecordHash(
      ledger.records[1].previousRecordHash,
      (() => {
        const { recordHash, ...pre } = ledger.records[1];
        return pre;
      })(),
    );
    ledger.records[2].previousRecordHash = ledger.records[1].recordHash;
    ledger.records[2].recordHash = computeRecordHash(
      ledger.records[2].previousRecordHash,
      (() => {
        const { recordHash, ...pre } = ledger.records[2];
        return pre;
      })(),
    );
  });
  assertInvalid(raw, /taskGroup must match reservation taskGroup/);
});

// ---------------------------------------------------------------------------
// Scenario: product finishes early and enters closure (irreversible)
// ---------------------------------------------------------------------------

test("enter-closure is blocked by open reservations, irreversible, and forbids later product reserves", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 10,
    start: T1,
  });
  assertAppendFails(
    file,
    { kind: "enter-closure", start: T2 },
    /enter-closure with open reservations/,
  );

  appendOk(file, {
    kind: "actual",
    reservationId: "m2r-0001",
    actual: 10,
    start: T1,
    end: T2,
  });
  const entered = appendOk(file, { kind: "enter-closure", start: T2 });
  assert.equal(
    entered.productRemaining,
    0,
    "unused product hours are forfeited",
  );
  assert.equal(
    entered.closureRemaining,
    8,
    "closure budget is the original 8h, not transferred",
  );

  assertAppendFails(
    file,
    { kind: "reserve", bucket: "product", taskGroup: "t-2", reserved: 1 },
    /exceeds product remaining/,
  );
  assertAppendFails(
    file,
    { kind: "enter-closure", start: T3 },
    /requires state product/,
  );
  // A hand-written product reserve in closure state is rejected by the state
  // machine even though the balance check alone would also refuse it.
  const raw = tampered(file, (ledger) => {
    const reserve = {
      recordId: "m2br-0005",
      previousRecordHash: ledger.records.at(-1).recordHash,
      kind: "reserve",
      bucket: "product",
      reservationId: "m2r-0002",
      taskGroup: "t-bad",
      actor: ACTOR,
      start: T3,
      end: null,
      reservedPersonHours: 4,
      actualPersonHours: null,
      productRemaining: 0,
      closureRemaining: 4,
      evidenceRef: null,
    };
    reserve.recordHash = computeRecordHash(
      reserve.previousRecordHash,
      (() => {
        const { recordHash, ...pre } = reserve;
        return pre;
      })(),
    );
    ledger.records.push(reserve);
  });
  assertInvalid(raw, /product reserve requires state product/);
  appendOk(file, {
    kind: "reserve",
    bucket: "closure",
    taskGroup: "t-closure",
    reserved: 4,
    start: T3,
  });
  const result = validateLedgerText(readFileSync(file, "utf8"));
  assert.equal(result.records.at(-1).closureRemaining, 4);
});

// ---------------------------------------------------------------------------
// Forced transitions: product=0 MUST enter-closure; closure=0 MUST stop
// ---------------------------------------------------------------------------

test("product budget exhausted with no open reservations forces enter-closure", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 63.75,
    start: T1,
  });
  appendOk(file, {
    kind: "actual",
    reservationId: "m2r-0001",
    actual: 63.75,
    start: T1,
    end: T2,
  });
  assertAppendFails(
    file,
    { kind: "reserve", bucket: "product", taskGroup: "t-2", reserved: 0.01 },
    /exceeds product remaining/,
  );
  assertAppendFails(file, { kind: "stop", start: T2 }, /must enter-closure/);
  appendOk(file, { kind: "enter-closure", start: T2 });
});

test("closure budget exhausted forces stop; stop is terminal", () => {
  const file = newLedger(tmpdir(), { B: 72 });
  appendOk(file, {
    kind: "reserve",
    bucket: "closure",
    taskGroup: "t-c1",
    reserved: 8,
    start: T1,
  });
  appendOk(file, {
    kind: "actual",
    reservationId: "m2r-0001",
    actual: 8,
    start: T1,
    end: T2,
  });
  assertAppendFails(
    file,
    { kind: "reserve", bucket: "closure", taskGroup: "t-c2", reserved: 0.01 },
    /exceeds closure remaining/,
  );
  assertAppendFails(
    file,
    {
      kind: "actual",
      reservationId: "m2r-0001",
      actual: 1,
      start: T2,
      end: T3,
    },
    /already closed/,
  );
  assertAppendFails(
    file,
    { kind: "reserve", bucket: "product", taskGroup: "t-x", reserved: 1 },
    /exceeds product remaining/,
  );
  appendOk(file, { kind: "stop", start: T2 });

  // Terminal: no further record of any kind (nor a second stop).
  for (const input of [
    { kind: "reserve", bucket: "closure", taskGroup: "t-c3", reserved: 1 },
    {
      kind: "actual",
      reservationId: "m2r-0001",
      actual: 1,
      start: T2,
      end: T3,
    },
    { kind: "enter-closure", start: T3 },
    { kind: "stop", start: T3 },
  ]) {
    assertAppendFails(
      file,
      input,
      /record after stop|requires state product|already closed|exceeds closure remaining/,
    );
  }
});

// ---------------------------------------------------------------------------
// Chain identity and structural checks
// ---------------------------------------------------------------------------

test("recordId and reservationId sequences are enforced", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 5,
    start: T1,
  });
  let raw = tampered(file, (ledger) => {
    ledger.records[1].recordId = "m2br-0009";
  });
  assertInvalid(raw, /recordId must be m2br-0002/);

  raw = tampered(file, (ledger) => {
    ledger.records[1].reservationId = "m2r-0009";
    ledger.records[1].recordHash = computeRecordHash(
      ledger.records[1].previousRecordHash,
      (() => {
        const { recordHash, ...pre } = ledger.records[1];
        return pre;
      })(),
    );
  });
  assertInvalid(raw, /reservationId must be m2r-0001/);
});

test("timestamp format and ordering are enforced", () => {
  const file = newLedger(tmpdir());
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 5,
    start: T1,
  });
  const rehash = (ledger) => {
    ledger.records[1].recordHash = computeRecordHash(
      ledger.records[1].previousRecordHash,
      (() => {
        const { recordHash, ...pre } = ledger.records[1];
        return pre;
      })(),
    );
  };
  let raw = tampered(file, (ledger) => {
    ledger.records[1].start = "2026-08-23T01:35:19Z";
    rehash(ledger);
  });
  assertInvalid(raw, /start must be canonical ISO-8601 UTC milliseconds/);
  raw = tampered(file, (ledger) => {
    ledger.records[1].end = "2026-01-01T00:00:00.000Z";
    rehash(ledger);
  });
  assertInvalid(raw, /start must not be after end/);
});

test("unknown fields and kinds are rejected", () => {
  const file = newLedger(tmpdir());
  let raw = tampered(file, (ledger) => {
    ledger.records[0].note = "extra";
  });
  assertInvalid(raw, /unknown fields note/);
  raw = tampered(file, (ledger) => {
    ledger.records.push({
      ...ledger.records[0],
      recordId: "m2br-0002",
      kind: "bogus-kind",
      taskGroup: null,
    });
    const last = ledger.records.at(-1);
    last.previousRecordHash = ledger.records[0].recordHash;
    last.recordHash = computeRecordHash(
      last.previousRecordHash,
      (() => {
        const { recordHash, ...pre } = last;
        return pre;
      })(),
    );
  });
  assertInvalid(raw, /unknown kind/);
});

test("invalid JSON and wrong schemaVersion are rejected", () => {
  assertInvalid("{not json", /invalid JSON/);
  assertInvalid(
    serializeLedger({ schemaVersion: "other-v1", records: [genesisRecord()] }),
    /schemaVersion must be m2-burn-ledger-v1/,
  );
  assertInvalid(
    serializeLedger({ schemaVersion: SCHEMA_VERSION, records: [] }),
    /records must be a non-empty array/,
  );
});

// ---------------------------------------------------------------------------
// Lockfile discipline
// ---------------------------------------------------------------------------

test("append refuses while another append holds the lockfile", () => {
  const file = newLedger(tmpdir());
  writeFileSync(`${file}.lock`, "held");
  const before = readFileSync(file, "utf8");
  assert.throws(
    () =>
      appendRecord(file, headOf(file), {
        kind: "reserve",
        bucket: "product",
        taskGroup: "t-1",
        reserved: 5,
        actor: ACTOR,
        start: T1,
      }),
    /EEXIST/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  rmSync(`${file}.lock`);
  appendOk(file, {
    kind: "reserve",
    bucket: "product",
    taskGroup: "t-1",
    reserved: 5,
    start: T1,
  });
  assert.equal(
    existsSync(`${file}.lock`),
    false,
    "lockfile must be released after append",
  );
});
