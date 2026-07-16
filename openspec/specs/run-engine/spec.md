# run-engine 规范

## 目的
待定 - 由归档变更 phase-0-skeleton 创建。归档后请更新目的。
## 需求
### 需求:运行状态持久化于 SQLite 四表
系统必须用单个 SQLite 文件的四张表 `App` / `Run` / `RunEvent` / `Approval` 承载运行状态;`RunEvent` 必须为 append-only 且带 `UNIQUE(run_id, seq)`(`seq` per-run 从 1 递增)。禁止新增第五张表或第二个库。创建 `Run` 行与其首个 `run.started`(seq=1)事件必须在**同一事务**(否则崩在两者之间会留一个 0 事件、`classify=queued` 却已带锁的孤儿)。

#### 场景:一次 run 同事务落库
- **当** 触发一个 app 的 run
- **那么** 系统必须在**同一事务**内创建一行 `Run` 并追加 `seq=1` 的 `run.started` 事件

#### 场景:事件只追加、seq 不撞号
- **当** run 推进产生新事件
- **那么** 系统必须由该 run 锁的持有者(单写者;approve 亦取该锁,见 tool-gateway)以 `max(seq)+1` 追加,禁止修改/删除已有事件;`UNIQUE(run_id, seq)` 兜底

### 需求:Run 状态由最新 RunEvent 全映射推导,终态只认 run.* 事件
系统必须由某 run 的最新事件计算 `state`(全函数、无悬空)。**只有 `run.completed`/`run.failed`/`run.cancelled` 是终态**;`action.executed`/`action.failed` 是**逐动作进度、非终态**(一次 run 可执行多个动作,单个动作失败不等于 run 失败)。`Run.state` 仅为缓存列。

#### 场景:全映射,action.* 不终态
- **当** 最新事件为 `run.started` / `approval.requested` / `approval.granted` / `action.executed` / `action.failed` / `run.completed` / `run.failed` / `run.cancelled`(或无事件)
- **那么** `state` 必须分别推导为 `running` / `waiting_human` / `executing` / `executing` / `executing` / `completed` / `failed` / `cancelled`(或 `queued`);`action.*` 绝不单独把 run 判为终态

#### 场景:低危动作失败不误杀 run
- **当** `run()` 中途一个低危动作重试耗尽 → gateway 追加 `action.failed`
- **那么** run **不得**因此进终态、不得释放锁;是否终结由 `run()` 决定(catch 继续,或让异常传播 → `run.failed`)

### 需求:所有终态转换走单一同事务 choke-point
任何 run 进终态必须经**唯一一个** choke-point 函数,在**同一事务**里:追加终态 `run.*` 事件、更新 `Run.state`、释放该 app 活跃锁、并把该 run 尚未终结的 `Approval`(pending/granting)一并置 `superseded`。锁释放**挂钩终态转换本身、不校验 `lock_owner==self`**(approve 第二阶段进程释放的锁,其 `lock_owner` 可能是已死的原触发进程)。

#### 场景:终态即释放锁并作废待批
- **当** 某 run 经 choke-point 进入任一终态
- **那么** 必须同事务释放 app 锁,并把其 pending/granting `Approval` 置 `superseded`(使 failed/cancelled 的 run 不留可执行待批动作)

### 需求:崩溃孤儿 run 由 reaper 回收(PID+启动时刻,仅写命令入口)
非抛错的进程死亡会把 run 停在非终态、锁不释放。**写命令(`run`/`approve`/`reject`/`daemon`)启动时**必须跑一次 reaper;**`doctor` 与只读命令不跑**(守 doctor「不写库」契约)。判「进程已死」必须比对 `lock_owner` 的 **PID + 启动时刻**指纹(仅比裸 PID 会被 PID 复用误判为存活),覆盖所有非终态(`queued`/`running`/`executing`)。

#### 场景:回收死进程孤儿 run
- **当** 写命令启动时发现某非终态 run 的 `lock_owner`(PID+启动时刻)已不对应活进程
- **那么** reaper 必须经 choke-point 判它 `run.failed`、释放锁、作废其 pending/granting Approval;`waiting_human`(无进程持有)不动

#### 场景:PID 复用不误判
- **当** 死 run 的裸 PID 已被 OS 复用给另一无关进程
- **那么** reaper 必须靠 PID+启动时刻指纹识别「非同一进程」并照常回收,不得因裸 PID 存活而漏收

### 需求:PipelineExecutor 执行 app 的 run
系统必须提供 `Executor` 接口,以 `PipelineExecutor` 为 v0 唯一实现:加载 app 的 `pipeline.ts` 调 `run(ctx)`;`ctx` 提供 `input`/`config`/`logger`/`emit`/`propose`/**只读 `signal`(`AbortSignal`)**/**只读 `capabilities`(`readonly string[]`)**(**无直执行工具入口**,见 tool-gateway)。`signal` 是鸭子契约新增字段:pipeline 可读它以优雅收尾,忽略它也必须仍能运行(向后兼容)。`capabilities` 是 host 从 canonical set 注入的新鲜冻结快照,供 pipeline 在 run 内业务副作用前 fail closed(见 host-capabilities)。

#### 场景:执行玩具
- **当** `hangar run heartbeat`
- **那么** 系统必须调用其 `pipeline.run(ctx)`,该函数 `emit`/`propose` 的产物必须落库

#### 场景:pipeline 抛错即失败(PARK 不抛错)
- **当** app 的 `pipeline.run` 抛出异常
- **那么** 系统必须经 choke-point 追加终态:**未 aborted → `run.failed`**;**`ctx.signal.aborted` 为真 → `run.cancelled`**(见下「取消」需求)。二者均 `释放锁` + `作废 pending Approval`;PARK **不通过抛错实现**(见 tool-gateway check-after-return)

#### 场景:运行时 pipeline.ts 缺失
- **当** `executor: pipeline` 的 app 在 run 时其 `pipeline.ts` 缺失
- **那么** 必须在**创建 Run 之前**拒绝并报 `pipeline_missing`(退出码 1),不建 Run、不占锁

#### 场景:老 pipeline 忽略 signal 仍可跑
- **当** 一个不读 `ctx.signal` 的老 pipeline 被执行
- **那么** 必须照常运行至自然完成/失败(取消退化为 abort 后宽限超时、由 reaper 收 `failed`,无回归)

#### 场景:pipeline 获得 host 注入的运行期能力
- **当** executor 调用任一 `pipeline.run(ctx)`
- **那么** `ctx.capabilities` 必须是 host canonical set 的新鲜冻结快照,不得采用 input/config/request 中的同名值

### 需求:run 锁防止重复执行
同一 app 同一时刻必须只允许一个活跃(非终态)run,由 `Run` 活跃态 + 部分唯一索引保证(不新增表)。approve/reject 亦取该锁(见 tool-gateway),使审批第二阶段与触发互斥。

#### 场景:重复触发被拒
- **当** 某 app 已有活跃 run 又被触发
- **那么** 报 `already_running`,不创建新 `Run`

### 需求:active run 持 AbortController,取消经 choke-point 记 cancelled 且终态幂等
每个 active run 必须持有一个 `AbortController`,其 `signal` 以只读形式经 `ctx.signal` 暴露给 `run()`。**pipeline 配合 signal 抛出/返回时,取消必须经唯一 choke-point 记 `run.cancelled`**,且**该 run 此后不得再写 `run.failed`/`run.completed`**——依赖既有 choke-point 幂等(首个终态胜、锁只释放一次)。**范围界定(评审):这条「aborted → cancelled、不得 failed」只对「pipeline 观察到 abort 并让本 run 收束」的协作路径成立**;一个**忽略 `signal`、跑到宽限期外**的 run,daemon 停机时不为它写终态,由重启期 reaper 记 `run.failed`(见 cli daemon 停机需求 + host-capabilities `cancelled-terminal/v1` 范围)——这是被明确接受的降级,不与本条矛盾。取消是**进程内**信号驱动(守 #6:无 IPC;不引入 DB 轮询取消标志)。`runApp` 在调用 `evaluateAfterRun`(check-after-return)前必须检查 `signal.aborted`:已 aborted 则直接经 choke-point 记 `run.cancelled`,不进 evaluate(否则「aborted 后正常 return」会被误记 completed)。取消路径必须释放 app 活跃锁与调度侧 `inFlight`(与其他终态同,经 choke-point 释放锁)。**若一次抛错与 abort 同时发生(catch 里 `signal.aborted` 为真、但错误其实是无关真 bug),`run.cancelled` 的 payload MUST 保留该错误文本**(与同一 catch 的 `run.failed` 分支**同样处理**——`executor.ts` 的 failed 路径写原始 `String(err.message)`、不 import gateway 的 `redactError`,故此处**不新增 redact 依赖**,只求不把真故障静默记成干净取消、丢失错误信息)。

#### 场景:mid-run 取消 → cancelled 单一终态
- **当** 一个 active run 执行中被 abort(`controller.abort()`),其 pipeline 观察到 `signal.aborted` 抛出或返回
- **那么** 系统必须经 choke-point 记**唯一**一个 `run.cancelled` 终态、`state=cancelled`、释放锁与 `inFlight`、作废其 pending/granting Approval;**不得**随后再写 `run.failed`/`run.completed`

#### 场景:pre-aborted(run 开始前已取消)
- **当** run 创建时其 `signal` 已 `aborted`(如停机中途又触发)
- **那么** pipeline 观察到 `signal.aborted` 立即收尾,系统经 choke-point 记 `run.cancelled`(非 failed)

#### 场景:完成×取消竞态 → 首个终态胜、幂等
- **当** pipeline 已正常 return 且即将 `run.completed`,同时 abort 到达(或反之)
- **那么** 以先到达 choke-point 的终态为准;第二个终态写入必须是 no-op(run 已终态),锁只释放一次,审计 trace 可回溯

#### 场景:重复取消幂等
- **当** 同一 run 被 abort 两次(或 SIGINT 后再 SIGTERM)
- **那么** 第二次 abort 对 controller 无副作用、第二次终态写入 no-op;终态仍为唯一一个 `run.cancelled`

