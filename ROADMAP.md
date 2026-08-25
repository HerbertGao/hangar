# Hangar v2 — ROADMAP

> 状态：Active。2026-08-04 起取代 v0 路线图。
> 规则：每个阶段都有主动开发预算、可演示交付物、出口闸和止损；闸不过，不进入下一阶段。
> 历史版本：`docs/archive/v0-sot-2026-08-04/ROADMAP.md`（该文件不在本分支，见 `README.md`「本分支说明」）。

## 当前进度（2026-08-25）

- M0：`NON-AUTHORIZING ADVISORY` 保持 READY，但不授权 candidate/production；
- M1：Heartbeat v2 纵向切片已完成并归档；
- M2：Pi Harness、typed Control API、CLI、Web 与 Telegram client 已通过出口闸，39/39 tasks 完成，主 specs 已同步，
  归档于 `openspec/changes/archive/2026-08-25-implement-m2-pi-control-slice/`；
- 下一步：创建独立 M3 提案，先冻结 Suggestion Center 的通用契约与 suggestion-only negative authority，再规划 Inbox
  Builder Challenge/shadow/cutover；schedule occurrence/misfire/catch-up 继续由另一具名 change 拥有。

M2 stage acceptance 不提升 candidate/production qualification（均保持 `false`），也不自动授权 M3 实现。

## 总路线

```text
M0 SOT / Harness contracts / oracle
  -> M1 Harness Heartbeat v2 vertical slice
  -> M2 Pi Harness + Control API + Web + second client
       └-> M7 AI Radar Harness 接入
  -> M3 Inbox Builder Challenge + suggestion shadow + cutover
       ├-> M4 Knowledge provider v1
       ├-> M5 Auto Developer Harness qualification
       └-> M6 retire v0
```

M3 Inbox、M5 Auto Developer 与 M7 AI Radar 是三个 reference tenant/Harness，也是 `C_platform` 摊销和可选
ProcessSpec 是否必要的唯一证据来源。它们共用一条纪律：**租户按 Hangar 契约重构，不与 control-core 同时修改**；
被契约缺口挡住时只能阻塞并另开 change，不得绕过。每次接入的 `C_enable`、核心变更建议条数、fault attribution 与
是否需要平台解释内部依赖都进入出口闸。

| 阶段 | 主动开发预算上限 | 可演示结果 | 出口 |
| --- | ---: | --- | --- |
| M0 | 原预算5日；advisory handoff保守实耗上界6日 | v2 SOT、Harness/control contracts、状态表和冻结 oracle bundle | 定义分母完整、内部一致且可供后续候选执行 |
| M1 | entry最多1日；实施剩余最多8日（累计day15硬上限） | 新 DB 上完成 release→RunAttempt→action→effect/resume→terminal | 无旧 DB 写入、无双 owner、fault fixture 通过 |
| M2 | 10 个工作日 | Pi Harness、typed API、Web 与第二 client | 两端共享一个控制路径，Harness 可替换 |
| M3 | 10 个工作日 + 30 天 soak | 两小时内重建 Inbox，完成 suggestion shadow 与 cutover | Builder、parity、suggestion/effect 安全门通过 |
| M4 | 5 个工作日 | 每 Agent 注册 versioned knowledge provider | 第二 Agent 可换 provider，权限与 revision 可追踪 |
| M5 | 5 个工作日 | Auto Developer 通过 Harness/containment 资格赛 | 保留内部 supervisor；外层 owner 与 whole-tree reap 闭合 |
| M6 | 迁移完成后 | 删除 v0 写路径、daemon、旧 gateway/fallback | 零使用、恢复演练、回滚窗口结束 |
| M7 | 10 个工作日 + 30 天 soak | AI Radar 以 tenant Harness + gateway owner 边界运行 | 领域状态仍归 AI Radar；不共改；回滚演练通过 |

时间是范围预算，不是承诺。超过预算先删范围、查边界，不自动延长。

## M0 — SOT、契约与 oracle

### 目标

把 v2 的方向变成可实现、可反驳的协议，同时冻结 v0 中真正值得保留的行为。M0 输出固定为 `NON-AUTHORIZING ADVISORY`：只记录 definitions、diagnostics 与 known gaps，不授权 M1、production 或 candidate qualification。

### 任务

> 实施状态只由对应 OpenSpec change 的 tasks 拥有；本节不维护第二份复选框。

- 归档 v0 的 DESIGN、ROADMAP、CLAUDE 和 OpenSpec config；
- 建立 v2 canonical SOT；
- 建立第一个 v2 OpenSpec change；
- 定义 AgentSpec、AgentRelease、Activation、Run、RunAttempt、HarnessSession/Event、checkpoint ref、Approval、Effect
  的类型与 Requirement-ID authority-owner validation；
- 写出 Activation、Run、RunAttempt、Approval、Effect 的穷尽 state × event 表和 typed error algebra；
- 冻结 outer/inner retry、durable wait/resume、ActionEvent attribution、checkpoint obligation/successor handoff chain、AttemptQuiesced 统一派生写入/launch fence 与 whole-tree containment owner；
- 定义 v2 SQLite DDL、database/source/数据库级 RecoverySession/target identity、clean-restart continuation、zero-row CAS、全局 source-fact 顺序、projection rebuild，以及含 session init/abort 单 CAS、per-Agent qualification、旧实例 registration closure、authenticated Agent-bound RecoveryDiscoveredOperation、跨 target conflict ack/TargetAuthorityClosed、BindingCertificate 与 binding-invalidated 收口的 restore；
- 从 v0 测试提取 run lifecycle、terminal、cancel、approval、reaper、CLI contract oracle；
- 建立 Inbox parity fixture 与 Auto Developer Harness/process fixture；
- 清点所有 v0 direct effects 与业务凭据；
- 冻结 `T_attempt/T_ready/C_platform/C_enable`、glue LOC 与 TCO 的采集方式。

### 出口闸

- oracle bundle 不 import 被测实现的内部常量；
- 每个终态、unknown Effect、cutover crash point 都有唯一预期定义；
- 每个 scenario 具备唯一 required coverage class、applicability、case 与 expected public observation；M0 只验证这些定义闭合，不运行 test-side 候选状态机。M1 Heartbeat 必须从冻结 bundle 推导适用分母，并经真实产品/public SQLite/process path 执行；M0 fixture、自报 observation 或 test receipt 不能补票；
- contracts 不包含通用 workflow、node-kind、NodeAttempt、branch/foreach expansion 或 `subflow` identity；
- fault-case definition denominator 从 owner 冻结的完整 universe/predicate 推导，required case 不可排除，且每项都定义 action、有效 grant、checkpoint、Effect 状态与恢复点的所需公共观察；适用分母非零、无漏跑、不可归因率 ≤5% 与 owner/effect boundary violation 为 0 由 M1+ 真实候选执行出口验证；
- DESIGN §6.1 每条默认拒绝、whole-tree hard reap、Harness/runtime、host-attestation 与 release-identity 的 launch/closure/attestation probe definition 完整；实际目标宿主的正向 probe 与 qualification 在 M1+ 执行，未验证宿主只能跑 mutation-disabled evaluator；
- 每条 M0 语义有全局唯一 Requirement ID，task/oracle/SOT 只引用 ID、不重复定义；
- versioned aggregate-gate manifest 对所有 Requirement/scenario、closed dimension、subcommand 与 external validator 一一闭合；41/244/233/88 作为 definition gates 汇总为 565 个冻结定义成员，完整 recoveryRacePoint × disposition 笛卡尔积每格有唯一 case/typed expected，N/A/skip 不移出分母；只有 typed aggregate owner 可输出 `M0 advisory: READY`，且该 token 永远 non-authorizing；
- DESIGN、ROADMAP、CLAUDE、OpenSpec config 相互无冲突。

### 止损

五个主动开发日后仍无法写清 state/effect/cutover 契约：停止设计更多包，缩回最小
`Release → Activation → Run → Event → Effect`。

## M1 — Harness Heartbeat v2 纵向切片

### 目标

不用 Pi、Inbox 或 UI，证明 v2 Control + Harness 边界本身能闭环。

### 任务

> 实施状态只由对应 OpenSpec change 的 tasks 拥有；本节不维护第二份复选框。

- 在首行产品代码前完成并 review 一个 ≤1 active developer-day entry artifact：完整 known-gap ledger、每项职责恰一 owner、禁止写边、M0+M1 累计预算、M1 observation/failure obligations；entry不构成conformance，PASS只激活已记录的 `USER-M1-AUTH-2026-08-22`。
- Entry通过后按已记录的条件授权建立 `packages/contracts`、`control-core` 与 `control-store-sqlite`，无需第二次授权；
- 以 `m1-heartbeat-runtime` 的全部 requirements/scenarios作为Heartbeat stage acceptance唯一语义SOT，并逐项用真实package public API、fresh SQLite facts/rows、真实process或可审查fail-closed guard确认；M0 evaluator universe未被本stage采用，不自动扩大分母；
- 编译一个不可变 Heartbeat AgentRelease；
- 实现 fake HarnessAdapter：接收目标、产生带 parent/action identity 的动作，并调用一个只读工具；M1 不实现
  workflow engine、scheduler/misfire/catch-up；
- 让 fake Harness 提交一个 EffectIntent，在显式边界产出带 obligation owner/generation 的 checkpoint ref；Control
  等待外部结果、提交并原子消费 AttemptQuiesced 后创建新 RunAttempt，Harness 从该 checkpoint resume 并提交 outcome proposal；
- 完成 RunEvent/SourceFact、action graph projection 与唯一 terminal choke point；
- 完成最小 Effect Gateway：intent、approval、claim、dispatch、可选 receipt、ExternalOutcome/reconciliation；
- 增加 legacy process Harness 的 heartbeat 兼容 fixture；
- 覆盖 crash、cancel、重复 approve、stale epoch、unknown Effect、checkpoint resume、whole-tree reap 与 restore。

### 出口闸

- entry artifact 已通过，且已记录的 `USER-M1-AUTH-2026-08-22` 条件授权已因此生效；M0 advisory、fixture、receipt 或 token 未被用于补票；
- Heartbeat 不写 v0 DB、不调用 v0 gateway、不共享 v0 Run identity；
- fake 与 legacy Harness 可互换，client/store/effect/terminal owner 不改；
- Harness 不创建外层 RunAttempt/terminal，不持高风险业务凭据，不重试 unknown/committed Effect；
- 前一 Attempt 未 terminal、containment/grant 未 fence，或 AttemptQuiesced/obligation digest 未由分配 CAS 原子消费时，Control 不创建下一 Attempt；quiescence 后旧 Attempt 的 EffectIntent/checkpoint/child launch 等派生输入全部拒绝；
- scheduled admission 保持 typed unsupported，不创建 scheduler/cursor；
- action/grant/checkpoint/effect/recovery attribution可从公开facts与真实process证据审查，projection可重建，备份可恢复；
- `m1-heartbeat-runtime` 中每个Requirement/Scenario均由允许类别的精确证据满足，strict、固定M1/M0检查与fresh CR+RC通过；不得用M0 token/fixture/TAP/digest补票，也不生成scenario registry；

### 当前 observation 状态

Heartbeat stage acceptance只由`m1-heartbeat-runtime`拥有；6.1/6.2仅可在逐项证据、固定检查与fresh双lane review全部通过后关闭。关闭stage不改变candidate/production qualification（均保持false）；此前及此后都不得用M0 advisory补票。M2 planning只能在这两个任务关闭后开始；该前置已随M1归档满足。

### 止损

M0 + entry + M1 累计达到 15 个主动开发日仍不能跑通：暂停 M2，删除非必要 abstraction。不得用 UI、Knowledge 或更多
runtime 掩盖核心未闭合。

## M2 — Pi Harness、Control API 与两个客户端

### 目标

证明 Hangar + Pi Harness 可替换，并从两个真实界面控制同一个状态机。

### 任务

> 状态：Completed。实施进度由已归档 OpenSpec change 的 39/39 tasks 拥有；本节仅保留范围清单，不维护第二套复选框。

- 实现 `harness-pi` reference adapter；
- 实现 typed HTTP/SSE Control API；
- 从同一 Zod schema 生成 TypeScript SDK 与 OpenAPI；
- 用生成的 SDK 建立 v2 CLI facade，保留 JSON/退出码习惯；
- hangar-view 改为 API client，不再启动 CLI 子进程；
- Telegram Bot 作为第二 client；
- 实现 actor attribution、idempotency key 与 projection policy；
- 保留迁移期 legacy CLI，标记版本和删除条件。

### 出口闸

- Pi Harness 不拥有第二份 Run、外层 RunAttempt/retry 或 terminal；
- Web 与第二 client 的同一 intent 经过同一 policy、Run、approval 和 audit 路径；
- client 不读写 SQLite 或 Agent 文件（包括 `agent.yaml` 与 legacy `app.yaml`）；
- view 中的 Inbox command whitelist 被删除；
- Pi Harness 可替换为 fake，client、Control、store 与 Effect 不改。

## M3 — Inbox Builder Challenge 与迁移

### 目标

证明 Hangar 能在 30 分钟～2 小时构筑一个接近完整 Inbox 的 Agent，并安全接管真实运行。

> 状态：Proposal preparation。当前没有活跃 M3 change；必须先完成 Suggestion 协议提案与 review，才可开始实现。

### Builder Challenge

- [ ] 从 clean baseline 计时；
- [ ] 不得调用旧 `run()` 完成核心处理；
- [ ] 产出不可变、可审查 AgentRelease；
- [ ] `T_attempt ≤120min`；
- [ ] 原子/加权功能 ≥98%，category ≥95%，安全门 100%；
- [ ] 单列 `T_ready`、`C_platform`、`C_enable`、glue LOC 和 TCO。

### Suggestion shadow 与生产迁移

- [ ] 在实现建议前另开具名 Suggestion change，冻结通用 envelope、Observation→Suggestion 门、evidence ref、
  domain dedupe key、append-only revision、反馈作用域、TTL/降权、保留与统一建议中心 API；
- [ ] 该 change 必须冻结 suggestion-only principal 的负向能力：唯一写权是 append Suggestion；禁止 Control admission、
  EffectIntent、gateway/runtime mutation grant 与 mutation credential，并以带 provenance 的负向 fixture 覆盖所有输出路径；
- [ ] 第一条 vertical slice 固定为「服务器告警邮件 → 建议让 Hostlens 检查」；只写入 shadow 建议中心，不自动
  创建 Hostlens Run，也不执行取消续费；
- [ ] 保留现有低风险 mark-read policy，并证明新增建议推理不能扩大其 mutation authority；
- [ ] 原始邮件留在 Inbox provider；建议只保存最小摘要与受控 evidence ref；
- [ ] 同一 dedupe key 合并证据，无明确下一步的模式只记 Observation；无响应逐渐降权，显式拒绝写入选定作用域；
- [ ] 由用户人工决定何时从静默试运行开放摘要，不以单一指标自动 promotion；目标保持高精度、低打扰；
- [ ] 在启用 cron 前另开具名 schedule change，冻结 occurrence/misfire/catch-up/cursor 语义与 oracle；
- [ ] v2 shadow 处理受控相同输入，禁止未授权 Effect；
- [ ] 比较分类、cursor、dedup、domain commit、Suggestion、EffectIntent 与 trace；
- [ ] 关闭 v0 cron 与手动 admission，drain Run/Approval/Effect；
- [ ] 以更高 activation epoch cutover；
- [ ] canary 后扩大 trigger；
- [ ] 完成 30 天 soak。

### 出口闸

- Builder Challenge 全部硬门通过；
- 没有双 admission、双写、stale epoch 或重复 Effect；
- Inbox 领域状态、阅读行为和原始邮件仍留在 Inbox/provider；
- suggestion-only slice 的 principal/provenance 证明除 append Suggestion 外无写权；Agent-to-Agent admission、Effect/grant、
  mutation credential 与自动外部 action 的全部尝试均类型化拒绝，重复建议合并且证据可追溯；
- 用户明确决定是否开放摘要；rollback 演练通过。

## M4 — Knowledge provider v1

### 目标

让每个 Agent 注册自己的知识源，同时保持 provider 可替换、权限最小、来源可追踪。

### 任务与出口

- [ ] 实现 versioned files provider；
- [ ] AgentRelease 固定 provider/ref/version/tools；
- [ ] runtime 只经 `search/read` ToolDescriptor 访问；
- [ ] trace 记录 query、revision 与结果摘要；
- [ ] 无法 pin 的远端来源标记 `non-reproducible`；
- [ ] 第二个测试 Agent 使用不同 provider，control-core 零修改；
- [ ] provider 不可用时产生明确、可恢复的 Harness/action failure。

## M5 — Auto Developer Harness qualification

### 目标

证明现有 Auto Developer 可作为 Harness 接入，而不是把其已工作的内部 supervisor 搬进 control-core。

### 任务

- [ ] `ProcessHarnessAdapter → existing Auto Developer orchestrator`；
- [ ] 映射顶层 trigger、release、Run/RunAttempt、cancel、ActionEvent/checkpoint、grant/Effect 与 final gate；
- [ ] 保留 Auto Developer 对 phase/session/watchdog、模型/传输 retry、resume 和内部逻辑子进程调度的 ownership；
- [ ] 由 Hangar containment 在不复制内部 supervisor 的前提下 hard-reap 完整进程树；
- [ ] 跑父死、late child、partial JSONL、cancel during spawn、TERM→KILL、ambiguous Effect、resume、
  double-scheduler 与 overlapping outer-retry fixture。

### 出口闸

- Hangar 没有复制内部 supervisor、provider session 或内部 phase state；
- Auto Developer 不创建 Hangar 外层 Attempt/terminal，Hangar 不与 live/ambiguous session 重叠 retry；
- 失败、cancel、checkpoint 与 action/grant/effect attribution 满足全程硬门；
- 父死/超时/cancel 后无 orphan，whole-tree containment 可独立勘验；
- 不合格时明确记录 `managed-result: retain-external-harness`。

M5 没有后续“supervisor 接管”阶段。只有未来至少两个 Harness 证明同一更细粒度 runtime owner 既必要又更可靠，
才可另开独立 SOT/OpenSpec change；Auto Developer 单一消费者不能为通用 takeover 提供正当性。

## M6 — v0 退役

只有全部条件满足才执行：

- [ ] 所有 active Agent 已迁移、归档或留在外部平台；
- [ ] v0 没有 active/parked Run、pending Approval 或 unknown effect；
- [ ] v0 DB 已只读归档且历史 trace 可查；
- [ ] legacy pipeline adapter 使用者为零；
- [ ] CLI/view 无旧 fallback；
- [ ] Inbox 完成 30 天 soak；
- [ ] rollback 窗口结束，backup/restore 演练通过。

删除旧四表写路径、旧 daemon、旧 gateway、view CLI subprocess 与 hard-coded command whitelist。

## M7 — AI Radar Harness 接入

前置：M2 出口闸通过（typed Control API 已是唯一写入口）。不依赖 M3。

### 目标

让 AI Radar 成为控制面的第二个真实租户：**发布身份、外层运行、结构化观察与高风险副作用交给 Hangar，内部
推进与领域仍归 AI Radar Harness**。它是第一个证明 `C_enable` 会随租户数下降的对象。

### 边界（必须写死，否则等于把领域概念吸进核心）

- **交给 Hangar**：trigger/admission、不可变 release、外层 Run/RunAttempt、ActionEvent 接收、飞书/Telegram 推送的
  `EffectIntent → approval → claim → dispatch → ExternalOutcome/reconciliation`、单一 typed 控制入口与聚合健康事实。
- **仍归 AI Radar/Harness**：阶段/foreach、模型与传输 retry、跨来源去重与唯一索引、采集游标与高水位、
  Postgres 领域状态、RAG/知识检索、比价与推荐裁决。control-core 不得出现 news/source/dedup/price 一类概念。

### 任务

- [ ] 把 AI Radar 现有流水线包装为 tenant Harness；内部顺序/foreach 不翻译成平台 ProcessSpec；
- [ ] BullMQ 的定时链改为 Hangar trigger + activation；AI Radar 侧只保留领域任务队列（若仍需要）；
- [ ] 推送凭据迁入 Effect Gateway，AI Radar 进程不再持有飞书/Telegram 提交凭据；
- [ ] 现有 egress fail-closed 自检映射为 release 所需 capability/sink operation，再由 control boundary 生成
  RunAttempt-bound grants；
- [ ] shadow 运行：处理同一受控输入但禁止提交 Effect，比对分类、去重、推送基数、ActionEvent 与 trace；
- [ ] 记录 `T_ready`、`C_enable`、glue LOC、「提给 Hangar 的核心变更建议条数」与是否需要平台解释内部依赖。

### 出口闸

- 领域状态、内部推进与业务裁决仍在 AI Radar/Harness，control-core 零领域概念；
- 每次运行可定位 release、RunAttempt、实际 Harness/runtime/model/tool、action/grant/checkpoint/effect 身份；
- 所有推送经 gateway 提交，`effectId` 全链路幂等，`unknown` 进 reconcile 不自动重提；
- **不共改**：接入期间 AI Radar 与 control-core 没有出现在同一个变更里；被契约缺口挡住时阻塞并另开 change；
  `trusted-direct-effects` 标注点数量未增加；
- 「提给 Hangar 的核心变更建议条数」≤ 3（超出即说明抽象边界画错）；
- 完成 30 天 soak：零未解释 Effect，每个 dispatch 恰有一个最终 ExternalOutcome/reconciliation，receipt 可为 0 或 1；
- 回滚演练通过：关闭 Hangar admission 后，AI Radar 能以自有调度恢复且不重复提交已 committed 推送；
- 汇总 Inbox/Auto Developer/AI Radar matched pilots：仅当至少 2/3 证明正确恢复必须依赖平台解释内部依赖时，
  才允许提出可选 ProcessSpec change。

### 止损

`C_enable` > 5 个主动开发日，或「提给 Hangar 的核心变更建议条数」> 3，或接入必须向 control-core 新增领域
概念——任一成立即暂停 M7，先复审抽象边界，不得靠扩建核心让接入通过。

## 全程硬门

- admission、Run、外层 Attempt/restart、durable wait、terminal、Effect 与 whole-tree reap 各自单一 owner；
- Run/RunAttempt/ActionEvent/Effect 状态可解释，fault attribution 不可归因率 ≤5%；
- Harness 内部 retry 不与 Control 外层 retry 重叠；
- Effect Gateway 无绕过，unknown/committed Effect 不被 Harness 或 Control 自动重提；
- production-active / business-effect execution 的目标宿主在当前启动周期内通过 DESIGN §6.1 全部正向勘验；
- no production dual-write；
- TypeScript client/Harness 边界稳定；
- 两个真实 client 共用一个控制路径；
- 轻量指标持续记录：冷启动、idle/peak RSS、磁盘、进程数；
- restore 只凭 snapshot 不得恢复生产；必须通过 `v2s.restore` 的数据库级 RecoverySession/共享 target 与 per-Agent qualification、
  独立 recovery authority、旧实例 registration closure、稳定 discovery-key 且具封闭 lifecycle/不可 dispatch 的快照后 operation facts、跨 target 本地 ack 或 TargetAuthorityClosed proof、有限 authority/dispatch denominators、最终 ExternalOutcome/reconciliation、BindingCertificate/binding-invalidated、单调 epoch 与 anti-replay 闸，否则保持 quarantined；
- 外部 Harness/完整平台候选按相同透明控制、故障 fixture 与 12 个月 TCO 继续 benchmark。

## 明确不在当前路线

多租户、团队 RBAC、计费、SSO、marketplace、工作流画布、通用 ProcessSpec、长驻推理进程、Agent-to-Agent 自动
执行、通用向量库、任意 continuation/durable workflow、完整不可信代码 sandbox。需要其中任何一项时，先建立具名
消费者、独立赌注和出口闸。
