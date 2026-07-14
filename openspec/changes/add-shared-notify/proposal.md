## Why

现在 4 个 agent(hangar 上的 **inbox**,以及尚未迁入的 **ai-radar / auto-developer / hostlens**)各自配置自己的通知渠道。真痛点是**配置重复**:目的地(群号)散在 4 个仓的 4 份配置里,换个群要改 4 处、部署 4 次;而每个 agent 的 bot token 是刻意隔离的(不共用)。

`docs/proposals/control-plane-channels.md` 的 D8 早已判过:通知集中 = **脊柱之外的共享层**,agent 只报 lane、不知目的地。本变更**只做配置归一化那一半**——把「目的地在哪」收敛成一份 git 版本化的 `channels.yaml`,**不碰传输**。

> **为什么不换传输(不引入 apprise / apprise.js)。** D9/D10 曾设想把投递也委托给 apprise。一轮对抗 review(Codex + Code Reviewer + Reality Checker + Security Engineer,两轮迭代)用可复跑探针证明:**apprise 的传输语义与 inbox 刻意做的安全决策逐条相反**——它默认 `parse_mode=HTML`(inbox 刻意不设,以杜绝标记/链接注入)、把超时藏进 URL(inbox 是一行 `AbortSignal.timeout(10_000)`)、`notify()` 只回 `boolean`(inbox 靠 `telegram-http-500`/`TimeoutError` 区分重试语义)、对坏 chat id 静默丢弃(inbox 显式报错)。换传输会引入一整层「把这个库摁回 inbox 已有行为」的防御代码,并制造 6 条 ship-blocker,其中最狠一条:`bodyFormat: TEXT` 的转义把每行 `\n` 膨胀成 `\r\n`,一个**正常忙碌日**的 digest 段(148 行短中文,3995 字符)在线上膨胀到 **4142 > 4096** → Telegram 400 → digest 永久卡死(已探针实测)。**结论:传输不换,inbox 保留自己那 40 行生产验过的 telegram.ts;只归一化配置。** 完整证据见 `design.md` 的「为什么不换传输」。

## What Changes

- **新增 `packages/notify`** —— 仓内、**脊柱之外**的姊妹包(与 `packages/hangar-view` 同性质)。它是一个**配置解析器**,不是投递器:`resolve(app, lane) → { botToken, chatId } | undefined`。不含任何传输代码。
- **新增 host 级 `channels.yaml`**(经 `HANGAR_NOTIFY_CONFIG` 定位)—— `(app, lane) → 目的地` 的唯一 SOT,**git 版本化**(承 §11 的 3b 决策)。**不含密钥**:bot token 以 `${ENV}` 占位。配置形状是**两个字段**,不是 URL:
  ```yaml
  apps:
    inbox:
      private: { bot: "${TG_BOT_INBOX}", chat: "886699001" }
  ```
- **inbox 读 resolver,保留自己的传输** —— `telegramChannelFromConfig()` 从 `resolve('inbox', 'private')` 拿 `{botToken, chatId}`,而非从 `config.TELEGRAM_*`。它现有的「任一缺失 → 返回 undefined → notifier 降级 skipped」逻辑**原样保留**(这本就是我们要的「配置缺失不崩」)。`telegram.ts` 的传输、`sanitizeField`、`renderTelegramText`、10s 超时、http 状态 error kind —— **一行不改**。
- **BREAKING(部署侧)**:`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 退役,token 改由 `TG_BOT_INBOX` 提供、chat id 改由 `channels.yaml` 提供;env 走 **launchd plist 的 `EnvironmentVariables`**(hangar 的 core/cli **没有 dotenv**),且 daemon 与 `hangar run` 两个入口都要拿到。
- **`@hangar/core` 零改动。** 不加 `ctx.notify`、不注入 host config、core 不认识 lane、不经手任何 bot token。

**非目标(本次刻意不做)**

- **不换传输、不引入 apprise / apprise.js。** inbox 的 `telegram.ts` 传输保留(理由见上与 design)。
- **不把通知做进脊柱**(不加 `ctx.notify()` / `app.yaml` 的 `notify:` 块)。理由见 design D3。
- **不做出站通知的审计总线**(承 D5/R2:`RunEvent.seq` 每 run 从 1 计,审计日志当不了投递队列)。
- **不迁 ai-radar / auto-developer / hostlens。** 它们自行采用同一 `channels.yaml` 格式即可,**与迁不迁 hangar 解绑**(承 §10)。本变更只把 inbox 接上。
- **不共享传输代码(暂缓)。** 本次只共享**配置**;把 4 个 agent 的 Telegram POST 也抽成共享传输,等第 2 个消费者真的迁上来再做(seed-then-generalize)。
- **不做跨 pilot 通知限流。**

**对不变量 #2 的回答(「inbox 哪一行用它」)**:本变更不给脊柱加任何能力,#2 的门不适用;共享层的真实首用户是 inbox 的 `telegramChannelFromConfig()`(`src/notify/telegram.ts:143`),它是唯一接入点。

## Capabilities

### New Capabilities
- `shared-notify`: 脊柱外的共享通知**配置**层——lane→目的地的解析契约、`channels.yaml` schema 与 `${ENV}` 插值(含空串处理、密钥零落盘、fail-closed 拒绝明文 token)、运行期「解析不出即降级、绝不抛」的契约、以及部署期 preflight(在 daemon 的 env 里跑)。**不含传输。**

### Modified Capabilities
- `inbox-app`: 通知渠道的**凭据/目的地来源**从 `TELEGRAM_*` 环境变量换成 `@hangar/notify` 的 resolver;传输、渲染、脱敏、三态、error kind **全部不变**。`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 退役。

## Impact

- **新增**:`packages/notify`(仓内小包,~40 行配置解析)。inbox 经 `file:../hangar/packages/notify`(同机兄弟 checkout)依赖它——**不需要 npm 发版**;发布 `hangar-notify` 到 npm 推迟到第 2 个非兄弟仓(如 ai-radar)采用时。
- **运行时依赖**:`packages/notify` 只需 `yaml`(复用仓里已有的 `yaml@^2.9.0`)+ `zod`(已有)。**无 apprise、无 markdown-it、无第三方发版挂在关键路径上。**
- **`@hangar/core`**:零改动。
- **inbox-pilot(独立 repo)**:`telegramChannelFromConfig()` 改读 resolver(小改);`configSchema.ts` 去 `TELEGRAM_*`;`logger.ts` 的 redact 换成 `TG_BOT_INBOX`。**传输/渲染/测试 fixture 不动。**
- **inbox-pilot 自己的 OpenSpec 须出 delta**:`notifications/spec.md:61`(触发条件措辞:`TELEGRAM_*` 缺失 → resolver 无条目/配置不可用;「必须降级 skipped、禁抛未捕获异常」**保持有效**——它正是本设计的规范依据)、`:68`(chat id 改从 `channels.yaml` 读)、`service-bootstrap/spec.md:9`(`TELEGRAM_*` → `TG_BOT_INBOX`,仍为可选)。
- **脱敏**:inbox 的 `logger.ts:39-44` 是 bot token 目前唯一的 pino redact;退役 `TELEGRAM_BOT_TOKEN` 的**同一次提交**里必须换上 `TG_BOT_INBOX` **及 `botToken`(+ 各自 `*.` 变体)**——`botToken` 是 resolver 返回密钥的对象键,须一并 redact(CodeRabbit review 发现);否则覆盖 1→0(hangar core 建 pino 没有 `redact`)。**由 inbox 自己维护**,`@hangar/notify` 不导出共享 redact 清单(只有一个 app 在范围内)。
- **部署(ts.mac-mini)**:先**确认 `TELEGRAM_*` 当前在生产上的真实来源**(hangar root 无 `.env`,大概率已在 plist);再把 `TG_BOT_INBOX` + `HANGAR_NOTIFY_CONFIG` 写进 daemon 的 plist,**且保证 `hangar run` 手动入口也拿得到**;放置 `channels.yaml`;部署前**在 daemon 的 env 里**跑 preflight。考虑把 plist 模板 check 进 `deploy/`(仿 `packages/hangar-view/deploy/`)。
- **docker-compose 路径**:inbox 有一条 compose 部署(`openspec/specs/deployment/`)。本变更须给它出 delta——要么挂载 `channels.yaml` + 两个 env,要么显式声明该路径退役;**不得留一条静默无通知的已规范部署**。
- **文档债(一并清)**:`control-plane-channels.md` 的 D9/D10/§10 与 `followups-command-write-path.md` 的 A 表仍写「apprise-api 容器 / 长期 apprise.js」,本变更把方向改成「只共享配置、传输留 pilot」,须记一笔;`DESIGN.md §0` 把「通知」列在脊柱吸收清单里,给出确定措辞。
- **已知 landmine(只记录、不修)**:pilot 是 **in-process 加载**,共享同一个 `process.env`。`TG_BOT_<APP>` 命名规避的是**撞名**,**不是机密性**(见 design D11)。pilot #2 落地时其他密钥会正面撞上,须另开变更。
