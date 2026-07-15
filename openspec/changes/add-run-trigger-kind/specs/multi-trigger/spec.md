## 修改需求

### 需求:触发身份进 run(ctx)
触发一个 run 时,脊柱 MUST 把该触发器的 `name`(不透明字符串)经 `ctx.trigger` 传给 `run(ctx)`。脊柱 MUST NOT 解释该 name 的域含义(零域知识)。无名触发器(单触发省略 name)MUST 使 `ctx.trigger` 为 `undefined`。`RunContext` 的 `trigger` 字段 MUST 可选(向后兼容:老脊柱不传时 pilot 读到 undefined、走默认路径)。run 的 `trigger` 记录(`Run.trigger` 列)SHOULD 存该 name(供 trace 按触发器归因),缺 name 时回退触发类别(`cron`/`manual`)。

**新增(#16):** `RunContext` MUST 另暴露 host 在 run 创建入口生成、**`--trigger` flag 与 pilot 均不可伪造**的 `triggerKind: 'manual' | 'cron'`,以及可选 `triggerName?: string`(= 触发器 name,与 `trigger` 同值的语义化新名)。`triggerKind` MUST **只**由 host 在两个 run 创建入口写死——manual 入口(`hangar run` → `cmdRun`)恒 `'manual'`、daemon cron 入口恒 `'cron'`(含 unnamed cron 触发器)——**绝不**来自 `--trigger` flag 或 pilot。**不可伪造的准确范围:** `--trigger` flag 改不了 kind,pilot 只收 `ctx`(不构造 `RunRequest`)也改不了;`runApp` 虽是导出符号,但其唯一调用者是这两个 host 入口。故本需求是「flag/app 不可伪造 + host 入口是唯一 provenance」,**不**声称对任意程序化 `runApp` 调用者做运行时 provenance 校验(单用户 BYO、无对抗 app 作者,同 §3.5 carve-out)。既有 `ctx.trigger` 字段 MUST 保留(标注 deprecated,= `triggerName`),使只读它的旧 pilot 零回归。pilot MUST 能只凭 `ctx`(不反推 `Run.trigger` 列)区分 manual 与 cron。

#### 场景:具名触发分派
- **当** 名为 `digest` 的触发器 fire
- **那么** `run(ctx)` 收到 `ctx.trigger === 'digest'`,app 据此分派到 digest 行为

#### 场景:无名触发走默认
- **当** 单个无名触发器 fire(heartbeat/现 inbox poll)
- **那么** `ctx.trigger === undefined`,run() 走默认(现有)行为、零回归

#### 场景:cron 触发暴露 triggerKind 为 cron
- **当** daemon 的 cron 触发器 fire(具名或无名)
- **那么** `ctx.triggerKind === 'cron'`;具名时 `ctx.triggerName` = 该 name、无名时 `undefined`

#### 场景:manual 触发暴露 triggerKind 为 manual
- **当** `hangar run app`(可带 `--trigger foo`)手动触发
- **那么** `ctx.triggerKind === 'manual'`(即便带 `--trigger`);`ctx.triggerName` = `foo` 或无 flag 时 `undefined`

#### 场景:manual 用与 cron 相同 name 时 kind 仍为 manual
- **当** `hangar run app --trigger daily`,而该 app 另有一个名为 `daily` 的 cron 触发器
- **那么** 本次 manual run 的 `ctx.triggerKind` MUST 为 `'manual'`(不因同名而被当作 cron);`ctx.triggerName === 'daily'`

#### 场景:旧 app 只读 ctx.trigger 仍工作
- **当** 一个只读 `ctx.trigger`、不认识 `triggerKind` 的旧 pilot 被触发
- **那么** `ctx.trigger` MUST 仍 = 触发器 name(或无名时 `undefined`),行为与本变更前一致

### 需求:具名触发可手动调用
`hangar run <app>` SHALL 接受可选 `--trigger <name>` 标志;给定时 MUST 把该 name 经 `ctx.trigger`(及 `ctx.triggerName`)传入,使任一具名触发器的行为可手动触发/重放。省略 `--trigger` 时 `ctx.trigger`/`ctx.triggerName` MUST 为 `undefined`(走默认行为,向后兼容)。`--trigger` MUST **只**设置 name,**MUST NOT** 改变 `ctx.triggerKind`——经 `hangar run` 触发的 run,其 `triggerKind` 恒为 `'manual'`,与 `--trigger` 是否给出、给的什么值无关。

#### 场景:手动触发 digest
- **当** `hangar run inbox --trigger digest`
- **那么** `run(ctx)` 收到 `ctx.trigger==='digest'`、跑 digest 行为(可手动验证/补发一次摘要);且 `ctx.triggerKind === 'manual'`

#### 场景:--trigger 不改 kind
- **当** 以任意 `--trigger <name>` 值经 `hangar run` 触发
- **那么** `ctx.triggerKind` MUST 恒为 `'manual'`(flag 只落 name,不可伪造 kind)
