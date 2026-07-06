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
系统必须提供 `Executor` 接口,以 `PipelineExecutor` 为 v0 唯一实现:加载 app 的 `pipeline.ts` 调 `run(ctx)`;`ctx` 提供 `input`/`config`/`logger`/`emit`/`propose`(**无直执行工具入口**,见 tool-gateway)。

#### 场景:执行玩具
- **当** `hangar run heartbeat`
- **那么** 系统必须调用其 `pipeline.run(ctx)`,该函数 `emit`/`propose` 的产物必须落库

#### 场景:pipeline 抛错即失败(PARK 不抛错)
- **当** app 的 `pipeline.run` 抛出异常
- **那么** 系统必须经 choke-point 追加 `run.failed`、`state=failed`、释放锁、作废其 pending Approval;PARK **不通过抛错实现**(见 tool-gateway check-after-return)

#### 场景:运行时 pipeline.ts 缺失
- **当** `executor: pipeline` 的 app 在 run 时其 `pipeline.ts` 缺失
- **那么** 必须在**创建 Run 之前**拒绝并报 `pipeline_missing`(退出码 1),不建 Run、不占锁

### 需求:run 锁防止重复执行
同一 app 同一时刻必须只允许一个活跃(非终态)run,由 `Run` 活跃态 + 部分唯一索引保证(不新增表)。approve/reject 亦取该锁(见 tool-gateway),使审批第二阶段与触发互斥。

#### 场景:重复触发被拒
- **当** 某 app 已有活跃 run 又被触发
- **那么** 报 `already_running`,不创建新 `Run`

