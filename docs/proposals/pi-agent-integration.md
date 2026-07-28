# 决策记录 — Pi Agent、MCP 与 hangar 的边界

> ⚠️ **历史探索记录,不是 SOT 或实施规格。** 当前执行结论见 `docs/proposals/pi-agent-roadmap.md`;架构/次序仍以仓根 `DESIGN.md`/`ROADMAP.md` 为准。
>
> **状态:** 探索完成,拆成三条独立路线;尚未开 OpenSpec、未写实现。

## 1. 最初的问题为什么被拆开

讨论从“让 Pi 诊断并帮助 pilot 自进化”扩展为:

1. view 对话框用 Pi 指挥 pilot;
2. 外部 agent 通过 MCP 驱动 hangar;
3. auto-developer 用 Pi 作为编码引擎并迁入 hangar;
4. inbox 地址降温作为第一枪。

这些不是一个架构问题:

- inbox 降温是已有低风险、可逆的 view 确认 UX;
- MCP 是新的互操作控制面,会破 #6/#7;
- auto-developer 是独立 pilot 迁移,真正高风险的是公网发布;
- Pi-as-client 与 Pi-as-coding-engine 是两个身份,不共享权限或生命周期。

把它们串成一个“通用 intent 授权”路线,会为了一个低风险 inbox 动作给 core 增加 durable proposal、nonce、状态、索引与第二切点,违反 seed-then-generalize。

## 2. 最终结论

### A. inbox 命令种子

保留现有:

```text
interpret-feedback → view 显示 canonical diff → 人确认 → apply-feedback
```

只补地址/domain 校验、可见回执和 `uncool`。不接 Pi、MCP、`intents:` 或 core。

### B. auto-developer 迁移

独立于 MCP:

```text
Pi 容器隔离
  → immutable publish manifest + fake-provider fault tests
  → 停 launchd / 门住直发 alias / 启 Hangar owner
  → ctx.propose('publish') → 现有 waiting_human → approve handler
  → 7 天 soak
```

公网发布使用现有 OS Approval,不新增 pre-run 授权状态。publish 是 pipeline 终点;批准后的 handler 负责发布、成功回写与通知。

外部发布不能承诺 exactly-once。可证明的结果是 `succeeded | failed-before-submit | outcome-unknown`;远端结果不明时禁止自动重放,先 reconciliation 或再次人工批准。

### C. MCP 互操作

延期成独立赌注。只有第二个真实 pilot/use case 出现,或 owner 明确接受破 #6/#7,才开新 OpenSpec。此前所有 `awaiting_authorization`、共享 intent seam、nonce、双索引和 Pi-0…Pi-7 方案均作废。

## 3. 承重事实

### Pi

- Pi 没有逐 tool-call 的交互审批 handshake。
- 较新 CLI 可用 `--no-tools`/`--no-builtin-tools`/allowlist 静态限制工具;工具数量与 flags 必须按钉版复核,不能沿用“永远只有四个工具”的旧描述。
- RPC/子进程比 in-process SDK 更适合当前 hangar 的 abort→TERM→grace→KILL 生命周期,但父进程硬死后的子孙回收必须另有 actor。
- Pi 的模型 credential 也不应进入 Bash-enabled 容器;由唯一 egress proxy 注入并执行路径/并发/预算限制。

### inbox

现有 view 写路径已经具备:

- 硬编码 allowlist;
- interpret/apply 两次短 run;
- 人确认后才 apply;
- 原子 overlay 写;
- `noise_senders` 对后续非敏感邮件降级。

因此第一枪缺的是校验、撤销与回执,不是 Pi 或通用 registry。

### auto-developer

已知形状:

- 已有 Hangar run adapter 与 scheduler-owner cutover guard;
- 生产 owner 仍需按真实 checkout 复核;
- Pi 作为 RPC coding runtime;
- 高风险面是 AD-P5/republish 等公网发布入口;
- hangar reaper 当前只回收 DB/锁,不等于回收 Pi/container 子孙。

落地前所有外部仓断言都必须重新以 file:line 核实。

## 4. 安全边界

### 不声称防同 uid 恶意 shell

hangar 的 CLI/SQLite 模型是单用户协作模型。能直接修改 DB、app.yaml、pilot 域文件或 import pilot 的同 uid shell owner 已越过 hangar 支持入口;`CLAUDE.md` 的“不直改 DB”是控制面契约,不是 ACL。

如果未来 threat model 真包含恶意同 uid/tool-enabled client,必须另立 privilege-separated broker/独立 UID/ACL 项目。不能靠 MCP tool omission、CLI 约定或 user-presence token 假装保护底层文件。

### auto-developer 的真实断路器

- Pi 容器拿不到 CF/发布 credential;
- 模型 credential 留在受限 egress proxy;
- workdir 是唯一可写 mount;
- 正常/异常/父死路径都清理后代;
- 所有 Hangar-mode 发布 alias 都收束到 immutable manifest + approved handler;
- provider lost-response 进入 `outcome-unknown`,不自动重放。

CSP 只是发布后浏览器能力限制,不替代 P4 或发布审批。

## 5. 作废决策台账

| 旧结论 | 当前判定 |
|---|---|
| Pi 是 hangar 固定“头”或驱动层 | 作废;Pi 只是可选 client / 某个 pilot 的执行引擎 |
| inbox 第一枪用 Pi/MCP 验证集成 | 作废;该用例不需要它们 |
| 一个 pilot 的能力足以抽通用 registry | 作废;等第二个真实 pilot/use case |
| MCP client 回显参数即可证明 OS 授权 | 作废;client 内 UI 行为不是 OS 可观测事实 |
| 给 low intent 建 pre-run durable Approval | 作废;过度设计并破 #8 枚举 |
| user-presence token 能防同 uid Bash 绕过 | 作废;文件/DB/域状态仍可直接访问 |
| publish idempotency key 保证整套 exactly-once | 作废;gateway 只给 at-most-once claim,外部结果需 reconciliation |
| 容器隔离与 scheduler cutover 必须依赖 MCP | 作废;auto-developer 独立迁移 |
| `connect-src` 单项 CSP 能挡全部外联 | 作废;需完整策略,且仍不是发布安全边界 |

## 6. 仍未决定的事

- 目标 host 的 container/control-FD 父死回收是否可靠;不可靠则选 external supervisor 或已落地 hard-crash containment。
- provider proxy 的具体实现与预算上限。
- Pi 将来若提供稳定 typed worker/SDK,是否替代手写 RPC union。
- 何种第二真实 pilot/use case 足以启动 MCP 路线 C。

## 7. 关键真相源

**hangar:**

- `CLAUDE.md` — 9 条不变量与控制面约束
- `DESIGN.md §3.4–§3.6` — Run 状态、reaper、gateway/Approval
- `ROADMAP.md` — 当前阶段次序与 cutover 欠账
- `SKILL.md` — CLI 控制面契约
- `packages/core/src/executor.ts` — RunContext、run 生命周期
- `packages/core/src/gateway.ts` — propose/PARK/approve,外部幂等边界
- `packages/core/src/reaper.ts` — DB/锁回收边界
- `openspec/specs/hangar-view/spec.md` — 现有两阶段命令写路径

**外部 pilot(落地前复核):**

- `inbox-pilot/src/pipeline.ts` — interpret/apply trigger 与 overlay 写
- `inbox-pilot/src/rules/applySafetyRules.ts` — noise/sensitive 规则
- `auto-developer/orchestrator/src/agent-runtime/pi-runtime.ts` — Pi RPC/runtime
- `auto-developer/orchestrator/src/scheduler-owner.ts` — owner/cutover guard
- `auto-developer/orchestrator/src/main.ts` / `publish.ts` — 发布入口与重试
