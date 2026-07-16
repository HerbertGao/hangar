# cli 规范

## 目的
待定 - 由归档变更 phase-0-skeleton 创建。归档后请更新目的。
## 需求
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

### 需求:写操作拒绝 root
写命令(`run` / `approve` / `reject` / `daemon`)在 `EUID==0` 时必须拒绝执行;只读命令与 `doctor` 不拒绝。

#### 场景:root 运行写命令被拒
- **当** 以 `EUID==0` 执行 `hangar run <app>`
- **那么** 命令必须拒绝执行、以非 0 退出、且不写 SQLite

#### 场景:doctor 不拒绝 root
- **当** 以 `EUID==0` 执行 `hangar doctor`
- **那么** 命令必须正常运行

### 需求:doctor 显式化环境前置检查,且非破坏性
`doctor` 必须检查 node 版本、SQLite 可写、`apps/` 目录存在、各 app 的 spec 合法性与 `pipeline.ts` 存在性,并可 `--json` 输出。可写检查:**库文件已存在 → 对文件 `access(W_OK)`;不存在 → 对目录 `access(W_OK)`;两种情况都绝不创建 `hangar.sqlite`**。

#### 场景:环境全绿
- **当** 环境就绪
- **那么** `doctor --json` 必须返回 `ok:true` 且各 check 为 `ok`

#### 场景:doctor 不得创建状态库
- **当** `hangar.sqlite` 尚不存在时运行 `doctor`(哪怕以 root)
- **那么** doctor 必须只对目录做非破坏性检查、**不创建库文件**(否则 root 跑 doctor 会造 root-owned 库,之后非 root 的 run 永远写不进)

#### 场景:已存在 root-owned 库不给假绿
- **当** `hangar.sqlite` 已存在且为 root-owned、当前非 root 运行 doctor
- **那么** 可写检查必须对**文件**做 `access(W_OK)` 判定为不可写(而非只查目录得出假 `ok`)

#### 场景:不可写
- **当** 库文件(或目录)不可写
- **那么** 对应 check 必须非 `ok`,顶层 `ok` 必须为 `false`

### 需求:只读命令映射事件状态
`status` / `runs` / `trace` 必须为只读,并以 `RunEvent` 推导展示状态:`status` 显示各 app 最新 run 的 state;`runs [<app>]` 显示 run 历史(可按 app 过滤),`--limit N`(正整数,否则退出码 2)取最近 N 条(`started_at` DESC);`trace` 显示某 run 的完整事件时间线与待批动作。

#### 场景:等审批可见
- **当** 某 run 处于 `waiting_human`
- **那么** `status --json` 必须显示该 state,`trace <run>` 必须列出其 `pendingApprovals`

#### 场景:runs --limit 取最近 N 条
- **当** 库中有 M 条 run 且执行 `runs --limit N`(N<M)
- **那么** 必须只返回最近 N 条(`started_at` 倒序);`--limit` 非正整数则退出码 2(usage)

#### 场景:完整时间线
- **当** 某 run 已完成
- **那么** `trace <run>` 必须按 `seq` 顺序列出从 `run.started` 到 `run.completed` 的全部事件

#### 场景:不存在的 run
- **当** `trace` / `approve` / `reject` 一个不存在的 `run`
- **那么** 必须报 `run_not_found`、退出码 1

### 需求:daemon 按 triggers 调度,遇活跃 run 跳过;阻塞由 status/doctor 派生
`daemon` 必须为长驻进程,读取各 app 的 `triggers`(cron)并按时触发 run;它与 CLI 共享同一 SQLite,不通过 HTTP/IPC 互相通信。cron 到点时**该 app 无活跃 run 才触发**;被活跃/parked run 挡住时跳过(至多写 stderr 日志)。**`enabled: false` 的 app MUST NOT 被调度触发**——实现于 `daemonTasks` 馈入前 `filter(a => a.spec.enabled !== false)`。「app 被阻塞」**不持久化信号**(4 表闭事件集容不下、也破 #3),而由 `status`/`doctor` **从既有状态派生**:某 app 存在 `waiting_human` run 且其龄期已超过该 app 的 cron 周期 = 阻塞。**但 `enabled: false` 的 app MUST NOT 被派生为阻塞**(否则一个被禁用、却有旧 parked run 的 app——如 heartbeat 的历史 `demo.risky` park——会永报逾期)。**实现注意**:`deriveBlocked` **不读 `enabled`**,且 disabled app 的 `spec.triggers` **仍非空**(禁用不清空 triggers),故它**不会**因空周期自动返回 `false`;须在**两处 `deriveBlocked` 调用点**(doctor 循环、`cmdStatus`)对 disabled **显式**令 `blocked=false`(而非依赖任何「视同无触发器」的自动等价)。disabled app **MUST 仍列在** `status`/`doctor`(不 delist,守下「doctor 如实报」),仅不进 `doctor.checks.blocked`、其 `status` 行 `blocked=false`。

#### 场景:无活跃 run 且 enabled 时触发
- **当** `daemon` 运行、某 **enabled** app 的 cron 时刻到达且该 app 无活跃 run
- **那么** 必须为该 app 触发一个 run(等价于 `hangar run <app>`)

#### 场景:被 parked run 挡住 → 派生阻塞可见
- **当** cron 时刻到达但该 **enabled** app 有活跃 `waiting_human` run
- **那么** daemon 跳过触发;`status`/`doctor` 必须能**派生**报出「app 被过期 parked run 阻塞」(waiting_human + cron 逾期),使忘记 approve 不会悄悄停跑(守「每天用」判据),且不为此新增事件类型或第 5 张表

#### 场景:disabled app 不被调度、不派生阻塞、仍列出
- **当** 某 app `enabled: false`,其 cron 到点或它有旧 `waiting_human` run
- **那么** daemon MUST NOT 触发它;`status`/`doctor` MUST NOT 把它派生为阻塞(不进 `doctor.checks.blocked`,`status` 行 `blocked=false`);但该 app MUST 仍出现在 `status`/`doctor` 列表(不 delist)

### 需求:doctor 上报 enabled;手动 run/approve 不受影响
`doctor --json` 的 `checks.apps[]` 每项 MUST 增报 `enabled`(布尔;`app.yaml` 未写→`true`;**注册失败的 app 无解析 spec → 省略该键**,消费方缺字段视作 `true`);`DoctorReport` 接口类型须同步加此字段。注意 `enabled` 落在 `checks.apps[]` 项上,**与既有的 `checks.blocked`(app id 列表)是两处**——disabled app 表现为 `checks.apps[]` 项带 `enabled:false` 且 **不出现在 `checks.blocked` 里**。

**手动 `hangar run <app>` 与 `hangar approve/reject` MUST 不受 `enabled` 影响** —— disabled 只关**自动调度与呈现**,operator 仍可手动触发 + 审批(守 DoD §8.1 在 `enabled:false` 下仍跑通 run→approve→marker)。`enabled` 过滤 MUST 只作用于**调度馈入与 blocked 派生**,MUST NOT 从 `loadApps()` 摘除 disabled app(否则 run/approve/doctor 一并失其踪)。

#### 场景:doctor 上报 enabled
- **当** 执行 `hangar doctor --json`
- **那么** `checks.apps[]` 每项含 `enabled` 布尔(未写该字段的 app 报 `true`;注册失败的 app 可省略该键);disabled app 不出现在 `checks.blocked`

#### 场景:手动 run/approve 不受 enabled 影响
- **当** 对 `enabled: false` 的 app 执行 `hangar run <app>` 再 `hangar approve <run>`
- **那么** 照常触发并执行动作(disabled 不挡手动调用与审批)

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

