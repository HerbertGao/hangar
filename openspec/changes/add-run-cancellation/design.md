## Context

- **现状(已核对):** `RunContext`(executor.ts:21)只有 `input/trigger/config/logger/emit/propose`,无 `signal`。`runApp` 的 catch(executor.ts:120)对**任何**抛错记 `run.failed`。`run.cancelled`/`cancelled` 态在 events.ts 已定义并被 `chokePoint` 支持,但**唯一写入方是 `gateway.reject`**(gateway.ts:275,parked→cancelled)。
- **daemon 停机:** `startDaemon` 只 wire cron;`main()`(cli.ts:804)`return await new Promise(() => {})` 永不 resolve。**没有任何 `process.on('SIGINT'/'SIGTERM')`**——Ctrl-C 直接杀进程,活跃 run 停非终态,靠下次写命令启动的 reaper 收成 failed。
- **choke-point 幂等:** `chokePoint`(store.ts:137)对已终态 run 是 no-op(`TERMINAL_STATES.includes(run.state) → return`)。这是本变更全部竞态安全的锚点:第一个到达终态的写入胜,后续任何终态写入是 no-op。
- **消费者:** inbox 无高危动作、不需要中途取消。真实消费者是 auto-developer——一个 spawn detached process group 的 trusted pilot,要求 shutdown 能优雅传播、且取消不被误记为 failed。

## Goals / Non-Goals

**Goals:**
- 给 `run()` 一个可观测的取消信号(`ctx.signal`),让自愿配合的 pipeline 能优雅收尾。
- 取消经**唯一 choke-point** 记 `run.cancelled`,与自然完成/失败在终态上**互斥且幂等**。
- daemon 优雅停机:SIGINT/SIGTERM abort 全部 active run,宽限等待 cleanup。
- 缺失取消能力时 doctor/adapter **fail closed**(auto-developer 切换前置闸)。

**Non-Goals:**
- SIGKILL / 硬崩溃 / OS 孤儿孙进程回收(→ #18)。
- 跨进程 cancel 命令(→ 被 #6 挡,另立赌注)。
- durable cancel 队列 / 中途 checkpoint(#8)。
- 改 `hangar reject` 的退出码语义。

## Decisions

### D1 — 取消是**进程内**信号驱动,不做跨进程 cancel
一个独立 `hangar cancel <run>` CLI 进程和 daemon **只共享 SQLite**(#6:无 HTTP/IPC/MQ),够不到活在 daemon 内存里的 `AbortController`。这与 `hangar approve` 只能作用于 **parked**(无活进程持有)run 是**同一堵墙**:活跃 run 归 daemon 进程私有。故本变更的「取消路径」= 进程内:daemon 收信号 abort 自己的活跃 run;手动 `hangar run` 收 SIGINT abort 自己那一个。**不引入 IPC,也不引入「DB 里写 cancel 标志、daemon 轮询」**——后者是新机制,要先改 DESIGN(#9)且违背 #6 精神,YAGNI。

*备选:* DB 轮询 cancel 标志(跨进程可行)——否决:新机制、破 #6 精神、无真实需求(auto-developer 要的是 shutdown 传播,不是外部点名取消某个活跃 run)。

### D2 — abort→cancelled 经**既有单一 choke-point** 映射
`runApp` 的 catch 改为:`if (ctx.signal.aborted) chokePoint(run.cancelled) else chokePoint(run.failed)`(约 3 行)。**不新增终态转换点**(守 #8)。取消要么让 pipeline 抛出(被 catch 捕获)、要么 pipeline 正常 return(此时 evaluateAfterRun 会记 completed——但若已 aborted,应先于 evaluate 判 cancelled;见 D3)。

### D3 — 竞态矩阵靠 chokePoint 幂等收敛
所有终态竞态(pre-aborted / mid-run / SIGINT / SIGTERM / 重复 cancel / 完成×cancel)都归结为「谁先到 choke-point」。因 chokePoint 对已终态 run no-op,**首个终态胜、锁只释放一次**:
- **pre-aborted**(run 开始前 signal 已 aborted):pipeline 观察到 `signal.aborted` 立即抛出/返回 → catch 判 cancelled。
- **完成×cancel**:pipeline 已正常 return 并即将 `evaluateAfterRun→run.completed`,同时 abort 到达——**以先写入 choke-point 者为准**;若 completed 先落,后续 abort 的 cancelled 写入是 no-op(run 已 completed),这是可接受的良性竞态(run 确实完成了)。反之若 aborted 抛错先落 cancelled,completed 不再发生。为让「aborted 后正常 return」也判 cancelled 而非 completed,`runApp` 在调用 `evaluateAfterRun` 前**检查 `signal.aborted`**:已 aborted 则直接 `chokePoint(run.cancelled)`,不进 evaluate。
- **重复 cancel / SIGINT 后再 SIGTERM**:第二次 abort 对同一 controller 无副作用;第二次终态写入 no-op。

### D4 — daemon registry + 宽限 + reaper-fallback
`runApp` 增一个 seam:`opts.onActive?(runId, abort: () => void)`,在 `createRun` 之后、`executor.run` 之前调用(此刻 runId 已知)。daemon 的 `onActive` 把 `abort` 存进 `Map<runId, abort>`,并在 run settle 的 `finally` 里删除。

**停机接缝须可接线、可 await、可单测(评审 F1/F2):** `Map` 与宽限逻辑住 `startDaemon` 闭包,信号 handler 却在 `main()`——若不打通,「abort 全部」无法接线、其测试也只能断言注入 stub(vacuous,同 #16 逼出的 `daemonRunOne` 提取)。故:① `startDaemon` **自己**装 `process.on('SIGINT'/'SIGTERM')`(它持 Map/grace),或返回 `{ shutdown }`;② abort-全部 + 等收束的主体提取成一个**可 await 的 `shutdownDaemon(grace)`**、与 `process.exit` 解耦(测试直接 await 它)。

**`shuttingDown` 标志(评审 F1:cron-during-grace + 二次信号):** 首个信号置位,它同时——① **门住 `fire()`**(`fire` 开头 `if (shuttingDown) return`),否则宽限窗口内一个 cron tick `createRun` 出的新 run 在 abort-全部 扫描**之后**才诞生、逃过取消、留非终态;② **handler 幂等**,首信号独占那一次「宽限+exit」,SIGINT 后再 SIGTERM 不重入。

**等收束不是盲 sleep(评审 F5):** `Map` 存 `abort` 函数、非 promise,故「等 pipeline 收束」的原语须明确——轮询 `map.size===0` 到 `HANGAR_SHUTDOWN_GRACE_MS` 截止,或另存 run promise 后 `Promise.race([allSettled, graceTimeout])`。**宽限内未收束的 run 留非终态**——不强杀、不在此处补写终态;下次 daemon 启动的 reaper 按 `lock_owner`(死 PID)判它 failed(= cleanup-timeout 语义,复用既有 reaper,零新机制)。手动 `hangar run` 的 `onActive` 装 `process.once('SIGINT', abort)`(`once` 保留第二次 Ctrl-C 回落默认强杀;忽略 signal 的老 pipeline 首次 abort 无效),立即 abort + 短等、不套完整宽限。

### D5 — 老 pipeline 忽略 signal 仍可跑
`ctx.signal` 是 host 恒提供的鸭子契约新增**必填**字段;pipeline 是否读取/监听它可选。pipeline 不读它 → 取消退化为「abort 后等宽限、超时 reaper 收 failed」(与现状 Ctrl-C 一致,无回归)。要求真·取消传播的 app(auto-developer)靠能力集在部署前置检查里 fail-closed(见 D6)。

### D6 — 同一 canonical set 提供部署期广播与运行期快照(#16/#19)
`add-run-trigger-kind`(#16)只增加 `triggerKind`/`triggerName` 字段;能力集机制归本变更。四个成员分别证明 `trigger-kind/v1`、`abort-signal/v1`、`cancelled-terminal/v1` 与 `runtime-capabilities/v1`。`HOST_CAPABILITIES` 是唯一 canonical set,doctor 输出与每次 run 的快照都必须从它派生,避免两条路径漂移。

- **部署期真机门禁**:`doctor --json` 的 `capabilities[]` 来自运行中的 host 二进制。`assertCapabilities(required, have)` 的 `have` 必填、无 module-local 常量默认值;否则外部 adapter 自带较新 `@hangar/core` 时会校验自己 bundle 而非真机 host,产生假绿。auto-developer 部署脚本跨进程读 doctor JSON,在部署/启动前精确比对 adapter 自带的 required 集。
- **运行期新鲜性证明(#19)**:`RunContext` 增只读 `capabilities: readonly string[]`;executor 为每个 run 调 `createRuntimeCapabilities()`,从 canonical set 复制并 `Object.freeze`。快照不是 caller 提交字段,`input`/`config`/`RunRequest`/trigger 都不能替换它;每个 run 拿到新数组,对某个快照的修改尝试既不能改变 canonical set,也不能改变后续 run 或 doctor 输出。adapter 在 `run(ctx)` 入口、自己的业务副作用前按精确字符串校验该快照。
- **required 归 adapter**:不给 `app.yaml` 加 `requires_capabilities`;doctor 只广播 offered 集,脊柱也不替 app 存 required 集。unknown-newer 不自动兼容旧版,例如仅有 `/v2` 仍不满足 `/v1`。
- **诚实边界**:`PipelineExecutor` 在调用 `run(ctx)` 前已经 import pilot 模块,因此运行期断言保护的是 adapter 的 **run 内业务副作用**,不能追回模块顶层副作用。pipeline 模块必须遵守 DESIGN §6 的 side-effect-free import 纪律;部署期 doctor 门禁仍负责在旧 host 上阻止部署。两道门互补,都不能被描述成单独覆盖所有副作用。

## Risks / Trade-offs

- **[忽略 signal 的挂死 pipeline 无法被优雅取消]** → 它会占住 run 到宽限超时,再由 reaper 收成 failed(非 cancelled)。这与现有 `inFlight` liveness 假设同一 wedge(DESIGN §3.4:`run()` 须自限时);本变更不新引入,也不承诺解决 → 属 #18 硬 containment 范围。
- **[完成×cancel 的良性竞态可能把「其实完成了」记成 cancelled,或反之]** → 由 D3 的 evaluate-前 `signal.aborted` 检查 + chokePoint 幂等收敛为「首个终态胜」;两种结果都终态一致、锁只释放一次,审计 trace 可回溯,可接受。
- **[宽限期取值]** → 太短会把还在 cleanup 的 run 误留给 reaper 判 failed;太长拖慢停机。默认 ~5s + env 覆盖(校准旋钮),trusted pilot 按其 cleanup 时长调。

## Migration Plan

1. 先落地 add-run-trigger-kind(#16)——它加 `ctx.triggerKind` 字段(本变更的 `trigger-kind/v1` 能力 attests 它)。**能力集机制本身归本变更**(拆分后 #16 不建机制)。
2. 实现 executor(signal + 每 run 冻结能力快照)/cli(停机接缝 + shuttingDown)/能力集机制(capabilities.ts + doctor 广播 + `ctx.capabilities`)+ 契约文档(见 tasks.md),`openspec-cn validate --strict` + 全测试绿。
3. 部署仍**钉在测过的 hangar commit/version**;auto-developer 的 adapter/doctor 校验能力集后才切换。
4. 回滚:取消是纯增量(host 新增必填 context 字段,老 pipeline 可忽略 + 新信号处理),移除信号 handler 即回到现状硬杀;无数据迁移。

## Open Questions

- 宽限期默认值(5s?)与是否需要 per-app 覆盖——建议先单一 env(`HANGAR_SHUTDOWN_GRACE_MS`),per-app 等真有 pilot 需要再加。
- `hangar run`(手动)被 SIGINT 取消时,是否也要宽限等待 cleanup,还是立即 cancelled 退出?建议立即 abort + 短等(单 run、交互式,用户按了 Ctrl-C 就想尽快退)。
