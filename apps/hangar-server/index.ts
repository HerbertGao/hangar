import type { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  Authenticator,
  type AuthStoreOptions,
} from "../../packages/auth-store-sqlite/index.ts";
import {
  createEffectGateway,
  type ControlOptions,
} from "../../packages/control-core/index.ts";
import {
  classifyHeaders,
  createGuardedServer,
  matchRoute,
  parseCookieHeader,
  parseStrictJson,
  wireError,
  type CompiledRoute,
} from "../../packages/control-api/index.ts";
import {
  digestJson,
  type AuthorityContext,
  type ErrorKind,
} from "../../packages/contracts/index.ts";
import {
  openSqliteControl,
  type StoreOptions,
} from "../../packages/control-store-sqlite/index.ts";

export interface HangarServerConfig {
  readonly host?: string;
  readonly tls: boolean;
  readonly secureCookies: boolean;
  readonly controlPath: string;
  readonly controlStore: StoreOptions;
  readonly controlOptions?: ControlOptions;
  readonly authPath: string;
  readonly authOptions: Omit<AuthStoreOptions, "secureCookies">;
}

const loopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

/** Composition only: wire handlers land in tasks 4.2/4.3. */
export function createHangarServerComposition(config: HangarServerConfig) {
  const host = config.host ?? "127.0.0.1";
  if (!loopback(host) && (!config.tls || !config.secureCookies))
    throw new Error("non_loopback_requires_tls_and_secure_cookies");
  if (resolve(config.controlPath) === resolve(config.authPath))
    throw new Error("auth_store_must_be_physically_separate");
  const control = openSqliteControl(
    config.controlPath,
    config.controlStore,
    config.controlOptions,
  );
  let auth: Authenticator;
  try {
    auth = new Authenticator(config.authPath, {
      ...config.authOptions,
      secureCookies: config.secureCookies,
    });
  } catch (error) {
    control.close();
    throw error;
  }
  const gateway = createEffectGateway(control.control);
  return {
    host,
    control,
    auth,
    gateway,
    close: () => {
      auth.close();
      control.close();
    },
  };
}

export type HangarServerComposition = ReturnType<
  typeof createHangarServerComposition
>;

const headers = (
  rawHeaders: readonly string[],
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2)
    result[rawHeaders[index].toLowerCase()] = rawHeaders[index + 1];
  return result;
};

const authenticate = (
  composition: HangarServerComposition,
  request: IncomingMessage,
): AuthorityContext | undefined => {
  const values = headers(request.rawHeaders);
  const authorization = values.authorization;
  const cookieHeader = values.cookie;
  if ((authorization && cookieHeader) || (!authorization && !cookieHeader))
    return undefined;
  if (authorization) {
    const match = /^Bearer ([\x21-\x7e]{1,1024})$/.exec(authorization);
    return match ? composition.auth.authenticateBearer(match[1]) : undefined;
  }
  const parsed = parseCookieHeader(cookieHeader!);
  return parsed.ok && parsed.cookies.hangar_session
    ? composition.auth.authenticateSession(parsed.cookies.hangar_session)
    : undefined;
};

const authenticateWrite = (
  composition: HangarServerComposition,
  request: IncomingMessage,
): AuthorityContext | undefined => {
  const values = headers(request.rawHeaders);
  if (values.authorization) return authenticate(composition, request);
  const parsed = values.cookie
    ? parseCookieHeader(values.cookie)
    : undefined;
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
  composition: HangarServerComposition,
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
    html: readFileSync(new URL("../hangar-view/public/index.html", import.meta.url), "utf8"),
    appJs: readFileSync(new URL("../hangar-view/public/app.js", import.meta.url), "utf8"),
    browserSdkJs: readFileSync(
      new URL("../../packages/control-sdk/browser.generated.js", import.meta.url),
      "utf8",
    ),
  };
}

export function createHangarReadServer(
  composition: HangarServerComposition,
  options: {
    readonly heartbeatMs?: number;
    readonly viewAssets?: HangarViewAssets;
    readonly guardDeadlines?: {
      readonly headersDeadlineMs?: number;
      readonly bodyDeadlineMs?: number;
    };
  } = {},
) {
  return createGuardedServer(
    (request, response, body) => {
      void handleReadRequest(composition, request, response, body, options);
    },
    options.guardDeadlines,
  );
}

async function handleReadRequest(
  composition: HangarServerComposition,
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
  const authority =
    matched.route.method === "POST"
      ? authenticateWrite(composition, request)
      : authenticate(composition, request);
  if (!authority) {
    sendError(response, 401, "unauthorized");
    return;
  }
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
      result.ok
        ? sendRouteJson(
            matched.route,
            response,
            { runId: result.value.runId, result: result.value },
            undefined,
            201,
          )
        : sendError(response, statusFor(result.error), result.error);
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
      result.ok
        ? sendRouteJson(
            matched.route,
            response,
            {
              runId: result.value.runId,
              cancelStatus: result.value.cancelStatus,
              result: result.value,
            },
            undefined,
            202,
          )
        : sendError(response, statusFor(result.error), result.error);
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
        ? sendRouteJson(matched.route, response, result.value)
        : sendError(response, statusFor(result.error), result.error);
      return;
    }
  }
  sendError(response, 405, "invalid_input");
}

async function streamEvents(
  composition: HangarServerComposition,
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
