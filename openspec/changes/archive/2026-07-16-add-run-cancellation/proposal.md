## Why

Hangar 当前的 `RunContext` 没有 `AbortSignal`,daemon 没有 active-run controller registry,`main()` 阻塞在一个永不 resolve 的 promise 上——**收到 SIGINT/SIGTERM 就是硬杀进程,无优雅取消**。而 pipeline 一旦抛错**一律**经 choke-point 记 `run.failed`(executor.ts);`run.cancelled` 终态虽已存在(events.ts),却**只有 `gateway.reject` 一条路**(parked→cancelled)能写到它。对会 spawn 长生命周期子进程的 trusted pipeline(auto-developer),这意味着 cancel/shutdown 无法传播到 `run()`,且被杀时的取消会被**误记为 failed**——auto-developer 无法据此把生产 scheduler owner 从 launchd 切到 hangar。

## What Changes

- **每个 active run 持一个 `AbortController`**;`RunContext` 暴露只读 `signal: AbortSignal`(Node 原生,不自造)。老 pipeline 忽略 `signal` 仍照跑(向后兼容)。
- **取消经唯一 choke-point 记 `run.cancelled`**:`runApp` 的 catch 里按 `ctx.signal.aborted` 分流——aborted → `chokePoint(run.cancelled)`,否则 → `run.failed`。**取消路径写 cancelled 后,不得再写 failed/completed**(靠 chokePoint 既有幂等:首个终态胜)。
- **active-run 取消路径 = 进程内**(守 #6:无 IPC——独立 `hangar cancel` CLI 进程够不到活在 daemon 内存里的 `AbortController`;**不引入 IPC、不引入 DB 轮询取消标志**)。daemon 内维护 `Map<runId, abort>`;收 **SIGINT/SIGTERM** → abort 全部 active run → **宽限期(grace)**内等 pipeline cleanup → 退出。宽限内未收束的 run 留非终态,由**重启期 reaper** 回收成 failed(= cleanup-timeout 路径,复用既有机制)。手动 `hangar run` 装一个 SIGINT handler abort 它自己那一个 run。
- **CLI 对 cancelled 返回非零**:`hangar run` 的 run 被中断(SIGINT/abort)→ `state=cancelled` → 退出码非零,并输出可追踪的 `run id/state`(复用现有 `${runId} -> ${state}` 形状)。(注:`hangar reject` 产出的 cancelled 是**用户主动驳回**、语义上是成功操作,退出码仍 `0`,不在本变更改动。)
- **引入 host 能力集机制(#16 拆分后归本变更)**:版本化能力集(`hangar.run.<name>/vN`)+ `assertCapabilities` 关门原语 + 广播;成员 = `hangar.run.trigger-kind/v1`(attests #16 加的 `ctx.triggerKind` 字段)+ 本变更加的 `hangar.run.abort-signal/v1`、`hangar.run.cancelled-terminal/v1`、`hangar.run.runtime-capabilities/v1`。能力集有两个互补出口:
  - **部署期门禁**:`doctor --json` 广播真机 host 提供的能力;外部 adapter 自带 `required` 集并在部署前精确比对,缺失/unknown-newer → 在任何业务副作用之前 fail closed。`assertCapabilities(required, have)` 的 `have` 必填、无 module-local 常量默认值,避免校验调用方 bundle 的常量而假绿。
  - **运行期新鲜性证明**:每个 `RunContext` 暴露只读 `capabilities` 快照,由 host 在创建 run 时从同一 `HOST_CAPABILITIES` 复制并冻结;app input/config/request 不能替换或伪造。adapter 在 `run(ctx)` 入口、自己的业务副作用前用该快照再次关门。**不给 app.yaml 加 `requires_capabilities` 字段**:required 仍由 adapter 自带。

## Capabilities

### New Capabilities

- `host-capabilities`: 版本化 host 能力集机制(`hangar.run.<name>/vN`)+ `assertCapabilities` fail-closed 原语 + `doctor --json` 真机广播 + `ctx.capabilities` 运行期冻结快照。**#16 拆分后本变更引入它**;成员 = trigger-kind/v1 + abort-signal/v1 + cancelled-terminal/v1 + runtime-capabilities/v1。部署与运行时都从同一 `HOST_CAPABILITIES` 派生,required 集仍由 adapter 自带。

### Modified Capabilities

- `run-engine`: **修改**「PipelineExecutor 执行 app 的 run」(`ctx` 增只读 `signal`;抛错场景按 `signal.aborted` 分流 cancelled vs failed);**新增**「active run 持 AbortController、取消经 choke-point 记 cancelled 且终态幂等」需求。
- `cli`: **修改**「CLI 遵循 I/O 与退出码约定」(`hangar run` 的 cancelled → 非零);**新增**「daemon 收 SIGINT/SIGTERM 取消 active run 并宽限等待清理;手动 run 装 SIGINT 取消自身」需求。

## Impact

- **代码**:`packages/core/src/executor.ts`(`RunContext.signal`/`RunContext.capabilities`、每 run 建 `AbortController`、注入新鲜冻结能力快照、catch 分流、`runApp` 增 `onActive(runId, abort)` seam)、`cli.ts`(daemon `Map<runId, abort>` + 可 await 的 `shutdownDaemon(grace)` 接缝 + `shuttingDown` 标志门住 `fire()` + `process.on('SIGINT'/'SIGTERM')`;`cmdRun` 装 `process.once('SIGINT')` + cancelled→退出码 1;`doctor` 广播 `capabilities[]`)、**新增** `packages/core/src/capabilities.ts`(`HOST_CAPABILITIES` 四成员静态常量 + `createRuntimeCapabilities()` + `assertCapabilities(required, have)`,**无 module-local 默认 `have`**)、`reaper`/`chokePoint` **不改**(取消复用其幂等与回收)。
- **数据/DB**:零——不加表、不加列(#3)。取消是运行时事件流,`run.cancelled` 事件已在闭集内。
- **契约文档**:`DESIGN.md` §3.4(取消/宽限/reaper-fallback)、§3.5(`ctx.signal` + `ctx.capabilities`)、`SKILL.md`(四项能力、运行期快照、daemon 停机语义 + cancelled 退出码)。
- **依赖**:本变更**依赖 add-run-trigger-kind(#16)先落地**——#16 加 `ctx.triggerKind` **字段**,本变更引入的 `hangar.run.trigger-kind/v1` 能力 attests 该字段。注:**能力集机制归本变更**(#16 拆分后不再建机制),故 #18 的 `hard-crash-containment/v1` 能力闸依赖源亦为本变更。
- **不变量**:未破 #1(取消是 OS 生命周期、零域名词)/#3(不加表)/#6(取消进程内、无 IPC)/#8(cancelled 走单一 choke-point);#9(改 DESIGN.md,列为任务)。

## 非目标

- **不处理 SIGKILL / daemon 硬崩溃 / 主机掉电后的 OS 孤儿(孙)进程**——那要 worker containment / durable reaper,是 **design-hard-crash-containment(#18)** 的范围;本变更的取消只在进程仍活、能跑 cleanup 时有效(issue #17 原文非目标)。
- **不做跨进程 cancel 命令**(如 `hangar cancel <run>` 去停一个 daemon 拥有的活跃 run)——被 #6 挡死(无 IPC),且与 `hangar approve` 只能作用于 parked run 同一堵墙。真需要时另立赌注。
- **不做 durable cancel 队列 / 中途 checkpoint**(#8)。
- **不改 `hangar reject` 的退出码**(driven cancelled 是成功驳回,仍 `0`)。
