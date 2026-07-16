## 1. 前置依赖 + 建能力集机制(#16 拆分后归本变更)

- [x] 1.1 确认 add-run-trigger-kind(#16)已落地:`ctx.triggerKind` **字段**存在(本变更的 `trigger-kind/v1` 能力 attests 它)。注:#16 拆分后**不建能力集机制**,机制由本变更创建
- [x] 1.2 **新增 `packages/core/src/capabilities.ts`**:`HOST_CAPABILITIES: readonly string[]` = 四成员(`hangar.run.trigger-kind/v1`、`hangar.run.abort-signal/v1`、`hangar.run.cancelled-terminal/v1`、`hangar.run.runtime-capabilities/v1`)+ `createRuntimeCapabilities()`(每次复制并冻结)+ `assertCapabilities(required: readonly string[], have: readonly string[]): void`——精确 `name/vN` 判 `required ⊆ have`,缺任一即 throw。**`have` 必填、无 module-local 默认值**
- [x] 1.3 self-check(`capabilities.test.ts`):齐备 / 缺失 / unknown-newer 三态;canonical set 与每次快照冻结;连续快照引用不同;修改尝试不影响 canonical/doctor;并由签名强制 `assertCapabilities` 必传 `have`

## 2. executor:AbortController + ctx.signal + catch 分流

- [x] 2.1 `packages/core/src/executor.ts`:`RunContext` 增只读 `signal: AbortSignal` 与 `capabilities: readonly string[]`;executor 每 run 注入 `createRuntimeCapabilities()` 的新鲜冻结快照。能力字段完全由 host 构造,input/config/request/trigger 不得替换;老 pipeline 忽略新增字段仍可运行
- [x] 2.2 `runApp`:每 run 建一个 `AbortController`,把 `controller.signal` 接进 `ctx.signal`
- [x] 2.3 `runApp` 增 seam `opts.onActive?(runId, abort: () => void)`,在 `createRun` 之后、`executor.run` 之前**同步调用**(runId 已知)。**关键:onActive 与 createRun 之间 MUST 无 `await`**(评审 nit)——否则一个刚过 `fire()` 门的 run 还没进 Map,abort-全部 扫描就可能漏掉它(cron-during-grace 的 no-escape 保证正靠这段同步窗口)
- [x] 2.4 `runApp` catch:`chokePoint(ctx.signal.aborted ? run.cancelled : run.failed)`(约 3 行),复用既有 choke-point,不新增终态转换点(守 #8)。**aborted 分支的 `run.cancelled` payload 保留错误文本**(若 catch 到的是真 throw;**与 failed 分支同处理**——写原始 message、不新增 `redactError` 依赖)——停机窗口内一次无关真故障不被静默记成干净取消(评审 nit)
- [x] 2.5 `runApp` 在调用 `gateway.evaluateAfterRun` 前检查 `ctx.signal.aborted`:已 aborted → 直接 `chokePoint(run.cancelled)`,不进 evaluate(避免「aborted 后正常 return」被误记 completed)

## 3. cli:daemon 信号处理 + 手动 run SIGINT + cancelled 退出码

- [x] 3.1 `cli.ts` `startDaemon`:维护 `Map<runId, abort>`(为能 await 收束,可另存 run promise 或用 `map.size` 轮询);`runOne` 传入 `onActive` 登记、settle 的 `finally` 里删除。**abort-全部 + 等收束的主体提取成一个可 await 的 `shutdownDaemon(grace): Promise<void>`,与 `process.exit` 解耦**;**`startDaemon` 返回 `{ shutdown, fire }`,三者(`Map`、`fire`、`shuttingDown`)共享同一份闭包态**——这样测试能经真 `fire`/真 `onActive` 驱动真 `Map`,而非手搭一个 stub Map(否则重蹈 #16 「断言注入 stub = vacuous」)。信号 handler 是薄封装 `shutdownDaemon().finally(() => process.exit())`
- [x] 3.2 **`shuttingDown` 标志住 `shutdownDaemon` 内、由它 set+guard(不是只在 handler 外层)**:`shutdownDaemon` 首行 `if (shuttingDown) return; shuttingDown = true;`——这样①二次信号(SIGINT 后 SIGTERM)直接 early-return、**幂等**(不叠加宽限计时/不双 exit),且**可被测试直接连调两次证明**;②同一 `shuttingDown` **门住 `fire()`**(`makeFireGate` 内 `fire` 开头 `if (shuttingDown) return`):停机窗口内 cron/pending/drain fire 全跳过,否则宽限内一个 tick `createRun` 出的新 run 逃过 abort-全部 扫描、留非终态(评审 F1 cron-during-grace)。然后 abort 全部 → 宽限 `HANGAR_SHUTDOWN_GRACE_MS`(默认 ~5s)内**等 run 真收束**(轮询 `map.size===0` 到截止,或 `Promise.race([allSettled, graceTimeout])`——**非盲 sleep**);未收束的 run 留非终态(交下次启动 reaper);可选 `task.stop()`/`.destroy()` 停 cron
- [x] 3.3 `cmdRun`:传 `onActive` 装 `process.once('SIGINT', abort)`(**`once` 非 `on`**——留第二次 Ctrl-C 回落默认强杀的逃生阀),**并在 run settle 的 `finally` 里 `process.removeListener('SIGINT', abort)`**(避免 in-process 反复驱动 runApp 时——如测试——监听器泄漏);**立即 abort + 短等**(不套 daemon 完整宽限);终态映射 `state==='cancelled' || state==='failed' → 退出码 `1``(cancelled 输出 `run id/state`);**不改 `cmdReject` 退出码**(driven cancelled 仍 0)
- [x] 3.4 `doctor` 广播 `capabilities[]` = `HOST_CAPABILITIES` 全四成员(`trigger-kind/v1` + `abort-signal/v1` + `cancelled-terminal/v1` + `runtime-capabilities/v1`);`DoctorReport` 类型加 `capabilities: readonly string[]`。doctor 与 `ctx.capabilities` 必须同源于 canonical set

## 4. 契约文档同步(#9)

- [x] 4.1 `DESIGN.md` §3.4:记 daemon SIGINT/SIGTERM abort + 宽限 + reaper-fallback(cleanup-timeout);§3.5:`ctx.signal` + `ctx.capabilities` 只读字段、部署/运行两道门与 side-effect-free import 边界
- [x] 4.2 `SKILL.md`:daemon 停机语义(优雅取消 vs 硬杀)+ `hangar run` cancelled 退出码 + 四条能力字符串 + runtime snapshot 消费约定

## 5. 测试(契约矩阵 + self-check)

- [x] 5.1 `run-engine.test.ts`:pre-aborted、mid-run cancel、重复 cancel、完成×cancel 竞态——每例断言**唯一终态事件 `run.cancelled` + `state=cancelled` + 锁释放 + pending Approval superseded**;aborted 后正常 return 也判 cancelled(非 completed)
- [x] 5.2 `run-engine.test.ts`:老 pipeline 忽略 `signal` 仍跑通至自然完成/失败(无回归)
- [x] 5.3 `cli.test.ts`:**直接 await `startDaemon` 返回的 `shutdown`(不 raise 真信号——真信号 + `process.exit` 会先杀测试进程)**,且 in-flight run 经**真 `runApp` + 真 `onActive` 登记进真 `Map`**(**不手搭 stub Map/fire**,否则重蹈 #16 vacuous)。用**协作** pipeline:abort-全部 → 宽限内收束 `run.cancelled`(断言唯一终态 + `Map` 释放);**忽略 signal 的 pipeline** 超宽限 → 留非终态。**cleanup-timeout 腿须显式伪造死 owner**:活测试进程的 `lock_owner` 是活的、直接 `reap()` 不会判死——须先把该 run 的 `lock_owner` 改写成一个死 `pid:startTime`(或 stub `processStartTime`)再 `reap()`,才断言得到 `run.failed` + `reason:'reaped'`(与 cancelled 区分)。**cron-during-grace / 二次信号**:置 `shuttingDown` 后经**真 `fire`** 触发一个 cron tick → 断言不产生新 run;连调 `shutdown` 两次 → 第二次 early-return(幂等)
- [x] 5.4 `cli.test.ts`:`hangar run` 被 SIGINT 取消 → 非零退出 + 输出 `run id/state`;`hangar reject` 的 cancelled 退出码仍 0
- [x] 5.5 能力集三态(`assertCapabilities`:缺失 / 齐备 / unknown-newer);断言 doctor 含全四成员且 = `HOST_CAPABILITIES`;断言每 run 快照新鲜/冻结/input-config-request 不可伪造/修改不污染 canonical 与 doctor。**「无 module-local 默认 `have`」由必填参数 + `tsc` 保证**
- [x] 5.6 self-check:单一终态**每路径只写一次**——mid-run cancel 后**不**再有 `run.completed`/`run.failed`(断言 trace 里 `run.cancelled` 后无后续终态事件、锁只释放一次)。注:chokePoint 幂等本身已在 `run-engine.test.ts` 既有用例直测,本条断言的是「取消路径单写者」而非再造幂等用例

## 6. 校验 + 部署

- [x] 6.1 `openspec-cn validate add-run-cancellation --strict` 通过;`pnpm --filter @hangar/core build` + 全测试绿
- [x] 6.2 部署钉测过的 hangar commit;auto-developer 的 adapter/doctor 校验能力集后再切换(本 Issue 前其生产 owner 仍可保持现状)
