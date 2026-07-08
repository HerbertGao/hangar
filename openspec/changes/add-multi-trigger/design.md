## Context

hangar pilot 模型:一个 app = 一个 `run(ctx)`,由 hangar daemon 按 `app.yaml.triggers` 的 cron 触发。当前:
- `app.yaml.triggers` 已是数组,`daemonTasks` 已 `flatMap` 全部触发各起一个 `cron.schedule`。
- **但** 触发身份不进 `ctx`(`RunContext = {input, config, logger, emit, propose}`),`run(ctx)` 分不清是哪个 trigger 触发;且每 app **单活跃-run**(`idx_run_active_lock`),多 trigger 同刻 fire 会撞锁(一个 `runApp` 撞 UNIQUE 抛)。
- 现状 daemon:cron fire 时 `if hasActiveRun → skip + log`。

第一个真实需求:`add-inbox-migration` 删 `main.ts` 时丢了每日摘要的启动点(`startDigestSchedulers`),`buildDigest`/`notifyDigest`/`markDigested` 成孤儿。inbox 要一个 poll 触发(`*/3` classify→notify)+ 一个 digest 触发(`DIGEST_TIMES=06:00/12:30/19:00`,汇总当日 P1/P2/P3),**各干不同事**。用户确认这是**通用脊柱能力**(未来「同一 agent 多触发形式各干不同事」),要提前完善且后续开发者好理解。

约束:#1 脊柱零域;#2 通用而非 inbox 过拟合(已确认);#3 不加表;#6 v0 无 HTTP/webhook;#9 先改 DESIGN。

## Goals / Non-Goals

**Goals:**
- 脊柱通用支持「一个 app 多个具名触发、各分派到不同行为」,契约最小、后续开发者一眼看懂。
- 恢复 inbox 每日摘要(作为首用例,同时验证多触发)。
- heartbeat 与现 inbox 单触发路径**零回归**。
- 多触发同刻 fire **不丢**任何触发(尤其 digest),且保「每 app 单活跃 run」不变量、堆积有界。

**Non-Goals:**
- 非-cron 触发机制(webhook/manual/event)——只留 schema 形状 + 注释,**不建机制**(#6,Phase 3)。
- per-trigger config/permissions/executor(YAGNI;config 留 app 级)。
- 放宽「每 app 单活跃 run」为并发(不改锁/reaper 模型)。
- approval 相关(Phase 2)。

## Decisions

**D1 — 路由:`ctx.trigger` + app 内分派(非命名 handler、非 per-trigger executor)。**
脊柱把触发的 name(不透明字符串)塞进 `ctx.trigger`;`run(ctx)` 单入口,app 内 `switch(ctx.trigger)`。为何:脊柱**零域知识**(不认识 poll/digest,守 #1);契约只加一个字段(vs 命名 handler 要多入口加载约定 + 复杂化鸭子契约;vs per-trigger executor 破「app.yaml 唯一入口」#4)。app 可把内部分派写成 `runPoll`/`runDigest` 保可读。

**D2 — `ctx.trigger` = trigger 的 `name`(字符串,非结构化、非派生)。**
run() 靠稳定语义 name 分派。为何 name-string:最轻、可读(vs `{type,name}` 结构化——单 trigger 也得包对象、契约变重,且 type 对分派非必需:未来 webhook 也是 `switch(name)` + 读 ctx.input 里 payload;vs 从 schedule/index 派生——改 schedule/调顺序即变身份,脆弱)。

**D3 — `schedule` 接受 `string | string[]`,每条须为合法 cron。**
`z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])`,且每条 schedule 字符串经 `.refine(s => cron.validate(s))` 校验——空串/非法 cron(如 `"30 12 * *"`)→ `spec_invalid`(load 时拒绝、doctor 报错、app 不注册)。**为何在 schema 拦**:daemon 的 `cron.schedule` 循环无 try/catch、非法 cron 会同步抛并逃出 `main()` 的 try → **崩掉整个 daemon、所有 app 停调度**;被替换的 `digestScheduler` 原有 per-task try/catch 隔离,调度移到 app.yaml 后靠这层 load-时校验补回(daemon 循环因此可假设 cron 已合法,留一行 `ponytail:` 注释点明)。数组 = 同一 trigger、同一 name、多个 cron 时刻(digest 的 06:00/12:30/19:00 分钟不齐,一条 cron 表达不了);`daemonTasks` 展开数组成多 `cron.schedule`、**都带同一 name** → 都分派同一行为,并 `[...new Set(arr)]` 去重(同串重复 = 同刻双跑,去掉)。为何 union 而非「多个同名 trigger 条目」:配置不繁琐(一个 digest trigger 而非 3 个);为何 union 而非「总是数组」:单触发保持 `schedule: "*/3 * * * *"` 简洁。

**D4 — `name` 可选,但 app **>1 trigger 条目**时 schema 强制必填且唯一。**
单触发可省 name → `ctx.trigger=undefined`(heartbeat/现 inbox 零改动)。多触发(条目数 >1,非展开后的 schedule 数)每个必须有非空 name,**且同 app 内 name 互不重复**,否则 `spec_invalid`。为何必填:单触发向后兼容 + 多触发被迫命名 → 分派无歧义、后续开发者一眼看懂。为何唯一:D2 拿 name 当 trigger 身份、D5 按 `app+name` 去重 pending——同名两条会塌成同一 `ctx.trigger`/`Run.trigger`/pending 键,trace 归因歧义、且可能丢一个 pending fire。`SpecSchema` superRefine 一并校验 `length>1 → 每条非空 name` 与 `name 集合无重复`。(vs 总可选——多触发可能匿名 → `undefined` 歧义;vs 总必填——破 heartbeat/inbox 向后兼容。)

**D5 — daemon 序列化:本 daemon 内 per-app 序列化 + 去重(替换 skip)。**
per-app 内存 `inFlight` set + `pending`(按 `app+trigger name` 去重、每 trigger 至多 1 pending、封上界;`pending` 是**易失调度提示、非 run-state 真相**——RunEvent 仍是审计 SOT[#3/§3.3],`pending` 不进 4 表、不进 status/trace/doctor、daemon 崩即丢,drain 按插入序)。`fire(app,name)` 回调:`inFlight.has(app)`(本 daemon 正跑该 app)→ 记 pending(去重);否则 `hasActiveRun(db,app)`(**别的进程**持锁,**或本 daemon 的 run 已 park 成 `waiting_human` 仍持 active-lock**)→ skip+log(接受降级、同现 reap-vs-run);否则跑。**drain 必须按 DB 活跃态而非 promise 生命周期判定**:`runApp` 的 `.finally` 里 `inFlight.delete(app)` 后,取一个 pending **走回 `fire(app,name)`**(而非直接 runApp)——若此刻 `hasActiveRun` 仍真(run 已 resolve 但 park 成非终态、仍持锁),drain 落 skip+log(与 `blocked` 语义一致),**不**盲跑撞 `createRun → already_running` 把 pending 丢掉。为何:多 trigger 同刻 fire(12:30 digest 与 `*/3` poll 的 `:30` 对齐)不丢 digest;保单活跃-run 不变量(不并发);去重封住堆积(慢 poll 期间至多 1 pending poll)。**park 交互**:一个 run park 时仍持 app 锁,期间该 app 的 fire 一律 skip+log 直到 run 达终态(仅 Phase 2 approval 才会发生;inbox poll/digest 不 propose→不 park,本阶段休眠——但 heartbeat 已用 `permissions.approval`,通用能力须自洽)。**liveness 假设**:`inFlight` 只在 `runApp` settle 时清——pilot 的 `run()` **必须自限时**(inbox:每邮件 45s / 每轮 10min),否则挂死的 run 永占 `inFlight`、该 app 再不调度(与现状 `hasActiveRun→skip` 同一 wedge、非本变更新引入;脊柱级 watchdog 属未来范围)。为何不放宽单活跃-run:破核心不变量 + 锁/reaper 大改 + 两 run 同碰同批邮件/DB 有风险。

**D6 — 未来非-cron 形式:schema 形状可扩展 + 注释,零机制。**
`type` 作判别字(现 `z.literal('cron')`,是一臂的 union);注释点名 webhook/manual/event → Phase 3、受 #6 门控。为何:分派已由 D2(name)类型无关地兼容;扩展点**可见可读**(后续开发者看到 `type` + 注释)但**不投机建机制**(v0 建不了 webhook、YAGNI、#6)。

**D7 — config/permissions 留 app 级,trigger 只带 `{type, name, schedule, timezone}`。**
run(ctx) 拿 app.config + ctx.trigger,在代码里按 trigger 分支即可。为何:YAGNI(digest 不需 per-trigger config);schema 仍可扩展(未来真需再加);最可读。

**inbox 落地(应用上述能力 + 恢复摘要):**
- `app.yaml` 两条 trigger:`{type:cron, name:poll, schedule:"*/3 * * * *", timezone:Asia/Shanghai}` + `{type:cron, name:digest, schedule:["0 6 * * *","30 12 * * *","0 19 * * *"], timezone:Asia/Shanghai}`。
- `run(ctx)` 按 `ctx.trigger` 分派,**显式 case + loud default**:`'digest'` → `runDigest`;`'poll'` 或 `undefined` → `runPoll`;其余(既非 undefined 又非已知 name)→ **throw**(拼错/漏配 trigger name 时响亮失败,而非静默走 poll 在 digest 时刻双 poll)。名→行为绑定是**约定**(脊柱零域、无法内省 app 的 switch),故 app 侧自守 loud default。
- `runDigest` **包裹**(非逐字调用 `runDigestOnce`)一轮编排、把审计经 `ctx.emit`(`digest.sent`/`digest.empty`/`digest.failed`,非 PII)而非模块 logger:`buildDigest(repo, now)` → 逐段 `notifyDigest(seg.text)` 成功即 `markDigested(seg.messageRowIds)`、遇非 sent 停;build 为 null → emit `digest.empty` 不推。`runPoll` = 现有 fetch→classify→executeActions→markProcessed。
- `hangar run <app> [--trigger <name>]`:`run` 命令加可选 `--trigger`,把 name 经 `RunRequest.triggerName` → `ctx.trigger`,让 digest 路径可**手动触发/重放**(否则 `hangar run inbox` → `ctx.trigger=undefined` → 只会跑 poll、digest 无法手动验证或补发)。CLI 已解析 flag,一行接线。
- `DIGEST_TIMES` env 退役(调度移到 app.yaml);`digestScheduler.ts` 的 `startDigestSchedulers`/`DIGEST_TIMES` 解析/node-cron 部分删除,只留一轮编排(runOnce 语义)供 runDigest 复用;`configSchema` 的 `DIGEST_TIMES` 字段保留但标记退役(不再读)、不删,以免既有 `.env` 触发 config 严格校验报错。

## Risks / Trade-offs

- **跨进程碰撞仍 skip(接受降级)**:D5 只在本 daemon 内序列化;若真有第二个 daemon/CLI 并发持锁,该 fire skip+log(单 launchd daemon 部署下极罕见,同现 reap-vs-run 已接受降级)。**digest 特例**:两写者若各自在 `markDigested` 前 `buildDigest`,会各看到同批未标候选 → Telegram 双推(`markDigested` 无唯一约束挡不住并发);单-daemon 假设下不发生,多写者才有、属接受降级。真出多入口再补。
- **`inFlight`/`pending` 是内存态**:daemon 崩溃丢 pending(launchd KeepAlive 重拉后 cron 照常下一周期 fire;digest 丢一次窗口 → 下个 DIGEST_TIME 补,或该窗口无摘要)。可接受(不引 durable 队列,守 #8 精神;`pending` 定性为易失调度提示、非 RunEvent 那样的持久真相)。
- **`ctx.trigger` 是运行时鸭子契约新增字段**:老脊柱不传 → pilot 读到 undefined → 默认路径(向后兼容);pilot 须防御性读(`ctx.trigger === 'digest'`,undefined 落默认)。fail-loud **不**断言 trigger(可选)。
- **`Run.trigger` 列混载 name 与类别**:存 `triggerName ?? req.trigger ?? 'manual'` → 值域是 trigger name(`digest`/`poll`)∪ 类别(`cron`/`manual`);现无消费者 switch 它(仅 `cmdRuns` 透传显示),但未来消费者**不得假设** `trigger ∈ {cron,manual}`。
- **overdue 检测(`appPeriodMs`)对数组 schedule**:取每条 cron 周期的**最小值**——即「最快的那条 trigger 一个周期没跑就算 app overdue」(语义正确:blocked = 漏过任一 trigger 的 ≥1 次 fire;注意这是**最激进**的判定、非「保守/不误报」)。overdue/blocked 是**诊断性告警、非执行门**;边角:某 app **唯一** trigger 是多时刻日频数组(无高频兄弟 trigger)时,每条周期都是「日」→ 中午漏一次要等到次日才翻 blocked——可接受(诊断滞后,不影响正确性)。
- **digest 幂等**:同 D5 去重 + `markDigested`(已 mark 段下轮不重发)双保;12:30 digest 与 poll 撞 → digest 排队 pending、poll 跑完即 drain,digest 迟几秒发(可接受)。
- **未来非-cron 形式**:schema 只留形状,真加 webhook 时仍要 Phase 3 的 HTTP 入站(#6)+ 可能的 ctx.input payload 契约——本变更不解,只保证 name-路由天然兼容。
