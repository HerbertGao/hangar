## 修改需求

### 需求:崩溃孤儿 run 由 reaper 回收(PID+启动时刻,仅写命令入口)
非抛错的进程死亡会把 run 停在非终态、锁不释放。**写命令(`run`/`approve`/`reject`/`daemon`)启动时**必须跑一次 reaper;**`doctor` 与只读命令不跑**(守 doctor「不写库」契约)。判「进程已死」必须比对 `lock_owner` 的 **PID + 启动时刻**指纹(仅比裸 PID 会被 PID 复用误判为存活),覆盖所有非终态(`queued`/`running`/`executing`)。

**边界(本变更澄清,非新行为):** 现有 reaper **只回收 DB 与 app 锁**(判 `run.failed`、释放锁、作废 Approval),它**不持有任何子进程 / 进程组身份,不回收 pipeline 派生的 OS 子孙进程**。因此对会 spawn detached 进程组的 trusted pipeline,daemon 被 SIGKILL / 崩溃后,reaper 使 DB 干净、但那些 OS 孤儿进程可能仍在 init 下运行。**「Hangar DB reaped」与「OS child reaped」是两件必须分开断言的事,前者 MUST NOT 被当作后者。** 「可证明地回收 OS 子孙进程树」的 hard-crash containment 属独立能力 `hangar.run.hard-crash-containment/v1`(见 `host-capabilities`),其实现与 fault test 是**单独的后续受闸变更**;在其落地前,要求该能力的 app 经能力集 fail-closed。

#### 场景:回收死进程孤儿 run
- **当** 写命令启动时发现某非终态 run 的 `lock_owner`(PID+启动时刻)已不对应活进程
- **那么** reaper 必须经 choke-point 判它 `run.failed`、释放锁、作废其 pending/granting Approval;`waiting_human`(无进程持有)不动

#### 场景:PID 复用不误判
- **当** 死 run 的裸 PID 已被 OS 复用给另一无关进程
- **那么** reaper 必须靠 PID+启动时刻指纹识别「非同一进程」并照常回收,不得因裸 PID 存活而漏收

#### 场景:DB 回收不等于 OS 子孙回收
- **当** daemon 被 SIGKILL,其 in-process pipeline 先前 spawn 的 detached 进程组被 reparent 到 init 后仍在运行
- **那么** 现有 reaper 回收 DB/锁(判 `run.failed`)后,该 OS 进程组**可能仍存活**;此状态 MUST NOT 被表述/断言为「OS 子孙已回收」——后者须由 `hangar.run.hard-crash-containment/v1` 的实现 + fault test 独立证明
