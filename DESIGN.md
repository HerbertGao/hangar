# Hangar v2 — 架构 SOT

> 状态：Accepted。2026-08-04 起取代 v0 `DESIGN.md`。
> 详细迁移论证：`docs/proposals/control-core-v2-migration.md`。
> 历史版本：`docs/archive/v0-sot-2026-08-04/DESIGN.md`（见下方「本分支说明」）。
>
> **本分支说明**：`v2` 是从空树重建的分支，只保留 v2 SOT 文档，不含 v0 实现、迁移期代码与
> `docs/archive/`、`SKILL.md`、`openspec/specs/` 等 v0 归档文件。v0 完整实现与历史提交保留在仓库的
> `main`（及其他既有分支），仅作行为参考，本分支不以它们为迁移路径，不会向其合并/变基。

## 0. 一句话

**Hangar 是开发者可完全掌控的个人 Agent Harness 与控制平面：不可变 Release 固定目标、能力和边界，
attempt-bound Harness 让 Agent 或确定性程序在边界内自主推进，Control Core 只接管 durable、安全和外部副作用语义。**

Hangar 不再只是一根无头调度脊柱，也不试图复制 OpenClaw 的整套个人助理体验。它负责 Agent 的定义、发布、
持久身份、受控唤醒、运行、观察、审批、副作用和接入边界；内部推理、领域逻辑、领域数据库、Workspace 内容与
知识源仍归各 Agent/Harness 或 provider 所有。

## 1. 已接受的产品与架构决策

| 决策 | 选择 |
| --- | --- |
| 主路线 | 立即新建 v2；v0 只做行为 oracle、legacy adapter 输入和回滚参照 |
| 用户 | 先服务单个开发者；团队/公司能力以后另立赌注 |
| 核心形态 | TypeScript 模块化单体 `hangar-server` |
| Agent 生命周期 | 持久逻辑身份；`AgentSpec → AgentRelease → Activation → Run → RunAttempt/HarnessSession`，执行进程不常驻 |
| 执行模型 | Harness-first；Harness 拥有 RunAttempt 内部推进，通用 workflow/ProcessSpec 不是当前核心抽象 |
| Workspace | 事实与产物可追加，偏好/推断可审计更新；skill、policy、tool、权限和能力变化形成新 Release candidate |
| Harness | Pi 为首个 reference adapter；确定性程序、进程、legacy pipeline、Python/外部 SDK 都经同一边界 |
| 控制面 | typed Control API 是唯一写入口；Web/Telegram/小程序/CLI 都是 client |
| 副作用 | `EffectIntent → policy/approval → dispatch → ExternalOutcome/reconciliation`（receipt 可选证据） |
| Agent 协作 | Release 版本化注册能力且默认私有；未来跨 Agent intent 经 policy/admission 创建独立 Run，不做 session 直连 |
| 状态库 | v2 使用独立 SQLite；不受 v0 四表限制 |
| 迁移 | 逐 Agent strangler cutover；允许双读，禁止双写与双 owner |
| Knowledge | 每个 Agent 注册自己的 provider；核心只定义注册、权限和检索协议 |
| Auto Developer | 作为现成 Harness/进程故障 oracle；保留其内部 supervisor，不以被 control-core 接管为路线目标 |
| 验证权威 | 每个阶段只由自身OpenSpec requirements/scenarios定义stage acceptance；M1 Heartbeat以`m1-heartbeat-runtime`为唯一语义SOT。M0仅为`NON-AUTHORIZING ADVISORY`，其evaluator universe只有被后续candidate spec显式采用时才成为qualification分母 |

## 2. 架构不变量

违反以下任一项就是架构 bug：

1. **核心零领域概念。** control-core 不得出现 email、mail、repository、slide 等具体业务模型。
2. **不可变发布。** 源码不能直接 activation；必须先编译为有 hash、可审查的 `AgentRelease`。
3. **分层单一 owner。** admission、Run、外层 RunAttempt/restart、durable wait、terminal、Effect commit 与顶层进程树
   containment/reap 各自只有一个 control owner；Harness 只能拥有同一 RunAttempt 内声明过的模型、传输和可逆 action retry。
4. **事件是真相。** Run/RunAttempt 状态与 action graph 由 append-only event 推导；终态只经唯一 choke point 闭合，
   运行后投影不得反向成为执行权威。
5. **显式 durable 边界。** 只在 human、Effect 或具名外部输入边界 wait/resume；checkpoint 只在声明过的边界序列化，
   恢复由新进程/RunAttempt 消费版本化状态，不做任意 continuation replay。
6. **Harness 拥有推进，不拥有控制状态。** Harness 可规划、选工具/subagent、管理上下文与内部 retry；不得创建第二个
   Hangar Run/RunAttempt、提交 terminal、重试 unknown/committed Effect 或把技术成功冒充业务完成。
7. **受控副作用只有一个入口。** 被平台宣称为受控的外部 mutation 必须经过 Effect Gateway；`unknown` 不自动重提。
8. **控制面只有一个契约。** 所有 client 与未来 Agent-to-Agent admission 经 typed Control API；不得直写 SQLite、Agent
   文件或自建外层 retry/effect 状态机。
9. **迁移期不双写。** 一个 Agent 在任一时刻只能有一个可写运行 owner；历史可以双读。
10. **Knowledge 与 Workspace 不是核心数据库。** provider/Agent 拥有索引、ACL、领域事实、更新和删除；Release 固定
    schema、引用、能力与权限，运行期学习不得静默改变 active Release。
11. **模块化单体优先。** 包边界约束依赖方向，不自动拆成微服务。
12. **先改 SOT，再改架构。** DESIGN 与 ROADMAP 先记录决定；M0 validator 只提供 non-authorizing diagnostics。每个阶段的OpenSpec requirements/scenarios是该阶段唯一语义验收SOT；M0 evaluator universe只对显式opt-in candidate生效。实际证据必须来自真实公开接口、fresh SQLite与process boundary。
13. **受限子进程有可验证内容。** Harness、确定性代码与 legacy process 都在凭据剥离、出站/secret 默认拒绝、
    attempt-bound grant 和完整进程树 hard-reap 边界内运行；未完成正向勘验的声明标 `unverified-claim`。
14. **租户不与核心共改。** 租户被契约缺口挡住时阻塞并另开 change，不用 direct-effect 或 Harness escape 绕过。
15. **共享原语要有具名消费者。** 新 ProcessSpec、durable 原语、Suggestion/AgentIntent 协议或 provider 契约进入实现
    前，必须有具名租户、排定阶段与依赖它的出口闸；“先预留”不算。

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
          Run + RunAttempt
                 │
         Harness Adapter boundary
       ┌─────────┼──────────┐
       ▼         ▼          ▼
 deterministic  model loop  existing process
   program      + tools      orchestrator
       └─────────┼──────────┘
        ActionEvent / checkpoint ref
                 │
       human / Effect / external input
                 │
     Approval + Effect Gateway
                 │
      EffectReceipt? / ExternalOutcome
                 ▼
 Domain State / Workspace / Knowledge Provider / Artifact Store
```

首个可用版本由一个 `hangar-server` 进程承载 compiler、Control API、admission、Run/Attempt state、store 和 effect
gateway。Harness 按 RunAttempt 启动受限子进程；Control 保持完整进程树的 containment/hard-reap 能力，但不接管
Harness 内部的 plan、provider session 或逻辑子进程调度。Telegram 等 channel adapter 可以是边缘进程，但不能拥有
Agent 领域状态或第二份控制状态机。受控 schedule 以后作为 trigger owner 加入，不把 Agent 变成长驻推理进程。

## 4. 核心对象

### 4.1 AgentSpec 与 AgentRelease

Agent Package 是普通目录或 Git 仓库，最小包含：

```text
agent.yaml
harness.ts
prompts/
policies/
fixtures/
evals/
resources/
```

`AgentSpec` 是作者真相源，但不能直接运行。Compiler 输出不可变 `AgentRelease`，固定：

- 规范化 AgentSpec、目标/指令与 Harness entry/完整 ExecutionClosure；
- prompt、policy、approved skill、fixture 和资源 hash；
- Harness adapter id/version、模型与 entitlement 约束；
- M0 只固定 required capability/operation id；对外 capability descriptor/schema、默认私有可见性与调用条件由具名自动协作 change 冻结；
- M0 只固定 checkpoint schema/version 与 access-controlled artifact ref；完整 Workspace schema/可写分层由具名 Workspace consumer change 冻结；
- Effect schema、最低风险和审批策略；
- health/eval/outcome 契约（§4.5）；
- knowledge provider/ref/version 与 ToolDescriptor；
- 目标宿主的静态 profile id/digest、所需控制与 probe 定义；当前启动周期的 probe 结果是独立 source fact，
  不进入 release identity。

Agent-owned state 中的事实、观察、产物、偏好和 checkpoint 都不进入既有 release identity。M0 不定义通用 Workspace
写协议；后续协议一旦有具名消费者，任何 skill、policy、tool、权限、能力或对外可见性变化仍只能生成新 Release candidate。

### 4.2 Activation

`Activation` 表示某个 release 是否可以接收 Run，并携带单调 `epoch`、状态与 admission owner。
最小状态为 `inactive | shadow | active | draining | quarantined`。开关不修改 release 内容。M0/M1 只实现 manual/intent admission；schedule series/occurrence 仅冻结身份，scheduler、misfire 与 catch-up typed reject。M3 启用 cron 前必须先有具名 SOT/OpenSpec change。

### 4.3 Run、RunAttempt、HarnessSession 与 RunEvent

- Run 固定 `agentId + releaseId + activationEpoch + trigger + actor/delegation provenance`；
- RunAttempt 是 Control 拥有的外层执行身份，固定 `runId + attempt + Harness/runtime identity + deadline + input checkpoint ref`；
- 每个 RunAttempt 恰有一个 attempt-bound HarnessSession；provider session、phase、subagent 和工具调用属于 Harness
  内部，但必须以带稳定 `actionId + parentActionId` 的结构化事件上报；
- checkpoint 以 access-controlled artifact ref、schema/version、digest 与封闭 obligation kind/subject/owner/generation 进入 source fact；合法 owner handoff 只经不可分支的 CAS successor chain 验证，不内联任意会话或领域正文；
- RunEvent append-only，并以 per-run seq 排序；action graph 是这些事件的可重建投影，不是下一步调度 authority；
- projection 可以重建，外部 receipt、checkpoint artifact 与 event 不能被 projection 覆盖；
- Harness/provider exit 0 只代表技术调用结束，业务成功由 Agent artifact/domain outcome gate 判断。

### 4.4 Approval 与 Effect

Approval 记录绑定 Effect intent/policy/release/epoch 的 subject、可信 actor/delegation provenance、decision 与 expiry。
Effect 记录 intent、claim、external identity、receipt 和 reconciliation 状态。只有 gateway-owned connector 可追加
receipt；Effect dispatch 必须受 single-use claim、当前 actor/delegation、host policy registry floor、release policy 与
activation epoch fencing 保护，未知或不可比较的 policy 组合一律拒绝。

### 4.5 健康契约

`run completed` 只证明 Harness 返回，不证明 Agent 履行了职责；一个 Run 长期零产出也可能是正确行为。因此每个
RunAttempt 至少区分五种终局健康事实，Release 还可声明需要单独观察的 action/tool subject：

- `invoked`：Harness 或声明的 subject 被调用；
- `produced(count)`：产生结果；
- `skipped(reason)`：因空输入、dedup、policy 等跳过；
- `degraded(reason)`：依赖缺失或走了降级路径；
- `failed(error)`：执行失败。

AgentRelease 再声明哪些事实应在多长时间内发生。三类断言各自独立，**不得互相替代**：

- **liveness**：数据源与触发器是否按预期被调用；
- **readiness**：连接器凭据与配置是否可用；
- **outcome**：业务结果多久出现一次。

这样才能区分「今天没有重要邮件」与「邮件源三周没工作」，也能在通知通道从未可用时直接报 readiness 失败，
而不是等 outcome 长期为零才发现。`GET /v1/health`（§8）是这些事实的聚合投影，不是它们的定义。

## 5. Harness-first 执行模型

Hangar 不预编译一个通用步骤图来决定 Agent 的每个下一步。Harness 可以是模型推理循环、确定性 TypeScript 程序，
或现有进程 orchestrator；它在一个 RunAttempt 内决定 plan、上下文、工具/subagent 次序和可逆行动。所有重要动作、
有效 grant、checkpoint、Effect 与 outcome proposal 必须成为结构化事件，运行后可投影出 action graph。

owner 固定如下：

| 语义 | 唯一 owner |
| --- | --- |
| release、activation、admission、Run | Control Core |
| 外层 RunAttempt 创建、restart、cancel、terminal | Control Core |
| plan、context、tool/subagent 选择、provider session | Harness |
| 模型/传输及声明为可逆且未提交的 action retry | Harness（同一 RunAttempt 内） |
| human/Effect/外部输入 wait 与 resume | Control Core 持久化；新 RunAttempt 恢复 Harness |
| capability/grant 签发与撤销 | Control boundary/broker |
| gateway-governed mutation | Effect Gateway |
| 领域状态与业务 outcome gate | Agent/domain package |
| 顶层进程树 containment 与 hard reap | Control Core；Harness 只拥有内部逻辑清理 |

Harness 不得对 unknown 或已 committed 的 Effect 做内部 retry。Control 只有在前一 RunAttempt 已 terminal，containment
已 seal/收敛、旧 grant generation 已撤销、Effect obligation 满足 owner contract 后，才能追加绑定 session/containment/
grant/obligation digest 的 `AttemptQuiesced` fact；下一 Attempt 由同一分配 CAS 消费该 fact，迟到事件或 digest 变化均使
分配失败；AttemptQuiesced 同时 fence 旧 Attempt 的 action/event/EffectIntent/checkpoint/grant/child launch，只有既有 obligation 的 authenticated late outcome 与 Control cleanup 可追加且不得派生工作。checkpoint 只是版本化恢复输入，不授予执行、权限或终态 authority。

通用 ProcessSpec 当前不进入核心。若 Inbox、AI Radar、Auto Developer 三个匹配 pilot 中至少两个证明正确 crash
recovery 必须由平台解释内部依赖，而不是只靠 RunAttempt/checkpoint/action events，才另开 change 加一个可选的粗粒度
ProcessSpec；它不得自动恢复为所有 Agent 的 primary abstraction。

### 5.1 共享原语准入规则

新的 ProcessSpec、durable 原语、Suggestion/AgentIntent 协议或 knowledge provider 契约进入实现前，必须存在具名
租户、排定阶段和依赖它的出口闸。「以后可能会用」「先预留着」不构成消费者。

- Inbox 是统一 Suggestion Center 的具名消费者；M3 先以服务器告警建议做 suggestion-only shadow slice，协议由
  M3 前的独立 change 冻结，不塞入本 M0 change。
- Agent capability directory 与 AgentIntent 的产品方向已接受：Release 版本化声明能力且默认私有，未来 intent 经
  policy/admission 创建独立目标 Run；当前 Inbox MVP 不自动启动 Hostlens，因此本阶段不冻结委派协议。
- `subflow`、node-kind、branch/foreach expansion identity 当前均无核心身份，不在 M0 contracts 中预留。

## 6. Harness Adapter

Harness 协议至少携带 Release/Activation/Run/RunAttempt identity、目标与 trigger input、Workspace/checkpoint refs、
工具、预算、deadline、RuntimeGrants 和 AbortSignal，并返回结构化 Harness/ActionEvent 流。

Adapter 可以在同一 RunAttempt 内规划、压缩上下文、调用 provider session/subagent，并对模型、传输和明确可逆的
未提交 action 做有界 retry；这些行为必须可归因。Adapter 不得：

- 创建自己的 Hangar Run、外层 RunAttempt 或 terminal；
- 在前一 Attempt 仍 live/ambiguous 时启动外层 retry；
- 重试 unknown 或已 committed 的 Effect；
- 持有 Gmail send、Git publish 等高风险业务提交凭据；
- 把 provider session 的完成状态直接映射为业务成功；
- 绕过 ToolDescriptor 读取 knowledge provider 凭据。

Pi 是首个 reference HarnessAdapter，不是固定“大脑”。AgentScope/LangGraph 可作为受边界约束的 SDK adapter 或外部
完整方案；若采用其完整 Service，就必须替代对应 Control owner，不能在 Hangar 上再叠一份 session/schedule/effect
状态机。外部候选必须通过同一 release、grant、effect-unknown、cancel/checkpoint、retry-owner 与 whole-tree-reap fixture。

### 6.1 「受限子进程」的定义与勘验

「受限」指四条**默认拒绝**，缺任何一条都不得称为受限：

1. **凭据剥离启动**：子进程不继承宿主的 secret 环境变量、凭据文件路径与 keychain 句柄；所需凭据只能以
   secret ref 在 release 中声明，由 control-core 经 broker 注入最小集合。
2. **出站默认拒绝**：网络访问按 release 内的 sink destination + operation 放行；只列 destination 不代表允许其
   mutation operation，未列或无法在 credential/broker 层区分的 operation 不可达。
3. **secret 访问默认拒绝**：只能读取 release 中显式授予的 secret ref。
4. **能力显式授予**：能力经 HarnessRequest 的 release/epoch/run/RunAttempt/audience/operation-bound grant 授予，
   未授予、过期或跨 Attempt 重放即不可用；子进程不得访问 control DB 路径/继承描述符、control/admin socket 或
   gateway connector credential。

适用范围是**全部**在子进程内执行的代码：模型驱动 Harness、确定性 Harness、provider/subagent child 和迁移期
legacy process adapter。Harness 可以逻辑管理其内部后代，但 Control 的 OS containment 必须能在 cancel、父死或超时
时 hard-reap 完整进程树；只回收 direct child 不满足本条。

**勘验条件（与定义同等重要）**：每条默认拒绝都必须有目标宿主正向 probe；未通过者标
`unverified-claim`，不计入 §7 的结构性保证。Release 只固定 profile/probe 声明，当前结果是独立 source fact；
production 或 mutation-capable launch 必须使用当前启动周期证据，mutation-disabled evaluator/shadow 才可在未验证时
运行。闭合 grant、ExecutionClosure、环境/描述符隔离、可信 attestation、checkpoint 引用、whole-tree reap 与 anti-replay
的唯一规范由当前 OpenSpec 的 runtime/process requirements 拥有，本 SOT 不复制证明格式。

这四条不是非受信代码的完整 OS/网络/文件 sandbox（§13 明列为非目标）。它们约束的是**受信但可能被外部内容
劫持**的代码：威胁模型的对象不是外部攻击者，而是被 prompt injection 劫持后仍以合法身份调用工具的自身 Agent。

## 7. Effect Gateway

受控 mutation 只有一个提交 owner：gateway 必须先落 durable dispatch identity；缺少可信外部结果时保持
`unknown` 且只做 reconciliation，不得自动重提。高风险提交凭据只在 gateway。M0/M1 production release 的
`trusted-direct-effects` 必须为空；v0 direct mutation 只进入只读 inventory/mutation-disabled fixture。后续阶段若需开放，必须先有具名消费者和独立 SOT/OpenSpec change，冻结 per-operation identity/outcome/recovery，且不得在租户接入 change 中放宽；例外数仍单调不增（§12.4）。

EffectIntent、policy/Approval、claim、dispatch、可选 ExternalReceipt、ExternalOutcome、reconciliation、handoff 与
operation-level enforcement 的唯一规范是 `v2c.effect`、`v2c.direct-effect`、`v2s.source-facts` 和 `v2s.handoff`；
本 SOT 不复制状态枚举或 receipt 映射。

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

TypeScript/Zod schema 同时生成 SDK 与 OpenAPI。写命令必须携带 actor claim、idempotency key 及所需的
release/activation 条件；actor 的权威身份与 delegation provenance 只能由可信控制边界认证后注入，不能信任 client
自报。SSE 是首选事件流；不得让每个 client 重写权限、错误、外层 retry 或 effect 逻辑。

未来 Agent-to-Agent intent 也只能作为已认证 principal 调用同一 admission path：目标 active Release、intent schema、
source visibility、预算与 delegation chain 都在 commit 时校验，并创建独立 Run；不得把两个 HarnessSession 直接相连。
当前 suggestion-only Inbox MVP 不实现这条写路径，具体目录/intent API 由具名后续 change 冻结。

`main` 上的历史 `SKILL.md` 描述已实现 v0 CLI，迁移期只作行为 oracle；本 v2 分支没有该文件，它也不是 v2 API
的架构 SOT。M2 必须用生成的 client contract 建立 v2 CLI，并显式管理 legacy 契约的版本与删除条件。

## 9. Capability Directory 与 Knowledge Provider

Agent capability 与 knowledge resource 是不同协议。AgentRelease 可发布版本化 capability id、intent schema 和可见性；
默认私有，Activation 只暴露该 release 允许发现的描述符。运行中不得扩大可见性或修改 schema；这类变化必须生成
新 Release candidate。目录与 AgentIntent admission 的精确协议按 §5.1 延后，不由 M0 预实现。

Knowledge v1 只定义注册和检索协议，不建设统一向量库：

- AgentRelease 固定 provider、ref、version、工具与权限；
- provider 拥有索引、ACL、刷新与删除；
- Harness 只能经最小权限 `search/read` ToolDescriptor 使用；
- trace 记录查询、实际 revision 和结果摘要；
- 无法 pin 的远端来源标记 `non-reproducible`。

首个实现是 versioned files provider。第二个 Agent 必须能换 provider 而无需修改 control-core。
新增 provider 协议同样受 §5.1 的准入规则约束：没有具名租户与排定阶段就不进本文件。

## 10. 持久化

v2 使用独立 SQLite 文件，初始逻辑实体为：

1. AgentRelease；
2. Activation；
3. Run；
4. RunAttempt；
5. RunEvent/SourceFact；
6. Approval；
7. Effect。

HarnessSession、action graph、health 与 checkpoint metadata 先作为 source facts/projections；M0 不为其预建第二套控制
状态机或通用 session store。精确 DDL 由状态转移表反推。最低一致性规则：

- `Run` 固定 releaseId 与 activationEpoch；
- schedule definition 有跨 activation/epoch 稳定的 series identity，`(agent, scheduleSeries, scheduledFor)` 对应的
  logical occurrence 全局唯一；
- `(run, seq)`、`(run, attempt)` 与 AttemptQuiesced generation 唯一；action 绑定 origin RunAttempt，Effect 以 Run 内
  稳定 intent key/generation 保持跨 Attempt 幂等并保留不可变 first-origin `actionId`；
- terminal Run 不接受新 RunAttempt/EffectIntent/dispatch；已开始 Effect 的合法 late outcome 仍可追加但不派生新工作；
- effect claim 受 epoch fencing；
- projection 可从 event 重建；
- `databaseIdentity` 标识不可变事实链谱系并跨 restore 保留；`controlInstanceId` 标识整个 v2 数据库的一次可写 incarnation，clean restart 仅在独占 continuation proof 与 resume fact 后复用，恢复副本必须区分 source 与新 target，绝不为每个 Agent 创建 control instance；
- backup 必须经过真实 restore 演练；snapshot 自洽不证明外部事实完整。restore 默认 `quarantined`，只有独立、
  单调且不可重放的 recovery evidence 永久关闭旧实例的 authority registration、证明既有 mutation authority 已 fenced、
  dispatch denominator 已完整收敛并取得更高 epoch 才能恢复生产；数据库级 restore-init pending transaction 先预分配
  唯一 RecoverySession/target，并为备份中的全部 Agent 建立共享 target、独立 qualification/epoch；session init/abort
  比较同一外部 generation 且 winner 必须终结全部 loser command。快照后且本地无 dispatch 的操作按不含冲突成员字段
  的稳定 discovery key 与 authenticated ownerAgentId 持久化为具有封闭 outcome/reconciliation lifecycle 且不可 dispatch
  的 RecoveryDiscoveredOperation；跨 Agent/target 归属冲突先由外部 authority fence 全部 consumer，再由各 target 本地 ack；永久失联 target 只可用不可逆 TargetAuthorityClosed proof 替代 ack；
  同一 session/Agent/qualification 只有一个开放 recovery coordination，init/abort/activate 使用正常 command path，bind 后以不可变
  BindingCertificate 固定一次决策，短期 permit 只能为同一 command/target/epoch 与当前 host generation 重签；若
  authenticated outcome 或跨 Agent 归属 conflict 在本地 activation 前获胜，则撤销 permit 并以 binding-invalidated 安全收口，该 Agent 只能在新
  RecoverySession/target 与更高 epoch 上恢复，且不影响同 session 其他 Agent；精确
  source/target binding、有限 denominator、终局证据与 qualification 状态机由 `v2s.restore` 唯一规定。

v0 SQLite 只读归档。迁移期 Web 可以聚合双库历史，但一个 Agent 不得同时向两库写入。

## 11. 迁移与 cutover

v0 新增工作只允许用于 oracle、legacy 兼容、严重正确性/安全修复和删除。新能力只进入 v2。

每个 Agent 的 cutover 必须：

1. 编译并验证 v2 release；
2. 以 shadow activation 运行，清空 gateway grant、`trusted-direct-effects` 与其他 mutation sink 权限；
3. 关闭 v0 cron 与所有手动 admission；
4. drain 旧 Run，处理 parked Approval，并让全部 unknown/冲突 Effect 得到最终 reconciliation；
5. 记录旧 owner final epoch 与全部 mutation authority 的 quiesce/revoke/rotate 证据；
6. 用更高 epoch 激活 v2；
7. effect gateway 拒绝 stale epoch；
8. canary 后扩大 trigger。

回滚是关闭 v2、drain/reconcile，再用更高 epoch 重启旧 owner；不是两边同时跑。`enabled:false` 只停旧调度，
仍允许手动 run，因此不能独自作为 admission barrier。

## 12. 关键集成

### 12.1 Inbox

Inbox 是首个正式 Builder Challenge、生产迁移对象和 Suggestion Center 具名消费者：

- Agent 是持久逻辑身份，但每次扫描是有限 Run；cursor、dedup、规则、阅读行为、邮件数据库和领域成功仍属于 Inbox；
- clean baseline 在 30 分钟～2 小时内产出可审查 AgentRelease，原子/加权功能 ≥98%，category ≥95%，安全门 100%；
- 已验证的低风险 mark-read policy 继续运行；新增主动洞察在首期只生成 Suggestion，不启动 Hostlens、不执行取消续费；
  suggestion-only principal 的唯一写权是 append Suggestion，Control admission、Effect/grant 与 mutation credential 均禁止；
- 第一条 vertical slice 是「服务器告警邮件 → 建议让 Hostlens 检查」；先静默写入统一建议中心，由用户主观决定
  何时开放摘要，目标是高精度、低打扰；
- Observation 只有在具备证据、为何现在重要和明确下一步时才能升级为 Suggestion；同一领域 dedupe key 的建议
  追加证据而不重复建卡，无响应只逐渐降权，显式拒绝有清晰作用域；
- 原始邮件留在 Inbox provider；跨域只持久化最小摘要与可授权 evidence ref；
- Suggestion schema/store/API 由 M3 前独立 change 冻结，shadow parity 通过后才进入 cutover，旧 pipeline 至少保留
  30 天只读/回滚窗口。

### 12.2 Auto Developer

Auto Developer 是现成的 Harness 与进程故障 oracle。`ProcessHarnessAdapter → existing orchestrator` 下：

- Auto Developer 继续拥有 phase/session/watchdog、模型/传输 retry、resume 与内部逻辑子进程调度；
- Hangar 拥有顶层 trigger、release、Run/RunAttempt、cancel、grant/Effect 边界、结构化观察、最终 gate，以及能够在
  父死/超时/cancel 时 hard-reap 完整进程树的 OS containment；
- 两者不得同时拥有外层 retry 或 terminal。通过中立 fixture 只证明 Harness 合格，不以把内部 supervisor 搬进
  control-core 为成功标准。

### 12.3 AI Radar

AI Radar 是第二个真实租户，也是 `C_enable` 是否随租户数下降的第一个证据来源。它按 Hangar Harness 契约重构：

- **交给 control-core**：trigger/admission、不可变 release、外层 Run/RunAttempt、ActionEvent 接收、通知类
  `EffectIntent → approval → claim → dispatch → ExternalOutcome/reconciliation`、typed Control API 与聚合健康事实；
- **仍属于 AI Radar/Harness**：内部阶段/foreach、模型与传输 retry、跨来源去重与唯一索引、采集游标与高水位、
  领域数据库、知识检索以及比价/推荐裁决。control-core 不得出现 news/source/dedup/price 等概念。

通知凭据必须迁入 Effect Gateway，租户进程不再持有；AI Radar 只在 release 声明所需 capability/sink operation，
运行时权限由 control boundary 签发 RunAttempt-bound grants，不另建权限模型。

### 12.4 租户接入纪律

对本节所有租户一律适用：**租户按 Hangar 契约重构，不与 control-core 在同一次变更中同时修改。**
接入被契约缺口挡住时，允许的动作是阻塞并另开 change，不是绕过——`trusted-direct-effects` 或 opaque Harness event
不得成为逃生门。每个租户接入期间「提给 Hangar 的核心变更建议条数」是可数的抽象边界误判次数，进入对应阶段
出口闸。若至少 2/3 参考租户要求平台解释内部依赖才能正确恢复，另开 ProcessSpec change，而不是接入时扩建核心。

## 13. 非目标

当前不做：

- 多租户、组织、计费、SSO、团队 RBAC；
- 面向外部市场的 Agent marketplace；
- 工作流画布、通用 workflow/ProcessSpec 引擎或 prompt 管理平台；
- 长驻推理进程、任意 continuation replay 或 Temporal 等级 durable workflow；
- 把完整 AgentScope/LangGraph Service 包在 Hangar 外再保留重复 session/schedule/effect owner；
- 非受信代码的完整 OS/网络/文件 sandbox；
- 统一向量数据库；
- 因“必须全自研”而复制外部平台已经更好拥有的能力。

Web、小程序、Telegram Bot、CLI 与未来 Agent principal 都是同一控制核心的 client，不属于非目标。

## 14. 验证与止损

任何阶段都必须记录 `T_attempt`、`T_ready`、`C_platform`、`C_enable`、glue LOC 和 12 个月 TCO。
两小时 Agent 构筑只证明 authoring speed，不能替代平台总成本。

以下任一项阻断下一阶段：

- 共享 v0/v2 Run identity、生产双写或双 admission owner；
- outer/inner retry、terminal 或顶层进程树出现双 owner；
- stale epoch mutation、gateway bypass、错误 actor attribution；
- unknown Effect 自动重提或 committed Effect 重复提交；
- projection 无法重建、checkpoint 无法归因、数据库无法恢复、activation 无法回滚；
- M0 中立 fault definitions 未从 owner 冻结的完整 universe/predicate 推导、完整 recoveryRacePoint × disposition 笛卡尔积未逐格绑定唯一 case/typed expected、以 N/A/skip 排除任一格；或 M1+ 候选未在真实执行前冻结适用分母、required case 被排除、适用分母为零、存在漏跑，或超过 5% 无法同时定位 action、有效 grant、checkpoint、Effect 状态与恢复点；任何 capability/effect owner violation 同样阻断；
- Inbox clean build 超过 120 分钟或依赖预置 Inbox 专属 glue；
- M0 + entry + M1 累计达到 15 个主动开发日仍无法闭合 heartbeat；
- 任一租户接入期间，`C_enable` 或「提给 control-core 的核心变更建议条数」超过该阶段出口闸声明的阈值，
  或接入必须向 control-core 新增领域概念。

这些是正确性、进度与需求侧止损。另有一个架构升级触发器：若至少 2/3 参考租户在匹配 fault pilot 中证明
平台不解释内部依赖就无法正确恢复，停止向 tenant Harness 堆补丁并另开可选 ProcessSpec change；在该证据出现前，
不得以预执行路径可见性为由重建通用 workflow engine。

## 15. SOT 关系

- `DESIGN.md`：架构决策与不变量；
- `ROADMAP.md`：实施次序、预算、出口闸和止损；
- `CLAUDE.md`：在仓库中工作的执行护栏；
- `docs/proposals/control-core-v2-migration.md`：完整迁移论证；
- `docs/proposals/personal-agent-builder.md`：产品选择、竞品与硬门依据；
- `openspec/config.yaml`：OpenSpec 生成上下文；
- `main:SKILL.md`：历史 v0 CLI 的迁移期运行契约，只作行为 oracle，直到 v2 client contract 接管；
- `main:openspec/specs/`：已交付 v0 行为的兼容 oracle；本分支无此目录，不能反向覆盖本文件的 v2 架构方向；
- `openspec/specs/`：由外部 `openspec-cn` 管理的 Control/Harness、存储与 evaluator requirement；产品代码与 M0 validator 不解析该目录；
  SOT 保留架构不变量，不复制这些状态机细节。
