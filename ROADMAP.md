# Hangar v2 — ROADMAP

> 状态：Active。2026-08-04 起取代 v0 路线图。
> 规则：每个阶段都有主动开发预算、可演示交付物、出口闸和止损；闸不过，不进入下一阶段。
> 历史版本：`docs/archive/v0-sot-2026-08-04/ROADMAP.md`（该文件不在本分支，见 `README.md`「本分支说明」）。

## 总路线

```text
M0 SOT / contracts / oracle
  -> M1 Heartbeat v2 vertical slice
  -> M2 Pi + Control API + Web + second client
       └-> M7 AI Radar 租户化接入
  -> M3 Inbox Builder Challenge + cutover
       ├-> M4 Knowledge provider v1
       ├-> M5 Auto Developer process baseline -> M8 Auto Developer supervisor 接管
       └-> M6 retire v0
```

M7 与 M8 是第二、第三个真实租户，也是 `C_platform` 摊销的唯一证据来源。两者共用一条纪律：
**租户按 hangar 的契约重构，不与 control-core 同时修改**；接入被契约缺口挡住时只能阻塞并另开 change，
不得绕过。每个租户接入期间「提给 hangar 的核心变更建议条数」是可数的边界误判次数，进入其出口闸。

| 阶段 | 主动开发预算上限 | 可演示结果 | 出口 |
|---|---:|---|---|
| M0 | 5 个工作日 | v2 SOT、contracts、状态表和冻结 oracle | 测试可独立评价 v0/v2/外部候选 |
| M1 | 10 个工作日 | 新 DB 上完成 release→run→effect→terminal | 无旧 DB 写入、无双 owner、fault fixture 通过 |
| M2 | 10 个工作日 | Pi adapter、typed API、Web 与第二 client | 两端共享一个控制路径，runtime 可替换 |
| M3 | 10 个工作日 + 30 天 soak | 两小时内重建 Inbox 并完成 shadow/cutover | Builder、parity、effect 安全门通过 |
| M4 | 5 个工作日 | 每 Agent 注册 versioned knowledge provider | 第二 Agent 可换 provider，权限与 revision 可追踪 |
| M5 | 5 个工作日，仅 baseline | Auto Developer 作为受控顶层进程运行 | 不复制其 supervisor/session owner |
| M6 | 迁移完成后 | 删除 v0 写路径、daemon、旧 gateway/fallback | 零使用、恢复演练、回滚窗口结束 |
| M7 | 10 个工作日 + 30 天 soak | AI Radar 以 hangar 为编排与副作用 owner 运行 | 领域状态仍归 AI Radar；不共改；回滚演练通过 |
| M8 | 10 个工作日 | control-core 拥有 Auto Developer 受管进程树的生命周期 | 中立 fixture 先过；P5 凭据入 gateway；epoch 回滚完整 |

时间是范围预算，不是承诺。超过预算先删范围、查边界，不自动延长。

## M0 — SOT、契约与 oracle

### 目标

把 v2 的方向变成可实现、可反驳的协议，同时冻结 v0 中真正值得保留的行为。

### 任务

- [x] 归档 v0 的 DESIGN、ROADMAP、CLAUDE 和 OpenSpec config；
- [x] 建立 v2 canonical SOT；
- [ ] 建立第一个 v2 OpenSpec change；
- [ ] 定义 AgentSpec、AgentRelease、Activation、Run、NodeAttempt、Approval、Effect 的类型；
- [ ] 写出穷尽 state × event 表和 typed error algebra；
- [ ] 定义 v2 SQLite DDL、事务边界、projection rebuild 与 backup/restore；
- [ ] 从 v0 测试提取 run lifecycle、terminal、cancel、approval、reaper、CLI contract oracle；
- [ ] 建立 Inbox parity fixture 与 Auto Developer process fixture；
- [ ] 清点所有 v0 direct effects 与业务凭据；
- [ ] 冻结 `T_attempt/T_ready/C_platform/C_enable`、glue LOC 与 TCO 的采集方式。

### 出口闸

- oracle 不 import 被测实现的内部常量；
- 每个终态、unknown effect、cutover crash point 都有唯一预期；
- v0 与 v2 可运行同一组适用 fixture；
- **contracts 中的 node-kind 枚举不超出 `DESIGN.md` §5 的允许集合**——以一条只读断言检查，防止
  「orchestrator 尚未交付」与「分类已在 M0 固化并向下约束状态机与存储形状」同时为真；
- 每条 §6.1 默认拒绝都已声明其在目标宿主上的正向勘验方式；未完成勘验者在 release 与 trace 中标注
  `unverified-claim`；
- DESIGN、ROADMAP、CLAUDE、OpenSpec config 相互无冲突。

### 止损

五个主动开发日后仍无法写清 state/effect/cutover 契约：停止设计更多包，缩回最小
`Release → Activation → Run → Event → Effect`。

## M1 — Heartbeat v2 纵向切片

### 目标

不用 Pi、Inbox 或 UI，证明 v2 控制核心本身能闭环。

### 任务

- [ ] 建立 `packages/contracts`、`control-core` 与 `control-store-sqlite`；
- [ ] 编译一个不可变 Heartbeat AgentRelease；
- [ ] 实现单节点 workflow 和 fake RuntimeAdapter；
- [ ] 完成 RunEvent、唯一 terminal choke point 与 projection；
- [ ] 完成最小 Effect Gateway：intent、approval、claim、receipt、unknown；
- [ ] 增加 legacy pipeline adapter 的 heartbeat 兼容 fixture；
- [ ] CLI 暂时作为 v2 API client facade，保留已有 JSON/退出码习惯；
- [ ] 覆盖 crash、cancel、重复 approve、stale epoch、unknown effect 与 restore。

### 出口闸

- Heartbeat 不写 v0 DB、不调用 v0 gateway、不共享 v0 Run identity；
- fake runtime 与 legacy adapter 可互换，workflow/store/effect 不改；
- runtime 没有高风险业务凭据；
- projection 可重建，备份可恢复；
- 所有 fault fixture 通过。

### 止损

M0 + M1 合计超过 15 个主动开发日仍不能跑通：暂停 M2，删除非必要 abstraction。不得用 UI、Knowledge 或更多
runtime 掩盖核心未闭合。

## M2 — Pi、Control API 与两个客户端

### 目标

证明 Hangar + Pi 可替换，并从两个真实界面控制同一个状态机。

### 任务

- [ ] 实现 `runtime-pi` reference adapter；
- [ ] 实现 typed HTTP/SSE Control API；
- [ ] 从同一 Zod schema 生成 TypeScript SDK 与 OpenAPI；
- [ ] hangar-view 改为 API client，不再启动 CLI 子进程；
- [ ] Telegram Bot 或小程序二选一作为第二 client；
- [ ] 实现 actor attribution、idempotency key 与 projection policy；
- [ ] 保留迁移期 legacy CLI，标记版本和删除条件。

### 出口闸

- Pi adapter 不拥有第二份 Run/retry/terminal；
- Web 与第二 client 的同一 intent 经过同一 policy、Run、approval 和 audit 路径；
- client 不读写 SQLite、Agent 文件或 app.yaml；
- view 中的 Inbox command whitelist 被删除；
- runtime 可替换为 fake，client 与 workflow 不改。

## M3 — Inbox Builder Challenge 与迁移

### 目标

证明 Hangar 能在 30 分钟～2 小时构筑一个接近完整 Inbox 的 Agent，并安全接管真实运行。

### Builder Challenge

- [ ] 从 clean baseline 计时；
- [ ] 不得调用旧 `run()` 完成核心处理；
- [ ] 产出不可变、可审查 AgentRelease；
- [ ] `T_attempt ≤120min`；
- [ ] 原子/加权功能 ≥98%，category ≥95%，安全门 100%；
- [ ] 单列 `T_ready`、`C_platform`、`C_enable`、glue LOC 和 TCO。

### 生产迁移

- [ ] v2 shadow 处理受控相同输入，禁止提交 effect；
- [ ] 比较分类、cursor、dedup、domain commit、EffectIntent 与 trace；
- [ ] 关闭 v0 cron 与手动 admission，drain Run/Approval/effect；
- [ ] 以更高 activation epoch cutover；
- [ ] canary 后扩大 trigger；
- [ ] 完成 30 天 soak。

### 出口闸

- Builder Challenge 全部硬门通过；
- 没有双 admission、双写、stale epoch 或重复 effect；
- Inbox 领域状态仍留在 Inbox；
- rollback 演练通过。

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
- [ ] provider 不可用时产生明确、可恢复的 Node failure。

## M5 — Auto Developer process baseline

### 目标

让 Hangar 托管 Auto Developer 的顶层生命周期，而不立刻重写其临时但已工作的内部 supervisor。

### 任务

- [ ] `ProcessRuntimeAdapter → existing Auto Developer orchestrator`；
- [ ] 映射顶层 trigger、release、cancel、observation 与 final gate；
- [ ] 保留 Auto Developer 对 phase/session/watchdog/retry/resume/子进程树的 ownership；
- [ ] 跑父死、late child、partial JSONL、cancel during spawn、TERM→KILL、ambiguous effect、resume、
  double-scheduler fixture。

### 出口闸

- Hangar 没有复制内部 supervisor 或 session state；
- 失败终态与 cancel 可观察；
- 不合格时明确记录 `ManagedResult=retain-agent`。

接管 Auto Developer supervisor 不属于 M5，属于 **M8**；进入 M8 的前提是 M5 出口闸通过，且中立 process
fixture 已证明新 owner 比现有 supervisor 更可靠。M5 不通过时停在 `ManagedResult=retain-agent`，不进 M8。

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

## M7 — AI Radar 租户化接入

前置：M2 出口闸通过（typed Control API 已是唯一写入口）。不依赖 M3。

### 目标

让 AI Radar 成为控制面的第二个真实租户：**编排、发布身份、运行事件与高风险副作用交给 hangar，领域仍归
AI Radar**。它是第一个证明 `C_enable` 会随租户数下降的对象。

### 边界（必须写死，否则等于把领域概念吸进核心）

- **交给 hangar**：trigger 与 admission、不可变 release 身份、按节点展开的 RunEvent、飞书/Telegram 推送的
  `EffectIntent → approval → claim → receipt → reconciliation`、单一 typed 控制入口、健康事实上报。
- **仍归 AI Radar**：跨来源去重与唯一索引、采集游标与高水位、Postgres 领域状态、RAG/知识检索、
  比价与推荐的业务裁决。control-core 不得出现 news/source/dedup/price 一类概念。

### 任务

- [ ] 把 AI Radar 的流水线重构为 v2 workflow（采集与逐条判断走有界顺序 `foreach`，推送走 `effect` 节点）；
- [ ] BullMQ 的定时链改为 hangar trigger + activation；AI Radar 侧只保留领域任务队列（若仍需要）；
- [ ] 推送凭据迁入 effect gateway，AI Radar 进程不再持有飞书/Telegram 提交凭据；
- [ ] 现有 egress fail-closed 自检与来源域白名单映射为 release 内的 `capabilities` 与 sink 白名单；
- [ ] shadow 运行：处理同一受控输入但禁止提交 effect，比对分类、去重、推送基数与 trace；
- [ ] 记录 `T_ready`、`C_enable`、glue LOC 与「提给 hangar 的核心变更建议条数」。

### 出口闸

- 领域状态与业务裁决仍在 AI Radar，control-core 零领域概念；
- 每次运行可定位不可变 release 身份与实际 runtime/model/tool 身份，并可按节点展开；
- 所有推送经 gateway 提交，`effectId` 全链路幂等，`unknown` 进 reconcile 不自动重提；
- **不共改**：接入期间 AI Radar 与 control-core 没有出现在同一个变更里；被契约缺口挡住时的动作是阻塞并
  另开 change，不是绕过；`trusted-direct-effects` 标注点数量未增加；
- 「提给 hangar 的核心变更建议条数」≤ 3（超出即说明抽象边界画错，见止损）；
- 完成 30 天 soak：零未解释 effect，`source → domain commit → 允许的 effect receipt` 基数 1:1 或 0:1；
- 回滚演练通过：关闭 hangar admission 后，AI Radar 能以自有调度恢复运行且不重复提交已 committed 的推送。

### 止损

`C_enable` > 5 个主动开发日，或「提给 hangar 的核心变更建议条数」> 3，或接入必须向 control-core 新增领域
概念——任一成立即暂停 M7，先复审抽象边界，不得靠扩建核心让接入通过。

## M8 — Auto Developer supervisor 接管

前置：M5 出口闸通过，且中立 process fixture 已证明新 owner 比现有 supervisor 更可靠。前置不成立就停在
`ManagedResult=retain-agent`。

### 目标

把 Auto Developer 的受管进程树生命周期从其内部 supervisor 迁到 control-core，同时不降级任何已冻结的行为与
故障语义。这是「通用 managed runtime」这一主张的唯一验收场。

### 任务

- [ ] 中立 process-fixture Agent 先跑通完整 lifecycle，再 shadow Auto Developer；
- [ ] 迁移 phase/session/watchdog/retry/resume 与后代进程 signal/reap 的 ownership；
- [ ] P5 publish 凭据迁入 effect gateway（保留内部 publish 的形态不得宣称治理高风险动作）；
- [ ] 按 DeploymentActivation 提升 epoch 原子切换，删除或禁用旧路径；
- [ ] 跑冻结故障集：silent/late child、wall-clock、partial JSONL、父死、spawn 中取消、TERM→KILL、
  ambiguous effect、resume、双 scheduler。

### 出口闸

- 冻结故障注入无 orphan、无重复 publish、无 false PASS；取消、父死与 late child 收敛；
- 第二个进程型 Agent 证明 supervisor 契约可复用——只有一个消费者时不得宣称通用 managed runtime；
- P5 经 gateway 的 intent/receipt 提交，凭据不在受管进程内；
- 每次 handoff 有 admission barrier、drain 与 epoch 证据；canary 与新 epoch 回滚完整；
- **不共改**：Auto Developer 与 control-core 未在同一变更中同时修改；
- 「提给 hangar 的核心变更建议条数」≤ 3。

### 止损

任一冻结故障场景劣于 M5 baseline，或第二个进程型 Agent 无法复用同一 supervisor 契约——立即回到
`ManagedResult=retain-agent`，保留 Auto Developer 自有 supervisor，并停止宣传通用托管能力。

## 全程硬门

- 单一 owner；
- Run/Event/Effect 状态可解释；
- effect gateway 无绕过；
- no production dual-write；
- TypeScript client/runtime 边界稳定；
- 两个真实 client 共用一个控制路径；
- 轻量指标持续记录：冷启动、idle/peak RSS、磁盘、进程数；
- 外部候选按相同透明控制与 12 个月 TCO 继续 benchmark。

## 明确不在当前路线

多租户、团队 RBAC、计费、SSO、marketplace、工作流画布、通用向量库、任意 durable workflow、完整不可信代码
sandbox。需要其中任何一项时，先建立独立赌注和出口闸。
