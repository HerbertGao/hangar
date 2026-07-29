# hangar 脊柱 daemon 部署(ts.mac-mini)

`com.herbertgao.hangar-inbox` —— 跑 `hangar daemon`,按 `app.yaml` 的 triggers 调度。
**命令在 ts.mac-mini 上跑。** (hangar-view 的部署另见 `packages/hangar-view/deploy/`。)

## env 的形状

三个文件,各有各的理由:

| 文件 | 放什么 | 为什么在这 |
|---|---|---|
| `~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist` | 非密钥变量(`PATH` / `HANGAR_APPS` / `DOTENV_CONFIG_PATH` / `HANGAR_NOTIFY_CONFIG` / **`TZ`**) | launchd 唯一读的地方;声明式,preflight 能直接读它 |
| `~/inbox-pilot-hangar/.env` | **全部密钥**(`DATABASE_URL` / `GMAIL_*` / `OPENROUTER_*` / `TG_BOT_INBOX` …) | 密钥的**唯一落点**。它同时服务 pilot 自己的入口(`prisma migrate deploy` / `account` / `eval:*`),复制进 plist 会变成两处要人工同步 |
| `~/.config/hangar/channels.yaml` | 通知渠道(`bot` 只写 `${TG_BOT_INBOX}` 引用) | `@hangar/notify` resolver 读 |

pilot 自己 `import 'dotenv/config'`;plist 的 `DOTENV_CONFIG_PATH` 告诉它 `.env` 在哪
(daemon 的 cwd 是 `~/hangar`,dotenv 默认只看 cwd,否则找不到)。

**两处都有同名变量时,plist 赢。** launchd 先设 plist 里的,dotenv 之后加载、遇到已经
存在的变量就不动它。`hangar-notify check --from-plist` 就是照这个顺序合并的。

**`TZ` 是个特例,必须放 plist。** node 只在启动时读一次时区。只写在 `.env` 里的话,
它要等代码跑起来才生效,在那之前算的日期用的是机器的系统时区 —— 每日摘要的「今天」
从几点算起就可能不对,而且不报错,只是算错。`.env` 里那份 `TZ` 可以留着(pilot 自己
的命令从 pilot 目录跑时用得上),但 plist 里必须也有一份。

> **新变量该放哪?** 问一句:它得在程序启动前就生效,还是代码要用时才去读?
> 启动前就得生效的(`TZ`、`PATH`)放 plist;代码用时才读的(密码、配置文件路径)放 `.env`。

## 从 wrapper 脚本切到本 plist

原先 plist 跑 `/bin/bash ~/hangar-inbox-daemon.sh`,由该脚本 source `.env`。本 plist
取消了那一层。**逐步做,每步可单独回滚。**

### 0. 先做这两个检查(不做别往下走)

**这次改动改变了环境变量生效的时机**:以前是进程启动前就全部灌好,以后是 pilot 代码
加载时才由 dotenv 读进来。万一 pilot 里有哪个模块在 dotenv 之前就去读环境变量,它会
读到空值 —— 而且多半不会报错,只是行为悄悄变了。下面两步就是来排除这件事的。

**检查一:代码能不能正常加载。** 只加载模块,不真跑一次 run(所以不会发通知、不会动
邮件):

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

要全是 `SET` 且不报错才能继续。只要有一个 `<MISSING>` 或者抛了错,就**别切**,继续用
原来的 shell 脚本(它在进程启动前就把变量灌好,不存在时机问题)。

**检查二:切换前后读出来的配置是不是一模一样。** 检查一只能发现「报错」那种情况;
如果某个模块读到空值却不报错,只有对比才看得出来。下面按两种方式各加载一次配置,
算个指纹来比 —— 只打指纹,不打密码:

```bash
cat > /tmp/probe.mjs <<'PROBE'
import { createHash } from 'node:crypto';
await import('/Users/herbertgao/inbox-pilot-hangar/dist/pipeline.js');
const { loadConfig } = await import('/Users/herbertgao/inbox-pilot-hangar/dist/config/config.js');
const c = loadConfig(); const keys = Object.keys(c).sort();
console.log('KEYS=' + keys.join(','));
console.log('FINGERPRINT=' + createHash('sha256').update(JSON.stringify(c, keys)).digest('hex').slice(0, 16));
PROBE
# A(wrapper 形态): set -a; . <pilot>/.env; set +a  然后 node /tmp/probe.mjs
# B(新形态):       DOTENV_CONFIG_PATH=<pilot>/.env  然后 node /tmp/probe.mjs
```

两次的 `FINGERPRINT` 必须完全一样。(2026-07-29 在生产机上跑过,两次都是
`78ee173e24f37d2e`,10 个键一致。)

⚠️ **这个对比只覆盖配置 schema 里的那 10 个变量。** schema 之外的(`TZ`、`TG_BOT_INBOX`)
不在指纹里,要单独想一遍。上面 `TZ` 必须放 plist 那条,就是这么发现的。

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
