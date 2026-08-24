import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, type AuthorityContext } from "../contracts/index.ts";

export type CredentialKind = "cli_bearer" | "bootstrap" | "telegram_service";
export type AuthError =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "gone"
  | "auth_store_failure";

export interface AuthStoreOptions {
  readonly nowUnixMs: () => number;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly sessionTtlMs?: number;
  readonly renewalGraceMs?: number;
  readonly beforeCommit?: () => void;
  readonly afterCommitBeforeAck?: () => void;
}

export interface SessionHeaders {
  readonly setCookie: readonly [string, string, string];
  readonly cacheControl: "no-store";
  readonly expiresAtUnixMs: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export type SessionExchangeResult =
  | {
      readonly ok: true;
      readonly status: 204;
      readonly headers: SessionHeaders;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 409 | 410 | 500;
      readonly error: AuthError;
      readonly predecessorHint?: string;
    };

export interface SessionExchangeInput {
  readonly action: "establish" | "renew";
  readonly bootstrapToken: string;
  readonly origin: string;
  readonly predecessorHeader?: string;
  readonly hintCookie?: string;
  /** Syntax checked by wire layer, but intentionally ignored as authority. */
  readonly ambientSessionCookie?: string;
}

interface CredentialRow {
  hash: string;
  kind: CredentialKind;
  generation: number;
  principalId: string;
  scopes: readonly string[];
  revokedAt: number | null;
}

interface SessionRow {
  sessionId: string;
  bootstrapGeneration: number;
  sessionGeneration: number;
  state: "active" | "expired" | "superseded" | "revoked";
  expiresAt: number;
  renewGraceUntil: number;
  predecessorSessionId: string | null;
  successorSessionId: string | null;
  hmacKeyGeneration: number;
  principalId: string;
}

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const text = (row: Record<string, unknown>, field: string): string => {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`invalid_${field}`);
  return value;
};
const integer = (row: Record<string, unknown>, field: string): number => {
  const value = row[field];
  if (!Number.isSafeInteger(value)) throw new Error(`invalid_${field}`);
  return value as number;
};
const nullableText = (
  row: Record<string, unknown>,
  field: string,
): string | null => (row[field] === null ? null : text(row, field));
const nullableInteger = (
  row: Record<string, unknown>,
  field: string,
): number | null => (row[field] === null ? null : integer(row, field));

const hmac = (secret: string, value: unknown): string =>
  createHmac("sha256", secret).update(canonicalJson(value)).digest("base64url");
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no transaction"))
      throw error;
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS auth_credentials(
      credential_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('cli_bearer','bootstrap','telegram_service')),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      principal_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      revoked_at INTEGER,
      UNIQUE(kind, generation)
    );
    CREATE TABLE IF NOT EXISTS auth_hmac_keys(
      key_generation INTEGER PRIMARY KEY CHECK(key_generation >= 1),
      secret_ref TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('active','retired'))
    );
    CREATE TABLE IF NOT EXISTS auth_sessions(
      session_id TEXT PRIMARY KEY,
      bootstrap_generation INTEGER NOT NULL,
      session_generation INTEGER NOT NULL CHECK(session_generation >= 1),
      state TEXT NOT NULL CHECK(state IN ('active','expired','superseded','revoked')),
      expires_at INTEGER NOT NULL,
      renew_grace_until INTEGER NOT NULL,
      predecessor_session_id TEXT UNIQUE,
      successor_session_id TEXT UNIQUE,
      hmac_key_generation INTEGER NOT NULL REFERENCES auth_hmac_keys(key_generation),
      principal_id TEXT NOT NULL,
      UNIQUE(bootstrap_generation, session_generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS auth_one_active_session
      ON auth_sessions(bootstrap_generation) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS auth_exchanges(
      exchange_identity TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK(action IN ('establish','renew')),
      status_code INTEGER NOT NULL,
      session_id TEXT,
      predecessor_hint TEXT,
      hmac_key_generation INTEGER NOT NULL REFERENCES auth_hmac_keys(key_generation),
      committed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_allowlist(
      service_principal_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      mapping_version INTEGER NOT NULL,
      represented_subject_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      PRIMARY KEY(service_principal_id,user_id,chat_id,mapping_version)
    );
  `);
}

export class Authenticator {
  readonly #db: DatabaseSync;
  readonly #options: AuthStoreOptions;

  constructor(path: string, options: AuthStoreOptions) {
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.#options = options;
    createSchema(this.#db);
  }

  putCredential(input: {
    rawToken: string;
    kind: CredentialKind;
    generation: number;
    principalId: string;
    scopes: readonly string[];
  }): void {
    this.#db
      .prepare(
        "INSERT INTO auth_credentials(credential_hash,kind,generation,principal_id,scope_json,revoked_at) " +
          "VALUES(?,?,?,?,?,NULL)",
      )
      .run(
        hash(input.rawToken),
        input.kind,
        input.generation,
        input.principalId,
        JSON.stringify([...new Set(input.scopes)].sort()),
      );
  }

  revokeCredential(kind: CredentialKind, generation: number): void {
    this.#db
      .prepare(
        "UPDATE auth_credentials SET revoked_at = ? WHERE kind = ? AND generation = ?",
      )
      .run(this.#now(), kind, generation);
  }

  putHmacKey(generation: number, secretRef: string, active = true): void {
    this.#transaction(() => {
      if (active)
        this.#db.prepare("UPDATE auth_hmac_keys SET state = 'retired'").run();
      this.#db
        .prepare(
          "INSERT INTO auth_hmac_keys(key_generation,secret_ref,state) VALUES(?,?,?)",
        )
        .run(generation, secretRef, active ? "active" : "retired");
    });
  }

  putTelegramMapping(input: {
    servicePrincipalId: string;
    userId: string;
    chatId: string;
    mappingVersion: number;
    representedSubjectId: string;
    scopes: readonly string[];
  }): void {
    this.#db
      .prepare(
        "INSERT INTO telegram_allowlist(service_principal_id,user_id,chat_id,mapping_version," +
          "represented_subject_id,scope_json,active) VALUES(?,?,?,?,?,?,1)",
      )
      .run(
        input.servicePrincipalId,
        input.userId,
        input.chatId,
        input.mappingVersion,
        input.representedSubjectId,
        JSON.stringify([...new Set(input.scopes)].sort()),
      );
  }

  exchangeSession(input: SessionExchangeInput): SessionExchangeResult {
    if (input.origin !== this.#options.origin)
      return { ok: false, status: 403, error: "forbidden" };
    const credential = this.#credential(input.bootstrapToken, "bootstrap");
    if (!credential || credential.revokedAt !== null)
      return { ok: false, status: 401, error: "unauthorized" };
    return input.action === "establish"
      ? this.#establish(credential)
      : this.#renew(credential, input);
  }

  authenticateBearer(
    rawToken: string,
    kind: "cli_bearer" | "telegram_service" = "cli_bearer",
  ): AuthorityContext | undefined {
    const credential = this.#credential(rawToken, kind);
    if (!credential || credential.revokedAt !== null) return undefined;
    return this.#authority(
      credential,
      credential.principalId,
      kind === "telegram_service" ? "telegram-adapter" : "hangar-control",
    );
  }

  authenticateSession(sessionCookie: string): AuthorityContext | undefined {
    const claims = this.#decodeEnvelope(sessionCookie);
    if (!claims) return undefined;
    const session = this.#session(String(claims.sessionId));
    if (
      !session ||
      session.state !== "active" ||
      session.expiresAt <= this.#now() ||
      session.sessionGeneration !== claims.sessionGeneration ||
      session.bootstrapGeneration !== claims.bootstrapGeneration ||
      session.hmacKeyGeneration !== claims.keyGeneration
    )
      return undefined;
    const key = this.#key(session.hmacKeyGeneration);
    if (!key || !this.#verifyEnvelope(sessionCookie, key.secret))
      return undefined;
    const credential = this.#credentialByGeneration(
      "bootstrap",
      session.bootstrapGeneration,
    );
    if (!credential || credential.revokedAt !== null) return undefined;
    return this.#authority(credential, session.principalId, "hangar-control");
  }

  authenticateTelegram(input: {
    serviceToken: string;
    userId: string;
    chatId: string;
    mappingVersion: number;
  }): AuthorityContext | undefined {
    const service = this.#credential(input.serviceToken, "telegram_service");
    if (!service || service.revokedAt !== null) return undefined;
    const mapping = this.#db
      .prepare(
        "SELECT represented_subject_id,scope_json FROM telegram_allowlist WHERE " +
          "service_principal_id=? AND user_id=? AND chat_id=? AND mapping_version=? AND active=1",
      )
      .get(
        service.principalId,
        input.userId,
        input.chatId,
        input.mappingVersion,
      );
    if (!mapping) return undefined;
    return this.#authority(
      { ...service, scopes: this.#scopes(text(mapping, "scope_json")) },
      text(mapping, "represented_subject_id"),
      "hangar-control",
    );
  }

  verifyWriteCsrfOrigin(input: {
    sessionCookie: string;
    csrfCookie: string;
    csrfHeader: string;
    origin: string;
  }): boolean {
    if (
      input.origin !== this.#options.origin ||
      input.csrfCookie !== input.csrfHeader
    )
      return false;
    const claims = this.#decodeEnvelope(input.sessionCookie);
    if (!claims) return false;
    const session = this.#session(String(claims.sessionId));
    if (!session || !this.authenticateSession(input.sessionCookie))
      return false;
    const key = this.#key(session.hmacKeyGeneration);
    return key ? equal(input.csrfHeader, this.#csrf(key, session)) : false;
  }

  close(): void {
    this.#db.close();
  }

  #establish(credential: CredentialRow): SessionExchangeResult {
    const identity = hash(
      canonicalJson([
        "auth-establish-v1",
        credential.hash,
        credential.generation,
      ]),
    );
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const prior = this.#db
        .prepare(
          "SELECT session_id FROM auth_exchanges WHERE exchange_identity=?",
        )
        .get(identity);
      if (prior) {
        const session = this.#session(text(prior, "session_id"));
        const result = session
          ? this.#establishReplay(session)
          : ({ ok: false, status: 500, error: "auth_store_failure" } as const);
        this.#db.exec("ROLLBACK");
        return result;
      }
      const activeRow = this.#db
        .prepare(
          "SELECT * FROM auth_sessions WHERE bootstrap_generation=? AND state='active'",
        )
        .get(credential.generation);
      if (activeRow) {
        const session = this.#decodeSession(activeRow);
        const key = this.#key(session.hmacKeyGeneration);
        if (!key) {
          this.#db.exec("ROLLBACK");
          return { ok: false, status: 500, error: "auth_store_failure" };
        }
        const hint = this.#hint(key, session);
        this.#db
          .prepare(
            "INSERT INTO auth_exchanges(exchange_identity,action,status_code,session_id," +
              "predecessor_hint,hmac_key_generation,committed_at) VALUES(?,'establish',?,?,?,?,?)",
          )
          .run(
            identity,
            session.expiresAt > this.#now() ? 204 : 410,
            session.sessionId,
            hint,
            session.hmacKeyGeneration,
            this.#now(),
          );
        this.#commit();
        return session.expiresAt > this.#now()
          ? this.#render(session)
          : { ok: false, status: 410, error: "gone", predecessorHint: hint };
      }
      const key = this.#activeKey();
      if (!key) {
        this.#db.exec("ROLLBACK");
        return { ok: false, status: 500, error: "auth_store_failure" };
      }
      const now = this.#now();
      const session: SessionRow = {
        sessionId: randomUUID(),
        bootstrapGeneration: credential.generation,
        sessionGeneration: 1,
        state: "active",
        expiresAt: now + (this.#options.sessionTtlMs ?? 60_000),
        renewGraceUntil:
          now +
          (this.#options.sessionTtlMs ?? 60_000) +
          (this.#options.renewalGraceMs ?? 300_000),
        predecessorSessionId: null,
        successorSessionId: null,
        hmacKeyGeneration: key.generation,
        principalId: credential.principalId,
      };
      this.#insertSession(session);
      const hint = this.#hint(key, session);
      this.#db
        .prepare(
          "INSERT INTO auth_exchanges(exchange_identity,action,status_code,session_id," +
            "predecessor_hint,hmac_key_generation,committed_at) VALUES(?,'establish',204,?,?,?,?)",
        )
        .run(identity, session.sessionId, hint, key.generation, now);
      this.#commit();
      return this.#render(session);
    } catch {
      rollback(this.#db);
      return { ok: false, status: 500, error: "auth_store_failure" };
    }
  }

  #renew(
    credential: CredentialRow,
    input: SessionExchangeInput,
  ): SessionExchangeResult {
    if (
      !input.predecessorHeader ||
      (input.hintCookie !== undefined &&
        input.hintCookie !== input.predecessorHeader)
    )
      return { ok: false, status: 400, error: "bad_request" };
    const untrusted = this.#decodeEnvelope(input.predecessorHeader);
    if (!untrusted) return { ok: false, status: 400, error: "bad_request" };
    const predecessor = this.#session(String(untrusted.sessionId));
    if (
      !predecessor ||
      predecessor.bootstrapGeneration !== credential.generation
    )
      return { ok: false, status: 409, error: "conflict" };
    const predecessorKey = this.#key(predecessor.hmacKeyGeneration);
    if (
      !predecessorKey ||
      !this.#verifyEnvelope(input.predecessorHeader, predecessorKey.secret)
    )
      return { ok: false, status: 500, error: "auth_store_failure" };
    const identity = hash(
      canonicalJson([
        "auth-renew-v1",
        credential.hash,
        credential.generation,
        predecessor.sessionId,
        predecessor.sessionGeneration,
      ]),
    );
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const prior = this.#db
        .prepare(
          "SELECT session_id FROM auth_exchanges WHERE exchange_identity=?",
        )
        .get(identity);
      if (prior) {
        const successor = this.#session(text(prior, "session_id"));
        const result = successor
          ? this.#render(successor)
          : ({ ok: false, status: 500, error: "auth_store_failure" } as const);
        this.#db.exec("ROLLBACK");
        return result;
      }
      const now = this.#now();
      if (predecessor.expiresAt > now) {
        this.#db.exec("ROLLBACK");
        return { ok: false, status: 409, error: "conflict" };
      }
      if (predecessor.renewGraceUntil < now) {
        this.#db.exec("ROLLBACK");
        return { ok: false, status: 410, error: "gone" };
      }
      if (predecessor.successorSessionId) {
        const successor = this.#session(predecessor.successorSessionId);
        this.#db.exec("ROLLBACK");
        return successor
          ? this.#render(successor)
          : { ok: false, status: 500, error: "auth_store_failure" };
      }
      const key = this.#activeKey();
      if (!key) {
        this.#db.exec("ROLLBACK");
        return { ok: false, status: 500, error: "auth_store_failure" };
      }
      const successor: SessionRow = {
        sessionId: randomUUID(),
        bootstrapGeneration: predecessor.bootstrapGeneration,
        sessionGeneration: predecessor.sessionGeneration + 1,
        state: "active",
        expiresAt: now + (this.#options.sessionTtlMs ?? 60_000),
        renewGraceUntil:
          now +
          (this.#options.sessionTtlMs ?? 60_000) +
          (this.#options.renewalGraceMs ?? 300_000),
        predecessorSessionId: predecessor.sessionId,
        successorSessionId: null,
        hmacKeyGeneration: key.generation,
        principalId: predecessor.principalId,
      };
      this.#db
        .prepare(
          "UPDATE auth_sessions SET state='superseded',successor_session_id=? WHERE session_id=?",
        )
        .run(successor.sessionId, predecessor.sessionId);
      this.#insertSession(successor);
      const hint = this.#hint(key, successor);
      this.#db
        .prepare(
          "INSERT INTO auth_exchanges(exchange_identity,action,status_code,session_id," +
            "predecessor_hint,hmac_key_generation,committed_at) VALUES(?,'renew',204,?,?,?,?)",
        )
        .run(identity, successor.sessionId, hint, key.generation, now);
      this.#commit();
      return this.#render(successor);
    } catch {
      rollback(this.#db);
      return { ok: false, status: 500, error: "auth_store_failure" };
    }
  }

  #establishReplay(session: SessionRow): SessionExchangeResult {
    const key = this.#key(session.hmacKeyGeneration);
    if (!key) return { ok: false, status: 500, error: "auth_store_failure" };
    return session.expiresAt > this.#now()
      ? this.#render(session)
      : {
          ok: false,
          status: 410,
          error: "gone",
          predecessorHint: this.#hint(key, session),
        };
  }

  #render(session: SessionRow): SessionExchangeResult {
    const key = this.#key(session.hmacKeyGeneration);
    if (!key) return { ok: false, status: 500, error: "auth_store_failure" };
    const sessionToken = this.#signedEnvelope(key, {
      schemaVersion: "hangar-session-v1",
      sessionId: session.sessionId,
      bootstrapGeneration: session.bootstrapGeneration,
      sessionGeneration: session.sessionGeneration,
      expiresAtUnixMs: session.expiresAt,
      keyGeneration: session.hmacKeyGeneration,
    });
    const csrf = this.#csrf(key, session);
    const hint = this.#hint(key, session);
    const secure = this.#options.secureCookies ? "; Secure" : "";
    return {
      ok: true,
      status: 204,
      headers: {
        setCookie: [
          `hangar_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict${secure}`,
          `hangar_csrf=${csrf}; Path=/; SameSite=Strict${secure}`,
          `hangar_session_hint=${hint}; Path=/; SameSite=Strict${secure}`,
        ],
        cacheControl: "no-store",
        expiresAtUnixMs: session.expiresAt,
        sessionId: session.sessionId,
        sessionGeneration: session.sessionGeneration,
      },
    };
  }

  #csrf(
    key: { generation: number; secretRef: string; secret: string },
    session: SessionRow,
  ): string {
    return hmac(key.secret, [
      "hangar-csrf-v1",
      key.secretRef,
      session.sessionId,
      session.sessionGeneration,
      session.expiresAt,
    ]);
  }

  #hint(
    key: { generation: number; secretRef: string; secret: string },
    session: SessionRow,
  ): string {
    return this.#signedEnvelope(key, {
      schemaVersion: "hangar-hint-v1",
      bootstrapGeneration: session.bootstrapGeneration,
      sessionId: session.sessionId,
      sessionGeneration: session.sessionGeneration,
      expiresAtUnixMs: session.renewGraceUntil,
      keyGeneration: key.generation,
    });
  }

  #signedEnvelope(
    key: { generation: number; secretRef: string; secret: string },
    claims: Record<string, unknown>,
  ): string {
    const mac = hmac(key.secret, [
      "hangar-auth-envelope-v1",
      key.secretRef,
      claims,
    ]);
    return Buffer.from(canonicalJson({ claims, mac })).toString("base64url");
  }

  #verifyEnvelope(encoded: string, secret: string): boolean {
    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as { claims: Record<string, unknown>; mac: string };
      const generation = Number(parsed.claims.keyGeneration);
      const key = this.#key(generation);
      if (!key || key.secret !== secret) return false;
      const expected = hmac(secret, [
        "hangar-auth-envelope-v1",
        key.secretRef,
        parsed.claims,
      ]);
      return typeof parsed.mac === "string" && equal(parsed.mac, expected);
    } catch {
      return false;
    }
  }

  #decodeEnvelope(encoded: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as { claims?: unknown };
      return parsed.claims && typeof parsed.claims === "object"
        ? (parsed.claims as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  #credential(raw: string, kind: CredentialKind): CredentialRow | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM auth_credentials WHERE credential_hash=? AND kind=?",
      )
      .get(hash(raw), kind);
    return row ? this.#decodeCredential(row) : undefined;
  }

  #credentialByGeneration(
    kind: CredentialKind,
    generation: number,
  ): CredentialRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM auth_credentials WHERE kind=? AND generation=?")
      .get(kind, generation);
    return row ? this.#decodeCredential(row) : undefined;
  }

  #decodeCredential(row: Record<string, unknown>): CredentialRow {
    return {
      hash: text(row, "credential_hash"),
      kind: text(row, "kind") as CredentialKind,
      generation: integer(row, "generation"),
      principalId: text(row, "principal_id"),
      scopes: this.#scopes(text(row, "scope_json")),
      revokedAt: nullableInteger(row, "revoked_at"),
    };
  }

  #session(id: string): SessionRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM auth_sessions WHERE session_id=?")
      .get(id);
    return row ? this.#decodeSession(row) : undefined;
  }

  #decodeSession(row: Record<string, unknown>): SessionRow {
    return {
      sessionId: text(row, "session_id"),
      bootstrapGeneration: integer(row, "bootstrap_generation"),
      sessionGeneration: integer(row, "session_generation"),
      state: text(row, "state") as SessionRow["state"],
      expiresAt: integer(row, "expires_at"),
      renewGraceUntil: integer(row, "renew_grace_until"),
      predecessorSessionId: nullableText(row, "predecessor_session_id"),
      successorSessionId: nullableText(row, "successor_session_id"),
      hmacKeyGeneration: integer(row, "hmac_key_generation"),
      principalId: text(row, "principal_id"),
    };
  }

  #insertSession(session: SessionRow): void {
    this.#db
      .prepare(
        "INSERT INTO auth_sessions(session_id,bootstrap_generation,session_generation,state," +
          "expires_at,renew_grace_until,predecessor_session_id,successor_session_id," +
          "hmac_key_generation,principal_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        session.sessionId,
        session.bootstrapGeneration,
        session.sessionGeneration,
        session.state,
        session.expiresAt,
        session.renewGraceUntil,
        session.predecessorSessionId,
        session.successorSessionId,
        session.hmacKeyGeneration,
        session.principalId,
      );
  }

  #key(
    generation: number,
  ): { generation: number; secretRef: string; secret: string } | undefined {
    const row = this.#db
      .prepare("SELECT secret_ref FROM auth_hmac_keys WHERE key_generation=?")
      .get(generation);
    if (!row) return undefined;
    const secretRef = text(row, "secret_ref");
    const secret = this.#options.resolveSecret(secretRef);
    return secret ? { generation, secretRef, secret } : undefined;
  }

  #activeKey():
    | { generation: number; secretRef: string; secret: string }
    | undefined {
    const row = this.#db
      .prepare("SELECT key_generation FROM auth_hmac_keys WHERE state='active'")
      .get();
    return row ? this.#key(integer(row, "key_generation")) : undefined;
  }

  #authority(
    credential: CredentialRow,
    representedSubjectId: string,
    audience: string,
  ): AuthorityContext {
    const now = this.#now();
    return {
      issuerNamespaceId: "hangar-auth-store-v1",
      principalId: credential.principalId,
      representedSubjectId,
      audience,
      issuerVersion: `credential-${credential.generation}`,
      authenticatedMethod: credential.kind,
      delegationChainDigest: hash("no-delegation"),
      effectiveScope: credential.scopes,
      effectiveOperation: "authenticated-request",
      issuedAtUtcMs: now,
      expiresAtUtcMs: now + 60_000,
      revocationVersion: `credential-${credential.generation}`,
    };
  }

  #scopes(value: string): readonly string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) &&
        parsed.every((entry) => typeof entry === "string")
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  #now(): number {
    const now = this.#options.nowUnixMs();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("invalid_time_authority");
    return now;
  }

  #commit(): void {
    this.#options.beforeCommit?.();
    this.#db.exec("COMMIT");
    this.#options.afterCommitBeforeAck?.();
  }

  #transaction(work: () => void): void {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      work();
      this.#commit();
    } catch (error) {
      rollback(this.#db);
      throw error;
    }
  }
}
