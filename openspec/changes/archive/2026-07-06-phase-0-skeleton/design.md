## 上下文

Phase 0 是 hangar 的第一段代码,把 `DESIGN.md` 里定的脊柱骨架落成能跑的东西。架构决策的 SOT 是 `DESIGN.md`(7 个已锁分叉)与 `CLAUDE.md`(9 条不变量);本文只记 Phase 0 落地时的实现层选择,不重复 DESIGN。目标是一个玩具 app 跑通 `run → park → approve → trace`,在动 inbox 之前证伪/证实设计。

当前状态:空仓 + 四份设计文档 + openspec 配置。无任何实现代码。

## 目标 / 非目标

**目标:**
- `@hangar/core`(`packages/core`)最小可跑:SQLite 四表、app registry、`PipelineExecutor`、tool gateway、PARK。
- `hangar` CLI 覆盖 SKILL.md 契约的命令,`doctor` 全绿。
- `apps/heartbeat/` 玩具把整条链端到端跑通(= 出口闸)。

**非目标:**
- 第二个 executor、任何域逻辑、inbox 迁移、配置 UI、成本 enforce、HTTP/IPC/MCP、通用 durable replay(见 proposal 非目标 + 不变量)。
- **多进程并发审批的完整仲裁**(seq 竞争败者重试、approve-vs-reject 活 race、granting lease/超时回收)—— Phase 0 单用户单进程,run-state 守卫 + approve 取锁 + reaper + 幂等键已够;完整并发硬化**显式延后 Phase 1**(inbox 每天 cron + 可能多入口时才真需要),已披露非遗漏。

## 决策

**D1 — pnpm workspace:`packages/core` + `apps/*`。** host 需 `import` app 模块拿到带类型的 `run`;workspace 让 `@hangar/core` 被 app 复用。备选:单包混装(否 —— 脊柱与 app 必须分家,否则不变量 #1 从目录层就破)。

**D2 — SQLite 用 `better-sqlite3` + 原生 SQL,不上 ORM。** 四张表、同步 API,正合单 host 的 CLI/daemon。备选:drizzle/prisma(否 —— 4 表不需要 ORM;inbox 的 prisma 是它的**域库**,与 OS 状态库无关,不复用)。

**D3 — 无 HTTP/IPC:CLI 与 daemon 是同一 core 的两个入口,共享一个 SQLite。** `approve` 直接在 CLI 进程里对状态库 + gateway 执行第二阶段,不通知 daemon;daemon 只跑 cron。并发靠 SQLite `PRAGMA busy_timeout` + Run 活跃状态锁(事务化 check-and-insert)+ approve 对每个 Approval 的**原子认领**(`UPDATE … WHERE status='pending'`,防两个进程重复执行同一高危动作)。**Phase 0 用 DELETE 日志模式(非 WAL)**:只读命令对已存在库零写入、不留 root-owned sidecar(WAL 只读仍造 -shm);WAL 的读写并发是多进程收益,延后 Phase 1。备选:daemon 独占状态、CLI 走 socket/HTTP(否 —— v0 过度设计,破 #6)。

**D4 — 状态从事件推导,`Run.state` 只是缓存列。** 真相源永远是 `RunEvent`;`classify(events)` **全映射**重算 state,写终态事件 + 更新缓存 + 释放锁**同一事务**。**免费的只有 `waiting_human` 的跨重启存活**;`running`/`executing` 中途被杀(非抛错)不会自动恢复,需**启动期 reaper**(死 `lock_owner` PID + 非终态 → 补 `run.failed` 释放锁),否则锁永久楔死该 app。(不再声称「崩溃恢复几乎免费」。)

**D5 — PARK 只一种切点:`propose(登记)→ run 结束评估 → approve → execute`。** `propose` **非阻断登记**、不抛错、不中断 `run()`;`run()` 正常返回后 executor **check-after-return** 评估一次:有 pending → 收束 `waiting_human`,无 → `run.completed`。这样一次 run 可 `propose` 多个高危动作(inbox 一次发 N 封的前提;若每次 propose 就退出则第一封后全丢)。**app 作者契约:propose 即 run 终点**——审批后 gateway 只执行那批动作、不重入 `run()`,别在 propose 后放「审批后才该跑」的域逻辑。不是通用中途 checkpoint(那是 Temporal 的活)。

**D6 — `Executor` 接口,`PipelineExecutor` 为唯一实现。** `Executor.run(ctx)`;pipeline 加载 `apps/<id>/pipeline.ts`。接口 = 未来接任何 harness 的插孔。未实现的 executor 值 → run 报 `executor_unsupported`,禁止静默成功。

**D7 — tool gateway 泛化 inbox 的 `executeActions` 内存重试 + `redactError`。** 保留其**内存有界**重试 + 脱敏形状,剥掉一切域概念(#1);治理(approval 检查)活在这里。**inbox 的 `retryQueue`(DB 持久化、跨重启、dead_letter)不搬**——那是通用 durable execution,破 #3/#8(D5 自己都点名 Temporal)。「直接搬~700 行」的说法作废:可复用的仅内存重试~百行 + redactError 35 行。

**D8 — 事件分类法(v0 固定一小组):** `run.started` · `approval.requested` · `approval.granted` · `action.executed` · `action.failed` · `run.completed` · `run.failed` · `run.cancelled`。payload 以不透明 JSON 携带域细节(域可见性走这里,不走表)。`seq` per-run 自增。

**D9 — run 锁不加第五张表:** 用 `Run` 的活跃状态 + 部分唯一索引(`app_id WHERE state 未终态`)保证同 app 单活跃 run;重复触发 → `already_running`。守不变量 #3。

**D10 — CLI 最小依赖:** 自行解析 argv 或用极轻的解析器;写命令用 `process.getuid?.() === 0` 拒绝 root。日志 pino → stderr,数据 → stdout。

**D11 — tool handler 接缝(对称于 Executor):** 动作的实际执行体是 app 的 `apps/<id>/tools.ts` 按名 handler 注册表 `{ [tool]: (args,ctx)=>Promise }`,gateway 按名加载、独立于 `run()`。没有它「gateway 执行动作」是未定义操作;审批后的域回写(inbox「已发送」写回域库)只能住 handler。备选:执行体藏在 `run()` 闭包里(否 —— approve 可能在重启后的另一进程跑,拿不到闭包)。heartbeat 落一个可观测 handler,让 DoD 真证明 execute 发生而非 no-op false-green。

**D12 — 连贯锁模型(一把锁收敛并发/崩溃):** approve/reject 先守 `state==waiting_human` 再**取 run 锁**(→executing);所有终态经**单一 choke-point**同事务释放锁 + 作废 Approval;reaper 按 PID+启动时刻回收死锁持有者(含崩在第二阶段的 approve)。这一套用**同一把 run 锁 + 同一个 reaper**收敛了「并发 approve、granting 崩溃、seq 竞争」,而非各加 lease/仲裁——省代码且正确。多进程活 race 的完整仲裁延后 Phase 1(见非目标)。

## 风险 / 权衡

- **[SQLite 单写者并发]** → DELETE 日志(见 D3,非 WAL)+ `busy_timeout` + run 锁行 + 事务化 check-and-insert;solo 场景写并发极低,足够(WAL 读写并发是多进程收益,延后 Phase 1)。
- **[`Run.state` 冗余列与事件不一致]** → state 永远可由 `classify(events)` 重算,冗余列只在同事务更新且以事件为准;不一致即视为 bug 由重算纠正。
- **[PARK 只一种切点]** → 某 app 想在循环中途等审批时不支持;v0 明确不做(DESIGN 已定),pilot #2 若真需要再谈,`Executor` 接口不改。
- **[`better-sqlite3` 是净新原生依赖]** → inbox 用 prisma+postgres、并无它;需验证目标平台预编译/node-gyp(不是「已在用、风险已知」)。
- **[parked run 静默停排期]** → daemon 遇活跃 run 跳过触发时必须落信号,`status`/`doctor` 报 app 被阻塞;否则忘了 approve 一次,app 就悄悄停跑,谋杀「每天用」判据。
- **[出口闸只验快乐路径]** → DoD(§8.2)必须额外固化并发 approve 幂等、崩溃重启 reaper 回收、`action.failed`→态 三条断言,否则「Phase 0 通过」会被误读为「脊柱可信」。

## 迁移计划

Greenfield,无数据迁移。仅初始化:建库 schema(四表 + 索引)、pnpm workspace、`apps/heartbeat/`。回滚 = 删 `hangar.sqlite` + 撤 commit。
