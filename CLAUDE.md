# CLAUDE.md — Hangar v2

> **本分支说明**：`v2` 从空树重建，不含 v0 实现、`SKILL.md`、`openspec/specs/` 等迁移期文件——下文提到
> 它们时指的是 `main`（及其他既有分支）上的历史内容，仅作参考，本分支不以其为迁移路径。详见 `README.md`。

Hangar 是开发者可完全掌控的个人 Agent 构筑与运行平台。当前已选择 v2-first；v0 只作为行为 oracle、legacy
兼容和回滚参照。

开始工作前依次读：

1. `DESIGN.md`：架构 SOT；
2. `ROADMAP.md`：阶段、预算、出口闸与止损；
3. 当前 OpenSpec change；
4. 需要完整迁移理由时读 `docs/proposals/control-core-v2-migration.md`。

`SKILL.md` 当前只描述已实现 v0 CLI 的迁移期运行契约，不再是 v2 总架构 SOT。

## 架构不变量

写代码前逐条自检：

1. **核心零领域概念。** control-core 不出现 email/mail/repository/slide 等具体业务模型。
2. **v2-only growth。** release、workflow、Control API、effect、knowledge 和新 client 能力只进入 v2；不要反向扩展 v0。
3. **不可变 release。** AgentSpec 必须编译成带 hash 的 AgentRelease 后才能 activation。
4. **单一 owner。** admission、Run、retry、terminal、effect commit、进程回收各自只有一个 owner。
5. **事件是真相。** Run/Node 状态由 append-only events 推导；终态只走唯一 choke point。
6. **显式 durable 边界。** 只在 human/effect/subflow 边界 wait/resume；不做任意 continuation replay。
7. **Runtime 不拥有控制状态。** Adapter 不建第二个 Run，不静默 retry，不持高风险业务提交凭据。
8. **Effect Gateway 唯一提交。** 受控 mutation 必须有 intent、policy/approval、claim、receipt、reconciliation；
   unknown 不自动重提。
9. **Typed Control API 唯一控制入口。** client 不直写 SQLite/Agent 文件，不复制 retry/effect 状态机。
10. **迁移允许双读，禁止双写。** 同一 Agent 同时只能有一个 admission 与可写运行 owner。
11. **Knowledge provider 自治。** provider 拥有索引、ACL、更新和删除；runtime 只拿最小 ToolDescriptor。
12. **模块化单体优先。** 包边界不等于服务边界；没有真实隔离/伸缩需求不拆进程。
13. **架构变更先改 SOT。** 代码与 DESIGN/ROADMAP 冲突时先更新文档和 OpenSpec，不得静默绕过。

## 当前阶段

按 `ROADMAP.md` 执行。当前从 M0 开始，M0 未通过前不得实现与旧 SOT 冲突的大规模 v2 代码；第一个
implementation slice 是：

```text
contracts
  -> v2 state machine
  -> v2 SQLite
  -> fake runtime
  -> heartbeat release/run/effect/terminal
```

Pi、Web、Knowledge 和 Auto Developer 都不能先于该闭环。

## v0 迁移纪律

- v0 当前代码、OpenSpec specs 与 `SKILL.md` 仍可能有未完成工作；不要回退或覆盖用户修改；
- `openspec/specs/` 在 v2 counterpart 落地前继续描述已交付 v0 行为，只作为兼容 oracle，不得据此新增 v0 能力；
- v0 只接受 oracle 固化、legacy 兼容、严重正确性/安全修复和删除工作；
- 不向 v0 四表、app.yaml 或 PipelineExecutor 塞 v2 新概念；
- legacy adapter 必须写 v2 RunEvent/Effect，不得调用旧 DB/gateway 创建第二份事实；
- `enabled:false` 不阻断手动 run，不能单独充当 cutover barrier；
- 删除 v0 必须等零使用证明、30 天 Inbox soak 与恢复演练。

## 实现约定

- TypeScript + Node.js + pnpm；schema/contract 优先使用 Zod；
- 新 package 默认链接进一个 `hangar-server`，依赖方向遵守 DESIGN；
- 非平凡状态转移、重试、审批、解析、并发和金额逻辑必须有可运行测试；
- fault fixture 要覆盖 crash point，不以 happy-path demo 代替；
- append-only event 与 external receipt 不得被 projection 覆盖；
- error 必须 typed、可操作，不把内部 stack/path 暴露给 client；
- secret 不进 release、event、trace 或 client；使用 secret ref；
- read-only 检查不得产生 SQLite sidecar 或其他隐式写入。

## 测量与止损

每个阶段记录：

- `T_attempt`：从 brief 到不可变 release 的连续墙钟时间；
- `T_ready`：干净主机到平台可用；
- `C_platform`：平台预投入；
- `C_enable`：每 Agent 专属适配；
- glue LOC、冷启动、idle/peak RSS、磁盘、进程数和 12 个月 TCO。

Inbox 的 `T_attempt ≤120min` 只是 authoring 硬门，不代表平台总成本合格。M0 + M1 超过 15 个主动开发日仍
不能闭合 heartbeat 时，停止 M2 并删减抽象。

## CLI 与 Git

- 现有 v0 CLI 继续遵循 `SKILL.md`：stdout 数据、stderr 日志、`--json`、退出码 0/1/2；
- 新 v2 CLI 是 generated client，不得成为第二套内部 API；
- 不直接修改 SQLite；
- 不由 Agent 启动长驻 daemon/server，除非任务明确要求；
- GitHub CLI 使用 `\gh`；
- 工作树可能包含其他人的未提交修改；只改任务范围，不回退、不顺手整理。

## 非目标

当前不做多租户、团队 RBAC、计费、SSO、marketplace、工作流画布、统一向量库、Temporal 仿制品或完整不可信
代码 sandbox。任何一项都需要新的产品赌注、威胁模型、路线图和退出闸。
