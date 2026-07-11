## 修改需求

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

## 新增需求

### 需求:doctor 上报 enabled;手动 run/approve 不受影响
`doctor --json` 的 `checks.apps[]` 每项 MUST 增报 `enabled`(布尔;`app.yaml` 未写→`true`;**注册失败的 app 无解析 spec → 省略该键**,消费方缺字段视作 `true`);`DoctorReport` 接口类型须同步加此字段。注意 `enabled` 落在 `checks.apps[]` 项上,**与既有的 `checks.blocked`(app id 列表)是两处**——disabled app 表现为 `checks.apps[]` 项带 `enabled:false` 且 **不出现在 `checks.blocked` 里**。

**手动 `hangar run <app>` 与 `hangar approve/reject` MUST 不受 `enabled` 影响** —— disabled 只关**自动调度与呈现**,operator 仍可手动触发 + 审批(守 DoD §8.1 在 `enabled:false` 下仍跑通 run→approve→marker)。`enabled` 过滤 MUST 只作用于**调度馈入与 blocked 派生**,MUST NOT 从 `loadApps()` 摘除 disabled app(否则 run/approve/doctor 一并失其踪)。

#### 场景:doctor 上报 enabled
- **当** 执行 `hangar doctor --json`
- **那么** `checks.apps[]` 每项含 `enabled` 布尔(未写该字段的 app 报 `true`;注册失败的 app 可省略该键);disabled app 不出现在 `checks.blocked`

#### 场景:手动 run/approve 不受 enabled 影响
- **当** 对 `enabled: false` 的 app 执行 `hangar run <app>` 再 `hangar approve <run>`
- **那么** 照常触发并执行动作(disabled 不挡手动调用与审批)
