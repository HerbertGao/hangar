import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  classifyHeaders,
  createGuardedServer,
  matchRoute,
  parseCookieHeader,
  parseStrictJson,
  deriveTelegramIdempotencyKey,
  signControlInteractionRef,
  verifyUpdateInteractionRef,
  wireError,
  type CompiledRoute,
  type UpdateInteractionClaims,
} from "../../packages/control-api/index.ts";
import {
  digestJson,
  type AgentSummary,
  type AuthorityContext,
  type ErrorKind,
  type HealthSummary,
  type IntentAdmissionInput,
  type IntentAdmissionResult,
  type PendingApprovalSummary,
  type QueryEnvelope,
  type ReleaseSummary,
  type Result,
  type RunEventPage,
  type SanitizedRunSummary,
} from "../../packages/contracts/index.ts";

type SessionExchangeResult =
  | {
      readonly ok: true;
      readonly status: 204;
      readonly headers: {
        readonly setCookie: readonly [string, string, string];
        readonly cacheControl: "no-store";
        readonly expiresAtUnixMs: number;
      };
    }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 409 | 410 | 500;
      readonly error: string;
      readonly predecessorHint?: string;
    };

interface AuthHttpPort {
  authenticateBearer(rawToken: string): AuthorityContext | undefined;
  authenticateSession(sessionCookie: string): AuthorityContext | undefined;
  authenticateTelegram(input: {
    readonly serviceToken: string;
    readonly userId: string;
    readonly chatId: string;
    readonly mappingVersion: number;
  }): AuthorityContext | undefined;
  exchangeSession(input: {
    readonly action: "establish" | "renew";
    readonly bootstrapToken: string;
    readonly origin: string;
    readonly predecessorHeader?: string;
    readonly hintCookie?: string;
    readonly ambientSessionCookie?: string;
  }): SessionExchangeResult;
  verifyWriteCsrfOrigin(input: {
    readonly sessionCookie: string;
    readonly csrfCookie: string;
    readonly csrfHeader: string;
    readonly origin: string;
  }): boolean;
}

interface RunEventCursorPort {
  next(): Promise<Result<QueryEnvelope<RunEventPage>>>;
  close(): void;
}

interface ControlHttpPort {
  listAgents(
    authority: AuthorityContext,
  ): Result<QueryEnvelope<readonly AgentSummary[]>>;
  listReleases(
    authority: AuthorityContext,
    agentId: string,
  ): Result<QueryEnvelope<readonly ReleaseSummary[]>>;
  readRun(
    authority: AuthorityContext,
    runId: string,
  ): Result<
    QueryEnvelope<{
      readonly run: SanitizedRunSummary;
      readonly pendingApprovals: readonly PendingApprovalSummary[];
    }>
  >;
  readHealth(authority: AuthorityContext): Result<QueryEnvelope<HealthSummary>>;
  admitIntentFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: IntentAdmissionInput,
  ): Result<IntentAdmissionResult>;
  cancelFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: { readonly runId: string; readonly reasonCode: "user-requested" },
  ): Result<{
    readonly runId: string;
    readonly cancelStatus: "cleanup-pending" | "cancel-pending-reconciliation";
    readonly fenceGeneration: number;
  }>;
  decideApprovalByIdFromWire(
    authority: AuthorityContext,
    idempotencyKey: string,
    ifMatch: string,
    input: {
      readonly approvalId: string;
      readonly decision: "approved" | "denied";
    },
  ): Result<{
    readonly approvalId: string;
    readonly state: "approved" | "denied" | "expired";
    readonly result: "accepted" | "stored";
  }>;
  openRunEventCursor(
    authority: AuthorityContext,
    runId: string,
    cursor: string | null,
    options: { readonly heartbeatMs?: number },
  ): Result<RunEventCursorPort>;
}

export interface HangarHttpComposition {
  readonly auth: AuthHttpPort;
  readonly control: { readonly control: ControlHttpPort };
  readonly telegramChannel?: {
    readonly updateRefSecret: string;
    readonly controlRefSecret: string;
    readonly serviceAuthorityId: string;
    readonly macKeyGeneration: number;
    readonly nowUnixMs: () => number;
  };
}

const headers = (
  rawHeaders: readonly string[],
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2)
    result[rawHeaders[index].toLowerCase()] = rawHeaders[index + 1];
  return result;
};

interface VerifiedChannel {
  readonly authority: AuthorityContext;
  readonly claims: UpdateInteractionClaims;
  readonly updateRef: string;
  readonly updateRefDigest: string;
}

const verifiedChannel = (
  composition: HangarHttpComposition,
  request: IncomingMessage,
): VerifiedChannel | undefined => {
  const config = composition.telegramChannel;
  const values = headers(request.rawHeaders);
  const ref = values["x-hangar-channel-context"];
  const bearer = /^Bearer ([\x21-\x7e]{1,1024})$/.exec(
    values.authorization ?? "",
  );
  if (!config || !ref || !bearer) return undefined;
  const verified = verifyUpdateInteractionRef(
    ref,
    config.updateRefSecret,
    config.nowUnixMs(),
  );
  if (!verified.ok || verified.claims.serviceAuthorityId !== config.serviceAuthorityId)
    return undefined;
  const authority = composition.auth.authenticateTelegram({
    serviceToken: bearer[1],
    userId: verified.claims.userId,
    chatId: verified.claims.chatId,
    mappingVersion: verified.claims.mappingVersion,
  });
  return authority
    ? {
        authority,
        claims: verified.claims,
        updateRef: ref,
        updateRefDigest: createHash("sha256").update(ref).digest("hex"),
      }
    : undefined;
};

const authenticate = (
  composition: HangarHttpComposition,
  request: IncomingMessage,
): AuthorityContext | undefined => {
  const values = headers(request.rawHeaders);
  const authorization = values.authorization;
  const cookieHeader = values.cookie;
  if ((authorization && cookieHeader) || (!authorization && !cookieHeader))
    return undefined;
  if (values["x-hangar-channel-context"])
    return verifiedChannel(composition, request)?.authority;
  if (authorization) {
    const match = /^Bearer ([\x21-\x7e]{1,1024})$/.exec(authorization);
    return match ? composition.auth.authenticateBearer(match[1]) : undefined;
  }
  const parsed = parseCookieHeader(cookieHeader!);
  return parsed.ok && parsed.cookies.hangar_session
    ? composition.auth.authenticateSession(parsed.cookies.hangar_session)
    : undefined;
};

const CHANNEL_ROUTES: Readonly<Record<string, string>> = {
  "submit-intent": "intent.submit",
  "read-run": "runs.read",
  "cancel-run": "runs.cancel",
  "decide-approval": "approvals.decide",
};
const RESPONSE_KINDS: Readonly<Record<string, string>> = {
  "intent.submit": "intent-admitted",
  "runs.read": "run-viewed",
  "runs.cancel": "cancel-requested",
  "approvals.decide": "decision-recorded",
};
const routeTarget = (
  route: CompiledRoute,
  params: Readonly<Record<string, string>>,
): string =>
  route.routeId === "intent.submit"
    ? params.agentId
    : route.routeId === "approvals.decide"
      ? params.approvalId
      : params.runId ?? route.routeId;

const channelMatches = (
  channel: VerifiedChannel,
  route: CompiledRoute,
  params: Readonly<Record<string, string>>,
  requestHeaders: Readonly<Record<string, string>>,
): boolean =>
  CHANNEL_ROUTES[channel.claims.controlOperation] === route.routeId &&
  channel.claims.normalizedTarget === routeTarget(route, params) &&
  (route.method !== "POST" ||
    requestHeaders["idempotency-key"] ===
      deriveTelegramIdempotencyKey(channel.claims.updateOccurrenceKey));

const responseInteractionRef = (
  composition: HangarHttpComposition,
  channel: VerifiedChannel | undefined,
  route: CompiledRoute,
  params: Readonly<Record<string, string>>,
  requestHeaders: Readonly<Record<string, string>>,
  body: unknown,
): string | undefined => {
  const config = composition.telegramChannel;
  const responseKind = RESPONSE_KINDS[route.routeId];
  if (!channel || !config || !responseKind) return undefined;
  const target = routeTarget(route, params);
  return signControlInteractionRef(
    {
      schemaVersion: "control-interaction-ref-v1",
      updateInteractionRefDigest: channel.updateRefDigest,
      routeId: route.routeId,
      normalizedTarget: target,
      responseKind: responseKind as
        | "intent-admitted"
        | "run-viewed"
        | "cancel-requested"
        | "decision-recorded",
      commandIdentityDigest:
        route.method === "POST"
          ? digestJson([
              channel.authority.representedSubjectId,
              route.routeId,
              target,
              requestHeaders["idempotency-key"] ?? "",
            ])
          : null,
      responseDigest: digestJson(body),
      factHead: null,
      expiryUnixMs: channel.claims.expiryUnixMs,
      macKeyGeneration: config.macKeyGeneration,
    },
    config.controlRefSecret,
  );
};

const authenticateWrite = (
  composition: HangarHttpComposition,
  request: IncomingMessage,
): AuthorityContext | undefined => {
  const values = headers(request.rawHeaders);
  if (values.authorization) return authenticate(composition, request);
  const parsed = values.cookie ? parseCookieHeader(values.cookie) : undefined;
  if (
    !parsed?.ok ||
    !parsed.cookies.hangar_session ||
    !parsed.cookies.hangar_csrf ||
    !values.origin ||
    !values["x-hangar-csrf"] ||
    !composition.auth.verifyWriteCsrfOrigin({
      sessionCookie: parsed.cookies.hangar_session,
      csrfCookie: parsed.cookies.hangar_csrf,
      csrfHeader: values["x-hangar-csrf"],
      origin: values.origin,
    })
  )
    return undefined;
  return composition.auth.authenticateSession(parsed.cookies.hangar_session);
};

function handleAuthSession(
  composition: HangarHttpComposition,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const values = headers(request.rawHeaders);
  const authorization = /^Bearer ([\x21-\x7e]{1,1024})$/.exec(
    values.authorization ?? "",
  );
  const action = values["x-hangar-session-action"];
  if (!authorization || !["establish", "renew"].includes(action ?? "")) {
    sendError(response, 400, "bad_request");
    return;
  }
  const parsedCookies = values.cookie
    ? parseCookieHeader(values.cookie)
    : { ok: true as const, cookies: {} as Readonly<Record<string, string>> };
  if (!parsedCookies.ok) {
    sendError(response, 400, "bad_request");
    return;
  }
  const result = composition.auth.exchangeSession({
    action: action as "establish" | "renew",
    bootstrapToken: authorization[1],
    origin: values.origin ?? "",
    predecessorHeader: values["x-hangar-session-predecessor"],
    hintCookie: parsedCookies.cookies.hangar_session_hint,
    ambientSessionCookie: parsedCookies.cookies.hangar_session,
  });
  if (result.ok) {
    response.writeHead(204, {
      "set-cookie": result.headers.setCookie,
      "cache-control": result.headers.cacheControl,
      "x-hangar-session-expiry": String(result.headers.expiresAtUnixMs),
    });
    response.end();
    return;
  }
  response.writeHead(result.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(result.predecessorHint
      ? { "x-hangar-session-predecessor": result.predecessorHint }
      : {}),
  });
  response.end(JSON.stringify(wireError(result.error, result.error)));
}

const statusFor = (error: ErrorKind): number =>
  error === "invalid_input"
    ? 400
    : error === "forbidden"
      ? 403
      : error === "not_found" || error === "cursor_unavailable"
        ? 404
        : error === "idempotency_conflict" ||
            error === "terminal_conflict" ||
            error === "invalid_state"
          ? 409
          : error === "expired"
            ? 410
            : error === "stale_epoch"
              ? 412
              : 500;

const sendError = (
  response: ServerResponse,
  status: number,
  error: string,
  message = error,
): void => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(wireError(error, message)));
};

const sendRouteJson = (
  route: CompiledRoute,
  response: ServerResponse,
  body: unknown,
  etag?: string,
  status = 200,
  interactionRef?: string,
): void => {
  const parsed = route.responseSchema?.safeParse(body);
  if (!parsed?.success) {
    sendError(response, 500, "protocol_error");
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(etag ? { etag } : {}),
    ...(interactionRef
      ? { "x-hangar-interaction-ref": interactionRef }
      : {}),
  });
  response.end(JSON.stringify(parsed.data));
};

export interface HangarViewAssets {
  readonly html: string;
  readonly appJs: string;
  readonly browserSdkJs: string;
}

export function loadBundledHangarViewAssets(): HangarViewAssets {
  return {
    html: readFileSync(
      new URL("../hangar-view/public/index.html", import.meta.url),
      "utf8",
    ),
    appJs: readFileSync(
      new URL("../hangar-view/public/app.js", import.meta.url),
      "utf8",
    ),
    browserSdkJs: readFileSync(
      new URL(
        "../../packages/control-sdk/browser.generated.js",
        import.meta.url,
      ),
      "utf8",
    ),
  };
}

export function createHangarReadServer(
  composition: HangarHttpComposition,
  options: {
    readonly heartbeatMs?: number;
    readonly viewAssets?: HangarViewAssets;
    readonly guardDeadlines?: {
      readonly headersDeadlineMs?: number;
      readonly bodyDeadlineMs?: number;
    };
  } = {},
) {
  return createGuardedServer((request, response, body) => {
    void handleReadRequest(composition, request, response, body, options);
  }, options.guardDeadlines);
}

async function handleReadRequest(
  composition: HangarHttpComposition,
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer | null,
  options: {
    readonly heartbeatMs?: number;
    readonly viewAssets?: HangarViewAssets;
    readonly guardDeadlines?: {
      readonly headersDeadlineMs?: number;
      readonly bodyDeadlineMs?: number;
    };
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://hangar.invalid");
  if (request.method === "GET" && options.viewAssets) {
    const asset =
      url.pathname === "/"
        ? { body: options.viewAssets.html, type: "text/html; charset=utf-8" }
        : url.pathname === "/hangar-view.js"
          ? {
              body: options.viewAssets.appJs,
              type: "text/javascript; charset=utf-8",
            }
          : url.pathname === "/control-sdk.js"
            ? {
                body: options.viewAssets.browserSdkJs,
                type: "text/javascript; charset=utf-8",
              }
            : undefined;
    if (asset) {
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
      });
      response.end(asset.body);
      return;
    }
  }
  const matched = matchRoute(
    request.method ?? "GET",
    `${url.pathname}${url.search}`,
  );
  if (!matched.ok) {
    sendError(response, matched.status, "invalid_input");
    return;
  }
  const classified = classifyHeaders(matched.route, request.rawHeaders);
  if (!classified.ok) {
    sendError(
      response,
      classified.status,
      classified.error.error.kind,
      classified.error.error.message,
    );
    return;
  }
  if (matched.route.routeId === "auth.session") {
    handleAuthSession(composition, request, response);
    return;
  }
  if (matched.route.authMode !== "control") {
    sendError(response, 404, "not_found");
    return;
  }
  const requestHeaders = headers(request.rawHeaders);
  const channel = requestHeaders["x-hangar-channel-context"]
    ? verifiedChannel(composition, request)
    : undefined;
  const authority =
    matched.route.method === "POST"
      ? authenticateWrite(composition, request)
      : authenticate(composition, request);
  if (!authority) {
    sendError(response, 401, "unauthorized");
    return;
  }
  if (
    requestHeaders["x-hangar-channel-context"] &&
    (!channel ||
      !channelMatches(
        channel,
        matched.route,
        matched.params,
        requestHeaders,
      ))
  ) {
    sendError(response, 403, "forbidden");
    return;
  }
  const interactionFor = (bodyValue: unknown): string | undefined =>
    responseInteractionRef(
      composition,
      channel,
      matched.route,
      matched.params,
      requestHeaders,
      bodyValue,
    );
  const control = composition.control.control;
  if (matched.route.routeId === "agents.list") {
    const result = control.listAgents(authority);
    result.ok
      ? sendRouteJson(matched.route, response, { agents: result.value.value })
      : sendError(response, statusFor(result.error), result.error);
    return;
  }
  if (matched.route.routeId === "releases.list") {
    const result = control.listReleases(authority, matched.params.agentId);
    result.ok
      ? sendRouteJson(
          matched.route,
          response,
          { releases: result.value.value },
          `"${digestJson(result.value.value)}"`,
        )
      : sendError(response, statusFor(result.error), result.error);
    return;
  }
  if (matched.route.routeId === "runs.read") {
    const result = control.readRun(authority, matched.params.runId);
    result.ok
      ? sendRouteJson(
          matched.route,
          response,
          result.value.value,
          `"${digestJson(result.value.value)}"`,
          200,
          interactionFor(result.value.value),
        )
      : sendError(response, statusFor(result.error), result.error);
    return;
  }
  if (matched.route.routeId === "health.read") {
    const result = control.readHealth(authority);
    result.ok
      ? sendRouteJson(matched.route, response, { health: result.value.value })
      : sendError(response, statusFor(result.error), result.error);
    return;
  }
  if (matched.route.routeId === "runs.events") {
    await streamEvents(
      composition,
      request,
      response,
      authority,
      matched.params.runId,
      headers(request.rawHeaders)["last-event-id"] ?? null,
      options.heartbeatMs,
    );
    return;
  }
  if (matched.route.method === "POST") {
    if (!body || !matched.route.bodySchema) {
      sendError(response, 400, "invalid_input");
      return;
    }
    let raw: unknown;
    try {
      raw = parseStrictJson(body);
    } catch {
      sendError(response, 400, "invalid_input");
      return;
    }
    const parsed = matched.route.bodySchema.safeParse(raw);
    if (!parsed.success) {
      sendError(response, 400, "invalid_input");
      return;
    }
    const values = headers(request.rawHeaders);
    const idempotencyKey = values["idempotency-key"];
    const ifMatch = /^"([0-9a-f]{64})"$/.exec(values["if-match"] ?? "")?.[1];
    if (!idempotencyKey || !ifMatch) {
      sendError(response, 400, "invalid_input");
      return;
    }
    const record = parsed.data as Record<string, unknown>;
    if (matched.route.routeId === "intent.submit") {
      const metadata = record.input as Record<string, unknown>;
      const result = control.admitIntentFromWire(
        authority,
        idempotencyKey,
        ifMatch,
        {
          agentId: matched.params.agentId,
          intentId: matched.params.intent,
          descriptorVersion: record.descriptorVersion as number,
          executionMode: record.executionMode as
            | "shadow-evaluator"
            | "production",
          input: { trigger: metadata.trigger as string },
        },
      );
      if (result.ok) {
        const responseBody = {
          runId: result.value.runId,
          result: result.value,
        };
        sendRouteJson(
          matched.route,
          response,
          responseBody,
          undefined,
          201,
          interactionFor(responseBody),
        );
      } else {
        sendError(response, statusFor(result.error), result.error);
      }
      return;
    }
    if (matched.route.routeId === "runs.cancel") {
      const result = control.cancelFromWire(
        authority,
        idempotencyKey,
        ifMatch,
        {
          runId: matched.params.runId,
          reasonCode: record.reasonCode as "user-requested",
        },
      );
      if (result.ok) {
        const responseBody = {
          runId: result.value.runId,
          cancelStatus: result.value.cancelStatus,
          result: result.value,
        };
        sendRouteJson(
          matched.route,
          response,
          responseBody,
          undefined,
          202,
          interactionFor(responseBody),
        );
      } else {
        sendError(response, statusFor(result.error), result.error);
      }
      return;
    }
    if (matched.route.routeId === "approvals.decide") {
      const result = control.decideApprovalByIdFromWire(
        authority,
        idempotencyKey,
        ifMatch,
        {
          approvalId: matched.params.approvalId,
          decision: record.decision as "approved" | "denied",
        },
      );
      result.ok
        ? sendRouteJson(
            matched.route,
            response,
            result.value,
            undefined,
            200,
            interactionFor(result.value),
          )
        : sendError(response, statusFor(result.error), result.error);
      return;
    }
  }
  sendError(response, 405, "invalid_input");
}

async function streamEvents(
  composition: HangarHttpComposition,
  request: IncomingMessage,
  response: ServerResponse,
  authority: AuthorityContext,
  runId: string,
  cursorValue: string | null,
  heartbeatMs = 5_000,
): Promise<void> {
  const opened = composition.control.control.openRunEventCursor(
    authority,
    runId,
    cursorValue,
    { heartbeatMs },
  );
  if (!opened.ok) {
    sendError(response, statusFor(opened.error), opened.error);
    return;
  }
  const cursor = opened.value;
  let closed = false;
  request.on("aborted", () => {
    closed = true;
    cursor.close();
  });
  response.on("close", () => {
    closed = true;
    cursor.close();
  });
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  while (!closed) {
    const page = await cursor.next();
    // Re-authenticate before disclosing each serialized batch/heartbeat.
    if (!page.ok || !authenticate(composition, request)) {
      cursor.close();
      response.end();
      return;
    }
    if (page.value.value.events.length === 0) {
      if (!response.write(": heartbeat\n\n")) {
        cursor.close();
        response.end();
        return;
      }
      continue;
    }
    for (const event of page.value.value.events) {
      const frame = `id: ${event.id}\nevent: ${event.eventKind}\ndata: ${JSON.stringify(event)}\n\n`;
      if (!response.write(frame)) {
        cursor.close();
        response.end();
        return;
      }
    }
  }
}
