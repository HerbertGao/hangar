import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Authenticator,
  type SessionExchangeResult,
} from "../../packages/auth-store-sqlite/index.ts";

const cookie = (result: SessionExchangeResult, name: string): string => {
  if (!result.ok) throw new Error(result.error);
  const header = result.headers.setCookie.find((value) =>
    value.startsWith(`${name}=`),
  );
  if (!header) throw new Error(`missing ${name}`);
  return header.slice(name.length + 1).split(";")[0];
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-auth-"));
  const path = join(directory, "auth.sqlite");
  let now = 1_000;
  let crashBefore = false;
  let crashAfter = false;
  const secrets = new Map<string, string>([["key-ref-1", "secret-key-1"]]);
  const options = {
    nowUnixMs: () => now,
    resolveSecret: (ref: string) => secrets.get(ref),
    origin: "http://127.0.0.1:8787",
    secureCookies: false,
    sessionTtlMs: 100,
    renewalGraceMs: 500,
    beforeCommit: () => {
      if (crashBefore) {
        crashBefore = false;
        throw new Error("crash-before-commit");
      }
    },
    afterCommitBeforeAck: () => {
      if (crashAfter) {
        crashAfter = false;
        throw new Error("ack-loss");
      }
    },
  };
  let auth = new Authenticator(path, options);
  auth.putHmacKey(1, "key-ref-1", true);
  auth.putCredential({
    rawToken: "bootstrap-1",
    kind: "bootstrap",
    generation: 1,
    principalId: "operator",
    scopes: ["run:read", "run:write"],
  });
  auth.putCredential({
    rawToken: "cli-1",
    kind: "cli_bearer",
    generation: 1,
    principalId: "cli-principal",
    scopes: ["run:read"],
  });
  auth.putCredential({
    rawToken: "telegram-service-1",
    kind: "telegram_service",
    generation: 1,
    principalId: "telegram-principal",
    scopes: ["run:read"],
  });
  auth.putTelegramMapping({
    servicePrincipalId: "telegram-principal",
    userId: "42",
    chatId: "7",
    mappingVersion: 1,
    representedSubjectId: "represented-42",
    scopes: ["run:read", "approval:write"],
  });
  const establish = (token = "bootstrap-1", ambientSessionCookie?: string) =>
    auth.exchangeSession({
      action: "establish",
      bootstrapToken: token,
      origin: options.origin,
      ambientSessionCookie,
    });
  const renew = (
    predecessorHeader?: string,
    hintCookie?: string,
    token = "bootstrap-1",
  ) =>
    auth.exchangeSession({
      action: "renew",
      bootstrapToken: token,
      origin: options.origin,
      predecessorHeader,
      hintCookie,
    });
  return {
    directory,
    path,
    options,
    secrets,
    get auth() {
      return auth;
    },
    establish,
    renew,
    setNow: (value: number) => {
      now = value;
    },
    crashBefore: () => {
      crashBefore = true;
    },
    crashAfter: () => {
      crashAfter = true;
    },
    reopen: () => {
      auth.close();
      auth = new Authenticator(path, options);
    },
    close: async () => {
      auth.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("establish is none-or-complete and ACK-loss replay returns identical headers", async () => {
  const f = await fixture();
  try {
    f.crashBefore();
    assert.deepEqual(f.establish(), {
      ok: false,
      status: 500,
      error: "auth_store_failure",
    });
    const first = f.establish();
    assert.ok(first.ok);
    const firstHeaders = first.ok ? first.headers : undefined;
    assert.deepEqual(f.establish(), first);

    // Separate generation: after-commit failure survives restart exactly.
    f.auth.putCredential({
      rawToken: "bootstrap-2",
      kind: "bootstrap",
      generation: 2,
      principalId: "operator",
      scopes: ["run:read"],
    });
    f.crashAfter();
    assert.deepEqual(f.establish("bootstrap-2"), {
      ok: false,
      status: 500,
      error: "auth_store_failure",
    });
    f.reopen();
    const replay = f.establish("bootstrap-2");
    assert.ok(replay.ok);
    assert.notEqual(
      replay.ok ? replay.headers.sessionId : "",
      firstHeaders?.sessionId,
    );
    assert.deepEqual(f.establish("bootstrap-2"), replay);
  } finally {
    await f.close();
  }
});

test("establish ignores ambient old cookies; expiry returns 410 then explicit renew", async () => {
  const f = await fixture();
  try {
    const first = f.establish();
    assert.ok(first.ok);
    const sessionCookie = cookie(first, "hangar_session");
    f.auth.putCredential({
      rawToken: "bootstrap-2",
      kind: "bootstrap",
      generation: 2,
      principalId: "operator-v2",
      scopes: ["run:read"],
    });
    const second = f.establish("bootstrap-2", sessionCookie);
    assert.ok(second.ok);
    assert.notEqual(
      second.ok ? second.headers.sessionId : "",
      first.ok ? first.headers.sessionId : "",
    );

    f.setNow(1_100);
    const gone = f.establish();
    assert.ok(!gone.ok && gone.status === 410 && gone.predecessorHint);
    assert.deepEqual(f.renew(), {
      ok: false,
      status: 400,
      error: "bad_request",
    });
    assert.deepEqual(f.renew(gone.predecessorHint, "different"), {
      ok: false,
      status: 400,
      error: "bad_request",
    });
    const successor = f.renew(gone.predecessorHint);
    assert.ok(successor.ok && successor.headers.sessionGeneration === 2);
  } finally {
    await f.close();
  }
});

test("old predecessor replay never creates next generation; successor hint owns next renew", async () => {
  const f = await fixture();
  try {
    const first = f.establish();
    const firstCookie = cookie(first, "hangar_session");
    const firstHint = cookie(first, "hangar_session_hint");
    f.setNow(1_100);
    const second = f.renew(firstHint, firstHint);
    assert.ok(second.ok && second.headers.sessionGeneration === 2);
    assert.equal(f.auth.authenticateSession(firstCookie), undefined);
    assert.equal(
      f.auth.authenticateSession(cookie(second, "hangar_session"))?.principalId,
      "operator",
    );
    const secondHint = cookie(second, "hangar_session_hint");
    f.setNow(1_200);
    assert.deepEqual(f.renew(firstHint, firstHint), second);
    const third = f.renew(secondHint, secondHint);
    assert.ok(third.ok && third.headers.sessionGeneration === 3);
    assert.deepEqual(f.renew(firstHint, firstHint), second);
  } finally {
    await f.close();
  }
});

test("key rotation affects only new sessions; missing retained key fails closed", async () => {
  const f = await fixture();
  try {
    const first = f.establish();
    assert.ok(first.ok);
    f.secrets.set("key-ref-2", "secret-key-2");
    f.auth.putHmacKey(2, "key-ref-2", true);
    assert.deepEqual(f.establish(), first);
    f.secrets.delete("key-ref-1");
    assert.deepEqual(f.establish(), {
      ok: false,
      status: 500,
      error: "auth_store_failure",
    });
  } finally {
    await f.close();
  }
});

test("revocation, CSRF/origin, CLI bearer and Telegram delegation are server-owned", async () => {
  const f = await fixture();
  try {
    const established = f.establish();
    const sessionCookie = cookie(established, "hangar_session");
    const csrf = cookie(established, "hangar_csrf");
    assert.equal(
      f.auth.verifyWriteCsrfOrigin({
        sessionCookie,
        csrfCookie: csrf,
        csrfHeader: csrf,
        origin: f.options.origin,
      }),
      true,
    );
    assert.equal(
      f.auth.verifyWriteCsrfOrigin({
        sessionCookie,
        csrfCookie: csrf,
        csrfHeader: `${csrf}x`,
        origin: f.options.origin,
      }),
      false,
    );
    assert.equal(
      f.auth.verifyWriteCsrfOrigin({
        sessionCookie,
        csrfCookie: csrf,
        csrfHeader: csrf,
        origin: "http://evil.invalid",
      }),
      false,
    );

    assert.equal(
      f.auth.authenticateBearer("cli-1")?.principalId,
      "cli-principal",
    );
    const telegram = f.auth.authenticateTelegram({
      serviceToken: "telegram-service-1",
      userId: "42",
      chatId: "7",
      mappingVersion: 1,
    });
    assert.equal(telegram?.representedSubjectId, "represented-42");
    assert.equal(
      f.auth.authenticateTelegram({
        serviceToken: "telegram-service-1",
        userId: "42",
        chatId: "7",
        mappingVersion: 2,
      }),
      undefined,
    );

    f.auth.revokeCredential("bootstrap", 1);
    assert.equal(f.auth.authenticateSession(sessionCookie), undefined);
    f.setNow(1_100);
    const hint = cookie(established, "hangar_session_hint");
    assert.deepEqual(f.renew(hint, hint), {
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    assert.equal(
      readFileSync(f.path).includes(Buffer.from("bootstrap-1")),
      false,
    );
  } finally {
    await f.close();
  }
});
