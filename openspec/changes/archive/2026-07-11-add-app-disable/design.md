## Context

hangar-view(Phase 1.5)首次把办公室推到生产后暴露:`heartbeat` 这个 phase-0 骨架的**参考/DoD 夹具 app** 带每天 09:00 的 cron,天天在生产 park `demo.risky` → 办公室常显「举手·已逾期」假警报。它同时是 `dod.test.ts §8.1` 端到端跑的**真 app**(不可删)+ 6 份规范的示例。

现状:hangar 没有「禁用某 app 但保留它」的能力。registry 每次重扫 `HANGAR_APPS/*/app.yaml`,凡有合法 app.yaml 的目录一律注册、daemon 一律按其 triggers 调度、hangar-view 一律上墙(spec 明写「MUST NOT 静默省略已注册 app」)。

**关键前情**:`DESIGN.md`「App 表」段已预留——「`spec_hash/enabled` 等列 Phase 0 无消费者,**有需求(漂移检测/启停)再加**」。本变更即该「启停」需求兑现。

## Goals / Non-Goals

**Goals:**
- 一等公民的「禁用 app」:disabled app **不自动调度、不上墙**,但**仍可手动 `hangar run`**(operator/DoD 夹具照跑)。
- 一个 committed flag 同时满足「CI 里可测 + 生产里隐身」,让 `heartbeat` 提交 `enabled:false` 后 DoD §8.1 绿、生产办公室干净。
- 退役骨架/测试 app(及将来退役 pilot)**而不删代码/夹具/规范**。

**Non-Goals:**
- 不做**运行时命令式开关**(`hangar disable/enable <app>` 写 DB)—— v1 用 app.yaml 声明式即可,ops 真需要免改文件的运行时切换再议(见 Open Questions)。
- 不做**分组/批量/定时启停**、不做**权限化的谁能禁用**。
- 不改 4 表 / 不加库(disabled 是 app 定义的一部分,不进状态库)。

## Decisions

### D1 — `enabled` 落 `app.yaml`(FS 权威),不落 App 表列

`app.yaml` 加可选 `enabled: boolean`(默认 `true`),registry 的 `SpecSchema` 解析、透传到 `Spec.enabled`。

- **为何不用 App 表列**(DESIGN §「App 表」曾把 `enabled` 设想成 App 表列):App 表是「`apps/*/` 扫描的缓存、非权威、每次重扫 FS」。把开关放非权威缓存里 = 一次 rescan 就与 FS 漂移、或需要额外的写路径去维护它。`app.yaml` 是**唯一 app 定义入口(#4)+ FS 即权威**,`enabled` 属「这个 app 是什么」的声明,天然归此。**故本变更取代 DESIGN §135 的「App 表 `enabled` 列」设想,改为 app.yaml 声明式字段;DESIGN 相应更新(#9)。**
- **副效**:声明式 + 版本可控 —— `heartbeat` 的 disabled 随仓走、`git pull` 不会冲掉(命令式 DB 开关做不到);零 DB 改动(#3 更干净)。
- 备选(命令式 `hangar disable <app>` + App 表列)留待 ops 有「免改文件运行时切换」硬需求再加,与本决策不冲突。

### D2 — disabled 语义 = 不调度 + 不上墙 + **手动 run 仍放行**

| 面 | disabled 行为 | 落点 |
|---|---|---|
| daemon 调度 | **跳过**其 cron,不自动 park | daemon 建 `cron.schedule` 时过滤 `enabled===false` |
| hangar-view 办公室 | **不上墙**(显式排除、非静默省略) | `deriveOffice` 过滤 + `doctor` 仍如实报 `enabled:false` |
| 手动 `hangar run <app>` | **照跑** | `cmdRun` 现走 `loadApps().apps.find` 且**不校验 enabled** —— 天然放行,无需改 |
| registry 加载 | **仍加载**(标记 enabled:false) | disabled ≠ 未注册;doctor/run 仍认得它 |

- **为何手动 run 仍放行**(而非「fully off」):这是让**一个 committed flag 同时服务 CI 与生产**的关键。DoD §8.1 用 `dispatch(['run','heartbeat'])`(手动),若 disabled 连手动都挡,提交 `enabled:false` 会挂 CI;放行则 CI 绿、生产 daemon 不 park、办公室不上墙,三赢。语义可一句话说清:「disabled = 不自动上班、不在花名册露面,但你能手动叫它跑一次」。
- **已验证的部分**:手动 run 链本身安全——`cmdRun`(`cli.ts` ~444)与审批入口 `openForDecision`(~501,`cmdApprove` 从 ~517 共用)无 `enabled` 门、disabled app 仍在 `loadApps().apps`,故 DoD §8.1 的 run→approve→marker 路径不受影响;core 无 scheduler 单测、无测试依赖 heartbeat 的 cron **真触发**(registry.test 用内联 `triggers:[]` 夹具)。
- **但要改断言(评审纠正)**:`doctor.checks.apps[]` 增 `enabled` 会破 `dod.test.ts §8.1`(~81)与 `cli.test.ts`(~93)两处整对象 `deepEqual`(与 heartbeat 值无关,纯因多了一个 key)。故「提交 enabled:false 不挂任何测试」**不成立**——须同步改这两处断言(见 Migration Plan 步骤 6)。§8.1 是**硬红**(deepEqual 失败),**不是**静默假绿(run 路径仍真跑)。
- **仅对 valid app 生效**:`enabled` 只在 `app.yaml` 整体通过 zod 时才解析,故 `spec_invalid` 的坏 app.yaml **无法**用此旗禁言(仍呈「配置坏了」⚠️)——disable 是 valid-app 的生命周期开关,不是压制注册错误的手段。

### D3 — doctor 如实报 `enabled`,view 负责过滤(而非 registry 直接丢弃 disabled)

`doctor.checks.apps[]` 每项增 `enabled`;hangar-view `deriveOffice` 据此**显式排除**。

- **为何不在 registry/doctor 层直接不返回 disabled**:doctor 是环境**如实自检**,一个 disabled app 客观存在、该被看见(`hangar doctor --json` 里能查到它 disabled);办公室的「不上墙」是**呈现层的显式选择**。这样既满足用户「不出现在前端」,又不破 hangar-view spec「MUST NOT 静默省略已注册 app」的精神——排除是**有据可查的显式例外**,不是数据凭空消失。

### D4 — 默认 `true`,向后兼容

`enabled` 缺省 = `true`。现有 app(inbox 及所有无此字段的 app.yaml)行为**零变化**。

## Risks / Trade-offs

- **[提交 `enabled:false` 会不会连 CI 也禁了 heartbeat]** → 手动-run-放行语义化解 §8.1 的 run 路径;但 `checks.apps[]` 加 `enabled` 会破 `dod.test.ts`/`cli.test.ts` 两处 `deepEqual`(F2)——**须同步改断言**,不是零改(见 Migration Plan 6)。改后 §8.1 仍真跑 run→approve→marker。
- **[disabled 但可手动 run = 反直觉]** → 属**有意设计**(夹具/退役 app 仍可按需验证);SKILL/spec 写清语义,避免误读成「disabled 就完全动不了」。
- **[view 隐藏后 operator 找不到「它去哪了」]** → `hangar doctor --json` 仍列出它 + `enabled:false`;办公室 v1 直接排除(文档披露);将来要「折叠的 disabled 抽屉」再加(Open Questions)。
- **[#2 硬约束:inbox 不直接用 disable]** → 见下「不变量论证」。

### 不变量 #2 论证(inbox-uses-it-or-out)

硬约束问「inbox-pilot 哪一行用它?」——disable **不在 inbox 的 pipeline 里被调用**。但:
1. 它是 **OS 层 app 生命周期管理**(与已有 `registry`/`doctor`/`status`/多触发调度**同族**),不是域能力(#1 不破:零 `email`/域名词)。
2. **DESIGN 早预留**:「App 表 ... `enabled` 等列 ... 有需求(**启停**)再加」——本变更是设计**已预见**的需求兑现,非事后过拟合。
3. **同「多触发」先例**:DESIGN 明载「多触发 = 通用脊柱能力,inbox poll+digest 是**首用例**、非过拟合 #2」。disable 同框架:**通用退役/启停能力,heartbeat 是首用例**。
4. 反面检验:若不加,替代只有「删 DoD 夹具 + 改 6 规范」或「动生产 apps 根 / 手改被 pull 冲掉的 app.yaml」——都更差。

结论:接受为 OS 生命周期能力,DESIGN 显式 ratify(把 §135 的「`enabled` 列」落成 app.yaml 声明式字段 + 记「首用例 heartbeat」)。

### D5 — disabled 的调度/派生须**显式 guard**(评审纠正,早稿等价被证伪)

早稿设想把 `enabled:false` **等价于「无可调度触发器」**、靠 `deriveBlocked` 对空周期已返回 `false` 一处覆盖三点。**评审证伪**:disabled app 的 `spec.triggers` **仍非空**(禁用不清空 triggers),`deriveBlocked` 也**不读 `enabled`**——heartbeat 的 daily cron 非空,其旧 parked run 仍会派生 `blocked=true`。且 `daemonTasks` 与 `deriveBlocked` **不共享代码**。故没有免费等价,正确做法是**三处各自显式 guard**(共享的是同一条 `enabled !== false` 判据,不是一段代码):
- `daemonTasks`(cli.ts ~588):`filter(a => a.spec.enabled !== false)` 不排期;
- doctor blocked 循环(cli.ts ~257)+ `cmdStatus`(cli.ts ~318):对 disabled **显式**令 `blocked=false`(`if (a.spec.enabled === false) → blocked=false`)。

disabled app **仍须列在** status/doctor(不 delist,见 D3),故 guard 只作用于**调度馈入 + blocked 派生**,不作用于「是否列出」。

## Migration Plan

1. **registry**(`registry.ts`):`SpecSchema` 加 `enabled: z.boolean().optional().default(true)`;经 `Spec`(`z.infer<typeof SpecSchema>`)→ `LoadedApp.spec.enabled` 自然透传;`DoctorReport`(`cli.ts` 的 `checks.apps[]` 项类型)加 `enabled: boolean`。
2. **daemon 调度**(`cli.ts` `daemonTasks` ~588):`load.apps` 馈入 `cron.schedule` 前 `filter(a => a.spec.enabled !== false)`,disabled app 不排期。
3. **blocked 派生跳过 disabled**(注意:**不在 daemon,daemon 无 blocked 派生**):两处 `deriveBlocked` 调用点——doctor 循环(`cli.ts` ~257)与 `cmdStatus`(`cli.ts` ~318)——须对 `enabled:false` 的 app **显式**令 `blocked=false`(`deriveBlocked` 不读 enabled、disabled 仍有非空 triggers,故**不能**依赖自动等价,见 D5)。二者都**仍列出**该 app,只是 `blocked` 恒 false。
4. **doctor 上报**(`cli.ts` ~231):`checks.apps[]` 每项增 `enabled`(未写字段的 app→`true`;**注册失败分支 ~236 无解析 spec → 省略 `enabled`**,view 缺字段视作 `true`)。注意 `enabled` 落 `checks.apps[]` 项,disabled app **不进** `checks.blocked`(那是独立的 app-id 列表)。
5. **hangar-view**:①`derive.js` `deriveOffice`(~123):**broken 检查在先**——`spec/pipeline != ok` 仍呈「配置坏了」⚠️;**仅对 `spec=ok ∧ pipeline=ok`** 的 app 施加 `enabled === false` 排除(**broken 优先于 disabled**:坏 app 不能靠禁用藏起来,与「CLI 取数失败」需求一致;缺 `enabled` 视作 `true`);②`server.js` `loadAppSpecs`(~68)读出 `enabled`,`mostFreqTrigger`(~103)/beacon 选择**跳过** disabled(F1:否则禁用最频繁 cron app 会毒化顶层 liveness);③`buildState`(~155)per-app runs 取数循环跳过 disabled(省无谓子进程)。
6. **测试同步**(**非「确认仍绿」而是必改断言**):`doctor.checks.apps[]` 加 `enabled` 会破两处整对象 `deepEqual`——`dod.test.ts` §8.1(~81-84,heartbeat 项)与 `cli.test.ts`(~93-96,`good` 项),**与 heartbeat 是否 disabled 无关**。须把两断言改为含 `enabled`(heartbeat→`false`、`good`→`true`)。另加自检:`registry.test`(默认/显式/非布尔)、daemon 跳过、blocked 跳过、`derive.test`(disabled 不上墙 + 缺字段照常上墙 + 禁用最频繁 cron 不误报停摆)、`loadApps()` 仍含 disabled app(守 D5 只作用调度/派生)。
7. **heartbeat**(`apps/heartbeat/app.yaml`):加 `enabled: false`。
8. **契约同步**:`DESIGN.md` 更新 App 表段(§135「`enabled` 列」→ app.yaml 声明式字段)+ app.yaml 段(§3.2),记 disable 决策、#2 首用例、手动-run-放行语义;**`SKILL.md`(控制面契约 SOT)** `doctor` 返回示例的 `checks.apps[]` 项加 `enabled`(+ 注册失败省略、缺字段视作 `true` 一行)——CLAUDE.md 定 SKILL.md 为控制面契约,不同步则契约卡与实现漂移。
9. **部署**:`pnpm --filter @hangar/core build`(registry+daemon+doctor 改了)→ ts.mac-mini pull+rebuild;view 无需改依赖。**回滚** = 撤 `enabled` 消费点 + 移除 heartbeat 的 `enabled:false` + 还原两处 `deepEqual` + 还原 DESIGN/SKILL 的契约段。

## Open Questions

- 是否补命令式 `hangar disable/enable <app>`(写 App 表列)给 ops 免改文件切换?**v1 不做**,app.yaml 声明式够用;有硬需求再开新变更。
- 办公室要不要给 disabled app 一个「折叠抽屉」而非全隐?**v1 全隐**,按需再加。
