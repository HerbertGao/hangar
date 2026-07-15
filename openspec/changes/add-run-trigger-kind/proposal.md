## Why

`ctx.trigger` 现在只透传触发器 `name`(`executor.ts:109` `trigger: req.triggerName`),而触发**类别**(manual/cron)——调用点其实已知(`cmdRun` 传 `trigger:'manual'`、daemon 传 `trigger:'cron'`)——从不上到 `RunContext`。于是:手动 `hangar run app --trigger daily` 与一个名为 `daily` 的 cron 触发器产出**完全相同**的 `ctx`;unnamed manual 与 unnamed cron 都得到 `ctx.trigger === undefined`。任何要「只有 daemon cron 才是唯一 scheduler owner、manual smoke 不许算数」这类门禁的 pilot(auto-developer 即如此)无法从 `ctx` 区分二者,只能去反推那根混载 name/类别的 `Run.trigger` 列——一条脆弱且现被文档明确禁止假设值域的路径。

## What Changes

- **`RunContext` 新增 host 生成、`--trigger` flag 与 app 均不可伪造的 `triggerKind: 'manual' | 'cron'`**,以及可选 `triggerName?: string`(= 触发器 name;与既有 `trigger` 同值,语义更清晰的新名)。`triggerKind` **只**由 host 在两个 run 创建入口(`cmdRun` / daemon)写死,`--trigger` flag 与 pilot 均无法改它。
- **`ctx.trigger` 保留**(标注 deprecated,= `triggerName`)= 旧 app 只读它的向后兼容分支;**不发破坏性版本**(合验收「旧 app 只读现有 `ctx.trigger` 保持兼容」)。
- **`--trigger <name>` 只设 name、绝不改 kind**:manual 用与某 cron 相同 name 时,`triggerKind` 仍为 `manual`。daemon cron 恒 `triggerKind='cron'`,含 unnamed 触发器。
- **`Run.trigger` 持久化列不动**(继续存 `triggerName ?? kind`,供 trace 归因、可追踪);pipeline 从此读 `triggerKind`/`triggerName` 两个独立字段,**不再从混载列反推来源**。

**范围说明(评审拆分决策):** 本变更**只**加 `triggerKind`/`triggerName` 字段。原稿的**版本化 host 能力集机制(`host-capabilities` + `assertCapabilities` + doctor 广播)已移出本变更**,正经设计(`ctx.capabilities` 真机快照 + 部署期门禁)属于 **#17(add-run-cancellation)**。

**依赖方向:本变更独立可发、不阻塞于 #17。** `triggerKind`/`triggerName` 是 `RunContext` 上**结构性**存在的字段——任何含本变更的 host 都提供,pilot 直接读即可(`ctx.triggerKind !== undefined` 只在「新旧 host 混部」时才用来区分老 host)。#17 的能力集**顺带**收一个 `hangar.run.trigger-kind/v1`,作为 adapter 在部署期声明「本 host 提供该字段」的钩子;但能力集的**真正负载**是 abort-signal/cancelled-terminal 那类**结构存在证不了的行为性保证**——trigger-kind 用不到那套机制,这正是它能从本变更拆出、能力集留 #17 的原因。

## Capabilities

### New Capabilities

(无。)

### Modified Capabilities

- `multi-trigger`: 「触发身份进 run(ctx)」需求——`RunContext` 除既有(deprecated)`trigger` 外,新增 host 生成、不可伪造的 `triggerKind` 与可选 `triggerName`;「具名触发可手动调用」需求——明确 `--trigger` 只设 name、`triggerKind` 恒为 `manual`。

## Impact

- **代码**:`packages/core/src/executor.ts`(`RunContext` 加 `triggerKind`/`triggerName`;`RunRequest.trigger` 收紧为 `triggerKind: 'manual'|'cron'`;`ctx` 构造透传)、`packages/core/src/cli.ts`(`cmdRun` 传 `triggerKind:'manual'`;daemon 的 RunRequest 构造**从 `startDaemon` 内联闭包提取为导出的 `daemonRunOne(db, app, name)`**,传 `triggerKind:'cron'`,使 cron 臂的不可伪造性可单元测)。
- **数据/DB**:零——不加表、不加列,`Run.trigger` 列语义不变(#3)。
- **`Run.trigger` 列消费者(D3「列不动」正为保护它们,已 fan-out 核实)**:`cli.ts` cmdRuns(362/367/383,展示透传)+ **`packages/hangar-view/src/derive.js`** 三处读——`deriveLiveness`(:214,无名 run 靠 `Run.trigger==='cron'`、具名靠 `===name` 判活)、`recentRuns`(:188)、`lastTrigger`(:161→:175)。本变更 `createRun` 落列由 `triggerName ?? trigger ?? 'manual'` 改为 `triggerName ?? triggerKind`,对四组合列值**逐字不变**,故这些消费者**零回归**。注:hangar-view 仍是**混载列消费者**(本变更不消除——acceptance「pipeline 不反推混载列」只对 pipeline 成立;hangar-view 反推是既有、超本变更范围)。
- **契约文档**:`DESIGN.md` §3.5(RunContext 段加 `triggerKind`/`triggerName`,记 immutable/host-generated 决策,#9)、**§3.3(~143)**(列值公式 `triggerName ?? req.trigger ?? 'manual'` → `triggerName ?? req.triggerKind`;并订正同段「现无消费者 switch 它」——hangar-view `deriveLiveness` 实际 switch `=== 'cron'`,与本提案一致)。
- **测试**:`cli.test.ts`(经 `dispatch(['run', app, '--trigger', name])` 断言 manual 边界不可伪造 + manual-用-cron-name-仍-manual 的真碰撞)、对提取的 `daemonRunOne` 直接断言 cron 臂(含 unnamed)、`run-engine.test.ts`(旧 app 只读 `ctx.trigger` 零回归 + runApp 层 threading 测试并注明非不可伪造性证明)。**并修所有因 `RunRequest` 收紧而破的现存构造点**(见 tasks 1.4)。
- **不变量**:未破 #1(零域:`triggerKind` 是 OS 级 run 元数据、非业务名词)/#3(不加表)/#4(不加 app 定义入口)/#6(无网络);#9 随 DESIGN 更新兑现。**#2**:inbox 的 poll 是单个 unnamed 触发器、不区分 manual/cron,**不使用**本字段(诚实回答「inbox 哪一行用它」:一行都没有);但 `triggerKind` 是 **OS 层通用 run 生命周期元数据**(与 `multi-trigger`/`enabled` 同族、零域 #1),首个真实消费者是 auto-developer(issue #16 明确拉动),随其 cutover 兑现——与「多触发」「disable」同一框架(通用脊柱能力、真实 pilot 首用例,非投机)。原稿争议最大的能力集半(评审判为「为未迁 pilot 预建 spine」)已移出 → 本变更现在只是「加一个 OS 元数据字段」,#2 张力大幅降低。

## 非目标

- **不给 inbox 加 trigger-kind 消费**(见上 #2:inbox 一行不用;首消费者 auto-developer,随 cutover 兑现,非预建)。
- **不引入版本化能力集 / `assertCapabilities` / doctor 广播 / `capabilities.ts`**——整套已移到 **#17(add-run-cancellation)**,在那里与 abort-signal/cancelled-terminal 一起、按 `ctx.capabilities` 真机快照 + 部署期门禁正经设计;本变更加的字段由 #17 的 `hangar.run.trigger-kind/v1` attests。
- **不做跨进程 cancel / 不改 `Run.trigger` 持久化列的存法 / 不改 daemon 序列化语义**。
