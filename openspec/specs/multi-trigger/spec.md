# multi-trigger 规范

## 目的
脊柱级「一个 app 多个具名触发、各分派到不同行为」的通用能力:trigger schema(`type` 判别字 + `name` + `string|string[]` schedule + 合法性校验)、`ctx.trigger` 不透明 name 路由(app 内 switch、脊柱零域 #1)、daemon 单活跃-run 下的 per-app 序列化+去重(park/跨进程降级 skip)。为未来非-cron 触发形式留 schema 形状、不建机制(#6)。
## 需求
### 需求:多个具名触发器
一个 app SHALL 可在 `app.yaml.triggers` 声明多个触发器,每个触发器 `{ type: 'cron', name?: string, schedule: string | string[], timezone?: string }`。`type` 是判别字(v0 仅 `'cron'`)。`schedule` MUST 接受单条非空 cron 字符串或非空 cron 字符串数组(数组表示同一触发器在多个时刻触发);每条 schedule 字符串 MUST 为合法 cron 表达式,否则该 app SHALL 判 `spec_invalid`、不注册(避免非法 cron 在 daemon 注册时同步抛、崩掉整个进程)。`config` 与 `permissions` MUST 仍为 app 级,触发器 MUST NOT 携带自己的 config/permissions/executor。

#### 场景:单条 schedule
- **WHEN** 触发器 `schedule` 是一个字符串
- **THEN** daemon 为它注册一个 cron 任务

#### 场景:数组 schedule 展开
- **WHEN** 触发器 `schedule` 是 `["0 6 * * *","30 12 * * *","0 19 * * *"]`
- **THEN** daemon 为每条 cron 注册一个任务,且**都携带该触发器的 `name`**(都分派到同一行为);数组内重复 cron 串去重、不重复注册

#### 场景:非法 cron 拒绝
- **WHEN** 某触发器 `schedule` 含空串或非法 cron 表达式(如 `"30 12 * *"`)
- **THEN** 该 app 判 `spec_invalid`、doctor 报错、不注册,daemon 不受影响继续跑其它 app

### 需求:多触发器时 name 必填且唯一
当一个 app 的 `triggers` **条目数 > 1** 时,每个触发器 MUST 有非空 `name`,**且同 app 内各 `name` MUST 互不重复**;否则该 app SHALL 判为 `spec_invalid`、不注册。触发器只有一条时 `name` MAY 省略。判定按**触发器条目数**,不按数组 schedule 展开后的任务数。

#### 场景:多触发缺 name 拒绝
- **WHEN** 一个 app 有 2 个触发器、其中一个无 `name`
- **THEN** 该 app 判 `spec_invalid`、doctor 报错、不注册

#### 场景:重名触发拒绝
- **WHEN** 一个 app 有 2 个触发器、`name` 相同
- **THEN** 该 app 判 `spec_invalid`、不注册(name 是触发身份,重名会使 `ctx.trigger`/pending 归因塌陷)

#### 场景:单触发省 name 合法
- **WHEN** 一个 app 只有 1 个触发器且无 `name`(如 heartbeat)
- **THEN** 该 app 合法注册,行为与现状一致

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

### 需求:同 app 多触发 fire 本进程内序列化
每 app 仍 SHALL 至多一个活跃 run(不放宽单活跃-run 锁)。当本 daemon 正在跑某 app 时,该 app 的新触发 fire MUST 记入 pending(按 `app + trigger name` 去重、每触发器至多一个 pending,封上界)而不丢弃;活跃 run 达**终态**后 MUST 按插入序 drain 下一个 pending。drain MUST 复用同一 fire 守卫、按 DB 活跃态判定:若 run 已 resolve 但 **park 成非终态**(`waiting_human`,仍持 active-lock),drain 落 skip+log、MUST NOT 盲目 `createRun`(会撞 `already_running` 丢掉 pending)。当活跃 run 属于**别的进程**(跨进程持锁)时,本次 fire MAY skip + log。序列化保证**限于本进程内、`run()` 自限时、非 park、非跨进程、非崩溃**;park/跨进程/崩溃下降级为 skip+log 或靠下一周期/DB 自愈(`pending` 是易失调度提示、非持久真相,不进 4 表)。

#### 场景:digest 与 poll 同刻 fire
- **WHEN** `12:30` 时 digest 触发与 `*/3` poll 触发同刻 fire,poll 先取得活跃-run
- **THEN** digest fire 记 pending;poll run 达终态后 digest 立即 drain 执行,digest **不丢**

#### 场景:活跃 run park 时 fire 降级
- **WHEN** 某 app 的 run 已 propose→PARK(`waiting_human`、仍持 active-lock),期间该 app 另一触发 fire(或已有 pending 待 drain)
- **THEN** 该 fire/drain skip+log(与 `blocked` 一致),不盲跑撞 `already_running`;run 达终态后方恢复调度

#### 场景:pending 去重封上界
- **WHEN** 某 app 正跑时,同一触发器连续 fire 多次
- **THEN** 至多保留一个该触发器的 pending(不无限堆积)

### 需求:具名触发可手动调用
`hangar run <app>` SHALL 接受可选 `--trigger <name>` 标志;给定时 MUST 把该 name 经 `ctx.trigger`(及 `ctx.triggerName`)传入,使任一具名触发器的行为可手动触发/重放。省略 `--trigger` 时 `ctx.trigger`/`ctx.triggerName` MUST 为 `undefined`(走默认行为,向后兼容)。`--trigger` MUST **只**设置 name,**MUST NOT** 改变 `ctx.triggerKind`——经 `hangar run` 触发的 run,其 `triggerKind` 恒为 `'manual'`,与 `--trigger` 是否给出、给的什么值无关。

#### 场景:手动触发 digest
- **当** `hangar run inbox --trigger digest`
- **那么** `run(ctx)` 收到 `ctx.trigger==='digest'`、跑 digest 行为(可手动验证/补发一次摘要);且 `ctx.triggerKind === 'manual'`

#### 场景:--trigger 不改 kind
- **当** 以任意 `--trigger <name>` 值经 `hangar run` 触发
- **那么** `ctx.triggerKind` MUST 恒为 `'manual'`(flag 只落 name,不可伪造 kind)

### 需求:为未来触发形式留扩展位、不建机制
触发器 schema 的 `type` MUST 为判别字,使未来非-cron 触发形式(webhook/manual/event)可作为新的 `type` 臂加入;文档 SHOULD 点名这些未来形式受 v0「无 HTTP/IPC」约束、留待后续阶段。本变更 MUST NOT 实现任何非-cron 触发机制。

#### 场景:v0 仅 cron
- **WHEN** 触发器 `type` 非 `'cron'`
- **THEN** schema 拒绝(v0 仅实现 cron)

