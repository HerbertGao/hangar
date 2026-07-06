# tool-gateway 规范

## 目的
待定 - 由归档变更 phase-0-skeleton 创建。归档后请更新目的。
## 需求
### 需求:app 必须提供按名索引的工具处理器(tool handler)
「按名字执行一个动作」需要一个 app 提供、可**独立于 `run()` 加载**的处理器注册表(对称于 `Executor`)。app 必须导出 `apps/<id>/tools.ts`:`{ [tool]: (args, ctx) => Promise<Result> }`;gateway 按 `tool` 名加载调用。**没有它,「gateway 执行动作」是未定义操作**(approve 后进程可能重启,执行体只能按 `{tool,args}` 重解析,不能靠 `run()` 闭包)。审批后的域回写(如 inbox 把「已发送」写回自己域库)只能住在 handler 里。

#### 场景:approve 时真的跑了 app 代码
- **当** heartbeat 的假高危动作被 `approve`
- **那么** gateway 必须调用 `apps/heartbeat/tools.ts` 对应 handler,该 handler 必须产生**可观测副作用**(写 marker / 计数),DoD 必须断言它发生(而非仅 core 自己 emit 了 `action.executed`)

### 需求:动作经单一异步 propose 入口分派
app 通过 `await ctx.propose({ tool, args })` 提交动作(无直执行旁路)。`propose` 是 **async**:低危(不在 `permissions.approval`)→ gateway 调 handler 执行、`emit action.executed`、resolve 结果(`run()` 可 await 取结果);高危 → 写 `Approval(pending)`、**不执行、不抛错、不中断 run()**、resolve void。app 与 executor 禁止自行处理审批。

#### 场景:低危立即执行并可 await
- **当** `await propose` 一个低危动作
- **那么** gateway 必须调其 handler、`emit action.executed`、把结果 resolve 回 `run()`

#### 场景:高危只登记不执行
- **当** `propose` 一个高危动作
- **那么** gateway 必须写 `Approval(pending)`、不执行、不中断 `run()`、resolve void

### 需求:PARK 在 run 结束后统一评估一次(check-after-return)
系统必须在 `run()` 正常返回后**评估一次**:有 pending Approval → 逐个 `emit approval.requested`、收束 `waiting_human`;无 → 经 choke-point `emit run.completed`。禁止每次 propose 就收束。

#### 场景:一次 run 多个高危 propose
- **当** run 里 `propose` 了 N(≥2)个高危动作后 `run()` 正常返回
- **那么** 必须登记全部 N 个 `Approval(pending)`、逐个 `approval.requested`、收束一次 `waiting_human`

### 需求:重试为内存有界、不引入 durable 队列;错误脱敏
动作执行以内存有界重试(泛化 `executeActions` 的 `MAX_ATTEMPTS`)处理瞬时失败,禁止持久化/跨重启重试队列(durable execution,破 #3/#8)。写入事件/日志的错误先脱敏(泛化 `redactError`,剥域正则)。

#### 场景:重试后成功 / 耗尽
- **当** 动作内存重试后成功;或耗尽仍失败
- **那么** 分别 `emit action.executed`;或 `emit action.failed`(错误已脱敏)且不落任何持久队列

### 需求:approve/reject 必须先守 run 状态、再取 run 锁,幂等透传
`approve`/`reject` 只对 `state==waiting_human` 的 run 有效;否则报 `not_waiting`、不执行——**防止对 failed/completed/running 的 run 误执行被作废的 pending 动作(审批闸破洞、破 #5)或非法覆盖终态**。approve/reject 必须**取得该 run 锁**(`waiting_human → executing`,`lock_owner=自身 PID+启动时刻`),使第二阶段单写者串行、且崩溃后可被 reaper 回收。高危动作把 `Approval.id`(或其派生)作为**幂等键透传给 handler**;gateway 只保证「至多认领一次」(CAS),对外部副作用的「至多执行一次」取决于 handler / 外部系统认不认该键。

#### 场景:非 waiting_human 拒绝审批
- **当** `approve`/`reject` 一个 `running`/`executing`/`failed`/`completed`/`cancelled` 的 run
- **那么** 必须报 `not_waiting`、不执行任何动作、不改其终态

#### 场景:批准后执行
- **当** approve 取锁成功(唯一进入 `executing` 者)
- **那么** 逐个 pending Approval → 调 handler(带幂等键)→ `emit action.executed` + 置 `granted`;全部完成 → 经 choke-point `emit run.completed`

#### 场景:审批进程崩溃可恢复
- **当** approve 取锁进 `executing` 后、完成前进程被杀
- **那么** run 停 `executing` 且锁 `lock_owner` 为死进程 → 下次写命令的 reaper 按 PID+启动时刻回收(判 `run.failed` 并作废其 Approval);幂等键保证已执行的外部动作不被重复执行

#### 场景:approve 无 pending
- **当** `approve` 一个 `waiting_human` 但无 pending Approval 的 run
- **那么** 报 `no_pending_approval`,不重复 `emit run.completed`

### 需求:approve 第二阶段部分失败有明确终态
批量 approve 中途某动作重试耗尽失败时,该 run 必须经 choke-point 收束到 `run.failed`(已 `granted` 的不回滚、记录已执行;其余 pending 置 `superseded`)。

#### 场景:部分失败
- **当** 一批已认领动作中某个重试耗尽失败
- **那么** `emit action.failed`、该 run 经 choke-point 进 `run.failed`;已 granted 保留、其余置 `superseded`

### 需求:reject 驳回不执行
对 `waiting_human` 的 run(已取锁),`reject` 禁止执行任何动作:pending `Approval` 置 `rejected`,经 choke-point 收束 `run.cancelled`。

#### 场景:驳回
- **当** `reject` 一个 `waiting_human` run
- **那么** 不执行任何动作、pending 置 `rejected`、`run.cancelled`

### 需求:Phase 0 单进程假设(多进程并发硬化留 Phase 1)
Phase 0 假设**单用户单进程**审批。上面的 run-state 守卫 + approve 取锁 + reaper + 幂等键已覆盖「崩溃恢复」与「第二个 approver 被守卫挡掉」。**多进程同时 approve/reject 同一 run 的完整仲裁**(seq 竞争败者重试、approve-vs-reject 活 race、granting 的 lease/超时回收)**必须显式延后至 Phase 1**(inbox 每天 cron + 可能多入口时才真需要)。这是有意的、已披露的范围延后,不是遗漏。

#### 场景:延后项已披露
- **当** 评估 Phase 0 并发完备性
- **那么** 文档必须显式声明单进程假设与 Phase 1 硬化清单,不得把多进程并发完整性当作已保证

