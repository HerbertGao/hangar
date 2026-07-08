## Why

`add-inbox-migration` 删 `main.ts` 时,连带删掉了 `startDigestSchedulers` 的启动点——**每日邮件摘要**(`DIGEST_TIMES=06:00/12:30/19:00`)自 cutover 后**停发**;`buildDigest`/`notifyDigest`/`markDigested` 域码尚在,但成孤儿(在、有测试、永不执行)。

根因是 hangar 的 pilot 模型只有单入口 `run(ctx)`,由 app.yaml **单 cron** 触发——一个 pilot **没法「多种触发方式各干不同事」**(poll 每 3 分钟 classify→notify vs digest 每日定点汇总)。`app.yaml.triggers` 虽已是数组、`daemonTasks` 也已 flat-map 全部触发调度,但 (a) **触发身份没进 `run(ctx)`**(ctx 只有 input/config/logger/emit/propose,run 分不清哪个 trigger 触发)、(b) **每 app 单活跃-run**,多 trigger 同刻 fire 会撞 `idx_run_active_lock`。

这是**通用脊柱能力**(用户明确:未来会有「同一 agent 多种触发方式干不同事」,要提前把 hangar 完善成能容纳、且后续开发者好理解),不是给 inbox 特化。inbox 的 poll+digest 是第一个真实用例,同时修复迁移丢的摘要。

## What Changes

**hangar 脊柱(通用多触发能力):**
- **Trigger schema**:`CronTrigger = { type: 'cron', name?: string, schedule: string | string[], timezone? }`。`type` 是判别字(现仅 `'cron'`;注释点名未来 webhook/manual/event → Phase 3、受 #6 门控,**现在不建机制**);`schedule` 接受**单条或数组**(同一 trigger 多个 cron 时刻)、每条须为**合法 cron**(非法 → `spec_invalid`,避免注册时崩 daemon);`name` 可选,但 **app 有 >1 trigger 条目时 schema 强制每个必须有 name 且互不重复**(否则 `spec_invalid`);config/permissions 仍 **app 级**。
- **路由**:脊柱把触发的 `name`(**不透明字符串**,脊柱不认识 poll/digest,守 #1)塞进 `ctx.trigger`;`run(ctx)` **单入口**、app 内 `switch(ctx.trigger)` 分派。单个无名 trigger → `ctx.trigger=undefined` → 默认(**heartbeat/现 inbox 零改动**)。
- **ctx 契约**:`RunContext` 加 `trigger?: string`(**可选**、向后兼容;pilot 本地鸭子契约加可选字段、fail-loud 不断言它)。`Run.trigger` 列存 name 供 trace(复用现有列,**不加表**,守 #3;该列混载 name 与类别 `cron`/`manual`,消费者不得假设值域仅 `{cron,manual}`)。`hangar run <app> [--trigger <name>]` 加可选 flag,让具名触发行为(如 digest)可手动触发/重放。
- **daemon 序列化**:把「`hasActiveRun` 就 skip」换成**本 daemon 内序列化 + 去重**——per-app `inFlight` set + `pending`(按 app+trigger name 去重、每 trigger 至多 1 pending、封上界;易失、非持久真相);跨进程持锁 **或本 daemon run 已 park** → skip+log(接受降级);drain 复用 fire 守卫按 DB 活跃态判定(park 未终态不盲跑撞 `already_running`)。**本进程内不丢 digest、保单活跃-run 不变量、堆积有界**(park/跨进程/崩溃降级 skip+log 或自愈)。`daemonTasks` 展开数组 schedule 成多任务(去重同串)、都带同 name;overdue 检测对数组取每条周期最小值。

**inbox pilot(恢复摘要、作为多触发首用例):**
- `app.yaml` 两条 trigger:`{name: poll, "*/3 * * * *"}` + `{name: digest, ["0 6 * * *","30 12 * * *","0 19 * * *"]}`(Asia/Shanghai)。
- `run(ctx)` 按 `ctx.trigger` 分派:`'digest'` → 复用 `buildDigest → 逐段 notifyDigest → markDigested` 编排;否则 → 现有 poll 逻辑。
- `DIGEST_TIMES` env **退役**、`digestScheduler.ts` 的 cron/解析部分不再用(域码 buildDigest/notifyDigest/markDigested 复用)。

## Capabilities

### New Capabilities
- `multi-trigger`: 脊柱级「一个 app 多个具名触发、各分派到不同行为」能力——trigger schema(type 判别 + name + `string|string[]` schedule + name-required-when-multiple 校验)、`ctx.trigger` 不透明 name 路由(app 内 switch,脊柱零域)、daemon 单活跃-run 下的 per-app 序列化+去重。为未来非-cron 触发形式(webhook/manual/event)留 schema 形状 + 注释、不建机制(#6)。

### Modified Capabilities
- `inbox-app`: 新增 digest 触发 + `run(ctx)` 按 `ctx.trigger` 分派(poll vs digest);复用既存 buildDigest/notifyDigest/markDigested 域码恢复每日摘要;`DIGEST_TIMES` env 退役、摘要时刻移到 app.yaml。（承接 `add-inbox-migration` 的 inbox-app 能力。）

## Impact

- **`@hangar/core`**:`registry.ts`(CronTrigger schema + name 校验)、`cli.ts`(`daemonTasks` 展开数组 + name、daemon 序列化替换 skip、overdue min)、`executor.ts`(`ctx.trigger` + Run.trigger 存 name);`DESIGN.md` 多触发契约(#9 先改)。self-check:schema 校验、序列化去重/drain、ctx.trigger 传递。
- **inbox-pilot**:`pipeline.ts`(run 分派 + digest 接线)、`app.yaml`(两触发)、本地 `RunContext` type 加 `trigger`、退役 `DIGEST_TIMES`/`digestScheduler` cron。self-check:digest 分派走 buildDigest→notifyDigest→markDigested,poll 分派走现有逻辑。
- **部署**:rebuild core + 更新 pilot(git pull + build)+ 重启 launchd daemon;`.env` 可留 `DIGEST_TIMES`(退役、不再读)。heartbeat 与现 inbox 单触发路径**零回归**(ctx.trigger undefined → 默认)。
- **不在本变更**:非-cron 触发机制(webhook/event,Phase 3、#6);approval 相关(Phase 2)。
