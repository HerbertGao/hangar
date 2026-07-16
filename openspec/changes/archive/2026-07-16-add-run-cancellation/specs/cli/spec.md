## 修改需求

### 需求:CLI 遵循 I/O 与退出码约定
所有命令必须:数据写 stdout、日志写 stderr、`--json` 给结构化输出;退出码 `0` 成功 / `1` 业务失败 / `2` 参数错误;无参运行必须打印帮助且不执行任何写操作。**`hangar run` 的 run 若被取消(SIGINT/abort)进入 `state=cancelled`,必须以退出码 `1` 退出**(取消是一种非成功终态,归 `1` 业务失败档;与 `failed` 同码、靠输出的 `state` 区分),并输出可追踪的 `run id/state`(复用 `${runId} -> ${state}` 形状 / `--json` 下 `{run,state}`)。(注:`hangar reject` 产出的 `cancelled` 是**用户主动驳回**、语义上成功操作,退出码仍 `0`,不变。)

#### 场景:--json 不混入日志
- **当** 命令带 `--json`
- **那么** stdout 必须是可解析的结构化 JSON,日志必须只走 stderr

#### 场景:参数非法
- **当** 命令参数非法或缺失
- **那么** 退出码必须为 `2`

#### 场景:无参打印帮助
- **当** 不带任何子命令运行 `hangar`
- **那么** 必须打印帮助,禁止执行任何写操作

#### 场景:run 被取消 → 非零退出且可追踪
- **当** `hangar run <app>` 的 run 被 SIGINT/abort 取消,终态为 `cancelled`
- **那么** 命令必须以**非零**退出,且 stdout 输出该 `run id` 与 `state=cancelled`(便于追踪);`hangar reject` 的 cancelled 退出码仍为 `0`

## 新增需求

### 需求:daemon 收 SIGINT/SIGTERM 取消 active run 并宽限等待清理;手动 run 装 SIGINT 取消自身
`daemon` 必须为每个 active run 登记其取消入口(进程内 `Map<runId, abort>`,run settle 时移除),不经 HTTP/IPC。

**停机路径须是一个可从信号 handler 触达、可 await 的接缝**(实现约束,评审):`Map` 与宽限逻辑住 `startDaemon` 闭包,而信号 handler 由 `main()` 装——二者须打通。故 `startDaemon` 必须**自己安装 `process.on('SIGINT'/'SIGTERM')`**,或返回一个 `{ shutdown }` 供 `main()` 调用;**abort-全部 + 等收束**的主体必须提取成一个**可 await 的函数**(与 `process.exit` 解耦),否则该契约既无法接线、其测试也只能断言注入的 stub(= vacuous;同 #16 review 逼出的 `daemonRunOne` 提取教训)。

收到 **SIGINT 或 SIGTERM** 时:必须置一个 **`shuttingDown` 标志**,该标志同时:①**门住 `fire()`**——停机窗口内新到的 cron/pending fire MUST 被跳过(否则宽限期内一个 cron tick 会 `createRun` 出一个在 abort-全部 扫描**之后**才诞生的 run,逃过取消、留非终态);②**使 handler 幂等**——首个信号独占那一次「宽限 + 退出」序列,SIGINT 后再来 SIGTERM MUST NOT 重入(不叠加宽限计时 / 不双 `process.exit`)。然后 abort **全部** active run,并在**宽限期(grace period)**内**等待其真正收束**(等待原语须明确:轮询 `Map.size===0` 到 `HANGAR_SHUTDOWN_GRACE_MS` 截止,或另存 run promise 后 `Promise.race([allSettled, graceTimeout])`——**不是盲 sleep**)后退出。

**宽限内未收束的 run 必须留在非终态、不得在此处强写终态**——由**下次 daemon 启动的 reaper**(按 `lock_owner` 死 PID 指纹)回收成 `failed`(= cleanup-timeout 路径,复用既有 reaper,不新增机制,不破 #3)。取消经既有单一 choke-point 记 `run.cancelled`(不新增终态转换点,守 #8)。取消路径全程**进程内**(守 #6:无 IPC)。

手动 `hangar run <app>` 必须装 `process.once('SIGINT', abort)`(**`once` 非 `on`**——保留「第二次 Ctrl-C 回落 Node 默认强杀」的逃生阀,因忽略 `signal` 的老 pipeline 首次 abort 无效)。手动路径**立即 abort + 短等**即可(单 run、交互式;不套用 daemon 的完整宽限);无强制超时,忽略 signal 的 run 会挂到自然完成或第二次 Ctrl-C。cancelled → **退出码 `1`**(业务失败档;与 failed 同码,靠 stdout 的 `run id/state` 区分)。

#### 场景:SIGINT 或 SIGTERM 优雅停机取消全部 active run
- **当** daemon 有若干 active run 时收到 SIGINT 或 SIGTERM
- **那么** 必须 abort 全部 active run;配合的 pipeline 在宽限期内收束为 `run.cancelled`(唯一终态、释放锁与 `inFlight`);daemon 等这些 run 真正收束(非盲 sleep)后退出

#### 场景:停机窗口内 cron 不再 fire、二次信号幂等
- **当** `shuttingDown` 已置(已收到首个信号),此时一个 cron tick 到点、或又收到第二个信号(SIGINT 后 SIGTERM)
- **那么** 新 fire MUST 被 `fire()` 跳过(不 `createRun` 出逃过取消的新 run);第二个信号 MUST NOT 重入宽限+退出序列(不叠加、不双 `process.exit`)

#### 场景:宽限超时的 run 交给重启 reaper(cleanup timeout)
- **当** 某 pipeline 在宽限期内**未**收束(忽略 signal 或 cleanup 过久),daemon 到点退出
- **那么** 该 run 留非终态;下次 daemon 启动的 reaper 必须按死 PID 指纹判它 `run.failed`、释放锁——**不得**在停机处强写终态、不得误记为 cancelled(即「aborted → 必记 cancelled」**只对协作且宽限内收束的 run 成立**,见 host-capabilities `cancelled-terminal/v1` 范围)

#### 场景:手动 run 被 SIGINT 取消
- **当** `hangar run <app>` 运行中用户按 Ctrl-C(SIGINT)
- **那么** 必须 abort 该 run → 配合的 pipeline 经 choke-point 记 `run.cancelled` → 命令以退出码 `1` 退出并输出 `run id/state`;第二次 Ctrl-C 回落默认强杀
