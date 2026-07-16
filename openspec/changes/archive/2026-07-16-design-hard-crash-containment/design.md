## Context

**现状(已核对代码):**

- **进程内加载。** daemon(`cli.ts` `startDaemon`)cron 到点 -> `runApp`(`executor.ts`)-> `import(<appDir>/dist/pipeline.js).run(ctx)`。pipeline 与 daemon **同一进程、同一崩溃域**(DESIGN §6 显式接受此代价)。
- **reaper 只修 DB/锁。** `reaper.ts` 按 `Run.lock_owner`(`${pid}:${startTime}`,`lock.ts`)判死进程 -> 经 choke-point 判 `run.failed`、释放 app 锁、作废 Approval。它**不持有任何子进程/进程组身份**,对 OS 层的 detached 进程一无所知。
- **#17 覆盖优雅路径。** add-run-cancellation 给 `ctx.signal`(AbortSignal),daemon SIGINT/SIGTERM abort 全部 active run -> pipeline 自行清理其子进程。**但 signal handler 只在进程还活着时跑。**

**触发场景:** auto-developer(trusted pipeline)在 `run()` 里 spawn build / test / git 子进程(可能再派生孙进程)。当 daemon 被 `kill -9` / segfault / OOM-killed / 主机断电:AbortSignal handler **不跑**,pipeline 清理**不跑**,这些子孙进程被 reparent 到 init、**继续运行、继续写副作用**(可能正在 `git push` 或跑 build);daemon 重启后当前 reaper 把 Run 判 `failed`、释放锁,**DB 干净了,但 OS 孤儿进程仍在 init 下活着**。

**这就是缺口:`Hangar DB reaped` ≠ `OS child reaped`。** hangar 现在无法**证明**它回收了 OS 子孙进程树。

**平台现实(研究定论,决定本 ADR 的形状):**
- **可证明、完整、防 setsid 逃逸的回收,依赖内核容器(Linux cgroup v2)+ 把 handle 持久化到磁盘**(Nomad / kubelet / systemd-run 皆此路)。跨崩溃回收的充要条件 = 「持久化 handle」+「活过 agent 的内核容器」;GitHub / Buildkite 无法跨重启回收,正因它们**不持久化 handle**。**hangar 天生持久化 handle**--`run_id` 一直在 `Run` 行、在 SQLite,这是 hangar 的关键优势。
- **macOS 上「可证明」的硬崩溃容纳根本不可能**:没有 cgroup、没有 namespace、没有 child-subreaper,只有 pgid/sid(setsid 能逃)和按属性扫 BSD 进程表(有 reparent + PID 复用竞争)。**launchd 自己在这也是 best-effort。** 故 hangar 不需**超过** launchd(不可能);(d) 在 macOS 对留 tag 的工具链与 launchd **同档 best-effort、不同的洞**(非严格 ≥)--切离 launchd 就成立;要「可证明」得把 build 塞进 Linux VM(与调度器无关)。

**约束(不变量):** #1 脊柱零域概念 · #3 一 host/一 SQLite/4 表 · #5 审批只在 OS 层 · #6 v0 脊柱内无 HTTP/IPC/MQ(CLI 与 daemon 共享 SQLite、互不通信) · #9 改架构先改 DESIGN。

## Goals / Non-Goals

**Goals:**
- 让 **hangar 自身**(而非每个 app)在 daemon hard-crash 后回收 pipeline 派生的 OS 子孙树:**Linux 可证明 + 完整(cgroup),macOS best-effort(与 launchd 同档、不同的洞)**--平台自适应,同 `lock.ts` 已有的 Linux `/proc` vs 非 Linux `ps` 分野。
- 明确回收边界(详见 D3;核心切分 = DB-reap 恒发生 vs OS-回收 best-effort)。
- 定义 `hangar.run.hard-crash-containment/v1` 能力闸:**过 fault test 才广播、按平台如实标注强度;DB-reaped 不算数**。
- 给出推荐方案 (d) + 后续实现变更的验收(fault test)契约。

**Non-Goals:**
- 本变更**不写实现**(ctx.spawn / cgroup / reaper 扫 / fault test 属后续受闸变更)。
- 不覆盖优雅 SIGINT/SIGTERM(= #17)。
- **不承诺在 macOS 上「可证明」地回收**--macOS 无内核容器,纯 best-effort;要可证明须 Linux VM/容器(记为升级路径,不在 v1 macOS 承诺)。
- 不为 inbox 建(inbox 无 detached / 长生命周期子进程,见下 #2 例外论证)。

## Decisions

### D1 - 方案评估(深挖 OS 原语 + 业界先例后定稿)

**(d) 进程内 pipeline + hangar 自管 `ctx.spawn` + reaper 按 run_id 回收 【推荐】**

pipeline **仍在进程内**(§6 不动、无 worker)。hangar 提供 **`ctx.spawn(cmd, opts)`** 作为受闸 pilot **唯一的受容纳 spawn 入口**。**handle = `run_id`**(createRun 起就 durable,GitHub/Buildkite 缺的正是它)--两平台都**零新列**,回收全凭 run_id:

- **Linux:** 子进程进一个 **run_id 命名的 per-run cgroup v2**(路径确定性 = `<委派根>/hangar-<run_id>`,reaper 由 run_id **重构**;委派根由部署定(systemd user-slice 或 root chown),属实现细节)。**用 `CLONE_INTO_CGROUP`(5.7+;`cgroup.kill` 已需 5.14+ 故必有)让子进程从第一条指令就在 cgroup 内**--无「建组 -> fork -> 写 `cgroup.procs`」的落组窗口(Node 的 `child_process` 不直接暴露 clone3 flag,实现用 native shim 或自落组 exec wrapper--**实现细节,非 ADR 级**;目标「从第一条指令就在 cgroup」不变)。回收 = 重构路径 -> `cgroup.kill`(5.14+,**防 setsid 逃逸、防 fork race**、可安全重复执行)-> `rmdir`。**cgroupfs 每次 boot 重建为空,故留存的 `hangar-<run_id>` cgroup 必属本 boot--重启安全由构造保证、无需 boot 门。** 有 cgroup v2 委派时 **provable + 完整**;无委派则回退 env-tag(同 macOS)、best-effort。
- **macOS:** `ctx.spawn` 给子进程注入 **`HANGAR_RUN_ID=<runId>` env**(跨 fork+setsid+exec 继承)。回收 = **按 `HANGAR_RUN_ID` 全表扫、逐个杀匹配进程,再重扫直至稳定或超时**(单一机制、无需记录、**无记录窗口**;**抓一切保留 tag 的进程,含 setsid 逃逸者**--正是 launchd 的 job-pgid 抓不到的)。**重启安全无需 boot 门**:重启后 pre-reboot 进程已死,唯一可能携带旧 tag 的是该 run 的孤儿(被扫到即正确清理);`run_id` 是唯一 UUID,故不会误命中其他 run 的进程。**担保残余 = 任何丢掉 `HANGAR_RUN_ID` tag 的子孙**(见 D3/Risks);**另:inspect-to-kill 间有极窄 PID 复用误杀窗口**(macOS 无 pidfd、不能 race-free kill;同 launchd 的 pgid 复用);**scan-kill 间被杀进程 fork 出带 tag 子孙的窗口由重扫循环收窄**(仅末次重扫后 fork 者残留,极窄)。**best-effort。**
- *(评审曾考虑给 macOS 加 `killpg` 补充腿以多抓「组内丢-tag 者」,但判定为过度工程:它唯一多抓的片 = scrub-env 密封沙箱,本就路由 Linux/VM;且引入非幂等 + 须事务性认领孤儿(claim-the-orphan)+ 存 pgid 的写窗口。砍掉 -> macOS 单一 env-tag 机制,可测可推理。)*

**reaper(写命令启动时,现有入口)** 对每个孤儿 run(`isDead(lock_owner)` = 持有 daemon 死):按 run_id 回收(Linux 重构 cgroup 路径 `cgroup.kill` / macOS env 扫逐杀,均**有界、超时即放弃**不挂住 DB reap)-> **无论 OS 回收成败**,再经**现有单一 choke-point** 判 `run.failed` + 释放锁(DB reap 恒发生,见 D3)。

- **为何 (d) 够、且比 (a) 轻:** 要回收的是 pipeline 派生的**子孙**(build/git),不是 pipeline 本身(它随 daemon 一起死)。**§6 不碰(进程内)、无跨进程 `ctx.input`/`propose` 通道、`#6` 不碰**(ctx.spawn 本地 API、reaper 读 OS+SQLite、非 IPC)。**schema:两平台均零新列**(handle = `run_id`,Linux 路径由 run_id 派生、macOS tag 即 run_id)--守 #3(不加表、不加列、不加进程)。

**(a) 每 pipeline 独立 worker 进程组 + reaper killpg 【仅当同时要崩溃隔离才值】**

daemon spawn 一个 worker 作进程组 leader,pipeline 在 worker 内跑;reaper `killpg(worker 组)`。**它对「容纳」目标是正交且更重的**:worker 的真正价值是**崩溃隔离**(pipeline crash ≠ daemon crash)--那是 §6 当前接受的另一个代价、另一份变更;单为容纳不值得付 §6 侵入 + 跨进程 `ctx.input`/`propose` 通道 + approve 面不覆盖。**容纳本身 (d) 已足。** 若将来 crash-isolation 也上日程,worker 可顺带兼容 (d) 的 handle 回收。

**(b) trusted app 持久化 child lease 【被 (d) 吸收】**

pipeline 每 spawn 一个 detached 子进程先写一份持久 lease、重启读回回收。**(d) 就是它的 hangar-自管版**:handle 由 hangar 记录(ctx.spawn)、由 hangar 回收(reaper)-> **hangar 自证**,修掉 (b) 「责任下放给 app、hangar 无法普适自证」的缺点;lease 落 `Run` 列(非第 5 表)。app 自身域 SQLite 的 resume 仍是 app 职责(见 D3)。

**(c) macOS launchd 可验证 containment 【否决作调度器,但记录其容纳也 best-effort】**

- **否决理由:** ① 自我拆台--auto-developer 的目标就是用 hangar **取代** launchd 当 scheduler owner;② 平台锁定。
- **但关键定论:** launchd 在 macOS 上的容纳**同样只是 best-effort**(macOS 无 cgroup)。所以「hangar 证明不了容纳、故不能切离 launchd」这个立论**不成立**--launchd 也证明不了;(d) 在 macOS 对留 tag 工具链与 launchd 同档 best-effort(不同的洞)即满足切换(见 D2)。

### D2 - 战略决策:(d) 便携核 + Linux cgroup 升级 + macOS 诚实 best-effort

macOS 根本只能 best-effort,故真正要拍的不是「worker vs lease」,而是容纳强度目标:

| | A. macOS best-effort(推荐) | B. build 塞进 Linux VM/容器 | C. 保持 launchd |
|---|---|---|---|
| 强度 | best-effort(env-tag 扫),**与 launchd 同档、不同的洞**(见下) | **provable + 完整**(cgroup,**需 v2 委派**;无委派回退 best-effort) | best-effort(= A) |
| 代价 | 小,不碰硬不变量 | 需在 mac 上跑 Linux VM(重、偏离「无头脊柱」) | 零(现状) |
| 切离 launchd | ✅ | ✅ | ❌ |

**macOS best-effort 与 launchd 的关系(诚实):** env-tag 扫抓一切保留 tag 的子孙、**含 setsid 逃逸者**--这是 launchd 的 job-pgid 抓不到的;反过来,launchd 的持久 job-pgid 能抓「组内成员 scrub 了 tag」这类 hangar 的 env 扫抓不到的(它们丢了 tag)。**故二者是不同的洞、非严格 ≥。** 对**保留 tag 的工具链**(普通 git/build 不 scrub env),hangar 抓得比 launchd 全(多抓 setsid 逃逸者)-> cutover 不丢容纳;对**密封沙箱 scrub env 的工具链**(Bazel/Nix),tag-drop 残余在两者都真实 -> **那类 run 应走 Linux(cgroup 可证明)或 Linux VM(D2/B)**。

**推荐:先落 (d)、macOS 上如实标 best-effort**(对留 tag 工具链与 launchd 同档、不丢容纳即满足切换),**Linux cgroup 的 provable 路径在有委派时自动生效**,provable-on-mac(Linux VM)留作「auto-developer 工具链实测漏(见残余)才上」的升级。**本 ADR 只定方向,实现与最终形态由后续受闸变更在原型 + fault test 跑通后拍板。**

### D3 - 回收边界(实现契约)

| 边界 | 处理 |
|---|---|
| **孤儿判定** | 沿用现有 `isDead(lock_owner)`(持有 run 的 daemon 死 = 孤儿)--**语义不变、零回归**。`lock_owner` 仍是 daemon 身份;OS 回收 handle = `run_id`(**不另存**,不动 `lock_owner`、不加列)。 |
| **锁 / Run 终态(DB reap 恒发生)** | `isDead` 即经**现有单一 choke-point** 判 `run.failed` + 释放锁--**无论 OS 回收成败**(守 run-engine spec、与今日 `reaper.ts` 一致)。**强制序:OS 回收(cgroup.kill / env 扫逐杀)在 chokePoint 事务之外先跑、有界(超时即放弃)、其错误一律 catch 吞掉;chokePoint 无条件执行、释放锁**--OS 回收抛错或超时绝不能挡住 DB reap。跳过/失败的 OS 回收 = OS 子孙残余、但 DB 已干净。 |
| **重启安全(无需 boot 门)** | **两平台均由构造保证**:Linux cgroupfs 每 boot 重建、留存的 `hangar-<run_id>` cgroup 必属本 boot;macOS `run_id` 唯一 UUID、重启后唯一携带旧 tag 的是该 run 孤儿(无假命中)。 |
| **防误杀** | **Linux cgroup:内核跟踪成员,无 PID 复用问题**。**macOS:** env 扫按 `HANGAR_RUN_ID` = run_id 精确匹配--**tag 即身份**(唯一 UUID,无假命中)。**残余:macOS inspect-to-kill 间有极窄 PID 复用误杀窗口**(macOS 无 pidfd、不能 race-free kill;同 launchd 的 pgid 复用)。两平台 OS 回收操作均**可安全重复执行**。DB-reap 侧的并发抢锁行级仲裁仍是 DESIGN §3.6 延后项(不影响 OS 回收侧)。 |
| **掉 env-tag / setsid / 容器逃逸** | **Linux:cgroup 无出口、全抓**(威胁模型之外:delegatee 主动 `write(cgroup.procs)` 自迁移到 sibling cgroup 可逃出 `hangar-<run_id>`--需进程主动迁移,可信 pipeline 不做,**不计残余**)。**macOS:** env 扫抓一切保留 `HANGAR_RUN_ID` 的进程(**含 setsid 逃逸者**--launchd 抓不到的)。**macOS 担保残余 = 任何丢掉 tag 的子孙**:密封沙箱 scrub env(Bazel/Nix、Gradle daemon worker),以及 env 不可读或非 root 无法发信号的 uid-change/SIP 子进程;另加 inspect-to-kill PID 复用窗口(见上行)。**auto-developer 跑密封沙箱构建时这些残余真实**--那类 run 应走 Linux/VM(见 D2)。 |
| **approve 面** | reaper **扫描统一**(按 run_id 一视同仁扫到 approve 侧进程)。`ctx.spawn` 挂在 `RunContext` 上、只在 `runApp` 为 pipeline run 构造;被审批高危动作(`git push`)在独立 `hangar approve` 进程执行(#5),**须自己接上同样的受闸 containment 接线**(cgroup/env-tag)才被 reaper 看见--**非自动,是后续实现的一份显式接线**。`ctx.spawn` 只管 OS 生命周期待遇(容纳/回收),**不绕过** `ctx.propose`:审批列出的副作用仍须走 `ctx.propose` -> OS 层 approve 执行(守 #5)。 |
| **app 自身 SQLite resume** | hangar 只回收 OS 进程树 + Run/锁终态;app 域 SQLite(auto-developer 自己的状态)crash-safe / resume 是 app 职责,hangar 不碰(守 #1/#4)。 |

### D4 - 能力闸 `hangar.run.hard-crash-containment/v1`

- 复用 **#17 (add-run-cancellation) 引入的 `host-capabilities` 机制**(版本化能力集 + `assertCapabilities` fail-closed + doctor 广播;代码已在 #17 实现,规范待 #17 归档)。
- **广播闸 = release-time 纪律,不是运行时门。** `HOST_CAPABILITIES` 是静态常量、`doctor` 逐字广播;**实现变更只有在 fault test CI 全绿后,才可把能力串加进 `HOST_CAPABILITIES`**。**Hangar DB reaping 单独 MUST NOT 满足它。**
- **v1 按平台如实广播(fail-closed 消费者须知):** **Linux(有 cgroup 委派)= provable + 完整;Linux(无委派)与 macOS = best-effort**(env-tag 扫),残余见 D3。**广播取向 = macOS 也广播 `/v1`**,语义为「本平台可达的最强容纳」(mac 上即 best-effort、过 best-effort fault test 即广播)--否则 adapter 在生产 mac-mini 上永远 fail-closed、切不过来。**密封沙箱 scrub-env 工具链**的 tag-drop 残余在 mac 上真实 -> 那类 run 应走 Linux/VM(见 D2)。若日后要区分「provable」与「best-effort」两档,**另立**一个更严的能力串(如 `…-provable/v1`),**不**改 `/v1` 语义。**v1 的 fault test 必须覆盖 pipeline 与 approve 两面**(pipeline 经 `ctx.spawn`;approve 侧 containment 接线**非自动、是后续实现的一份显式工作**,见 D3)--fault test 必双覆盖(见 D5)。
- **消费(部署期,非运行时):** adapter 在**部署期**读真机 `doctor --json` 自比后 fail-closed(#17 C2:模块顶层副作用先于 in-run 断言);能力缺失或仅未知更高版本 -> 精确匹配不命中 -> 关门。
- **部署:** auto-developer cut-over 前 pin 已测的 hangar commit/version。

### D5 - fault test 契约(后续实现变更的验收)

后续实现变更**必须**带 fault test,证明:

1. **pipeline 面:** `ctx.spawn` 起一棵长生命周期树,含**普通-留 tag / setsid-留 tag / scrub-env-丢 tag** -> **SIGKILL daemon** -> 重启 -> reaper 回收 -> 断言:**Linux `cgroup.kill` 全清(三类)**;**macOS env 扫清一切留 tag 者(含 setsid)、scrub-env-丢 tag 者记残余**(记录而非期望覆盖)。
2. **approve 面:** 从 `hangar approve` handler 经受闸 containment 入口起一个 detached 长生命周期子进程 -> SIGKILL approve 进程 / daemon -> 重启 -> 断言 reaper 按 run_id 回收它(两平台)--**与 pipeline 面同等覆盖**(approve 侧接线非自动,故必须显式测)。
3. **无关进程未被杀**(误杀防护:另起一个复用 PID / 同名的无关进程,断言存活)。
4. **DB-reaped 与 OS-child-reaped 分开断言**--禁止用「Run 已判 failed」冒充「OS 子孙已回收」;并断言 **OS 回收步抛错或超时时 chokePoint 仍执行、锁仍释放、run 仍判 `failed`**(DB reap 不被 OS 回收失败挡住)。
5. **幂等 + 有界:** reaper 重复跑不误杀、不崩(`cgroup.kill` / 逐个 `kill` 均可安全重复执行);**OS 回收步有界**(超时即放弃、仍跑 chokePoint,不挂住 DB reap)。
6. **Linux 无委派回退:** 无 cgroup 委派时回退 env-tag(同 macOS)-> 断言 best-effort 回收仍工作(与 macOS 同残余)。
7. 只有以上按平台全绿,doctor 才广播 `hangar.run.hard-crash-containment/v1`。

### D6 - #2 论证(inbox 哪一行用它)

**inbox 一行都不用**--inbox 不 spawn 任何 detached / 长生命周期子进程,根本不触发本能力。故本变更**显式请求一个 #2 例外**(已获项目 owner 批准),并记账其理由与闸门:

1. hard-crash containment 是**通用 OS 层进程生命周期能力**(非域概念),与 multi-trigger / disable 同类--只是其 forcing consumer 不是 inbox。
2. 其唯一 forcing consumer 是 **auto-developer(Phase-2 pilot)**,当前**尚不存在**;故本变更**只出设计、零代码进脊柱**。
3. **受闸**:实现变更须过 fault test 才落地,auto-developer 生产 owner 在此前保持 launchd。
4. **若 auto-developer 最终不切过来,本能力整体不实现**(设计留档即可),不留下无消费者的脊柱代码。

**这是一个显式、可审计的 #2 例外,而非默默过拟合。** #2 的硬约束仍在:没有在场 forcing consumer 前,不得把本能力的实现并入脊柱。

## Risks / Trade-offs

- **[macOS 无 cgroup = 根本 best-effort]** 研究双证:macOS 无内核容器,launchd 亦 best-effort。**缓解:** 如实按平台广播;可证明路径 = Linux VM(升级留档,不在 v1 mac 承诺)。**这是平台天花板、非本方案缺陷。**
- **[macOS 容纳残余(真实)]** 担保残余 = **任何丢掉 `HANGAR_RUN_ID` tag 的子孙**:密封沙箱构建(Bazel/Nix、Gradle daemon worker)**默认 scrub env**--env 扫抓不到;另有 env 不可读或非 root 无法发信号的 uid-change / SIP-hardened 子进程;**另:inspect-to-kill 间极窄 PID 复用误杀窗口**(macOS 无 pidfd)。Linux cgroup 无这些洞(delegatee 主动自迁移 sibling 属威胁模型之外,可信 pipeline 不做)。**缓解:** 如实记残余;那类工具链的 run 走 Linux(cgroup)或 Linux VM(D2/B)。
- **[OS 回收失败不自动重试]** run 经 chokePoint 判终态后,后续 reaper 跳过它 -> OS 回收失败的子孙**残留直到人工兜底**(非「一轮」)。**缓解:** doctor 暴露未清 OS 残余的可观测性;OS 回收步有界(不挂住 DB reap)。
- **[误杀 > 漏杀 的取舍]** 一律「宁漏勿误」:handle/指纹存疑就跳过 OS 回收(DB 仍 reap)。代价 = 偶发残余,doctor 暴露可观测性。
- **[cgroup v2 委派前提(Linux)]** 需 unified 层 + 委派子树(systemd user-slice 或一次性 root chown);不可得则回退 env-tag(同 macOS)。
- **[DB-reap 并发抢锁的行级仲裁]** DESIGN §3.6/ROADMAP Phase 1 延后项--影响 chokePoint 侧(DB reap),与 OS 回收侧(cgroup.kill / env 扫逐杀,均可安全重复执行)无关。

## Migration Plan

1. 本变更(设计)合入:ADR + DESIGN 更新 + 能力闸契约。**无运行时改动。**
2. auto-developer **保持 launchd** 当生产 scheduler owner(硬前置,直到步骤 4 通过)。
3. 后续**单独受闸变更**实现 (d) + fault test;fault test 按平台全绿前 doctor **不**广播能力。
4. fault test 通过 -> **doctor 在该平台广播 `/v1`(mac 上即 best-effort 语义,见 D4)** -> auto-developer pin 已测 hangar version -> cut-over。**macOS 上 best-effort 对留 tag 工具链与 launchd 同档、不丢容纳即可切**(见 D2);密封沙箱工具链或要 provable -> 走 Linux/VM。
5. **回滚:** 能力未广播即 fail-closed,adapter 在副作用前停,自动退回 launchd;无部分迁移的中间危险态。

## Open Questions

(仅存两条真未决:)

- **OQ1(平台天花板,已定位):** macOS 担保残余 = 任何丢掉 `HANGAR_RUN_ID` tag 的子孙 + inspect-to-kill PID 复用窗口(D3/Risks)。**是否咬**取决于 auto-developer 工具链:密封沙箱构建(Bazel/Nix)scrub env 即落入残余。实测真咬 -> 那类 run 走 Linux(cgroup)/Linux VM(D2/B)。
- **OQ2:** fault test 在 CI 里 SIGKILL 真 daemon + 起真树的可移植性(macOS vs Linux runner);`CLONE_INTO_CGROUP` 的 Node shim 在 CI Linux runner 上的稳定性。
