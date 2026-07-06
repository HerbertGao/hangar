## 1. 工程骨架

- [x] 1.1 建 pnpm workspace:根 `package.json` + `pnpm-workspace.yaml`(`packages/*` + `apps/*`)+ `tsconfig.base.json`
- [x] 1.2 建 `packages/core`(`@hangar/core`),装 `zod`/`pino`/`node-cron`/`yaml`(inbox 已在用)+ **净新** `better-sqlite3`(验证目标平台预编译/node-gyp;musl 需从源码构建)
- [x] 1.3 建 `hangar` CLI 入口(bin):无参打印帮助、退出码 0/1/2 骨架、pino 日志走 stderr

## 2. SQLite 状态库

- [x] 2.1 四表 `App(id,name,registered_at)` / `Run(…,lock_owner)`(`lock_owner`=PID+启动时刻)/ `RunEvent(…,UNIQUE(run_id,seq))` / `Approval(…,status)` + run 锁部分唯一索引(同 app 单活跃 run)
- [x] 2.2 open/init helper:WAL + `PRAGMA busy_timeout`、首次幂等建表
- [x] 2.3 self-check:四表存在可读写、`UNIQUE(run_id,seq)` 拒重复 seq

## 3. App registry(spec: app-registry)

- [x] 3.1 `SpecSchema`(zod):`id`/`name`/`executor`(**已知值枚举**)/`triggers`/`tools`/`permissions`/`config`
- [x] 3.2 扫 `apps/*/app.yaml`、zod 校验、`id==目录名`;缺字段 / 未知 executor 值 → `spec_invalid` 不注册
- [x] 3.3 `executor` 选向;`pipeline` → 约定定位 `pipeline.ts`;已知未实现值 → run 时 `executor_unsupported`
- [x] 3.4 self-check:合法注册;缺/未知 executor → `spec_invalid`

## 4. Run engine(spec: run-engine)

- [x] 4.1 创建 `Run` + `run.started`(seq=1)**同一事务**(queued 不带锁落库);append 事件事务内 `max(seq)+1`
- [x] 4.2 `classify` 全映射:**`action.*` 非终态(→executing)、只 `run.*` 终态**;空→queued
- [x] 4.3 **choke-point**(唯一终态函数):同事务 append `run.*` + 更新 `Run.state` + 释放 app 锁 + 作废该 run 的 pending/granting `Approval`(`superseded`);锁释放**不校验 `lock_owner==self`**
- [x] 4.4 run 锁:活跃 run 存在 → `already_running`
- [x] 4.5 `Executor` 接口 + `RunContext`(`input`/`config`/`logger`/`emit`/**async `propose`**;无 `tools`)
- [x] 4.6 `PipelineExecutor`:抛错 → 经 choke-point `run.failed`;非 pipeline → `executor_unsupported`;PARK 用 check-after-return **不抛错**;run 时 `pipeline.ts` 缺失 → **建 Run 前**报 `pipeline_missing`
- [x] 4.7 **reaper**:仅写命令入口跑(`doctor`/只读不跑);按 **PID+启动时刻**指纹判死;覆盖 `queued`/`running`/`executing`;经 choke-point 回收;`waiting_human` 不动
- [x] 4.8 self-check:`action.failed` 不终态、choke-point 释放锁 + 作废 Approval、reaper 回收死 PID(含 approve 崩溃)、PID 复用不误判

## 5. Tool gateway(spec: tool-gateway)

- [x] 5.1 **`tools.ts` handler 注册表**:gateway 按名加载 `{ [tool]: (args,ctx)=>Promise }`,独立于 `run()`
- [x] 5.2 async `propose`:低危 `await` handler 执行 + `action.executed` + resolve 结果;高危写 `Approval(pending)` + resolve void,不执行不中断
- [x] 5.3 check-after-return:有 pending → `approval.requested` + `waiting_human`;无 → 经 choke-point `run.completed`(**支持多次高危 propose**)
- [x] 5.4 内存有界重试(`MAX_ATTEMPTS`,不 durable)+ `redactError` 剥域正则
- [x] 5.5 approve/reject:**先守 `state==waiting_human`(否则 `not_waiting`)→ 取 run 锁**;approve 执行 handler(`Approval.id` 幂等键)+ `action.executed` + `granted`,全完成经 choke-point `run.completed`;approve 无 pending → `no_pending_approval`
- [x] 5.6 approve 部分失败 → 经 choke-point `run.failed`(已 granted 不回滚);reject → pending `rejected` + 经 choke-point `run.cancelled`
- [x] 5.7 self-check:**handler 真被调用产生可观测副作用**、非 waiting_human 拒审批、PARK 端到端(多次 propose→park→approve→execute→completed)、reject→cancelled、低危 `await` 直执

## 6. CLI 命令(spec: cli)

- [x] 6.1 I/O 约定:数据 stdout、日志 stderr、`--json`、退出码 0/1/2、无参帮助
- [x] 6.2 写命令(`run`/`approve`/`reject`/`daemon`)`getuid()===0` 拒 root;`doctor`/只读不拒
- [x] 6.3 只读 `status`/`runs`/`trace`;`run_not_found`;**status/doctor 派生「阻塞」**(waiting_human + cron 逾期)
- [x] 6.4 写:`run`(`--input`)、`approve`、`reject`(接 gateway,含 `not_waiting`)
- [x] 6.5 `doctor`:node 版本、sqlite 可写(**文件已存在查文件、否则查目录、不建库**)、`apps/`、spec 合法性、`pipeline.ts` 存在性;`--json`
- [x] 6.6 `daemon`:cron 无活跃 run 才触发;被挡跳过(至多 stderr 日志);阻塞不持久化、靠派生

## 7. heartbeat 玩具 app

- [x] 7.1 `apps/heartbeat/app.yaml`:`executor: pipeline`,`permissions.approval` 含一个假高危 tool
- [x] 7.2 `apps/heartbeat/pipeline.ts`:`run` 里 `emit` 一条 + `propose` **两个**假高危动作
- [x] 7.3 `apps/heartbeat/tools.ts`:假高危 tool 的**可观测 handler**(写 marker 文件/计数),供 DoD 断言执行真发生

## 8. 端到端出口闸(DoD)

- [x] 8.1 快乐路径:`doctor --json` 全绿(不建库)→ `run heartbeat`→`waiting_human`(**两个** pending)→ `status --json` 正确 → `approve`→`completed` → **handler 的 marker 真被写**(证明 execute 非 no-op)→ `trace` 完整时间线
- [x] 8.2 防 false-green 断言:`action.failed` 不终态(低危失败 run 不死)、崩溃(杀进程)后 reaper 回收锁(含 approve 崩溃 + 幂等键不重复执行)、非 waiting_human 的 run 拒 `approve`
- [x] 8.3 **显式记录 Phase 0 单进程假设**:多进程并发 approve/reject 仲裁不在 Phase 0 覆盖(留 Phase 1),文档不得当作已保证
