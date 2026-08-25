import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type TelegramDisposition =
  | "control-pending"
  | "control-unknown"
  | "delivery-pending"
  | "delivery-unknown"
  | "delivery-recorded"
  | "delivery-denied"
  | "abandoned-before-send"
  | "quarantined-unknown";

export interface TelegramTransportRecord {
  readonly occurrenceKey: string;
  readonly correlationSeed: string;
  readonly updateRef: string;
  readonly updateRefDigest: string;
  readonly rawUpdate: Uint8Array;
  readonly rawUpdateDigest: string;
  readonly disposition: TelegramDisposition;
  readonly controlTuple: Readonly<Record<string, unknown>> | null;
  readonly interactionRef: string | null;
  readonly responseKind: string | null;
  readonly deliveryKey: string | null;
  readonly deliveryOperation: string | null;
  readonly payloadBytes: Uint8Array | null;
  readonly payloadDigest: string | null;
  readonly effectId: string | null;
  readonly updatedAtUnixMs: number;
}

const DISPOSITIONS: readonly TelegramDisposition[] = [
  "control-pending",
  "control-unknown",
  "delivery-pending",
  "delivery-unknown",
  "delivery-recorded",
  "delivery-denied",
  "abandoned-before-send",
  "quarantined-unknown",
];
const hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export class TelegramTransportStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, nowUnixMs: () => number) {
    this.#db = new DatabaseSync(path);
    this.#now = nowUnixMs;
    this.#db.exec(`
      PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS transport_meta(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        poll_cursor TEXT
      );
      INSERT OR IGNORE INTO transport_meta(singleton,poll_cursor) VALUES(1,NULL);
      CREATE TABLE IF NOT EXISTS telegram_updates(
        occurrence_key TEXT PRIMARY KEY,
        correlation_seed TEXT NOT NULL UNIQUE,
        update_ref TEXT NOT NULL,
        update_ref_digest TEXT NOT NULL,
        raw_update_base64url TEXT NOT NULL,
        raw_update_digest TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN (
          'control-pending','control-unknown','delivery-pending','delivery-unknown',
          'delivery-recorded','delivery-denied','abandoned-before-send','quarantined-unknown'
        )),
        control_tuple_json TEXT,
        interaction_ref TEXT,
        response_kind TEXT,
        delivery_key TEXT,
        delivery_operation TEXT,
        payload_base64url TEXT,
        payload_digest TEXT,
        effect_id TEXT,
        updated_at INTEGER NOT NULL,
        CHECK(
          disposition IN ('control-pending','control-unknown','abandoned-before-send','quarantined-unknown')
          OR (control_tuple_json IS NOT NULL AND interaction_ref IS NOT NULL AND
              response_kind IS NOT NULL AND delivery_key IS NOT NULL AND
              delivery_operation IS NOT NULL AND payload_base64url IS NOT NULL AND
              payload_digest IS NOT NULL)
        )
      );
    `);
  }

  cursor(): string | null {
    const row = this.#db
      .prepare("SELECT poll_cursor FROM transport_meta WHERE singleton=1")
      .get();
    return row?.poll_cursor === null ? null : String(row?.poll_cursor);
  }

  setCursor(cursor: string | null): void {
    this.#db
      .prepare("UPDATE transport_meta SET poll_cursor=? WHERE singleton=1")
      .run(cursor);
  }

  registerUpdate(input: {
    occurrenceKey: string;
    updateRef: string;
    rawUpdate: Uint8Array;
  }): { record: TelegramTransportRecord; conflict: boolean } {
    const updateRefDigest = hex(input.updateRef);
    const rawUpdateDigest = hex(input.rawUpdate);
    const seed = hex(`telegram-correlation-v1\0${input.occurrenceKey}`);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#row(input.occurrenceKey);
      if (existing) {
        const record = this.#decode(existing);
        const conflict =
          record.updateRefDigest !== updateRefDigest ||
          record.rawUpdateDigest !== rawUpdateDigest;
        if (conflict && record.disposition !== "quarantined-unknown")
          this.#db
            .prepare(
              "UPDATE telegram_updates SET disposition='quarantined-unknown',updated_at=? " +
                "WHERE occurrence_key=?",
            )
            .run(this.#time(), input.occurrenceKey);
        this.#db.exec("COMMIT");
        return {
          record: this.get(input.occurrenceKey)!,
          conflict,
        };
      }
      this.#db
        .prepare(
          "INSERT INTO telegram_updates(occurrence_key,correlation_seed,update_ref," +
            "update_ref_digest,raw_update_base64url,raw_update_digest,disposition,updated_at) " +
            "VALUES(?,?,?,?,?,?,'control-pending',?)",
        )
        .run(
          input.occurrenceKey,
          seed,
          input.updateRef,
          updateRefDigest,
          Buffer.from(input.rawUpdate).toString("base64url"),
          rawUpdateDigest,
          this.#time(),
        );
      this.#db.exec("COMMIT");
      return { record: this.get(input.occurrenceKey)!, conflict: false };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch (rollbackError) {
        if (
          !(rollbackError instanceof Error) ||
          !rollbackError.message.includes("no transaction")
        )
          throw rollbackError;
      }
      throw error;
    }
  }

  get(occurrenceKey: string): TelegramTransportRecord | undefined {
    const row = this.#row(occurrenceKey);
    return row ? this.#decode(row) : undefined;
  }

  work(): readonly TelegramTransportRecord[] {
    return this.#db
      .prepare(
        "SELECT * FROM telegram_updates WHERE disposition IN (" +
          "'control-pending','control-unknown','delivery-pending','delivery-unknown') " +
          "ORDER BY updated_at,occurrence_key",
      )
      .all()
      .map((row) => this.#decode(row));
  }

  claim(
    occurrenceKey: string,
    expected: "control-pending" | "delivery-pending",
  ): boolean {
    const next =
      expected === "control-pending" ? "control-unknown" : "delivery-unknown";
    return (
      this.#db
        .prepare(
          "UPDATE telegram_updates SET disposition=?,updated_at=? " +
            "WHERE occurrence_key=? AND disposition=?",
        )
        .run(next, this.#time(), occurrenceKey, expected).changes === 1
    );
  }

  recordControlTuple(
    occurrenceKey: string,
    tuple: {
      controlTuple: Readonly<Record<string, unknown>>;
      interactionRef: string;
      responseKind: string;
      deliveryKey: string;
      deliveryOperation: string;
      payloadBytes: Uint8Array;
      payloadDigest: string;
    },
  ): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE telegram_updates SET disposition='delivery-pending',control_tuple_json=?," +
            "interaction_ref=?,response_kind=?,delivery_key=?,delivery_operation=?," +
            "payload_base64url=?,payload_digest=?,updated_at=? " +
            "WHERE occurrence_key=? AND disposition='control-unknown'",
        )
        .run(
          JSON.stringify(tuple.controlTuple),
          tuple.interactionRef,
          tuple.responseKind,
          tuple.deliveryKey,
          tuple.deliveryOperation,
          Buffer.from(tuple.payloadBytes).toString("base64url"),
          tuple.payloadDigest,
          this.#time(),
          occurrenceKey,
        ).changes === 1
    );
  }

  recordDelivery(
    occurrenceKey: string,
    result: { status: "effect"; effectId: string } | { status: "denied" },
  ): boolean {
    const disposition =
      result.status === "effect" ? "delivery-recorded" : "delivery-denied";
    return (
      this.#db
        .prepare(
          "UPDATE telegram_updates SET disposition=?,effect_id=?,updated_at=? " +
            "WHERE occurrence_key=? AND disposition='delivery-unknown'",
        )
        .run(
          disposition,
          result.status === "effect" ? result.effectId : null,
          this.#time(),
          occurrenceKey,
        ).changes === 1
    );
  }

  abandon(
    occurrenceKey: string,
    expected: "control-pending" | "delivery-pending",
    disposition: "abandoned-before-send" | "quarantined-unknown",
  ): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE telegram_updates SET disposition=?,updated_at=? " +
            "WHERE occurrence_key=? AND disposition=?",
        )
        .run(disposition, this.#time(), occurrenceKey, expected).changes === 1
    );
  }

  quarantineUnknown(occurrenceKey: string): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE telegram_updates SET disposition='quarantined-unknown',updated_at=? " +
            "WHERE occurrence_key=? AND disposition IN ('control-unknown','delivery-unknown')",
        )
        .run(this.#time(), occurrenceKey).changes === 1
    );
  }

  close(): void {
    this.#db.close();
  }

  #row(occurrenceKey: string): Record<string, unknown> | undefined {
    return this.#db
      .prepare("SELECT * FROM telegram_updates WHERE occurrence_key=?")
      .get(occurrenceKey);
  }

  #decode(row: Record<string, unknown>): TelegramTransportRecord {
    const string = (field: string): string => {
      if (typeof row[field] !== "string") throw new Error(`invalid_${field}`);
      return row[field] as string;
    };
    const nullable = (field: string): string | null =>
      row[field] === null ? null : string(field);
    const control = nullable("control_tuple_json");
    let controlTuple: Readonly<Record<string, unknown>> | null = null;
    if (control)
      try {
        controlTuple = JSON.parse(control) as Record<string, unknown>;
      } catch {
        throw new Error("invalid_control_tuple");
      }
    const disposition = string("disposition") as TelegramDisposition;
    if (!DISPOSITIONS.includes(disposition))
      throw new Error("invalid_disposition");
    return {
      occurrenceKey: string("occurrence_key"),
      correlationSeed: string("correlation_seed"),
      updateRef: string("update_ref"),
      updateRefDigest: string("update_ref_digest"),
      rawUpdate: Buffer.from(string("raw_update_base64url"), "base64url"),
      rawUpdateDigest: string("raw_update_digest"),
      disposition,
      controlTuple,
      interactionRef: nullable("interaction_ref"),
      responseKind: nullable("response_kind"),
      deliveryKey: nullable("delivery_key"),
      deliveryOperation: nullable("delivery_operation"),
      payloadBytes:
        row.payload_base64url === null
          ? null
          : Buffer.from(string("payload_base64url"), "base64url"),
      payloadDigest: nullable("payload_digest"),
      effectId: nullable("effect_id"),
      updatedAtUnixMs: Number(row.updated_at),
    };
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("invalid_time_authority");
    return value;
  }
}
