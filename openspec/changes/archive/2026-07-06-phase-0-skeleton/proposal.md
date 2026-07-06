## 为什么

hangar 的一切能力都要先能端到端跑一次,否则全是纸上谈兵。Phase 0 不解决任何真实业务,只回答一个问题:**这根脊柱的骨架能不能活?** 用一个约 30 行的玩具 app 把 `run → park → approve → trace` 整条链跑通,在动 22K 行的 inbox 之前先把设计证伪/证实。这是全职 solo 防止「造出精致废物」的第一道保险(见 ROADMAP Phase 0 出口闸)。

## 变更内容

搭建 `@hangar/core`(`packages/core`)脊柱骨架 + `hangar` CLI + 一个 `apps/heartbeat/` 玩具 app,使下述链路可跑:

- 扫 `apps/*/app.yaml`、zod 校验、`executor` 字段选执行方向(`pipeline` → 约定加载同目录 `pipeline.ts`)。
- SQLite(better-sqlite3)4 张表 `App/Run/RunEvent/Approval`;Run 状态**从 RunEvent 推导**,不靠 LLM 自称;run 锁行防重复执行。
- `Executor` 接口 + 唯一实现 `PipelineExecutor`(加载 app 的 `pipeline.ts` 的 `run(ctx)`)。
- Tool Gateway:动作实际执行体 = app 的 `tools.ts` 按名 handler 注册表(独立于 `run()` 加载);单入口 **async** `propose`(无直执行旁路,低危 await 执行、高危登记),查 `permissions.approval`,带**内存重试** + error 脱敏(不搬 durable retryQueue);approve/reject 先守 `state==waiting_human` 再取 run 锁。
- 审批 PARK 切点:`propose`(登记)→ run 结束 check-after-return → `waiting_human` → `approve`(并发安全、原子认领)→ `execute` → `completed`;支持一次 run 多次高危 propose。
- CLI:`run/status/runs/trace/approve/reject/doctor/daemon`,遵循 SKILL.md 契约(stdout=数据 / stderr=日志 / --json / 退出码 0·1·2 / 写操作拒绝 root / doctor 必存在 / 无参打印帮助)。

### 非目标(本次不做)

- 第二个 executor(`llm-direct` / `claude-code` / `codex`)—— 留 Phase 2。
- 任何域逻辑、inbox 迁移 —— inbox 是 Phase 1。
- 配置 UI、成本 enforce、更多触发器类型。
- HTTP / IPC / 消息队列、MCP、通用 durable replay —— 违反不变量,本阶段永不做。
- **多进程并发审批的完整仲裁**(并发 approve/reject 活 race、granting lease)—— Phase 0 单进程假设,守卫+取锁+reaper+幂等键已够;完整硬化留 Phase 1(已披露)。

## 功能 (Capabilities)

### 新增功能

- `app-registry`: app 定义(`app.yaml`)与加载 —— 扫 `apps/*/`、zod 校验、`executor` 选执行方向、`pipeline` 约定加载同目录 `pipeline.ts`。
- `run-engine`: 运行生命周期 —— SQLite 4 表状态库、`Executor` 接口与 `PipelineExecutor`、Run 状态从 `RunEvent` 推导、run 锁防重复。
- `tool-gateway`: 动作网关与 PARK 审批 —— 单入口 `propose`、`permissions.approval` 检查、**内存重试** + 脱敏、approve 并发安全、`propose → approve → execute` 一种切点。
- `cli`: 控制面命令契约 —— `run/status/runs/trace/approve/reject/doctor/daemon`,I/O 形状遵循 SKILL.md。

### 修改功能

<!-- 无。项目此前没有 specs,这是首个变更。 -->

## 影响

- **新增**:`packages/core/`(脊柱)、`apps/heartbeat/`(玩具)、根 `package.json` / `pnpm-workspace.yaml` / `tsconfig`、`hangar.sqlite`(运行时生成,已 gitignore)。
- **依赖**:`zod`、`pino`、`node-cron`、`yaml`(inbox 已在用);`better-sqlite3` 为**净新**原生依赖(inbox 用 prisma+postgres),需验证 node-gyp/预编译。
- **不影响**:任何现有 pilot(inbox / ppt / ai-radar 不动);无外部 API、无网络层。
- **出口闸(DoD)**:`hangar doctor --json` 全绿(且不建库);`hangar run heartbeat` → run 进 `waiting_human`(两个 pending);`hangar status --json` 正确;`hangar approve <run>` → `completed`;`hangar trace <run>` 显示完整事件时间线;run 锁生效。**外加防 false-green 断言**:并发/重复 approve 幂等(不双执行)、崩溃重启 reaper 回收锁、`action.failed`→`failed` 释放锁。
