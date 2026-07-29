# hangar 脊柱 daemon 部署(ts.mac-mini)

`com.herbertgao.hangar-inbox` —— 跑 `hangar daemon`,按 `app.yaml` 的 triggers 调度。
**命令在 ts.mac-mini 上跑。** (hangar-view 的部署另见 `packages/hangar-view/deploy/`。)

## env 的形状

三个文件,各有各的理由:

| 文件 | 放什么 | 为什么在这 |
|---|---|---|
| `~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist` | 非密钥变量(`PATH` / `HANGAR_APPS` / `DOTENV_CONFIG_PATH` / `HANGAR_NOTIFY_CONFIG`) | launchd 唯一读的地方;声明式,preflight 能直接读它 |
| `~/inbox-pilot-hangar/.env` | **全部密钥**(`DATABASE_URL` / `GMAIL_*` / `OPENROUTER_*` / `TG_BOT_INBOX` …) | 密钥的**唯一落点**。它同时服务 pilot 自己的入口(`prisma migrate deploy` / `account` / `eval:*`),复制进 plist 会变成两处要人工同步 |
| `~/.config/hangar/channels.yaml` | 通知渠道(`bot` 只写 `${TG_BOT_INBOX}` 引用) | `@hangar/notify` resolver 读 |

pilot 自己 `import 'dotenv/config'`;plist 的 `DOTENV_CONFIG_PATH` 告诉它 `.env` 在哪
(daemon 的 cwd 是 `~/hangar`,dotenv 默认只看 cwd,否则找不到)。

**优先级:plist 覆盖 `.env`。** launchd 先把 plist 的变量灌进进程,dotenv 随后加载且
默认不覆盖已存在的键。`hangar-notify check --from-plist` 复刻的正是这个次序。

## 从 wrapper 脚本切到本 plist

原先 plist 跑 `/bin/bash ~/hangar-inbox-daemon.sh`,由该脚本 source `.env`。本 plist
取消了那一层。**逐步做,每步可单独回滚。**

### 0. 先过这道闸(不做这步别往下走)

切换把 env 的注入时机从「进程启动前」挪到「pilot 模块求值时」。若 pilot 的模块图里
有谁在 `config.ts` 之前于顶层读 `process.env`,它会拿到空值 —— 而且是**静默半坏**。
先只做模块求值(不跑 run、无外部副作用)证伪它:

```bash
env -i HOME=/Users/herbertgao \
  PATH=/Users/herbertgao/.local/share/fnm/node-versions/v24.18.0/installation/bin:/opt/homebrew/bin:/usr/bin:/bin \
  DOTENV_CONFIG_PATH=/Users/herbertgao/inbox-pilot-hangar/.env \
  HANGAR_APPS=/Users/herbertgao/hangar/apps \
  bash -c 'cd /Users/herbertgao/hangar && node --input-type=module -e "
    await import(\"/Users/herbertgao/inbox-pilot-hangar/dist/pipeline.js\");
    for (const k of [\"DATABASE_URL\",\"TG_BOT_INBOX\",\"GMAIL_CLIENT_ID\",\"OPENROUTER_API_KEY\",\"TZ\"])
      console.log(k.padEnd(20), process.env[k] ? \"SET\" : \"<MISSING>\");
  "'
```

全部 `SET` 且无异常才继续。任一 `<MISSING>` 或抛错 = 存在顺序依赖,**放弃本次切换**、
继续用 wrapper(它在进程启动前就把 env 灌好了,对顺序免疫)。

### 1. 装 plist(保留旧 wrapper 以便回滚)

```bash
cd ~/hangar && git pull
cp ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist ~/hangar-inbox.plist.bak
cp deploy/com.herbertgao.hangar-inbox.plist ~/Library/LaunchAgents/
mv ~/hangar-inbox-daemon.sh ~/hangar-inbox-daemon.sh.retired   # 先留着,别删
chmod 600 ~/inbox-pilot-hangar/.env                            # 现为 0644
```

### 2. preflight(改完 plist 才跑得通;它现在会跟读 DOTENV_CONFIG_PATH)

```bash
~/inbox-pilot-hangar/node_modules/.bin/hangar-notify \
  check --from-plist ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
```

期望 `ok inbox/private` + 退 0。非零就停在这,别重启 daemon。

### 3. 重启并观察

```bash
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-inbox
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
sleep 20 && tail -5 ~/hangar-inbox.err.log        # 应见 "daemon started"
node ~/hangar/packages/core/dist/cli.js runs --limit 3 --json   # 下一次 poll 后应有新 completed
```

### 回滚

```bash
mv ~/hangar-inbox-daemon.sh.retired ~/hangar-inbox-daemon.sh
cp ~/hangar-inbox.plist.bak ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-inbox
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
```

## 注意

- **`pnpm install` 在这台机上的历史坑**:`apps/inbox` 是 symlink 出去的外部 checkout。
  `pnpm-workspace.yaml` 已排除它(`- '!apps/inbox'`),`--frozen-lockfile` 因此能装;
  但**这个修法只在开发机上验过**,生产机首次 install 时留意。
- 换 node major:plist 里的 node 绝对路径要跟着改,且原生模块要 `pnpm rebuild -r`
  (不带 `-r` 是静默 no-op)。ABI 判据是**真开一次库**,不是 `require` 成功。
