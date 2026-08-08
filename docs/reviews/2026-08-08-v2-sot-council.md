# v2 SOT Council 评审记录（2026-08-08）

> **状态：评审记录，不是 SOT。** 本文记录一次对 `DESIGN.md` / `ROADMAP.md` /
> `docs/proposals/control-core-v2-migration.md` 的对抗式评审的结论、证据与 owner 裁决。
> 它**不修改**任何 SOT——按 `CLAUDE.md` §13「架构变更先改 SOT」，下文第 3 节的四条 delta 需要各自
> 落进 `DESIGN.md` / `ROADMAP.md` 后才生效。
>
> 评审 run：`68dae495`（council，incumbent-draft mode，5 席 + 对抗轮 + 交叉质询 + 两轮 DA）
> 终态：`UNRESOLVED (audit-failed: 5 open)` —— 原因见 §6，与结论有效性无关。
> 评审时三份文档的 digest：
> `DESIGN.md sha256:71c6346053470a943375075273ae66994884a3234149b5946ef717d0d72e7370`、
> `ROADMAP.md sha256:a9616e929a4dafebaf495d158eb462f13c3ae3636956ec822b7c05d47403fd4d`、
> `control-core-v2-migration.md sha256:220588de1440b084595975751d09c6559eb28a964b21f049a5ecb6b85f1e2aba`。

## 1. 结论一句话

**架构形态成立，无人主张替换；但有四处「已写下却没有内容 / 没有闸门 / 没有规范 / 与 owner 实际意图冲突」
的地方，需要在 M0 动工前处理。方案宣称的成本优势在当前 SOT 中不可证伪。**

处置 = `combine`：以现有 v2 方案为基座，补上凭据域的定义、健康契约的规范、需求侧止损，并先修一处
ROADMAP 与实际意图的冲突。四条 delta **全部是文档级改动，不改拓扑，零构建**。

## 2. 先说这份结论的证据地位

**不要把「五个席位都没主张替换」当作支持。** 本平台会把项目 `CLAUDE.md`（v2 SOT 的浓缩重述，含
`AgentRelease`、`Effect Gateway`、`heartbeat`、架构不变量 12 条、M0/M1 切片）注入每个 subagent 的上下文，
因此「盲搜」只在 prompt 层面成立、不在上下文层面成立。证据：两个无工具席位逐字引用了 `CLAUDE.md:89`
与 `:79`，经只读核实两句确实存在于该文件。四个非对立席随后全部让步，对立席在最终攻击轮把自己的候选
一并撤回证据地位，其原话是：**「本轮净结果不是『C5 被让掉』，而是本 run 未产出任何独立架构证据，含我的。」**

下面第 3 节的四条**不依赖任何席位意见**——它们是对仓库文本的只读检查结果，任何人都可以复跑。

## 3. 四处待补（含 owner 裁决）

### 3.1 `受限` 是一个空词

| 检查 | 结果 |
|---|---|
| `DESIGN.md:84` | 「Runtime 按 Run 启动**受限**子进程」（全文「受限子进程」COUNT 1） |
| `DESIGN.md` 中「出站」/「沙箱」/「隔离」/「白名单」 | **COUNT 0** |
| `DESIGN.md` 中「网络」 | COUNT 1，位于非目标行 `:286` |
| `control-core-v2-migration.md` 中「出站」/「剥离」 | **COUNT 0** |
| `DESIGN.md:134` | 「- `code`：确定性 TypeScript 函数；」——执行位置全文未规定 |
| 凭据条款 | 只有 `:153`（adapter 禁止持有）与 `:177`（gateway 唯一持有）两句 |

即：SOT 定义了「谁不许持凭据」和「谁唯一持凭据」，但没有定义**任何机制**使之在结构上成立。HC1⑤
「唯一持凭据提交者、不可绕过」目前是命名约定，不是结构保证。

**第二个消费者已经在生产**：`ai-radar` 已实现 `browser-worker egress/netns 封锁（封 RFC1918/link-local/
metadata、启动自检 fail-closed）`、`MR_SOURCE_DOMAIN_ALLOWLIST`、`recordPriceChange` / `setSourceUrl`
授权入口 + Telegram HITL，并写下红线「不为跑通放松 egress/fail-closed」。三个系统里只有 hangar 的 SOT
把这块写成空词。

**owner 裁决**：**现在补定义 + 写勘验条件**。
- 补：子进程以剥离凭据的环境启动、出站与 secret 默认拒绝、能力经 `capabilities` 显式授予；
- 补：`code` 节点的执行位置；
- 补：`trusted-direct-effects` 从「标注」升为 release hash 内的枚举白名单，未枚举者运行期不可达外部 sink；
- **同时写明该定义在哪种宿主上以什么方式正向勘验，未勘验前标注「声明而非保证」**。
  这一条来自 owner 自己的教训：`ai-radar` 的同类封锁被判「在 Docker Desktop 目标上不可正向验证」而剥离延后。
  只写要求不写勘验条件，就会再造一条「看起来完备、从不被读取」的治理声明。

> **状态：已处理（2026-08-08）。** `DESIGN.md` 新增 **§6.1「受限子进程」的定义与勘验**（四条默认拒绝 +
> 勘验条件 + `unverified-claim` 标注 + 威胁模型对象声明），§3 与 §5 指向它，§5 的 `code` 节点补上执行位置，
> §7 的 `trusted-direct-effects` 改为 release hash 内逐项枚举的白名单且条目数须单调不增。
> **owner 已确认**：`code` 节点与 `agent` 节点同样在受限子进程内执行，不在 `hangar-server` 进程内运行。
> 代价明确接受——需要一个 code-node ABI 与一次跨进程序列化，成本落在 M1；换来的是 §6.1 的四条默认拒绝
> 对 `code` 节点同样成立，`trusted-direct-effects` 因此是唯一的残余口子。

### 3.2 止损只管「造得对不对」，不管「该不该造」

`DESIGN.md:299-304` 的六条阻断项：共享 Run identity/双写/双 admission、stale epoch/gateway bypass/错误
actor、unknown effect 自动重提、projection 不可重建、Inbox clean build >120 分钟、M0+M1 >15 主动开发日。
**全部是内部正确性与进度触发器。**

| 检查 | 结果 |
|---|---|
| `DESIGN.md` 中「第三个」 | **COUNT 0** |
| `C_enable` 出现位置 | `DESIGN.md:294`（测量口径行）、`ROADMAP.md:48`（M0 冻结采集方式）、`ROADMAP.md:129`（M3 单列指标） |
| `C_enable` 出现在任何阻断条件中 | **否** |

对立席在最终攻击轮的判词值得原样保留：**「一个从不被任何闸门读取的度量，与不存在完全等价，且比不存在
更糟：书面口径制造了度量纪律的外观，消耗审查者的怀疑预算。」** 即便「第三个租户永远不出现」这一支点
假设被现实证伪，现有止损机制也不会响。

**待补**（无席位反对）：一条需求侧阻断项。度量采用 owner 的「不共改」纪律所自然产生的可数量——
**每个租户接入期间，提给 hangar 的核心变更建议条数**。租户既然不得与 hangar 同时改，凡接入被挡就必须
提 change，因此该条数**就是**「抽象边界画错的次数」，且不依赖记工时。与 `C_enable` 天数并列作为触发器。

**配套条款（必须一起立）**：接入被契约缺口挡住时，允许的动作是**「阻塞 + 提 change」，不得绕过**。
没有这句，压力会导向 `trusted-direct-effects`（`DESIGN.md:181`）这个现成逃生门——租户按期接入、平台
看似工作，而「受控 effect」的覆盖率悄悄下降。可观测的预警指标：每次接入后 `trusted-direct-effects`
标注点数量**不下降或增长**。

> **状态：已处理（2026-08-08）。** `DESIGN.md` §14 新增第七条阻断项（租户接入期间 `C_enable` 或
> 「提给 control-core 的核心变更建议条数」超阈值、或接入必须向 core 新增领域概念），并加一句区分：
> 前六项回答「造得对不对」，第七项是唯一回答「该不该继续造」的需求侧触发器。配套的不得绕过条款落在
> §12.4，白名单单调不增落在 §7。**阈值本身仍待 owner 用实测值回填**（ROADMAP M7/M8 暂写 ≤3）。

### 3.3 健康契约停在占位符——而它正是 owner 点名的痛点

| 检查 | 结果 |
|---|---|
| `DESIGN.md` 中「health」 | COUNT 2：`:109`（release 固定「health/eval 契约」一行）、`:195`（`GET /v1/health`） |
| `agent.yaml` 骨架 | `health: {}` |

owner 陈述的具体痛点是：**「无论是 Auto Developer 还是 AI Radar 都缺少运维监控点」**。而
`docs/proposals/personal-agent-builder.md` §10 早就写好了这套东西——每节点区分 `invoked` /
`produced(count)` / `skipped(reason)` / `degraded(reason)` / `failed(error)`，并把 liveness、readiness、
outcome 三者分开（「今天没有重要邮件」必须能与「邮件源三周没工作」区分）——**它没有被 v2 采纳。**

这是全场唯一一个**三个具名租户都要用**的能力。

**owner 裁决**：**不删任何现有枚举，只升格 health + 立规则。**
- health 从占位符升格为规范（节点级五态 + liveness/readiness/outcome 三分）；
- 立规则：**具名 + 有阶段 + 有出口闸的接入承诺，才算「消费者」**；纯「以后可能会用」不算；
- 现有节点种类枚举**全部保留**，作为三个租户接入的预留地基。规则因此按**对新增生效、现有枚举
  grandfather** 处理；`subflow` 登记为 owner 明确接受的已知例外（见 §5）。

这条裁决的内部逻辑由 owner 的「不共改」纪律支撑：租户既然不许在接入时改核心，契约就必须提前完整，
不能只留今天用得上的。

> **状态：已处理（2026-08-08）。** `DESIGN.md` 新增 **§4.5 健康契约**：节点级五态
> （`invoked` / `produced(count)` / `skipped(reason)` / `degraded(reason)` / `failed(error)`）+
> liveness / readiness / outcome 三类断言互不替代，并写明 `GET /v1/health` 只是它们的聚合投影而非定义。
> §4.1 的「health/eval 契约」条目指向 §4.5。**枚举未删**，按裁决全部保留为接入地基；准入规则已落在
> `DESIGN.md` **§5.1**——「具名 + 有阶段 + 有出口闸的接入承诺才算消费者」，对新增生效，现有枚举
> grandfather，`subflow` 作为唯一无具名消费者的条目在 §5.1 登记并带 M0/M1 复查点；§5.1 同时要求 M0 出口闸
> 补一条只读断言，绑定 contracts 的 node-kind 枚举不得超出 SOT 允许集合。

### 3.4 ROADMAP 与实际意图冲突，须先修

| 检查 | 结果 |
|---|---|
| `ROADMAP.md:183` | 「接管 Auto Developer supervisor 不属于 M5；必须另开 Managed Runtime change，并以中立 fixture 证明新 owner 更可靠。」 |
| `ROADMAP.md` / `DESIGN.md` 中 `radar`（忽略大小写，对评审时的 `HEAD` 复核） | **各 0 次** |

> 取证更正：本行最初引用的是一次**大小写敏感**的定值搜索结果（`radar` COUNT 0），据此断言「AI Radar
> 一次都没出现」是不严谨的——它不排除 `Radar`。事后已对评审时的 `HEAD` 做大小写不敏感复核，两份文档
> 各 0 次，**结论不变，证据写法已更正**。

owner 的实际意图是「Auto Developer 与 AI Radar 都按 v2 重写接入」。按 `CLAUDE.md:35`「架构变更先改 SOT」，
这两条必须先落进 ROADMAP（各自的阶段、预算上限、出口闸），否则第三个租户的工作不受任何闸门约束——
正是 §3.2 暴露的那个洞。

> **状态：已处理（2026-08-08，本次评审之后）。** `ROADMAP.md` 新增 **M7 AI Radar 租户化接入**（挂在 M2
> 之后）与 **M8 Auto Developer supervisor 接管**（挂在 M5 之后），各带预算上限、任务、出口闸与止损；
> `ROADMAP.md:183` 由「必须另开 Managed Runtime change」改写为指向 M8，前置条件未放松。
> `DESIGN.md` 新增 **§12.3 AI Radar**（只写所有权边界）与 **§12.4 租户接入纪律**（不共改 + 不得绕过 +
> 建议条数进出口闸）。预算数字与「≤3 条建议」阈值由 moderator 提出，**待 owner 用实测值回填**。

## 4. 两个租户的实际形状（接入设计时的输入）

**AI Radar**（`~/VSCodeProject/ai-radar`）：`redis`(BullMQ 队列) + `postgres`(drizzle，唯一索引决定去重) +
`worker` / `mr-browser-worker` / `web`(Hono `/health`) + `cloudflared`，docker-compose 部署。其 README 明写
「去重、推送状态、幂等与唯一约束由**程序和数据库**保障；LLM 只负责分类、摘要、价值评分、推荐解释」。
自带 MCP 外部访问面。流水线是线性的：Collectors → Normalizer → Dedup → Value Judge → Digest → Push。

**Auto Developer**（`~/VSCodeProject/auto-developer`）：launchd 07:00 触发 → ranking(`claude -p`) →
P1/P2/P4 三个**独立 fresh session 子进程、阶段间权限/MCP/silence/wall-clock/tool-use 围栏不对称** →
P4 PASS 后 orchestrator 原生 shell-out 跑 P5 publish(`wrangler`)、P6 notify(Telegram/飞书)。
SQLite run-state 逐 phase 原子落盘，跨进程崩溃可从第一个非 passed 的 phase `--resume`。

映射到 v2 节点：P1/P2/P4 = `agent` 节点（含 per-node entitlement）；P5/P6 = `effect` 节点（正是 gateway
该管的高风险提交）；三次重试 + 阶段续跑 = Run/NodeAttempt + durable 边界。

## 5. 仍然开着的问题

1. **`subflow` 无消费者**（owner 明确接受的例外）。三个具名租户的实际形状里都找不到它的消费者：
   Auto Developer 的 P1→P2→P4 是单 run 内的线性序列，不是可复用的有版本子图；AI Radar 是线性流水线。
   `CLAUDE.md:27` 架构不变量第 6 条已逐字含 `subflow`，移除成本从此刻起单调上升。
   **复查点**：M0 契约落地时清点 node-kind 枚举；若到 M1 出口闸仍无具名接入承诺指向 `subflow`，按 §3.3
   的规则删除。
2. **M0 contracts 枚举陷阱**。`ROADMAP.md` 从不约束 contracts 枚举什么（「subflow」在 ROADMAP 中 COUNT 0，
   M1 任务只是 `:72`「实现单节点 workflow 和 fake RuntimeAdapter」）。因此「orchestrator 未交付」与
   「分类已在 M0 固化并向下约束状态机与 SQLite 形状」可以同时为真。**建议**：M0 出口闸补一条只读断言，
   绑定 contracts 的 node-kind 枚举不得超出 SOT 允许集合。
3. **HC3 的 2 小时可达性今天无法查证**。需要 `inbox-parity` manifest（ROADMAP M0 的未勾选任务）才能逐条
   标注「可由声明文件表达」vs「必须改核心层」；阈值：>2% 的原子需求或任一安全门落在后者一侧。
4. **TCO 摊销缺可机械判定的证据**。AI Radar 被具名并承诺重写接入，这把支点从「押注」变成「已声明的意图」，
   但**不构成测量**。检查方式：每个租户接入完成后实测 `C_enable` 与 §3.2 的建议条数。
5. **勘验可行性未知**。§3.1 补的「出站/secret 默认拒绝」在个人电脑 + 常驻小主机上是否可正向勘验，
   目前无证据。
6. **health 契约升格的成本未估**，也不在任何阶段预算内。

## 6. 关于本次评审的终态

评审以 `UNRESOLVED (audit-failed: 5 open)` 收尾。原因是**评审流程自身的操作缺陷**，与上述结论无关：
moderator 把 run nonce 的生成与建立工作目录合并成了一条命令（`mkdir -p … && openssl rand -hex 4`），
而审计用的 pinned enumerator 以精确字符串匹配定位「出生事件」（要求 `command.strip() ==
"openssl rand -hex 4"`），因此找不到出生事件、退出 1、零行输出，A0–A9 与 I0–I5 全部**未触及**
（不是不通过）。审计员明确判定这**不在 fabrication 路径上**，且本 run 内不可修复（重新 roll 会得到新
nonce，重新声明第二个开场块会被判为 fabrication）。

评审员对自己的裁决未被审计确认这一点，与 §2 的证据地位声明，一并如实记录在此。§3 的四条以及 §5 的
复查点都基于只读文本检查，不受该终态影响。

## 7. 未被采纳但值得保留的反对（少数派）

对立席（最小改动视角）从未让步的立场，逐字保留：

- 「用最小候选替换现方案的今天的代码 delta 是零、文档与计划 delta 是全部……裁剪应发生在 M2 的实测数据上，
  不发生在今天的文档上。」
- 对「预留地基」的直接反对（owner 的裁决与之相反）：「任意性是**选取规则**的属性，不是集合大小的属性；
  把一份任意选出的清单扩大，只得到一份更大的任意清单，认证能力一点没增加……用扩建来回应一次反驳，
  等于自伤 TCO 半句。」

架构席对自己立场的最强反驳：「真实风险仍是交付风险：`C_platform` 先付、TCO 收益后收，最可能的结局不是
『架构选错』，而是停在 M2 半路——同时背一个半成品控制面和两个仍在自维护的 Agent，12 个月 TCO 严格高于
什么都不做。」
