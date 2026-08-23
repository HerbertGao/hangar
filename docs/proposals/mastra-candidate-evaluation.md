# Mastra 候选评估 — `personal-agent-builder` §4/§6 附录

> 状态：候选评估，不是架构 SOT。`DESIGN.md`、`ROADMAP.md`、`openspec/config.yaml` 仍是权威。
> 定位：`docs/proposals/personal-agent-builder.md` §4「为什么不直接用现成平台」与 §6.3「透明控制硬门」的附录。
> 取证：2026-08-21，来源为 Mastra 官方文档与官方博客（见文末）。未经文档实证的判断一律标 `未查实`，
> 不计入裁决依据。
> 裁决：Mastra 是 Harness adapter 与 client/telemetry 依赖的**第一候选**，不是控制 owner；
> 它需要参加与其它外部候选完全相同的 §6.3 资格赛，不因功能重叠而获得豁免或特权。

---

## 1. 结论

1. **Hangar 的多数「想法」确实可由 Mastra 实现——但那部分不是 Hangar 存在的理由。** 重合区集中在
   M2（Harness、typed API、client SDK、Web）与 M4（knowledge/RAG）；M0/M1 冻结的语义（外层 attempt 单
   owner、fencing、受控副作用提交、containment 勘验）恰好是 Mastra 官方文档明确声明不提供的部分。
2. **「重复造轮子」的指控对 M2/M4 成立，对 M0/M1 不成立。** 按 `DESIGN.md` §13 最后一条
   （不因「必须全自研」而复制外部平台已经更好拥有的能力），M2/M4 的自建范围应重新裁剪。
3. **不给一等公民。** 一等公民等于承认它拥有 owner 语义，直接冲突 `DESIGN.md` 不变量 3/6/8 与 §13
   「把完整 Service 包在 Hangar 外再保留重复 session/schedule/effect owner」。正确形态见 §5。
4. **候选名单存在真实缺口。** `personal-agent-builder` §4.2–§4.4 与 §6 的外部候选是 OpenClaw、
   LangGraph、LangSmith Fleet、AgentScope。以当前形态看，Mastra 比其中任何一个都更接近 Hangar 的
   目标形状，却不在名单内。补齐名单是本附录唯一主张的改动。

---

## 2. Mastra 的当前形态

Mastra 已不只是 agent + workflow SDK。文档实证的能力面：

- **Harness 层**：Durable Agents、Background Tasks、Goals、Schedules、Signals / Signal Providers、
  Agent Controller。名词与 Hangar 的 Harness 撞车，语义不同（见 §3）。
- **工作流**：snapshot 持久化（`workflow_snapshots` 表，按 `runId` 标识）、suspend/resume、
  human-in-the-loop、time travel、step/workflow 两级 `retryConfig`、cron 调度（`pause`/`resume` 为 durable，
  写入 schedules 表，跨重启与重新部署存活）。
- **控制入口**：Mastra Server、server adapters/middleware、custom API routes、PubSub、client SDK；
  agents 与 workflows 具备 `.create()/.delete()/.pause()/.resume()/.run()` 的 CRUD 面。
- **权限**：JWT、Simple/Composite Auth、Custom Auth Provider、Fine-Grained Authorization。
- **执行环境**：Sandbox（Vercel Sandbox / E2B / Daytona）、Workflow Runners、Workers、多云 deployer。
- **界面与观测**：Studio（Editor / Deployment / Observability）、metrics dashboard、scorers、traces。

---

## 3. 逐条对照

判定口径：**可白拿** = Mastra 已有且更成熟，自建不划算；**形似神不似** = 名词对应但不满足 Hangar
不变量；**缺口** = Mastra 不提供，且其文档未声称提供。

| Hangar 概念（DESIGN 出处） | Mastra 现状（文档实证） | 判定 |
| --- | --- | --- |
| Harness 拥有 attempt 内推进（§5、§6） | Mastra 本体即此 | 可白拿 |
| typed Control API 唯一写入口（§8） | Mastra Server + client SDK + agents/workflows CRUD + FGA/JWT | 可白拿 |
| 显式 durable 边界与 checkpoint resume（§4.3、不变量 5） | snapshot + suspend/resume + time travel，跨部署持久 | 可白拿（语义仍需 §5 约束） |
| Knowledge provider 自治、不建统一向量库（§9） | RAG + MCP + memory，provider 可替换 | 大体等价 |
| 第二 client / Web（M2） | Studio + client SDK | 可白拿 |
| 核心零领域概念（不变量 1） | 同为通用框架 | 等价 |
| 不可变 `AgentRelease` + hash（§4.1、不变量 2） | 文档未见版本化 release / 发布—回滚模型 | 缺口 |
| Activation epoch 与 admission 单 owner（§4.2） | schedules 具 durable pause/resume，无 epoch 与 fencing | 形似神不似 |
| 外层 RunAttempt 与 `AttemptQuiesced` fence（§5、不变量 3） | 只有 `runId` + snapshot，无外层 attempt 身份；官方声明无分布式租约/锁 | 缺口（决定性） |
| Effect Gateway：intent→claim→dispatch→unknown→reconciliation（§7、不变量 7） | 无对应层；只有 step 重试 + 「请保证工具幂等」的使用约定 | 缺口（决定性） |
| Approval 为绑定 policy/release/epoch/expiry 的持久记录（§4.4） | `session.respondToToolApproval()`，但 pending approval 属 live session state | 形似神不似 |
| 受限子进程四条默认拒绝与 whole-tree hard reap（§6.1、不变量 13） | 依赖第三方 sandbox provider；deployer 将 `.env` 注入 sandbox VM；无子进程树回收保证 | 方向相反 |
| 健康契约 liveness/readiness/outcome 三分（§4.5） | metrics / scorers / traces | 缺口（可在 Agent 层自建） |
| 事件是真相、append-only、唯一 terminal choke point（不变量 4） | snapshot + traces + PubSub | 可观测，但非执行 authority |

---

## 4. 三条决定性证据

以下均为 Mastra 官方文档原文，且逐条落在 `ROADMAP.md`「全程硬门」上：

1. **无跨副本 owner 仲裁。** “Mastra doesn't provide a distributed lease or lock yet. In multi-replica
   deployments, every replica that starts with `recovery.durableAgents: 'auto'` will race to recover the
   same runs.” → 对应硬门「admission、Run、外层 Attempt/restart、terminal 各自单一 owner」。
2. **恢复语义是重放而非受控续跑。** “Recovery re-runs the agentic loop from the last snapshot, which
   re-issues LLM calls (real cost) and re-executes tool calls. Make sure your tools are idempotent before
   enabling automatic recovery.” → 对应硬门「unknown/committed Effect 不被自动重提」。Mastra 把幂等
   责任推给工具作者，Hangar 把它收进 gateway 的 claim/outcome 状态机。
3. **凭据边界与 §6.1 相反。** sandbox 隔离由 provider 决定，deployer 读取 `.env` 并注入远端 sandbox VM；
   文档未提供进程隔离、子进程终止或出站默认拒绝的保证（Daytona 的按目的地过滤是 provider 行为）。
   → 对应硬门「目标宿主在当前启动周期内通过 DESIGN §6.1 全部正向勘验」。

补充事实：durable agents API 标记为 Beta，“breaking changes may occur without a major version bump
until the API is stable.”

一句话概括分歧：**Mastra 把 durability 定义为「状态能存活」，Hangar 把 durability 定义为「恰好一次
提交且可归因」。** 二者不是同一个问题，因此也不是替代关系。

---

## 5. 接入形态与边界

若 Mastra 进入实现，只能是**受边界约束的 Harness adapter**，外加可选的 client/telemetry 依赖。接入时
必须关闭的 owner 级能力（否则即为双 owner）：

- `recovery.durableAgents: 'auto'` 必须关闭；外层恢复由 Control 的 RunAttempt 与 `AttemptQuiesced` 拥有；
- Mastra schedules 不得作为 Hangar Agent 的 trigger owner；trigger/admission 归 Control；
- tool approval 只能治理 Harness 内部可逆动作；受控 mutation 的审批与提交走 Approval + Effect Gateway；
- Mastra 侧不得持有高风险业务提交凭据（推送、发信、Git publish 等），凭据只在 gateway；
- Mastra server 若被用作控制入口，它必须**替代** Hangar 的对应 owner，而不是与之并存。

这与 `DESIGN.md` §6 对 AgentScope/LangGraph 的既有裁决一致，不需要新规则。

---

## 6. 对 SOT 与路线图的影响

- **不改**：`DESIGN.md` 的架构不变量、M0/M1 的范围与出口闸。M1 期间不引入 Mastra——heartbeat 要证明的
  正是 owner 边界，引入一个自带 recovery 与 scheduler 的 runtime 会污染判定。
- **需要一个具名 change**：把 Mastra 补进 `personal-agent-builder` §4 的候选 leaderboard 与 §6 的 adapter
  候选，并声明它按 §6.3 七项硬门与同一套 fault fixture 参赛。按不变量 13，此改动先于任何实现。
- **M2 应重新裁剪**：typed API、client SDK、Web/第二 client 是否自建，与 `harness-mastra` adapter spike
  一并裁决；spike 必须与 `harness-pi` 跑同一组 fixture：release identity、grant、effect-unknown、
  cancel/checkpoint、retry-owner、whole-tree reap。spike 计入 `C_platform`，并单列 glue LOC。
- **M4 应先问「买」**：knowledge provider v1 的出口闸是「第二个 Agent 可换 provider，control-core 零修改」；
  该条件在 Mastra 的 provider/MCP 之上同样可满足，自建需要额外理由。

---

## 7. 反向止损（可证伪）

若 Mastra 后续同时补上以下三项，则 Hangar control-core 的存在理由消失，按 `personal-agent-builder`
§4.2 的第一种判定执行——归档 Hangar runtime，把 oracle 与契约迁入 Mastra 的正式扩展边界：

1. 跨副本 lease/fencing，且外层恢复具备单一 owner 与单调 epoch；
2. 具备 claim、unknown 与 reconciliation 的受控外部提交层，且不自动重提 unknown；
3. 默认凭据剥离、出站默认拒绝且可 hard-reap 完整进程树的子进程边界。

反之，若 Mastra 只是在功能面继续扩张（更多 connector、更多 runner、更好 Studio），不构成对上述判定的
任何位移。功能数量不能补硬门的分。

---

## 8. 待查项

以下未查实，进入资格赛前必须补齐，缺证据按 §6.3 口径计 0：

- 各包的许可证边界，以及 self-host 与 Cloud 的能力差；
- schedules 的 misfire / catch-up / 重叠 occurrence 去重语义（文档未写；这正是 M3 前须冻结的 schedule change 内容）；
- Studio/Agent Builder 是否存在版本化发布与回滚（现有文档页未提及，不等于不存在）；
- workflow 重试与 `onError/onFinish` 的先后次序，以及重试耗尽后的终态定义；
- snapshot 存储在 SQLite/LibSQL 单机形态下的一致性与恢复演练结果。

---

## 9. 引用

- Mastra 首页与文档索引：<https://mastra.ai/>、<https://mastra.ai/llms.txt>
- Durable Agents：<https://mastra.ai/docs/harness/durable-agents>
- Agent Controller：<https://mastra.ai/docs/harness/agent-controller>
- Goals：<https://mastra.ai/docs/harness/goals>
- Schedules：<https://mastra.ai/docs/harness/schedules>
- Workflows（snapshots / suspend-resume / error-handling / scheduled）：<https://mastra.ai/docs/workflows/snapshots>
- Sandbox 部署：<https://mastra.ai/docs/deployment/sandbox>
- Studio 部署：<https://mastra.ai/docs/studio/deployment>
- 第三方评估（durability 边界）：<https://www.developersdigest.tech/blog/mastra-durable-typescript-agents>
