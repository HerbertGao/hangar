# hangar — 设计拍板文档

> 目录当前名 `agent-os/` 为暂定,拍板后改名 `hangar/`。
> 本文档是 v0 的唯一决策 SOT(single source of truth)。改架构 = 先改本文档。

---

## 0. 一句话

**hangar 是一根无头的 AgentOS 脊柱:它停放、调度、审计你一整队 `*-pilot` agent,自己却不抢戏。控制面 BYO(自带 harness),首选用 Claude Code 驱动。**

不是这个:又一个你必须住进去的对话 Agent(OpenClaw / Hermes / Agno AgentOS)。
是这个:一个薄脊柱 + 一群专注到极致的 pilot;脊柱把每个 pilot 反复重造的脚手架吸收掉一次。

诊断(为什么造):`inbox-pilot`(22K 行 TS)、`ppt-pilot`(22K)、`ai-radar`(58K)各自把「配置 / 持久化 / 调度 / 运行管线 / 动作执行 / 通知 / 日志 / CLI」重造了一遍。**pilot 不重,是它被迫自带一整套脊柱去干一件事。** hangar = 把那根脊柱抽出来一次。

---

## 1. 决策日志(7 个已锁分叉)

| # | 分叉 | 拍板 | 为什么 |
|---|---|---|---|
| Q1 | 服务对象 | **只服务自己的 portfolio**(我 + 小圈子) | 首用户/成功判据/动机/投入四项全指向自用;拼生态短期打不过 OpenClaw;掐掉外部野心 = 免掉多租户/计费/SSO/品牌全部负担。「给别人用」是**以后另立的赌注**,不是本项目阶段。 |
| Q2 | 执行面架构 | **executor 可插拔**;v0 只实现 `pipeline` 一种,留好 `Executor` 接口 | inbox 是 pipeline 型,而成功判据 = inbox 迁上来每天用 → pipeline 必须先能跑。`Executor` 接口 = 未来接**进程内** executor 的插孔;外部 harness(claude-code/codex)只作**推理引擎**,副作用一律回流 `ctx.propose`、不得自带工具权限(否则绕过 OS 审批,破 #5/#6/#7,见 §3.5)。 |
| Q3 | 脊柱与 pilot 关系 | **单一 `hangar` host 进程** + `apps/` 目录 | 「用 Claude Code 控制这个 OS」+「一处看所有状态」要求存在唯一可被一条 CLI 驱动、能看见所有 app 的东西。库模型退回「N 个各自为政的进程」= 老毛病复发。 |
| Q4 | 状态库 | **OS 存 SQLite,只管 `Run/RunEvent/Approval/App`;app 各自管自己的域库** | 薄脊柱底线:OS 一旦管域表,每个新 pilot 的域模型漏进 OS schema,当场过拟合成「邮件形状」。域可见性走 event payload,不走共享表。SQLite = solo/本地/零运维,Claude Code 能直接读文件看状态。 |
| Q5 | app 是代码还是数据 | **单一入口 `app.yaml`,`executor` 字段自选方向**;`pipeline` → 约定加载同目录 `pipeline.ts`;声明式 executor → 无代码。运维可调值单独一层数据配置。 | 约定 > 配置,没有字符串入口那层烂事,没有两种文件类型要嗅探。app 长重了 yaml 照旧、补个 `pipeline.ts` 即可就地毕业。 |
| Q6 | 审批机制 | **PARK / resume**;v0 只做 `propose → approve → execute` 一种切点 | cron + solo + host 会崩 → BLOCK 会把进程占住跨天、一重启全丢。PARK 对 BYO harness 天然解耦(审批只在 OS 层),顺手白拿崩溃恢复。**不造通用 durable replay**(那是 Temporal 存在的理由)。 |
| Q7 | v0 边界 | 见 §5。玩具先行,inbox 迁移作 v0.1。 | 专为「全职 solo」防 scope 爆炸;先拿 30 行玩具验骨架,再动 22K 行真 app。 |

技术选型(已授权我定):**TypeScript + Node + pnpm**(与 portfolio 一致)、SQLite 用 `better-sqlite3`(4 张表不需要 ORM)、调度 `node-cron`、校验 `zod`、日志 `pino`。`zod/pino/node-cron/yaml` 沿用 inbox-pilot 已在用;**`better-sqlite3` 是净新原生依赖**(inbox 用 prisma+postgres,并无它),需验证目标平台预编译/node-gyp。

---

## 2. 架构总览

```
                  ┌─────────────────────────────────────┐
   Claude Code ──▶│  控制面 = CLI (hangar run/status/...) │──┐
   (BYO harness)  │  + SKILL.md 让 CC 照着驱动            │  │
                  └─────────────────────────────────────┘  │
                                                            ▼
   cron 触发 ─────────────────────────────────▶  ┌──────────────────┐
                                                  │  @hangar/core     │
                                                  │  ─────────────    │
   ┌────────────────────┐   scan apps/*/app.yaml  │  registry(zod)   │
   │ inbox (外挂 repo)  │◀────────────────────────│  scheduler(cron) │
   │   app.yaml         │                         │  executor(接口)  │
   │   dist/pipeline.js │──run(ctx)───────────────│  tool gateway    │
   │  (自带 postgres)   │   emit events / propose │  (retry/redact)  │
   └────────────────────┘                         │  approval(PARK)  │
   ┌────────────────────┐                         └────────┬─────────┘
   │ apps/heartbeat/    │                                  │ 读写
   │   app.yaml         │                         ┌────────▼─────────┐
   └────────────────────┘                         │  hangar.sqlite    │
                                                  │  Run/RunEvent/   │
                                                  │  Approval/App    │
                                                  └──────────────────┘
```

**关键简化(v0 无 HTTP / 无 IPC):** daemon 和 CLI 是 `@hangar/core` 的**两个入口**,操作**同一个 SQLite 文件**。**并须同一个 `HANGAR_APPS`:daemon 与所有 CLI 入口(run/status/doctor/approve)必须共享同一个 `HANGAR_APPS`(与同一 SQLite 并列)——否则一方解析不到 pilot(app_not_found / 空 doctor),而 trace/runs 只读 SQLite 仍工作,故障看起来不一致。**(图中 `apps/` 条目可为外部 repo 的 checkout/symlink,入口为编译产物 `dist/pipeline.js`,仓内 dev pilot 才回退 `pipeline.ts`。)daemon 只干「cron → 跑 run」;CLI 干「按需 run / approve / inspect」。`hangar approve` **自己在 CLI 进程里执行**那批已批动作,不用通知 daemon。并发靠 SQLite `busy_timeout` + run 锁行(防重复触发)+ approve 的**原子认领**(`UPDATE … WHERE status='pending'` 防并发双执行)+ **启动期 reaper**(回收崩溃的孤儿 run)。**Phase 0 用 DELETE 回滚日志模式(非 WAL)**:只读命令(status/doctor/…)对已存在库**零写入、不留 root-owned `-wal/-shm` sidecar**(WAL 只读仍会造 -shm,会重踩 root DoS)。代价——WAL 的读写并发只在 daemon+并发 CLI 才有意义,那是多进程,已延后 Phase 1,`busy_timeout` 兜底 rare overlap。**没有服务器,没有消息队列。**

---

## 3. 内核对象

### 3.1 app 布局约定

app 布局约定。apps 根目录可配(默认 `./apps`,`HANGAR_APPS` 覆盖)。一个 pilot = 该根下含 `app.yaml` 的目录(注册 appDir = `HANGAR_APPS/<id>`,一个名为 `<id>` 的 symlink/checkout);pilot **可以是一个独立 repo/package 的 checkout**(自带 `package.json`/`node_modules`/域库),从而把域依赖留在 pilot 自己的 repo、不进 hangar repo。**外部编译 pilot** 的 appDir 根含 `app.yaml` + 编译产物 `dist/pipeline.js`(入口源码 `src/pipeline.ts`,tsc `rootDir:src`/`outDir:dist` 出 `dist/pipeline.js`)。host 解析 `<appDir>/dist/pipeline.js`(编译外部 pilot)优先、回退 `<appDir>/pipeline.ts`(**仅**限仓内 dev pilot:heartbeat 形态 `app.yaml`+`pipeline.ts` 扁平、无 build)。原生 strip-types 加载不了带 `.js` import specifier 的跨仓裸 `.ts`,故外部 pilot **必须**出编译后的 `dist/pipeline.js`。

```
apps/                 # = HANGAR_APPS(默认 ./apps)
  inbox/              # 外部 pilot:独立 repo 的 checkout/symlink
    app.yaml          # 单一入口,永远读它(appDir 根)
    src/pipeline.ts   # 入口源码,export run(ctx)
    dist/pipeline.js  # tsc 编译产物(rootDir:src / outDir:dist);host 加载它
    [tools.ts]        # 可选:propose'd/审批动作的 handler 注册表 —— inbox Phase 1 无高危动作、不需要;Phase 2 gmail.send 才加(届时同样出编译产物)
    (域代码/域库自理:providers/classifier/normalizer/... + 自己的 postgres)
  heartbeat/          # 仓内 dev pilot:app.yaml+pipeline.ts 扁平、无 build(host 无 dist/ 时回退)
    app.yaml
    pipeline.ts       # emit 一条 + propose 两个假高危动作
    tools.ts          # 假高危 tool 的可观测 handler(写 marker/计数),让 DoD 真证明执行发生
```

### 3.2 AgentAppSpec(`app.yaml`)

```yaml
id: inbox                      # 唯一,= 目录名
name: Inbox Pilot
executor: pipeline             # pipeline | llm-direct | claude-code | codex(v0 只实现 pipeline)
enabled: true                  # 可选,默认 true;false = 禁用但保留(见下「disable 契约」)

triggers:                      # 一或多个具名触发器;name 在 >1 触发器时必填且同 app 内唯一
  - type: cron                 # 判别字:v0 仅 'cron';webhook/manual/event 留作未来 type 臂(Phase 3、#6 门控,现不建机制)
    name: poll                 # 不透明触发身份,经 ctx.trigger 传给 run();脊柱不解释其域含义(#1)
    schedule: "*/3 * * * *"    # string | string[];每条须为合法 cron(非法/空串 → spec_invalid、不注册)
    timezone: "Asia/Shanghai"
  - type: cron
    name: digest
    schedule: ["0 6 * * *", "30 12 * * *", "0 19 * * *"]  # 数组=同一触发器多时刻,展开成多个 cron 任务、都带同 name
    timezone: "Asia/Shanghai"

tools:                         # 白名单:app 能碰哪些动作
  - gmail.read
  - gmail.send

permissions:
  approval:                    # 这些动作 = PARK,必须人拍板
    - gmail.send

# 运维可调值(未来 UI 编辑的那层;现在手改/CC 改)
config:
  model: gpt-5.5
  budget_usd_per_run: 0.5
```

- 加载:`registry` 扫 `<appsDir>/*/app.yaml`(`appsDir` 默认 `./apps`,`HANGAR_APPS` 覆盖;条目可为该根下的独立 repo checkout)→ `SpecSchema.parse()` → 带类型的 `Spec`。`id === 目录名` 约束不变。入口按 `<appDir>/dist/pipeline.js`(编译外部 pilot)解析、回退 `<appDir>/pipeline.ts`(仓内 dev)。
- 约束:`app.yaml` 无 `dist/pipeline.js` 亦无 `pipeline.ts` 却写 `executor: pipeline` = doctor 报错。
- **多触发契约(通用脊柱能力:一个 app 多个具名触发、各分派到不同行为;inbox poll+digest 是首用例、非过拟合 #2):** 每个触发器 `{ type, name?, schedule: string | string[], timezone? }`。
  - `type` 是**判别字**(v0 仅 `z.literal('cron')`,单臂 union):为未来非-cron 形式(webhook/manual/event)留 **schema 形状 + 注释**,受 #6(v0 无 HTTP/IPC)门控、留待 Phase 3——**本变更不建任何机制**(分派已由 name 类型无关地兼容,扩展点可见可读但不投机)。
  - `schedule` 接受**单条 cron 或非空 cron 数组**(数组 = 同一触发器多个时刻,如 digest 的 06:00/12:30/19:00 分钟不齐、一条 cron 表达不了)。**每条 schedule 须为合法 cron**,空串/非法(如 `"30 12 * *"`)→ `spec_invalid`、doctor 报错、app 不注册。**为何在 load 时拦**:daemon 的 `cron.schedule` 循环无 try/catch,非法 cron 会**同步抛并崩掉整个 daemon**、所有 app 停调度;load-时校验把这层挡在注册前,daemon 循环因此可假设 cron 已合法。
  - `name` 可选,但 **app 的 triggers 条目数 > 1 时每个必填、且同 app 内各 name 互不重复**(否则 `spec_invalid`)。单触发可省 name(heartbeat/现 inbox poll → `ctx.trigger=undefined`、零改动)。为何唯一:name 是触发身份(§3.5 路由、§3.4 pending 去重都拿它当键),重名会使 `ctx.trigger`/`Run.trigger`/pending 归因塌陷。判定按**触发器条目数**、不按数组展开后的任务数。
  - **`config`/`permissions` 仍 app 级**,触发器**不携带**自己的 config/permissions/executor(YAGNI/#2;`run(ctx)` 拿 app.config + ctx.trigger 自行分支即可)。这**不新增 app 定义方式**——`app.yaml` 仍是唯一入口(#4)。
- **disable 契约(app 生命周期开关,通用脊柱能力;退役 heartbeat 是首用例、非过拟合 #2):** `enabled: boolean` 可选、默认 `true`;`false` = **禁用但保留**该 app。语义三条:① daemon **跳过**其 cron 触发(不自动 park);② hangar-view 办公室**不上墙**(`doctor` 仍如实报 `enabled:false`,是**显式排除**、非静默省略);③ **手动 `hangar run <app>` 仍放行**(operator / DoD 夹具照跑)——一个 committed flag 同时满足「CI 里可测 + 生产里隐身」(disabled ≠ 完全动不了)。
  - **落 `app.yaml` 不落 App 表列**:App 表非权威、一次 rescan 即与 FS 漂移;声明式 + 随仓版本可控(`git pull` 不冲掉)、零 DB 改动(#3)。取代 §「App 表」段早稿的「`enabled` 列」设想。
  - **仅对 valid app 生效**:`enabled` 只在 `app.yaml` 整体过 zod 时解析,坏 app.yaml(`spec_invalid`)**无法**用此旗禁言(仍呈⚠️);disable 是 valid-app 的生命周期开关,不是压制注册错误的手段。**broken 优先于 disabled**——`spec`/`pipeline` 坏一律先呈「配置坏了」⚠️,禁用只排除 otherwise-healthy(`spec=ok ∧ pipeline=ok`)的 app。
  - **D5 显式 guard(早稿「等价于无可调度触发器」被评审证伪):** disabled **不清空** `triggers`、`deriveBlocked` **不读** `enabled`,故无免费等价——调度馈入(daemon)+ blocked 派生(doctor/status)**三处各自显式 guard**(共享 `enabled !== false` 判据、非同一段代码);disabled app **仍列在** status/doctor(不 delist),guard 只作用于「排期 + 派生阻塞」,不作用于「是否列出」。
  - **#2 论证**:disable 不在 inbox pipeline 里被调用,但属 **OS 层 app 生命周期管理**(与 `registry`/`doctor`/`status`/多触发调度同族、零域名词 #1);「App 表」段早预留「启停」、本变更是已预见需求的兑现;同「多触发 = 通用能力、inbox poll+digest 首用例」框架,disable 的首用例是**退役 heartbeat**(其 daily cron 在生产天天 park demo.risky、天天冒假警报,又是 DoD §8.1 夹具不可删)。缺省 `true`,现有 app 零变化(向后兼容)。
- `defineApp()` 不做了(Q5 采纳单入口方案后作废)。

### 3.3 OS 存储(`hangar.sqlite`,只此 4 表)

```sql
App        (id PK, name, registered_at)                    -- FS 扫描的缓存/审计,非权威
Run        (id PK, app_id, state, trigger, started_at, ended_at, lock_owner)  -- lock_owner=PID+启动时刻,供 reaper
RunEvent   (id PK, run_id, seq, kind, payload_json, at, UNIQUE(run_id,seq))    -- append-only,状态之源
Approval   (id PK, run_id, tool, args_json, status, requested_at, decided_at, decided_by)
```

**OS 永远不知道「邮件」这个概念存在。** 域细节全在 `RunEvent.payload_json`(如 `{kind:"classified", count:12, flagged:2}`)。
- App 表是 `apps/*/` 扫描的缓存,registry 每次加载重扫 FS(App 表非权威,避免漂移);`spec_hash` 列 Phase 0 无消费者,有漂移检测需求再加。**「启停」需求(早稿设想的 `enabled` 列)已兑现为 `app.yaml` 声明式字段 `enabled`(见 §3.2 disable 契约),不落 App 表列**——App 表非权威、一次 rescan 即与 FS 漂移;开关属「这个 app 是什么」的声明,归唯一入口 `app.yaml`(#4)+ FS 即权威。
- `Run.state` 是缓存列,真相源永远是 `RunEvent`:写终态事件、更新 `Run.state`、释放 app 锁**必须同一事务**(锁骑在 state 上,不同步即锁失真)。
- `Run.trigger` 列**复用**存触发身份(守 #3 不加表):值 = `triggerName ?? req.triggerKind`——具名触发器存其 `name`(供 trace 按触发器归因),缺 name 回退触发类别(`cron`/`manual`)。**该列自此混载 trigger name 与类别**;消费者:`hangar runs` 透传显示、hangar-view `deriveLiveness`(`packages/hangar-view/src/derive.js:214`)按 `trigger === 'cron'` switch 它(无名 run 靠此判活);未来消费者**不得假设**值域仅 `{cron, manual}`。

### 3.4 Run 状态机(从事件推导,不靠 LLM 自称)

```
queued → running → [waiting_human] → executing → completed
                          ▲                         ├─ failed
                          └──── approve ────────────┘
                                                     └─ cancelled
```

`classify(run)` 读 `RunEvent` 最新**生命周期映射**事件(跳过 domain kinds 如 notify.*/reflect.*/email.dead_letter)推出状态(全映射,无悬空):空→`queued`;`run.started`→`running`;`approval.requested`→`waiting_human`;`approval.granted`/`action.executed`/`action.failed`→`executing`(**`action.*` 是逐动作进度、非终态**——一次 run 可多动作,单动作失败不等于 run 死);`run.completed`→`completed`;`run.failed`→`failed`;`run.cancelled`→`cancelled`。**只有 `run.*` 是终态**,且所有终态转换走**单一 choke-point**:同事务追加 `run.*` + 更新缓存 + 释放 app 锁 + 作废该 run 的 pending/granting Approval(锁释放挂钩终态转换本身、不校验 `lock_owner==self`)。UI 文案:排队 / 思考中 / 等你拍板 / 卡住了 / 搞定 / 翻车。

**崩溃回收(reaper):** 进程被杀(非抛错)会把 run 停在非终态、锁不释放。**写命令(run/approve/reject/daemon)启动时**跑一次 reaper(`doctor`/只读不跑,守「不写库」);按 `lock_owner` 的 **PID+启动时刻**指纹(非裸 PID,防复用误判)找出死进程持有的非终态 run(含 `queued`/`running`/`executing`)→ 经 choke-point 判 `run.failed` 释放锁并作废其 Approval;`waiting_human`(无进程持有)不动。approve 崩在第二阶段亦被此机制回收(它已取锁 → lock_owner 是死的 approve 进程)。**边界(hard-crash containment ADR 澄清):reaper 只回收 DB/锁,不回收 pipeline 派生的 OS 子孙进程——「DB reaped」≠「OS child reaped」,二者须分开断言。** OS 子孙回收是独立能力 `hangar.run.hard-crash-containment/v1`(能力闸,过 fault test 才广播;设计见 archive/2026-07-16-design-hard-crash-containment):实现落地时 OS 回收步在 choke-point 事务**之外**先跑、有界(超时即放弃)、错误 catch 吞掉——**DB reap 恒发生、绝不被 OS 回收失败挡住**;两平台无需 boot 门(Linux cgroupfs 每 boot 重建 / macOS run_id 唯一 UUID)。该实现属后续受闸变更,现未实现。

**daemon 多触发序列化(替换旧「`hasActiveRun` → skip」):** 保「每 app 至多一个活跃 run」不变量、不放宽为并发。daemon 进程内维护 per-app `inFlight` set + `pending`(按 `app + trigger name` 去重、每触发器至多 1 pending、封上界、插入序 drain)。**`pending` 是易失调度提示、非 run-state 真相**——RunEvent 仍是审计 SOT(守 #3),`pending` **不进 4 表**、不进 status/trace/doctor、daemon 崩即丢。`fire(app, name)`:本 daemon 正跑该 app(`inFlight.has`)→ 记 pending(去重)、不丢;否则别的进程持锁**或本 daemon 的 run 已 park 成 `waiting_human`(仍持 active-lock)**(`hasActiveRun` 真)→ skip+log(接受降级、同 reap-vs-run);否则跑。**drain 复用 fire 守卫、按 DB 活跃态而非 promise 生命周期判定**:`runApp` settle(`.finally`)清 `inFlight` 后,取一个 pending **走回 `fire`**——若此刻 run 已 resolve 但 park 成非终态、仍持锁,drain 落 skip+log,**不**盲跑撞 `createRun → already_running` 把 pending 丢掉。故多触发同刻 fire(12:30 digest 与 `*/3` poll 的 `:30` 对齐)本进程内**不丢** digest、堆积有界;park/跨进程/崩溃下降级为 skip+log 或靠下一周期/DB 自愈。**liveness 假设**:`inFlight` 只在 `runApp` settle 时清,pilot 的 `run()` **须自限时**(否则挂死的 run 永占 `inFlight`、该 app 再不调度——与现状 `hasActiveRun→skip` 同一 wedge、非本变更新引入;脊柱级 watchdog 属未来)。`daemonTasks` 把数组 schedule 展开成多个 `cron.schedule`、**都带同 name**(同串去重);overdue/blocked 检测对数组取**每条 cron 周期的最小值**(= 最快触发器一周期没跑即 overdue;诊断性告警、非执行门,最激进而非保守的判定)。

**daemon 优雅停机(SIGINT/SIGTERM · 替换旧「收信号即硬杀」):** daemon 收 **SIGINT/SIGTERM** 置 `shuttingDown` 标志——它同时**门住 `fire()`**(停机窗口内新到的 cron/pending tick 不再 `createRun`,否则宽限内诞生的 run 逃过取消扫描、留非终态)与**使 `shutdown()` 主体幂等**(2 次调用早退、不重 abort / 重轮询);信号 handler 另有一次性退出门闩,首个信号独占「宽限 + exit」序列,宽限内后续 SIGINT/SIGTERM 被忽略,不得截断剩余宽限或触发第二次 `process.exit`。随后 **abort 全部 active run**,在**宽限期(`HANGAR_SHUTDOWN_GRACE_MS`,默认 ~5s)**内等它们**真收束**(非盲 sleep)后退出:配合 `signal` 的 pipeline 在宽限内经上文**单一 choke-point** 记 `run.cancelled`(不新增终态转换点,守 #8);**宽限内未收束者**(忽略 signal / cleanup 过久)留非终态、**不在此处强写终态**,由下次启动的 **reaper** 按死 PID 指纹判 `run.failed`(= cleanup-timeout,复用上文既有 reaper、零新机制)。取消全程**进程内**(#6:无 IPC、不引入 DB 轮询取消标志)。手动 `hangar run` 则装 `process.once('SIGINT', abort)` 只取消自身那一个 run(立即 abort + 短等、不套完整宽限;`once` 留第二次 Ctrl-C 回落硬杀)。

### 3.5 Executor 接口(未来接进程内 executor 的插孔)

```ts
interface Executor {
  run(ctx: RunContext): Promise<void>   // 抛错 = run failed;PARK 不抛错(见 §3.6 check-after-return)
}
// v0 唯一实现:PipelineExecutor —— import(`<appDir>/dist/pipeline.js`).run(ctx)(编译外部 pilot;回退 `<appDir>/pipeline.ts` 仅限仓内 dev)
```

```ts
interface RunContext {
  input: unknown                            // 来自 hangar run --input
  triggerKind: 'manual' | 'cron'            // host 在 run 创建入口写死的触发类别;--trigger flag 与 app 均不可伪造(唯一 provenance = host 入口)
  triggerName?: string                      // 可选触发器 name(= 既有 trigger 同值、语义更清晰的新名);无名触发器 undefined
  trigger?: string                          // @deprecated 用 triggerName —— 保留为旧 app 只读的向后兼容分支(= triggerName);脊柱零域 #1,app 内 switch 分派;老脊柱不传→undefined→默认路径(向后兼容)
  config: Record<string, unknown>          // 来自 spec.config
  logger: Logger                            // pino
  readonly signal: AbortSignal              // 只读取消信号(Node 原生);host 恒提供(必填,同 triggerKind),pipeline 读它优雅收尾、忽略仍照跑(向后兼容)
  readonly capabilities: readonly string[] // host 从 HOST_CAPABILITIES 为本 run 复制并冻结的新鲜快照;input/config/request 不可伪造
  emit(kind: string, payload?: object): void          // 追加 RunEvent
  propose(action: {tool: string; args: object}): Promise<unknown>  // 唯一动作入口(async):低危 await 执行拿结果,高危登记待批 resolve void;不抛错、不中断 run()
}
```

**触发路由(`ctx.trigger`,多触发能力的分派契约):** 脊柱把触发该 run 的触发器 `name`(**不透明字符串**)塞进 `ctx.trigger` 传给 `run(ctx)`;**脊柱零域**(#1)——不认识 `poll`/`digest`,只透传。`run(ctx)` 是**单入口**,app 内 `switch(ctx.trigger)` 自行分派(可写成 `runPoll`/`runDigest` 保可读),并**自守 loud default**(既非 `undefined` 又非已知 name → throw,拼错/漏配触发器时响亮失败,而非静默走默认路径)——名→行为绑定是 app 内约定,脊柱无法内省其 switch。单个无名触发器 → `ctx.trigger === undefined` → 默认路径(heartbeat/现 inbox poll **零回归**)。`ctx.trigger` 是运行时**鸭子契约新增字段**且**可选**:老脊柱不传→pilot 读到 undefined→默认路径(向后兼容);pilot 须防御性读(`ctx.trigger === 'digest'`),fail-loud **不**断言它(可选)。`hangar run <app> [--trigger <name>]` 可手动注入 name,使任一具名触发行为(如 digest)可手动触发/重放(否则 `hangar run inbox` → undefined → 只跑默认路径、digest 无法手动验证或补发)。

**触发类别(`ctx.triggerKind`,不可伪造的 provenance):** `triggerKind: 'manual' | 'cron'` 由 host 在**两个 run 创建入口写死**——`cmdRun` 恒 `'manual'`、daemon 恒 `'cron'`;`--trigger <name>` flag **只**设 `triggerName`、绝不改 kind(manual 用与某 cron 相同 name 时 `triggerKind` 仍 `'manual'`),app/pilot 只收 ctx、不构造 RunRequest 故也无法改它。因此**唯一 provenance 是 host 入口**——这是「flag/app 不可伪造 + host 入口是唯一来源」,**非**对任意程序化调用者做运行时 provenance 校验(单用户 BYO、无对抗 app 作者,同上 carve-out)。`triggerName`(= 触发器 name)是既有 `trigger` 语义更清晰的同值新名;`trigger` **保留但 deprecated**(= `triggerName`),旧 app 只读它照常走、零回归;pipeline 从此读 `triggerKind`/`triggerName` 两独立字段,不再从 §3.3 混载列反推来源。

**取消信号(`ctx.signal`,进程内优雅取消):** 每个 active run 持一个 `AbortController`,其 `signal` 以只读形式经 `ctx.signal` 暴露给 `run()`。取消**只经既有单一 choke-point 记 `run.cancelled`**(守 #8 不新增终态转换点):`runApp` catch 里按 `ctx.signal.aborted` 分流(aborted→`run.cancelled`、否则→`run.failed`),且在调 `evaluateAfterRun`(check-after-return)前先查 `signal.aborted`——已 aborted 直接记 `run.cancelled`、不进 evaluate(免得「aborted 后正常 return」被误记 completed);靠 choke-point 既有幂等收敛为「首个终态胜、锁只释放一次」。**「aborted → cancelled」只对协作路径成立**:pipeline 配合 `signal`、在**宽限期内收束**时才记 `run.cancelled`;忽略 `signal`/超宽限的 run,daemon 停机不为它写终态,由重启期 **reaper** 判 `run.failed`(§3.4 cleanup-timeout,被明确接受的降级)。老 pipeline 不读 `ctx.signal` 仍照跑,取消退化为「abort 后等宽限、超时 reaper 收 failed」(与现状 Ctrl-C 一致、零回归)。

**运行期能力快照(`ctx.capabilities`,#19):** `HOST_CAPABILITIES` 是唯一 canonical set,当前含 `hangar.run.trigger-kind/v1`、`hangar.run.abort-signal/v1`、`hangar.run.cancelled-terminal/v1`、`hangar.run.runtime-capabilities/v1`。`doctor --json` 从它广播真机 offered 集;executor 也为**每个 run**从它复制并冻结一个新数组注入 `ctx.capabilities`。该字段不是 `RunRequest` 的 caller 输入,同名 input/config/trigger 不能替换;修改某次快照不能污染 canonical、doctor 或后续 run。外部 adapter 自带 required 集:部署前跨进程读 doctor 做制品门禁,进入 `run(ctx)` 后在自己的业务副作用前再对快照精确校验(`/v2` 不自动满足 `/v1`)。`assertCapabilities(required, have)` 的 `have` 必填,禁止默认读 module-local 常量以免 bundle 假绿。**边界:** pipeline 模块在 `run(ctx)` 前已被 import,所以运行期门禁不保护模块顶层副作用;模块必须 side-effect-free at import,部署期门禁与运行期门禁互补。

**没有 `ctx.tools` 直执行入口**——那是让 app 绕过 `permissions.approval` 的后门(破 #5)。「要不要审批」是 OS 策略、不是 app 选哪个方法;**可审批/高危动作走单一 `propose`**,gateway 按名单决定 park 还是立即执行。

**carve-out(add-inbox-migration,#9):** `propose` 是**受审批策略约束的动作**的入口;app **可**在 `run()` 里直接调用自己**本质无害的域副作用**(inbox 的自动 reflect/mark_read/notify——打标签 / 标已读 / 推自己的 telegram,非破坏性、无需审批),**不必**经 `propose`;但任何**可审批/高危**动作(如 Phase 2 的 `gmail.send`)**必须**走 `propose`。故 #5 对直执行路径由**结构强制**降为 **app 编写纪律**(单用户 BYO 无对抗 app 作者,可接受;`run()` 本是任意 app TS、能 `import` 任何库,该「结构保证」历来约定邻近)。(`executor.ts` 的 `RunContext` 注释已同步反映此 carve-out。)
**外部 harness 收窄**:`claude-code`/`codex` 那类独立进程 harness 只作**推理引擎**、零工具权限,副作用一律回流 `ctx.propose`;否则其工具调用绕开审批(破 #5)或要加 IPC/MCP(破 #6/#7)。接口类型不变,但这条**使用契约现在写死**,免得 Phase 2 逼你在「改脊柱」和「破不变量」间二选一。

### 3.6 Tool Gateway(治理活在这里 · 内存重试 + `redactError`,供 propose'd/审批动作;见 §3.5 carve-out)

**动作的实际执行体 = app 的 `tools.ts` handler**(对称于 Executor 的插孔):`{ [tool]: (args, ctx) => Promise }`,gateway 按名加载、**独立于 `run()`**(approve 可能在重启后的另一进程执行,只能按 `{tool,args}` 重解析,不能靠 run() 闭包)。**没有它「执行动作」就是空洞**——heartbeat 用假 tool 盖住会让 execute 退化成「只 emit 事件」的 false-green;审批后的域回写(inbox 把「已发送」写回域库)只能住这里。

**`propose` 是 async 登记入口**(不即时收束,否则一次 run 多次 propose 第一次就退出——inbox 一次发 N 封当场坏):
- 低危(不在 `approval` 名单)→ `await` 调 handler 执行(内存重试 + 脱敏)+ `emit action.executed`,resolve 结果回 `run()`。
- 高危 → 写 `Approval(pending)`,**不执行、不抛错、不中断 `run()`**,resolve void。
- `run()` 返回后 **check-after-return** 评估一次:有 pending → 逐个 `emit approval.requested`、收束 `waiting_human`;无 → 经 choke-point `emit run.completed`。

**app 作者契约(文档约定、非机制强制):** 高危 `propose` 即 run 终点——审批后 gateway 只跑那批 handler、**不重入 `run()`**。故 propose 后别放「审批后才该跑」的域逻辑:它会**在审批前、run() 里就执行**(基于「已成功」的假前提),若随后 reject 就成孤儿脏写。域回写请放进 handler。(违反不报错、是静默跑错——比「别放」暗示的更危险。)

**`hangar approve/reject <run>`:** 先守 `state==waiting_human`(否则 `not_waiting`——防对 failed/completed run 误执行被作废的待批动作 = 破 #5)→ **取该 run 锁**(`waiting_human→executing`,lock_owner=自身 PID+启动时刻)使第二阶段单写者串行、崩溃可被 reaper 回收 →
- approve:逐个 pending 执行 handler(`Approval.id` 作幂等键透传)→ `emit action.executed` + `granted`;全完成经 choke-point `run.completed`。某动作耗尽失败 → 经 choke-point `run.failed`(已 granted 不回滚)。
- reject:不执行,pending 置 `rejected`,经 choke-point `run.cancelled`。
- gateway 只保证「至多认领一次」(CAS);对外部副作用的「至多执行一次」取决于 handler/外部系统认不认幂等键。

**只搬内存重试,不搬 durable 队列:** 泛化 `executeActions` 的 `MAX_ATTEMPTS` 内存有界重试 + `redactError`(35 行,剥残留域正则)。inbox 的 `retryQueue`(DB 持久化、跨重启、dead_letter)= 通用 durable execution,**破 #3/#8,不搬**。**(add-inbox-migration 精修,#9)** 此内存重试 + redact 供 **propose'd/审批动作**用;inbox 的**自动动作**(reflect/mark_read/notify)迁移后**在 `run()` 内直接编排**(保留自身更丰富的三值/退避/reauth 处理),**不经 gateway**——gateway 是审批门控、inbox 无高危动作;`propose` 保留给 Phase 2 的 `gmail.send`。

**Phase 0 单进程假设:** 上面守卫+取锁+reaper+幂等键覆盖崩溃恢复与「第二个 approver 被守卫挡掉」;**一切多进程并发的完整仲裁显式延后 Phase 1**——含 ① 同时审批同一 run(seq 竞争、approve-vs-reject 活 race、granting lease)② **reap 与并发 run/claim 的行级仲裁**(reap 在事务外读 `lock_owner`、另一进程可能在读后抢锁)。你 solo/单终端/heartbeat 玩具碰不到,inbox 上线才需要。已披露,非遗漏。

### 3.7 CLI 面(= 控制面 · 遵循你 CLAUDE.md 的 CLI 规范)

```
hangar run <app> [--input …]      手动触发一次 run
hangar status [--json]            所有 app 当前状态一览(读 SQLite)
hangar runs [<app>] [--json]      run 历史
hangar trace <run> [--json]       某 run 的完整事件时间线
hangar approve <run>              执行该 run 的待批动作
hangar reject <run> [--reason …]  驳回待批动作
hangar doctor [--json]            环境自检(node 版本、sqlite **目录**可写(access(W_OK),不建库)、apps 目录、各 app.yaml 合法性、入口存在性(`dist/pipeline.js` 编译外部 pilot / 回退 `pipeline.ts` 仓内 dev))
hangar daemon                     启动长驻进程(cron 调度)
```

约定:日志 → stderr,数据 → stdout,`--json` 结构化输出,退出码 0/1/2 语义化。**写操作(run/approve/reject)拒绝 root(EUID==0)**;`doctor` 不拒绝,但其可写检查**非破坏性**(绝不创建 `hangar.sqlite`)——否则 root 跑 doctor 会造 root-owned 库、之后非 root 的 run 永远写不进。`trace/approve/reject` 一个不存在的 run → `run_not_found`(退出码 1)。无参运行 = 打印帮助。

### 3.8 控制面 / SKILL

`SKILL.md`(host-agnostic SOT)描述每条 CLI 的用途 / 参数 / 返回 JSON schema / 错误 kind / Agent 行为约定,并列「不暴露给 Agent 的能力」(如 `hangar daemon` 不该被 CC 误调)。让 Claude Code 照 SKILL 驱动 hangar。**不上 MCP**(你 CLAUDE.md 明列的反模式;CLI + JSON 已够)。

---

## 4. v0 范围(多一样都不许)

**IN**
- `hangar` host(TS 长驻,一个 docker 容器)+ `hangar daemon`
- registry:扫 `<appsDir>/*/app.yaml`(appsDir 可配;pilot 可放在 hangar repo 之外的独立 checkout,域依赖留在 pilot repo)+ zod 校验,`executor` 选方向。
- **只一个 executor:`pipeline`**
- scheduler:`node-cron` 读 `triggers`
- OS SQLite:`Run/RunEvent/Approval/App`
- tool gateway:内存重试 + redact(供 propose'd/审批动作;**不搬 durable retryQueue**);查 approval 名单;发事件。(add-inbox-migration,#9:inbox 自动动作在 `run()` 直接编排、不经 gateway)
- 审批 PARK:`propose`(登记)→ run 结束 check-after-return → `waiting_human` → `approve`(原子认领防双执行)→ execute
- 崩溃回收:启动期 reaper 把死 PID 的孤儿非终态 run 判 `failed` 释放锁;daemon 多触发**本进程内序列化**(fire → per-app inFlight/pending 去重 → 终态后 drain,替换旧「遇活跃 run 就 skip」;跨进程持锁/park 才 skip+log,见 §3.4)
- CLI:`run/status/runs/trace/approve/reject/doctor/daemon`(`--json`)
- `SKILL.md`(SOT)

**OUT(附加回条件)**
- `llm-direct`/`claude-code`/`codex` executor → pilot #2 是声明式再加
- 配置 UI → 手改 config 手疼再加
- eval/regression → **留在 inbox 内部**,别当 OS 功能;pilot #2 再谈通用化
- 成本/预算强制 → 某 run 真烧出意外账单再加(v0 只记 `config.budget`,不 enforce)
- 多用户 / RBAC / 租户 → 永不,直到「给别人用」变真赌注
- 通用 durable replay / 中途 checkpoint → 永不,直到某 app 需要非 propose/execute 切点
- MCP / A2A / marketplace / **多用户** web workbench → Claude Code 就是 workbench。**例外:单用户、只读、经 CLI `--json`(+ 只读 `app.yaml`)、零改 core 的私人巡检 view(`hangar-view`「虚拟办公室」)= 显式接受的独立赌注(Phase 1.5,SOT `docs/proposals/hangar-view.md`)——不破 #6(HTTP 在脊柱外、view 只作 CLI 消费者)。给别人用的多租户 workbench 仍永不做。**
- 多根 / 多 repo 的**外部 pilot loader 子系统**(config 列 N 个外部路径、pilot index)→ **pilot #2 逼出「停一队 fleet」时再加**;单 pilot 用 `HANGAR_APPS` 覆盖 + 独立 checkout 即可,不建 loader 子系统。
- 外部 pilot **marketplace / plugin store / publish-discover-install** → 永不,直到「给别人用」成真赌注(同 §6)。

**构建次序**
1. **v0(骨架):** `@hangar/core` + SQLite + registry + `PipelineExecutor` + PARK + CLI + doctor,配一个 **30 行 `apps/heartbeat/`**(`executor: pipeline`,run 里 `emit` 一条 + `propose` 一个假高危动作)。目标:一天内跑通 `run → park → approve → trace → status` 整条链,亲眼见脊柱活着。
2. **v0.1(里程碑):** 迁 `inbox-pilot` 为外部 pilot(checkout 到 `HANGAR_APPS/inbox`、编译出 `dist/pipeline.js`)。见 §5。**「每天用」从这里开始计。**

---

## 5. inbox-pilot 迁移备忘

| inbox 现有 | 去向 |
|---|---|
| `src/actions/executeActions`(**仅内存重试部分**)+ `redactError` | **泛化进 `@hangar/core` tool gateway**(剥掉残留域正则)——**供 propose'd/审批动作用(add-inbox-migration #9 精修);inbox 自动动作(reflect/mark_read/notify)迁移后在 `run()` 内直接编排、不经 gateway(见下行「classify→act 主流程」+ §3.6),故此泛化对 Phase 1 inbox 未被使用** |
| `src/actions/retryQueue`(DB 持久化 durable 队列) | **不搬**——通用 durable execution,破 #3/#8 |
| `src/config` `src/db` `src/jobs` `src/logger` `src/cli` `src/pipeline` | 由 hangar 脊柱提供,inbox 侧删除 |
| `src/classifier` `src/normalizer` `src/digest` `src/rules` `src/accounts` `src/providers/*` | **留在 inbox 外部 repo**(域逻辑,不进脊柱) |
| prisma + postgres + 邮件域表 | **原封不动**,inbox app 自管(hangar 不碰) |
| classify→act 主流程 | 收敛成 inbox 外部 repo `src/pipeline.ts`(tsc 编译出 `dist/pipeline.js`)的 `run(ctx)`:分类 `ctx.emit`;自动动作(reflect_priority/mark_read/notify,本质无害)**在 `run()` 内直接编排、不经 gateway**;若日后有高危动作(如 `gmail.send`)才走 `ctx.propose`(命中 approval → PARK)。注:inbox 现有动作均**不自动发信**、无高危动作,`gmail.send` 是规划中动作而非现状 |
| `src/classifier/eval` | 暂留 inbox 内部,不进 OS |

迁移完成判据:**inbox 作为外部 repo checkout 到 hangar 的 apps 根(`HANGAR_APPS/inbox`)、在 hangar host 上按 cron 每天跑,若存在高危动作则走 `hangar approve`(inbox 现状无高危动作、其 run 永不 `waiting_human`,故此判据对 inbox 空过),而你每天真在用它。**

inbox 作为**独立 repo/package** checkout 到 hangar 的 apps 根(`HANGAR_APPS`)下;host 按 `<root>/inbox/dist/pipeline.js` **就地 in-process import**。inbox 的 prisma/postgres/provider 依赖留在 inbox 自己的 `package.json`/`node_modules`,**不进 hangar repo**。不再拷贝域码、无双 schema 共库。

---

## 6. 非目标(反 scope 爆炸 · 全职 solo 专用护栏)

hangar **不是**:对话助手 / 工作流画布 / prompt 管理平台 / 面向外部市场的产品 / 通用 durable execution 引擎 / 模型或向量数据库。凡是 inbox-pilot 用不到的能力,**一律不许进脊柱**——这是本项目唯一的硬约束。

外部 pilot 指**代码在别的 repo、由 host in-process import**(filesystem-external),**不是**把 pilot 跑成独立进程(process-external → 破 #6/#7)。**代价:** in-process 加载把外部 pilot 的同步 throw / 模块顶层 `process.exit` / native 崩溃 / OOM 放进与脊柱**同一崩溃域**(D7 只挡异步 abandoned-promise,不挡模块加载期 exit);单 pilot 可接受,fleet 规模是 Phase 2 gate 的考量。in-process pilot 契约:**模块顶层禁 `process.exit`/throw**(否则杀 host)。**补注(hard-crash containment ADR):** 该能力的推荐方案 (d) **保持进程内加载不变**——pipeline 不搬出进程、不引入进程外 worker,只加受闸 spawn 入口(`ctx.spawn` 记录)+ reaper 回收 OS 子孙,故本节假设不受其影响;worker(crash-isolation)若将来立项才动本节。
