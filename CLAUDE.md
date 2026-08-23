# CLAUDE.md — Hangar v2

> **本分支说明**：`v2` 从空树重建，不含 v0 实现与 `SKILL.md`。`openspec/specs/` 只由外部
> `openspec-cn` 管理；产品代码、M0 validator 与产品测试不得解析它。`main` 的历史内容只作固定 revision 参考。

Hangar 是开发者可完全掌控的个人 Agent Harness 与控制平面。当前已选择 v2-first；v0 只作为行为 oracle、legacy
兼容和回滚参照。

开始工作前依次读：

1. `DESIGN.md`：架构 SOT；
2. `ROADMAP.md`：阶段、预算、出口闸与止损；
3. 当前 OpenSpec change；
4. 需要完整迁移理由时读 `docs/proposals/control-core-v2-migration.md`。

`main:SKILL.md` 描述已实现 v0 CLI 的迁移期运行契约；本 v2 分支没有该文件，它只作行为 oracle，不是 v2 SOT。

## 架构不变量

写代码前逐条自检：

1. **核心零领域概念。** control-core 不出现 email/mail/repository/slide 等具体业务模型。
2. **v2-only growth。** release、Harness、Control API、Effect、knowledge 和新 client 能力只进入 v2；不要反向扩展 v0。
3. **不可变 release。** AgentSpec 必须编译成带 hash 的 AgentRelease 后才能 activation。
4. **分层单一 owner。** admission、Run、外层 RunAttempt/restart、durable wait、terminal、Effect commit 和 whole-tree
   reap 各自只有一个 Control owner；下一 Attempt 必须原子消费 AttemptQuiesced，且该 fence 拒绝旧 Attempt 的全部派生
   写入/launch（只放行既有 obligation 的不可调度 late outcome 与 Control cleanup）；Harness 只拥有同一 Attempt 内声明过的模型、传输与可逆 action retry。
5. **事件是真相。** Run/RunAttempt 与 action graph 由 append-only events 推导；终态只走唯一 choke point，投影不反向
   成为执行 authority。
6. **显式 durable 边界。** 只在 human、Effect 或具名外部输入边界 wait/resume；checkpoint 只在声明边界序列化，
   并绑定封闭 obligation owner/generation；合法 owner handoff 只认不可分支的 CAS successor chain；新 RunAttempt 消费版本化状态，不做任意 continuation replay。
7. **Harness 拥有推进，不拥有控制状态。** Harness 可规划、选工具/subagent、管理上下文与内部 retry；不建第二个
   Hangar Run/RunAttempt，不提交 terminal，不重试 unknown/committed Effect，不持高风险业务提交凭据。
8. **Effect Gateway 唯一提交。** 受控 mutation 必须有 intent、policy/approval、claim、dispatch 与最终
   ExternalOutcome/reconciliation；receipt 仅在存在时作为证据，unknown 不自动重提。
9. **Typed Control API 唯一控制入口。** client 与未来 Agent principal 不直写 SQLite/Agent 文件，不复制外层
   retry/effect 状态机。
10. **迁移允许双读，禁止双写。** 同一 Agent 同时只能有一个 admission 与可写运行 owner。
11. **Knowledge/Workspace 自治。** provider/Agent 拥有索引、ACL、领域事实、更新和删除；Harness 只拿最小
    ToolDescriptor；运行期学习不得静默改变 active Release。
12. **模块化单体优先。** 包边界不等于服务边界；没有真实隔离/伸缩需求不拆进程。
13. **架构变更先改 SOT。** 代码与 DESIGN/ROADMAP 冲突时先更新文档和 OpenSpec，不得静默绕过。
14. **受限子进程有内容。** 模型驱动/确定性 Harness、provider/subagent child 与 legacy process 都在受限子进程内：
    凭据剥离、出站与 secret 默认拒绝、能力只经 RunAttempt-bound RuntimeGrant 授予，Control 必须能 hard-reap 完整
    进程树（DESIGN §6.1）。未完成正向勘验的条目标 `unverified-claim`，不计入结构性保证。
15. **租户不与核心共改。** 租户按 Hangar 契约重构，不与 control-core 出现在同一次变更里；被契约缺口挡住时
    阻塞并另开 change，不得用 `trusted-direct-effects` 或 opaque Harness event 绕过（DESIGN §12.4）。
16. **准入要有具名消费者。** 新 ProcessSpec、durable 原语、Suggestion/AgentIntent 或 knowledge provider 协议进实现
    的条件是「具名租户 + 排定阶段 + 该阶段出口闸依赖它」；「先预留」不算（DESIGN §5.1）。

## 当前阶段

按 `ROADMAP.md` 执行。M0 已降为 non-authorizing advisory，M1 entry 已通过并激活条件授权；当前只实现以下
Heartbeat vertical slice：

```text
contracts
  -> v2 Run/RunAttempt state machine
  -> v2 SQLite
  -> fake Harness
  -> heartbeat release/action/effect/checkpoint-resume/terminal
```

Heartbeat stage acceptance的唯一语义SOT是`m1-heartbeat-runtime`全部requirements/scenarios；M0 evaluator universe未被该stage采用，token/fixture/TAP/digest均不得补票。只有6.1逐项证据与6.2固定检查/fresh CR+RC关闭后才能开始M2 planning；candidate/production qualification继续为false。Pi、Web、Knowledge、Inbox、Auto Developer与AI Radar都不能先于该闭环。M3才实现Inbox suggestion shadow；
M5 只做 Auto Developer Harness qualification，不规划 supervisor takeover；M7 接入 AI Radar Harness。

## v0 迁移纪律

- `main` 上的 v0 代码、OpenSpec specs 与 `SKILL.md` 仍可能有未完成工作；不要回退或覆盖用户修改；
- `main:openspec/specs/` 描述已交付 v0 行为，只作为兼容 oracle；本 v2 分支无该目录，不得据此新增 v0 能力；
- v0 只接受 oracle 固化、legacy 兼容、严重正确性/安全修复和删除工作；
- 不向 v0 四表、app.yaml 或 PipelineExecutor 塞 v2 新概念；
- legacy adapter 必须写 v2 RunEvent/Effect，不得调用旧 DB/gateway 创建第二份事实；
- `enabled:false` 不阻断手动 run，不能单独充当 cutover barrier；
- 删除 v0 必须等零使用证明、30 天 Inbox soak 与恢复演练。

## 实现约定

- TypeScript + Node.js + pnpm；M1 stdlib-only，使用可执行 TypeScript 与显式 runtime guards，不为 schema 引入依赖；Zod/OpenAPI 延后到已有依赖或 M2 API change；
- 新 package 默认链接进一个 `hangar-server`，依赖方向遵守 DESIGN；
- 非平凡状态转移、重试、审批、解析、并发和金额逻辑必须有可运行测试；
- fault fixture 要覆盖 crash point，不以 happy-path demo 代替；
- append-only event 与 external receipt 不得被 projection 覆盖；
- error 必须 typed、可操作，不把内部 stack/path 暴露给 client；
- secret 不进 release、event、trace 或 client；使用 secret ref；
- read-only 检查不得产生 SQLite sidecar 或其他隐式写入。

## 反过度设计

M0 一次产出 52k 行 JSON + 11k 行测试 + 3.6k 行自建 validator、0 行实现，止损闸触发未拉。下列规则由该次
失败反推，写代码和写契约前逐条自检：

1. **无具名消费者不产出。** 任何文件、字段、digest、计数都要能指名当下就读它的消费者；「先冻结着以后要用」
   等于不写（同不变量 16）。
2. **断言只指向被测系统。** 开发工具版本（openspec-cn、pnpm、node）、当前工作树布局、规划文件路径都不是
   被测系统，不得进断言。需要固定输入就 pin git revision，读冻结 revision 而非活动工作树。
3. **不手工重做 git 已经做的事。** 不把仓内源文件的 sha256、路径清单、mtime 存成受维护的数据；
   内容寻址是 git 的职责，手工版本只会漂移。
4. **一个事实一个位置。** 路径、计数、分母、digest 只能有一个 owner，其余引用它；能遍历推导的不写字面量。
   判据：改一条语义应只动一个文件，扇出到三个以上就是这条被违反了。
5. **一套断言引擎。** 用标准 runner（`node:test`），不并行维护自建 validator；两套断言同一批数据
   必然各存一份常量并互相漂移。
6. **测试必须能被产品代码证伪。** 逻辑不得只活在 test helper 里；断言 helper 自身行为的测试零证据力，
   且在实现落地时必然变成第二个真相源（违反不变量 5、9）。
7. **止损是硬约束。** 阶段预算或止损条件触发即停并上报，不得靠继续产出来解决产出不足；
   ROADMAP 的止损条款不是建议。

## 测量与止损

每个阶段记录：

- `T_attempt`：从 brief 到不可变 release 的连续墙钟时间；
- `T_ready`：干净主机到平台可用；
- `C_platform`：平台预投入；
- `C_enable`：每 Agent 专属适配；
- glue LOC、冷启动、idle/peak RSS、磁盘、进程数和 12 个月 TCO；
- 租户接入期间「提给 control-core 的核心变更建议条数」——按不变量 15 租户不与核心共改，凡接入被挡就必须
  提 change，因此该条数就是可数的抽象边界误判次数。

Inbox 的 `T_attempt ≤120min` 只是 authoring 硬门，不代表平台总成本合格。M0 + entry + M1 累计达到 15 个主动开发日仍
不能闭合 heartbeat 时，停止 M2 并删减抽象。

上述都是「造得对不对」的触发器。回答「该不该继续造」的是需求侧触发器：任一租户接入期间 `C_enable`
或核心变更建议条数超过其阶段出口闸阈值、接入必须向 control-core 新增领域概念，或 fault attribution 未从 owner
冻结的完整 universe 推导、required case 被排除、适用分母为零/有漏跑/超过 5%，均阻断下一阶段（DESIGN §14、ROADMAP M3/M5/M7）。至少 2/3 reference tenants 证明正确恢复必须由平台解释内部
依赖时，才另开可选 ProcessSpec change。

## CLI 与 Git

- 现有 v0 CLI 继续遵循 `main:SKILL.md`：stdout 数据、stderr 日志、`--json`、退出码 0/1/2；
- 新 v2 CLI 是 generated client，不得成为第二套内部 API；
- 不直接修改 SQLite；
- 不由 Agent 启动长驻 daemon/server，除非任务明确要求；
- GitHub CLI 使用 `\gh`；
- 工作树可能包含其他人的未提交修改；只改任务范围，不回退、不顺手整理。

## 非目标

当前不做多租户、团队 RBAC、计费、SSO、marketplace、工作流画布、通用 ProcessSpec、长驻推理进程、
Agent-to-Agent 自动执行、统一向量库、Temporal 仿制品或完整不可信代码 sandbox。任何一项都需要具名消费者、
新的产品赌注、威胁模型、路线图和退出闸。
