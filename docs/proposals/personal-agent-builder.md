# Hangar：透明的个人 Agent 构筑与控制平台提案

> **状态：历史方向与竞品验证依据，不是当前架构 SOT。** 2026-08-04 owner 已选择 Hangar v2-first；
> canonical 架构与次序现见仓根 `DESIGN.md`、`ROADMAP.md` 与 `openspec/config.yaml`。本文的透明控制硬门、
> 外部候选 benchmark 与成本模型继续有效，但 `ControlResult` 条件分支不再阻塞 M0/M1 启动。
>
> **本文回答三个问题：**为什么不直接把 OpenClaw、LangGraph 或 LangSmith Fleet
> 当成最终平台；Hangar 必须拥有什么才不是重复造轮子；如何用可验证的实验决定继续、
> 重写或归档当前 Hangar。

---

## 1. 决策摘要

建议把 Hangar 的目标从“保留现有无头 AgentOS，再补一个 Builder”改为：

> **面向开发者的、透明、可编程、可审计的个人 Agent 构筑与控制系统。**
> Hangar 拥有 Agent 的定义、显式流程、运行状态、权限、副作用和验收；Pi、LangGraph、
> 模型 SDK 或未来 runtime 只是可替换的执行器。

这一结论**不保护当前 Hangar 代码**。现有 registry、scheduler、Run/RunEvent、Approval、
PARK、CLI 和 hangar-view 都是候选资产，不是必留架构。只保护被冻结后的用户目标、行为 oracle、
安全边界和可观测语义；如果重写或外部方案以更低总成本达到它们，现有实现应归档而不是被继续托举。

本提案不把“工作流 + RAG + 自托管”当作差异化。这个组合已有成熟产品。Hangar 的具体赌注是：

1. **文件和代码为真相源。** Agent 定义、prompt、flow、policy、fixture 和 eval 可读、可
   diff、可版本化；AI 只起草候选变更。
2. **外层流程显式，内层推理受限。** Hangar 决定何时启动、进入哪个状态、给 runtime 什么上下文、
   允许哪些工具、何时重试或终止；Pi 等 runtime 只负责需要推理的节点。
3. **每一次 Run 都能被解释。** owner 可从触发一直追到上下文快照、工具调用、状态变化、人工审批、
   外部回执和业务终态，不依赖某个黑盒“宣称成功”。
4. **个人 Agent fleet 是一级产品对象。** 已发布的 AgentRelease、run、资源、审批和健康状态
   处在同一个私人控制面。
5. **界面是客户端，不是另一套业务规则。** Web、微信小程序、Telegram Bot、CLI 或未来客户端
   都通过同一个 typed intent/event/approval 接口控制 Agent。
6. **完全掌控但不重造生态。** Hangar 拥有语义与替换边界；模型 API、Pi、MCP、通道 SDK、向量库、
   沙箱和 durable graph 可复用外部实现。

方向包含三个可分开裁决的问题：

- **透明控制核心：** Hangar 或外部方案能否让 owner 完整掌握定义、流程、状态、权限、运行身份、
  副作用与替换边界。这是 Hangar 是否存在的主决策。

- **快速构筑基准（inbox）：**在已经安装候选平台、配好账号和凭据的前提下，owner 从空白 Agent
  开始，在 **30 分钟到 2 小时的墙钟时间**内得到一个不可变候选发布；它必须通过预先冻结的统一
  验收套件，原子需求覆盖率和加权能力均达到 **至少 98%**。不得把旧 `run()` 当黑盒重新挂回去。
- **复杂托管基准（Auto Developer）：**平台能托管带多阶段 Agent 会话、非对称权限、进程监管、
  watchdog、retry/resume、取证、发布门禁和高风险副作用的复杂 Agent；不能把它降格为一个
  “命令退出码为 0 就成功”的节点。现有 Auto Developer 的实现可以被重写，必须保留的是冻结后的
  行为与故障语义，而不是其临时形成的内部架构。

若 OpenClaw、LangGraph + 薄控制层、LangSmith Fleet 或其它组合通过同一套透明控制硬门，并以
更低 12 个月总成本达成目标，就应归档 Hangar 实现。反之，外部方案只是快速或功能多，却把流程、
会话、记忆、工具权限和运行状态一并变成其私有语义，就不是对 Hangar 目标的等价替代。

近期仍只服务个人使用。小团队是未来另行验证的产品阶段，不以多租户、RBAC、SSO、计费或
marketplace 的形式提前进入当前范围。

---

## 2. 为什么要从“脊柱”走向“透明构筑与控制”

当前 Hangar 解决的是 Agent 已经存在之后的问题：怎么注册、调度、执行、审批、留痕和查看状态。
这些能力重要，但它们只降低运行成本，没有明显降低**创造下一个 Agent**的成本。

现在新增一个 pilot，仍然意味着创建 repo、写 pipeline、选择模型与工具、组织 prompt、处理配置和
领域状态、补测试，再把它接回 Hangar。基础设施被复用了，Agent 本身却仍然主要靠手工工程构筑。
这使 Hangar 的价值依赖“以后还会手写很多 pilot”，价值兑现慢，用户感知也弱。更重要的是，如果
平台不能在两小时内重建 inbox 这类已经明确、已有测试和领域规则的 Agent，就没有证据表明它能显著
降低新 Agent 的构筑成本。

新闭环不是在现有 runtime 上叠一个聊天框，而是：

```text
自然语言目标
  → Pi 或其它构筑 runtime 起草 AgentSpec、workflow 代码、prompt、schema、fixture 与 eval
  → Hangar 编译、验证并展示 diff
  → 人确认
  → dry-run / replay / eval
  → 发布为不可变 AgentRelease
  → 由 Hangar 显式 workflow 调用确定性代码、Pi turn 或外部 runtime
  → 运行数据反哺下一次修改
```

对开发者来说，“掌控”不是能在 UI 中点击暂停，而是能沿一次 Run 看清触发、节点、上下文、工具、状态、
审批和 effect receipt，并能在不改变上层契约的情况下替换 Pi/模型/graph runtime。这才是 Hangar 相对
个人助手黑盒的价值。

---

## 3. 这是否符合 AI Agent 的发展方向

### 3.1 Agent 正从“一个 prompt”变成可运营的软件系统

主流框架正在向相似的工程面收敛：工具调用、持久状态、人工介入、trace、eval、知识检索、部署和
权限治理。LangGraph 将自身定位为支持 durable execution、streaming、human-in-the-loop 和
persistence 的编排 runtime；它的 checkpoint 进一步支持跨中断恢复、memory、time travel 与
fault tolerance。[^langgraph-overview] OpenAI 的 Agents SDK 也把 handoff、guardrail、tracing 与
多步工具使用列为核心能力。[^openai-agents]

这说明 Hangar 已有的 Run、事件、审批和调度不是偏离方向；问题只是它还缺少更高层的构筑体验、
节点级观察、eval 与资源声明。

### 3.2 “AI 帮人构筑 Agent”成立，但托管画布不是稳定的唯一答案

产品曾普遍把构筑体验做成拖拽画布。Dify 已提供工作流、Agent、RAG 与自托管，Flowise Agentflow
V2 也提供 Agent、Retriever、Document Store、tool 与 flow state。[^dify][^flowise]

但模型能力提高后，流程定义越来越适合由 AI 直接生成和修改。画布可以继续作为可视化结果，却未必
适合作为唯一真相源。一个值得计入供应商生命周期风险的案例是：OpenAI 在 2026 年 6 月宣布逐步关闭其
Agent Builder 与 Evals 产品，并建议需要持续运行的工作流迁回 Agents SDK 代码；相关产品将在
2026 年 11 月 30 日后不再可用。[^agentkit-sunset] 这不证明 Hangar 应当自建，也不代表 SDK 或云服务
不可用；它只说明可迁移性应进入候选平台评分，而不能被当作默认成立。

Hangar 因而不应反向再造一套以拖拽编辑为中心的 UI。更合适的形状是：文件是真相源，AI 修改文件，
人查看生成的 diff 和只读流程图，runtime 对定义做确定性验证。

### 3.3 模型、工具和协议会快速商品化，个人运行状态不会

模型、MCP server、embedding、reranker、向量库与常见 SaaS connector 会持续变好。Hangar 不应把
其中任何一个实现绑定成自身核心价值。真正难以从通用服务取回的是：

- 这个 Agent 被允许做什么；
- 哪些动作必须由主人批准；
- 它处理到了哪里；
- 它长期应该产生什么结果；
- 它过去为何作出某次决定；
- 换模型、工具或知识 provider 后，行为是否仍然合格。

这些是属于用户的运行契约和历史，而不是模型厂商或连接器的属性。Hangar 应当拥有这部分，把快速
变化的模型与工具留在可替换边界之外。

### 3.4 结论

方向成立，但成立的不是“再做一个 low-code Agent 平台”，而是：

> **当 AI 越来越能生成流程和代码时，个人更需要一个自己拥有的编译、权限、运行、验证和历史层。**

这里的“拥有”不要求自己实现每一行底层代码，而要求自己拥有语义和替换权：外部组件必须经过窄接口接入、
版本可 pin、输入输出可记录、失败可分类、不能绕过 Hangar 独立改变领域状态或提交高风险 effect。

---

## 4. 为什么不直接使用 OpenClaw、LangGraph 或 LangSmith Fleet

### 4.1 先承认：大量场景不应该使用 Hangar

出现以下任一情况，应优先选现成产品：

- 要快速搭一个标准聊天机器人、文档问答或常见 SaaS 自动化；
- 团队需要非技术成员拖拽编辑流程；
- 需要大量现成 connector、模板与社区插件；
- 需要成熟的分支、汇合、流式执行、任意 checkpoint、time travel 或大规模并发；
- 愿意接受厂商的数据面、部署模型和商业许可，以换取更少维护；
- 项目的主要目标是交付业务 Agent，而不是拥有一套长期个人 Agent 基础设施。

如果 Hangar 最后只复现了“画节点、接 LLM、挂向量库”，停止自研并迁到 OpenClaw、
LangSmith Fleet、Dify、Flowise 或 n8n
会更理性。

选择不应只靠功能表。候选的应是**完整可运营组合**，而不是孤立品牌：`Hangar + Pi`、
`OpenClaw native/ACP`、`LangGraph + 薄控制层`、`Fleet + external domain service`。它们必须参加同一场
inbox 重建、多界面控制和 Auto Developer 故障试验。只有构筑时间、透明控制硬门、验收覆盖、运行负担和失配
代码量能回答 buy-vs-build。

### 4.2 OpenClaw 是最接近的产品竞品，但不默认是合格基座

OpenClaw 已经将个人 Agent、多通道 Gateway、session、skills、工具、定时任务、多 Agent 路由、
权限和自定义 Gateway client 组成一个完整产品，并可通过 ACP 运行外部 coding harness。
[^openclaw-gateway][^openclaw-multi-agent][^openclaw-acp] 它是必测的直接替代，不能因为早期体验像黑盒就先验排除。

但“有公开 RPC”不等于“owner 拥有运行语义”。OpenClaw 同时拥有通道、会话、记忆、Agent loop、
工具策略、调度和内部状态；二次开发者仍需围绕其对象模型和升级节奏工作。官方建议嵌入主机把
Gateway 当可替换子进程、仅经协议交互，这可降低 fork 风险，却不自动满足 Hangar 的节点级输入、决策、状态和
effect 解释要求。[^openclaw-embedding]

因此 OpenClaw 的判定只有三种：

- 通过透明控制硬门：归档 Hangar runtime，把 oracle/契约迁入 OpenClaw 的正式扩展边界；
- 只有通道和对话 UX 胜出：它可作为可选 edge adapter，不做 Hangar 的状态和流程 owner；
- 为满足硬门需要长期 fork 或双重控制面：淘汰。

### 4.3 LangSmith Fleet 适合快速构筑，不默认适合长期主权

Fleet 直接提供自然语言构筑、Email Assistant 模板、connected accounts、工具、子 Agent、定时任务、
通道、审批和托管执行，可通过 API 调用，也能导出 Agent 配置包。[^langsmith-fleet][^fleet-api][^fleet-export]
它因此是“30 分钟到 2 小时构筑”赛道的强基准。

但 Fleet SaaS 的执行、连接账号、trace 和用量仍属于 LangSmith 平台语义；导出文件不等于运行时可无损迁移。
Fleet 自托管当前也不应与个人低运维等同；必须把托管 SaaS、Fleet 自托管 beta 和完整 LangSmith
自托管分开评分。[^langsmith-selfhost]

若 Inbox 的 IMAP、cursor、dedup、policy、effect receipt 和业务健康最终都留在外部 MCP/领域服务，
Fleet 实际只是 Builder 和通用 Agent runtime；这可以成为合格的分层结果，却不应被表述为它已替代整个 Hangar。

### 4.4 LangGraph 解决的是状态化 Agent 编排，不是完整个人控制产品

LangGraph 的优势是真实且显著的：成熟的 graph runtime、checkpoint、interrupt/resume、memory、
fault tolerance 和 LangSmith 生态。[^langgraph-persistence] 对需要长时间运行、复杂分支汇合、
图内循环和任意步骤恢复的 Agent，它比自建 runtime 更可靠。

Hangar 当前已有另一层的部分能力：cron、Run/cancel、host 生命周期、跨 Agent 状态视图、审批和 CLI；
它尚不自动提供个人多界面产品、跨 Agent fleet、Auto Developer 的 OS 进程树监管，也不决定领域
cursor/dedup/effect 等正确性语义。LangGraph 可以成为 Hangar 某个 executor 或节点内的 durable runtime；
只有 `LangGraph + 薄控制层` 这个完整组合通过透明控制和 TCO 硬门时，它才能替代 Hangar core。

### 4.5 Pi 是首选参考执行器，不是 Hangar 的固定大脑

Pi 刻意保持较小的 terminal coding harness 核心，同时提供 Node SDK、headless RPC、结构化事件、
TypeScript extensions 与自定义工具。[^pi-docs][^pi-rpc][^pi-extensions] 这使它很适合作为可被 Hangar pin、
限权、隔离、超时、取证和替换的动态推理执行器。Auto Developer 已采用 Pi RPC 的受控子进程形状，
但这只是当前参考实现，不构成平台绑定。

Hangar 应自己拥有调用时机、上下文快照、工具权限、预算、取消、重试、状态写入和高风险 effect。Pi 只返回一次
turn 的事件和结果。若普通邮件游标或去重用确定性代码更合适，就不得为了“Hangar + Pi”品牌强行调用 Pi。

### 4.6 Dify / Flowise 更像完整工作台，但其抽象和运维边界由平台决定

Dify 和 Flowise 已经能高效完成画布编排、Agent、知识库和常见工具接入。它们适合希望尽快得到
可交互应用、接受平台对象模型，并愿意围绕平台 UI 管理应用的人。Dify 甚至有 tool、datasource、
trigger、agent strategy 等完整插件类型。[^dify-plugin]

Hangar 自建的理由不能是“它们做不到”，而只能是以下约束同时成立：

- Agent 定义必须是普通文件和 Git 历史，而不是平台数据库中的画布；
- 已有 pilot 是带领域数据库和复杂代码的独立 repo，不能被迫改造成平台 plugin；
- 个人需要比“工作流成功”更细的业务健康契约；
- 需要平台保证的高风险副作用必须汇入自己掌控、独占提交凭据的 gateway；
- 希望模型、知识库和执行框架可替换，而不迁移整个 fleet；
- 愿意持续承担小型 runtime 的开发和维护成本。

### 4.7 n8n 的强项是集成自动化，不是领域 Agent 的所有权模型

n8n 对大量 SaaS 集成、webhook、定时任务和人工可读流程很有优势。若主要需求是“把系统 A 的数据搬到
系统 B，中间让 LLM 判断一次”，它通常比 Hangar 更合适。

Hangar 只有在 Agent 需要保留独立领域代码、状态、安全规则、eval、长期健康语义和个人 fleet 身份时
才有额外价值。Hangar 不应与 n8n 比 connector 数量；需要普通集成时，应复用 MCP、HTTP 或现成服务。

### 4.8 模型厂商 Agent SDK 适合作为推理构件，不适合作为唯一控制权来源

厂商 SDK 通常最快获得最新模型能力、内置工具和 tracing。Hangar 应允许它们作为 executor 或 node
provider，而不是重写它们。但长期 Agent 的定义、权限、运行历史和知识引用不应只能存在于某一厂商
控制面中。Agent Builder 的退场已经说明，厂商产品路线可以比个人自动化的寿命更短。

### 4.9 Buy / build / integrate 结论

此处不预先批准当前 Hangar、重写 Hangar 或任何外部平台；唯一决策来自 §6 的结果与 §7 的实测。

| 层 | 固定边界 |
|---|---|
| 模型、tool calling、Pi、MCP、connector、embedding、向量检索 | Buy / integrate，不以重造生态竞争 |
| 复杂 durable graph | Integrate；只在真实 Agent 需要时引入，不设为全局默认 |
| Agent 定义、发布、显式流程、Run、权限、effect、health | Build 或 adopt external winner；但必须存在单一明确 owner |
| Web/小程序/Telegram/CLI | Integrate 通道 SDK，自己拥有 typed control contract；客户端不复制业务规则 |
| Builder/compiler/workbench | 仅 `BuilderResult=native(control)` 时 Build；external 时 Integrate；no-winner 时不建设 |
| managed supervisor | 仅 `ManagedResult=control-core` 时 Build；external 时 Integrate；retain-agent 时由 Agent 自有 |

“完整掌控”的目标是拥有上述语义边界，不是将所有开源依赖 fork 进自己的仓库。能窄接口调用、pin、
观测、限权并替换的组件可以是黑盒；同时拥有会话、流程、状态、权限和副作用而无法展开验证的整体平台不可以。

---

## 5. 产品定义

### 5.1 首要用户

第一用户仍然是 owner 自己：会写代码、拥有多个长期运行的个人 Agent、重视数据和凭据控制，希望用
自然语言更快构筑新 Agent，但不愿把长期自动化锁进某个 SaaS 画布或一个难以展开的个人助手黑盒。
他希望通过构筑和检视 Hangar + Pi 理解 Agent 怎样处理上下文、工具、状态、失败和副作用，并能用 Web、
微信小程序、Telegram Bot 或 CLI 控制同一个 Agent。第一项可测工作不是再造一个
toy，而是把现有 inbox-pilot 当需求和验收基线，在两小时内构筑出可替换版本。

短期成功不以外部用户、star、模板数量或 connector 数量衡量，而以“是否显著增加自己能长期运行的
有用 Agent 数量，并降低维护成本”衡量。

### 5.2 核心工作

1. **构筑：**从目标描述生成或修改 AgentSpec、prompt、schema、fixture 与 eval。
2. **验证：**在发布前检查类型、拓扑、权限、安全路径、预算和 eval。
3. **显式编排：**确定性代码、policy、人工节点、Pi turn 和外部 runtime 都在可读 workflow 中组合，
   不把整条流程藏在一次自治 Agent loop 中。
4. **运行：**手动、cron 或未来的事件触发；支持取消、失败和明确终态。
5. **干预：**高风险动作以终端 effect intent 进入统一 Approval；低风险模糊输入先解释、再确认。
6. **解释：**从 fleet 到 run 再到 node，展开当时的 release、上下文快照、runtime、工具调用、状态 diff、
   审批、effect receipt 和业务裁决。
7. **学习：**运行记录和人工反馈成为改 prompt、规则和 eval 的材料，而不是让 Agent 无约束自改。
8. **挂载资源：**每个 Agent 声明自己的知识、memory、领域状态和工具边界。
9. **多界面控制：**为客户端提供稳定的 typed command/query/event/approval 契约；通道负责身份、会话关联和展示，
   不直写 Agent 状态。
10. **托管复杂程序型 Agent：**为 Auto Developer 一类 Agent 提供受控进程、取消、资源、事件和
   effect 契约；其临时架构可重写，但领域行为与故障语义必须通过冻结 oracle 保持。

### 5.3 明确不做

- 不以拖拽画布作为编辑真相源；
- 不把通用聊天、persona 或长期记忆的“自治助手”做成唯一 Agent 形态；
- 不在 core 中实现 Telegram/微信/Web 特有业务逻辑；
- 不将 Pi、LangGraph 或任何单一 runtime 写成无法替换的必选依赖；
- Builder/flow v1 不做任意环、通用 durable replay 或 Temporal 替代品；
- 不把 shell、文件系统或所有 MCP 工具默认暴露给生成的 Agent；
- 不把知识、memory 与业务游标塞进一个统一 vector store；
- 不做 connector marketplace；
- 不为了未来团队提前实现多租户、RBAC、SSO 和计费；
- 不强制把现有复杂 pipeline 重写成 flow。

---

## 6. 决策内核与条件架构

本节是方向决策的唯一规范来源，不是 effect 或 cutover 的实施规格。Stage 1 的 OpenSpec 必须为 winner
补齐穷尽状态表和可运行测试；本文不授权在 benchmark 之前实现这些能力。

### 6.1 三项所有权决策

- `ControlResult = hangar | external(id) | no-winner`
- `BuilderResult = native(control) | external(id) | no-winner`
- `ManagedResult = control-core | external(id) | retain-agent | no-winner`

`ControlResult` 是主决策：谁拥有 AgentRelease、显式 workflow、Run 身份、状态转移、权限、effect、
health 和统一控制 API。`external(id)` 只在外部组合通过透明控制硬门时合法；此时 Hangar 实现归档，
契约和 oracle 迁入 winner 的正式扩展/API 边界。`no-winner` 表示暂不建个人平台，保留各 Agent 自有运行方式。

Builder 和 managed runtime 是两个独立能力。外部 Builder 可以为 Hangar 生成候选 release；Auto Developer 也可
永久保留自己的 supervisor，此时只证明 Hangar 能触发和观察它，不宣称通用 managed runtime。

任何 capability 在一个 activation 中只能有一个 owner。不允许同时让 OpenClaw 和 Hangar 各自保存一份
“真实 session/run”，也不允许让 Pi 内部重试与 Hangar 重试同时生效。双重 owner 不是灵活，而是不可判定。

### 6.2 条件架构（仅 `ControlResult=hangar`）

```text
Web / 微信小程序 / Telegram / CLI
                 │
        typed command/query/event/approval
                 ▼
        Hangar Control API + identity
                 │
     AgentSpec compiler + AgentRelease
                 │
        explicit workflow + Run log
        ┌────────┼──────────┐
        ▼        ▼          ▼
  deterministic  Pi/runtime   human/effect
      code         adapter       gateway
        └────────┼──────────┘
                 ▼
 domain state / knowledge / memory / receipts
```

边界如下：

1. **Agent Package：**`AgentSpec + workflow + prompts + policies + fixtures + evals + resource refs`，普通文件/Git 为真相源。
2. **Compiler/Release：**解析类型、引用、权限、runtime 版本、成本与健康契约，生成内容寻址的不可变 release。
3. **Workflow engine：**v1 只拥有单 Run DAG、有界分支/顺序 `foreach`、取消和明确终态；不伪装成 Temporal。
4. **Runtime Adapter：**统一接受冻结上下文、工具清单、预算、deadline 和 cancel，返回结构化事件；Pi 是首个参考 adapter。
5. **Domain boundary：**cursor、dedup、outbox、领域状态和业务裁决属于 Agent 自己，Hangar 不把它们混成通用 memory。
6. **Effect gateway：**runtime 产生 intent，独立受信提交者持有高风险凭据；所有 unknown outcome 显式 reconciliation。
7. **Control clients：**界面通过同一契约读状态、下 typed intent、回答问题与处理审批；不直读写数据库或 Agent 文件。

### 6.3 透明控制硬门（所有 `ControlResult` 候选）

候选若任一项不通过，不能用功能数量、社区规模或构筑速度补分：

1. 对任一 Run，能定位不可变 release 和实际 runtime/model/tool/entitlement 身份。
2. 能按节点展开触发原因、输入/上下文快照、决策、工具调用、状态 diff、输出、失败和下一状态。
3. 一个 runtime adapter 可在不改 Agent 领域存储、effect 契约和客户端的情况下被另一实现替换。
4. Web、小程序、Telegram 和 CLI 发出的同一 typed intent 经过同一权限、Run、审批和审计路径。
5. 高风险 effect 只有一个持凭据的提交 owner；模型/runtime/channel 不能绕过，结果不明时不自动重提。
6. 停止、超时、crash、retry、resume、cutover 和父死都有单一 owner 与可测终态；不用“命令返回 0”代替业务成功。
7. 从 clean checkout 可导出或重建 Agent 定义；采用外部平台时，还要列出不可导出的运行时语义。

### 6.4 所有 winner 必须满足的运行不变量

1. **Release identity：**每个 Run 固定到可验证执行身份。Hangar flow/pipeline/process 分别锁定全部引用、
   bundle/dependency 或 binary/image；external adapter 锁定 workflow/deployment/runtime revision。无法 pin
   的整个执行目标标为 `non-reproducible`，不能由 release hash 宣称可重放。
2. **Effect safety：**只有 gateway-governed effect 可宣称高风险受控；risk/最低 Approval 由 host registry
   定义，Agent 只能收紧。外部结果不明时禁止盲目重提，领域状态未幂等 reconcile 前不得报告业务完成。
   任意中段 continuation 不在 v1；实施状态机必须覆盖 dispatch、拒绝、过期、unknown、domain failure、
   人工处置和 owner cutover。
3. **Single owner：**release 内容与 activation 分离；scheduler、supervisor、effect commit 使用持久
   epoch/fencing。cutover 在旧 admission 关闭、在途进程收敛、所有未决 effect/domain reconciliation
   终结或仅转移 reconciliation ownership 后才可激活新 owner；转移不能再次 dispatch 外部 effect。
4. **External qualification：**每个 Run 记录实际 workflow/runtime、provider/model revision/fingerprint、
   entitlement 和 billing route。activation 前必须通过冻结 drift eval；identity/route 变化使 qualification
   失效并重跑。硬安全 fail 或 unknown 一律 quarantine、停止 gateway effect；普通质量 fail 标 degraded
   且不能宣称合格。本地定义改变产生新 release，纯远端漂移产生新的 qualification record。
5. **Trust boundary：**受信 pack/pipeline/process 若直接持有宿主凭据，不受结构性安全保证，也不能计入
   “高风险受控”。非受信代码的 OS/网络/文件系统 sandbox 属于 **[out-of-scope]**。

Stage 1 的实施规格必须把上述不变量展开为 `state × event → transition | blocked | terminal error`，覆盖
effect committed 后领域写失败、各未决状态下 cutover、cutover crash、drift fail/unknown；否则不得实现。

---

## 7. 两个硬验收基准

### 7.1 Inbox Rebuild Challenge：证明构筑速度

#### 计时口径

挑战开始前冻结 clean baseline 与可复用资产 hash。只有此前已公开、非 inbox 专用的平台组件，以及
用户自己的标签、prompt 和已批准安全规则可以复用；验收 fixture 只属于 evaluator。禁止 import 旧
`run()`、调用旧服务完成核心处理，或把旧 pipeline 塞入代码节点。

同时记录四项，硬门只看第一项，但决策使用全部成本：

- `T_attempt`：从候选首次看到 challenge brief/manifest，或更早发生的候选专属推理、命令、配置动作，
  到提交不可变 AgentRelease 的**连续墙钟时间**；包含 AI/模型/工具等待、调试和专属 adapter，硬门
  为 **≤2 小时**。
- `T_active`：owner 主动操作时间，只用于解释效率，不能替代 `T_attempt`。
- `T_ready`：从干净主机到平台、账号和凭据可用的墙钟时间。
- `C_platform`：为了让候选具备参赛能力而预先投入的平台/pack 建设人时、墙钟等待、代码量和维护面；
  `C_enable` 单列每个 Agent 的专属适配成本。两者进入总拥有成本，不能藏到两小时之外。

若 mail pack 在挑战前专门为 Hangar 开发，它必须计入 `C_platform`；没有第二个独立消费者时还要标为
inbox 产品资产。现成平台的私有 connector 或自定义节点遵守同一规则。

每个候选对每个 sealed task 只有一次计分提交，并从同一 clean-baseline hash 开始；失败产物不得带入
另一计分尝试。评测关闭前只返回聚合结果，不泄露 case。若研究性重试获准，必须使用预登记的新分片/
seed，并把所有尝试的累计墙钟和主动时间计入成本，不能只报告最后一次通过。

#### 98% 的计算口径

先把 inbox 的 OpenSpec、硬约束、生产行为和故障 fixture 规范化成原子 `inbox-parity` manifest。每项
记录唯一期望、normative source、版本/hash 和 `supersedes` 链；硬安全与 owner 批准的目标需求优先，
生产行为只证明已有能力或产生失败 fixture，已知事故不能成为成功语义。任何冲突必须由 owner 标成
`preserve` 或 `known-false-green-to-fix`，未裁决项为零后才冻结分母、权重和 category。

1. Gmail 与 IMAP 取件、规范化及多账号；
2. 增量游标、高水位、dedup 与重启不重复；
3. 结构化分类、低置信度/模型失败降级；
4. 确定性 safety policy；
5. P0–P4 的通知、摘要、标已读、标签/文件夹动作；
6. P4/敏感邮件永不自动标已读，绝不自动发信；
7. per-email/run timeout、重试、死信或其经批准的等价降级；
8. 凭据与正文脱敏；
9. 规则配置、反馈增删和运行中生效语义；
10. run/node liveness、readiness 与 outcome 健康信号。

合格同时要求：原子 requirement 覆盖率 ≥98%、预先加权分 ≥98%、每个 category ≥95%。以下是
**100% 硬门**：绝不自动发信、P4/敏感邮件不自动标已读、低置信度保守降级、去重不产生重复副作用、
凭据不泄露。开发集可见；holdout custodian 在隔离执行边界内持有有 digest 的只读分片和一次性 final
reserve，候选与 Builder 不得读取。提交后运行故障和 mutation cases；custody 违规或缺失/跳过/未运行
均计 0，不按同名节点计分。

30 天 soak 使用冻结 ledger：按账号/类别规定每日最低受控输入和处理 deadline，逐项验证
`source → domain commit → 允许的 effect receipt` 的 1:1 或 0:1 基数，要求零未解释 effect；旧 inbox
退出处理链或仅无副作用 shadow。按日程注入故障，任何 deadline、基数或安全违反使窗口重新计时；最后
重跑 parity。集中补做、无真实输入或只有 `run completed` 均不通过。

#### 候选平台选择规则

实验前先建立一个完整方案 leaderboard，再为 Builder 和 Managed runtime 建两个子榜。候选至少包含：

- `Hangar + Pi adapter`：可丢弃重写 spike，不默认复用当前 core；
- `OpenClaw native/ACP`：同时测试原生使用和仅作 edge/runtime adapter，不以一个最重形态代替全部结果；
- `LangGraph + 最小可用控制层`：必须把为补齐控制产品而写的代码和运维全部计入；
- `LangSmith Fleet + external domain service`：计入 SaaS 数据/用量边界、外部 MCP/领域服务和退出成本。

完整方案首先通过 §6.3 七项透明控制硬门；失败即淘汰，不进入加权排名。过门后 100 分为：新 Agent
构筑与修改效率 20、Inbox 正确性 20、Auto Developer 复杂度上限 15、多界面控制 10、12 个月 TCO 20、
可迁移/退出 10、日常运维 5。外部候选若能通过硬门且与 Hangar 分差 `<5`，默认选外部方案。

子榜允许不同 winner：

- **Builder：**Inbox 硬门之外，每个 finalist 还做一个不可复用该领域 prompt/rule/fixture 的 sealed 新领域
  task；测量从目标到可审查不可变 release 的时间。
- **Managed runtime：**候选至少含一个非 Hangar 的完整 buy/integrate 栈（例如 supervised worker +
  Temporal，或 Kubernetes Job/Argo 类部署形态）和 Hangar 条件 spike；各自必须实际拥有中立
  process-fixture Agent 的 supervisor，再 shadow Auto Developer。Baseline 兼容不获得 managed 分。
  100 分为故障/终态 40、owner handoff 20、集成 15、12 个月 TCO 15、可迁移 10。

Stage -1 为每项原始指标冻结确定的 raw→score 函数；缺证据计 0，硬门缺证据即淘汰，owner 偏好只能
否决 winner，不能补分。先测现成方案，再批准同 rubric、固定预算、可丢弃的 Hangar spike。所有 winner
必须达到预登记 threshold，否则输出 §6.1 的 `no-winner`；managed 也可由 owner 明确选择 `retain-agent`。
结果直接写成 `ControlResult/BuilderResult/ManagedResult`。

只要 Control、Builder 或 Managed 中有两个以上的 owner 准备作为一个系统运营，就必须用 sealed 端到端 Agent 通过 composition
gate：definition/release 导入、trigger、Run/cancel、gateway intent/receipt、health 和 rollback 均互通，
且组合 `C_enable/TCO` 过上限；winner 同名不豁免。未通过者只能作为多个独立平台运营并计入重复控制面、
凭据和运维成本，不能称为一个组合平台。

### 7.2 Auto Developer Hosting Challenge：证明复杂度上限

Auto Developer 不是声明式 inbox 的放大版。当前生产围栏包含：

- P1/P2/P4 fresh Agent session 与阶段不对称的权限、skills、工具配置；
- thinking-aware silence、wall-clock、tool-use 和重复事件 watchdog；
- 父进程存活时的进程组 TERM→KILL、后代清理与取消；父进程硬死收敛是待修目标；
- phase retry、失败 snapshot、stream JSONL 取证、SQLite resume 与 idea 固定；
- P4 report、dirty-tree 和 soft-pass；
- P5 发布、P6 通知及其业务门禁；
- runtime/provider/protocol/model/订阅 entitlement 分离，禁止静默按量 fallback；
- 单一 scheduler owner 与可回滚 cutover。

先把这些行为、artifact gate 和故障场景规范化成 `autodev-hosting` oracle：每项有稳定 id、来源和
`preserve | known-false-green-to-fix` 裁决，hard safety/property 优先于当前实现的偶然行为。例如
`Result: NOT RUN` 必须成为负 fixture，而不能继承 fuzzy PASS。现有 daily pipeline、`ProcessSupervisor`
和 scheduler ownership 是临时实现，不是要保护的架构。

| 阶段 | 后代进程 signal/reap owner | candidate runtime 角色 | 出口条件 |
|---|---|---|---|
| Baseline | Auto Developer | 只启动顶层 controller、传递 cancel；不 signal/reap 其后代 | 冻结 oracle 与 PID/事件证据 |
| Shadow | Auto Developer | 观察进程树和事件，禁止控制后代 | silent/late child、TERM→KILL、父死、partial stream、spawn 中 cancel 均与 oracle 对齐 |
| Atomic cutover（可选） | candidate runtime | 独占受管进程树生命周期 | process-fixture 与第二个 Agent 证明通用性；按 DeploymentActivation 提升 epoch 并删除/禁用旧路径 |

也可以永久停在 Baseline，由 Auto Developer 保留内部 supervisor；这只证明托管兼容性。若选择重写，
phase/session/watchdog/retry/resume 只在跨 Agent 复用后上移，领域裁决仍由 artifact/state machine 给出。
要宣称 managed runtime 能治理高风险动作，P5 publish 凭据必须迁到 §6.2 effect gateway；保留内部 publish 的
Baseline 不获得该能力分。

所有入围候选先拥有同一 process-fixture Agent 的完整 lifecycle，再运行 silent/late child、wall-clock、
部分 JSONL、父死、spawn 中取消、TERM→KILL、ambiguous effect、resume 与双 scheduler 故障。只有通过者
进入 Auto Developer Shadow/Canary；切换统一使用 admission barrier、drain、epoch/fencing 和新 epoch
回滚，stale schedule/spawn/signal/effect 全部 fail-closed。quiescent 或 exit 0 不等价于业务成功，必须
以裁决后的 artifact gate、domain commit 与 effect receipt 判断。

### 7.3 三项验收如何共同限制架构

- Control 的 go/no-go 先看 §6.3 七项硬门、两张真实客户端与 12 个月 TCO；功能清单不能弥补流程与状态黑盒。
- Builder/flow 的 go/no-go 只看 Inbox Challenge、至少三个不同 trigger/resource/effect 组合的持续使用
  Agent，以及通用声明式节点是否减少构筑和修改成本。
- Managed runtime 的 go/no-go 只看 `autodev-hosting` 与第二个进程型 Agent 是否证明 supervisor、取消、
  事件和终态契约可复用。
- 三者只共享 AgentRelease identity、Run/cancel、结构化事件、终端 effect intent/receipt 和健康事实。只有其中
  一个通过时，保留通过的部分；多个通过仍需报告共享代码与契约，不能把多个并置产品称作同一抽象。

---

## 8. Native Builder 候选的 AgentSpec 形状

以下仅在 `ControlResult=hangar` 且 `BuilderResult=native(control)` 时用于说明边界，不是 v1 schema：

```yaml
id: research-brief
executor: flow

triggers:
  - type: cron
    name: morning
    schedule: "0 8 * * *"

resources:
  knowledge:
    - id: personal-notes
      provider: local-directory
      ref: ./knowledge
      access: read-only

flow:
  nodes:
    query:    { kind: input, out: Query }
    source:   { kind: input, out: ArticleList }
    retrieve: { kind: retrieval, knowledge: personal-notes, in: Query, out: Evidence }
    judge:    { kind: agent, prompt: prompts/judge.md, in: [ArticleList, Evidence], out: Decision }
    policy:   { kind: policy, impl: policies/publish.ts, in: Decision, out: SafeDecision }
    publish:  { kind: action, tool: notify.private, in: SafeDecision }
  edges:
    - [query, retrieve]
    - [source, judge]
    - [retrieve, judge]
    - [judge, policy]
    - [policy, publish]

permissions:
  approval: [notify.private]

health:
  - { node: source, expect: invoked, within: 26h }
  - { node: source, expect: produced, within: 7d }
  - { node: publish, expect: dependency_ready }

evals:
  - evals/relevance.yaml
  - evals/no-unsupported-claims.yaml
```

Builder 修改的是这些声明及其引用文件；发布动作面对的是可审查 diff，而不是一句“已经帮你改好了”。

---

## 9. 知识、Memory 与运行状态

三者必须从第一天分开：

| 类型 | 含义 | 典型内容 | 所有权 |
|---|---|---|---|
| Knowledge | 可检索语料 | 文档、代码、邮件、笔记 | Agent/resource provider |
| Memory | 跨交互积累的经验 | 用户偏好、已确认事实、情节记忆 | Agent；有明确写入策略 |
| Operational state | 保证处理正确性的进度 | cursor、dedup、高水位、outbox | Agent 领域存储 |

Hangar core 只管理资源引用、访问策略、健康与审计元数据，不直接拥有任意领域表。第一种 knowledge
provider 可以是本地目录加一个可重建索引；后续可以接 pgvector、Qdrant、厂商 file search 或 MCP。

每个 knowledge resource 至少需要：稳定 id、provider、来源、访问模式、索引版本、刷新策略、删除语义
和 provenance。Embedding 版本变化必须能触发重建，删除源文档必须能传播到索引；“可以检索”不等于
“索引是新鲜和可追溯的”。

Memory 写入比 retrieval 风险更高。v1 可以只读 knowledge，不急于提供自动长期记忆；等出现真实
用例后，再定义哪些节点可以写 memory、如何纠错、过期和删除。

---

## 10. 从 run 级绿灯升级为 Agent 级健康契约

“run completed”只能证明函数返回，不能证明 Agent 完成了职责。节点观察也不能只记
`last_produced_at`：例如没有高优先级邮件时，通知节点长期零产出是正确行为。

每个节点至少区分：

- `invoked`：被调用；
- `produced(count)`：产生结果；
- `skipped(reason)`：因空输入、dedup、policy 等跳过；
- `degraded(reason)`：依赖缺失或使用降级路径；
- `failed(error)`：执行失败。

AgentSpec 再声明哪些事实应在多长时间内发生。数据源定期被调用属于 liveness，连接器凭据和配置可用
属于 readiness，业务结果多久出现属于 outcome。三者不能互相替代。这样才能区分“今天没有重要邮件”
与“邮件源三周没工作”，也能在通知渠道从未可用时直接报 readiness 失败。

---

## 11. Native Builder 候选的交互原则

仅当 `BuilderResult=native(control)` 时采用以下交互；external winner 保留原生 authoring，但仍须通过 §6.3 与
composition gate。Hangar Builder 不是拥有任意写权限的聊天机器人，而是一条受约束的构筑流水线：

1. 用户描述目标、输入、输出、数据源和允许的动作；
2. Builder 选择已有 node/provider，生成 AgentSpec 和缺失资源；
3. compiler 返回确定性的类型、权限和引用错误；
4. Builder 修正并生成 fixture/eval；
5. workbench 展示文件 diff、只读流程图、权限摘要和预计成本；
6. 用户确认后 dry-run；
7. dry-run 通过后才 publish/register；
8. 后续修改重复同一流程，不允许直接覆盖已部署版本。

Builder v1 可以起草声明式节点，也可以起草受信 TypeScript workflow/policy，但两者的发布级别不同：
声明式组合经 compiler 通过后可进入 dry-run；新的可执行代码还必须经人审 diff、沙箱 fixture 与明确信任提升。
AI 生成内容始终是不可信候选，不因“由 Builder/Pi 生成”而获得更高信任。

---

## 12. 分阶段路线与出口闸

### Stage -1：先冻结透明控制契约与 oracle

在任何候选专属实现之前，先把 §6.3 的每一项“可展开、可替换、单一 owner”改成可运行 fixture，
裁决 `inbox-parity` 与 `autodev-hosting` 的规范冲突，再冻结 clean baseline、holdout custody、可复用资产、
候选部署形态、完整方案榜和两份子榜的硬门/raw→score/adoption threshold、
成本口径与 tie-break。此时只读取现有实现提取 oracle，不建设 Hangar flow/Builder。

**出口闸：**oracle 冲突账本无未裁决项，manifest/fixture 有稳定 id/hash；另一人能从相同原始证据重算
三个 result，且计时、sealed task、custody、缺证据与失败处理无自由裁量。

### Stage 0：候选实测与有界 Hangar spike

先测试 OpenClaw、LangGraph + 薄控制层与 Fleet + external domain service 的最小完整组合，再批准固定预算、
可丢弃的 `Hangar + Pi` spike。每个候选都先跑透明控制硬门和多界面同一 intent，再跑 Inbox 与 sealed 新领域
task；managed finalist 必须实际控制 process-fixture Agent，而不是借 Auto Developer 的旧 supervisor 得分。spike 不修改产品
SOT，也不因既有 Hangar 代码自动延长预算。

**出口闸：**每个候选都有计时、覆盖率/故障硬门、`C_platform/C_enable`、定制 glue LOC、部署组件和
12 个月成本；`ControlResult/BuilderResult/ManagedResult` 可不同，组合成本仍过门，也允许归档当前 Hangar。

### Stage 1：批准方向并更新 SOT

按 §6.1 结果修订 `DESIGN.md`、`ROADMAP.md` 与 `openspec/config.yaml`。若 `ControlResult=external(id)`，明确归档范围、
契约/oracle 迁移位置、退出方案和外部 owner；若 `ControlResult=hangar`，批准的也只是 §6.2 的最小透明内核，
不是现有架构整体延续。`no-winner` 不产生平台扩建 change。

**出口闸：**SOT 写清三项 owner、信任域、release/activation/runtime/channel adapter、个人优先边界与单一
真相源；外部 winner 不被强制转换成 Hangar AgentSpec。

### Stage 2A：落实 Builder winner + Inbox replacement

仅 `BuilderResult` 为 `native(control)/external(id)` 时运行本阶段；`no-winner` 直接跳到其它有效赛道。Native
winner 才实现受限 workflow、Builder、mail pack、类型/事件/effect 路径；external winner 通过其正式 export/API
产生或发布到 control winner，不要求伪装成 AgentSpec/workbench。两条分支都参加 Inbox Challenge；旧 inbox 只作 oracle、
shadow 和回滚。

**出口闸：**`T_attempt` ≤2 小时、原子与加权覆盖率均 ≥98%、category ≥95%、五项安全门 100%，并按
§7.1 完成有受控输入和 receipt 对账的 30 天 soak。mail pack 没有第二个消费者时明确记为产品资产。

### Stage 2B：Managed runtime + Auto Developer（独立 go/no-go）

仅 `ManagedResult` 为 `control-core/external(id)` 时运行本阶段；`retain-agent/no-winner` 保持现状或跳过，不得
宣称 managed runtime。其余先用 process-fixture Agent 验证 winner 的托管契约，再以 Baseline/Shadow；
只有第二个进程型 Agent 证明复用，才按 DeploymentActivation epoch 原子迁移并删除旧路径。Auto
Developer 可以围绕更优 Hangar 抽象重写，但裁决后的行为和故障 oracle 不降级。

**出口闸：**冻结故障注入无 orphan、重复 publish 或 false PASS；取消、父死和 late child 收敛；每次
handoff 有 admission/drain/epoch 证据，P5 通过 winner 的 gateway intent/receipt，canary 与新 epoch 回滚完整。

### Stage 2C：统一控制契约 + 两张真实的脸

本阶段不建“全渠道框架”。先以 Web 作为可展开运行与构筑的主界面，再选 Telegram Bot 或微信小程序中
实际使用价值更高的一个作为第二客户端。两者共用 typed command/query/event/approval 契约；通道自有身份、
消息关联、格式化和重连，不自有 Agent 业务状态。

**出口闸：**同一个 Inbox typed intent 从两个客户端发出时，必须经过同一个 release、权限、Run、确认/审批和
审计路径；一个客户端断线不影响 Agent 运行，也不能导致回复/审批被另一 Agent 误领取。

### Stage 3：验证 Builder winner 的平台价值

仅 Builder 有 active winner 时运行本阶段。用 winner 的原生 authoring 模型构筑至少三个持续使用、且
trigger/resource/effect 组合不同的 Agent；
记录连续三次改变输入、policy 或输出契约的发布，比较声明式与受信代码修改的墙钟成本。

**出口闸：**至少 80% 的上述发布只改 winner 的声明、prompt、policy 或 eval；无单 Agent 平台特例；owner
通过选定构筑面完成 diff/验证/发布，而不是绕回各 repo 手工注册。外部 winner 不要求使用 Hangar workbench。

### Stage 4：按需求引入 Knowledge provider

只有已持续使用的 Agent 无法通过现成 provider/MCP 满足知识需求时，才实现本地 knowledge provider，
并验证 ingest、provenance、刷新、删除、重建和 provider 替换；否则继续集成现成方案。

**出口闸：**需求 Agent 的检索 fixture 达标；删除/刷新无旧文档残留；替换 provider 不改变业务 flow。

### Stage 5：小团队另立赌注

只有第二个真实使用者持续使用后，才评估 workspace、actor identity、secret isolation、RBAC、SSO、
并发与远程部署。当前可以避免全局不可分割的资源命名，并保留 `agent/resource/actor` 标识，但不实现
团队功能。

---

## 13. 止损条件

满足任一项就应停止扩建或改用现成产品：

1. 三个 trigger/resource/effect 组合不同的真实 Agent 之后仍无法得到稳定通用 flow，只能不断加入领域特例；
2. 新 Agent 的主要工作仍是写 code node，声明式层只剩装饰；
3. Builder 生成的结果需要比手写更多的调试和审查时间；
4. 三个月内没有三个持续使用的 Agent；
5. 知识、eval、trace 或 durable execution 的维护成本逼近复用成熟平台的迁移成本；
6. 真正需求转向多人协作和大量 SaaS 集成，而非个人长期 Agent 所有权；
7. 为追平 OpenClaw、Dify、n8n、Flowise 或 LangSmith 的功能清单而开发，而不是解决自己的真实痛点；
8. 任一现成候选在对应 leaderboard 过硬门并达到 adoption threshold，Hangar 在该赛道停止自建；
9. 两小时指标只能通过预先手写一个与旧 inbox 同等复杂的 mail pack 达成，且该 pack 没有第二个消费者；
10. Hangar 无法比使用 Pi/OpenClaw/LangGraph/Fleet 原生日志更清楚地回答“这一次为什么这样跑”；
11. 为了让三种客户端接入，不得不在每个通道重写一份路由、授权、审批或业务逻辑；
12. 成本上限内无法使 Pi/runtime 保持窄边界，实际上只能让 runtime 拥有整条流程和未经管治的工具权限。

止损可以意味正式归档 Hangar 代码。应保留的是 oracle、契约、故障 fixture、安全裁决和产品经验，不是必然保留
某个 runtime。若只有 Builder 赌注失败，则仍可用外部 Builder 生成候选 release；若 Control 也败给外部 winner，
就不再为了品牌保留第二个控制面。

---

## 14. 最终判断

自己搭建 Hangar 的合理性不来自“现成产品做不到”，而来自以下组合是否对 owner 足够重要：

- 需要长期拥有 Agent 定义、运行历史、权限和知识引用；
- 已有多个带复杂领域代码和独立状态的 pilot；
- 希望 AI 显著降低新 Agent 的构筑成本；
- 希望通过显式 workflow 与 Pi/runtime 事件理解 Agent，而不是只使用一个完整黑盒；
- 希望 Web、微信小程序、Telegram 与 CLI 只是可替换的控制界面；
- 不希望被绑定到单一画布、模型厂商或 graph runtime；
- 愿意用克制的范围承担一个小型控制与构筑层的维护。

若这个组合成立，Hangar 值得继续，但它的产品不是“另一个全能 Agent 平台”，而是：

> **一个用文件和显式流程定义 Agent、用 Pi 等可替换 runtime 完成动态推理、从任意界面经同一契约控制，
> 并能把每次运行从触发一直解释到外部副作用的私人 Agent 工坊。**

若 OpenClaw、LangGraph + 薄控制层或 LangSmith Fleet + 领域服务能以更低 TCO 通过同一硬门，直接采用它们并归档
Hangar 会更诚实。在实测之前，本提案只批准评测和有界 spike，不批准大规模续建。

---

## 参考资料

[^langgraph-overview]: [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
[^langgraph-persistence]: [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
[^langsmith-fleet]: [LangSmith Fleet](https://docs.langchain.com/langsmith/fleet)
[^fleet-api]: [LangSmith Fleet — Access your agent from code](https://docs.langchain.com/langsmith/fleet/code)
[^fleet-export]: [LangSmith Fleet — Manage agent settings](https://docs.langchain.com/langsmith/fleet/manage-agent-settings)
[^langsmith-selfhost]: [Self-hosted LangSmith](https://docs.langchain.com/langsmith/self-hosted)
[^openclaw-gateway]: [OpenClaw Gateway](https://docs.openclaw.ai/gateway)
[^openclaw-embedding]: [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)
[^openclaw-multi-agent]: [OpenClaw multi-agent routing](https://docs.openclaw.ai/multi-agent)
[^openclaw-acp]: [OpenClaw ACP agents](https://docs.openclaw.ai/tools/acp-agents)
[^pi-docs]: [Pi documentation](https://pi.dev/docs/latest)
[^pi-rpc]: [Pi RPC mode](https://pi.dev/docs/latest/rpc)
[^pi-extensions]: [Pi extensions](https://pi.dev/docs/latest/extensions)
[^openai-agents]: [OpenAI — New tools for building agents](https://openai.com/index/new-tools-for-building-agents/)
[^agentkit-sunset]: [OpenAI — Introducing AgentKit（含 2026-06-03 产品退场更新）](https://openai.com/index/introducing-agentkit/)
[^dify]: [Dify documentation — Introduction](https://docs.dify.ai/guides/knowledge-base/retrieval)
[^dify-plugin]: [Dify documentation — Choose a Plugin Type](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)
[^flowise]: [Flowise Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2)
