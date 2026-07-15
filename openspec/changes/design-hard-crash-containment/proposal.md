## Why

hangar v0 在 daemon 进程内 `import` pipeline(DESIGN §6 显式接受「共享崩溃域」)。auto-developer 这类 **trusted pipeline** 会 spawn detached process group(build / test / git 等孙进程)。issue #17 给的 `AbortSignal` 能覆盖 SIGINT/SIGTERM 的优雅清理,但 **daemon 被 SIGKILL / 崩溃 / 主机断电时清理代码根本不跑**--detached 进程组被 reparent 到 init 继续运行、继续写副作用。

而当前 reaper(`reaper.ts`)只按 `Run.lock_owner`(pid+启动时刻)把孤儿 Run 判 `run.failed`、释放锁--**它只修 DB/锁,不持子进程 PGID 身份,证明不了 OS 子孙进程已被回收**。于是 hangar 报「run failed、锁已释放」时,auto-developer 的 detached build/git 可能仍在 init 下运行。**「Hangar DB reaped」≠「OS child reaped」**--这道缺口正是 auto-developer 不能把生产 scheduler owner 从 launchd 切到 hangar 的原因。**但研究定论:macOS 无内核容器(cgroup),可证明容纳根本不可能--launchd 自己也只是 best-effort。** 故目标是**在 macOS 对留 tag 的工具链与 launchd 同档 best-effort(不同的洞、不丢容纳)**即可切换,可证明容纳留给 Linux(cgroup)或 Linux VM。

本变更是 **ADR / 设计,不是实现**(issue #18 明写「请先形成 ADR/设计…再选择实现」)。产出 = 一份评估方案、**推荐 (d)(进程内 + hangar 自管 `ctx.spawn` + reaper 按 run_id 回收)**的 ADR + DESIGN 决策 + 能力闸契约;**`ctx.spawn` / cgroup / reaper 扫等实现属另一个受闸的后续变更**。

## What Changes

- **产出 ADR(`design.md`)**:评估方案并**推荐 (d)**--深挖 OS 原语 + 业界先例(cgroup / systemd-run / Nomad / GitHub runner)后,以「持久化 handle(hangar 天生有 `run_id`)+ 平台自适应回收」为核:
  - **(d)【推荐】** pipeline **留在进程内**、hangar 自管 `ctx.spawn`(Linux 放 run_id 命名 cgroup v2、macOS 注入 `HANGAR_RUN_ID` env-tag),reaper 按 run_id 回收(Linux `cgroup.kill` / macOS env 扫逐杀);
  - (a) worker 进程组--仅当**同时**要崩溃隔离才值,对容纳目标正交且更重;
  - (b) child lease--被 (d) 吸收(hangar 自管、自证);
  - (c) launchd--否决作调度器(自我拆台+平台锁),但记录其容纳**也** best-effort。
- **明确边界**:孤儿判定、重启安全(两平台均无需 boot 门)、DB-reap 恒发生 vs OS-回收 best-effort、掉 env-tag/setsid 残余、approve 面(须自接线、fault test 必覆盖)、app 自身 SQLite resume。
- **定义能力闸 `hangar.run.hard-crash-containment/v1`**(依赖 **add-run-cancellation #17** 引入的 `host-capabilities` 机制;代码已在 #17 实现、规范待 #17 归档):**实现变更只有在 fault test 全绿后才把该能力串加进 `HOST_CAPABILITIES`(release-time 纪律,doctor 逐字广播静态集、非运行时门);Hangar DB reaping 单独 MUST NOT 满足它**(DB-reaped 与 OS-child-reaped 分开断言)。要求该能力的 app adapter 在**部署期**读真机 doctor 自比、业务副作用前 fail-closed。
- **更新 DESIGN.md**(§6 进程内崩溃域假设 + §3.4 reaper 边界 + 能力闸)--改架构先改 DESIGN(#9)。
- **显式延后**:选定实现 + fault test 是**单独的后续受闸变更**;在其通过前 auto-developer 生产 owner 保持 launchd。

## Capabilities

### New Capabilities

(无 -- `host-capabilities` 由 **#17** 引入;本变更只**追加**一条 `hardcrash` 需求,详见 Modified Capabilities 与 specs/host-capabilities。)

### Modified Capabilities

- `host-capabilities`(**追加需求**,写作 ADDED -- `hardcrash` 是全新需求,ADDED-vs-baseline 的理由详见 specs/host-capabilities):定义 `hangar.run.hard-crash-containment/v1` 的广播闸与 fail-closed 语义。**依赖 #17**。
- `run-engine`(**修改**「崩溃孤儿 run 由 reaper 回收」需求):补一条边界--current reaper 回收 DB/锁**不代表**回收了 OS 子孙进程,二者须分开断言;禁止拿前者冒充后者。这是**边界澄清、非新行为**。

## Impact

- **代码**:本变更**零实现代码**(设计-only)。后续实现变更将触及 `executor.ts`/`RunContext`(加 `ctx.spawn`,平台自适应:Linux run_id 命名 cgroup + `CLONE_INTO_CGROUP` / macOS 注入 `HANGAR_RUN_ID` env-tag)、`reaper.ts`(孤儿按 run_id 回收)、`store.ts`/schema(**两平台均零新列**--handle = `run_id`)、`lock.ts`(沿用其平台自适应模式)。
- **契约文档**:`DESIGN.md`(§3.4 reaper 边界;§6 **不改**--(d) 留在进程内)、`SKILL.md`(doctor 能力集若含 `hardcrash` 闸,按平台标 best-effort)。
- **数据/DB + 进程(#3)**:handle = **`run_id`**(createRun 起就 durable)。**两平台均零新列**(Linux cgroup 路径由 run_id 派生、macOS tag 即 run_id)。**(d) pipeline 在进程内、不加常驻第二进程**(ctx.spawn 的子进程 = pipeline 今天就在起的 build/git,只是走受闸入口)--故 **§6/`#6` 均不碰**,守 #3(不加表、不加列、不加进程)。
- **不变量**:(d) **不触碰** §6(pipeline 留在进程内)--比 worker 方案轻。能力闸依赖 **#17** 的 `host-capabilities`。**macOS 无 cgroup 是平台天花板**:v1 在 mac 上 best-effort(如实广播)。

## 非目标

- **本变更不写实现**:`ctx.spawn` / cgroup / reaper 扫 / fault test 全属后续受闸变更,本轮只出 ADR + 契约。
- **不为 inbox 建**:inbox 不 spawn 任何 detached / 长生命周期子进程,**根本不需要**本能力。它由 **auto-developer(Phase-2 pilot,唯一 forcing consumer)** 独家驱动,且显式受闸(其生产 owner 在实现落地前保持 launchd)。本变更据此**显式请求一个 #2 例外**(已获 owner 批准)--见 design.md D6。
- **不覆盖 SIGKILL 以外的、已有归属的场景**:优雅 SIGINT/SIGTERM 清理是 issue #17(add-run-cancellation)的职责,不在本变更。
- **不承诺在 macOS 上「可证明」回收**:macOS 无内核容器,担保残余 = **任何丢掉 env-tag** 的子孙(密封沙箱构建 scrub env)+ env 不可读的 uid-change/SIP 子进程;可证明须 Linux(有 cgroup 委派)或 Linux VM。ADR 如实标注这道平台天花板。
