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
hangar-notify check --from-plist <path>   # validate against the daemon's environment
```

`--from-plist` exists because checking your own shell proves nothing: the shell may have
the token while the daemon's environment does not. It reads the plist's
`EnvironmentVariables` instead of `process.env`.

If the plist declares `DOTENV_CONFIG_PATH`, the `.env` file it points at is read too, and
merged underneath — **the plist wins on conflicts**, matching what actually happens at
runtime (launchd sets its variables first; `dotenv` leaves an already-set variable alone).
This is for deployments that keep secrets out of the plist: launchd declares only the
non-secret variables, and the app loads the rest through its own `import 'dotenv/config'`.
Parsing uses `dotenv` itself, so quotes and `export ` prefixes are read the same way the
app reads them.

`HANGAR_NOTIFY_CONFIG` must be declared somewhere in that environment — the plist or the
`.env` file. Declared nowhere, the check would silently fall back to the default path and
validate a different file than the daemon reads.

Offline shape + presence check only; it does not verify a token is live.

## License

[Apache-2.0](./LICENSE)
