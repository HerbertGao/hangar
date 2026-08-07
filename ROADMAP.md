# Hangar v2 — ROADMAP

> 状态：Active。2026-08-04 起取代 v0 路线图。
> 规则：每个阶段都有主动开发预算、可演示交付物、出口闸和止损；闸不过，不进入下一阶段。
> 历史版本：`docs/archive/v0-sot-2026-08-04/ROADMAP.md`（该文件不在本分支，见 `README.md`「本分支说明」）。

## 总路线

```text
M0 SOT / contracts / oracle
  -> M1 Heartbeat v2 vertical slice
  -> M2 Pi + Control API + Web + second client
  -> M3 Inbox Builder Challenge + cutover
       ├-> M4 Knowledge provider v1
       ├-> M5 Auto Developer process baseline
       └-> M6 retire v0
```

| 阶段 | 主动开发预算上限 | 可演示结果 | 出口 |
|---|---:|---|---|
| M0 | 5 个工作日 | v2 SOT、contracts、状态表和冻结 oracle | 测试可独立评价 v0/v2/外部候选 |
| M1 | 10 个工作日 | 新 DB 上完成 release→run→effect→terminal | 无旧 DB 写入、无双 owner、fault fixture 通过 |
| M2 | 10 个工作日 | Pi adapter、typed API、Web 与第二 client | 两端共享一个控制路径，runtime 可替换 |
| M3 | 10 个工作日 + 30 天 soak | 两小时内重建 Inbox 并完成 shadow/cutover | Builder、parity、effect 安全门通过 |
| M4 | 5 个工作日 | 每 Agent 注册 versioned knowledge provider | 第二 Agent 可换 provider，权限与 revision 可追踪 |
| M5 | 5 个工作日，仅 baseline | Auto Developer 作为受控顶层进程运行 | 不复制其 supervisor/session owner |
| M6 | 迁移完成后 | 删除 v0 写路径、daemon、旧 gateway/fallback | 零使用、恢复演练、回滚窗口结束 |

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

接管 Auto Developer supervisor 不属于 M5；必须另开 Managed Runtime change，并以中立 fixture 证明新 owner 更可靠。

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
