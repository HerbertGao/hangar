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
| Q2 | 执行面架构 | **executor 可插拔**;v0 只实现 `pipeline` 一种,留好 `Executor` 接口 | inbox 是 pipeline 型,而成功判据 = inbox 迁上来每天用 → pipeline 必须先能跑。`Executor` 接口 = 未来接任何 harness 的插孔。 |
| Q3 | 脊柱与 pilot 关系 | **单一 `hangar` host 进程** + `apps/` 目录 | 「用 Claude Code 控制这个 OS」+「一处看所有状态」要求存在唯一可被一条 CLI 驱动、能看见所有 app 的东西。库模型退回「N 个各自为政的进程」= 老毛病复发。 |
| Q4 | 状态库 | **OS 存 SQLite,只管 `Run/RunEvent/Approval/App`;app 各自管自己的域库** | 薄脊柱底线:OS 一旦管域表,每个新 pilot 的域模型漏进 OS schema,当场过拟合成「邮件形状」。域可见性走 event payload,不走共享表。SQLite = solo/本地/零运维,Claude Code 能直接读文件看状态。 |
| Q5 | app 是代码还是数据 | **单一入口 `app.yaml`,`executor` 字段自选方向**;`pipeline` → 约定加载同目录 `pipeline.ts`;声明式 executor → 无代码。运维可调值单独一层数据配置。 | 约定 > 配置,没有字符串入口那层烂事,没有两种文件类型要嗅探。app 长重了 yaml 照旧、补个 `pipeline.ts` 即可就地毕业。 |
| Q6 | 审批机制 | **PARK / resume**;v0 只做 `propose → approve → execute` 一种切点 | cron + solo + host 会崩 → BLOCK 会把进程占住跨天、一重启全丢。PARK 对 BYO harness 天然解耦(审批只在 OS 层),顺手白拿崩溃恢复。**不造通用 durable replay**(那是 Temporal 存在的理由)。 |
| Q7 | v0 边界 | 见 §5。玩具先行,inbox 迁移作 v0.1。 | 专为「全职 solo」防 scope 爆炸;先拿 30 行玩具验骨架,再动 22K 行真 app。 |

技术选型(已授权我定):**TypeScript + Node + pnpm**(与 portfolio 一致)、SQLite 用 `better-sqlite3`(4 张表不需要 ORM)、调度 `node-cron`、校验 `zod`、日志 `pino`。全部沿用 inbox-pilot 已在用的依赖,零学习成本。

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
   ┌────────────────┐   scan apps/*/app.yaml      │  registry(zod)   │
   │ apps/inbox/     │◀───────────────────────────│  scheduler(cron) │
   │   app.yaml      │                            │  executor(接口)  │
   │   pipeline.ts   │──run(ctx)──────────────────│  tool gateway    │
   │  (自带 postgres) │   emit events / propose    │  (retry/redact)  │
   └────────────────┘                            │  approval(PARK)  │
   ┌────────────────┐                            └────────┬─────────┘
   │ apps/heartbeat/ │                                     │ 读写
   │   app.yaml      │                            ┌────────▼─────────┐
   └────────────────┘                            │  hangar.sqlite    │
                                                  │  Run/RunEvent/   │
                                                  │  Approval/App    │
                                                  └──────────────────┘
```

**关键简化(v0 无 HTTP / 无 IPC):** daemon 和 CLI 是 `@hangar/core` 的**两个入口**,操作**同一个 SQLite 文件**。daemon 只干「cron → 跑 run」;CLI 干「按需 run / approve / inspect」。`hangar approve` **自己在 CLI 进程里执行**那批已批动作,不用通知 daemon。SQLite WAL + 一个 run 锁行防重复执行。**没有服务器,没有消息队列。**

---

## 3. 内核对象

### 3.1 app 布局约定

```
apps/
  inbox/
    app.yaml          # 单一入口,永远读它
    pipeline.ts       # executor: pipeline 时按约定加载,export run(ctx)
    (域代码/域库自理:providers/classifier/normalizer/... + 自己的 postgres)
  heartbeat/
    app.yaml          # executor 非 pipeline 时,无需任何代码
```

### 3.2 AgentAppSpec(`app.yaml`)

```yaml
id: inbox                      # 唯一,= 目录名
name: Inbox Pilot
executor: pipeline             # pipeline | llm-direct | claude-code | codex(v0 只实现 pipeline)

triggers:
  - type: cron
    schedule: "0 9 * * *"
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

- 加载:`registry` 扫 `apps/*/app.yaml` → `SpecSchema.parse()`(zod)→ 拿到带类型的 `Spec`。
- 约束:`app.yaml` 无 `pipeline.ts` 却写 `executor: pipeline` = doctor 报错。
- `defineApp()` 不做了(Q5 采纳单入口方案后作废)。

### 3.3 OS 存储(`hangar.sqlite`,只此 4 表)

```sql
App        (id PK, name, spec_hash, enabled, registered_at)
Run        (id PK, app_id, state, trigger, started_at, ended_at, lock_owner)
RunEvent   (id PK, run_id, seq, kind, payload_json, at)   -- append-only,状态之源
Approval   (id PK, run_id, tool, args_json, status, requested_at, decided_at, decided_by)
```

**OS 永远不知道「邮件」这个概念存在。** 域细节全在 `RunEvent.payload_json`(如 `{kind:"classified", count:12, flagged:2}`)。

### 3.4 Run 状态机(从事件推导,不靠 LLM 自称)

```
queued → running → [waiting_human] → executing → completed
                          ▲                         ├─ failed
                          └──── approve ────────────┘
                                                     └─ cancelled
```

`classify(run)` 读 `RunEvent` 最新事件推出状态:`run.started`→running;`approval.requested`→waiting_human;`approval.granted`→executing;`run.completed/failed`→终态。UI 文案:思考中 / 等你拍板 / 卡住了 / 搞定 / 翻车。

### 3.5 Executor 接口(未来接任何 harness 的插孔)

```ts
interface Executor {
  run(ctx: RunContext): Promise<void>   // 通过 ctx.emit / ctx.propose 产出;抛错 = run failed
}
// v0 唯一实现:PipelineExecutor —— import(`apps/${id}/pipeline.ts`).run(ctx)
```

```ts
interface RunContext {
  input: unknown
  config: Record<string, unknown>          // 来自 spec.config
  logger: Logger                            // pino
  emit(kind: string, payload?: object): void          // 追加 RunEvent
  propose(action: {tool: string; args: object}): void // 走 tool gateway;命中 approval 则 PARK
  tools: ToolGateway                        // 直接执行非高危工具
}
```

### 3.6 Tool Gateway(治理活在这里 · 上收 inbox 的 `executeActions`)

`ctx.propose({tool, args})` →
- `tool ∈ spec.permissions.approval` → 写 `Approval(status=pending)` + `emit("approval.requested")`,**不执行**(PARK);run 结束退出。
- 否则 → 执行(带 retry + error 脱敏,直接搬 inbox `src/actions/{executeActions,retryQueue,redactError}` ~700 行)+ `emit("action.executed")`。

`hangar approve <run>`(CLI 进程内):取该 run 的 pending `Approval` → 逐个执行 → `emit("action.executed")` + `emit("run.completed")` → Approval `status=granted`。

### 3.7 CLI 面(= 控制面 · 遵循你 CLAUDE.md 的 CLI 规范)

```
hangar run <app> [--input …]      手动触发一次 run
hangar status [--json]            所有 app 当前状态一览(读 SQLite)
hangar runs [<app>] [--json]      run 历史
hangar trace <run> [--json]       某 run 的完整事件时间线
hangar approve <run>              执行该 run 的待批动作
hangar reject <run> [--reason …]  驳回待批动作
hangar doctor [--json]            环境自检(node/pnpm 版本、sqlite 可写、apps 目录、各 app.yaml 合法性、pipeline.ts 存在性)
hangar daemon                     启动长驻进程(cron 调度)
```

约定:日志 → stderr,数据 → stdout,`--json` 结构化输出,退出码 0/1/2 语义化。**写操作(run/approve/reject)拒绝 root(EUID==0)**;`doctor` 不拒绝。无参运行 = 打印帮助。

### 3.8 控制面 / SKILL

`SKILL.md`(host-agnostic SOT)描述每条 CLI 的用途 / 参数 / 返回 JSON schema / 错误 kind / Agent 行为约定,并列「不暴露给 Agent 的能力」(如 `hangar daemon` 不该被 CC 误调)。让 Claude Code 照 SKILL 驱动 hangar。**不上 MCP**(你 CLAUDE.md 明列的反模式;CLI + JSON 已够)。

---

## 4. v0 范围(多一样都不许)

**IN**
- `hangar` host(TS 长驻,一个 docker 容器)+ `hangar daemon`
- registry:扫 `apps/*/app.yaml` + zod 校验,`executor` 选方向
- **只一个 executor:`pipeline`**
- scheduler:`node-cron` 读 `triggers`
- OS SQLite:`Run/RunEvent/Approval/App`
- tool gateway:上收 inbox 的 execute+retry+redact;查 approval 名单;发事件
- 审批 PARK:`propose → waiting_human → approve → execute`
- CLI:`run/status/runs/trace/approve/reject/doctor/daemon`(`--json`)
- `SKILL.md`(SOT)

**OUT(附加回条件)**
- `llm-direct`/`claude-code`/`codex` executor → pilot #2 是声明式再加
- 配置 UI → 手改 config 手疼再加
- eval/regression → **留在 inbox 内部**,别当 OS 功能;pilot #2 再谈通用化
- 成本/预算强制 → 某 run 真烧出意外账单再加(v0 只记 `config.budget`,不 enforce)
- 多用户 / RBAC / 租户 → 永不,直到「给别人用」变真赌注
- 通用 durable replay / 中途 checkpoint → 永不,直到某 app 需要非 propose/execute 切点
- MCP / A2A / marketplace / web workbench → Claude Code 就是 workbench

**构建次序**
1. **v0(骨架):** `@hangar/core` + SQLite + registry + `PipelineExecutor` + PARK + CLI + doctor,配一个 **30 行 `apps/heartbeat/`**(`executor: pipeline`,run 里 `emit` 一条 + `propose` 一个假高危动作)。目标:一天内跑通 `run → park → approve → trace → status` 整条链,亲眼见脊柱活着。
2. **v0.1(里程碑):** 迁 `inbox-pilot` → `apps/inbox/`。见 §5。**「每天用」从这里开始计。**

---

## 5. inbox-pilot 迁移备忘

| inbox 现有 | 去向 |
|---|---|
| `src/actions/{executeActions,retryQueue,redactError}` | **上收进 `@hangar/core` tool gateway** |
| `src/config` `src/db` `src/jobs` `src/logger` `src/cli` `src/pipeline` | 由 hangar 脊柱提供,inbox 侧删除 |
| `src/classifier` `src/normalizer` `src/digest` `src/rules` `src/accounts` `src/providers/*` | **留在 `apps/inbox/`**(域逻辑,不进脊柱) |
| prisma + postgres + 邮件域表 | **原封不动**,inbox app 自管(hangar 不碰) |
| classify→act 主流程 | 收敛成 `apps/inbox/pipeline.ts` 的 `run(ctx)`:分类时 `ctx.emit`,`gmail.send` 走 `ctx.propose`(命中 approval → PARK) |
| `src/classifier/eval` | 暂留 inbox 内部,不进 OS |

迁移完成判据:**inbox 作为 `apps/inbox/` 在 hangar host 上按 cron 每天跑,发送邮件走 `hangar approve`,而你每天真在用它。**

---

## 6. 非目标(反 scope 爆炸 · 全职 solo 专用护栏)

hangar **不是**:对话助手 / 工作流画布 / prompt 管理平台 / 面向外部市场的产品 / 通用 durable execution 引擎 / 模型或向量数据库。凡是 inbox-pilot 用不到的能力,**一律不许进脊柱**——这是本项目唯一的硬约束。
