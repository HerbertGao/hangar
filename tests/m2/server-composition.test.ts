import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHangarServerComposition } from "../../apps/hangar-server/index.ts";
import { RecoveryAuthority } from "../../packages/control-store-sqlite/index.ts";

const authOptions = {
  nowUnixMs: () => 1_000,
  resolveSecret: (_ref: string) => "secret",
  origin: "http://127.0.0.1:8787",
};

async function base() {
  const directory = await mkdtemp(join(tmpdir(), "hangar-m2-server-"));
  const authorityPath = join(directory, "authority.sqlite");
  const authority = new RecoveryAuthority(authorityPath);
  const initialized = authority.initialize("database-server", "target-server");
  if (!initialized.ok) throw new Error(initialized.error);
  return {
    directory,
    authorityPath,
    authority,
    fence: initialized.value,
    close: async () => {
      authority.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("composition defaults loopback and keeps AuthStore physically/minimally separate", async () => {
  const fixture = await base();
  try {
    const controlPath = join(fixture.directory, "control.sqlite");
    const authPath = join(fixture.directory, "auth.sqlite");
    const composition = createHangarServerComposition({
      tls: false,
      secureCookies: false,
      controlPath,
      controlStore: {
        authorityPath: fixture.authorityPath,
        fence: fixture.fence,
      },
      authPath,
      authOptions,
    });
    assert.equal(composition.host, "127.0.0.1");
    composition.close();
    const auth = new DatabaseSync(authPath);
    try {
      const tables = auth
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      assert.ok(tables.includes("auth_sessions"));
      for (const forbidden of [
        "source_facts",
        "effects",
        "projections",
        "commands",
        "runs",
      ])
        assert.equal(tables.includes(forbidden), false, forbidden);
    } finally {
      auth.close();
    }
  } finally {
    await fixture.close();
  }
});

test("same DB path or nonloopback without TLS/Secure cookies rejects before startup", async () => {
  const fixture = await base();
  try {
    const same = join(fixture.directory, "same.sqlite");
    assert.throws(
      () =>
        createHangarServerComposition({
          tls: false,
          secureCookies: false,
          controlPath: same,
          controlStore: {
            authorityPath: fixture.authorityPath,
            fence: fixture.fence,
          },
          authPath: same,
          authOptions,
        }),
      /physically_separate/,
    );
    assert.throws(
      () =>
        createHangarServerComposition({
          host: "0.0.0.0",
          tls: false,
          secureCookies: false,
          controlPath: join(fixture.directory, "control-nonloop.sqlite"),
          controlStore: {
            authorityPath: fixture.authorityPath,
            fence: fixture.fence,
          },
          authPath: join(fixture.directory, "auth-nonloop.sqlite"),
          authOptions: {
            ...authOptions,
            origin: "https://example.test",
          },
        }),
      /requires_tls/,
    );
  } finally {
    await fixture.close();
  }
});
