import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Authenticator } from "../../packages/auth-store-sqlite/index.ts";
import { ROUTES } from "../../packages/control-api/index.ts";

const cookie = (header: string): string =>
  header.slice(header.indexOf("=") + 1).split(";")[0];

test("credential mapping and single-session exchange produce replay-stable secure header block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-auth-contract-"));
  const path = join(directory, "auth.sqlite");
  let now = 1_000;
  const auth = new Authenticator(path, {
    nowUnixMs: () => now,
    resolveSecret: () => "external-key-material",
    origin: "http://127.0.0.1:8787",
    secureCookies: false,
    sessionTtlMs: 1_000,
    renewalGraceMs: 5_000,
  });
  try {
    auth.putHmacKey(1, "key-ref", true);
    auth.putCredential({
      rawToken: "bootstrap-secret",
      kind: "bootstrap",
      generation: 1,
      principalId: "operator-subject",
      scopes: ["run:read", "run:write"],
    });
    const input = {
      action: "establish" as const,
      bootstrapToken: "bootstrap-secret",
      origin: "http://127.0.0.1:8787",
      ambientSessionCookie: "ignored-old-cookie",
    };
    const first = auth.exchangeSession(input);
    assert.ok(first.ok);
    assert.deepEqual(auth.exchangeSession(input), first);
    assert.equal(first.headers.setCookie.length, 3);
    assert.match(
      first.headers.setCookie[0],
      /hangar_session=.*HttpOnly; SameSite=Strict/,
    );
    assert.match(first.headers.setCookie[1], /hangar_csrf=.*SameSite=Strict/);
    assert.match(
      first.headers.setCookie[2],
      /hangar_session_hint=.*SameSite=Strict/,
    );
    const session = cookie(first.headers.setCookie[0]);
    const csrf = cookie(first.headers.setCookie[1]);
    const context = auth.authenticateSession(session);
    assert.equal(context?.principalId, "operator-subject");
    assert.deepEqual(context?.effectiveScope, ["run:read", "run:write"]);
    assert.equal(auth.authenticateSession(`${session}forged`), undefined);
    assert.equal(
      auth.verifyWriteCsrfOrigin({
        sessionCookie: session,
        csrfCookie: csrf,
        csrfHeader: csrf,
        origin: "http://127.0.0.1:8787",
      }),
      true,
    );
    now = 2_001;
    const gone = auth.exchangeSession(input);
    assert.ok(!gone.ok && gone.status === 410 && gone.predecessorHint);
    assert.equal(
      readFileSync(path).includes(Buffer.from("bootstrap-secret")),
      false,
    );
  } finally {
    auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("client actor/delegation/runtime fields are rejected by the unique route schema", () => {
  const schema = ROUTES.find(({ routeId }) => routeId === "intent.submit")!
    .bodySchema!;
  const base = {
    descriptorVersion: 1,
    executionMode: "shadow-evaluator",
    input: { trigger: "manual" },
  };
  assert.equal(schema.safeParse(base).success, true);
  for (const forged of [
    { ...base, actor: "forged" },
    { ...base, representedSubjectId: "forged" },
    { ...base, delegation: { scope: "admin" } },
    { ...base, runtimeState: {} },
    { ...base, secret: "raw" },
  ])
    assert.equal(schema.safeParse(forged).success, false);
});
