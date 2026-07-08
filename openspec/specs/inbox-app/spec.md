# inbox-app 规范

## 目的
inbox 作为 hangar pilot 运行的能力:仓根 `app.yaml`(`executor: pipeline`,host in-process 加载 `dist/pipeline.js`)+ 多具名 cron 触发(`poll` 每 3 分钟 fetch→classify→notify、`digest` 每日定点汇总当日 P1/P2/P3),自动动作在 `run()` 内直接编排、审计经 `ctx.emit`,域逻辑住 inbox 自己的 repo、不进脊柱(#1)。
## 需求
### 需求:inbox 以 pipeline executor + cron 触发作为 app 运行

系统必须把 inbox 作为 **hangar repo 之外的独立 pilot repo** 运行:仓根 `app.yaml` 的 `executor` 必须为 `pipeline`(host 解析 `<appDir>/dist/pipeline.js`(编译产物)优先、回退 `<appDir>/pipeline.ts`,调其 `run(ctx)`),触发器必须为 cron;host 经可配 apps 根(`HANGAR_APPS`)**in-process 加载其编译产物**。`app.yaml` **禁止**声明 `permissions.approval`——inbox 现状无任何高危动作。inbox 的域逻辑必须住 **inbox 自己的 repo**,禁止进入 `@hangar/core`(#1)。重叠的 cron 触发**禁止**产生同 app 的并发 run(依赖脊柱 `idx_run_active_lock` 串行化);daemon 必须优雅跳过被 active-lock 拒绝的触发,禁止崩溃。

#### 场景:cron 到点起一次 run 并跑完

- **当** cron 触发时刻到达,hangar 为 inbox 起一个 run
- **那么** `run(ctx)` 被调用、处理完当轮邮件、无 pending approval,run 经 choke-point 进入 `completed`,`hangar trace <run>` 可见 `started →(分类/动作域事件)→ completed`

#### 场景:上一个 run 未完时下一次 cron 触发

- **当** 前一个 inbox run 仍非终态,下一次 cron 触发尝试起新 run
- **那么** 脊柱 `idx_run_active_lock` 拒绝创建并发 run,daemon 优雅跳过该次触发(不崩溃、不双跑)

### 需求:自动动作在 run() 内直接编排,不经 gateway/propose

inbox 的自动动作(reflect_priority / mark_read / notify)必须由 `run(ctx)` 直接调用搬入的域编排(inbox 原 `executeActions`,**gut+restructure**:剥掉 durable `recordAction`/`enqueueRetry`/`updateAction`,保留内存有界重试 + BackoffBudget + 三值处理 + reauth 致命,并**把每动作结果 surface 成返回值**);**禁止**经 `ctx.propose`/gateway 执行(propose→PARK→approve 是 approval 门控,inbox 无高危动作;`ctx.propose` 保留给 Phase 2 的 gmail.send)。动作审计必须经 `ctx.emit` 写域事件进 `RunEvent.payload_json`。系统**禁止**迁入 durable `retryQueue` / `drainAccountRetries` / mail_actions 状态机。

- **结果回传契约**:`executeActions` 必须返回每动作结果 `{ reflect, markRead, notify: 'none'|'sent'|'skipped'|'failed', notifyExhausted: boolean }`（`'none'` = 不满足 `shouldNotifyNow` 未发；或注入 `emit` dep 等价物）;run() 依 `notifyExhausted` 决定是否跳 `markProcessed`。仅剥 durable 不够——run() 必须**学到**结果才能 emit 真事件与判耗尽。
- **per-email catch 作用域**:run() 的 per-email try/catch 只吞**良性**(classify 崩 / get-map-normalize 失败)→ skip 该封 continue;`ProviderReauthRequired` 与终态 DB I/O **必须逃出**该 catch → 账号级处理,**禁止**被当作「skip 一封」。**两者账号级处理不同**:硬 reauth → **持久** `setAccountEnabled(false)` + emit `account.suspended`(reason `reauth-required`,下条);终态 DB I/O(瞬时故障)→ **仅本 run break 该账号 + emit `account.suspended`(reason `terminal-error`,供 trace 审计、区别于「无邮件」run),不持久 disable**(下轮 cron 自然重试)。
- notify `sent` → emit `notify.sent`(该 emit 须在重试 try **之外**,保非幂等 notify 不因落库失败重发);`skipped` → emit `notify.skipped`(终态、不重试);`failed` → 内存有界重试,耗尽 → emit `notify.failed` 并触发下一需求(跳 markProcessed)。
- reflect_priority / mark_read 成功 → emit `reflect.ok` / `mark_read.ok`(best-effort 成功审计;design D2 枚举 `reflect.ok`);发送态耗尽 → emit `reflect.failed` / `mark_read.failed`(best-effort、记降级)、**不阻断** notify。
- 任一动作/读侧遇 `ProviderReauthRequired`:**硬 reauth(`invalid_grant` / scope-403)→ 持久 `setAccountEnabled(false)`**(`invalid_grant` 不自愈,持久化防每 tick 徒劳打 token 端点;clear-path = 既有重授权流 `updateGmailTokens`+`setAccountEnabled(true)`);**本 run 内存 suspend set** 只做本 run 内跳过该账号剩余邮件、break 其邮件循环;不重试;emit `account.suspended`。
- 错误文本进任何事件前必须过 inbox 域脱敏 + **截断为摘要**(禁含 email 地址 / chat_id / telegram token / 正文);emit payload 须带**非 PII** 的 `messageRowId`/`providerMessageId` 供 trace 按封归因。

#### 场景:notify 成功即内联落地并如实审计

- **当** run() 调 notify 得 `sent`
- **那么** emit `notify.sent`、该封继续走到 `markProcessed`;trace 如实显示 sent(非 skipped/failed)

#### 场景:reflect 瞬时失败不抑制 notify、审计如实

- **当** reflect_priority(始终第一个)发送态耗尽而 notify 本应发送
- **那么** run() emit `reflect.failed`(真实、非假绿)、**继续**调 notify,notify 不被首个动作失败抑制

#### 场景:token 撤销即致命隔离,单次命中不猛打

- **当** 某动作/读侧遇 `ProviderReauthRequired`(`invalid_grant`)
- **那么** run() 不重试(不经 gateway 3× 路径)、**持久** `setAccountEnabled(false)`、本 run 内 break 该账号邮件循环、emit `account.suspended`;该账号在重授权前不再被 `listEnabledAccounts` 取到(不每 tick 猛打 token 端点)

### 需求:notify 耗尽走 coarse re-poll,依赖不变量并有死信终态

仅 notify 发送态耗尽时,该封**禁止**置 `processedAt`,依赖 email 级 at-least-once re-poll 于下轮 cron 重跑。re-poll 的「不丢推送」**唯一依赖**不变量 `shouldNotifyNow ⊥ shouldMarkRead`(P0/P4 vs P2/P3 不相交):系统必须(a)显式记账为 seam B 前提、(b)提供 self-check 断言、(c)**禁止将来放松**该不变量。(动作顺序 reflect→notify→mark_read 仅为可读性,**不**是不变量放松时的 fallback——若真同真,mark_read 仍在同批 notify 后清 unread,重排救不了。)re-poll 重跑**必须复用已持久化分类**(经新增 `getClassification`,复用既有 `rebuildFinalDecision` 重建、跳过 `saveClassification` 避免追加重复行)。系统**必须**有死信终态且**覆盖所有已落库成因**(notify 耗尽 / saveEmail 之后的 timeout / classify 崩):`mail_messages` 加一列 re-poll 计数,**在重跑一封已存-未处理封的最开头**评估门 `计数≥K 或 receivedAt 超 staleness` → `markProcessed` + emit `email.dead_letter`(payload 带**终态原因** `max-attempts`/`stale`;门在入口、当轮失败因未知)、跳过本封;否则计数 +1。门在入口 ⇒ 封顶所有已落库成因。**落库前失败**(坏 MIME normalize / pre-save timeout,无行无计数)不被此门封顶——每 tick `is:unread` 重取+skip(成本仅 1×get,与旧 Gmail 同级),记已接受降级;实测持续刷屏才加 `(accountId,providerMessageId)` intake 计数。

#### 场景:notify 耗尽 → 留 unread → 重跑复用分类 → 计数推进

- **当** 某封 notify 发送态耗尽(mark_read 因顺序未执行,邮件仍 unread)
- **那么** 不置 `processedAt`、不入 durable 队列、re-poll 计数 +1;下轮 `is:unread` 取回、dedup 命中未处理封 → 经 `getClassification` 复用分类(跳过 LLM)、重发 notify

#### 场景:达死信阈值即终止重发

- **当** 某封 notify 的 re-poll 计数达 K(或 receivedAt 超 staleness 上界)
- **那么** 置 `markProcessed` + emit `email.dead_letter`(payload 带终态原因 `max-attempts`/`stale`),该封不再被 re-poll 重发

#### 场景:不变量 self-check

- **当** 对所有优先级枚举运行动作派生 self-check
- **那么** 断言不存在任一优先级同时 `shouldNotifyNow=true ∧ shouldMarkRead=true`

### 需求:fetch 编排复刻两级读错误模型与成本上界

`run(ctx)` 内重组的 poller 编排(取信循环、穷尽分页、DB 预去重、最旧优先)**必须**复刻旧 poller 的读侧错误分层与成本上界(**不调** `drainAccountRetries`):

- 读侧(list/get)`429/配额` → **结束本轮**(禁逐封 skip 继续翻页,加剧限流)。
- 读侧 `401 / scope-403(insufficientPermissions) / invalid_grant(HTTP 400)` → 结束本轮 + suspend 账号。
- 读侧瞬时 `403(rate/quota)` → 结束本轮、不 suspend。
- 良性 get/map/normalize 失败 → 逐封 skip + log continue。
- 必须保留 `processFrom`/`after:<epoch>` 水位下界 + get-budget ≤200 上限(否则大量 unread 积压下每 tick 穷尽翻页 + 无 classify/get 上限 → API/LLM 爆发 + 长 run 占 active-lock)。
- **读侧终态由 run() 捕获、按账号结束本轮后 run 仍走 `completed`**;`run.failed` 只留给真故障(否则例行 429 每 run 标 failed、污染 trace)。

#### 场景:读侧 429 结束本轮而非逐封 skip

- **当** 分页取信中某次 list/get 返回 429/配额
- **那么** 结束本轮(不继续翻页)、下轮 cron 重试;**禁止**逐封 skip 继续翻页加剧限流

### 需求:每 email 超时 + 每 run 兜底,机制必须安全(取消尽力 + 吞拒绝 + fence)

`run(ctx)` **必须**自持超时防 hung 调用永占 `idx_run_active_lock`(reaper 只回收崩溃、不回收 live-hung)。**裸 `Promise.race` 不够**:

- **per-email 主超时 + per-run 兜底**:主超时锁到 **per-email**(避免 per-run + 最旧优先让一封 hung-poison 最旧邮件每 tick 吃掉整 run、饿死更新邮件);per-email 值按**单封实际工作量级**(数十秒,**非**旧 `DEFAULT_POLL_TIMEOUT_MS`=5min 那个**每轮**预算,否则 200×5min≈16h 占锁);**另加一个结束本轮的 per-run 墙钟兜底**(剩余邮件 → re-poll、受死信门封顶;因 per-email 已封单封,兜底不重引入 head-of-line)。
- **取消尽力、真兜底是 fence+吞诺**:底层 Gmail/LLM/telegram 调用挂 `AbortController`/client timeout **尽量**中止(googleapis AbortSignal 是 best-effort、不保证毁 socket;原语签名须加 `signal` 参)——但 anti-wedge 保证**不靠取消**,靠下两条。
- **吞拒绝**:被弃 promise 稍后 reject 无 handler → `unhandledRejection` → Node 杀 daemon(楔死重现);被弃分支**必须**挂吞拒绝 `.catch`(参 `scheduler.ts:164`)。
- **超时后 fence(per-email 作用域标志,每封新建)**:释放锁前用 aborted 标志在每个 `ctx.emit`/`markProcessed`/副作用前 fence,禁止晚到调用(reject **或** resolve)写已完成的 run / 多发 notify。

#### 场景:hung 调用被超时打断,锁释放且不崩 daemon

- **当** 某封的某调用挂起超过 per-email 超时上界
- **那么** run() 尽力取消该调用、该封留待 re-poll(计数受死信门封顶)、正常返回释放 active-lock;被弃 promise 的晚到 reject **被吞**、晚到 resolve **被 fence 挡住**(不 emit/不 markProcessed)、**无 `unhandledRejection`**、daemon 不崩;下一 cron tick 不被楔死

### 需求:in-process pilot 模块加载安全(顶层禁 process.exit/throw)

脊柱 daemon 经 `import()` **in-process** 加载 pilot 编译产物;pilot 代码在**模块顶层**(import 时)执行的 `process.exit` 或 throw 会在**加载即杀死整个 daemon**(绕过 D7 fence/reaper——非单 run 崩)。故 pilot 模块顶层**禁** `process.exit`、**禁** throw;所有 env/config 校验与致命处理必须移入 `run(ctx)`(throw → `run.failed`,受 choke-point + reaper 覆盖)。inbox 的 `src/config/config.ts` 现在 import 时对坏 env `process.exit(1)`,**必须**改:把该 exit 门控在 is-entrypoint 判断之后,或改由 `run(ctx)` 校验 config 并 throw(→ `run.failed`)而非 exit。

#### 场景:坏 env 下 daemon 不被 pilot 加载杀死

- **当** daemon 加载一个 config 无效的 pilot 模块
- **那么** import 不触发 `process.exit`/throw(daemon 存活);config 无效在 `run(ctx)` 内 throw → 该 run `failed`、daemon 继续调度下一 tick

### 需求:域库与脊柱库并存,脊柱零域概念

inbox 必须自管其 PostgreSQL / prisma 与邮件域表,hangar **禁止**读写它;hangar 只认自己的 SQLite 4 表,本变更**禁止**新增表/库/进程(seam B 的 re-poll 计数是既有 `mail_messages` 加一列,属 inbox 域库)。`@hangar/core` 代码中**禁止**出现 email / mail / inbox 域名词;inbox 域细节只经 `ctx.emit` → `RunEvent.payload_json` 流过。取信接缝切清:薄 provider 原语 + `executeActions`(去 durable)+ `mailRepo`(**trim** `recordAction/enqueueRetry/updateAction/markActionDeadLetter/getCursor/setCursor`,**新增** `getClassification` 读方法)当库搬入;poller 编排在 run() 重组、不调 `drainAccountRetries`;IMAP 游标 skeleton 不搬。

#### 场景:脊柱不含域名词,域细节经事件流过

- **当** 检视 `@hangar/core` 源码与本变更对脊柱的改动
- **那么** core 中不出现任何邮件域名词、core 代码仅一处小脊柱改动(0.3:入口认 `dist/pipeline.js` + symlink 跟随,非域名词/概念)+ DESIGN 契约修订;分类/裁定/动作结果仅作为 `ctx.emit` payload 进入 `RunEvent.payload_json`

### 需求:Phase 1 不引入 approval 动作

本变更**禁止**引入任何走 propose→approve→PARK 的高危动作:`gmail.send` 不实现,approval 债(多进程 approve 仲裁 / gmail.send exactly-once / 审批后回写)整体延后 Phase 2。inbox 任一 run **禁止**进入 `waiting_human`。文档两处「发送邮件走 hangar approve」判据(`ROADMAP.md:31`、`DESIGN §5` 完成判据行)必须改写为「若存在高危动作则走 approve」;`ROADMAP.md:32`「能力无退化」改为枚举已接受降级;`ROADMAP.md:40-42`「补齐多进程仲裁」中 approval 仲裁项路由 Phase 2、reap-vs-run 项标记已接受降级。

#### 场景:inbox run 永不停在等审批

- **当** inbox 的任一 run 结束
- **那么** 其状态直接为 `completed` 或 `failed`,不经过 `waiting_human`;`Approval` 表不因 inbox 产生任何 pending 行

### 需求:每日摘要作为 digest 触发器
inbox app SHALL 声明两个触发器:`name: poll`(`*/3 * * * *`,现有 fetch→classify→notify 每轮循环)与 `name: digest`(数组 schedule,每日定点,汇总当日 P1/P2/P3 摘要)。`run(ctx)` MUST 按 `ctx.trigger` 分派:`'digest'` → 摘要流程(`buildDigest → 逐段 notifyDigest → markDigested`),`'poll'` 或 `undefined` → 现有 poll 流程,**其余未知 name → throw**(拼错/漏配触发器时响亮失败,不静默走 poll)。digest 触发器的时刻由 `app.yaml` 的 cron 数组给出(默认 `["0 6 * * *","30 12 * * *","0 19 * * *"]`,Asia/Shanghai)。摘要审计 SHALL 经 `ctx.emit`(`digest.sent`/`digest.empty`/`digest.failed`)。

#### 场景:digest 触发发摘要
- **WHEN** digest 触发器到点 fire,当日有未摘要的 P1/P2/P3
- **THEN** `run(ctx)`(`ctx.trigger==='digest'`)构建摘要、逐段推送、发成功即 `markDigested`,已 mark 的下轮不重发

#### 场景:未知 trigger 响亮失败
- **WHEN** `ctx.trigger` 是既非 `undefined` 又非 `poll`/`digest` 的值(配置拼错)
- **THEN** `run(ctx)` throw(不静默走 poll),run 记 failed 供 trace 发现

#### 场景:摘要为空不推
- **WHEN** digest 触发 fire 但无 P1/P2 且 P3 计数为 0
- **THEN** `buildDigest` 返回 null,记 digest-empty、不推送

#### 场景:poll 触发不受影响
- **WHEN** poll 触发器 fire(`ctx.trigger==='poll'`)
- **THEN** 走现有 fetch→classify→executeActions→markProcessed,不触发摘要

### 需求:DIGEST_TIMES 环境变量退役
摘要调度 MUST 由 `app.yaml` 的 digest 触发器 cron 提供,`DIGEST_TIMES` 环境变量与 `digestScheduler` 的 node-cron/时刻解析逻辑 SHALL 退役、不再驱动调度。`configSchema` 的 `DIGEST_TIMES` 字段 SHOULD **保留但标记退役(不再读)**,而非删除,以免既有 `.env` 触发 config 严格校验报错。摘要**内容组装**域码(`buildDigest`/`notifyDigest`/`markDigested`/一轮编排)SHALL 复用、不删。

#### 场景:忽略 DIGEST_TIMES
- **WHEN** `.env` 仍设 `DIGEST_TIMES`
- **THEN** 不影响调度(以 app.yaml digest 触发器 cron 为准)、不报错

