# @herbertgao/hangar-notify

A spine-external **notification config resolver** for [hangar](https://github.com/HerbertGao/hangar) pilots. It maps `(app, lane)` to a delivery destination read from a git-versioned `channels.yaml` — bot tokens stay in `${ENV}` placeholders, never in the file. It contains **no transport**: how to deliver is the pilot's job.

## Install

```sh
pnpm add @herbertgao/hangar-notify   # or: npm i / yarn add
```

ESM-only, ships type declarations, requires Node ≥ 22.18. Also installs a `hangar-notify` CLI (see [Preflight](#preflight)).

## Usage

```ts
import { createResolver } from '@herbertgao/hangar-notify'

const notify = createResolver('inbox')          // bind the app id once
const dest = notify.resolve('private')           // lane → { botToken, chatId } | undefined
```

`lane` is a key like `'private'` / `'broadcast'` matching a `channels.yaml` entry (below). The `bot` / `chat` fields there surface as `botToken` / `chatId` on the resolved `Destination`.

`resolve()` **never throws** — any problem (missing file, malformed YAML, absent entry, unset/empty env, bad token shape) returns `undefined` so a caller constructing a channel at module load can degrade instead of wedging. `resolveWithReason()` additionally surfaces `{ reason, varName }` (never the token value) so the caller can log an error.

## `channels.yaml`

```yaml
apps:
  inbox:
    private: { bot: "${TG_BOT_INBOX}", chat: "886699001" }
```

Located via the `HANGAR_NOTIFY_CONFIG` env var (default `~/.config/hangar/channels.yaml`). `${NAME}` in a `bot` field is interpolated from `process.env.NAME` at resolve time — e.g. `${TG_BOT_INBOX}` reads `process.env.TG_BOT_INBOX`, so the token lives in the environment, not the file. The `bot` field **must** be a bare `${ENV}` placeholder — a committed plaintext token is a schema error (fail-closed).

## Preflight

```sh
hangar-notify check                       # validate against the current environment
hangar-notify check --from-plist <path>   # validate against a launchd plist's EnvironmentVariables
```

Offline shape + presence check only; it does not verify a token is live.
