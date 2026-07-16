## Context

`RunContext`(`executor.ts:21-31`)当前把触发信息表达为单个可选 `trigger?: string`(值 = 触发器 `name`)。触发**类别**在两个调用点已知却被丢弃:`cmdRun`(`cli.ts` ~472)恒传 `trigger:'manual'`、daemon `runOne`(`cli.ts` ~732)恒传 `trigger:'cron'`,二者进 `RunRequest.trigger`(free string),仅用于 `createRun` 落 `Run.trigger` 列(`triggerName ?? trigger ?? 'manual'`),**从不上到 ctx**。因此 `ctx` 无法区分 manual `--trigger daily` 与 cron `daily`,也无法区分 unnamed manual 与 unnamed cron(都 `undefined`)。

约束:脊柱零域(#1)——`triggerKind` 只能是 OS 级枚举(manual/cron),不得携带任何域含义;不加表/库(#3);`app.yaml` 仍是唯一 app 定义入口(#4);改契约先改 DESIGN(#9)。

**范围(评审拆分决策):** 原稿把版本化 host 能力集机制也塞进本变更。对抗评审(Codex 抓到 `assertCapabilities` 默认读 module-local 常量的**假绿**——外部 pilot 自带 `@hangar/core` 会校验自己那份常量;且 #17-round-2 验收要求能力集在 `RunContext` 上而非模块常量)+ #2 治理(能力集为未迁 pilot 预建 spine)→ **能力集整套移到 #17 正经设计**(那里 abort-signal/cancelled-terminal 才是它要证的行为性保证)。本变更只加 `triggerKind`/`triggerName` 字段。

## Goals / Non-Goals

**Goals:**
- `ctx` 暴露 host 生成、`--trigger`/app 不可伪造的 `triggerKind: 'manual'|'cron'` + 可选 `triggerName`。
- manual 与 cron 在 ctx 层可判别(含 unnamed);`--trigger` 只影响 name。
- 旧 app 只读 `ctx.trigger` 零回归。

**Non-Goals:**
- 不引入能力集机制(移 #17)。
- 不做跨进程 cancel、不改 `Run.trigger` 列存法、不改 daemon 序列化/pending 语义。

## Decisions

- **D1 — `triggerKind` 由 host 在 run 创建入口写死,`--trigger`/app 不可伪造。** `RunRequest.trigger: string` 收紧为 `triggerKind: 'manual' | 'cron'`(联合类型)。`cmdRun` **写死** `'manual'`、daemon 的 RunRequest 构造 **写死** `'cron'`;`--trigger <name>` **只**落 `triggerName`。**「不可伪造」的准确范围(评审 C4 收窄):** `--trigger` flag 与 pilot(只收 ctx、不构造 RunRequest)都改不了 kind;`runApp` 虽是导出符号,但其**唯一调用者是 host 入口**(cmdRun / daemon),外部 pilot 经 `run(ctx)` 被调用。故这是「flag/app 不可伪造 + host 入口是唯一 provenance」,**非**「运行时对任意程序化调用者做 provenance 校验」(单用户 BYO、无对抗 app 作者,同 §3.5 carve-out)。备选:让 pilot 从 `Run.trigger` 反推——否决,该列混载 name/类别、DESIGN §3.3 已明令消费者不得假设值域。
- **D2 — 保留 `ctx.trigger`(deprecated)而非发破坏性版本。** `ctx.trigger` 继续 = `triggerName`(旧 app 只读它照常走)。新增 `triggerName` 为语义更清晰的同值字段,`triggerKind` 为新判别字。理由:懒且合验收「旧 app 保持兼容」;鸭子契约新增可选字段,零回归。备选:改 `ctx.trigger` 为 `{kind,name}` 对象——否决,破坏所有现有 pilot 读法。
- **D3 — `Run.trigger` 持久化列不动。** 继续存 `triggerName ?? kind`,供 `hangar runs`/trace 归因。pipeline 改从 `ctx.triggerKind`/`ctx.triggerName` 两独立字段读,**不再反推列**——满足验收「持久化仍可追踪,但 pipeline 不需从混合列反推来源」。列值对四组合**逐字不变**(`triggerName ?? triggerKind` 与旧 `triggerName ?? trigger ?? 'manual'` 同值:unnamed manual→`manual`、`--trigger foo`→`foo`、unnamed cron→`cron`、named cron→name),故 `Run.trigger` 既有消费者(cmdRuns + hangar-view deriveLiveness/recentRuns/lastTrigger)零回归。丢掉 `?? 'manual'` 尾巴安全,因 `triggerKind` 变必填、类型保证表达式不为 `undefined`。备选:拆 `Run.trigger` 为两列——否决,#3 不加列、且无消费者需要。
- **D4 — cron 臂的不可伪造性须可单元测 → 提取 `daemonRunOne`(评审 F2/Blocker-1)。** daemon 的 RunRequest 构造原是 `startDaemon` 内联闭包(`cli.ts` ~721-739),不可从外部断言 `triggerKind:'cron'`——唯一注入点 `makeFireGate.runOne` 在构造点**之上**,测试在那里只会断言注入的 stub(正是要消除的 vacuous-literal)。故提取为**模块级导出** `daemonRunOne(db, app, name)`(建 gateway + 调 runApp),`startDaemon` 经它接线,测试直接对它断言 named/unnamed cron 都得 `'cron'`。manual 臂经 `dispatch(['run', app, '--trigger', name])` 真触发即可,无需提取。备选:只在 runApp 层 threading 测试——否决,证不出「host 写死 cron」不可伪造性。

## Risks / Trade-offs

- **[deprecated `trigger` 长期滞留] → Mitigation:** 注释标 deprecated + 指向 `triggerName`;移除是未来独立破坏性变更,不在本轮。
- **[「不可伪造」是入口纪律非运行时强制] → Mitigation:** `runApp` 唯一调用者是 host 入口(cmdRun/daemon),外部 pilot 不构造 RunRequest。规范措辞已收窄为「flag/app 不可伪造」,不 overclaim 运行时 provenance 校验(同 §3.5 carve-out、单用户 BYO,无对抗 app 作者)。
- **[#2:inbox 零消费] → Mitigation:** 争议最大的能力集半已移出;剩下只是加一个 OS 元数据字段,与「多触发」「disable」同框架(通用脊柱能力、真实 pilot 首用例),issue #16 明确拉动、随 auto-developer cutover 兑现。

## Migration Notes

- `RunRequest.trigger` 收紧为必填 `triggerKind` 是 **breaking**:`RunRequest` 经 `index.ts:11` 公开 re-export,但**无外部构造者**(外部 pilot 用 `run(ctx)`、不调 `runApp`;`apps/` 目录零 RunRequest 构造)。须同批修所有**仓内**构造点(cli 两处 + 11 处测试,见 tasks 1.4),否则 `tsc`/`pnpm build` 红。属仓内破坏、无需版本协商。
