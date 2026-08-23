# Add Mastra Harness Candidate

## Why

`docs/proposals/personal-agent-builder.md` §4/§6 冻结的外部候选是 OpenClaw、LangGraph、LangSmith Fleet，
`DESIGN.md` §6 另列 AgentScope/LangGraph 作为受边界约束的 SDK adapter。该名单成文时，Mastra 还只是
agent + workflow SDK。

2026-08-21 的文档取证（记录于 `docs/proposals/mastra-candidate-evaluation.md`）显示形态已变：Mastra 现有
Durable Agents、Background Tasks、Goals、Schedules、Signals、Agent Controller、cron 调度、snapshot/suspend/resume/
time travel、Mastra Server + client SDK + JWT/Composite Auth/FGA、Sandbox 部署与 Studio。以 Hangar 的目标形状
衡量，它比名单内任何候选都更接近，却不在名单内——这是候选 leaderboard 的覆盖缺口，不是架构方向问题。

同一份取证也显示三条决定性缺口（均引官方文档原文）：无跨副本 lease/lock、多副本 auto recovery 互相竞争；
recovery 重放 agentic loop 并重发 LLM 与工具调用、把幂等责任推给工具作者；sandbox 隔离由第三方 provider 决定
且 deployer 将 `.env` 注入远端 sandbox VM。它们分别落在 `ROADMAP.md` 全程硬门的单一 owner、unknown/committed
Effect 不自动重提、以及 `DESIGN.md` §6.1 正向勘验上。

因此本 change 的判断是：Mastra 必须进名单并参加与其它候选完全相同的资格赛，不因功能重叠获得豁免，
也不因缺口明显被先验排除。按 `DESIGN.md` 不变量 13（架构变更先改 SOT），名单与边界先落文档，再谈实现。

## What Changes

- 把 Mastra 加入 `docs/proposals/personal-agent-builder.md` §4 的完整方案候选与 §6 的候选平台选择规则，
  并在 `DESIGN.md` §6 的外部 SDK adapter 句中并列；`DESIGN.md` §15 增加对候选评估附录的指针。
- 冻结外部候选名录的记录口径：每个候选绑定取证日期、来源链接与 `已实证 | 未查实` 标注；未查实项按
  §6.3 口径计 0，不得以功能列表或社区规模补分。
- 冻结 Mastra 一旦接入时的 owner 边界：只能是受边界约束的 Harness adapter 与可选 client/telemetry 依赖；
  `recovery.durableAgents: 'auto'`、Mastra schedules 作为 trigger owner、tool approval 治理受控 mutation、
  以及 Mastra 侧持有高风险业务提交凭据，四者一律拒绝。若采用其完整 Service，必须**替代**对应 Control owner，
  不得与 Hangar 并存形成第二套 session/schedule/effect 状态机。
- 冻结资格赛条款：候选先过 `personal-agent-builder` §6.3 七项透明控制硬门，再跑与 `harness-pi` 同一组
  fixture（release identity、grant、effect-unknown、cancel/checkpoint、retry-owner、whole-tree reap）；
  失败即淘汰，不进入加权排名。
- 冻结反向止损：若 Mastra 同时补齐跨副本 fencing、带 claim/unknown/reconciliation 的受控提交层、
  默认凭据剥离且可 hard-reap 完整进程树的子进程边界，则按 §4.2 第一种判定归档 Hangar runtime 并迁移
  oracle/契约；仅功能面扩张不构成位移。
- **不做**：不修改 `DESIGN.md` 的架构不变量与 M0/M1 范围；不新增运行时能力、package、adapter 或依赖；
  不在 M1 引入 Mastra；不裁决 M2 的 typed API/client 是自建还是复用——那属于 M2 的具名 change。

服务阶段：本 change 服务 `ROADMAP.md` M2 之前的候选准备，产出物全部是文档与验收口径。M0 的 41/244/233/88
与 565-member definition denominator 不变，本 change 不向 `define-v2-control-contracts` 的任何 spec 增删成员，
也不新增 M0 aggregate gate。

不变量检查：

- **单一 owner**：本 change 只增加候选与边界记录，不创建任何 owner；对 Mastra 冻结的四条拒绝正是为了防止
  接入时出现第二个 admission/schedule/effect owner。
- **event truth**：不引入新的事实源；候选取证是文档证据，不进入 RunEvent/SourceFact。
- **Effect Gateway**：明确 Mastra 不得持有高风险业务提交凭据，受控 mutation 仍只有 gateway 一个提交 owner。
- **typed API**：不建立第二控制入口；Mastra Server 若被采用，必须替代而非并存。
- **no dual write**：无数据面改动，不触及任一数据库。

使用证据：本 change 不新增核心能力，因此不适用「两个 Agent 或一个真实 Agent 加一个中立 fixture」的使用
证据要求。它冻结的验收口径由 M2 的 `harness-pi`/`harness-mastra` spike 与中立 Heartbeat fixture 执行。

外部平台成本口径：本 change 只冻结「必须计算」的项目——glue LOC、部署形态、退出成本、各包许可证边界、
self-host 与 Cloud 的能力差，以及 12 个月 TCO；实际数值由 M2 spike 产生，缺证据的项按 0 计入排名。

## Capabilities

### New Capabilities

- `external-candidate-qualification`: 外部完整平台/Harness 候选的名录记录口径、owner 边界拒绝清单、
  资格赛前置与反向止损。仅治理候选评估，不定义任何运行时行为。

### Modified Capabilities

无。本 change 保持 `define-v2-control-contracts` 的 Requirement/scenario/member ID与数量不变；允许 `define-m1-spec-based-acceptance` 对其作一次“candidate spec显式opt-in M0 evaluator universe”的语义修订，不改变Mastra资格赛或冻结成员。

## Impact

- 文档改动限于 `docs/proposals/personal-agent-builder.md`、`DESIGN.md` §6/§15 与新增的
  `docs/proposals/mastra-candidate-evaluation.md`；无代码、无 package、无依赖、无数据迁移。
- `ROADMAP.md` 的阶段、预算与出口闸不变；M2 任务表在其自身 change 中决定是否新增 `harness-mastra` spike。
- 非目标：不评估 Mastra Cloud 商业条款、不迁移任何现有 Agent、不在本 change 内产生 benchmark 数值、
  不为 Mastra 预留运行时接口（按 `DESIGN.md` §5.1，没有具名租户与排定阶段就不预留）。
- 回滚：删除本 change 与附录、还原三处文档段落即可，无运行时影响。
- 止损：若两个主动开发日内无法把候选边界与资格赛条款写成不产生第二 owner 的形式，放弃把 Mastra 列为
  adapter 候选，只保留为 §6.3 完整方案 leaderboard 上的 benchmark 条目。
