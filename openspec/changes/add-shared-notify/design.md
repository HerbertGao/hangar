## Context

**现状。** 4 个 agent 各自配置通知渠道:hangar 上的 **inbox**,以及仍在独立 repo、未上 hangar 的 **ai-radar / auto-developer / hostlens**(三者投同一个技术群)。群号(目的地)散在 4 份配置里;bot token 各自独立、刻意不共用。

**已有的决策地基**(`docs/proposals/control-plane-channels.md`,讨论记录、非 SOT):**D8** 共享层在脊柱之外、agent 只报 lane;**§11** 配置落点定 3b(git 版本化声明式 yaml);**D5/R2** 「通知走 RunEvent 由外部适配器消费」被毙。**本变更实现 D8 的配置那一半,并推翻 D9/D10 的「换传输」那一半**(理由见下)。

## 为什么不换传输(推翻 D9/D10)

D9/D10 设想把投递也委托给 apprise(近期 apprise-api 容器,长期原生 `apprise.js`)。两轮对抗 review + 可复跑探针的结论是:**这条路不该走**。不是因为 apprise.js 质量差——它对 Python apprise 1.12.0 的移植是忠实的(五条核心行为断言逐条复现为真);而是因为**apprise 的传输语义与 inbox 刻意做的安全决策逐条相反**,换传输 = 引入一个你不想要其行为的库,再写一整层防御把它摁回原样。

| inbox 的刻意决策 | apprise 的默认 | 换传输的代价 |
|---|---|---|
| **不设 `parse_mode`**(杜绝标记/链接注入,`telegram.ts:106-107` 明令) | 两分支都设 `parse_mode`,`HTML` 是 else 分支,**无「不设」路径** | 必须传 `bodyFormat: TEXT` 补转义;而守住它的「schema 拒 `?format=`」是**字面量黑名单**,被 `&format=`/`;format=`/`?FORMAT=`/url-encode **全部走穿**(探针实测,注入原样复活) |
| **一行 `AbortSignal.timeout(10_000)`** | 超时藏进 URL 的 `cto`/`rto` | 配置里写 `?cto=5&rto=5`,自带 transport 还得复刻 apprise 的 round/clamp 守卫,否则 `?cto=1.1` 抛 `ERR_OUT_OF_RANGE` |
| **`notify()` 回 `sent/failed(kind)`**,靠 `telegram-http-500`/`TimeoutError` 推理重试(可能已送达 vs 确定失败) | `notify()` 只回 `boolean` | 必须自带 per-instance transport 把状态码捞回来;而闭包 sink 跨调用存活 → 陈旧/串扰归因 |
| **坏 chat id 显式报错** | 静默丢 target,`add()` 仍返回 `true` | preflight 对最常见的编辑错(chat id 打错一字)**假绿**,生产恒 false + 无限重投 |
| **`SEGMENT_MAX=4000` 按裸文本量的字节** | `bodyFormat:TEXT` 把每行 `\n` 膨胀成 `\r\n` | **一个正常忙碌日**的 digest 段(148 行短中文,3995 字符)线上膨胀到 **4142 > 4096** → Telegram 400 → digest 在 `markDigested` 前 bail → 永久卡死。**探针实测,非对抗输入** |

**这是两个安全模型的冲突,不是一个 bug。** apprise 忠实移植了 Python apprise,而 Python apprise 的 telegram 本来就默认 `parse_mode=HTML`;inbox 刻意偏离这个行业默认是一条安全决策。「换传输不换语义」的框架在这里失灵——apprise 的语义**包含**了 inbox 明确拒绝的那条。

**净账**(ponytail 透镜):inbox 的 `telegram.ts` 158 行里传输只有约 40 行,净贡献是替你拼 `POST /bot{token}/sendMessage` 两个模板字符串;换 apprise 收费 7 个 npm 包(含 markdown-it,服务于一条被明令禁用的 MARKDOWN 路径)+ 一整层防御性 URL 解析 + 一次第三方发版挂关键路径 + 上表 6 条 blocker。**传输不换。**

> **探针可复跑**:`scratchpad/f1.mjs`(`?format=` 黑名单被走穿)、`scratchpad/digest.mjs`(4142>4096 digest 卡死)、`scratchpad/probe-timeout2.mjs`。这些是「为什么不换」的证据,**保留以防有人日后照 D9/D10 旧文档把 apprise 用回 inbox**。

> **作用域锁定(别把本节当成对 apprise 的全盘否决)。** 上表只对 **inbox** 成立——它是单平台(仅 Telegram)、传输已硬化、且转发**攻击者可控**的邮件主题。对**广度型广播消费者**(ai-radar / auto-developer / hostlens,Telegram+飞书双通道、拟扩企微/钉钉、且多为绿地、自产内容、fire-and-forget)同一张具体 diff **符号相反**,apprise 对它们价值为正:`4 平台 × 3 agent` 手写 = 12 套鉴权/转义/限流,apprise 摊成 4 个忠实移植共享。**apprise 的价值与平台数正相关;inbox 在曲线 x=1 处且偏离默认(负),广播组在 x=2→4 且绿地(正)。** apprise.js 仍是广播组的预期后端,按真实需求逐插件从上游长(D10 flywheel)。这不改本变更(inbox 仍 config-only);ai-radar 到通知层时用它自己的 diff 重新评估,别拿本节结论去套。详见 `control-plane-channels.md` 的 D9/D10 修订(tasks 7.8)。

## Goals / Non-Goals

**Goals**
- 4 个 agent 的**目的地配置**收敛成一份;换群 = 改一个文件。
- 每个 app 保留**自己的 bot token**(隔离是特性)。
- `@hangar/core` **零改动**;inbox 的传输/渲染/安全性质**零改动**。

**Non-Goals**
- 不换传输、不引入 apprise/apprise.js。
- 不加 `ctx.notify()` / `app.yaml` 的 `notify:` 块(D3)。
- 不迁另外 3 个项目;不共享传输代码(暂缓,seed-then-generalize);不做跨 pilot 限流。

## Decisions

### D1 — 配置形状:两个字段,不是 URL

```yaml
# channels.yaml   ← 进 git;${大写} 是 env 占位,密钥不在这里。路径由 HANGAR_NOTIFY_CONFIG 指定
apps:
  inbox:
    private: { bot: "${TG_BOT_INBOX}", chat: "886699001" }
  ai-radar:
    broadcast: { bot: "${TG_BOT_AI_RADAR}", chat: "-1002233445566" }
```

- 每个 app 持有**自己的 bot token**;被共享的**只有目的地**(chat)。
- **两个字段而非 apprise URL**:没有 query string 面 → `?format=`/`?overflow=` 这类注入/截断参数**写不出来**;「凭据段必须是 `${ENV}`」退化成 `bot` 字段上一条 zod regex `/^\$\{[A-Z0-9_]+\}$/`(把「别提交密钥」变成 parse error)。
- env 名按 app 命名空间化(`TG_BOT_INBOX`);**这是硬要求**(N 个 pilot 共享 `process.env`,通用名会互相覆盖),但**不是安全边界**(见 D11)。
- 超时**不进配置**:它是 inbox 自己的 `TELEGRAM_TIMEOUT_MS = 10_000` 常量,与目的地无关。

### D2 — `hangar-notify` 是配置解析器,不是投递器

对外只有:`resolve(app, lane) → { botToken, chatId } | undefined`(`createResolver(app)` 绑定 app id,由 pilot 传——core 零改动)。它读 `channels.yaml`、插值 `${ENV}`、校验,返回目的地的**原料**;**如何投递由 app 自己的传输决定**。

inbox 的接入是**最小改动**:`telegramChannelFromConfig()`(`telegram.ts:143`)现在读 `config.TELEGRAM_BOT_TOKEN`/`config.TELEGRAM_CHAT_ID`,改成读 `resolve('inbox','private')`;它现有的「任一缺失 → 返回 undefined → notifier 降级 `skipped`」逻辑**原样保留**。`createTelegramChannel` 及其下所有传输/渲染/脱敏代码**一行不动**。

**为何不现在就共享传输**:把 4 个 agent 的 Telegram POST 也抽成共享 `notify(lane,{title,body})`,只在第 2 个消费者真迁上来时才有回报;当前只有 inbox 在范围内,提前抽 = 为不存在的消费者建抽象(YAGNI)。共享配置是承重的那一半,共享传输是可推迟的第二步(承 control-plane §10 seed-then-generalize)。

### D3 — 不做 `ctx.notify()`:那道门进去就退不回来

考虑过让 core 提供 `ctx.notify(lane, msg)`。**否决**:`app.yaml` 会长出 `notify:` 块 → `SpecSchema` 认识「通知/车道」= 破不变量 #1;lane 白名单变必需 → 脊柱长第二套 per-app 权限;core 会持有 4 个 bot token;下一步静默时段/优先级/模板全往脊柱挤,而 #2 拦不住(inbox 确实会逐个用到)。换来的只有「pilot 少一行 import」。同理否决「core 注入 host config 进 ctx」。

### D4 — 投递内联,不经 RunEvent(承 D5/R2)

投递在 pilot 的 `run()` 调用栈内发生(inbox 现状),结果回传调用方。不建立消费 `RunEvent` 的外部投递器(`seq` 每 run 从 1 计,外部消费者建不出持久水位线)。想让 hangar「看见」通知,pilot 自己 `ctx.emit('notify.sent')`——审计与投递解耦。

### D5 — 运行期绝不抛;「响亮」搬到部署期 preflight

**运行期**:resolver 遇到任何问题(文件缺失/不可读/YAML 语法错/schema 不合法/app 或 lane 无条目/`${ENV}` 未设/空串/token 形状非法)**一律返回 `undefined`,绝不抛**。inbox 收到 undefined → 走它既有的 `skipped` 降级路径。

**为何绝不抛(三条硬约束,全部验证属实)**:① inbox 的 `defaultNotifier` 是**模块级 const**(`notifier.ts:173`),在 hangar 的 `await import()`(`executor.ts:57`)期构造 —— 抛错会被 **ESM loader 永久缓存**,一个配置写错让整个 pilot 到 daemon 重启前跑不了;② 撞 hangar 自己的 `inbox-app spec:95-97`「pilot 模块顶层禁 throw」;③ 撞 inbox 自己的 `notifications/spec:61`「未配置必须降级为记日志并跳过、禁止抛出未捕获异常、记为 `skipped` 并含原因」。

**运行期日志分层**(不抛,但响度有别):**值缺失/无条目** = 「本 app 不在这条 lane 上说话」→ 静默或 INFO;**值存在但非法**(token 形状错、YAML 解析错)→ **ERROR 级结构化日志**(脱敏),因为这是真误配。日志由**调用方(inbox)用它已在脱敏的 pino** 记 —— resolver 返回 `{ reason, varName }` 之类给 inbox,**resolver 自己不打日志、不引入 logger 依赖**(避免落到未脱敏的 `console.error`)。

**「响亮」在部署期**:`hangar-notify check`(见 D6)。运行期可静默降级,是因为部署期已经把坏配置挡在门外。

### D6 — preflight 必须在 daemon 的 env 里跑

`hangar-notify check`:读 `channels.yaml`、插值 `${ENV}`、校验 token 形状、校验 chat 非空。配置有问题 → 非零退出,指明 app/lane/变量名(**不带值**)。

**但它必须校验 daemon 将要看到的那份环境,不是运维 shell 的**。daemon 由 launchd 托管,env 来自 plist 的 `EnvironmentVariables`;运维 SSH shell 是另一套。一个在 shell 里跑绿、daemon 里缺变量的 preflight 是**假绿**(Security/RC 都指出)。故:`check --from-plist <path>` 解析 plist 的 `EnvironmentVariables` 并**只**用它,同时断言 plist 里的 `HANGAR_NOTIFY_CONFIG` 与自己读的文件是同一份。

**诚实边界**:`check` 是离线校验(形状 + 存在性),**不验 token 有效性**——一个已吊销/属于别的 bot 的合法形状 token 会通过。spec 措辞不得声称「token 被验过」。可选 `--live`(一次 `getMe`,免费无副作用)留作后续。

### D7 — 所有加载 pilot 的入口都要拿到 notify 的 env

两个入口共用同一个 `PipelineExecutor`(`executor.ts`):launchd daemon,以及运维 shell 的 `hangar run <app>`(`cli.ts`)。hangar **零 dotenv**,所以 `hangar run` 只看得到 shell 的 env。只给 daemon plist 配 env → 手跑 `hangar run inbox` 静默无通知。

⇒ 给 `HANGAR_NOTIFY_CONFIG` 一个**约定默认路径**(如 `~/.config/hangar/channels.yaml`),两个入口零 env 管道即解析到同一份(文件不存在 → 按 D5 降级);`TG_BOT_INBOX` 则须在两个入口的环境里都存在(plist for daemon;运维跑 `hangar run` 时须在同一 shell 环境)。`hangar-notify check` 打印它解析到的路径,runbook 要求在与 daemon 同用户/同环境下跑。**注意**:`HANGAR_NOTIFY_CONFIG` 的路径解析可以有约定默认(不破「core 不认识通知」——这是 `hangar-notify` 的约定,不是 core 的),但 `hangar doctor` **不**回显它(那才会让脊柱认识通知)。

### D8 — 配置在首次 resolve 时惰性读取一次并缓存

`channels.yaml` 读取时机 spec 明写:**首次 `resolve()` 时惰性读一次、进程内缓存**。不在模块加载期同步读(避免 D5 的 ESM-cache 地雷),也不每次 `notify()` 重读。**改配置需重启 daemon 生效**——这与 inbox 现状(`defaultNotifier` 模块级、config 惰性 memoize)一致,不是新约束。

### D9 — app id 由 pilot 自己传,`RunContext` 不动

`createResolver('inbox')`。pilot 当然知道自己是谁,core 零改动。否决给 `RunContext` 加 app id(合理的脊柱能力,但不该被通知提案顺带推动)。

### D10 — 脱敏:inbox 自己维护,不导出共享清单

退役 `TELEGRAM_BOT_TOKEN` 的**同一次提交**里,inbox 的 `logger.ts` redact 换上 `TG_BOT_INBOX`(及 `*.TG_BOT_INBOX`;pino 不支持 key 后缀通配)。**理由**:hangar core 建 pino 没有 `redact`,inbox 的 `logger.ts:39-44` 是 bot token 唯一的 pino redact;只删不补 → 覆盖 1→0。

**不导出共享 `REDACT_PATHS`**(上一版设计里有,ponytail/CR 都指出多余):只有 inbox 一个 app 在范围内,导出一个枚举 4 个 app 的清单 = 75% 死条目 + 「加第 5 个 app 要回来改 notify 包」的反向耦合。每个 app 自己往自己的 logger 加两行即可。另:inbox 的 `redactError.ts:24` 是第二层(形状正则),须验证 bot token 形状仍被它捕获,且**与 resolver 的接受形状对齐**(`redactError` 是 `\d{6,}:[A-Za-z0-9_-]{20,}`,resolver 的校验不得比它宽,否则一个被放行的短 token 不会被洗掉)。

### D11 — `TG_BOT_<APP>` 是防撞名约定,不是隔离边界(诚实措辞)

pilot 在同一进程 `await import()` 加载,共享 `process.env`。任何 pilot 都读得到全部 `TG_BOT_*`。per-app bot 隔离的是 **Telegram 侧**的爆炸半径(吊销一个不影响其余、per-bot 限流、群里辨发送者)——这些是真的;**它不是进程级密钥边界**。

**不做 `delete process.env.TG_BOT_<APP>`**(上一版设计里有,是负收益):import 顺序不受控 → 删的只有自己那个,挡不住恶意 pilot;而它会让**任何第二次 resolve**(第二条 lane、重建渠道、测试里再构造)读到已删的 env → 一个完全正确的配置报 `skipped(config-invalid)`。删掉它,D11 的诚实措辞已经足够。真要进程级密钥边界,那是 pilot 加载器的变更(proposal 已承认的 landmine),不在本变更。

## Risks / Trade-offs

- **[配置错误 → 静默 `skipped`]** → D5 用降级换掉了抛错,代价是配置坏掉时一封 P0 可能不被通知(邮件仍正常处理)。**这不是回归**——今天 `TELEGRAM_*` 缺失就是这个行为。**Mitigation**:① 值非法时 ERROR 日志 + `notify.skipped` 审计事件(`hangar trace` 可见);② 部署期 preflight(在 daemon env 里)强制,坏配置上不了线。

- **[digest 段预算 vs 传输]** → inbox 传输不变,所以 `SEGMENT_MAX=4000` 的 96 字符余量仍按它自己发出的字节算,**依旧成立**(换 apprise 才会因转义膨胀吃穿它——这正是不换的理由之一)。无需重算。

- **[in-process `process.env` 冲突]** → `TG_BOT_<APP>` 规避撞名,但 landmine 本身不是通知造成的(pilot #2 落地时其他密钥会撞)。**Mitigation**:只记录,不顺手修。

- **[跨仓共享的是文件路径,不是包]** → 另外 3 个 agent 要「换群改一处」,前提是它们读同一份 `channels.yaml`,即与 hangar host 共享一个文件系统路径。它们不跑在 hangar 下,如何指到同一文件,本变更**不设计**(非目标)。本变更只兑现 inbox 这一个消费者;跨仓那半是它们各自采用 `channels.yaml` 格式时的事。**headline 收益「4 处变 1 处」在本变更内只对 inbox 成立**,别说超。

## Migration Plan

1. `packages/notify` 落地(resolver + self-check:文件缺失/YAML 错/无条目/env 缺失/空串/token 形状非法 → 全部 undefined 不抛;`${ENV}` 插值;fail-closed 拒绝明文 token)。
2. inbox 经 `file:../hangar/packages/notify` 依赖它(同机兄弟 checkout,不需 npm 发版)。**硬前置(review-loop round-1 Codex/RC 抓)**:`hangar-notify` 的 `main` 是 `dist/index.js`,而 `dist/` 是 git-ignored 且 pnpm 10 默认不跑依赖 build script → **deploy/CI 必须先 `pnpm --filter hangar-notify build` **再**在 inbox 侧 `pnpm install`(顺序不可反)再让 inbox 加载**——pnpm 把 file: 依赖**拷贝快照**进 inbox 的 store(非 live symlink),故重建 hangar 的 dist 后 inbox 侧不 reinstall 就仍是旧拷贝(review-loop round-1 实测)。否则 `import 'hangar-notify'` 在 inbox 模块加载期(`defaultNotifier` 构造,`await import()` 内)抛错 → ESM loader 永久缓存 → pilot 起不来。**silent-prod-wedge 由步骤 5 的 `hangar-notify check` 兜住**——那个 bin 本身就是 `dist/cli.js`,dist 缺失则它跑不起来、部署即停(天然 importability gate)。CI 若缺此前置则 import 失败 = 响亮红,非静默生产坑。**具体已证(review-loop round-2 Codex）**:inbox 现有 `.github/workflows/ci.yml` 只 `actions/checkout`(单仓)+ `pnpm install --frozen-lockfile` → `file:../hangar/packages/notify` 路径在 CI 里不存在 → install 失败、CI 红。故提交 group B 到 inbox 前须解此。**已选并实现方案 ①**(hangar 已转公开仓,默认 `GITHUB_TOKEN` 即可 checkout):inbox 的 `.github/workflows/ci.yml` 改为两仓 checkout 到兄弟路径(`inbox-pilot/` + `hangar/`)、先 `pnpm install --frozen-lockfile --filter 'hangar-notify...'` + `pnpm --filter hangar-notify build`、再 inbox install(`working-directory: inbox-pilot`)。fresh CI checkout 无本地 `apps/inbox` gitignored 符号链接,故不污染 hangar workspace(已实测)。CI 每次 fresh build hangar-notify 再装 inbox,顺带消掉 RC-F3 的 stale-snapshot 顾虑。备选 ② 提前 npm 发布 `hangar-notify` 仍是长期更干净的路(D5),CI 逼它提前只是时机问题。**CI review-loop 定的两点**:(a) CI 末尾加 `pnpm exec tsx --test 'src/notify/*.test.ts'`(只跑 notify 子集、不需 postgres——全量 `pnpm test` 需 DB,这是原 CI 只 build 不 test 的原因),让 wire/ERROR-branch 安全测试真在 CI 跑、堵住「运行时回归绿着过」的 false-green;(b) hangar checkout 暂**不钉 ref**、跟 main(co-开发期 lockstep;失败响亮红非 false-green;要可复现就钉 tag 或走 npm 发布)。**npm 发布留给 ai-radar 那个非兄弟仓落地时刻意做**——届时 inbox 依赖 `hangar-notify@^x` 从 npm、CI 回退单仓、这些遗留一并清。(npm 发版路径由 `prepack` 建 dist 入 tarball,无此问题。)
3. inbox 侧:`telegramChannelFromConfig()` 改读 resolver;`logger.ts` redact **加** `TG_BOT_INBOX`(**本步现在做**——secret 已 live)。**传输/渲染/测试不动。**注意:`configSchema` 删 `TELEGRAM_*` 与删旧 redact 条目属**退役**,延到步骤 7(观察期后);本步只**增**不**删**(RC round-2 F1:避免步骤 3 与步骤 7 自相矛盾)。
4. **先确认 `TELEGRAM_*` 今天在 ts.mac-mini 的真实来源**(plist? 别处?),再写 BREAKING 步骤;考虑把 plist 模板 check 进 `deploy/`。
5. 部署:plist `EnvironmentVariables` 加 `TG_BOT_INBOX` + `HANGAR_NOTIFY_CONFIG`(plist 须**显式**设 `HANGAR_NOTIFY_CONFIG`——preflight `hangar-notify check --from-plist` 强制它存在、否则退 1;约定默认路径只兜底 `hangar run` 那类 shell 入口,不覆盖 plist);保证 `hangar run` 入口也拿得到;放 `channels.yaml`;**在 daemon 的 env 里跑 `hangar-notify check`**;切换。
6. 生产观察一个发布周期(P0 即时通知 + 每日 digest 各真发过一轮;因传输不变,文案与今天**逐字节一致**——这条验收现在**可通过**)。
7. 删旧路径 + inbox 自己 OpenSpec 出 delta(`notifications:61,68`、`service-bootstrap:9`)+ docker-compose 路径出 delta + 清文档债。

**回滚**:步骤 7 之前,inbox 的 `telegramChannelFromConfig()` 换回读 `config.TELEGRAM_*` + 恢复两个 env 即可。因传输从未动过,回滚不涉及任何投递代码;且 D5 不抛,回滚不需要「模块能 import 进去」这个前提。

## Open Questions

无。(跨仓 3 个 agent 如何指到同一 `channels.yaml` 属它们各自采用时的事,本变更非目标,已在 Risks 说明。)
