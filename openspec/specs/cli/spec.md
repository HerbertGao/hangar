# cli 规范

## 目的
待定 - 由归档变更 phase-0-skeleton 创建。归档后请更新目的。
## 需求

### 需求:CLI 遵循 I/O 与退出码约定
所有命令必须:数据写 stdout、日志写 stderr、`--json` 给结构化输出;退出码 `0` 成功 / `1` 业务失败 / `2` 参数错误;无参运行必须打印帮助且不执行任何写操作。

#### 场景:--json 不混入日志
- **当** 命令带 `--json`
- **那么** stdout 必须是可解析的结构化 JSON,日志必须只走 stderr

#### 场景:参数非法
- **当** 命令参数非法或缺失
- **那么** 退出码必须为 `2`

#### 场景:无参打印帮助
- **当** 不带任何子命令运行 `hangar`
- **那么** 必须打印帮助,禁止执行任何写操作

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
