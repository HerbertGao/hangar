# @herbertgao/hangar-notify

A spine-external **notification config resolver** for [hangar](https://github.com/HerbertGao/hangar) pilots. It maps `(app, lane)` to a delivery destination read from a git-versioned `channels.yaml` — bot tokens stay in `${ENV}` placeholders, never in the file. It contains **no transport**: how to deliver is the pilot's job.

```ts
import { createResolver } from '@herbertgao/hangar-notify'

const notify = createResolver('inbox')
const dest = notify.resolve('private') // → { botToken, chatId } | undefined
```

`resolve()` **never throws** — any problem (missing file, malformed YAML, absent entry, unset/empty env, bad token shape) returns `undefined` so a caller constructing a channel at module load can degrade instead of wedging. `resolveWithReason()` additionally surfaces `{ reason, varName }` (never the token value) so the caller can log an error.

## `channels.yaml`

```yaml
apps:
  inbox:
    private: { bot: "${TG_BOT_INBOX}", chat: "886699001" }
```

Located via `HANGAR_NOTIFY_CONFIG` (default `~/.config/hangar/channels.yaml`). The `bot` field must be a bare `${ENV}` placeholder — a committed plaintext token is a schema error (fail-closed).

## Preflight

```sh
hangar-notify check                       # validate against the current environment
hangar-notify check --from-plist <path>   # validate against a launchd plist's EnvironmentVariables
```

Offline shape + presence check only; it does not verify a token is live.

## License

BSD-2-Clause
