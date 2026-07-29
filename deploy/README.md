# hangar 脊柱 daemon 部署(ts.mac-mini)

`com.herbertgao.hangar-inbox` —— 跑 `hangar daemon`,按 `app.yaml` 的 triggers 调度。
**命令在 ts.mac-mini 上跑。** (hangar-view 的部署另见 `packages/hangar-view/deploy/`。)

本目录还有 `hangar-pg.docker-compose.yml` —— **生产上共享 postgres 实例的真实副本**,
部署在 `~/hangar-pg/`。它与 `packages/pgconfig/deploy/docker-compose.yml` 不是一回事:
那份是给任何人起步用的**通用模板**(`postgres:16` / 5434);这份是**这台机器上实际跑着的东西**
(`pgvector/pgvector:pg16` / 5432 / 带 `pgnet` 外部网),因为租户 ai-radar 用到 `vector` 扩展。
放这里的理由与那份 plist 相同:一份只活在一台机器上的配置,等于没有备份也无人评审。
改生产时**两边一起改**。

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

### 1. 装 plist

```bash
cp ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist ~/hangar-inbox.plist.bak
# 从开发机传过去,或在生产机上 git pull 后从 deploy/ 复制
scp deploy/com.herbertgao.hangar-inbox.plist ts.mac-mini:/tmp/new.plist
ssh ts.mac-mini 'plutil -lint /tmp/new.plist && cp /tmp/new.plist ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist'
chmod 600 ~/inbox-pilot-hangar/.env    # 原来是 0644,里面全是密码
```

**旧的 `hangar-inbox-daemon.sh` 不要删也不要改名。** 换完 plist 它就不在链路里了,
留着的话回滚只需要换回一个文件。等跑稳几天再清理。

> 只需要 plist 这一个文件的话,**别顺手 `git pull`**。生产机可能落后好几个提交,
> 一起拉进来就没法确定出问题是哪一步造成的,回滚也失去意义。

### 2. preflight

```bash
~/inbox-pilot-hangar/node_modules/.bin/hangar-notify \
  check --from-plist ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
```

期望 `ok inbox/private` + 退 0。非零就停在这,别重启 daemon。

期望输出里能看到它读了**两个**来源:

```
validating against plist EnvironmentVariables + /Users/herbertgao/inbox-pilot-hangar/.env; ...
  ok    inbox/private
```

> ⚠️ **要 `@herbertgao/hangar-notify` ≥ 0.2.0。** 生产机装的是 npm 上的版本,不是仓里的。
> 0.1.0 只看 plist、看不到 `.env` 里的密钥,会报 `TG_BOT_INBOX` 缺失 —— **那是假红,
> daemon 其实是好的**。判断方法就看上面那行提示里有没有出现 `+ <路径>/.env`。
> (2026-07-29 生产已升到 0.2.0。)旧版下的等价检查:
>
> ```bash
> cd ~/inbox-pilot-hangar && env -i HOME=$HOME \
>   PATH=<fnm node bin>:/opt/homebrew/bin:/usr/bin:/bin \
>   HANGAR_APPS=$HOME/hangar/apps \
>   DOTENV_CONFIG_PATH=$HOME/inbox-pilot-hangar/.env \
>   HANGAR_NOTIFY_CONFIG=$HOME/.config/hangar/channels.yaml \
>   TZ=Asia/Shanghai \
>   node --import dotenv/config node_modules/@herbertgao/hangar-notify/dist/cli.js check
> ```

### 3. 重启并观察

```bash
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-inbox
sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
sleep 8
launchctl list | grep hangar-inbox                # 第 2 列是上次退出码,要 0
tail -3 ~/hangar-inbox.err.log                    # 应见 "daemon started",tasks/apps 数与切换前一致
ps -o pid,command -p $(launchctl list | awk '/hangar-inbox/{print $1}')   # 应是 node 直接跑,没有 bash

# 等下一次 poll(每 3 分钟),确认真跑完一轮:
cd ~/hangar && node packages/core/dist/cli.js runs --limit 3 --json
```

> ⚠️ **查 run 一定要先 `cd ~/hangar`。** `HANGAR_DB` 默认是相对当前目录找的,在别的目录跑
> 会指向一个不存在的库,然后**退 0、输出 `[]`** —— 和「一次都没跑过」长得一模一样。

### 回滚

wrapper 脚本一直没动过,所以换回 plist 就行:

```bash
cp ~/hangar-inbox.plist.bak ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
launchctl bootout gui/$(id -u)/com.herbertgao.hangar-inbox
sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
```

---

## 已切换记录

**2026-07-29 12:00 UTC 完成。** 切换后两轮 poll(11:57、12:00)均 `completed`,
`tasks 4 / apps 2` 与切换前一致,日志无新错误。`.env` 与 `channels.yaml` 均已 0600。
旧 wrapper `~/hangar-inbox-daemon.sh` 保留未动。

## 注意

- **`pnpm install` 在这台机上的历史坑**:`apps/inbox` 是 symlink 出去的外部 checkout。
  `pnpm-workspace.yaml` 已排除它(`- '!apps/inbox'`),`--frozen-lockfile` 因此能装;
  但**这个修法只在开发机上验过**,生产机首次 install 时留意。
- 换 node major:plist 里的 node 绝对路径要跟着改,且原生模块要 `pnpm rebuild -r`
  (不带 `-r` 是静默 no-op)。ABI 判据是**真开一次库**,不是 `require` 成功。
