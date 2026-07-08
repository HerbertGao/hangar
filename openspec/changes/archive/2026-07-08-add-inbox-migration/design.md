## 上下文

Phase 1 是 hangar 的验证里程碑,出口闸 = 连续 7 天每天用 inbox 且不想切回旧 inbox-pilot。探索 + 两轮对抗性 review 澄清了三件决定本设计的事实:

1. **inbox 真实用法是「自动分类推送」**——现有动作 reflect_priority / mark_read / notify 全自动、无一需人批。propose→approve→PARK 在 inbox 现状里一次都不触发。故本变更迁的是**「脊柱 减去 approval」**层。
2. **旧 inbox 的持久性是两层、刻意不重叠**(`executeActions.ts:21`「与 processedAt 的 email 粒度 re-poll 互补不重叠」):① email 级 at-least-once(`markProcessed` 最后);② action 行级 durable 重试(`enqueueRetry`+`drainAccountRetries`,`recordAction→already-retrying→SKIP` 保非幂等 notify 唯一恢复)。durable 层破 #3/#8,**不搬**;其职能由 email 级 re-poll + 一个死信终态承接(D3/D6-terminal)。
3. **hangar tool gateway 是「二值 成功/抛出」的无状态执行器,其存在理由是 approval 门控**(propose→PARK→approve)。inbox 的自动动作是「三值 sent/skipped/failed + 致命 reauth + 退避 + 域脱敏 + 两级读错误」的**有状态域编排**。两轮 review 证明:把自动动作硬塞进 approval gateway 会在每个角落撞阻抗(handler 无 emit → 假绿审计、gateway 3× 重试 → 猛打撤销 token、无 attempt# → 无法区分耗尽、无 typed-fatal)。**结论(用户已授权):自动动作不走 gateway,直接在 `run(ctx)` 内编排;`ctx.propose` 保留给 Phase 2 的 approval 动作(gmail.send)。**

约束:9 条不变量(#1 脊柱零域、#2 inbox 用不到不进脊柱、#3 4 表单库、#5 审批只在 OS 层、#6 无 HTTP/IPC、#8 只 propose→approve→execute 一种切点、#9 改架构先改 DESIGN)。

**拓扑(B,已定):** inbox 是 **hangar repo 之外的独立 pilot repo**,host 经 `HANGAR_APPS` in-process 加载其**编译产物**(`dist/pipeline.js`);域码就地改、不拷贝进 hangar;inbox 独占自己的 PG(无共库)。`@hangar/core` 本变更**仅一处小改**(入口解析认 `<appDir>/dist/pipeline.js`,tasks 0.3)——filesystem-external + in-process、单进程(#6 保持,代价:一个崩溃域);治理改写见 DESIGN §3.1/§3.2/§4/§5/§6(tasks 0.2 已做,#9)。逻辑设计(下方 D1–D7)与拓扑无关,A/B 一致。

## 目标 / 非目标

**目标:**
- inbox 作为**外部 pilot repo**(app.yaml pipeline + cron、pipeline.ts、可选 tools.ts;编译成 `dist/`)由 hangar host 经 `HANGAR_APPS` 加载、按 cron 每天自动跑。
- 复用脊柱的 config / SQLite Run+RunEvent 状态 / cron / pipeline / trace;域**原语**(list/get/markRead/reflectPriority/notify/classify/rules)+ `executeActions` 编排(**去掉 durable enqueue**)当库搬入 app,由 `run(ctx)` 调用;审计经 `ctx.emit`。
- 旧 inbox-pilot 的分类质量与**已声明保留的**能力无退化;**每一项放弃的能力显式记账**。

**非目标:**
- `gmail.send` 与任何 approval 动作(→ Phase 2,届时走 `ctx.propose`)。
- 迁 durable `retryQueue` / `drainAccountRetries` / mail_actions 状态机(破 #3/#8);IMAP 游标状态机随之不搬(D5)。
- 一键降级 / 一键已读(需 v0 没有的入站回程,破 #6;→ Phase 3 webhook trigger)。
- 通用化 inbox 的 eval(留 app 内)。
- 改动 `@hangar/core` 的**能力/行为**(含给 gateway 加 typed-fatal/attempt#/handler-emit——那是 Phase 2 第二个 pilot 才co-justify 的脊柱演化,#2);**0.3 入口认 `<appDir>/dist/pipeline.js` + symlink 目录跟随的一处小脊柱改动除外**(加载机制、非能力,inbox-driven)。

## 决策

### D2 — 自动动作在 run() 内直接编排,不走 gateway(核心决策,已授权)
reflect_priority / mark_read / notify 由 `run(ctx)` 调用**搬入的 `executeActions`**(inbox 原编排,**剥掉 durable `recordAction`/`enqueueRetry`/`updateAction`**,保留内存有界重试 + BackoffBudget + 三值处理 + reauth 致命通道)。审计经 `ctx.emit`(run() 有 `emit`;domain 事件如 `reflect.ok/reflect.failed/notify.sent/notify.skipped/notify.failed` 进 `RunEvent.payload_json`)。
- **为什么**:见上下文事实 3。治理(重试/脱敏)本是**域逻辑**(#1 不进脊柱),inbox 早有更丰富实现;gateway 通用版保留给 propose'd(审批)动作。
- **⚠️ 契约冲突(R3-3,#9,必须先改 DESIGN)**:现 DESIGN §3.5(`propose` 是「唯一动作入口」、「没有 ctx.tools 直执行入口——那是绕过 approval 的后门,破 #5」,约 DESIGN:153/157)+ §3.6(「泛化 inbox 的 executeActions」,约 :160/165)+ `executor.ts:14-25` RunContext 注释,**当前禁止**本 pivot。故非「零 spine 规范修改」——是**一处小脊柱改动(0.3:入口认 `dist/pipeline.js` + symlink 跟随)+ 有据的 DESIGN 契约修订**。tasks 5.3 必须给 §3.5/§3.6/§4/§5 补一条 carve-out:「`propose` 是**受审批策略约束的动作**的入口;app 可在 run() 内直接做**本质无害的域副作用**;任何**可审批/高危**动作**必须**走 `propose`」——#5 由此仍成立(inbox 无高危动作)。#5 对直执行路径由**结构强制**降为**app 编写纪律**(记账,单用户 BYO 可接受);`executor.ts:14-18` 注释由 0.3 顺手改(指向 §3.5 carve-out;0.3 已开该文件、守零脊柱代码的理由失效)。
- **执行结果回传契约(R3-4,M-A)**:旧 `executeActions` 返回 `void`、把结果吞进 `updateAction`/`enqueueRetry`。pivot 下 run() 必须**学到**每动作结果(才能 emit 真事件)与 **notify 是否耗尽**(才能决定跳 markProcessed)。故 `executeActions` 须**重构**为返回 `{ reflect, markRead, notify: 'none'|'sent'|'skipped'|'failed', notifyExhausted: boolean }`(`'none'` = P1/P2/P3 不满足 `shouldNotifyNow`、未发;或注入 `emit` dep);run() 依 `notifyExhausted` 分支 markProcessed。`notifyExhausted` 虽可从 `notify==='failed'` 导出,保留为显式字段(R5 nit,可读)。这是**gut+restructure**(三 helper 都要改把结果 surface 出来),**非**「近原样 trim」。
- **per-email catch 作用域(R3-5,M-B)**:run() 的 per-email try/catch 只吞**良性**(classify 崩 / get-map-normalize)→ skip 该封 continue;`ProviderReauthRequired` / 终态 DB I/O **必须逃出**该 catch → **break 该账号本 run 邮件循环 + emit `account.suspended`**(否则把整个已撤销账号误当「skip 一封」;且 DB 挂掉的 run 在 trace 里与「没邮件可做」无从区分)。**但持久 `setAccountEnabled(false)` 只给硬 reauth**(`invalid_grant`/scope-403,不自愈)——终态 DB I/O 是瞬时故障、**只本 run suspend、不持久 disable**(否则一次 DB 抖动就把账号永久禁用需手动重授权);两者用 `account.suspended` 的 `reason` 区分:`reauth-required`(持久)/ `terminal-error`(仅本 run)。
- **溶解的东西**:handler 假绿审计、gateway 3× 猛打 reauth、无 attempt# 困境——两轮 review 的 B1/M1/M2 全消。动作独立性自然保住(`executeActions.ts:315`);reflect/mark_read 耗尽 → emit `*.failed` best-effort(记 tasks 5.2 降级)、不阻 notify;仅 notify 耗尽 → D3。

### D3 — 接缝 B:notify 耗尽走 coarse re-poll + 死信终态
仅 notify 发送态耗尽时 run() **跳过该封 markProcessed** → 下轮 cron re-poll 重跑该封。
- **load-bearing 不变量(唯一守护,R3 RC-F3 纠正)**:re-poll 靠该封仍 `is:unread`。`applySafetyRules.ts:226/230`:`shouldNotifyNow=P0∨P4`、`shouldMarkRead=(P2∨P3)∧¬guard` **优先级不相交 ⇒ 二者对同一封永不同真**,故 notify 封永不被 mark_read 清 unread。这条不变量是 seam B **唯一**守护——显式记账 + self-check 断言 + **禁止将来放松**。(动作顺序 reflect→notify→mark_read 采用是为可读性;**不**声称它是「不变量放松时的 fallback」——若真同真,mark_read 仍在同批 notify 后跑清 unread,重排救不了;之前的 defense-in-depth 说法作废。)
- **死信终态(M6 + R3-1e,修「无界重发」·覆盖所有**已落库**成因)**:旧 durable drain 有终态(`MAX_DURABLE_ATTEMPTS=6` / notify `NOTIFY_STALENESS_MS` → `dead_letter` → 停)。coarse re-poll 补等价终态。方案(懒,非 queue):`mail_messages` 加**一列** re-poll 计数;**在重跑一封已存-未处理封的最开头**评估门 `计数≥K 或 receivedAt 超 staleness` → `email.dead_letter`(payload 带**终态原因** `max-attempts`/`stale`——门在入口、当轮失败因未知,计数列也不留 per-tick 因;cause-neutral kind 已够防「谎标 notify」)+ `markProcessed`、跳过本封;否则 +1 再跑。门在**入口**评估 ⇒ 封顶**所有已落库**成因:notify 耗尽 / **saveEmail 之后**的 timeout / classify 崩。
- **⚠️ 落库前失败不被此门封顶(R5 Codex,claim 收窄)**:`saveEmail` 在 `processEmail` 内、`messages.get`/map/normalize **之后**(`processEmail.ts:81-86`)。故**落库前**反复失败(坏 MIME normalize 抛 / pre-save timeout)**无行、无计数、无终态**——每 tick 被 `is:unread` 重取、再 skip。此与旧 Gmail 行为**同级**(无游标、每轮全量 `is:unread`),每 tick 成本仅 1×get(无 classify/notify),故记为**已接受降级**(tasks 5.2);仅当实测持续刷屏才加一个 `(accountId,providerMessageId)` intake 计数 + 终态(另立、住 app)。**不再声称门覆盖「良性 fetch 失败」。** 计数读/增须新增 repo accessor(连 `getClassification` 一并加)。
- **成本(诚实记账)**:notify 持续失败下,终态前每 tick 重跑 = 1×get + 1×reflect + ≤3×notify;`classify` 由 D4 复用消除。≤1 重复推送是**每 tick**、被终态封顶 K tick。
- **P0 时效(R3 RC-F4)**:旧 durable drain 亚分钟重试;换 cron re-poll 后一次瞬时 telegram 失败把 P0 推送推迟一个 cron 周期。P0 = 验证码**会过期**。故 Phase 1 cron **须亚小时**(或显式接受「P0 在瞬时失败下可能迟到/失效」并喂给 tasks 6.1 阈值决策)。
- **第二前提(m3 记账)**:re-poll 是 `is:unread`-gated,旧 durable drain 不依赖读态。若用户在失败窗口内于 Gmail 直接读了该封 → `is:unread` 不再返回 → 该次 notify 不再补(多为良性:用户已看到)。这是 no-loss 的**第二个**、旧模型不需要的前提,与 ⊥ 不变量并列披露。

### D4 — markProcessed 落点 + re-poll 复用分类(需新增读路径)
markProcessed 每封所有动作之后、仅当无 notify 耗尽(D3)。dedup(`findByDedupKey`)+ 幂等原语保重跑安全。
- **精确措辞(n1)**:reflect/mark_read 幂等;notify 非幂等,re-poll 重发 = at-least-once,≤1 重复**每 tick**、被死信终态封顶。真实 dup 窗口是「notify 已发 → markProcessed 前崩」,**非**「mark_read 后 notify」(二者不相交,mark_read 从不在 notify 封上跑)。
- **复用分类(m1 + R3 minors)**:re-poll 重跑复用已持久化分类跳过 LLM。`MailRepo` **无 `getClassification` 读回**(仅 `saveClassification` 写)——须新增 `getClassification(messageRowId)`,且**必须复用**既有 `parseFinalDecisionBlock`/`rebuildFinalDecision`(`mailRepo.ts:494-590`)重建 `FinalDecision`(**不写第二个 rawAiJson 解码器**)、沿用既有**最新行排序**(`createdAt desc, id desc`)、定义 no-row/malformed 行为(→ 当无分类、重 LLM)。区分:classify 崩(无分类)→ 重 LLM;notify 耗尽(有分类)→ 复用。**复用路径必须跳过 `saveClassification`**(它是 append-only `create`,`mailRepo.ts:795`;否则 K tick 追加 K 条重复分类行,m-5)。

### D5 — 取信接缝:薄原语搬入,poller 编排在 run() 内重组(含两级读错误 + 成本上界)
`providers/*` 非薄适配器:pollers `import`+调 `drainAccountRetries`、IMAP poller 拥有游标状态机——整包搬会拖入 durable + 游标。切清:
- (a) **薄 provider 原语**(messages.list/get、markRead、reflectPriority、notify)当库搬入;
- (b) **poller 编排**在 run() 重组、**不调** `drainAccountRetries`,且**必须复刻**:
  - **两级读错误模型(M3)**:list/get 上——`429/配额` → **结束本轮**(不逐封 skip 继续翻页加剧限流);`401 / scope-403(insufficientPermissions) / invalid_grant(400)` → 结束本轮 + **suspend 账号**(见下 reauth 持久化);`瞬时 403(rate/quota)` → 结束本轮不 suspend;良性 get/map/normalize 失败 → 逐封 skip+continue。(旧 gmailPoller.ts:120-187 的分层,读侧不经动作路径,必须在 run() fetch 循环内复刻。)**读侧终态由 run() 捕获、按账号结束本轮后 run 仍走 `completed`**(R3 RC-F6)——`run.failed` 只留给真故障;否则例行 429 会把每个 run 标 failed、污染 trace 历史,且与「结束该账号、继续其他账号」意图冲突(单账号 skeleton 下 moot,但契约要写清)。
  - **成本上界(M4)**:`processFrom`/`after:<epoch>` 水位下界 + get-budget ≤200(`slice(0,budget)`)。二者是 load-bearing 成本上界(否则大量 unread 积压——P0/P4/P1 从不标已读——每 tick 穷尽翻页 + 无 classify/get 上限 → LLM/API 爆发 + 长 run 占 active-lock)。记为**已声明保留、随编排重组**(不在放弃清单)。
  - **reauth suspend 分两级(R3-2,修 invalid_grant 每 tick 猛打)**:旧模型是 **per-process 闭包 guard + 持久 `setAccountEnabled(false)`** 二者兼有(`scheduler.ts` + `mailRepo.ts:718`),持久那半正是为「`invalid_grant` 不会自愈,绝不每 tick 徒劳打 Google token 端点」。故本设计:**硬 reauth(`invalid_grant` / scope-403)→ 持久 `setAccountEnabled(false)`**(既有方法、survives trim、inbox 自有;**clear-path 是既有的**——用户重授权 `updateGmailTokens`+`setAccountEnabled(true)` 自动重纳入 `listEnabledAccounts`);**per-run 内存 suspend set 只做本 run 内跳过该账号剩余邮件**。之前「per-run 匹配旧 per-cycle / 下 run 自然恢复 / 无 clear-path 问题 / pure win」的说法**作废**(旧非 per-cycle、`invalid_grant` 无自愈)。残留降级(硬 reauth 前该账号本 run 命中一次 token 端点)记 tasks 5.2。
- (c) **IMAP 游标状态机**:skeleton 只 Gmail(无游标),IMAP 增量轮游标**显式留后续**(此前 IMAP 取回已读封的保证 skeleton 不承诺,记 open question)。

### D6 — 文档记账(修正 loci,M7 + R3-3 契约 carve-out)
Phase 1 验证「脊柱当 daily-driver」,**不**验证「approval 当 daily-used」**也不验证 gateway 通用动作执行**(自动动作已改走 run());approval + gateway 通用动作执行(尤指 `propose` **低危立即执行分支** `gateway.ts:163-174`——inbox 不用、纯审批的 Phase-2 pilot 也走 approve 分支,故可能零 pilot 需求,#2 待 Phase 2 证或砍)的真 forcing function 是 Phase 2。文档改:
- **契约 carve-out(R3-3,#9,先改 DESIGN)**:`DESIGN.md §3.5`(约 :153/157「propose 唯一动作入口 / 无直执行入口」)+ `§3.6`(约 :160/165「泛化 executeActions / 低危→gateway execute」)+ `§4`(gateway bullet「泛化 inbox execute 内存重试+redact」)**必须**加 carve-out(见 D2):propose = 受审批约束动作的入口;app 可在 run() 直接做本质无害域副作用;可审批/高危**必须** propose。同步:proposal 的「零 spine 规范修改」措辞改为「**一处小脊柱改动(0.3:入口认 `dist/pipeline.js` + symlink 跟随)**;DESIGN 契约文本有据修订(#9)」;`executor.ts:14-18` RunContext 注释由 0.3 顺手改(指向 §3.5 carve-out;守零脊柱代码的理由失效)。
- **两处**(非三处)「发送邮件走 hangar approve」判据 →「若存在高危动作则走 approve」:① `ROADMAP.md:31`;② `DESIGN §5` 迁移完成判据行。(grep 确认无第三处;旧 D6 的 ②③ 重复计数。已由 0.2/Fix-A 落地。)
- **`ROADMAP.md:32`「能力无退化」** → 改为枚举已接受降级(durable drain / action-level durable / 退避粒度 / reflect·mark_read best-effort / gateway 通用动作执行不被 inbox 使用),不再笼统称「无退化」。
- **`ROADMAP.md:40-42`「必须在每天用前补齐多进程仲裁」** → 与 R5 对齐:approve-vs-approve/reject/granting-lease(①)**因本变更移除 approval 路径而 moot** → 路由 Phase 2;reap-vs-concurrent-run(②)对 inbox 单 daemon 用法由 reaper + busy_timeout + active-lock 覆盖 → 标记已接受降级。

### D7 — 每 email 超时 + 每 run 兜底(修 live-hung 楔死,M5 + R3-1 机制正确性)
`runApp` await `executor.run(ctx)` 无墙钟上界(executor.ts:101);reaper 只回收**崩溃**(pid:startTime),**不**回收 live-but-hung。run() **必须**自持超时,但**裸 `Promise.race` 不够**(R3 三家共识):
- **per-email 主超时 + per-run 兜底(R5 SA/RC minor)**:超时锁到 **per-email**(避免 per-run + 最旧优先让一封 hung-poison 最旧邮件每 tick 吃掉整 run、饿死更新邮件的 head-of-line)。per-email 值按**一封实际工作**量级(数十秒,**非**旧 `DEFAULT_POLL_TIMEOUT_MS`=5min——那是**每轮**预算),否则 200×5min≈16h 单 run 占锁。**另加一个结束本轮的 per-run 墙钟兜底**(剩余邮件 → re-poll,受死信门封顶):因 per-email 已封住单封,per-run 兜底**不**重引入 head-of-line,只封住病态累积。
- **取消是 best-effort,真兜底是 fence+吞诺(R5 CR/RC minor,纠正)**:底层调用挂 `AbortController`/client timeout **尽量**中止 hung 调用(googleapis 的 AbortSignal 是 best-effort、不保证毁 socket,见 `scheduler.ts:201`;notifier/provider 原语签名须加 `signal` 参)。但**anti-wedge 保证不靠取消**,靠下面两条。
- **弃诺必吞拒绝**:被弃 promise **稍后 reject 无 handler → `unhandledRejection` → Node 默认杀 daemon**(楔死借另一门重现)。被弃分支**必须**挂吞拒绝 `.catch`(`void p.then(()=>{},()=>{})`,`scheduler.ts:164`)。
- **超时后 fence 副作用**:释放锁前**禁止**再对该封 `ctx.emit`/`markProcessed`/发副作用(晚到调用会写已完成的 run / 多发一次 notify)——**per-email 作用域**的 aborted 标志(每封新建,非 run 级)在每个副作用前 fence。
- self-check(tasks 4.4)须断言超时后**无 `unhandledRejection`**、锁被释放、**且被弃调用晚到 resolve 时不 emit/不 markProcessed**(fence 对 resolve 也成立,R5 RC-F2)。app 侧、零脊柱。

### D8 — in-process pilot 模块加载契约(顶层禁 process.exit/throw,M2)
脊柱 daemon 经 `import()` **in-process** 加载 pilot 编译产物;pilot 代码在**模块顶层**(import 时)执行的 `process.exit` 或 throw 会**在加载即杀死整个 daemon**——绕过 D7 的 fence/reaper(那是 per-run 保护,拦不住 load-time 自杀),且不是「一个 run 崩」而是「daemon 崩」。
- **契约**:pilot 模块顶层**禁** `process.exit`、**禁** throw;所有 env/config 校验与致命处理必须移入 `run(ctx)`(throw → `run.failed`,受 choke-point + reaper 覆盖)。
- **inbox 具体**:`src/config/config.ts` 现在 import 时对坏 env 调 `process.exit(1)`——须改:把该 exit **门控在 is-entrypoint 判断之后**(`require.main`/`import.meta` 门),或让 `run(ctx)` 开头校验 config 并 **throw**(→ `run.failed`)而非 exit。skeleton 加一条 config 改造任务(tasks 1.6)。

## 风险 / 权衡

- **[R1] notify 失败触发整封重跑。** → D4 复用分类消 LLM 重花;D3 死信终态封顶重发次数;≤1 重复/tick 与旧 spec 已接受同级(旧亦有终态,现补齐)。
- **[R2] 一封坏邮件拖垮整批 run。** → per-email try/catch(classify/fetch 错误);per-action 独立(动作错误)。
- **[R3] Phase 1 不触发 approval 也不用 gateway 动作执行 → 脊柱这两块在真实 pilot 上「未被使用」直到 Phase 2。** → 接受并显式命名(D6):Phase 1 验证脊柱的 config/调度/状态/trace 当 daily-driver;approval + gateway 动作执行由 heartbeat(Phase 0)覆盖,Phase 2 pilot #2 才是真体检。**这是诚实的 thesis 信号**——inbox 的动作执行域特化到通用 gateway 不服务它(#2 的真实体检:gateway 通用动作执行是否 earn 其位,待 Phase 2 定)。
- **[R4] better-sqlite3(原生)与 prisma 共存。** → skeleton 首验(tasks 1.3)。
- **[R5] 多进程 SQLite 仲裁(DESIGN §3.6 延后)。** → inbox 上线是命名触发点;approval 仲裁 moot(无 approval),reap-vs-run 由 reaper+busy_timeout+active-lock 覆盖(tasks 4.3 验证)。
- **[R6] 迁 executeActions 时误带 durable。** → 明确**gut+restructure**(D2 R3-4):剥 `recordAction/enqueueRetry/updateAction` + 把结果 surface 成返回值;mailRepo trim durable 方法(含 `selectDueRetries`/`DueRetryAction`/`RebuildResult` 死代码,tasks 1.2)。
- **[R7] 跨库非原子(SQLite 审计 emit vs Postgres processedAt/计数,R3 RC-F5)。** → 缓解:**emit(SQLite 审计)在前 → Postgres(processedAt/计数)最后写、以 Postgres 为准**。故崩在二者之间的最坏情形是**多一条审计行 + ≤1 多发/多一轮 exhaust**(非缺终态)——审计行冗余无害、重发受死信门 K 封顶(R5 CR 纠正:Postgres-last ⇒ 重复而非缺失审计行)。
- **[R8] `ctx.emit` 不脱敏(R3 CR-m3)。** → gateway 的自动 redact 只覆盖 propose'd 动作;inbox 直接 emit 须在 app 侧**先过 inbox `redactError`+截断**再 emit;self-check 断言 emit payload 不含地址/token/正文。emit payload 须带**非 PII** 的 `messageRowId`/`providerMessageId` 以便 trace 按封归因(R3 SA-m2)。notify done 的 `emit('notify.sent')` 须**在重试 try 之外**(保「每调用至多一条」非幂等 notify 不因落库失败重发,R3 SA-m1)。
- **[R9] `HANGAR_APPS` 解析漂移(M3)。** → daemon 与所有 CLI 入口**必须共享同一 `HANGAR_APPS`**(与共享 SQLite 并列——否则 CLI `hangar run inbox` 与 daemon 各自解析到不同 apps 根,一个找得到 pilot 另一个找不到)。缓解:`hangar doctor` 回显解析到的 `HANGAR_APPS`/`HANGAR_DB`(tasks 5.1)。
- **[R10] 本地 `RunContext` 是运行时鸭子契约,编译绿 ≠ 版本兼容(M6)。** → 外部 pilot 用本地结构化 `RunContext` type,`tsc` 绿只证本地自洽、**不**证与脊柱运行时传入的 ctx 版本兼容;脊柱 `RunContext` 改动后**须重编译外部 pilot**。缓解(fail-loud,tasks 1.5):`run()` 开头断言收到的 `ctx` 具备 `emit`/`config`/`input`/`logger`(run() 实际用到的字段;`propose` 留 Phase 2 approval 动作接入时再断言——现断言它会在脊柱 Phase 2 重塑/移除 propose 时误拒合法 ctx),缺则 throw 明确错误(而非晚点 `undefined is not a function`)。

## 迁移计划

1. **Walking skeleton(单进程手动,先只 Gmail 单账号)**:classify→notify 最小闭环,run() 内直接编排(port executeActions 减 durable),`hangar run inbox` 手动跑通,验双库并存 + run(ctx) 契合 + trace(ctx.emit 域事件)完整。
2. **接缝 B + 终态**:notify 耗尽→跳 markProcessed→re-poll(复用分类);死信计数列→K tick 终态;reflect/mark_read 耗尽→emit failed、不阻 notify。
3. **fetch 编排**:两级读错误(429→结束本轮、硬 reauth→结束本轮+持久 `setAccountEnabled(false)`、良性→skip;读侧终态 run 仍 completed)+ processFrom + get-budget;per-run 内存 set 仅本 run 内跳过该账号。
4. **补齐动作 + 顺序 + 超时**:reflect_priority、mark_read;顺序 reflect→notify→mark_read(仅可读性);**per-email** 超时 + 真取消(`AbortController`)+ 吞拒绝 `.catch` + 超时后 fence 副作用。
5. **上 cron**:app.yaml cron;`hangar daemon` 用户自起;daemon 优雅跳过 active-lock 拒绝的 tick。
6. **量失败率 + 连续 7 天每天用** → 过 Phase 1 出口闸;不达 → ROADMAP ⛔ 止损。
回滚:inbox-pilot 就地改 → 打一个 pre-migration tag/branch,回滚 = inbox-pilot `git checkout <tag>` + 从 `HANGAR_APPS` 摘除(或停 cron),旧 standalone inbox-pilot 照跑;脊柱那处小改(认 `.js`)对旧路径无害、可留。

## 待解问题

- **IMAP 游标 / 增量轮**是否进 Phase 1(D5 先 Gmail;IMAP 取回已读封 skeleton 不承诺)。
- **死信 K / staleness 阈值**取值(参照旧 `MAX_DURABLE_ATTEMPTS=6` / `NOTIFY_STALENESS_MS`)——skeleton 后按真实失败率定。
- **reauth 后 un-suspend(已定,见 D5)**:硬 reauth 持久 `setAccountEnabled(false)`,clear-path 是既有的重授权 `updateGmailTokens`+`setAccountEnabled(true)` → `listEnabledAccounts` 自动重纳入;per-run 内存 set 仅本 run 内跳过。
- **批大小 / poll 窗口 ↔ cron 频率**;频率需**亚小时**(D3 P0 时效)且知「notify 耗尽 → 推迟一个 cron 周期发」。
- **app 事件 kind 不得撞 `STATE_BY_KIND`**(`events.ts:47-56`)否则 `classify()` 误移生命周期状态 / `appendEvent` 遇终态 kind 抛;所选 `notify.*/reflect.*/mark_read.*/account.suspended/email.dead_letter` 安全,app 内留一行守卫注释或 3 行 self-check 导入 `STATE_BY_KIND` 断言不撞(R3 CR-n1)。
- **digest(P5)是否属 Phase 1**——倾向否。
