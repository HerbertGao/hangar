# Hangar v2 — 架构 SOT

> 状态：Accepted。2026-08-04 起取代 v0 `DESIGN.md`。
> 详细迁移论证：`docs/proposals/control-core-v2-migration.md`。
> 历史版本：`docs/archive/v0-sot-2026-08-04/DESIGN.md`（见下方「本分支说明」）。

> **本分支说明**：`v2` 是从空树重建的分支，只保留 v2 SOT 文档，不含 v0 实现、迁移期代码与
> `docs/archive/`、`SKILL.md`、`openspec/specs/` 等 v0 归档文件。v0 完整实现与历史提交保留在仓库的
> `main`（及其他既有分支），仅作行为参考，本分支不以它们为迁移路径，不会向其合并/变基。

## 0. 一句话

**Hangar 是开发者可完全掌控的个人 Agent 构筑与运行平台：用 TypeScript 快速定义流程式 Agent，用一个透明、
轻量的控制核心托管它们，再通过 Web、小程序、Telegram Bot 或 CLI 操作同一套状态。**

Hangar 不再只是一根无头调度脊柱，也不试图复制 OpenClaw 的整套个人助理体验。它负责 Agent 的定义、发布、
运行、观察、审批、副作用和接入边界；领域逻辑、领域数据库和知识源仍归各 Agent 所有。

## 1. 已接受的产品与架构决策

| 决策 | 选择 |
|---|---|
| 主路线 | 立即新建 v2；v0 只做行为 oracle、legacy adapter 输入和回滚参照 |
| 用户 | 先服务单个开发者；团队/公司能力以后另立赌注 |
| 核心形态 | TypeScript 模块化单体 `hangar-server` |
| Agent 生命周期 | `AgentSpec → AgentRelease → Activation → Run` |
| 流程 | 有限、显式、可展开的 workflow，不做任意 durable JavaScript continuation |
| Runtime | Pi 为首个 reference adapter；进程、legacy pipeline、Python runtime 都经 adapter |
| 控制面 | typed Control API 是唯一写入口；Web/Telegram/小程序/CLI 都是 client |
| 副作用 | `EffectIntent → policy/approval → dispatch → receipt → reconciliation` |
| 状态库 | v2 使用独立 SQLite；不受 v0 四表限制 |
| 迁移 | 逐 Agent strangler cutover；允许双读，禁止双写与双 owner |
| Knowledge | 每个 Agent 注册自己的 provider；核心只定义注册、权限和检索协议 |
| Auto Developer | 先以 process adapter 托管；是否接管其 supervisor 另行资格赛 |

## 2. 架构不变量

违反以下任一项就是架构 bug：

1. **核心零领域概念。** control-core 不得出现 email、mail、repository、slide 等具体业务模型。
2. **不可变发布。** 源码不能直接 activation；必须先编译为有 hash、可审查的 `AgentRelease`。
3. **单一 owner。** 同一 activation 的 admission、Run、retry、terminal、effect commit 和进程回收各自只能有一个 owner。
4. **事件是真相。** Run/Node 状态由 append-only event 推导；终态只经唯一 choke point 闭合。
5. **显式流程。** durable wait 只允许出现在声明过的 human、effect 和 subflow 边界。
6. **Runtime 只是执行器。** Adapter 不创建第二个 Hangar Run，不静默拥有 retry，不把技术成功冒充业务完成。
7. **受控副作用只有一个入口。** 被平台宣称为受控的外部 mutation 必须经过 Effect Gateway；`unknown` 不自动重提。
8. **控制面只有一个契约。** 所有 client 经 typed Control API；不得直写 SQLite、Agent 文件或自建 retry/effect 状态机。
9. **迁移期不双写。** 一个 Agent 在任一时刻只能有一个可写运行 owner；历史可以双读。
10. **Knowledge 是资源，不是核心数据库。** provider 拥有索引、ACL、更新和删除；Release 固定引用与权限。
11. **模块化单体优先。** 包边界约束依赖方向，不自动拆成微服务。
12. **先改 SOT，再改架构。** DESIGN 与 ROADMAP 先记录决定；实现必须有可运行的 contract/fault fixture。

## 3. 系统边界

```text
Web / Mini Program / Telegram / CLI
                 │
          typed Control API
                 │
      AgentSpec Compiler / Registry
                 │
       immutable AgentRelease
                 │
        Activation + admission
                 │
        Workflow Orchestrator
       ┌─────────┼──────────┐
       ▼         ▼          ▼
 deterministic  runtime     human
    code node    adapter     boundary
                 │
       Pi / process / legacy pipeline
                 │
           EffectIntent
                 ▼
     Approval + Effect Gateway
                 │
           EffectReceipt
                 ▼
 Domain State / Knowledge Provider / Artifact Store
```

首个可用版本由一个 `hangar-server` 进程承载 compiler、Control API、scheduler、workflow、store 和 effect
gateway。Runtime 按 Run 启动受限子进程。Telegram 等 channel adapter 可以是边缘进程，但不能拥有 Agent
领域状态或第二份控制状态机。

## 4. 核心对象

### 4.1 AgentSpec 与 AgentRelease

Agent Package 是普通目录或 Git 仓库，最小包含：

```text
agent.yaml
workflow.ts
prompts/
policies/
fixtures/
evals/
resources/
```

`AgentSpec` 是作者真相源，但不能直接运行。Compiler 输出不可变 `AgentRelease`，固定：

- 规范化 AgentSpec 与 workflow graph；
- prompt、policy、fixture 和资源 hash；
- runtime adapter id/version、模型与 entitlement 约束；
- effect schema、最低风险和审批策略；
- health/eval 契约；
- knowledge provider/ref/version 与 ToolDescriptor。

### 4.2 Activation

`Activation` 表示某个 release 是否可以接收 Run，并携带单调 `epoch`、状态与 scheduler owner。
最小状态为 `inactive | shadow | active | draining | quarantined`。开关不修改 release 内容。

### 4.3 Run、NodeAttempt 与 RunEvent

- Run 固定 `agentId + releaseId + activationEpoch + trigger + actor`；
- NodeAttempt 固定 `nodeId + attempt + runtime identity + deadline`；
- RunEvent append-only，并以 per-run seq 排序；
- projection 可以重建，外部 receipt 与 event 不能被 projection 覆盖；
- runtime exit 0 只代表技术调用结束，业务成功由 Agent artifact/domain gate 判断。

### 4.4 Approval 与 Effect

Approval 记录 subject、decision、actor 与 expiry。Effect 记录 intent、claim、external identity、receipt 和
reconciliation 状态。Effect dispatch 必须受 claim token 与 activation epoch fencing 保护。

## 5. Workflow v1

Workflow v1 只支持：

- `code`：确定性 TypeScript 函数；
- `agent`：调用 RuntimeAdapter；
- `effect`：提交 EffectIntent；
- `human`：提问或审批并进入显式等待；
- `subflow`：调用有版本的静态子图；
- 有界条件分支与有界顺序 foreach。

不支持任意动态图、无限循环、任意中段 checkpoint 或通用 durable replay。若需求开始接近 Temporal，应优先把
Temporal/Argo 等作为外部 owner，而不是在 Hangar 内复制它们。

## 6. Runtime Adapter

Runtime 协议至少携带 Run/Node/Attempt/Release identity、input、context snapshot、工具、预算、deadline、
capabilities 和 AbortSignal，并返回结构化 RuntimeEvent 流。

Adapter 不得：

- 创建自己的 Hangar Run 或 terminal；
- 在内部静默重试 control-core 已拥有的 attempt；
- 持有 Gmail send、Git publish 等高风险业务提交凭据；
- 把 provider session 的完成状态直接映射为业务成功；
- 绕过 ToolDescriptor 读取 knowledge provider 凭据。

Pi 是首个 reference adapter，不是固定“大脑”。LangGraph 可以作为受边界约束的 adapter 或外部完整方案，但不
同时拥有同一次 activation 的状态机。

## 7. Effect Gateway

受控 mutation 的唯一合法路径：

```text
EffectIntent
  -> policy / risk
  -> Approval? / automatic allowance
  -> dispatch claim
  -> external call
  -> EffectReceipt(committed | rejected | failed | unknown)
  -> domain reconciliation
```

规则：

- host registry 定义最低风险，Agent 只能收紧；
- gateway 是唯一持有高风险提交凭据的组件；
- `effectId` 是全链路 idempotency key；
- `unknown` 必须 reconcile，不能自动重提；
- effect committed 后领域写失败不能靠重跑整个 Run 解决；
- 本地可信 code node 的直接 mutation 必须标记 `trusted-direct-effects`，且不计入结构性治理保证。

## 8. Typed Control API

最小控制面：

```text
GET  /v1/agents
GET  /v1/agents/:id/releases
POST /v1/agents/:id/intents/:intent
GET  /v1/runs/:id
GET  /v1/runs/:id/events
POST /v1/runs/:id/cancel
POST /v1/approvals/:id/decision
GET  /v1/health
```

TypeScript/Zod schema 同时生成 SDK 与 OpenAPI。写命令必须携带 actor、idempotency key 及所需的
release/activation 条件。SSE 是首选事件流；不得让每个 client 重写权限、错误、retry 或 effect 逻辑。

当前根 `SKILL.md` 继续描述已实现 v0 CLI，供迁移期使用；它不是 v2 API 的架构 SOT。M2 必须用生成的 client
contract 替换或分版本管理该契约。

## 9. Knowledge Provider

v1 只定义注册和检索协议，不建设统一向量库：

- AgentRelease 固定 provider、ref、version、工具与权限；
- provider 拥有索引、ACL、刷新与删除；
- runtime 只能经最小权限 `search/read` ToolDescriptor 使用；
- trace 记录查询、实际 revision 和结果摘要；
- 无法 pin 的远端来源标记 `non-reproducible`。

首个实现是 versioned files provider。第二个 Agent 必须能换 provider 而无需修改 control-core。

## 10. 持久化

v2 使用独立 SQLite 文件，初始逻辑实体为：

1. AgentRelease；
2. Activation；
3. Run；
4. NodeAttempt；
5. RunEvent；
6. Approval；
7. Effect。

精确 DDL 由状态转移表反推。最低一致性规则：

- `Run` 固定 releaseId 与 activationEpoch；
- `(activation, trigger, scheduledFor)` 唯一；
- `(run, seq)` 与 `(run, node, attempt)` 唯一；
- terminal Run 不接受新 node/effect；
- effect claim 受 epoch fencing；
- projection 可从 event 重建；
- backup 必须经过真实 restore 演练。

v0 SQLite 只读归档。迁移期 Web 可以聚合双库历史，但一个 Agent 不得同时向两库写入。

## 11. 迁移与 cutover

v0 新增工作只允许用于 oracle、legacy 兼容、严重正确性/安全修复和删除。新能力只进入 v2。

每个 Agent 的 cutover 必须：

1. 编译并验证 v2 release；
2. 以 shadow activation 运行，禁止业务 effect；
3. 关闭 v0 cron 与所有手动 admission；
4. drain 旧 Run，处理 parked Approval，reconcile unknown effect；
5. 记录旧 owner final epoch；
6. 用更高 epoch 激活 v2；
7. effect gateway 拒绝 stale epoch；
8. canary 后扩大 trigger。

回滚是关闭 v2、drain/reconcile，再用更高 epoch 重启旧 owner；不是两边同时跑。`enabled:false` 只停旧调度，
仍允许手动 run，因此不能独自作为 admission barrier。

## 12. 关键集成

### 12.1 Inbox

Inbox 是首个正式 Builder Challenge 与生产迁移对象：

- clean baseline 在 30 分钟～2 小时内产出可审查 AgentRelease；
- 原子/加权功能 ≥98%，category ≥95%，安全门 100%；
- cursor、dedup、规则、邮件数据库和领域成功仍属于 Inbox；
- shadow parity 通过后 cutover，旧 pipeline 至少保留 30 天只读/回滚窗口。

### 12.2 Auto Developer

第一阶段只采用 `ProcessRuntimeAdapter → existing Auto Developer orchestrator`。Auto Developer 继续拥有
phase/session/watchdog/retry/resume 和后代进程 signal/reap；Hangar 只拥有顶层 trigger、release identity、
cancel、结构化观察和最终 gate 映射。

只有中立 process fixture 证明新 runtime 在父死、late child、partial JSONL、spawn 中取消、TERM→KILL、
ambiguous effect、resume 和双 scheduler 场景都更可靠，才讨论 supervisor atomic cutover。

## 13. 非目标

当前不做：

- 多租户、组织、计费、SSO、团队 RBAC；
- 面向外部市场的 Agent marketplace；
- 工作流画布或 prompt 管理平台；
- 任意动态图和 Temporal 等级 durable workflow；
- 非受信代码的完整 OS/网络/文件 sandbox；
- 统一向量数据库；
- 因“必须全自研”而复制外部平台已经更好拥有的能力。

Web、小程序、Telegram Bot 和 CLI 是同一控制核心的 client，不属于非目标。

## 14. 验证与止损

任何阶段都必须记录 `T_attempt`、`T_ready`、`C_platform`、`C_enable`、glue LOC 和 12 个月 TCO。
两小时 Agent 构筑只证明 authoring speed，不能替代平台总成本。

以下任一项阻断下一阶段：

- 共享 v0/v2 Run identity、生产双写或双 admission owner；
- stale epoch mutation、gateway bypass、错误 actor attribution；
- unknown effect 自动重提或 committed effect 重复提交；
- projection 无法重建、数据库无法恢复、activation 无法回滚；
- Inbox clean build 超过 120 分钟或依赖预置 Inbox 专属 glue；
- M0 + M1 超过 15 个主动开发日仍无法闭合 heartbeat。

## 15. SOT 关系

- `DESIGN.md`：架构决策与不变量；
- `ROADMAP.md`：实施次序、预算、出口闸和止损；
- `CLAUDE.md`：在仓库中工作的执行护栏；
- `docs/proposals/control-core-v2-migration.md`：完整迁移论证；
- `docs/proposals/personal-agent-builder.md`：产品选择、竞品与硬门依据；
- `openspec/config.yaml`：OpenSpec 生成上下文；
- `SKILL.md`：迁移期 v0 CLI 的当前运行契约，直到 v2 client contract 接管；
- `openspec/specs/`：当前已交付 v0 行为的兼容 oracle；各模块的 v2 spec 接管后逐项归档，不能反向覆盖本文件的
  v2 架构方向。
