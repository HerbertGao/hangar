# Hangar v2 Harness-first 控制核心与渐进迁移架构

> 状态：已接受的架构方向；精确 M0 语义已由 `define-v2-control-contracts` OpenSpec change 接管。
> 初始决策：2026-08-04 选择 v2-first；v0 只保留为行为 oracle、兼容输入和回滚参照。
> Harness-first 修订：在 M1 尚未实现时，以 RunAttempt/HarnessSession 取代 workflow/NodeAttempt 主轴；不为旧规划保留沉没成本。
> 执行边界：本决策只授权有界 M0/M1；后续阶段仍受 `ROADMAP.md` 出口闸与止损约束。
> 市场边界：AgentScope、LangGraph、OpenClaw 等仍可作为 Harness SDK、完整 owner 或 benchmark 候选；完整外部 Service 不得与 Hangar 叠加重复 control owner。
> SOT 边界：`DESIGN.md`、`ROADMAP.md`、`CLAUDE.md` 与 `openspec/config.yaml` 是当前权威；本文只解释迁移理由，不复制规范状态机。

## 1. 目的

本文回答两个问题：

1. 如果 Hangar 拥有个人 Agent 平台的控制核心，Agent 自主推进与工程控制应如何分层；
2. 当前 `pipeline.ts + 四表 SQLite + CLI` 如何迁移过去，而不产生两个 admission、两个 Run 事实源、两个 retry/terminal owner 或两个 Effect owner。

### 1.1 已接受的方向

- **v2 是立即开始的主路线。** 新的 Release、Harness、Control API、Effect、Knowledge 与多端能力只进入 v2。
- **Harness-first。** Agent/确定性程序拥有一次 RunAttempt 内的 plan、context、tool/subagent 与内部推进；平台不预编译通用步骤图决定每个下一步。
- **Control 只拥有跨崩溃与安全边界。** admission、Run、外层 RunAttempt/restart、durable wait、cancel、terminal、grant、Effect 与 whole-tree containment/reap 各自只有一个 Control owner。
- **v0 不是平行产品路线。** 不向 v0 设计 release、RunAttempt、knowledge registry 或新客户端控制面。
- **v0 仍是迁移资产。** 现有测试、事件/终态、CLI 契约、旧 pipeline 和历史数据库分别作为 oracle、legacy Harness 输入与只读回滚证据。
- **外部候选仍能赢。** 外部 SDK 可成为 Harness adapter；完整平台若通过同一硬门，可以替代某个 Hangar owner，但不能套在 Hangar 外再保留重复 session/schedule/effect 状态机。
- **通用 ProcessSpec 不是当前地基。** 只有 Inbox、Auto Developer、AI Radar 三个 matched pilot 中至少两个证明正确恢复必须由平台解释内部依赖，才另开可选 ProcessSpec change。

目标不是保护旧代码或旧文档。要保护的是：

- 事件是真相，Agent 不能自报成功；
- 终态只有一个 choke point；
- 审批、取消、外层 retry、崩溃恢复和幂等有明确 owner；
- `unknown` Effect 不自动重提；
- 进程取消/父死可以收敛整棵进程树；
- CLI/API 对人和机器有稳定错误、JSON 与退出码；
- 领域状态与长期行为事实属于 Agent/provider，核心不吸收 `email` 等业务概念。

## 2. 适用范围

### 2.1 本方案包含

- TypeScript-first 的单用户模块化控制核心；
- 持久逻辑 Agent 身份与有限执行：`AgentSpec → AgentRelease → Activation → Run → RunAttempt/HarnessSession`；
- model-led、确定性程序、进程型 Agent 与旧 pipeline 的可替换 Harness adapter；
- parent-linked ActionEvent、实际 runtime/tool/grant 归因与版本化 checkpoint ref；
- typed Control API 及 Web、Telegram、小程序、CLI 的统一入口；
- Effect intent、policy/Approval、唯一提交者、可选 receipt、ExternalOutcome/reconciliation；
- v0 到 v2 的逐 Agent strangler、回滚和删除路线；
- Inbox、Auto Developer、AI Radar 三种不同 tenant/Harness 形状；
- 后续按 Agent 注册 Knowledge provider，以及有具名阶段后再实现 Suggestion/AgentIntent/capability directory。

### 2.2 本方案不包含

- 通用 workflow/ProcessSpec engine、工作流画布或任意 continuation replay；
- 长驻推理进程；Agent 是持久身份，compute/session 由有限 RunAttempt 承载；
- 当前阶段的 Agent-to-Agent 自动执行；M3 Inbox 首期只生成 Suggestion；
- 多租户、组织、计费、SSO 或团队权限模型；
- 非受信代码的完整 OS/网络/文件 sandbox；
- 通用向量数据库；
- 对任意第三方 Harness 的永久兼容承诺；
- 因 v2-first 预先宣布 Hangar 是市场 winner。

## 3. 一句话架构

Hangar v2 是轻量的 TypeScript 模块化单体：不可变 Release 固定目标、执行 closure、能力与安全边界；attempt-bound Harness 在边界内自主推进；append-only facts 记录 action、grant、checkpoint、Effect 与 outcome；Control Core 只接管 durable、安全、外部副作用和进程收敛，并让所有 client 通过同一 typed API 操作同一状态机。

## 4. 设计原则

### 4.1 只承诺边界，不承诺现有实现

当前 core 可以整体替换。迁移以新契约和 oracle 为准，不以复用代码量为准。v0 新增工作只允许服务 oracle、legacy 兼容、严重正确性/安全修复和最终删除；不得把 v2 概念反向塞入 v0 四表或 `PipelineExecutor`。

### 4.2 分层单一 owner

| 语义 | 唯一 owner |
| --- | --- |
| release、activation、admission、Run | Control Core |
| 外层 RunAttempt/restart、cancel、durable wait、terminal | Control Core |
| plan、context、tool/subagent、provider session | Harness |
| 模型/传输及声明为可逆且未提交的 action retry | Harness，同一 RunAttempt 内 |
| capability/grant 签发与撤销 | Control boundary/broker |
| gateway-governed external commit | Effect Gateway |
| 领域状态与业务 outcome gate | Agent/domain package |
| 顶层 OS containment 与 whole-tree hard reap | Control Core |
| Harness 内部逻辑 phase/session/child 调度 | Harness |

Harness 不是“只会调用一次模型的薄 adapter”，但也不是第二个控制面。它不能创建 Hangar Run/RunAttempt、提交 terminal、重试 `unknown`/committed Effect 或持有高风险提交凭据。

### 4.3 TypeScript-first，不拒绝其他生态

Control contract、核心状态机、SDK 和首个 Harness 使用 TypeScript。Python/Java SDK 可以通过进程/协议 adapter 使用，但部署、IPC、glue LOC、调试与资源成本必须进入 `C_enable`/TCO。

AgentScope 的启发是“模型主导内部推进，Harness 提供 context/tools/permissions/events/recovery”，不是删除所有确定性工程边界。当前官方成熟实现主要在 Python/Java；TypeScript 适配与 owner fencing 仍需同 fixture 资格赛。若完整 AgentScope Service 自己拥有 session、schedule、state 与 permissions，应在对应范围替代 Hangar，而不是形成双控制面。

### 4.4 模块化单体优先

首个版本由一个 `hangar-server` 承载 compiler、Control API、admission、Run/Attempt state、store 与 Effect Gateway。Harness 按 RunAttempt 启动受限子进程。包边界约束依赖方向，不自动拆服务；只有真实隔离或伸缩需求出现时才拆进程。

### 4.5 双读可以，双写不行

迁移期 Web 可以同时展示 v0 历史和 v2 Run，但一个 Agent 同时只能有一个 admission owner 和一套可写运行记录。迁移采用逐 Agent cutover，不使用长期双写同步。

## 5. 可保留资产与应删除外壳

### 5.1 可保留的语义资产

| 当前资产 | 保留原因 | v2 去向 |
| --- | --- | --- |
| `RunEvent` 派生状态 | 防止 Agent 自报成功 | 带 release/RunAttempt/action identity 的 source facts |
| terminal choke point | 终态与清理原子闭合 | 新 Run 状态机唯一终态入口 |
| `Approval` CAS/idempotency | 重复审批与恢复基础 | Effect policy/Approval/claim/outcome |
| PID + start-time | 防 PID reuse | containment root identity 的组成部分 |
| `AbortSignal`/capability snapshot | 取消与能力协商 | HarnessRequest/RuntimeGrant 必填边界 |
| CLI JSON、stderr、退出码 | 稳定人机契约 | generated SDK 上的 CLI client |
| view default-drop/sanitize | 防默认泄露 | Control API projection policy |
| 现有测试 | 比实现更有迁移价值 | adapter-neutral oracle/fixture |
| Auto Developer supervisor | 已证明内部 agent loop/phase 可收敛 | Harness 内部 owner 与 process fixture oracle |

### 5.2 不再固化的外壳

1. **四表限制。** v2 需要 Release、Activation、RunAttempt、SourceFact、Approval 与 Effect 的独立约束。
2. **静态 DAG/NodeAttempt 主轴。** 它让平台预先解释租户推进，并把 phase identity 铸进存储；当前没有 2/3 tenant 证据。
3. **Opaque pipeline。** 可以作为 legacy Harness，但必须输出 ActionEvent/checkpoint/effect/outcome，不能只给一个 exit code。
4. **直接副作用 carve-out。** 未经 gateway 的 mutation 不能被包装后宣称为受控。
5. **CLI 子进程作为内部 API。** client 必须消费 typed SDK/API。
6. **内存 pending scheduler。** 它不能成为 owner handoff 与恢复事实源；M0/M1 不实现 schedule execution。
7. **把 Auto Developer supervisor 搬进核心。** 内部 owner 工作正常时，标准化边界比复制实现更小、更可靠。

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
 Domain State / Agent-owned State / Knowledge / Artifact Store
```

### 6.1 Agent Package

```text
agent.yaml
harness.ts
prompts/
policies/
fixtures/
evals/
resources/
```

`AgentSpec` 是作者真相源，但不能直接 activation。Compiler 先生成不可变 `AgentRelease`。M0 Release 固定 Harness entry/ExecutionClosure、goal/instructions、prompt/policy/approved skill、runtime/model constraints、required capability/operation、checkpoint schema、Effect/health/eval、Knowledge descriptors 与 host profile。Agent-owned mutable state、偏好/推断、checkpoint body、probe 与 recovery evidence 不进入 release identity。

对外 capability registration/schema/visibility 与完整 Workspace write protocol 已作为产品方向接受，但当前无实现阶段消费者，不在 M0 预建字段；必须由具名后续 change 冻结。

### 6.2 Release 与 Activation

`Activation` 表示某个 release 是否可以接收 Run，并携带单调 epoch、状态与 admission owner。最小状态仍为 `inactive | shadow | active | draining | quarantined`。Release 内容与运行开关分离。M0/M1 只实现 manual/intent admission；schedule identity 可冻结，但 scheduler/misfire/catch-up 保持 typed unsupported，启用前另开具名 change。

### 6.3 RunAttempt、HarnessSession 与 ActionEvent

Run 固定 Agent、Release、Activation epoch、trigger 和 actor/delegation provenance。Control 分配单调 RunAttempt；每个 Attempt 恰有一个 HarnessSession。Provider session、phase、subagent 和内部 retry 不成为 Hangar aggregate，但重要 action 必须先注册稳定 `actionId`，并以 parent-linked ActionEvent 上报实际 runtime/tool、有效 grant、artifact ref 与 outcome。

Action graph 是 source facts 的可重建投影，不是 scheduler。Harness 可以动态决定下一步，也可以完全确定性执行。

### 6.4 Checkpoint、retry 与进程边界

Checkpoint 只持久化 access-controlled artifact ref、schema/version、digest、producer Attempt/action，以及封闭的 obligation kind/subject/owner/generation ref；合法 owner handoff 只认不可分支的 CAS successor chain。它不包含 secret、任意会话正文或 program counter，也不授予 authority。Resume 总是创建新 RunAttempt。

Control 只有在前一 Attempt 已终结、containment 已 seal 并静默、旧 grant generation 已撤销，且旧 Effect 已 final 或由明确 wait/reconciliation owner 持有时才能 retry。它先追加绑定 session/containment/grant/obligation digest 的 `AttemptQuiesced` fact，再由新 Attempt 分配事务原子消费；该 fence 拒绝旧 Attempt 的全部派生写入/launch，只放行既有 obligation 的不可调度 late outcome 与 Control cleanup，任何 digest 变化使分配失败。Harness 的模型/传输/可逆 action retry 只发生在同一 Attempt 内并可观察。

每个 Harness 在 dedicated OS containment 内启动。Harness 拥有内部逻辑调度与 graceful cleanup；Control 必须在 cancel、timeout 或父死时独立 hard-reap 完整 descendant tree。只能杀 direct child 的 host 不具备 production 结构性保证。

### 6.5 Effect Gateway

```text
EffectIntent
  -> policy/risk
  -> Approval? / automatic allowance
  -> single-use dispatch claim
  -> durable dispatch-started
  -> external call
  -> authenticated EffectReceipt?
  -> ExternalOutcome / reconciliation
```

`intentKey` 在 Run 内稳定，Effect identity 绑定 `(runId, intentKey, intentGeneration)` 并保留 first-origin action。Checkpoint/retry 后的等价 replay 返回既有 Effect。`unknown` 不自动重提；只有 final not-committed 后，Harness 才能显式提高 generation 并重新经过 policy/Approval。

Gateway 是 gateway-governed mutation 的唯一提交者；高风险凭据只在 gateway。Receipt 仅在存在时作为证据；ExternalOutcome/reconciliation 才是收敛事实。Direct mutation 是显式 exception，M0/M1 production list 必须为空。

### 6.6 Typed Control API

所有 client 通过同一 TypeScript/Zod contract 生成的 SDK/OpenAPI 发出 intent、cancel 与 approval decision。写命令携带可信 actor、idempotency key 和 release/epoch 条件；SSE 提供事件流。Client 不读写 SQLite/Agent 文件，也不拥有 outer retry、Effect 或 terminal。

未来 Agent-to-Agent intent 也必须走同一 admission path，创建独立目标 Run；不得直接连接两个 HarnessSession。当前 Inbox MVP 只产生 Suggestion，不实现该路径。

### 6.7 Knowledge、Suggestion 与能力目录

Knowledge provider 拥有索引、ACL、更新与删除；Harness 只得到最小 `search/read` ToolDescriptor。无法 pin 的来源记录实际 revision 或 `non-reproducible`。

M3 前另开 Suggestion change，冻结统一建议中心的 generic envelope、Observation→Suggestion 门、evidence ref、dedupe/revision、feedback scope 与 TTL。Suggestion-only principal 唯一写权是 append Suggestion；Control admission、Effect/grant 与 mutation credential 均负向禁止。首期只做“服务器告警邮件 → 建议让 Hostlens 检查”的静默 shadow，不自动创建 Hostlens Run，也不执行取消续费。

Capability directory 的方向是：各 AgentRelease 版本化注册能力且默认私有；具体 schema/visibility/admission 等到具名自动协作阶段再定义。

## 7. v2 状态与存储

初始逻辑实体：

1. `AgentRelease`；
2. `Activation`；
3. `Run`；
4. `RunAttempt`；
5. `RunEvent/SourceFact`；
6. `Approval`；
7. `Effect`。

HarnessSession、ActionEvent、checkpoint metadata 与 health 先作为 facts/projections，不建第二 control state machine。精确 DDL 由中文 OpenSpec specs 反推。

架构层固定：

- Run 绑定 immutable release/epoch；
- `(runId, attempt)`、action、checkpoint、Run-wide Effect identity 唯一；
- terminal 后拒绝新 Attempt/action/EffectIntent/dispatch；合法 late outcome 不派生新工作；
- projection 从全局有序、hash-chained SourceFacts 重建；
- `databaseIdentity` 保留事实谱系，`controlInstanceId` 标识一次可写 incarnation；
- restore 默认 quarantined；数据库级 restore-init 只建一个 RecoverySession/target，并为备份内全部 Agent 建立独立 qualification/epoch；session init/abort 比较同一外部 generation 并终结 loser command；RecoveryAuthority 永久关闭旧实例的新 mutation-authority registration；快照后外部操作按稳定 discovery key + authenticated ownerAgentId 成为具封闭 lifecycle 且不可 dispatch 的 RecoveryDiscoveredOperation，归属冲突 fence 所有 consumer；跨 target 以本地 ack 或不可逆 TargetAuthorityClosed proof 收敛；完成有限 denominator 后，以不可变 BindingCertificate 固定普通 activation 决策，短期 permit 只为同一命令/current host 重签，bind 后 outcome/Agent-binding 冲突只走 permit revoke + binding-invalidated 收口；
- read-only validation 不创建 SQLite sidecar。

v2 使用独立 SQLite 文件。迁移期可双读两个库，但某个 Agent 只能有一个可写 owner。

## 8. 建议包结构

```text
packages/
  contracts/                 # Release、RunAttempt、Harness/Action events、errors
  control-core/              # compiler、admission、Run/Attempt/terminal
  control-store-sqlite/      # source facts 与 projections
  control-api/               # HTTP/SSE
  effect-gateway/            # policy、approval、dispatch、outcome/reconcile
  harness-pi/                # Pi reference Harness
  harness-process/           # existing process orchestrator adapter
  harness-legacy-pipeline/   # v0 pipeline compatibility
  client-sdk/

apps/
  control-web/
  channel-telegram/
  heartbeat-v2/
```

依赖方向：

```text
clients -> control-api -> control-core -> contracts
                           |       |
                           |       -> effect-gateway
                           -> Harness ports
store implementation -> control-core ports
Harness implementations -> contracts only
```

Harness、client 与 store implementation 不反向 import control-core 内部状态机。

## 9. 迁移策略：Strangler，而非原地翻修

### 9.1 总体规则

1. 新能力只进入 v2；
2. 先复制测试语义，再选择复用或重写；
3. 每次只迁一个 Agent；
4. 每次 cutover 都有 admission barrier、drain、epoch 与 rollback；
5. 兼容 Harness 有删除条件与使用者清单；
6. clean rebuild benchmark 与生产迁移分开；
7. 租户接入与 control-core 不在同一 change 中共改。

### 9.2 v0 → v2 映射

| v0 | v2 |
| --- | --- |
| `app.yaml id/name` | AgentSpec metadata |
| `enabled` | `Activation.status` |
| `triggers` | versioned trigger definitions；执行 schedule 另开 change |
| `executor: pipeline` | `harness-legacy-pipeline` |
| `permissions.approval[]` | Effect policy 最低审批要求 |
| `tools.ts` | 暂时的 tool/Effect adapter 来源 |
| `config` | release config/artifact ref；secret 转 SecretRef |
| `ctx.input/trigger*` | typed intent/TriggerSnapshot |
| `ctx.emit` | HarnessEvent/ActionEvent emitter |
| `ctx.propose` | EffectIntent port |
| `ctx.signal/capabilities` | HarnessRequest/RuntimeGrant |

### 9.3 Legacy Pipeline Harness 边界

兼容 Harness 可以加载旧 `pipeline.ts`，但：

- `emit` 写 v2 source facts；
- `propose` 写 v2 EffectIntent；
- cancel 由 v2 AbortSignal/containment 驱动；
- v0 `runApp`、旧 gateway 和旧 DB 不参与该 v2 Run；
- adapter 不创建 Run/RunAttempt/terminal；
- 旧直接副作用必须进入 inventory，包装后不自动算 gateway-governed。

无法脱离旧 DB/gateway 的 pipeline 保持在 v0；禁止双写兼容。

## 10. 交付路线导航

精确阶段、预算、出口闸与止损只读 `ROADMAP.md`：

```text
M0 Harness/control contracts + oracle
  -> M1 Harness Heartbeat
  -> M2 Pi Harness + typed API + clients
       └-> M7 AI Radar Harness
  -> M3 Inbox Builder + suggestion shadow + cutover
       ├-> M4 Knowledge provider
       ├-> M5 Auto Developer Harness qualification
       └-> M6 retire v0
```

M0+M1 的 15 个主动开发日是首个止损点。M5 没有 supervisor takeover 后继阶段。M3/M5/M7 汇总 ProcessSpec 证据；不足 2/3 时禁止以 shared-core graph workaround 接入租户。

## 11. 单 Agent Cutover

### 11.1 准备

1. 编译并验证 v2 AgentRelease；
2. shadow Activation 清空 gateway/direct mutation grant；
3. 对比 oracle、成本、action attribution 与 outcome；
4. 列出旧 Run、Approval、mutation authority 和不可重放资源。

### 11.2 Admission barrier

1. 关闭旧 cron 和所有手动/intent admission；
2. 等旧 Run 终态并收敛进程树；
3. 处理 parked Approval；
4. 让全部 `unknown`/conflicted Effect 进入最终 reconciliation；
5. 记录旧 owner final epoch 与 mutation authority quiesce/revoke/rotate 证据。

`enabled:false` 只停调度，不足以阻断手动 Run。

### 11.3 激活

1. 新 Activation 使用更高 epoch；
2. admission 只在新 owner 开启；
3. Effect Gateway 拒绝 stale epoch；
4. stale trigger/spawn/grant/dispatch 全部 fail closed；
5. canary 后扩大 trigger。

### 11.4 回滚

1. 关闭 v2 admission；
2. drain v2 Run/Attempt 并 reconcile Effect；
3. 旧 owner 使用更高 epoch 激活；
4. 不重新 dispatch committed/unknown Effect；
5. 重跑 drift/parity/attribution eval。

回滚是 owner 再切换，不是两边同时运行。

## 12. 验证矩阵

| 维度 | 最低验收 |
| --- | --- |
| Owner | admission/outer retry/terminal/Effect/containment 无重叠；Harness inner retry 可观察 |
| 透明度 | 分母由 owner-frozen universe/predicate 推导，完整 recovery race 笛卡尔积逐格绑定 typed expected/required gate 且不允许 N/A/skip，required case 不可排除、非零且无漏跑；fault case 可定位 action/grant/checkpoint/Effect/recovery；opaque rate ≤5%，boundary violation=0 |
| Process | 父死/cancel/timeout 无 orphan；目标 host 正向证明 whole-tree containment/reap |
| Effect | approval bypass、重复提交、unknown、post-final conflict、receipt/domain mismatch 全通过 |
| Run | crash、cancel、checkpoint resume、terminal race、stale epoch 唯一预期 |
| Restore | database/source/RecoverySession/共享 target、per-Agent qualification、独立 authority、快照后 operation facts、有限 denominator、bound-permit/binding-invalidated、最终 outcome 与 anti-replay |
| TypeScript | 跨 Harness glue LOC、`C_enable` 与调试主动时间被记录 |
| 多端 | 两个 client 的同一 intent 经过同一 Control path |
| Inbox | `T_attempt ≤120min`、原子/加权 ≥98%、category ≥95%、安全门 100%；建议首期 suggestion-only |
| Auto Developer | 内部 supervisor 保留；Harness/containment fixture 通过，否则 `retain-external-harness` |
| Knowledge | 第二 Agent 可换 provider，凭据不泄露，revision/失败可追踪 |
| 成本 | 12 个月 TCO 包含平台、tenant glue、部署、升级、恢复和退出 |
| 删除性 | legacy Harness、旧 DB 写路径和 client fallback 有零使用证明 |

## 13. 风险与止损

| 风险 | 早期信号 | 止损动作 |
| --- | --- | --- |
| Harness 变成黑盒 | 只能读私有 session store 才能解释故障 | 阻断资格；补 ActionEvent/grant/checkpoint 映射，不把私有 store 变核心真相 |
| 双 retry owner | Control 在 live/ambiguous session 时创建 Attempt | 立即停止外层 retry，修复 AttemptQuiesced 单事务消费 |
| Checkpoint 伪装 continuation | 内联会话/program counter，或 obligation owner/generation/successor chain 无法验证 | 拒绝 checkpoint，缩回 artifact ref + explicit boundary |
| Effect Gateway 名存实亡 | Harness 持业务 mutation 凭据或重试 unknown | 取消 production 资格，迁移凭据并 reconcile |
| Whole-tree 只是口号 | 只能杀 direct child 或依赖 tenant cleanup | 标 `unverified-claim`，仅允许运行 mutation-disabled fixture |
| 过早重建 ProcessSpec | 为一个租户向核心加 phase/node | 阻塞接入；等 2/3 matched evidence 后另开 change |
| 外部 Service 形成双控制面 | Hangar 与框架都持 session/retry/effect 状态 | 选择一个 owner：只用 SDK Harness，或由完整平台替代 Hangar 对应范围 |
| 核心纵向切片失控 | M0+M1 超过 15 个主动开发日 | 暂停 M2，删除非必要抽象 |
| 兼容层永久化 | 第二个 Agent 仍只输出 opaque terminal | 冻结新增使用者，重写 Harness contract 或留在外部/v0 |
| Restore bind 后卡死 | permit 过期或证据冲突后无法关闭 coordination | 过期只重签同一 decision；冲突撤 permit 并以 binding-invalidated 双阶段收口 |
| Typed API 只是 CLI 包装 | client 仍读 app.yaml/CLI 文本 | 停止新增 client，先完成 contract/SDK |
| Builder 只对 Inbox 有效 | 新 tenant 的 `C_enable` 不降 | 停止扩建 Builder/UI，复审平台价值 |
| 成本超过外部组合 | 连续阶段 TCO/维护时间劣于合格候选 | 归档对应 Hangar owner，迁移协议/oracle |

## 14. OpenSpec 接管

M0 的 Control/Harness、存储与 evaluator 语义由以下中文 specs 唯一拥有：

- `specs/v2-control-contracts/spec.md`；
- `specs/v2-storage-contract/spec.md`；
- `specs/m0-evaluation-oracles/spec.md`。

任务、验证命令与 stop-loss 由同 change 的 `tasks.md` 拥有。本文不复制状态枚举、DDL 或 restore proof。M0 artifacts 通过出口闸后，另开 M1 implementation change。

## 15. 推荐结论

Hangar 选择“新 v2 Harness/control core + legacy Harness + 逐 Agent strangler”，不再等待 v0 原地扩展，也不构建通用 workflow engine。第一项 implementation slice 是：

```text
contracts
  -> Run/RunAttempt state machine
  -> v2 SQLite
  -> fake Harness
  -> action/effect/checkpoint-resume/terminal Heartbeat
```

Pi、UI、Knowledge 与真实租户不能先于该闭环。任一阶段失败只否定对应抽象；可收窄 v2、替换 Harness，或把某个 owner 留给通过硬门的外部平台，不推导“继续扩建 v0”。
