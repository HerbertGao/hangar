import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

import {
  digestJson,
  fail,
  ok,
  type CommandMeta,
  type JsonValue,
  type Result,
  type SourceFact,
} from "../contracts/index.ts";
import {
  createControl,
  type CommitPlan,
  type Control,
  type ControlOptions,
  type ControlStore,
  type OutcomeAcceptor,
  type FactDraft,
  type ProjectionRow,
  type StoreSnapshot,
  type TransactOptions,
} from "../control-core/index.ts";

export interface WriteFence {
  readonly databaseIdentity: string;
  readonly targetId: string;
  readonly generation: number;
}

export interface StoreOptions {
  readonly authorityPath: string;
  readonly fence: WriteFence;
  readonly beforeCommit?: () => void;
  readonly afterCommitBeforeAck?: () => void;
}

const ZERO_HASH = "0".repeat(64);
const KNOWN_MAIN_SCHEMA_OBJECTS = new Set([
  "store_meta",
  "commands",
  "source_facts",
  "projections",
]);

function text(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`invalid_${field}`);
  return value;
}

function integer(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`invalid_${field}`);
  return value;
}

function parseJson<T>(value: string): T {
  try {
    // SAFETY: callers immediately use the parsed value through a closed package
    // type, while store-owned writers are the only producers of these columns.
    return JSON.parse(value) as T;
  } catch {
    throw new TypeError("invalid_stored_json");
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("no transaction is active")
    )
      throw error;
  }
}

function record(value: unknown): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid_fact_payload");
  // SAFETY: digestJson below recursively rejects non-JSON values before write.
  return value as Readonly<Record<string, JsonValue>>;
}

function factHash(
  databaseIdentity: string,
  factSeq: number,
  draft: FactDraft,
  previousHash: string,
): string {
  return digestJson({
    databaseIdentity,
    factSeq,
    aggregateId: draft.aggregateId,
    factKind: draft.factKind,
    previousHash,
    payload: draft.payload,
  });
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS store_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      database_identity TEXT NOT NULL,
      authority_identity TEXT NOT NULL,
      target_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation >= 0),
      physical_instance_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
      head_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commands (
      actor_subject_id TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      precondition_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (actor_subject_id, command_kind, target_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS source_facts (
      fact_seq INTEGER PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      fact_kind TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      fact_hash TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projections (
      family TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_fact_seq INTEGER NOT NULL REFERENCES source_facts(fact_seq),
      payload_json TEXT NOT NULL,
      PRIMARY KEY (family, entity_id)
    );
  `);
}

function createAuthoritySchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS authority_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      authority_identity TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS writer_heads (
      database_identity TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
      adopted_physical_id TEXT
    );
  `);
  const existing = db
    .prepare(
      "SELECT authority_identity FROM authority_meta WHERE singleton = 1",
    )
    .get();
  if (!existing)
    db.prepare(
      "INSERT INTO authority_meta(singleton, authority_identity) VALUES (1, ?)",
    ).run(randomUUID());
}

export class RecoveryAuthority {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    createAuthoritySchema(this.#db);
  }

  initialize(databaseIdentity: string, targetId: string): Result<WriteFence> {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const existing = this.#db
        .prepare(
          "SELECT target_id, generation, state FROM writer_heads WHERE database_identity = ?",
        )
        .get(databaseIdentity);
      if (existing) {
        const exact =
          text(existing, "target_id") === targetId &&
          integer(existing, "generation") === 0 &&
          text(existing, "state") === "active";
        this.#db.exec("ROLLBACK");
        return exact
          ? ok({ databaseIdentity, targetId, generation: 0 })
          : fail("stale_authority");
      }
      this.#db
        .prepare(
          "INSERT INTO writer_heads(database_identity, target_id, generation, state, adopted_physical_id) VALUES (?, ?, 0, 'active', NULL)",
        )
        .run(databaseIdentity, targetId);
      this.#db.exec("COMMIT");
      return ok({ databaseIdentity, targetId, generation: 0 });
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  claimRestore(
    databaseIdentity: string,
    expectedGeneration: number,
    targetId: string,
  ): Result<WriteFence> {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const next = expectedGeneration + 1;
      const changed = this.#db
        .prepare(
          `UPDATE writer_heads
           SET target_id = ?, generation = ?, adopted_physical_id = NULL
           WHERE database_identity = ? AND generation = ? AND state = 'active'`,
        )
        .run(targetId, next, databaseIdentity, expectedGeneration).changes;
      if (changed !== 1) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      this.#db.exec("COMMIT");
      return ok({ databaseIdentity, targetId, generation: next });
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  close(): void {
    this.#db.close();
  }
}

class SQLiteControlStore implements ControlStore {
  readonly #db: DatabaseSync;
  readonly #options: StoreOptions;
  readonly #physicalInstanceId: string;

  constructor(path: string, options: StoreOptions) {
    this.#options = options;
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const file = statSync(path, { bigint: true });
    this.#physicalInstanceId = `${file.dev}:${file.ino}`;
    try {
      this.#db.exec(
        "PRAGMA busy_timeout = 2000; PRAGMA main.locking_mode = EXCLUSIVE",
      );
      const existingObjects = this.#db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
      const hasMeta = existingObjects.some(
        (row) => text(row, "name") === "store_meta",
      );
      if (!hasMeta && existingObjects.length !== 0)
        throw new Error("missing_database_identity");
      if (
        hasMeta &&
        existingObjects.some(
          (row) =>
            text(row, "type") !== "table" ||
            !KNOWN_MAIN_SCHEMA_OBJECTS.has(text(row, "name")),
        )
      )
        throw new Error("unknown_schema_object");
      if (hasMeta) {
        const identity = this.#db
          .prepare(
            "SELECT database_identity FROM store_meta WHERE singleton = 1",
          )
          .get();
        if (
          !identity ||
          text(identity, "database_identity") !== options.fence.databaseIdentity
        )
          throw new Error("database_identity_mismatch");
        const local = this.#db
          .prepare(
            `SELECT target_id, authority_generation, physical_instance_id
             FROM store_meta WHERE singleton = 1`,
          )
          .get();
        if (
          !local ||
          (text(local, "target_id") === options.fence.targetId &&
            integer(local, "authority_generation") ===
              options.fence.generation &&
            text(local, "physical_instance_id") !== this.#physicalInstanceId)
        )
          throw new Error("physical_instance_mismatch");
      }

      this.#db
        .prepare("ATTACH DATABASE ? AS authority")
        .run(options.authorityPath);
      this.#db.exec("BEGIN IMMEDIATE");
      const authorityMeta = this.#db
        .prepare(
          "SELECT authority_identity FROM authority.authority_meta WHERE singleton = 1",
        )
        .get();
      if (!authorityMeta) throw new Error("missing_authority_identity");
      const authorityIdentity = text(authorityMeta, "authority_identity");
      if (hasMeta) {
        const localAuthority = this.#db
          .prepare(
            "SELECT authority_identity FROM main.store_meta WHERE singleton = 1",
          )
          .get();
        if (
          !localAuthority ||
          text(localAuthority, "authority_identity") !== authorityIdentity
        )
          throw new Error("authority_identity_mismatch");
      }
      const authority = this.#db
        .prepare(
          `SELECT generation, adopted_physical_id FROM authority.writer_heads
           WHERE database_identity = ? AND target_id = ? AND generation = ? AND state = 'active'`,
        )
        .get(
          options.fence.databaseIdentity,
          options.fence.targetId,
          options.fence.generation,
        );
      if (!authority) throw new Error("stale_authority");
      if (options.fence.generation === 0) {
        const claimed = this.#db
          .prepare(
            `UPDATE authority.writer_heads SET adopted_physical_id = ?
             WHERE database_identity = ? AND target_id = ? AND generation = 0
               AND state = 'active'
               AND (adopted_physical_id IS NULL OR adopted_physical_id = ?)`,
          )
          .run(
            this.#physicalInstanceId,
            options.fence.databaseIdentity,
            options.fence.targetId,
            this.#physicalInstanceId,
          ).changes;
        if (claimed !== 1) throw new Error("physical_instance_mismatch");
      }
      createSchema(this.#db);
      const meta = this.#db
        .prepare("SELECT singleton FROM store_meta WHERE singleton = 1")
        .get();
      if (!meta)
        this.#db
          .prepare(
            `INSERT INTO store_meta(
               singleton, database_identity, authority_identity, target_id,
               authority_generation, physical_instance_id, revision,
               head_seq, head_hash
             ) VALUES (1, ?, ?, ?, ?, ?, 0, 0, ?)`,
          )
          .run(
            options.fence.databaseIdentity,
            authorityIdentity,
            options.fence.targetId,
            options.fence.generation,
            this.#physicalInstanceId,
            ZERO_HASH,
          );
      this.#db.exec("COMMIT");
      this.#db.exec(
        "BEGIN EXCLUSIVE; SELECT singleton FROM store_meta; COMMIT",
      );
    } catch (error) {
      rollback(this.#db);
      this.#db.close();
      throw error;
    }
  }

  #readSnapshot(): StoreSnapshot {
    const meta = this.#db
      .prepare(
        "SELECT revision, head_seq, head_hash, database_identity FROM store_meta WHERE singleton = 1",
      )
      .get();
    if (!meta) throw new Error("missing_store_meta");
    const databaseIdentity = text(meta, "database_identity");
    const rows = this.#db
      .prepare(
        `SELECT fact_seq, aggregate_id, fact_kind, previous_hash, fact_hash, payload_json
         FROM source_facts ORDER BY fact_seq`,
      )
      .all();
    const facts: SourceFact[] = [];
    let expectedSeq = 1;
    let previousHash = ZERO_HASH;
    for (const row of rows) {
      const factSeq = integer(row, "fact_seq");
      const draft: FactDraft = {
        aggregateId: text(row, "aggregate_id"),
        factKind: text(row, "fact_kind"),
        payload: record(parseJson(text(row, "payload_json"))),
      };
      const storedPrevious = text(row, "previous_hash");
      const storedHash = text(row, "fact_hash");
      if (
        factSeq !== expectedSeq ||
        storedPrevious !== previousHash ||
        storedHash !== factHash(databaseIdentity, factSeq, draft, previousHash)
      )
        throw new Error("fact_chain_invalid");
      facts.push({
        factSeq,
        aggregateId: draft.aggregateId,
        factKind: draft.factKind,
        previousHash,
        factHash: storedHash,
        payload: draft.payload,
      });
      expectedSeq += 1;
      previousHash = storedHash;
    }
    if (
      integer(meta, "head_seq") !== facts.length ||
      text(meta, "head_hash") !== previousHash
    )
      throw new Error("fact_head_invalid");
    const projections = this.#db
      .prepare(
        "SELECT family, entity_id, source_fact_seq, payload_json FROM projections ORDER BY family, entity_id",
      )
      .all()
      .map((row) => ({
        family: text(row, "family") as ProjectionRow["family"],
        entityId: text(row, "entity_id"),
        sourceFactSeq: integer(row, "source_fact_seq"),
        payload: parseJson<JsonValue>(text(row, "payload_json")),
      }));
    return {
      revision: integer(meta, "revision"),
      headSeq: facts.length,
      facts,
      projections,
    };
  }

  readSnapshot(): Result<StoreSnapshot> {
    try {
      return ok(this.#readSnapshot());
    } catch {
      return fail("invalid_state");
    }
  }

  canWrite(): boolean {
    try {
      return this.#fence();
    } catch {
      return false;
    }
  }

  #fence(): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE authority.writer_heads SET generation = generation
           WHERE database_identity = ? AND target_id = ? AND generation = ? AND state = 'active'
             AND adopted_physical_id = (
               SELECT physical_instance_id FROM main.store_meta WHERE singleton = 1
             )`,
        )
        .run(
          this.#options.fence.databaseIdentity,
          this.#options.fence.targetId,
          this.#options.fence.generation,
        ).changes === 1
    );
  }

  transact<T>(
    meta: CommandMeta,
    decide: (snapshot: StoreSnapshot) => Result<CommitPlan<T>>,
    options: TransactOptions = {},
  ): Result<T> {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const stored = this.#db
        .prepare(
          `SELECT payload_digest, precondition_digest, result_json FROM commands
           WHERE actor_subject_id = ? AND command_kind = ? AND target_id = ? AND idempotency_key = ?`,
        )
        .get(
          meta.actorSubjectId,
          meta.commandKind,
          meta.targetId,
          meta.idempotencyKey,
        );
      if (stored) {
        if (!this.#fence()) {
          this.#db.exec("ROLLBACK");
          return fail("stale_authority");
        }
        const exact =
          text(stored, "payload_digest") === meta.payloadDigest &&
          text(stored, "precondition_digest") === meta.preconditionDigest;
        let result: Result<T>;
        if (!exact) result = fail("idempotency_conflict");
        else if (options.rejectReplay) result = fail("invalid_state");
        else result = parseJson<Result<T>>(text(stored, "result_json"));
        this.#db.exec("ROLLBACK");
        return result;
      }

      const snapshot = this.#readSnapshot();
      const decision = decide(snapshot);
      if (!decision.ok) {
        this.#db.exec("ROLLBACK");
        return decision;
      }
      if (
        decision.value.expectedRevision !== snapshot.revision ||
        !this.#fence()
      ) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      const metaUpdate = this.#db
        .prepare(
          `UPDATE store_meta SET revision = revision + 1
           WHERE singleton = 1 AND revision = ? AND target_id = ? AND authority_generation = ?`,
        )
        .run(
          snapshot.revision,
          this.#options.fence.targetId,
          this.#options.fence.generation,
        ).changes;
      if (metaUpdate !== 1) {
        this.#db.exec("ROLLBACK");
        return fail("invalid_state");
      }

      let factSeq = snapshot.headSeq;
      let previousHash = snapshot.facts.at(-1)?.factHash ?? ZERO_HASH;
      for (const draft of decision.value.facts) {
        factSeq += 1;
        const hash = factHash(
          this.#options.fence.databaseIdentity,
          factSeq,
          draft,
          previousHash,
        );
        this.#db
          .prepare(
            `INSERT INTO source_facts(
               fact_seq, aggregate_id, fact_kind, previous_hash, fact_hash, payload_json
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            factSeq,
            draft.aggregateId,
            draft.factKind,
            previousHash,
            hash,
            JSON.stringify(draft.payload),
          );
        previousHash = hash;
      }
      this.#db
        .prepare(
          "UPDATE store_meta SET head_seq = ?, head_hash = ? WHERE singleton = 1",
        )
        .run(factSeq, previousHash);
      this.#replaceProjectionRows(decision.value.projections);
      const storedResult: Result<T> = ok(decision.value.result);
      this.#db
        .prepare(
          `INSERT INTO commands(
             actor_subject_id, command_kind, target_id, idempotency_key,
             payload_digest, precondition_digest, result_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meta.actorSubjectId,
          meta.commandKind,
          meta.targetId,
          meta.idempotencyKey,
          meta.payloadDigest,
          meta.preconditionDigest,
          JSON.stringify(storedResult),
        );
      this.#options.beforeCommit?.();
      this.#db.exec("COMMIT");
      this.#options.afterCommitBeforeAck?.();
      return storedResult;
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  #replaceProjectionRows(rows: readonly ProjectionRow[]): void {
    this.#db.exec("DELETE FROM projections");
    const insert = this.#db.prepare(
      `INSERT INTO projections(family, entity_id, source_fact_seq, payload_json)
       VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows)
      insert.run(
        row.family,
        row.entityId,
        row.sourceFactSeq,
        JSON.stringify(row.payload),
      );
  }

  replaceProjections(
    expectedHeadSeq: number,
    rows: readonly ProjectionRow[],
  ): Result<null> {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      if (!this.#fence()) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      const updated = this.#db
        .prepare(
          "UPDATE store_meta SET revision = revision + 1 WHERE singleton = 1 AND head_seq = ?",
        )
        .run(expectedHeadSeq).changes;
      if (updated !== 1) {
        this.#db.exec("ROLLBACK");
        return fail("invalid_state");
      }
      this.#replaceProjectionRows(rows);
      this.#db.exec("COMMIT");
      return ok(null);
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  clearProjections(): Result<null> {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      if (!this.#fence()) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      this.#db.exec("DELETE FROM projections");
      this.#db.exec("COMMIT");
      return ok(null);
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  adoptFence(previous: WriteFence, next: WriteFence): Result<null> {
    const physicalInstanceId = this.#physicalInstanceId;
    if (previous.databaseIdentity !== next.databaseIdentity)
      return fail("stale_authority");
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const localState = this.#db
        .prepare(
          `SELECT target_id, authority_generation, physical_instance_id
           FROM store_meta WHERE singleton = 1`,
        )
        .get();
      const authorityState = this.#db
        .prepare(
          `SELECT adopted_physical_id FROM authority.writer_heads
           WHERE database_identity = ? AND target_id = ? AND generation = ? AND state = 'active'`,
        )
        .get(next.databaseIdentity, next.targetId, next.generation);
      const alreadyAdopted =
        localState &&
        authorityState &&
        text(localState, "target_id") === next.targetId &&
        integer(localState, "authority_generation") === next.generation &&
        text(localState, "physical_instance_id") === physicalInstanceId &&
        authorityState.adopted_physical_id === physicalInstanceId;
      if (alreadyAdopted) {
        this.#db.exec("ROLLBACK");
        return ok(null);
      }
      const authority = this.#db
        .prepare(
          `UPDATE authority.writer_heads SET adopted_physical_id = ?
           WHERE database_identity = ? AND target_id = ? AND generation = ?
             AND state = 'active' AND adopted_physical_id IS NULL`,
        )
        .run(
          physicalInstanceId,
          next.databaseIdentity,
          next.targetId,
          next.generation,
        ).changes;
      if (authority !== 1) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      const local = this.#db
        .prepare(
          `UPDATE store_meta
           SET target_id = ?, authority_generation = ?, physical_instance_id = ?, revision = revision + 1
           WHERE singleton = 1 AND database_identity = ? AND target_id = ? AND authority_generation = ?`,
        )
        .run(
          next.targetId,
          next.generation,
          physicalInstanceId,
          previous.databaseIdentity,
          previous.targetId,
          previous.generation,
        ).changes;
      if (local !== 1) {
        this.#db.exec("ROLLBACK");
        return fail("stale_authority");
      }
      this.#db.exec("COMMIT");
      return ok(null);
    } catch {
      rollback(this.#db);
      return fail("invalid_state");
    }
  }

  async backupTo(destinationPath: string): Promise<void> {
    await backup(this.#db, destinationPath);
  }

  close(): void {
    this.#db.close();
  }
}

export interface SQLiteControlRuntime {
  readonly control: Control;
  readonly outcomes: OutcomeAcceptor;
  readSnapshot(): Result<StoreSnapshot>;
  clearProjections(): Result<null>;
  adoptFence(previous: WriteFence, next: WriteFence): Result<null>;
  backupTo(destinationPath: string): Promise<void>;
  close(): void;
}

export function openSqliteControl(
  path: string,
  options: StoreOptions,
  controlOptions: ControlOptions = {},
): SQLiteControlRuntime {
  const store = new SQLiteControlStore(path, options);
  const { control, outcomes } = createControl(store, controlOptions);
  if (store.canWrite()) {
    const ensured = control.ensureProjections();
    if (!ensured.ok) {
      store.close();
      throw new Error(ensured.error);
    }
  }
  return {
    control,
    outcomes,
    readSnapshot: () => store.readSnapshot(),
    clearProjections: () => store.clearProjections(),
    adoptFence: (previous, next) => {
      const adopted = store.adoptFence(previous, next);
      return adopted.ok ? control.ensureProjections() : adopted;
    },
    backupTo: (destinationPath) => store.backupTo(destinationPath),
    close: () => store.close(),
  };
}
