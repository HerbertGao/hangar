import assert from "node:assert/strict";
import { connect } from "node:net";
import type { Server } from "node:http";
import test from "./scenario-test.ts";
import {
  LIMITS,
  analyzeRequestHead,
  checkSafetyHeaderDuplicates,
  createGuardedServer,
  parseCookieHeader,
  parseStrictJson,
  wireError,
} from "../../packages/control-api/index.ts";

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, () => resolve(server.address()!.port));
  });

const rawRequest = (
  port: number,
  payload: string,
  end = true,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(port);
    let data = "";
    socket.on("data", (chunk) => {
      data += Buffer.from(chunk as Uint8Array).toString("utf8");
    });
    socket.on("close", () => {
      const match = data.match(/^HTTP\/1\.1 (\d{3})/);
      resolve({ status: match ? Number(match[1]) : 0, body: data });
    });
    socket.on("error", (error) =>
      reject(error instanceof Error ? error : undefined),
    );
    socket.write(payload);
    if (end) socket.end();
  });

test.scenarios(
  ["m2c.control-boundary"],
  "head analyzer enforces header caps and Content-Length/TE conflicts",
  () => {
    // >64 headers
    const manyHeaders: string[] = [];
    for (let index = 0; index < 65; index += 1)
      manyHeaders.push(`x-pad-${index}`, "1");
    assert.equal(analyzeRequestHead("GET", manyHeaders).ok, false);
    // single value >8KiB
    const bigValue = "a".repeat(8 * 1024 + 1);
    assert.equal(analyzeRequestHead("GET", ["x-big", bigValue]).ok, false);
    // total >32KiB via many mid-size headers is capped at 64 headers first;
    // use 60 headers x ~560B each
    const total: string[] = [];
    for (let index = 0; index < 60; index += 1)
      total.push(`x-t-${index}`, "b".repeat(570));
    assert.equal(analyzeRequestHead("GET", total).ok, false);
    // conflicting duplicate Content-Length
    const conflict = analyzeRequestHead("POST", [
      "content-length",
      "5",
      "content-length",
      "6",
    ]);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.match(conflict.error.error.kind, /content_length/);
    // non-digit Content-Length
    const invalid = analyzeRequestHead("POST", ["content-length", "5x"]);
    assert.equal(invalid.ok, false);
    // CL+TE together
    const clte = analyzeRequestHead("POST", [
      "content-length",
      "5",
      "transfer-encoding",
      "chunked",
    ]);
    assert.equal(clte.ok, false);
    // unsupported Transfer-Encoding token
    const badTe = analyzeRequestHead(
      "POST",
      [["transfer-encoding", "gzip"]].flat(),
    );
    assert.equal(badTe.ok, false);
    // healthy POST with body
    const healthy = analyzeRequestHead("POST", ["content-length", "11"]);
    assert.deepEqual(
      healthy.ok
        ? { len: healthy.contentLength, body: healthy.expectsBody }
        : {},
      { len: 11, body: true },
    );
    // GET without declared body does not enter the body phase
    const getHead = analyzeRequestHead("GET", []);
    assert.ok(getHead.ok && !getHead.expectsBody);
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "safety-header duplicates rejected ASCII case-insensitively over rawHeaders",
  () => {
    assert.equal(
      checkSafetyHeaderDuplicates(["authorization", "Bearer a"]).ok,
      true,
    );
    assert.equal(
      checkSafetyHeaderDuplicates([
        "Authorization",
        "Bearer a",
        "AUTHORIZATION",
        "Bearer b",
      ]).ok,
      false,
    );
    assert.equal(
      checkSafetyHeaderDuplicates([
        "idempotency-key",
        "k",
        "Idempotency-Key",
        "k",
      ]).ok,
      false,
    );
    assert.equal(
      checkSafetyHeaderDuplicates(["x-custom-a", "1", "x-custom-a", "2"]).ok,
      true,
    );
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "strict JSON rejects duplicate/escape-equivalent keys, surrogates, unsafe numbers, trailing bytes",
  () => {
    assert.deepEqual(parseStrictJson(Buffer.from('{"a":1}')), { a: 1 });
    assert.deepEqual(
      parseStrictJson(Buffer.from('{"a":[1,{"b":null}],"c":"\\ud83d\\ude00"}')),
      { a: [1, { b: null }], c: "\u{1F600}" },
    );
    const invalid: readonly string[] = [
      '{"a":1,"a":2}', // literal duplicate
      '{"a":1,"\\u0061":2}', // escape-equivalent duplicate
      '{"\\u0041":1,"A":2}', // escape-equivalent duplicate, uppercase
      '{"s":"\\ud800"}', // lone surrogate
      '{"n":12345678901234567890123}', // unsafe integer magnitude
      '{"f":1e999}', // non-finite result
      '{"z":01}', // leading zero
      "{} {} ", // trailing bytes after value
      '{"a":1}}', // trailing close brace
      "not json",
      "{'single':1}", // single quotes
    ];
    for (const candidate of invalid)
      assert.throws(() => parseStrictJson(Buffer.from(candidate)), TypeError);
    // malformed UTF-8 bytes fail before structure parsing
    assert.throws(
      () => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d])),
      TypeError,
    );
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "cookie parser enforces protected-name uniqueness and strict shapes pre-auth",
  () => {
    const happy = parseCookieHeader("other=1; hangar_session=abc_DEF-123");
    assert.ok(happy.ok && happy.cookies["hangar_session"] === "abc_DEF-123");
    const cases: readonly [string, string][] = [
      [
        "duplicate protected name",
        "hangar_session=a; hangar_csrf=b; hangar_session=c",
      ],
      ["duplicate csrf", "hangar_csrf=a; hangar_csrf=b"],
      ["empty value", "hangar_session="],
      ["empty name", "=value"],
      ["quoted value", 'hangar_session="quoted"'],
      ["control character", "hangar_session=abc\n"],
      ["non-base64url protected", "hangar_session=abc$def"],
      ["malformed pair", "justtoken"],
    ];
    for (const [label, header] of cases) {
      const result = parseCookieHeader(header);
      assert.equal(result.ok, false, label);
    }
    // Non-protected cookie cannot override a protected value.
    const shadow = parseCookieHeader(
      "hangar_session=real; hangar_session=fake",
    );
    assert.equal(shadow.ok, false);
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "guarded server returns safe errors before parsing/auth and passes clean bodies",
  async () => {
    const seen: { path?: string; body?: string } = {};
    const server = createGuardedServer(
      (_request, response, body) => {
        seen.path = _request.url;
        seen.body = body?.toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      },
      { bodyDeadlineMs: 400, headersDeadlineMs: 400 },
    );
    const port = await listen(server);
    try {
      // clean POST reaches handler with the full body
      const good = await fetch(`http://127.0.0.1:${port}/v1/x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      });
      assert.equal(good.status, 200);
      assert.equal(seen.body, '{"a":1}');
      assert.equal(seen.path, "/v1/x");

      // oversize body -> 413 before handler
      const big = await fetch(`http://127.0.0.1:${port}/v1/x`, {
        method: "POST",
        body: "x".repeat(LIMITS.maxBodyBytes + 1),
      });
      assert.equal(big.status, 413);
      const bigError = (await big.text()).includes("body_too_large");
      assert.ok(bigError);

      // declared vs actual length mismatch -> safe 400 before any parsing.
      // Whether our typed envelope or the HTTP stack's own 400 lands first is
      // a transport race; the contract is status+close+zero mutation.
      const mismatch = await rawRequest(
        port,
        "POST /v1/x HTTP/1.1\r\nhost:h\r\ncontent-length:10\r\n\r\nshort",
      );
      assert.equal(mismatch.status, 400);

      // CL+TE -> safe 400; Node's llhttp may answer before our head analysis,
      // so only the protocol outcome is pinned here (pure logic covered above).
      const clte = await rawRequest(
        port,
        "POST /v1/x HTTP/1.1\r\nhost:h\r\ncontent-length:5\r\ntransfer-encoding:chunked\r\n\r\n0\r\n\r\n",
      );
      assert.equal(clte.status, 400);

      // case-duplicate safety header -> 400
      const dup = await rawRequest(
        port,
        "POST /v1/x HTTP/1.1\r\nhost:h\r\ncontent-type:a/json\r\nContent-TYPE:b/json\r\ncontent-length:2\r\n\r\n{}",
      );
      assert.equal(dup.status, 400);
      assert.ok(dup.body.includes("duplicate_header"));

      // zero-body-byte timeout -> 408
      const started = Date.now();
      const slow = await rawRequest(
        port,
        "POST /v1/x HTTP/1.1\r\nhost:h\r\ncontent-type:a/json\r\ncontent-length:5\r\n\r\n",
        false,
      );
      assert.equal(slow.status, 408);
      assert.ok(Date.now() - started < 3_000);
    } finally {
      server.close();
    }
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "wire error envelope has fixed schemaVersion and kind/message shape",
  () => {
    const envelope = wireError("invalid_input", "nope", "detail-value");
    assert.equal(envelope.error.schemaVersion, "wire-error-v1");
    assert.equal(envelope.error.kind, "invalid_input");
    assert.equal(envelope.error.detail, "detail-value");
    assert.equal("detail" in wireError("k", "m").error, false);
  },
);

// ---------------------------------------------------------------------------
// Route registry — task 1.3 part C
// ---------------------------------------------------------------------------

import {
  COMPILED_ROUTES,
  ETAG_SCHEMA,
  IDEMPOTENCY_KEY_SCHEMA,
  LAST_EVENT_ID_SCHEMA,
  classifyHeaders,
  deriveDeliveryKey,
  deriveTelegramIdempotencyKey,
  deriveUpdateOccurrenceKey,
  matchRoute,
  signControlInteractionRef,
  signUpdateInteractionRef,
  verifyControlInteractionRef,
  verifyUpdateInteractionRef,
  type CONTROL_OPERATIONS,
} from "../../packages/control-api/index.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/contracts/index.ts";

test.scenarios(
  ["m2c.control-boundary"],
  "registry exposes exactly the eight v1 routes plus auth session",
  () => {
    assert.equal(COMPILED_ROUTES.length, 9);
    const expected: readonly [string, string][] = [
      ["GET", "/v1/agents"],
      ["GET", "/v1/agents/agent-1/releases"],
      ["POST", "/v1/agents/agent-1/intents/emit-heartbeat"],
      ["GET", "/v1/runs/run-1"],
      ["GET", "/v1/runs/run-1/events"],
      ["POST", "/v1/runs/run-1/cancel"],
      ["POST", "/v1/approvals/appr-1/decision"],
      ["GET", "/v1/health"],
      ["POST", "/auth/session"],
    ];
    for (const [method, path] of expected) {
      const match = matchRoute(method, path);
      assert.ok(match.ok, `${method} ${path}`);
    }
    // param extraction
    const intent = matchRoute(
      "POST",
      "/v1/agents/agent-1/intents/emit-heartbeat",
    );
    assert.ok(
      intent.ok &&
        intent.params.agentId === "agent-1" &&
        intent.params.intent === "emit-heartbeat",
    );
    // unknown path and wrong method fail typed
    const unknownPath = matchRoute("GET", "/v1/unknown");
    assert.ok(!unknownPath.ok && unknownPath.status === 404);
    const wrongMethod = matchRoute("DELETE", "/v1/health");
    assert.ok(!wrongMethod.ok && wrongMethod.status === 405);
    // query strings are rejected registry-wide (no route declares one)
    const withQuery = matchRoute("GET", "/v1/agents?limit=5");
    assert.ok(!withQuery.ok && withQuery.status === 404);
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "header classification default-denies unknown app headers and ignores transport",
  () => {
    const route = matchRoute("GET", "/v1/health");
    assert.ok(route.ok);
    // transport headers ignored
    assert.ok(
      classifyHeaders(route.ok ? route.route : route, [
        "Host",
        "127.0.0.1:0",
        "User-Agent",
        "probe",
        "Sec-Fetch-Mode",
        "cors",
        "Cache-Control",
        "no-store",
      ]).ok,
    );
    // unknown application header rejected
    const unknownHeader = classifyHeaders(route.ok ? route.route : route, [
      "X-Custom",
      "v",
    ]);
    assert.ok(!unknownHeader.ok);
    // reads cannot carry write headers
    const readWithWriteHeaders = classifyHeaders(
      route.ok ? route.route : route,
      ["Idempotency-Key", "k"],
    );
    assert.ok(!readWithWriteHeaders.ok);
    // writes require idempotency + if-match
    const writeRoute = matchRoute("POST", "/v1/runs/run-1/cancel");
    assert.ok(writeRoute.ok);
    const missingWrite = classifyHeaders(writeRoute.route, [
      "content-type",
      "application/json",
    ]);
    assert.ok(!missingWrite.ok);
    const goodWrite = classifyHeaders(writeRoute.route, [
      "content-type",
      "application/json",
      "Idempotency-Key",
      "key-1",
      "If-Match",
      `"${"a".repeat(64)}"`,
    ]);
    assert.ok(goodWrite.ok);
    // malformed etag/idempotency shapes rejected
    assert.equal(ETAG_SCHEMA.safeParse('"not-hex"').success, false);
    assert.equal(IDEMPOTENCY_KEY_SCHEMA.safeParse("").success, false);
    assert.equal(
      IDEMPOTENCY_KEY_SCHEMA.safeParse("k".repeat(129)).success,
      false,
    );
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "SSE cursor aliases are typed-rejected before any lookup",
  () => {
    const invalid: readonly string[] = [
      "01",
      "+1",
      "-1",
      "1.0",
      "1e3",
      " 1",
      "9007199254740992", // MAX_SAFE + 1
      "",
      "12x",
    ];
    for (const candidate of invalid)
      assert.equal(
        LAST_EVENT_ID_SCHEMA.safeParse(candidate).success,
        false,
        candidate,
      );
    assert.equal(
      LAST_EVENT_ID_SCHEMA.safeParse("9007199254740991").success,
      true,
    );
    assert.equal(LAST_EVENT_ID_SCHEMA.safeParse("123").success, true);
  },
);

// ---------------------------------------------------------------------------
// Telegram refs — task 1.3 part D
// ---------------------------------------------------------------------------

const refSecret = "unit-test-ref-secret";
const baseClaims = {
  schemaVersion: "telegram-update-ref-v1" as const,
  connectorInstanceId: "connector-1",
  adapterInstanceId: "adapter-1",
  serviceAuthorityId: "authority-1",
  serviceCredentialGeneration: 1,
  updateId: "1001",
  updateOccurrenceKey: deriveUpdateOccurrenceKey(
    "connector-1",
    "authority-1",
    "1001",
  ),
  userId: "42",
  chatId: "7",
  messageIdOrCallbackId: "2002" as string | null,
  mappingVersion: 3,
  controlOperation: "read-run" as (typeof CONTROL_OPERATIONS)[number],
  normalizedTarget: "run-abc",
  rawUpdateDigest: createHash("sha256").update("raw").digest("hex"),
  expiryUnixMs: Date.now() + 60_000,
};

test.scenarios(
  ["m2c.control-boundary"],
  "occurrence key is canonical-order-stable; idempotency key derives from it",
  () => {
    assert.equal(
      deriveUpdateOccurrenceKey("c", "s", "u"),
      createHash("sha256")
        .update(canonicalJson(["telegram-update-v1", "c", "s", "u"]))
        .digest("hex"),
    );
    const occurrenceKey = deriveUpdateOccurrenceKey("c", "s", "u");
    assert.equal(
      deriveTelegramIdempotencyKey(occurrenceKey),
      createHash("sha256")
        .update(canonicalJson(["telegram-control-v1", occurrenceKey]))
        .digest("hex"),
    );
    // different update id -> different occurrence key
    assert.notEqual(
      deriveUpdateOccurrenceKey("c", "s", "u"),
      deriveUpdateOccurrenceKey("c", "s", "u2"),
    );
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "update interaction ref verifies MAC/expiry/size and fails closed",
  () => {
    const encoded = signUpdateInteractionRef(baseClaims, refSecret);
    assert.ok(encoded.length <= 2048);
    const verified = verifyUpdateInteractionRef(encoded, refSecret, Date.now());
    assert.ok(verified.ok && verified.claims.updateId === "1001");

    // tampered claims -> bad_mac
    const tampered = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as {
      claims: Record<string, unknown>;
      mac: string;
    };
    tampered.claims.normalizedTarget = "run-forged";
    const reencoded = Buffer.from(JSON.stringify(tampered)).toString(
      "base64url",
    );
    assert.equal(
      verifyUpdateInteractionRef(reencoded, refSecret, Date.now()).ok,
      false,
    );

    // wrong secret -> bad_mac
    assert.equal(
      verifyUpdateInteractionRef(encoded, "other-secret", Date.now()).ok,
      false,
    );

    // expired -> expired
    const expiredClaims = { ...baseClaims, expiryUnixMs: Date.now() - 1 };
    const expiredEncoded = signUpdateInteractionRef(expiredClaims, refSecret);
    const expiredResult = verifyUpdateInteractionRef(
      expiredEncoded,
      refSecret,
      Date.now(),
    );
    assert.ok(!expiredResult.ok && expiredResult.reason === "expired");

    // malformed payload -> malformed
    assert.equal(
      verifyUpdateInteractionRef(
        Buffer.from("{broken").toString("base64url"),
        refSecret,
        Date.now(),
      ).ok,
      false,
    );

    // oversize envelope -> oversize (claims padded via a huge target would fail
    // schema first, so drive the bound through an absurdly long secret-free path)
    const oversize = "A".repeat(2049);
    const oversizeResult = verifyUpdateInteractionRef(
      oversize,
      refSecret,
      Date.now(),
    );
    assert.ok(!oversizeResult.ok && oversizeResult.reason === "oversize");
  },
);

test.scenarios(
  ["m2c.control-boundary"],
  "control interaction refs bind response kind/digest and verify symmetrically",
  () => {
    const claims = {
      schemaVersion: "control-interaction-ref-v1" as const,
      updateInteractionRefDigest: createHash("sha256")
        .update("ref")
        .digest("hex"),
      routeId: "runs.read",
      normalizedTarget: "run-abc",
      responseKind: "run-viewed" as const,
      commandIdentityDigest: null,
      responseDigest: createHash("sha256").update("projection").digest("hex"),
      factHead: 17 as number | null,
      expiryUnixMs: Date.now() + 30_000,
      macKeyGeneration: 2,
    };
    const encoded = signControlInteractionRef(claims, refSecret);
    assert.ok(encoded.length <= 2048);
    const verified = verifyControlInteractionRef(
      encoded,
      refSecret,
      Date.now(),
    );
    assert.ok(verified.ok && verified.claims.factHead === 17);
    assert.equal(
      verifyControlInteractionRef(encoded, refSecret, Date.now() + 31_000).ok,
      false,
    );

    // delivery key derives only from ref digest + operation + response kind
    const digest = createHash("sha256").update("ref").digest("hex");
    assert.equal(
      deriveDeliveryKey(digest, "send-message", "run-viewed"),
      createHash("sha256")
        .update(
          canonicalJson([
            "telegram-delivery-v1",
            digest,
            "send-message",
            "run-viewed",
          ]),
        )
        .digest("hex"),
    );
  },
);
