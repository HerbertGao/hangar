## 0. #9 前置(架构先行,先于任何 pilot 代码)

- [x] 0.1 **pivot carve-out**:`DESIGN §3.5/§3.6/§4`(gateway bullet)加「`propose` = 受审批约束动作入口;app 可在 run() 直接做本质无害域副作用;可审批/高危必须 propose」;#5 对直执行路径由结构强制降为 app 编写纪律;`executor.ts:14-18` 注释记 stale-debt;spec/proposal 措辞同步。
- [x] 0.2 **外部-pilot 治理改写**(B 拓扑,#9):`DESIGN §3.1/§3.2/§4(IN+OUT)/§5/§6` + `CLAUDE #4/目录/CC` + `ROADMAP Phase1/2/非路线图` —— apps 根可配(`HANGAR_APPS`)、pilot 为外部独立 repo checkout、in-process 加载**编译产物**、`app.yaml` 唯一入口;loader 子系统留 Phase 2、marketplace 永不;filesystem-external ≠ process-external。
- [x] 0.3 **编译-pilot 脊柱小改**(本变更唯一 `@hangar/core` 代码改动):**三处**入口解析改为 `<appDir>/dist/pipeline.js` 优先、回退 `<appDir>/pipeline.ts`(扁平,仓内 dev 用):① `executor.ts:47`(import)② `executor.ts:79`(runApp 预检 existsSync)③ `registry.ts:129`(checkPipeline/doctor)。**同时**在 `registry.ts` 让 `loadApps` 跟随符号链接目录(改 `Dirent.isDirectory()` → 跟随解析的 `statSync(join(dir,name)).isDirectory()`——否则 symlink pilot 被跳过);此 symlink 支持**必需**(inbox 的 checkout 名为 `inbox-pilot`≠id `inbox`,只能靠命名 `inbox` 的 symlink 注册)。**⚠️ `statSync` 会对悬空 symlink 抛 `ENOENT`**(`Dirent.isDirectory()` 不抛)——故**每条目 `statSync` 必须包 try/catch**:解析失败/悬空 → **跳过并记一个 app 错误(如 `app_unresolved`)、绝不让 `loadApps` 抛**(否则 status/run/approve/daemon 全崩,且 `doctor` 在它该报告的失败上自盲、连健康 app 也列不出)。**顺手**在同一改动里:修 `executor.ts:14-18` stale RunContext 注释 → 指向 §3.5 carve-out;修 `registry.ts:128` 反了的 ponytail 注释(现 `.js` 优先);修 `executor.ts:50` error string(仍写 `pipeline.ts`)。仅 pipeline 入口(inbox-driven);gateway 的 `tools.ts` loader 认 `dist/tools.js` 留 **Phase 2**(inbox 无 tools)。self-check:①编译的仓外 pilot(dist/pipeline.js + symlink)被 loadApps/runApp/doctor 一致加载;②悬空 symlink → doctor 报 `app_unresolved`、不崩、仍列出其它 app;③仓内 heartbeat(扁平 pipeline.ts、无 dist/)仍回退加载。

## 1. Walking skeleton(inbox-pilot **仓内就地**,Gmail 单账号 classify→notify)

> B:inbox-pilot 留在自己仓、就地改;**不拷贝进 hangar**。半成品 `hangar/apps/inbox/`(A 方案拷贝)**作废**——`pipeline.ts` 草稿作模板搬到 inbox-pilot 根后删除整个 `apps/inbox/`。

- [x] 1.1 inbox-pilot **仓根**加 `app.yaml`(`executor: pipeline`、cron、**无 `permissions.approval`**、无 `tools`);entry 放 **`src/pipeline.ts`**(编译成 `dist/pipeline.js`)——`run(ctx)`,notify-only 骨架,`import` 解析到真 `./src`;`RunContext` 用**本地结构化 type**(ctx 运行时鸭子类型;或 `@hangar/core` types-only 依赖,契约易漂移时升级)
- [x] 1.2 抽 `src/providers/gmail/gmailMap.ts`(从 `gmailPoller.ts:274-431` 抽 `toRawEmail`/映射,不带 `gmailPoll`/drain);就地 **gut** `executeActions`(剥 durable `recordAction/enqueueRetry/updateAction`,保内存重试+BackoffBudget+三值+reauth 致命,**去 `repo`/`messageRowId` 参**,**返回 `{reflect,markRead,notify:NotifyOutcome,notifyExhausted}`**);`mailRepo` 就地**加** `getClassification`〔复用既有 `rebuildFinalDecision`/`parseFinalDecisionBlock` + 最新行排序 + no-row/malformed〕+ repoll 计数 accessor、**trim** durable 方法(`inMemoryMailRepo` 同步接口);`retryQueue`/`drainAccountRetries`/IMAP 游标不搬;**DELETE(非退役/dormant)**引用被 trim 的 durable 方法 / 旧 `executeActions` 签名的整批文件 **及其 `*.test.ts`**——`src/actions/retryQueue.ts`、`src/providers/gmail/gmailPoller.ts`、`src/providers/imap/imapPoller.ts`、`src/pipeline/processEmail.ts`、`src/main.ts`、`src/jobs/scheduler.ts`(`tsc` `include:src/**` 编译整树→留着即 typecheck 失败→无 `dist/pipeline.js`);`MailAction` **表**留 dormant(不删)——「dormant 不删」仅指 **prisma 表**,绝不指 `.ts` 代码文件。**另**:引用被删模块/被 trim 符号的**存活文件上的** `*.test.ts` 须删/改——**具体**:`notify/notifier.test.ts`(import `toRawEmail`,须**重指到** `gmailMap.js`)、`providers/imap/imapActions.test.ts`(import 已删的 `processEmail`)、`executeActions.test.ts`、`repo/watermark.test.ts`(getCursor/setCursor)等。注:`tsc`(`include` 排除 `*.test.ts`)**不因测试**断 build——断 build 的是**源文件**上条(retryQueue 等,在 `include:src/**` 内引用被 trim 符号);测试只挂 `pnpm test`。抽 `gmailMap.ts`(带 `HEADER_WHITELIST` + 从存活 `gmailClient.ts` import 类型)**先于**删 `gmailPoller.ts`
- [x] 1.3 【done：已在生产 `mail_router` 的隔离拷贝上 apply+验证（additive `ALTER TABLE ... ADD COLUMN "repollCount" INTEGER NOT NULL DEFAULT 0`，prisma client 已 regenerate）；对**生产库**的 `prisma migrate deploy` 随 §5.1 部署一并做】inbox-pilot **自己的** `prisma migrate` 加 `repollCount Int @default(0)` 列(inbox 独占自己的库,**无共库/双 schema 问题**)
- [x] 1.4 编译 + 注册:inbox-pilot `pnpm build`(tsc)→`dist/pipeline.js`;注册 = `ln -s <inbox-pilot> <appsRoot>/inbox`(symlink 命名 `inbox`,满足 `id===目录名`;须 0.3 symlink 支持);`hangar doctor` 认 `dist/pipeline.js` 判定合法(只验存在+解析、报告解析到 `.js` 还是 `.ts`;声明为编译 pilot 但缺 `dist/pipeline.js`/只有 `.ts` = `pipeline_missing`,不静默回退 `.ts` 再运行时崩)
- [x] 1.5 【done：对生产 `mail_router` 的**隔离拷贝**(本机 pg 5544,生产库零触碰)跑通全链路——2 个重授权 Gmail 账号(heapcn + hbtgao,gmail.modify)OAuth 非交互认证、`is:unread after:` 抓取+分页+去重、**47 封真邮件 LLM 分类**、markProcessed 写库、`hangar run inbox`→`completed`;notify 全链路用一封**主题含验证码**的邮件(applySafetyRules 确定性强制 P0)验证:`hangar trace` 见 `run.started → notify.sent{providerMessageId} → run.completed`、**真收到 Telegram 推送**;hangar sqlite + inbox PG 单进程并存无冲突】端到端(**你的 live 环境**:inbox PG + Gmail OAuth + Telegram):`hangar run inbox` → run `completed`;`hangar trace <run>` 见 `started →(notify.* 真实域事件)→ completed`、真收到一条推送;两库(hangar sqlite + inbox PG)单进程并存无冲突(tasks 1.3 剩下的唯一"并存"检查);`run()` 开头 **fail-loud** 断言收到的 `ctx` 具备 `emit`/`config`/`input`/`logger`(run() 实际用到的;`propose` 留 Phase 2 approval 动作再断言),缺则 throw 明确错误(M6,本地 `RunContext` 是运行时鸭子契约、编译绿 ≠ 版本兼容)
- [x] 1.6 **config 加载安全**(M2,in-process 模块契约):`src/config/config.ts` 现 `export const config = loadConfig()` 在 import 时对坏 env `process.exit(1)`——daemon `import()` 加载 pilot 即被杀(绕过 D7 fence/reaper、非单 run 崩)。**改法:让 config 加载惰性/不在模块顶层 exit,由 `run(ctx)` 开头校验并 `throw`(→ `run.failed`,受 choke-point+reaper 覆盖)**——**不用** "is-entrypoint 门控 exit"(对模块级 `const config=loadConfig()` 无效:hangar 加载时 loadConfig 照跑,config 反而未校验)。pilot 模块顶层禁 `process.exit`/throw

## 2. 接缝 B(notify 耗尽 re-poll)+ 死信终态 + 动作独立

- [x] 2.1 per-email try/catch **作用域纪律**:只吞良性(classify 崩 / get-map-normalize)→ skip 该封 continue;`ProviderReauthRequired`/终态 DB I/O **逃出**该 catch → 账号级处理(3.3)。per-action 独立:reflect/mark_read 耗尽 → `ctx.emit('reflect.failed'/'mark_read.failed')`(不阻 notify);仅 notify 耗尽 → 跳该封 markProcessed。emit 前先 inbox 域脱敏+截断,payload 带非 PII `messageRowId`;`notify.sent` emit 在重试 try 之外
- [x] 2.2 复用分类:re-poll 命中未处理封且 `getClassification` 有值 → 跳过 LLM **且跳过 `saveClassification`**(append-only,否则每 tick 追加重复行)、直接重跑动作(classify 崩无分类 → 重 LLM)
- [x] 2.3 死信终态(覆盖所有**已落库**成因):**在重跑一封已存-未处理封的最开头**评估门 `re-poll 计数≥K 或 receivedAt 超 staleness` → `markProcessed` + `ctx.emit('email.dead_letter', {reason:'max-attempts'|'stale'})`、跳过本封;否则 +1 再跑。门在入口 ⇒ notify 耗尽 / saveEmail 后 timeout / classify 崩 皆封顶;**落库前失败**(坏 MIME / pre-save timeout,无行)不封顶——每 tick 重取+skip(1×get,记降级 5.2)
- [x] 2.4 self-check(小 `*.test.ts`,**非空断言**:spy 真实 `classify` seam 调用数 / 读真实 emit 的 `RunEvent`,禁 stub `executeActions`/`emit`):(a)批 3 封第 2 封 notify 耗尽 → run `completed`、第 2 封无 `processedAt`、re-poll `classify` 调用数=0;(b)notify `skipped` → 不重试、markProcessed 照常;(c)reflect 耗尽 → notify 仍被调 且 trace 有真实 `reflect.failed`(非 `action.executed` 假绿);(d)re-poll 计数达 K → dead_letter + markProcessed 停发;(e)emit payload 无地址/token/正文

## 3. fetch 编排(两级读错误 + 成本上界)+ reauth

- [x] 3.1 run() 内 fetch 循环复刻**两级读错误**:`429/配额`→结束本轮;`401/scope-403/invalid_grant`→结束本轮+suspend;瞬时 `403`→结束本轮不 suspend;良性→逐封 skip continue(self-check:注入 429 断言结束本轮不继续翻页)
- [x] 3.2 成本上界:保留 `processFrom`/`after:` 水位下界 + get-budget ≤200
- [x] 3.3 reauth 分两级:硬 reauth(`invalid_grant`/scope-403)→ **持久 `setAccountEnabled(false)`**(clear-path=既有重授权流);本 run 内存 suspend set 仅本 run 内 break 该账号邮件循环;不重试;`ctx.emit('account.suspended')`(self-check:注入 reauth 断言单次命中不 3× 重试、账号被持久 disable、`listEnabledAccounts` 不再返回它)

## 4. 补齐动作 + 顺序 + 超时

- [x] 4.1 reflect_priority(始终、幂等)+ mark_read(仅 `shouldMarkRead`、幂等)接入 `executeActions`
- [x] 4.2 动作顺序 reflect_priority → notify → mark_read(仅可读性;**不**声称是不变量放松时的 fallback——重排救不了同真);真实 ≤1 dup 窗口是 notify 已发→markProcessed 前崩
- [x] 4.3 不变量 self-check:断言无优先级同时 `shouldNotifyNow ∧ shouldMarkRead`——**跑真实 `applySafetyRules` 遍历优先级**(非复述 `{P0,P4}∩{P2,P3}=∅`,那是空断言);若动作派生将来引入非优先级输入,断言须覆盖真实 `email→decision` 面
- [x] 4.4 超时:**per-email 主超时**(单封实际工作量级、数十秒,非旧每轮 5min;防最旧邮件 head-of-line 饿死)+ **per-run 结束本轮兜底**(剩余邮件 → re-poll、受死信门封顶);底层调用挂 `AbortController`/client timeout **尽力**取消(best-effort);被弃分支挂吞拒绝 `.catch`(`scheduler.ts:164`);超时后 **per-email 作用域** aborted 标志 fence 掉后续 `emit`/`markProcessed`(self-check:注入 hung 调用断言超时放弃、锁释放、**无 `unhandledRejection`**、**晚到 resolve 不 emit/不 markProcessed**)

## 5. 上 cron 部署 + 文档记账

- [ ] 5.1 `app.yaml` cron(timezone `Asia/Shanghai`,**亚小时**——P0 验证码会过期,见 design D3 P0 时效);`hangar daemon` 用户自起、优雅跳过 active-lock 拒绝的 tick;验证 daemon-run + 并发 CLI read 在 SQLite `busy_timeout` 内(reap-vs-run 边界,R5);**daemon 与所有 CLI 入口共享同一 `HANGAR_APPS`**(与共享 SQLite 并列,M3——否则 CLI 与 daemon 解析到不同 apps 根)、`hangar doctor` 回显解析到的 `HANGAR_APPS`/`HANGAR_DB`
- [ ] 5.2 旧能力对照:分类质量对照;**放弃的能力逐条记为已接受降级**(durable drain / action-level durable / 退避粒度 / reflect·mark_read best-effort / gateway 通用动作执行不被 inbox 使用),不笼统称「无退化」
  - **review 补记的 Phase-1 已接受降级**(对抗性 review 发现,一并记账):
    - list 尾页瞬时失败 → 结束本轮、下 tick 重取(Phase 1 unread<100 = 单页无翻页触发,故当下无缺失;月级视野是 P0 时效债)
    - 最旧优先 × get-budget:notify 持续故障下最新 P0 被最旧积压推后(→ §6.1 调参:budget/窗口/频率)
    - `processFrom` 是静态下界、从不推进(Gmail 无游标、与旧行为同级;unread 集随月增长)
    - 落库前(get/normalize)失败每 tick 重取-skip、无死信/无审计(design 明确接受;成本仅 1×get)
    - 瞬时 DB 写抖动中止该账号本轮、下 tick 自愈(Phase 1 无有界写重试)
    - 无 telegram 渠道的 P0 → `notify.skipped` + markProcessed(零投递、但如实审计;Phase 1 已配 telegram)
    - **(r2)** list+dedup 前导若大到耗尽 per-run 墙钟,该 tick 零处理(dedup deadline break 后 email 循环即因同一 deadline return);Phase 1 unread<数百→dedup 瞬时不触发,wedge 本身已由 M1a `statement_timeout` 关闭;真正修法=有界交织 list+dedup+process 前导,留后续
    - **(r2)** 死信门在 get 前 `incrementRepollCount`,故重跑封的 get 遇读侧 outage(429/5xx)也消耗死信预算 → 持续读 outage K tick 可死信一封未投递 P0;cause-neutral 门有意如此(K sub-hourly tick≈数小时,P0 码早过期;staleness 兜底)
    - **(r2)** get-5xx 归 benign 逐封 skip(非 end-round,防单封 poison 饿死整轮):Gmail-wide 5xx outage 下 ≤GET_BUDGET get/tick(有界、罕见)是较小恶
    - **(r2)** `withStatementTimeout` 的 URL 附加对「凭据/库名含 `?`」或「已带 `options=` 参」的 DATABASE_URL 不支持合并(realistic URL 罕见;命中则手动设 statement_timeout)
    - **(r2, nit)** notify 恰在 per-email 超时同刻返回 'sent' → fence 挡掉 `notify.sent` emit、下 tick 重发 → trace 少记一条已投递(accepted at-least-once,D4/D7)
- [ ] 5.3 文档修正(M7,承接 0.1/0.2;按**内容**定位——0.2 追加已让行号漂移):`ROADMAP` Phase 1 DoD + `DESIGN §5` 两处「发送邮件走 approve」→「若存在高危动作则…」;**`ROADMAP` Phase 1 目标行尾部** pivot 前旧话(「需人确认的动作走 `ctx.propose`、实际执行体放 `apps/inbox/tools.ts` handler」)→ 清理为「自动动作在 `run()` 内直接编排、不经 gateway」;`ROADMAP`「能力无退化」→ 枚举降级(durable drain / action-level durable / 退避粒度 / reflect·mark_read best-effort / gateway 通用动作执行不被 inbox 用 / 硬 reauth 前该账号本 run 命中一次 token 端点 / **落库前失败每 tick 重取-skip** / **notify 耗尽再送与新邮件共用 is:unread+get-budget 车道**);`ROADMAP` 多进程仲裁段 approval 仲裁 → Phase 2、reap-vs-run → 已接受降级;**`ROADMAP` Phase 1「延后到此」的 approval 债项(gmail exactly-once / 审批后域回写落点,现引 `apps/inbox/tools.ts`)→ 重框为 Phase-2-gated**(pivot 已移除 Phase 1 全部 approval,这些项对 Phase 1 moot);`DESIGN §5` executeActions→gateway 备注精修;approval 债显式列 Phase 2

## 6. 出口闸

- [ ] 6.1 量 notify 真实失败率(观测数天)→ 定死信 K/staleness 阈值;决定是否需 app 内 durable(design D3)——若需,另立变更(住 app、不进脊柱)
- [ ] 6.2 连续 7 天每天用 inbox 且不想切回旧 inbox-pilot → 过 Phase 1 出口闸;不达 → 触发 ROADMAP ⛔ 止损,回头质疑 thesis
