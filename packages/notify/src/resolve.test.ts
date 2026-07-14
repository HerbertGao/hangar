import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, resolveWithReason, createResolver, check } from './index.js';

// Each test writes a fresh channels.yaml under a unique temp path and points
// HANGAR_NOTIFY_CONFIG at it — the load cache keys by path, so tests don't collide.
let n = 0;
function withConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const path = join(dir, `channels-${n++}.yaml`);
  writeFileSync(path, yaml, 'utf8');
  process.env.HANGAR_NOTIFY_CONFIG = path;
  return path;
}

// A well-formed Telegram-shaped token (\d{6,}:[A-Za-z0-9_-]{20,}).
const GOOD_TOKEN = '123456789:AbCdEfGhIjKlMnOpQrStUvWxYz012345';

test('success: valid placeholder + chat → destination', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_OK}", chat: "886699001" }
`);
  process.env.TG_BOT_OK = GOOD_TOKEN;
  assert.deepEqual(resolve('inbox', 'private'), {
    botToken: GOOD_TOKEN,
    chatId: '886699001',
  });
});

test('① no entry → undefined', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_1}", chat: "1" }
`);
  process.env.TG_BOT_1 = GOOD_TOKEN;
  // wrong app and wrong lane both yield no entry
  assert.equal(resolve('other', 'private'), undefined);
  assert.equal(resolve('inbox', 'broadcast'), undefined);
  assert.equal(resolveWithReason('inbox', 'broadcast').failure?.reason, 'no-entry');
});

test('② env missing → undefined', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_ABSENT}", chat: "1" }
`);
  delete process.env.TG_BOT_ABSENT;
  assert.equal(resolve('inbox', 'private'), undefined);
  const r = resolveWithReason('inbox', 'private');
  assert.equal(r.failure?.reason, 'env-missing');
  assert.equal(r.failure?.varName, 'TG_BOT_ABSENT');
});

test('③ env empty string → undefined (no empty-token destination)', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_EMPTY}", chat: "1" }
`);
  process.env.TG_BOT_EMPTY = '   '; // whitespace-only counts as missing
  const r = resolveWithReason('inbox', 'private');
  assert.equal(r.destination, undefined);
  assert.equal(r.failure?.reason, 'env-empty');
});

test('④ token shape invalid → undefined + {reason, varName}', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_BAD}", chat: "1" }
`);
  process.env.TG_BOT_BAD = 'not-a-real-token';
  const r = resolveWithReason('inbox', 'private');
  assert.equal(r.destination, undefined);
  assert.equal(r.failure?.reason, 'token-shape-invalid');
  assert.equal(r.failure?.varName, 'TG_BOT_BAD');
  assert.equal(r.failure?.severity, 'error');
});

test('④b token-shaped substring wrapped in junk → invalid (anchored shape)', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_INBOX}", chat: "1" }
`);
  for (const junk of [
    `garbage ${GOOD_TOKEN}`, // leading junk
    `${GOOD_TOKEN} junk`, // trailing junk
  ]) {
    process.env.TG_BOT_INBOX = junk;
    const r = resolveWithReason('inbox', 'private');
    assert.equal(r.destination, undefined);
    assert.equal(r.failure?.reason, 'token-shape-invalid');
    assert.equal(r.failure?.severity, 'error');
  }
  // a bare valid token still resolves
  process.env.TG_BOT_INBOX = GOOD_TOKEN;
  assert.deepEqual(resolveWithReason('inbox', 'private').destination, {
    botToken: GOOD_TOKEN,
    chatId: '1',
  });
});

test('④c empty / whitespace-only config → config-missing (info, not error)', () => {
  for (const body of ['', '   \n  ']) {
    withConfig(body);
    const r = resolveWithReason('inbox', 'private');
    assert.equal(r.destination, undefined);
    assert.equal(r.failure?.reason, 'config-missing');
    assert.equal(r.failure?.severity, 'info');
  }
});

test('⑤ YAML syntax error → undefined, does not throw', () => {
  withConfig('apps: { inbox: { private: { bot: "${TG}", chat: "1" }'); // unbalanced
  assert.doesNotThrow(() => {
    assert.equal(resolve('inbox', 'private'), undefined);
  });
});

test('⑥ file missing → undefined, does not throw', () => {
  process.env.HANGAR_NOTIFY_CONFIG = join(tmpdir(), 'definitely-absent-notify.yaml');
  assert.doesNotThrow(() => {
    assert.equal(resolve('inbox', 'private'), undefined);
  });
});

test('⑦ plaintext token (not ${ENV}) → schema rejects', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "${GOOD_TOKEN}", chat: "1" }
`);
  const r = resolveWithReason('inbox', 'private');
  assert.equal(r.destination, undefined);
  assert.equal(r.failure?.reason, 'schema-invalid');
});

test('⑧ second resolve identical; no destructive side effect', () => {
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_TWICE}", chat: "42" }
`);
  process.env.TG_BOT_TWICE = GOOD_TOKEN;
  const r = createResolver('inbox');
  const first = r.resolve('private');
  const second = r.resolve('private');
  assert.deepEqual(second, first);
  // env var must NOT have been deleted (1.7): a third resolve still works
  assert.equal(process.env.TG_BOT_TWICE, GOOD_TOKEN);
  assert.deepEqual(r.resolve('private'), first);
});

test('⑨ diagnostics and error text never contain the token value', () => {
  // token-shape-invalid case carries a would-be secret; it must stay out of output
  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_SECRET}", chat: "1" }
`);
  const badSecret = 'SECRET-99999'; // a would-be secret with an invalid shape
  process.env.TG_BOT_SECRET = badSecret;
  const r = resolveWithReason('inbox', 'private');
  const text = JSON.stringify(r);
  assert.equal(text.includes(badSecret), false);

  // plaintext-token schema rejection must not echo the committed token either
  withConfig(`apps:
  inbox:
    private: { bot: "${GOOD_TOKEN}", chat: "1" }
`);
  const r2 = resolveWithReason('inbox', 'private');
  assert.equal(JSON.stringify(r2).includes(GOOD_TOKEN), false);
});

test('check(): valid config passes, bad config fails with reason (no value)', () => {
  const okPath = withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_CHK}", chat: "886699001" }
`);
  process.env.TG_BOT_CHK = GOOD_TOKEN;
  const okReport = check(process.env);
  assert.equal(okReport.ok, true);
  assert.equal(okReport.configPath, okPath);
  assert.equal(okReport.entries.length, 1);
  assert.equal(okReport.entries[0].ok, true);

  withConfig(`apps:
  inbox:
    private: { bot: "\${TG_BOT_CHK_MISSING}", chat: "1" }
`);
  delete process.env.TG_BOT_CHK_MISSING;
  const badReport = check(process.env);
  assert.equal(badReport.ok, false);
  assert.equal(badReport.entries[0].reason, 'env-missing');
  assert.equal(badReport.entries[0].varName, 'TG_BOT_CHK_MISSING');
  // report must not carry any token value
  assert.equal(JSON.stringify(badReport).includes(GOOD_TOKEN), false);
});
