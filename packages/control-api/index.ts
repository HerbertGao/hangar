// M2 Control API wire layer — task 1.3 of implement-m2-pi-control-slice.
//
// Single owner of the typed HTTP boundary before Zod/auth:
//   - streaming request guards (header/body caps and deadlines);
//   - duplicate-aware strict raw JSON parsing;
//   - case-insensitive safety-header duplicate detection over rawHeaders;
//   - strict single-Cookie-header parsing with protected-name rules.
// Later sections own the versioned Zod route registry and Telegram refs.
import { Buffer } from "node:buffer";

export type JsonPrimitive = null | boolean | number | string;

export interface WireError {
  readonly error: {
    readonly schemaVersion: "wire-error-v1";
    readonly kind: string;
    readonly message: string;
    readonly detail?: JsonPrimitive;
  };
}

export const wireError = (
  kind: string,
  message: string,
  detail?: JsonPrimitive,
): WireError => ({
  error: {
    schemaVersion: "wire-error-v1",
    kind,
    message,
    ...(detail === undefined ? {} : { detail }),
  },
});

// ---------------------------------------------------------------------------
// Streaming HTTP guards
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxHeaders: 64,
  maxHeaderBytes: 8 * 1024,
  maxTotalHeaderBytes: 32 * 1024,
  maxBodyBytes: 64 * 1024,
  headersDeadlineMs: 5_000,
  bodyDeadlineMs: 10_000,
} as const;

const CONTENT_LENGTH = /^([0-9]{1,15})$/;

export type HeadAnalysis =
  | {
      readonly ok: true;
      /** Parsed Content-Length, or null when absent. */
      readonly contentLength: number | null;
      readonly chunked: boolean;
      readonly expectsBody: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 413;
      readonly error: WireError;
    };

/**
 * Pure pre-parser analysis of a raw header block (rawHeaders pairs):
 * enforces header counts/byte caps, rejects conflicting Content-Length,
 * and CL+TE combinations before any body byte is read.
 */
export function analyzeRequestHead(
  method: string,
  rawHeaders: readonly string[],
): HeadAnalysis {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > LIMITS.maxHeaders)
    return {
      ok: false,
      status: 413,
      error: wireError("too_many_headers", "header count exceeds fixed bound"),
    };
  let total = 0;
  let contentLength: number | null = null;
  let chunked = false;
  const seenTransferEncoding: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    total += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (Buffer.byteLength(value) > LIMITS.maxHeaderBytes)
      return {
        ok: false,
        status: 413,
        error: wireError("header_too_large", "single header exceeds 8KiB"),
      };
    const lower = name.toLowerCase();
    if (lower === "content-length") {
      if (!CONTENT_LENGTH.test(value))
        return {
          ok: false,
          status: 400,
          error: wireError(
            "invalid_content_length",
            "Content-Length is not a plain digit string",
          ),
        };
      const parsed = Number(value);
      if (contentLength !== null && contentLength !== parsed)
        return {
          ok: false,
          status: 400,
          error: wireError(
            "conflicting_content_length",
            "conflicting duplicate Content-Length",
          ),
        };
      contentLength = parsed;
    } else if (lower === "transfer-encoding") {
      seenTransferEncoding.push(value.toLowerCase());
      if (value.toLowerCase() === "chunked") chunked = true;
    }
  }
  if (total > LIMITS.maxTotalHeaderBytes)
    return {
      ok: false,
      status: 413,
      error: wireError("headers_too_large", "total header bytes exceed 32KiB"),
    };
  if (seenTransferEncoding.length > 0 && contentLength !== null)
    return {
      ok: false,
      status: 400,
      error: wireError(
        "cl_with_te",
        "Content-Length together with Transfer-Encoding",
      ),
    };
  if (
    seenTransferEncoding.some(
      (encoding) => encoding !== "chunked" && encoding !== "identity",
    )
  )
    return {
      ok: false,
      status: 400,
      error: wireError(
        "invalid_transfer_encoding",
        "unsupported Transfer-Encoding",
      ),
    };
  const expectsBody =
    method === "POST" || method === "PUT" || method === "PATCH"
      ? chunked || (contentLength ?? 0) > 0
      : false;
  return { ok: true, contentLength, chunked, expectsBody };
}

// ---------------------------------------------------------------------------
// Duplicate-aware strict raw JSON parser
// ---------------------------------------------------------------------------

export type StrictJson =
  | null
  | boolean
  | number
  | string
  | readonly StrictJson[]
  | { readonly [key: string]: StrictJson };

const NUMBER_LITERAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

class StrictJsonParser {
  private readonly text: string;
  private position = 0;

  constructor(text: string) {
    this.text = text;
  }

  static parse(bytes: Buffer): StrictJson {
    // Malformed UTF-8 fails here before any structural parsing.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeError("invalid_utf8");
    }
    const parser = new StrictJsonParser(text);
    const value = parser.parseValue();
    parser.skipWhitespace();
    if (parser.position !== parser.text.length)
      throw new TypeError("trailing_bytes");
    return value;
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      if (char === " " || char === "\t" || char === "\n" || char === "\r")
        this.position += 1;
      else break;
    }
  }

  private peek(): string {
    if (this.position >= this.text.length)
      throw new TypeError("unexpected_end");
    return this.text[this.position];
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw new TypeError(`expected_${char}`);
    this.position += 1;
  }

  private parseValue(): StrictJson {
    this.skipWhitespace();
    const char = this.peek();
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === "t" || char === "f" || char === "n")
      return this.parseKeyword();
    return this.parseNumber();
  }

  private parseObject(): { readonly [key: string]: StrictJson } {
    this.expect("{");
    const result: Record<string, StrictJson> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.position += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      const rawKey = this.parseStringRaw();
      // Escape-equivalent keys ("a" vs "\u0061") decode to the same name.
      let key: string;
      try {
        key = JSON.parse(rawKey) as string;
      } catch {
        throw new TypeError("invalid_key");
      }
      if (seen.has(key)) throw new TypeError("duplicate_key");
      seen.add(key);
      this.skipWhitespace();
      this.expect(":");
      const parsedValue = this.parseValue();
      result[key] = parsedValue;
      this.skipWhitespace();
      const separator = this.peek();
      this.position += 1;
      if (separator === "}") return result;
      if (separator !== ",") throw new TypeError("expected_comma");
    }
  }

  private parseArray(): readonly StrictJson[] {
    this.expect("[");
    const result: StrictJson[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.position += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.peek();
      this.position += 1;
      if (separator === "]") return result;
      if (separator !== ",") throw new TypeError("expected_comma");
    }
  }

  private parseStringRaw(): string {
    this.expect('"');
    let raw = '"';
    for (;;) {
      if (this.position >= this.text.length)
        throw new TypeError("unterminated_string");
      const char = this.text[this.position];
      raw += char;
      this.position += 1;
      if (char === '"') return raw;
      if (char === "\\") {
        if (this.position >= this.text.length)
          throw new TypeError("unterminated_string");
        const escape = this.text[this.position];
        raw += escape;
        this.position += 1;
        if (escape === "u") {
          const hex = this.text.slice(this.position, this.position + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex))
            throw new TypeError("invalid_escape");
          const code = Number.parseInt(hex, 16);
          raw += hex;
          this.position += 4;
          if (code >= 0xd800 && code <= 0xdfff) {
            // Surrogates are only valid as strictly paired \uXXXX sequences.
            const high = code <= 0xdbff;
            let pairedLow = -1;
            if (this.text.startsWith("\\u", this.position)) {
              const lowHex = this.text.slice(
                this.position + 2,
                this.position + 6,
              );
              if (/^[0-9a-fA-F]{4}$/.test(lowHex)) {
                const low = Number.parseInt(lowHex, 16);
                const validLow = low >= 0xdc00 && low <= 0xdfff;
                const validHigh = low >= 0xd800 && low <= 0xdbff;
                if (high ? validLow : validHigh) pairedLow = low;
              }
            }
            if (pairedLow < 0) throw new TypeError("lone_surrogate");
            raw += this.text.slice(this.position, this.position + 6);
            this.position += 6;
          }
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape))
          throw new TypeError("invalid_escape");
      }
    }
  }

  private parseString(): string {
    try {
      return JSON.parse(this.parseStringRaw()) as string;
    } catch (error) {
      // parseStringRaw only emits well-formed JSON string literals; reaching
      // here means an internal scanner invariant broke, so keep the cause.
      throw new TypeError("invalid_string", { cause: error });
    }
  }

  private parseKeyword(): null | boolean {
    for (const [word, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(word, this.position)) {
        this.position += word.length;
        return parsed;
      }
    }
    throw new TypeError("invalid_keyword");
  }

  private parseNumber(): number {
    const start = this.position;
    while (
      this.position < this.text.length &&
      /[-+.0-9eE]/.test(this.text[this.position])
    )
      this.position += 1;
    const literal = this.text.slice(start, this.position);
    if (!NUMBER_LITERAL.test(literal)) throw new TypeError("invalid_number");
    const parsed = Number(literal);
    if (!Number.isFinite(parsed)) throw new TypeError("non_finite_number");
    if (/^-?[0-9]+$/.test(literal.replace(/^(-?)0+[1-9]/, "$11"))) {
      const magnitude = BigInt(
        literal.startsWith("-") ? literal.slice(1) : literal,
      );
      if (magnitude > MAX_SAFE) throw new TypeError("unsafe_number");
    }
    return parsed;
  }
}

/** Strict pre-Zod JSON parse over raw body bytes. */
export function parseStrictJson(bytes: Buffer): StrictJson {
  return StrictJsonParser.parse(bytes);
}

// ---------------------------------------------------------------------------
// Guarded HTTP server wiring
// ---------------------------------------------------------------------------

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as httpCreateServer } from "node:http";

function sendWireError(
  response: ServerResponse,
  status: 400 | 408 | 413,
  error: WireError,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify(error));
}

export type BodyGuardResult =
  | { readonly ok: true; readonly body: Buffer | null }
  | {
      readonly ok: false;
      readonly status: 400 | 408 | 413;
      readonly error: WireError;
    };

/**
 * Creates an HTTP server that enforces the fixed streaming bounds BEFORE any
 * parsing/auth: header count and byte caps, CL+TE conflicts, declared-vs-actual
 * length mismatches, chunked overflow, 5s header deadline, and a 10s
 * body/first-byte deadline starting at headers-complete (zero bytes included).
 * The handler only runs once the full body is within bounds.
 */
export function createGuardedServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer | null,
  ) => void,
  // Test-only knobs; production always runs at the fixed spec limits.
  deadlines?: {
    readonly bodyDeadlineMs?: number;
    readonly headersDeadlineMs?: number;
  },
): Server {
  const headersDeadline =
    deadlines?.headersDeadlineMs ?? LIMITS.headersDeadlineMs;
  const bodyDeadline = deadlines?.bodyDeadlineMs ?? LIMITS.bodyDeadlineMs;
  // Headers must complete within the deadline of the connection (or of the
  // previous request on a kept-alive socket); the timer is disarmed the moment
  // a request's headers have fully arrived.
  const headerTimerBySocket = new WeakMap<object, unknown>();
  const server = httpCreateServer((request, response) => {
    const pendingHeaderTimer = headerTimerBySocket.get(request.socket);
    if (pendingHeaderTimer !== undefined) {
      clearTimeout(pendingHeaderTimer);
      headerTimerBySocket.delete(request.socket);
    }
    const head = analyzeRequestHead(
      request.method ?? "GET",
      request.rawHeaders,
    );
    if (!head.ok) {
      sendWireError(response, head.status, head.error);
      request.destroy();
      return;
    }
    const duplicates = checkSafetyHeaderDuplicates(request.rawHeaders);
    if (!duplicates.ok) {
      sendWireError(response, 400, duplicates.error);
      request.destroy();
      return;
    }
    if (!head.expectsBody) {
      handler(request, response, null);
      return;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;
    const finish = (outcome: BodyGuardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.ok) handler(request, response, outcome.body);
      else {
        sendWireError(response, outcome.status, outcome.error);
        request.destroy();
      }
    };
    // Body/first-byte deadline starts at headers-complete; zero bytes included.
    const timer = setTimeout(() => {
      finish({
        ok: false,
        status: 408,
        error: wireError(
          "body_timeout",
          "body did not complete within deadline",
        ),
      });
    }, bodyDeadline);
    request.on("data", (chunk: Uint8Array) => {
      received += chunk.length;
      if (
        received > LIMITS.maxBodyBytes ||
        (head.contentLength !== null && received > head.contentLength)
      ) {
        finish({
          ok: false,
          status: 413,
          error: wireError("body_too_large", "body exceeds fixed bound"),
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (
        head.contentLength !== null &&
        !head.chunked &&
        received !== head.contentLength
      ) {
        finish({
          ok: false,
          status: 400,
          error: wireError(
            "length_mismatch",
            "declared Content-Length does not match actual body length",
          ),
        });
        return;
      }
      finish({ ok: true, body: Buffer.concat(chunks) });
    });
    request.on("aborted", () => {
      // Client closed before delivering the declared body length.
      finish({
        ok: false,
        status: 400,
        error: wireError(
          head.contentLength !== null && received < head.contentLength
            ? "length_mismatch"
            : "request_aborted",
          "request ended before declared body length was received",
        ),
      });
    });
    request.on("error", () => {
      finish({
        ok: false,
        status: 400,
        error: wireError("request_aborted", "request stream failed"),
      });
    });
  });
  server.on("connection", (socket) => {
    const timer = setTimeout(() => socket.destroy(), headersDeadline);
    headerTimerBySocket.set(socket, timer);
    socket.on("close", () => {
      const existing = headerTimerBySocket.get(socket);
      if (existing !== undefined) {
        clearTimeout(existing);
        headerTimerBySocket.delete(socket);
      }
    });
  });
  return server;
}

/** Headers whose duplicates are rejected ASCII-case-insensitively. */
export const SAFETY_HEADERS = [
  "authorization",
  "cookie",
  "origin",
  "x-hangar-csrf",
  "x-hangar-session-action",
  "x-hangar-session-predecessor",
  "x-hangar-channel-context",
  "idempotency-key",
  "if-match",
  "last-event-id",
  "content-type",
] as const;

const PROTECTED_COOKIES = [
  "hangar_session",
  "hangar_csrf",
  "hangar_session_hint",
] as const;
const COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;

export type HeaderDuplication =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: WireError };

/** Rejects any duplicated safety header by ASCII case-insensitive name. */
export function checkSafetyHeaderDuplicates(
  rawHeaders: readonly string[],
): HeaderDuplication {
  const seen = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const lower = rawHeaders[index].toLowerCase();
    if (!SAFETY_HEADERS.includes(lower as (typeof SAFETY_HEADERS)[number]))
      continue;
    if (seen.has(lower))
      return {
        ok: false,
        error: wireError(
          "duplicate_header",
          `duplicate safety header: ${lower}`,
        ),
      };
    seen.add(lower);
  }
  return { ok: true };
}

export type CookieParseResult =
  | {
      readonly ok: true;
      readonly cookies: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: WireError };

/**
 * Strict pre-auth parse of the single Cookie header value: semicolon-separated,
 * unique protected names, base64url-shaped protected values, no quoting or
 * control characters. Non-protected cookies cannot shadow protected names.
 */
/** Cookie OWS is space/tab only; other whitespace is a rejection vector. */
const stripOws = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === " " || value[start] === "\t"))
    start += 1;
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\t"))
    end -= 1;
  return value.slice(start, end);
};

export function parseCookieHeader(headerValue: string): CookieParseResult {
  const cookies: Record<string, string> = {};
  const seenProtected = new Set<string>();
  for (const part of headerValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0)
      return {
        ok: false,
        error: wireError("malformed_cookie", "cookie pair without name=value"),
      };
    const name = stripOws(part.slice(0, eq));
    const rawCookieValue = stripOws(part.slice(eq + 1));
    if (name.length === 0 || rawCookieValue.length === 0)
      return {
        ok: false,
        error: wireError("malformed_cookie", "empty cookie name or value"),
      };
    for (const char of `${name}${rawCookieValue}`)
      if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
        return {
          ok: false,
          error: wireError("malformed_cookie", "control character in cookie"),
        };
    if (
      PROTECTED_COOKIES.includes(name as (typeof PROTECTED_COOKIES)[number])
    ) {
      if (seenProtected.has(name))
        return {
          ok: false,
          error: wireError(
            "duplicate_cookie",
            `duplicate protected cookie: ${name}`,
          ),
        };
      seenProtected.add(name);
      if (rawCookieValue.startsWith('"'))
        return {
          ok: false,
          error: wireError("malformed_cookie", "quoted cookie value"),
        };
      if (!COOKIE_VALUE.test(rawCookieValue))
        return {
          ok: false,
          error: wireError(
            "malformed_cookie",
            "protected cookie value is not base64url",
          ),
        };
    }
    // First occurrence wins for non-protected names; protected names are unique
    // by the checks above, so later cookies can never override them.
    if (!(name in cookies)) cookies[name] = rawCookieValue;
  }
  return { ok: true, cookies };
}

// ---------------------------------------------------------------------------
// Versioned Zod route registry (single wire owner)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { canonicalJson } from "../contracts/index.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const REGISTRY_VERSION = "control-routes-v1";

export const IDEMPOTENCY_KEY_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);
export const ETAG_SCHEMA = z.string().regex(/^"[0-9a-f]{64}"$/);
/** Canonical safe-integer decimal: no sign, no leading zero, <= MAX_SAFE. */
export const LAST_EVENT_ID_SCHEMA = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number(value) <= Number.MAX_SAFE_INTEGER);

const EXECUTION_MODES = ["shadow-evaluator", "production"] as const;
const JSON_PRIMITIVE = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const SCHEMA_REF_RESPONSE = z.strictObject({
  id: z.string(),
  version: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
const INTENT_DESCRIPTOR_RESPONSE = z.strictObject({
  intentId: z.string(),
  descriptorVersion: z.number().int(),
  inputSchema: SCHEMA_REF_RESPONSE,
  scope: z.string(),
  policyId: z.string(),
  resultSchema: SCHEMA_REF_RESPONSE,
});
const RUN_STATE_RESPONSE = z.enum([
  "running",
  "waiting",
  "cancel-requested",
  "cancel-pending-reconciliation",
  "completed",
  "failed",
  "cancelled",
]);
const ATTEMPT_STATE_RESPONSE = z.enum([
  "running",
  "checkpointed",
  "succeeded",
  "failed",
  "cancelled",
]);

const INTENT_BODY = z.strictObject({
  descriptorVersion: z.number().int().min(1),
  executionMode: z.enum(EXECUTION_MODES),
  input: z.record(z.string(), JSON_PRIMITIVE),
});
const CANCEL_BODY = z.strictObject({ reasonCode: z.literal("user-requested") });
const DECISION_BODY = z.strictObject({
  decision: z.enum(["approved", "denied"]),
});

/**
 * Standard transport/browser headers the registry allows with byte caps and
 * ignores: they can never influence actor, command identity, or preconditions.
 */
export const TRANSPORT_HEADERS: Readonly<Record<string, number>> = {
  host: 512,
  connection: 128,
  accept: 256,
  "accept-encoding": 256,
  "accept-language": 256,
  "content-length": 32,
  "transfer-encoding": 64,
  te: 64,
  "user-agent": 512,
  origin: 512,
  referer: 1024,
  "cache-control": 256,
  pragma: 256,
};
const TRANSPORT_PREFIXES = ["sec-fetch-", "sec-ch-"] as const;

/** Application headers every route may carry, with shapes and byte caps. */
export const GLOBAL_APP_HEADER_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  authorization: z.string().min(7).max(1024),
  cookie: z.string().min(1).max(4096),
  "content-type": z.literal("application/json"),
  "idempotency-key": IDEMPOTENCY_KEY_SCHEMA,
  "if-match": ETAG_SCHEMA,
  "last-event-id": LAST_EVENT_ID_SCHEMA,
  "x-hangar-channel-context": z.string().min(16).max(2048),
  "x-hangar-csrf": z.string().min(43).max(128),
  "x-hangar-session-action": z.enum(["establish", "renew"]),
  "x-hangar-session-predecessor": z.string().min(16).max(512),
};

export interface RouteSpec {
  readonly routeId: string;
  readonly method: "GET" | "POST";
  /** Anchored source with :params, compiled once at module load. */
  readonly pathTemplate: string;
  readonly authMode: "control" | "auth-session";
  readonly requiresBody: boolean;
  readonly bodySchema?: z.ZodType;
  readonly responseSchema?: z.ZodType;
}

const paramNames = (template: string): readonly string[] =>
  template
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));

const compilePattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split("/")
      .map((segment) =>
        segment.startsWith(":") ? `(?<${segment.slice(1)}>[^/]+)` : segment,
      )
      .join("/")}$`,
  );

export const ROUTES: readonly RouteSpec[] = [
  {
    routeId: "agents.list",
    method: "GET",
    pathTemplate: "/v1/agents",
    authMode: "control",
    requiresBody: false,
    responseSchema: z.strictObject({
      agents: z.array(
        z.strictObject({
          agentId: z.string(),
          releaseCount: z.number().int().min(0),
        }),
      ),
    }),
  },
  {
    routeId: "releases.list",
    method: "GET",
    pathTemplate: "/v1/agents/:agentId/releases",
    authMode: "control",
    requiresBody: false,
    responseSchema: z.strictObject({
      releases: z.array(
        z.strictObject({
          agentId: z.string(),
          releaseId: z.string().regex(/^[0-9a-f]{64}$/),
          schemaVersion: z.enum(["agent-release-v1", "agent-release-v2"]),
          intentDescriptors: z.array(INTENT_DESCRIPTOR_RESPONSE),
          etag: ETAG_SCHEMA,
        }),
      ),
    }),
  },
  {
    routeId: "intent.submit",
    method: "POST",
    pathTemplate: "/v1/agents/:agentId/intents/:intent",
    authMode: "control",
    requiresBody: true,
    bodySchema: INTENT_BODY,
    responseSchema: z.strictObject({
      runId: z.string(),
      result: z.strictObject({
        runId: z.string(),
        releaseId: z.string(),
        activationEpoch: z.number().int(),
        executionMode: z.enum(["shadow-evaluator", "production"]),
        inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
        promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    }),
  },
  {
    routeId: "runs.read",
    method: "GET",
    pathTemplate: "/v1/runs/:runId",
    authMode: "control",
    requiresBody: false,
    responseSchema: z.strictObject({
      run: z.strictObject({
        runId: z.string(),
        agentId: z.string(),
        releaseId: z.string(),
        activationEpoch: z.number().int().min(0),
        state: RUN_STATE_RESPONSE,
        currentAttempt: z.number().int().min(0),
        attemptState: ATTEMPT_STATE_RESPONSE,
        executionMode: z.enum(["shadow-evaluator", "production"]).optional(),
        checkpointId: z.string().optional(),
        outcomeArtifactDigest: z.string().optional(),
      }),
      pendingApprovals: z.array(
        z.strictObject({
          approvalId: z.string(),
          runId: z.string(),
          state: z.literal("pending"),
          operation: z.string(),
          expiresAtUnixMs: z.number().int().optional(),
        }),
      ),
    }),
  },
  {
    routeId: "runs.events",
    method: "GET",
    pathTemplate: "/v1/runs/:runId/events",
    authMode: "control",
    requiresBody: false,
  },
  {
    routeId: "runs.cancel",
    method: "POST",
    pathTemplate: "/v1/runs/:runId/cancel",
    authMode: "control",
    requiresBody: true,
    bodySchema: CANCEL_BODY,
    responseSchema: z.strictObject({
      runId: z.string(),
      cancelStatus: z.enum([
        "cleanup-pending",
        "cancel-pending-reconciliation",
      ]),
      result: z.strictObject({
        runId: z.string(),
        cancelStatus: z.enum([
          "cleanup-pending",
          "cancel-pending-reconciliation",
        ]),
        fenceGeneration: z.number().int().min(1),
      }),
    }),
  },
  {
    routeId: "approvals.decide",
    method: "POST",
    pathTemplate: "/v1/approvals/:approvalId/decision",
    authMode: "control",
    requiresBody: true,
    bodySchema: DECISION_BODY,
    responseSchema: z.strictObject({
      approvalId: z.string(),
      state: z.enum(["approved", "denied", "expired"]),
      result: z.enum(["accepted", "stored"]),
    }),
  },
  {
    routeId: "health.read",
    method: "GET",
    pathTemplate: "/v1/health",
    authMode: "control",
    requiresBody: false,
    responseSchema: z.strictObject({
      health: z.strictObject({
        status: z.literal("healthy"),
        headSeq: z.number().int().min(0),
      }),
    }),
  },
  {
    routeId: "auth.session",
    method: "POST",
    pathTemplate: "/auth/session",
    authMode: "auth-session",
    requiresBody: false,
  },
];

export interface CompiledRoute extends RouteSpec {
  readonly pattern: RegExp;
  readonly params: readonly string[];
}

export const COMPILED_ROUTES: readonly CompiledRoute[] = ROUTES.map(
  (route) => ({
    ...route,
    pattern: compilePattern(route.pathTemplate),
    params: paramNames(route.pathTemplate),
  }),
);

export type RouteMatch =
  | {
      readonly ok: true;
      readonly route: CompiledRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 405;
      readonly error: WireError;
    };

/** Exact-match routing; unknown paths and known-path/method mismatches fail typed. */
export function matchRoute(method: string, pathname: string): RouteMatch {
  // Strip any query string: no v1 route declares query parameters.
  const rawPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const queryStart = rawPath.indexOf("?");
  const cleanPath = queryStart >= 0 ? rawPath.slice(0, queryStart) : rawPath;
  if (queryStart >= 0 && rawPath.slice(queryStart + 1).length > 0)
    return {
      ok: false,
      status: 404,
      error: wireError("unknown_query", "query parameters are not accepted"),
    };
  for (const route of COMPILED_ROUTES) {
    const match = route.pattern.exec(cleanPath);
    if (!match) continue;
    if (route.method !== method)
      return {
        ok: false,
        status: 405,
        error: wireError(
          "method_not_allowed",
          `${method} is not ${route.pathTemplate}`,
        ),
      };
    return { ok: true, route, params: { ...(match.groups ?? {}) } };
  }
  return {
    ok: false,
    status: 404,
    error: wireError("unknown_route", `no route for ${pathname}`),
  };
}

export type HeaderClassification =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400; readonly error: WireError };

/**
 * Default-deny header classification for a matched route: transport headers
 * are capped and ignored; application headers validate against closed schemas;
 * anything else is rejected before auth.
 */
export function classifyHeaders(
  route: CompiledRoute,
  rawHeaders: readonly string[],
): HeaderClassification {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    const value = rawHeaders[index + 1];
    const transportCap = TRANSPORT_HEADERS[name];
    if (
      transportCap !== undefined ||
      TRANSPORT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      if (Buffer.byteLength(value) > 1024)
        return {
          ok: false,
          error: wireError(
            "header_too_large",
            `transport header over bound: ${name}`,
          ),
          status: 400,
        };
      continue;
    }
    const schema = GLOBAL_APP_HEADER_SCHEMAS[name];
    if (schema === undefined)
      return {
        ok: false,
        error: wireError(
          "unknown_header",
          `header not allowed on ${route.routeId}: ${name}`,
        ),
        status: 400,
      };
    if (!schema.safeParse(value).success)
      return {
        ok: false,
        error: wireError("invalid_header", `header failed schema: ${name}`),
        status: 400,
      };
  }
  // Writes require idempotency + precondition; GETs must not carry them.
  const names = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2)
    names.add(rawHeaders[index].toLowerCase());
  if (route.method === "POST" && route.authMode === "control") {
    if (!names.has("idempotency-key") || !names.has("if-match"))
      return {
        ok: false,
        error: wireError(
          "missing_write_headers",
          "writes need Idempotency-Key and If-Match",
        ),
        status: 400,
      };
  } else if (names.has("idempotency-key") || names.has("if-match"))
    return {
      ok: false,
      error: wireError(
        "unexpected_write_headers",
        "reads cannot carry write headers",
      ),
      status: 400,
    };
  if (route.requiresBody && !names.has("content-type"))
    return {
      ok: false,
      error: wireError("invalid_header", "JSON writes need Content-Type"),
      status: 400,
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Telegram interaction refs and Gateway port schemas
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const ASCII_ID_RE = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^[0-9]+$/;
// Registry route ids are namespaced ("runs.read"), so they may carry dots.
const ROUTE_ID_RE = /^[A-Za-z0-9._-]+$/;

/** UpdateOccurrenceKey = sha256(canonical(['telegram-update-v1', c, s, u])). */
export function deriveUpdateOccurrenceKey(
  connectorInstanceId: string,
  serviceAuthorityId: string,
  updateId: string,
): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        "telegram-update-v1",
        connectorInstanceId,
        serviceAuthorityId,
        updateId,
      ]),
    )
    .digest("hex");
}

/** idempotencyKey = sha256(canonical(['telegram-control-v1', occurrenceKey])). */
export function deriveTelegramIdempotencyKey(
  updateOccurrenceKey: string,
): string {
  if (!HEX64.test(updateOccurrenceKey))
    throw new TypeError("invalid_occurrence_key");
  return createHash("sha256")
    .update(canonicalJson(["telegram-control-v1", updateOccurrenceKey]))
    .digest("hex");
}

export const CONTROL_OPERATIONS = [
  "submit-intent",
  "read-run",
  "cancel-run",
  "decide-approval",
] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];

const UPDATE_CLAIMS_SCHEMA = z.strictObject({
  schemaVersion: z.literal("telegram-update-ref-v1"),
  connectorInstanceId: z.string().regex(ASCII_ID_RE).max(128),
  adapterInstanceId: z.string().regex(ASCII_ID_RE).max(128),
  serviceAuthorityId: z.string().regex(ASCII_ID_RE).max(128),
  serviceCredentialGeneration: z.number().int().min(1),
  updateId: z.string().regex(DIGITS).max(19),
  updateOccurrenceKey: z.string().regex(HEX64),
  userId: z.string().regex(DIGITS).max(19),
  chatId: z.string().regex(DIGITS).max(19),
  messageIdOrCallbackId: z.union([z.string().max(64), z.null()]),
  mappingVersion: z.number().int().min(1),
  controlOperation: z.enum(CONTROL_OPERATIONS),
  normalizedTarget: z.string().regex(ASCII_ID_RE).max(128),
  rawUpdateDigest: z.string().regex(HEX64),
  expiryUnixMs: z.number().int().min(1),
});

export type UpdateInteractionClaims = z.infer<typeof UPDATE_CLAIMS_SCHEMA>;

export interface SignedRef {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly mac: string;
}

const MAX_REF_BYTES = 2048;

const hmacB64url = (secret: string, canonical: string): string =>
  createHmac("sha256", secret).update(canonical).digest("base64url");

const macEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Signs {claims, mac} over the canonical claims bytes; returns the unpadded
 * base64url envelope, enforcing the 2KiB header bound. Claims must never
 * contain actor/scope/delegation or raw update text — the schema is closed.
 */
export function decodeUpdateInteractionClaims(
  encoded: string,
): UpdateInteractionClaims {
  if (encoded.length > MAX_REF_BYTES) throw new TypeError("ref_exceeds_2kib");
  let signed: SignedRef;
  try {
    // SAFETY: strict JSON is schema-validated immediately below.
    signed = parseStrictJson(
      Buffer.from(encoded, "base64url"),
    ) as unknown as SignedRef;
  } catch {
    throw new TypeError("malformed_update_ref");
  }
  const parsed = UPDATE_CLAIMS_SCHEMA.safeParse(signed.claims);
  if (!parsed.success) throw new TypeError("malformed_update_ref");
  return parsed.data;
}

export function signUpdateInteractionRef(
  claims: UpdateInteractionClaims,
  secret: string,
): string {
  const parsed = UPDATE_CLAIMS_SCHEMA.parse(claims);
  const mac = hmacB64url(secret, canonicalJson(parsed));
  const encoded = Buffer.from(
    canonicalJson({
      // SAFETY: zod-parsed primitive record is structurally Record<string, unknown>.
      claims: parsed as unknown as Record<string, unknown>,
      mac,
    }),
  ).toString("base64url");
  if (encoded.length > MAX_REF_BYTES) throw new TypeError("ref_exceeds_2kib");
  return encoded;
}

export type RefVerification<T> =
  | { readonly ok: true; readonly claims: T }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "oversize" | "bad_mac" | "expired";
    };

/** Verifies size, shape, MAC, and freshness of an encoded interaction ref. */
export function verifyUpdateInteractionRef(
  encoded: string,
  secret: string,
  nowUnixMs: number,
): RefVerification<UpdateInteractionClaims> {
  if (encoded.length > MAX_REF_BYTES) return { ok: false, reason: "oversize" };
  let signed: SignedRef;
  try {
    // SAFETY: strict-JSON output is a plain JSON value; the zod schema below
    // is the real validator — this cast only carries it into SignedRef shape.
    signed = parseStrictJson(
      Buffer.from(encoded, "base64url"),
    ) as unknown as SignedRef;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = UPDATE_CLAIMS_SCHEMA.safeParse(signed.claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (typeof signed.mac !== "string") return { ok: false, reason: "malformed" };
  const expected = hmacB64url(secret, canonicalJson(parsed.data));
  if (!macEqual(expected, signed.mac)) return { ok: false, reason: "bad_mac" };
  if (parsed.data.expiryUnixMs <= nowUnixMs)
    return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed.data };
}

// Control-side opaque interaction refs returned in X-Hangar-Interaction-Ref.

export const RESPONSE_KINDS = [
  "agents-listed",
  "releases-listed",
  "intent-admitted",
  "run-viewed",
  "cancel-requested",
  "decision-recorded",
  "health-reported",
] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

const CONTROL_INTERACTION_CLAIMS_SCHEMA = z.strictObject({
  schemaVersion: z.literal("control-interaction-ref-v1"),
  updateInteractionRefDigest: z.string().regex(HEX64),
  routeId: z.string().regex(ROUTE_ID_RE).max(64),
  normalizedTarget: z.string().regex(ASCII_ID_RE).max(128),
  responseKind: z.enum(RESPONSE_KINDS),
  /** Write refs bind the stored command identity digest; read refs leave null. */
  commandIdentityDigest: z.union([z.string().regex(HEX64), z.null()]),
  /** Write: stored result digest; read: authorized projection digest. */
  responseDigest: z.string().regex(HEX64),
  /** Read refs pin the global fact head they were derived from; writes null. */
  factHead: z.union([z.number().int().min(1), z.null()]),
  expiryUnixMs: z.number().int().min(1),
  macKeyGeneration: z.number().int().min(1),
});

export type ControlInteractionClaims = z.infer<
  typeof CONTROL_INTERACTION_CLAIMS_SCHEMA
>;

export function signControlInteractionRef(
  claims: ControlInteractionClaims,
  secret: string,
): string {
  const parsed = CONTROL_INTERACTION_CLAIMS_SCHEMA.parse(claims);
  const mac = hmacB64url(secret, canonicalJson(parsed));
  const encoded = Buffer.from(
    canonicalJson({
      // SAFETY: zod-parsed primitive record is structurally Record<string, unknown>.
      claims: parsed as unknown as Record<string, unknown>,
      mac,
    }),
  ).toString("base64url");
  if (encoded.length > MAX_REF_BYTES) throw new TypeError("ref_exceeds_2kib");
  return encoded;
}

export function verifyControlInteractionRef(
  encoded: string,
  secret: string,
  nowUnixMs: number,
): RefVerification<ControlInteractionClaims> {
  if (encoded.length > MAX_REF_BYTES) return { ok: false, reason: "oversize" };
  let signed: SignedRef;
  try {
    // SAFETY: same as verifyUpdateInteractionRef — zod validates below.
    signed = parseStrictJson(
      Buffer.from(encoded, "base64url"),
    ) as unknown as SignedRef;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = CONTROL_INTERACTION_CLAIMS_SCHEMA.safeParse(signed.claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (typeof signed.mac !== "string") return { ok: false, reason: "malformed" };
  const expected = hmacB64url(secret, canonicalJson(parsed.data));
  if (!macEqual(expected, signed.mac)) return { ok: false, reason: "bad_mac" };
  if (parsed.data.expiryUnixMs <= nowUnixMs)
    return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed.data };
}

/** deliveryKey derives only from ref digest + operation + response kind. */
export function deriveDeliveryKey(
  controlInteractionRefDigest: string,
  deliveryOperation: string,
  responseKind: ResponseKind,
): string {
  if (!HEX64.test(controlInteractionRefDigest))
    throw new TypeError("invalid_ref_digest");
  return createHash("sha256")
    .update(
      canonicalJson([
        "telegram-delivery-v1",
        controlInteractionRefDigest,
        deliveryOperation,
        responseKind,
      ]),
    )
    .digest("hex");
}

// TelegramGatewayPort — the only surface between adapter and Effect Gateway.

export const DELIVERY_OPERATIONS = [
  "send-message",
  "edit-message",
  "answer-callback",
] as const;

const EFFECT_STATES = [
  "pending",
  "approved",
  "claimed",
  "dispatch-started",
  "unknown",
  "committed",
  "not-committed",
] as const;

const SERVICE_AUTHORITY = z.strictObject({
  serviceAuthorityRef: z.string().regex(ASCII_ID_RE).min(1).max(256),
});

export const TELEGRAM_GATEWAY_PORT_SCHEMAS = {
  pollUpdates: {
    request: z.strictObject({
      ...SERVICE_AUTHORITY.shape,
      cursor: z.union([z.string().max(128), z.null()]),
      limit: z.number().int().min(1).max(100),
    }),
    response: z.strictObject({
      updates: z.array(
        z.strictObject({
          rawUpdate: z
            .instanceof(Uint8Array)
            .refine((value) => value.byteLength <= 65536),
          updateInteractionRef: z.string().max(MAX_REF_BYTES),
        }),
      ),
      nextCursor: z.union([z.string().max(128), z.null()]),
    }),
  },
  requestDelivery: {
    request: z.strictObject({
      ...SERVICE_AUTHORITY.shape,
      updateInteractionRef: z.string().min(16).max(MAX_REF_BYTES),
      controlInteractionRef: z.string().min(16).max(MAX_REF_BYTES),
      responseKind: z.enum(RESPONSE_KINDS),
      deliveryKey: z.string().regex(HEX64),
      deliveryOperation: z.enum(DELIVERY_OPERATIONS),
      payloadBytes: z
        .instanceof(Uint8Array)
        .refine((value) => value.byteLength <= 16384),
      payloadDigest: z.string().regex(HEX64),
    }),
    response: z.union([
      z.strictObject({
        status: z.literal("effect"),
        effectId: z.string().regex(ASCII_ID_RE),
        state: z.enum(EFFECT_STATES),
        outcomeDigest: z.union([z.string().regex(HEX64), z.null()]),
      }),
      z.strictObject({
        status: z.literal("denied"),
        error: z.string().min(1).max(128),
      }),
    ]),
  },
  readDelivery: {
    request: z.strictObject({
      ...SERVICE_AUTHORITY.shape,
      effectId: z.string().regex(ASCII_ID_RE).min(1).max(128),
    }),
    response: z.strictObject({
      effectId: z.string().regex(ASCII_ID_RE),
      state: z.enum(EFFECT_STATES),
      sanitizedSummary: z.union([z.string().max(512), z.null()]),
    }),
  },
} as const;
