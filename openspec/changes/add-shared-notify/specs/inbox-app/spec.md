## 新增需求

### 需求:通知的凭据/目的地来源换成 @hangar/notify resolver;传输一行不改
inbox 的通知渠道 SHALL 从 `@hangar/notify` 的 resolver 获取 `{ botToken, chatId }`,不再从 `TELEGRAM_*` 环境变量读。inbox 的 lane SHALL 为 `private`。

**改动被限制在一个函数**:`telegramChannelFromConfig()`(`src/notify/telegram.ts:143`)现在读 `config.TELEGRAM_BOT_TOKEN` / `config.TELEGRAM_CHAT_ID`,改成读 `resolve('inbox', 'private')`。它现有的**「任一缺失 → 返回 `undefined` → notifier 降级 `skipped`」逻辑 SHALL 原样保留**——这本就是「配置缺失不崩」的正确形态,与 `@hangar/notify` 的「解析不出即 undefined」契约天然对接。

**下列一律不改**(本变更不碰传输):
- `createTelegramChannel` 及其下的 `fetch`、`AbortSignal.timeout(10_000)`、HTTP 状态 → `telegram-http-NNN`、`errorKind` → `telegram-fetch-error-*`。
- `renderTelegramText`(§13 模板)、`sanitizeField`、`formatSender`、`formatConfidence`、`categoryLabels`。
- **不设 `parse_mode`** 这条安全不变量(`telegram.ts:106-107`)——它是「攻击者文本不被当标记」构造性成立的根据,保留即安全,不需要转义层。
- `NotificationChannel` 契约、`ChannelSendResult` 类型、三态返回、`sanitizeChannelError`、`buildDigest` 的 `SEGMENT_MAX` 分段。
- inbox 的**测试 fixture 全部不动**(`telegram-http-500` 等 error kind 仍由不变的传输产出)。

#### 场景:换渠道来源后行为逐字节一致
- **当** inbox 用新的凭据来源发一封 P0 或一段 digest
- **那么** 实际发往 Telegram 的 `sendMessage` payload 与今天**逐字节一致**(传输未变);观察期可用 wire-level 对拍确认

#### 场景:resolver 无条目时仍降级 skipped
- **当** `channels.yaml` 中没有 inbox 的 `private` 条目,或配置文件不可用
- **那么** `telegramChannelFromConfig()` 得到 `undefined` → 渠道为 undefined → notifier 记 `notify-skipped-no-channel`、不抛、不崩(与今天 `TELEGRAM_*` 缺失时的行为一致)

### 需求:TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 环境变量退役
inbox SHALL 移除 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID`。token 改由 `TG_BOT_INBOX` 提供,chat id 改由 `channels.yaml` 的 inbox `private` 条目提供。

**为何必须改名而非沿用**:pilot 是 host in-process 加载的,多个 pilot 共享 `process.env`,通用名会在 pilot #2 落地时被覆盖。

**退役的触及点 SHALL 全部处理**(实测全集):

| # | 位置 | 处理 |
|---|---|---|
| 1 | `src/config/configSchema.ts:108-109`(+ `:106` 注释) | 删两字段及注释里的名字 |
| 2 | `src/logger.ts:39-44`(pino redact) | **换成** `TG_BOT_INBOX` + `*.TG_BOT_INBOX`(见下条需求)。**不能只删** |
| 3 | `src/notify/telegram.ts:144-145` | 改读 resolver |
| 4 | `src/notify/notifier.test.ts:84` | 靠子进程清空 `TELEGRAM_*` 驱动 **no-channel** 分支;退役后清的是不存在的变量 → 绿色空断言。触发机制 SHALL 改为「resolver 无 inbox 条目 / 指向空配置」。(注:`:213` 是注入假渠道、env 惰性不触发,无需改) |
| 5 | `.env.example:28-29` | 换成 `TG_BOT_INBOX=` |
| 6 | `PROJECT_INIT.md:726-727` | 同步 |
| 7 | `docker-compose.yml`(`env_file: .env`) | 见「docker-compose 路径」需求 |
| 8 | `openspec/specs/notifications/spec.md:61,68` | 见「inbox 自己的 OpenSpec」需求 |
| 9 | `openspec/specs/service-bootstrap/spec.md:9` | 见「inbox 自己的 OpenSpec」需求 |

全仓「零命中」断言 SHALL 限定到 `src/` + `openspec/specs/` + `.env.example` + 部署文件,**不含 `openspec/changes/archive/**`**(不可变历史,3 处提及,不动)。

#### 场景:旧变量不再被读取
- **当** 在 inbox 的 `src/` + 活跃 specs + 部署文件里搜索 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- **那么** 零命中(归档目录不计)

### 需求:bot token 的脱敏覆盖不得降为零
inbox 的 pino `redact` 名单 SHALL 在退役 `TELEGRAM_*` 的**同一次提交**里换上 `TG_BOT_INBOX`(及 `*.TG_BOT_INBOX`),SHALL NOT 只删旧条目。inbox 的 pino `redact` 名单 SHALL **另含 `botToken` 与 `*.botToken`**——resolver 以 `{ botToken, chatId }` 返回密钥,`botToken` 是密钥流经的对象键;若任何调用方日志记录了 `Destination` 对象,仅靠 env 变量名 redact 挡不住(CodeRabbit review 发现)。

**理由**:hangar core 建 pino **没有** `redact`,inbox 的 `logger.ts:39-44` 是 bot token 唯一的 pino redact——只删不补 = 覆盖 1→0。

`src/actions/redactError.ts:24` 是第二层(形状正则 `\d{6,}:[A-Za-z0-9_-]{20,}`)。SHALL 验证 bot token 仍被它捕获;`@hangar/notify` 的 token 形状校验 SHALL NOT 比它宽(否则一个被放行的短 token 不会被这层洗掉)。

#### 场景:redact 在同一提交里完成替换
- **当** 检查退役 `TELEGRAM_*` 的那次提交
- **那么** `logger.ts` 里 telegram 旧条目被删**且** `TG_BOT_INBOX` 条目被加,在同一提交内

### 需求:部署经 launchd plist，且覆盖所有入口
`TG_BOT_INBOX` 与 `HANGAR_NOTIFY_CONFIG` SHALL 由 daemon 的 **launchd plist `EnvironmentVariables`** 提供;`hangar run <app>` 这个入口 SHALL 在同一环境下也能拿到(`HANGAR_NOTIFY_CONFIG` 可用约定默认路径兜底)。

**理由**:hangar core/cli **无 dotenv**,「host 的 `.env`」没有读者;daemon 由 launchd 托管。

部署前 SHALL **在 daemon 的 env 里**(`hangar-notify check --from-plist`)校验,配置错则中止。**且须先确认 `TELEGRAM_*` 今天在生产上的真实来源**(hangar root 无 `.env`,大概率已在 plist)再写 BREAKING 步骤;考虑把 plist 模板 check 进 `deploy/`。

#### 场景:配置未就绪时部署中止
- **当** plist 漏设 `TG_BOT_INBOX`
- **那么** `hangar-notify check --from-plist` 非零退出,部署不继续

### 需求:docker-compose 部署路径不得静默无通知
inbox 有一条 compose 部署(`openspec/specs/deployment/`)。本变更 SHALL 给它出 delta:要么挂载 `channels.yaml` + 注入 `TG_BOT_INBOX` + `HANGAR_NOTIFY_CONFIG`,要么显式声明该路径退役。MUST NOT 留一条已规范却静默降级为 `skipped(no-channel)` 的部署。

#### 场景:compose 路径被显式处理
- **当** 审视 compose 部署在本变更后的通知能力
- **那么** 它要么真能发通知(挂载 + env 齐全),要么其 spec 已声明退役——不存在「跑着但永远不发」的中间态

### 需求:inbox 自己的 OpenSpec 同步出 delta
本变更 SHALL 在 inbox-pilot 仓内给下列规范出 delta:
- `notifications/spec.md:61` —— 触发条件措辞从「`TELEGRAM_*` 缺失」改为「resolver 无条目 / 配置不可用」;「未配置必须降级为 `skipped`、禁抛未捕获异常」**保持有效**(它是本设计不抛的规范依据)。
- `notifications/spec.md:68` —— 「凭据必须只从环境变量读取」:token 仍来自 env(`TG_BOT_INBOX`),但 **chat id 改从 `channels.yaml` 读**,措辞须改。
- `service-bootstrap/spec.md:9` —— P0 变量清单里 `TELEGRAM_*` 换成 `TG_BOT_INBOX`(仍为可选、缺失不得拒绝启动)。

#### 场景:inbox 规范与实现一致
- **当** 变更实现后核对 inbox 自己的三处规范
- **那么** 没有一条仍点名已退役的 `TELEGRAM_*`,也没有一条与「chat id 来自 channels.yaml」矛盾
