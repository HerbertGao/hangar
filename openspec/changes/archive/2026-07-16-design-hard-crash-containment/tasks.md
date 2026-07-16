## 1. ADR(design.md)-- 本变更核心产出

- [x] 1.1 评估方案,**推荐 (d)**(进程内 + hangar 自管 `ctx.spawn` + reaper 按 run_id 回收;Linux run_id 命名 cgroup + `cgroup.kill` / macOS `HANGAR_RUN_ID` env-tag 全表扫逐杀);记录 (a) worker 仅当同时要崩溃隔离才值、(b) 被 (d) 吸收、(c) launchd 否决作调度器且其容纳也 best-effort;记录砍掉 macOS killpg 补充腿的简化决定(过度工程:唯一多抓的片 = scrub-env 密封沙箱,本就路由 Linux/VM)
- [x] 1.2 明确回收边界:孤儿判定(`isDead(lock_owner)` 不变)、锁/Run 终态(**`isDead` 即 chokePoint 恒发生、DB 必 reap;OS 回收在事务外先跑、有界、错误 catch、不挡 chokePoint**)、重启安全(两平台均无需 boot 门--Linux cgroupfs 每 boot 重建 / macOS run_id 唯一 UUID)、防误杀(Linux cgroup 无复用;macOS env-tag 即身份、唯一 UUID 无假命中;**残余:macOS inspect-to-kill 间极窄 PID 复用误杀窗口**)、掉 env-tag/setsid/容器逃逸(Linux cgroup 全抓,delegatee 主动自迁移 sibling 属威胁模型之外、可信 pipeline 不做、不计残余;macOS env 扫抓一切留 tag 含 setsid、担保残余 = 任何丢 tag 者)、approve 面(reaper 扫统一,但 approve 进程须自接 containment 接线、**ctx.spawn 只管 OS 生命周期待遇、不绕过 ctx.propose/#5**)、app SQLite resume(app 职责)
- [x] 1.3 记录不变量分析:**(d) pipeline 留在进程内 -> §6/`#6` 不碰**(ctx.spawn 本地 API、reaper 读 OS+SQLite、非 IPC);handle = `run_id`、**两平台均零新列**(Linux cgroup 路径 `<委派根>/hangar-<run_id>` 由 run_id 派生、macOS tag 即 run_id);ctx.spawn 子进程非常驻第二进程(守 #3--不加表、不加列、不加进程)
- [x] 1.4 诚实标注平台天花板:**macOS 无内核容器 -> best-effort**,担保残余 = 任何丢掉 `HANGAR_RUN_ID` tag 的子孙(密封沙箱 scrub env)+ env 不可读的 uid-change/SIP 子进程 + inspect-to-kill PID 复用窗口;Linux 有 cgroup 委派时 provable+完整、无委派回退 best-effort;可证明-on-mac 须 Linux VM(OQ1)

## 2. 能力闸契约(host-capabilities,依赖 #17)

- [x] 2.1 定义 `hangar.run.hard-crash-containment/v1` 广播闸 = **release-time 纪律**:实现变更只有在 fault test 全绿后才把该能力串加进 `HOST_CAPABILITIES`(doctor 逐字广播静态集,非运行时门);Hangar DB reaping 单独 MUST NOT 满足它;**macOS 也广播 `/v1`(best-effort 语义)**--迁移前提是 best-effort 对留 tag 工具链与 launchd 同档即可切,mac 不广播则永远 fail-closed;要区分 provable 则另立更严能力串;**v1 的 fault test 必须覆盖 pipeline + approve 两面**(pipeline 经 ctx.spawn、approve 侧经等效受闸接线、**非自动**)
- [x] 2.2 定义消费契约:要求该能力的 adapter 在**部署期**读真机 doctor 自比、业务副作用前 fail-closed(#17 的 C2:模块顶层副作用先于 in-run 断言,可靠强制点在部署期;缺失或仅未知更高版本 -> 精确匹配不命中 -> 关门);复用 **#17** 的 `assertCapabilities`
- [x] 2.3 在 proposal/spec 中标注**依赖 add-run-cancellation #17**(host-capabilities 机制;代码已在 #17 实现、规范待归档);`hardcrash` 走 ADDED delta(ADDED-vs-baseline 理由见 spec);**spec 的 /v1 需求按平台分级**(Linux 完整、macOS best-effort + 披露残余)

## 3. fault test 契约(供后续实现变更验收,本变更只定义不实现)

- [x] 3.1 写明 **pipeline 面** fault test 必证:`ctx.spawn` 起一棵长生命周期树(**普通-留 tag / setsid-留 tag / scrub-env-丢 tag**)-> SIGKILL daemon -> 重启 -> reaper 回收 -> 断言(**Linux `cgroup.kill` 全清三类;macOS env 扫清一切留 tag 含 setsid、scrub-env-丢 tag 记残余**)
- [x] 3.2 写明 **approve 面** fault test:从 `hangar approve` handler 经受闸 containment 入口起 detached 长生命周期子进程 -> SIGKILL -> 重启 -> 断言 reaper 按 run_id 回收(两平台,与 pipeline 面同等覆盖)
- [x] 3.3 写明:无关进程 MUST NOT 被杀(误杀防护断言)
- [x] 3.4 写明:DB-reaped 与 OS-child-reaped **分开断言**,前者不冒充后者;**OS 回收步抛错或超时时断言 chokePoint 仍释放锁、run 仍 failed**;reaper 重复跑不误杀、不崩(幂等);**OS 回收步有界**(超时即放弃、不挂住 DB reap)
- [x] 3.5 写明 **Linux 无委派回退**:无 cgroup 委派时回退 env-tag(同 macOS)-> 断言 best-effort 回收仍工作

## 4. 契约文档同步(DESIGN / SKILL)-- 改架构先改 DESIGN(#9)

- [x] 4.1 `DESIGN.md` §6:**(d) 不改 §6**(pipeline 留在进程内)--仅补注「hard-crash containment 是进程内 + ctx.spawn 记录 + reaper 回收,不引入进程外 worker」;worker(crash-isolation)若将来上再动 §6
- [x] 4.2 `DESIGN.md` §3.4:补 reaper 边界--DB reap 恒发生(OS 回收事务外、有界、错误 catch、不挡 chokePoint)、OS 回收(cgroup.kill / env 扫逐杀)是额外 best-effort 步、两平台无需 boot 门(Linux cgroupfs 重建 / macOS run_id 唯一 UUID)。**§3.3 不动**(两平台均零新列)
- [x] 4.3 `SKILL.md`:若 doctor 能力集将含 `hangar.run.hard-crash-containment/v1`,在能力集说明处标注其广播闸语义(过 fault test 才出现)

## 5. 显式延后 + 校验

- [x] 5.1 **显式记账:(d) 实现 + fault test 是单独的后续受闸变更**(加 `ctx.spawn`、`reaper.ts` 按 run_id 回收;`store.ts` 零列改动;`lock.ts` 沿用平台自适应模式);本变更零运行时代码
- [x] 5.2 **auto-developer 生产 scheduler owner 在该后续变更 fault test 通过前保持 launchd**(硬前置);cut-over 时 pin 已测 hangar commit/version
- [x] 5.3 `openspec-cn validate design-hard-crash-containment --strict` 通过
