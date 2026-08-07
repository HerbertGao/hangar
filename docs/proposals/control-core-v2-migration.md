# Hangar v2 透明控制核心与渐进迁移架构

> 状态：已接受的架构方向，等待拆分为 OpenSpec 实施规格。
> 决策：2026-08-04，owner 选择立即从 v2 开始；v0 不再作为未来架构候选，只保留为行为 oracle、兼容输入和回滚参照。
> 执行边界：本决策授权从有界 M0/M1 开始，不授权无条件完成整场重写；每个阶段仍受出口闸与止损条件约束。
> 市场边界：这不证明 Hangar 已胜过外部完整方案。LangGraph、LangSmith Fleet、OpenClaw、Hermes
> 仍需作为 benchmark 或 adapter 候选接受同一组透明控制与成本检查。
> SOT 边界：2026-08-04 已归档 v0 SOT，并用 v2 `DESIGN.md`、`ROADMAP.md`、`CLAUDE.md` 与
> `openspec/config.yaml` 取代；历史版本位于 `docs/archive/v0-sot-2026-08-04/`。

## 1. 目的

本文回答两个问题：

1. 如果 Hangar 最终拥有个人 Agent 平台的控制核心，这个核心应长什么样；
2. 当前 `pipeline.ts + 四表 SQLite + CLI` 架构如何迁移过去，而不同时运行两个 scheduler、两个 Run
   事实源或两个 effect owner。

### 1.1 已接受的方向

本轮 Council 与 owner 决策已经关闭“原地扩展 v0 还是新建 v2”的路线分歧：

- **v2 是立即开始的主路线。** 新的 Agent 生命周期、workflow、Control API、effect、knowledge 和多端控制能力
  只进入 v2；
- **v0 不是平行产品路线。** 不为 v0 设计 release、node attempt、knowledge registry 或新的客户端控制面；
- **v0 仍是迁移资产。** 现有测试、事件/终态语义、CLI 契约、旧 pipeline 和历史数据库分别作为 oracle、
  legacy adapter 输入和只读回滚证据；
- **v2-first 不等于 v2-at-all-costs。** M0/M1 无法证明单一 owner、可恢复 effect、可替换 runtime 和最小
  Agent 构筑路径时，必须收窄或停止，而不是继续堆功能；
- **外部候选仍能赢得某个 owner。** 若外部平台通过透明控制硬门且在某个能力上明显更轻、更便宜，Hangar
  应吸收其协议或把该能力留给 adapter，而不是为了“全自研”重复建设。

目标不是保护现有 Hangar 代码。要保护的是已经被测试证明有价值的语义：

- 状态由事件推导，而不是由 Agent 自报成功；
- 终态通过唯一 choke point 闭合；
- 审批、取消、崩溃回收和幂等具有明确语义；
- CLI 对人和机器都有稳定错误、JSON 与退出码；
- 领域状态属于 Agent，控制核心不吸收 `email` 等业务概念。

## 2. 适用范围

### 2.1 本方案包含

- TypeScript-first 的单用户控制核心；
- `AgentSpec → AgentRelease → Activation → Run` 生命周期；
- 可展开的有限 workflow；
- Pi、进程型 Agent 和旧 pipeline 的可替换 runtime adapter；
- typed Control API 及 Web、Telegram、小程序、CLI 的统一入口；
- effect intent、审批、唯一提交者、receipt 与 reconciliation；
- v0 到 v2 的逐 Agent 迁移、回滚和删除路线；
- Inbox 与 Auto Developer 的不同迁移策略；
- 后续按 Agent 注册 Knowledge provider 的边界。

### 2.2 本方案不包含

- 多租户、组织、计费、SSO 或团队权限模型；
- 任意动态图、Temporal 等级的通用 durable workflow；
- 非受信代码的完整 OS、网络和文件系统 sandbox；
- 通用向量数据库或统一知识库产品；
- 对任意第三方 runtime 的永久兼容承诺；
- 因为选择 v2-first 就预先宣布 Hangar 是市场 winner；benchmark 仍可使某个 runtime、knowledge、
  deployment 或 managed-supervision owner 留在外部方案。

## 3. 一句话架构

Hangar v2 是一个轻量的 TypeScript 模块化单体：它把 Agent 定义编译成不可变 release，用显式 workflow 和
append-only Run log 驱动执行，把 Pi 等 runtime 限定为无业务 effect 凭据的可替换执行器，并让所有控制界面通过
同一 typed API 操作同一个状态机。

## 4. 设计原则

### 4.1 只承诺边界，不承诺现有实现

当前 core 可以被整体替换。任何迁移决策都以新契约和 oracle 为准，不以复用代码量为准。

v0 的新增工作只允许服务于 oracle 固化、legacy 兼容、严重正确性/安全修复和最终删除。不得为了降低短期迁移
成本，把 v2 的新概念反向塞入 v0 四表或 `PipelineExecutor`，否则会重新制造一条事实上的平行路线。

### 4.2 单一 owner

一次 activation 中，下列能力分别只能有一个 owner：

- release 与 activation；
- scheduler admission；
- Run identity 与状态转移；
- retry、cancel、resume 与终态；
- 高风险 effect commit；
- 进程树 signal/reap；
- 客户端鉴权和 actor identity。

适配器可以执行，但不能偷偷拥有第二份 Run、session 或 retry 事实源。

### 4.3 TypeScript-first，不等于拒绝其他生态

控制协议、核心状态机、SDK 和主要扩展面使用 TypeScript。Python runtime 可以作为进程适配器存在，但其部署、
IPC、glue LOC、调试时间和资源成本必须被看见。语言桥接不是免费抽象。

### 4.4 模块化单体优先

v2 的首个可用版本由一个 `hangar-server` 进程承载 Control API、scheduler、workflow engine、store 和 effect
gateway；runtime 按 Run 启动受限子进程。Telegram 等有状态 channel adapter 可以是可选边缘进程，但不拥有领域状态。

包边界用于约束依赖方向，不自动意味着服务边界。只有真实隔离或伸缩需求出现时才拆进程。

### 4.5 双读可以，双写不行

迁移期 Web 可以同时展示 v0 历史和 v2 Run，但一个 Agent 在任一时刻只能有一个 admission owner 和一套可写
运行记录。迁移采用逐 Agent cutover，不使用长期双写同步。

## 5. 当前架构资产与限制

### 5.1 可以保留的语义资产

| 当前资产 | 保留原因 | v2 去向 |
|---|---|---|
| `RunEvent` 派生状态 | 防止 Agent 自报成功 | 扩展为带 release/node/attempt identity 的事件流 |
| terminal choke point | 终态、锁释放和未决审批原子闭合 | 新 Run 状态机的唯一终态入口 |
| `Approval` CAS 与 idempotency key | 提供重复审批和崩溃恢复基础 | effect intent/approval/receipt 状态机 |
| PID + start-time fingerprint | 防 PID reuse 造成假存活 | 本地进程 adapter 的 supervisor primitive |
| `AbortSignal` 与 capability snapshot | 取消和运行时能力可协商 | RuntimeRequest 必填字段 |
| CLI JSON、stderr 和退出码 | 是稳定的人/机接口习惯 | typed SDK 上的 CLI client |
| view default-drop/sanitize | 防 trace 默认泄露 | Control API projection policy |
| 现有测试 | 比实现更有迁移价值 | oracle 与 contract test |

### 5.2 不应继续固化的外壳

1. **四表限制。** 新架构需要 release、activation、node attempt 和 effect receipt；为了守旧表数而把它们塞进
   JSON 会失去约束和可查询性。
2. **Opaque pipeline。** 当前 `PipelineExecutor` 只动态加载一个 `run(ctx)`；控制面看不到其内部步骤、预算和
   下一状态。
3. **直接副作用 carve-out。** 当前可信 app 可在 `run()` 中直接执行所谓低风险副作用；这只能算作者纪律，不能
   宣称结构性 effect 治理。
4. **CLI 子进程作为内部 API。** hangar-view 需要重复解析 schema、启动 CLI 并硬编码 inbox whitelist，无法自然
   扩展为多个 typed client。
5. **内存 pending scheduler。** 它适合 Phase 0，但不能成为切换 owner、重启恢复和复杂 Agent 托管的事实源。
6. **app 级单锁即全部并发模型。** 默认 `maxConcurrency=1` 可以保留，但它应是 activation policy，而不是数据模型
   无法表达其他选择。

## 6. 目标架构

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

### 6.1 定义层：Agent Package

一个 Agent Package 是普通目录或 Git 仓库：

```text
agent.yaml
workflow.ts              # 或编译器可静态读取的 workflow.json
prompts/
policies/
fixtures/
evals/
resources/
```

`agent.yaml` 至少声明：

```yaml
apiVersion: hangar.dev/v1alpha1
kind: Agent
metadata:
  id: inbox
  name: Inbox
spec:
  intents: []
  triggers: []
  workflow: ./workflow.ts
  runtimes: {}
  effects: {}
  resources:
    knowledge: []
  concurrency:
    maxRuns: 1
  health: {}
```

源文件是作者真相源，但不能直接 activation。Compiler 必须先生成不可变 `AgentRelease`。

### 6.2 Release 与 Activation

`AgentRelease` 固定：

- AgentSpec 规范化结果；
- workflow graph；
- prompt、policy、fixture 和资源引用 hash；
- runtime adapter id/version 与模型/entitlement 约束；
- effect schema、最低风险和审批策略；
- health/eval 契约；
- 可重建与不可重建部分的声明。

`Activation` 表示“哪个 owner 正在运行哪个 release”：

```ts
interface Activation {
  agentId: string;
  releaseId: string;
  epoch: number;
  status: 'inactive' | 'shadow' | 'active' | 'draining' | 'quarantined';
  schedulerOwner: 'control-core' | `external:${string}`;
  admittedAt?: string;
}
```

release 内容和运行开关分离，避免修改 `enabled` 就生成无法追踪的新执行身份。

### 6.3 Workflow v1

Workflow v1 只支持可以明确解释和测试的节点：

- `code`：确定性 TypeScript 函数；
- `agent`：调用 runtime adapter；
- `effect`：提交结构化 EffectIntent；
- `human`：提出问题或审批并进入显式等待；
- `subflow`：调用有版本的静态子图；
- 有界条件分支和有界顺序 `foreach`。

不支持任意中段内存 checkpoint。只有声明过的 `human`、`effect` 和子图边界可以 durable wait/resume，避免把
任意 JavaScript continuation 伪装成可恢复状态机。

每个 node transition 必须满足：

```text
(run state, node state, event) -> next node state | blocked | terminal error
```

业务成功由 Agent 的 artifact/domain gate 判断；“runtime exit 0”只表示一次技术调用结束。

### 6.4 Runtime Adapter

Runtime adapter 使用一个与 provider 无关的协议：

```ts
interface RuntimeRequest {
  runId: string;
  nodeId: string;
  attempt: number;
  releaseId: string;
  input: unknown;
  contextSnapshot: unknown;
  tools: readonly ToolDescriptor[];
  budget: { requests?: number; tokens?: number; costUsd?: number };
  deadline: string;
  capabilities: readonly string[];
  signal: AbortSignal;
}

interface RuntimeAdapter {
  execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
}
```

RuntimeEvent 可以表达模型输出、工具 query、EffectIntent、usage、checkpoint artifact、provider error 和 terminal
result。Adapter 不得：

- 创建第二个 Hangar Run；
- 在内部静默重试 control-core 已拥有的 attempt；
- 持有 Gmail send、Git publish 等业务 effect 凭据；
- 把外部 session 的成功状态直接映射成业务完成。

Pi 是第一个参考 adapter，不是固定“大脑”。LangGraph 若被采用，也只能在明确 owner 边界下成为 adapter 或外部
完整方案，不能同时拥有同一次 activation 的 Run 状态机。

### 6.5 Effect Gateway

所有需要被平台宣称为“受控”的外部 mutation 都必须经过：

```text
EffectIntent
  -> policy/risk decision
  -> Approval? / automatic allowance
  -> dispatch claim
  -> external call
  -> EffectReceipt(committed | rejected | failed | unknown)
  -> domain reconciliation
```

原则：

- host registry 定义最低风险，Agent 只能收紧；
- gateway 是唯一持有高风险业务凭据的提交者；
- `effectId` 是全链路 idempotency key；
- `unknown` 不自动重提，必须 reconcile；
- effect committed 后领域写失败不能把 Run 简单重跑；
- runtime 或 channel 绕过 gateway 的 mutation 不计入“受控 effect”。

本地可信 code node 仍可能直接访问文件或数据库；这种 Agent 必须标记 `trusted-direct-effects`，并明确不享受上述
结构性保证。该逃生门不能成为默认模板。

#### 6.5.1 外部参照：CloudflareOS Gatekeeper（已评估，暂不采用）

CloudflareOS（cloudflare/cloudflare-os）用 Gatekeeper 处理同一类问题：agent 触发需审批的动作时，Gatekeeper
先在本地**模拟**结果放行 agent 继续执行，真实动作攒起来事后批量/逐条人工审批，用来避免同步审批阻塞 workflow。

这与 Effect Gateway「先 policy/approval 通过才 dispatch」的顺序相反，会破坏「unknown 不自动重提」「effect
committed 后不能靠重跑整个 Run 解决」两条前提——agent 一旦把模拟结果当事实继续往下跑，真实审批被拒时的补偿
路径会更复杂。当前不采用。

如果未来同步审批阻塞确实成为体验瓶颈，可以在 Effect Gateway 内部为低风险 EffectIntent 加一条「乐观本地返回
+ 异步真实 dispatch」的分支，但必须仍收敛到同一个 receipt/reconciliation 状态机，而不是像 Gatekeeper 一样让
agent 基于模拟结果继续做决策。

### 6.6 Typed Control API

Control API 是所有控制面的唯一入口。v1 最小表面：

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

事件流首选 SSE；写命令要求 typed body、actor、idempotency key 和 release/activation 条件。API contract 从同一份
TypeScript/Zod schema 生成 SDK 和 OpenAPI，避免 view、Telegram 和小程序分别重写权限与错误映射。

客户端只负责：

- 身份与 channel-specific UX；
- 渲染 query/event；
- 发出 typed intent、cancel 和 approval decision。

客户端不得直读 SQLite、修改 Agent 文件或自己决定 retry/effect 终态。

### 6.7 Knowledge 边界

Knowledge 在 v1 只定义注册与检索协议，不自建统一向量库：

```yaml
resources:
  knowledge:
    - id: personal-mail-policy
      provider: files
      ref: ./knowledge/mail-policy
      version: sha256:...
      tools: [search, read]
```

Provider 拥有索引、数据权限和更新机制；Release 记录 provider/ref/version。Runtime 只能通过明确 ToolDescriptor
访问，检索输入和结果摘要进入 trace。对无法 pin 的远端知识源，Run 标记实际 revision 或
`non-reproducible`，不能假称完全重放。

## 7. v2 状态与存储

### 7.1 逻辑实体

v2 SQLite 不继续受“四表”限制，初始逻辑实体为：

1. `AgentRelease`：不可变 release 内容与 hash；
2. `Activation`：release、epoch、status、owner；
3. `Run`：agent/release/activation/trigger/actor/terminal summary；
4. `NodeAttempt`：node、attempt、runtime identity、deadline、状态；
5. `RunEvent`：append-only、per-run seq、结构化类型与 payload projection；
6. `Approval`：subject、decision、actor、expiry；
7. `Effect`：intent、claim、external identity、receipt、reconciliation 状态。

精确 DDL 必须在实施 OpenSpec 中由完整状态表反推，不能先画表再补语义。

### 7.2 一致性规则

- `Run` 固定 `releaseId + activationEpoch`；
- `(activation, trigger, scheduledFor)` 唯一，防 scheduler 重复 admission；
- `(run, seq)` 唯一；
- `(run, node, attempt)` 唯一；
- effect dispatch 使用 claim token 和 activation epoch fencing；
- terminal Run 不接受新 node/effect；
- projection 可以重建，append-only event 与 external receipt 不可被 projection 覆盖。

### 7.3 为什么使用新 SQLite 文件

建议 v2 使用独立数据库，而不是原地升级当前四表：

- 旧代码对表数、state、trigger 和 active-lock 有硬编码假设；
- v2 的 release/node/effect identity 无法无歧义回填到旧 Run；
- 独立文件允许旧历史只读、v2 新写，并使回滚边界清晰。

迁移期宿主上可能暂时存在两个 SQLite 文件，但对于某个 Agent：旧库或新库只能有一个可写运行 owner。Web 可
双读聚合；禁止双写同步。

## 8. 建议的包结构

```text
packages/
  contracts/                 # AgentSpec、Control API、events、errors
  control-core/              # compiler、workflow、state machine、admission
  control-store-sqlite/      # v2 repository 与 projection
  control-api/               # HTTP/SSE server
  effect-gateway/            # policy、approval、dispatch、receipt、reconcile
  runtime-pi/                # Pi JSONL/RPC adapter
  runtime-process/           # 进程型 Agent adapter
  runtime-legacy-pipeline/   # v0 pipeline compatibility adapter
  client-sdk/                # Web/Telegram/小程序/CLI 共用类型客户端

apps/
  control-web/
  channel-telegram/          # 可选边缘进程
  heartbeat-v2/
```

所有包默认链接进一个 `hangar-server`。依赖方向为：

```text
clients -> control-api -> control-core -> contracts
                           |       |
                           |       -> effect-gateway
                           -> runtime adapter interfaces
store implementation -> control-core ports
runtime implementations -> contracts only
```

Runtime、client 和 store implementation 不能反向 import control-core 的内部状态机。

## 9. 迁移策略：Strangler，而非原地翻修

### 9.1 总体规则

1. 新能力只进入 v2 packages；v0 只接受 oracle、兼容、严重正确性/安全和迁移阻塞修复；
2. v0 不再参加“未来架构”竞争，但其现有行为仍作为低成本反事实，防止 v2 以复杂度换取并未改善的结果；
3. 先复制测试语义，再选择复用或重写代码；
4. 每次只迁一个 Agent；
5. 每次 cutover 都有 admission barrier、drain、epoch 和 rollback；
6. 兼容 adapter 有删除日期和使用者清单；
7. benchmark 的 clean rebuild 与生产迁移分开，legacy adapter 不得用于两小时挑战得分。

### 9.2 v0 → v2 定义映射

| v0 | v2 |
|---|---|
| `app.yaml id/name` | `metadata.id/name` |
| `enabled` | `Activation.status`，不进入 release 内容 |
| `triggers` | versioned trigger definitions |
| `executor: pipeline` | 单节点 `legacy-pipeline` workflow |
| `permissions.approval[]` | effect policy 的最低审批要求 |
| `tools.ts` | effect handler registry 的临时来源 |
| `config` | release config ref；secret 必须转为 secret ref |
| `ctx.input/trigger*` | typed intent/TriggerSnapshot |
| `ctx.emit` | RuntimeEvent/NodeEvent emitter |
| `ctx.propose` | EffectIntent port |
| `ctx.signal/capabilities` | RuntimeRequest 必填字段 |

### 9.3 LegacyPipelineAdapter 的边界

兼容 adapter 可以加载旧 `pipeline.ts`，但必须把上下文映射到 v2：

- `emit` 写 v2 RunEvent；
- `propose` 写 v2 EffectIntent；
- cancel 由 v2 AbortSignal 驱动；
- v0 `runApp`、旧 gateway 和旧 DB 不参与这次 v2 Run；
- adapter 返回结构化 terminal result，不创建自己的 Run；
- 旧 pipeline 的直接副作用必须列入迁移风险，不能被包装后自动算作 gateway-governed。

如果某个 pipeline 无法在不使用旧 DB/gateway 的情况下运行，应保持在 v0，不能用“双写兼容”掩盖边界错误。

## 10. 交付路线图

路线图按单人开发者配合 AI 工具估算。时间是**主动开发预算上限，不是交付承诺**；超过预算的默认动作是缩小
范围和复查边界，不是自动延长。M0/M1 立即开始，后续阶段只能在前一出口闸通过后进入。

```text
M0 契约/oracle
  -> M1 Heartbeat 纵向切片
  -> M2 Pi + Control API + 两个客户端
  -> M3 Inbox Builder Challenge 与生产迁移
       ├-> M4 Knowledge provider v1
       ├-> M5 Auto Developer process baseline
       └-> M6 v0 退役（迁移与 soak 条件满足后）
```

| 阶段 | 主动开发预算上限 | 可演示结果 | 进入下一阶段的决定 |
|---|---:|---|---|
| M0 | 5 个工作日 | 冻结契约、状态表、oracle 与 effect inventory | 测试能独立评价 v0/v2/外部候选 |
| M1 | 10 个工作日 | Heartbeat 在新 DB 上完成 release→run→effect→terminal | 无旧 DB 写入、无双 owner、故障 fixture 通过 |
| M2 | 10 个工作日 | Pi reference adapter、typed API、Web + 第二客户端 | 两端共享同一控制路径，runtime 可替换 |
| M3 | 10 个工作日，另加 30 天 soak | 两小时内重建 Inbox，并完成 shadow/cutover | Builder 硬门、parity 与 effect 安全门通过 |
| M4 | 5 个工作日 | 每 Agent 可注册 versioned knowledge provider | files provider 可追踪、最小权限、可替换 |
| M5 | 5 个工作日（仅 baseline） | Auto Developer 作为受控顶层进程运行 | 不复制其 supervisor/session owner |
| M6 | 迁移完成后执行 | v0 写路径、daemon、旧 gateway 和 fallback 删除 | 零使用证明、恢复演练、回滚窗口结束 |

M0 + M1 合计超过 15 个主动开发日仍不能跑通最小纵向切片，是第一次架构止损点：暂停 M2，不得用 UI、
知识库或更多 runtime 掩盖核心未闭合。

### Phase M0：冻结契约与 oracle

工作：

- 建立 `packages/contracts`；
- SOT transition 已于 2026-08-04 完成：v0 文档归档，canonical DESIGN/ROADMAP/CLAUDE/OpenSpec config 已切换为 v2；
- 从现有测试提取 run lifecycle、cancel、approval、reaper 与 CLI error oracle；
- 冻结 Inbox parity 和 Auto Developer hosting fixture；
- 给所有 v0 app 建立 direct-effect inventory；
- 定义 v2 state × event 表，但不实现完整平台；
- 把 Council 已接受的 owner 边界拆成 ADR/OpenSpec，并明确每个 package 的依赖方向；
- 冻结 `T_attempt`、`T_ready`、`C_platform`、`C_enable`、glue LOC 和 12 个月 TCO 的记录方式。

出口闸：

- 同一 fixture 可以分别评价 v0、v2 或外部候选；
- 所有终态、unknown effect 和 cutover 状态均有唯一预期；
- oracle 不 import 被测实现的内部状态常量。

### Phase M1：Heartbeat v2 纵向切片

工作：

- 新 SQLite、release compiler、单节点 workflow、RunEvent、effect gateway 最小链；
- fake runtime 证明核心不依赖 Pi；`runtime-legacy-pipeline` 只用于 heartbeat 兼容路径；
- CLI 改成 v2 API client，但保留原命令/JSON/退出码；
- 验证 run → wait/approve → receipt → terminal trace。

出口闸：

- heartbeat 不写旧 DB；
- runtime adapter 可替换为一个 fake adapter，workflow/client/effect 不改；
- crash、cancel、重复 approve 和 unknown effect fixture 通过；
- 删除兼容 adapter 后，核心 contract test 仍可运行。

### Phase M2：Pi、Control API 与两张真实客户端

工作：

- 实现第一个 `runtime-pi` reference adapter，并证明其不拥有业务 effect 凭据或第二份 Run/retry 状态；
- hangar-view 改调 typed API，不再启动 CLI 子进程；
- Web 成为第一个正式 client；
- Telegram 或小程序选择一个作为第二 client；
- 同一 intent 从两端经过同一 actor、policy、Run、approval 和 audit 路径。

出口闸：

- view 删除 inbox 硬编码 command whitelist；
- client 无 SQLite/app.yaml 直读写；
- 第二客户端接入不复制领域分支、retry 或 effect 状态机；
- trace default-drop 和 actor attribution 测试通过。

### Phase M3：Inbox

生产迁移和 Builder Challenge 分开：

1. Builder Challenge 从 clean baseline 生成新的 Inbox AgentRelease，不得调用旧 `run()` 完成核心处理；
2. 新 release 在 shadow 模式处理同一受控输入，但 effect gateway 禁止提交；
3. 比较分类、cursor、dedup、domain commit 与 EffectIntent；
4. 通过 parity 后进入 cutover；
5. 30 天 soak 后归档旧 pipeline。

Inbox 的 cursor、dedup、规则、邮件数据库和业务成功仍属于 Inbox，不迁入 control-core。

### Phase M4：Knowledge provider v1

只实现注册和检索协议，不建设统一向量数据库：

- 先提供 versioned `files` provider，并允许 Inbox 注册自己的 knowledge ref；
- AgentRelease 固定 provider、ref、version 和可用工具；
- runtime 只能经最小权限 `ToolDescriptor` 使用 `search/read`；
- trace 记录查询、实际 revision 和结果摘要；无法 pin 的远端来源标记 `non-reproducible`；
- provider 的索引、ACL、刷新和删除仍由 provider 拥有。

出口闸：

- 第二个测试 Agent 可注册不同知识源而无需修改 control-core；
- 删除或替换 provider 不改变 Run/workflow/effect 状态机；
- runtime 无法绕过 ToolDescriptor 直接取得 provider 凭据；
- knowledge 不可用时产生明确、可恢复的 node failure，而不是静默降级或伪造重放。

### Phase M5：Auto Developer baseline

先采用 `runtime-process`：

```text
Hangar Run
  -> ProcessRuntimeAdapter
  -> existing Auto Developer orchestrator
```

此阶段 Auto Developer 继续拥有 phase/session/watchdog/retry/resume 和后代进程 signal/reap。Hangar 只拥有顶层
trigger、release identity、cancel 请求、结构化观察和最终业务 gate 映射，结果为 `ManagedResult=retain-agent` 或
baseline compatibility。

只有候选 runtime 先独立通过 process-fixture 的父死、late child、partial JSONL、spawn 中取消、TERM→KILL、
ambiguous effect、resume 和双 scheduler 故障后，才允许进行 supervisor atomic cutover。

M5 的五日预算只覆盖 baseline compatibility，不覆盖重写 Auto Developer。若未来要让 Hangar 接管其
session/watchdog/retry/resume/supervisor，必须另开独立的 Managed Runtime change，并先让中立 process fixture
证明新 owner 比现有 supervisor 更可靠。

### Phase M6：删除 v0

满足以下条件才删除：

- 所有 active Agent 已迁移、归档或明确留在外部平台；
- v0 没有 active/parked Run、pending Approval 或 unknown effect；
- v0 DB 已只读归档，历史 trace 有查询入口；
- `runtime-legacy-pipeline` 使用者为零；
- CLI/view 无旧路径 fallback；
- Inbox 至少完成 30 天 soak；
- rollback 窗口结束且备份恢复演练通过。

删除对象包括旧四表写路径、旧 daemon、旧 gateway、view CLI subprocess 和硬编码 command whitelist。

## 11. 单 Agent Cutover 协议

### 11.1 准备

1. 编译并验证 v2 AgentRelease；
2. v2 Activation 设为 `shadow`，禁止业务 effect；
3. 对比 oracle、成本和 trace；
4. 列出旧 Run、Approval、直接副作用和不可重放资源。

### 11.2 Admission barrier

1. 关闭旧 cron 和所有手动 admission；
2. 等旧 active Run 终态；
3. 处理 parked Approval；
4. reconcile 所有 `unknown` 或已提交但领域未确认的 effect；
5. 记录旧 owner 的 final epoch 和 cutover artifact。

`enabled:false` 只停调度、仍允许手动 run，因此不能独自充当 admission barrier。需要移除旧 app registration、关闭
旧 CLI 写入口，或增加一个可证明同时阻断 cron/manual 的迁移闸。

### 11.3 激活

1. v2 Activation epoch 单调增加；
2. scheduler admission 开启；
3. effect gateway 只接受新 epoch；
4. stale schedule/spawn/effect 全部 fail closed；
5. canary 通过后才扩大 trigger。

### 11.4 回滚

1. 关闭 v2 admission；
2. drain v2 Run，并 reconcile effect；
3. 旧 owner 使用更高 epoch 重新激活；
4. 不能重新 dispatch 已 committed/unknown 的 effect；
5. rollback 后重跑 drift/parity eval。

回滚是 owner 再切换，不是两边同时跑。

## 12. 验证矩阵

| 维度 | 最低验收 |
|---|---|
| 透明控制 | `personal-agent-builder.md` §6.3 七项硬门 7/7 |
| TypeScript 适配 | 记录跨 runtime 组件数、glue LOC、`C_enable` 和调试主动时间 |
| 轻量 | clean-host `T_ready`、冷启动、idle/peak RSS、磁盘、进程数 |
| 多端 | 两个真实 client 的同一 intent 经过同一路径 |
| Effect | approval bypass、重复提交、unknown、receipt/domain mismatch fixture 全通过 |
| Run | crash、cancel、retry、resume、cutover、stale epoch、父死终态明确 |
| Inbox Builder | ≤2 小时，原子/加权 ≥98%，category ≥95%，安全门 100% |
| Knowledge | 第二个 Agent 可换 provider；凭据不泄露给 runtime；revision/失败状态可追踪 |
| Auto Developer | process-fixture 先通过；否则保持 `retain-agent` |
| 成本 | 12 个月 TCO 包含平台、Agent 专属 glue、部署、升级、恢复和退出 |
| 路线图预算 | M0 + M1 ≤15 个主动开发日；超限先复查范围，不进入 M2 |
| 可删除性 | legacy adapter、旧 DB 写路径和旧 client fallback 有零使用证明 |

## 13. 主要风险与止损

| 风险 | 早期信号 | 止损动作 |
|---|---|---|
| v2 变成 Temporal 仿制品 | 开始设计任意 checkpoint、分布式队列和无限动态图 | 缩回声明式节点和显式等待边界 |
| 核心纵向切片失控 | M0 + M1 超过 15 个主动开发日仍不能跑通 heartbeat | 暂停后续阶段，删除非必要抽象并重审 state/effect 边界 |
| 兼容层永久化 | 第二个 Agent 仍以 opaque legacy node 上线 | 冻结新增使用者，要求重写或留在 v0 |
| 双 owner | 同一 Agent 两边都能手动 run 或提交 effect | 立即关闭新 activation，先补 admission barrier |
| Effect Gateway 名存实亡 | runtime/code node 普遍持业务 mutation 凭据 | 不宣称受控；迁移凭据或淘汰架构 |
| Typed API 只是 CLI 包装 | client 仍解析 CLI 文本、读 app.yaml | 停止新增客户端，先完成 contract/SDK |
| Builder 只对 Inbox 有效 | 新领域 sealed task 构筑成本无下降 | `BuilderResult=no-winner`，不扩建 UI |
| Managed runtime 只包一层进程 | Auto Developer 仍靠旧 supervisor 通过测试 | 记录 `retain-agent`，停止宣传通用托管 |
| 成本超过外部组合 | 连续两个阶段 TCO/维护时间劣于合格外部候选 | 归档对应 Hangar owner，迁移契约和 oracle |

## 14. 实施前仍需写成 OpenSpec 的内容

本文只给出架构，不足以直接编码。SOT transition 已完成；任何实现仍必须先补：

1. AgentSpec/Release schema 与兼容版本规则；
2. Run、NodeAttempt、Approval、Effect 的穷尽状态转移表；
3. RuntimeEvent 与 Control API 的 typed error algebra；
4. v2 SQLite DDL、事务边界、projection 重建和 migration/backup；
5. admission epoch、scheduler dedup、cutover 和 rollback fixture；
6. legacy adapter 的 direct-effect inventory 与禁止双写测试；
7. heartbeat v2 的固定预算、完成判据和删除条件；
8. M0/M1 的任务拆分、依赖顺序、每项验证命令和阶段 stop-loss。

## 15. 推荐结论

Hangar 已选择立即采用“新 v2 控制核心 + legacy pipeline adapter + 逐 Agent strangler cutover”。不再等待 v0
原地扩展方案，也不在当前四表、CLI 子进程和 opaque `pipeline.run()` 上继续堆未来能力。

迁移应优先保留事件、终态、审批、取消、回收和 CLI 契约的测试语义；数据库、daemon、gateway、view 集成和
PipelineExecutor 都只是可替换实现。第一项 implementation change 应是 `contracts + v2 state machine + heartbeat
legacy adapter`，不是 Pi adapter、可视化 Builder 或 Auto Developer 重写。

因此执行顺序固定为：**先 M0/M1 证明控制核心闭环，再 M2 接 Pi 和真实客户端，再用 M3 Inbox 证明 Builder，
之后才进入 Knowledge 与 Auto Developer。** 任一阶段失败都只否定对应能力或当前抽象，不推导“继续扩建 v0”；
需要时应收窄 v2、替换 adapter，或把某个 owner 留给通过硬门的外部方案。
