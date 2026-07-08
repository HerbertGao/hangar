## 新增需求

### 需求:每日摘要作为 digest 触发器
inbox app SHALL 声明两个触发器:`name: poll`(`*/3 * * * *`,现有 fetch→classify→notify 每轮循环)与 `name: digest`(数组 schedule,每日定点,汇总当日 P1/P2/P3 摘要)。`run(ctx)` MUST 按 `ctx.trigger` 分派:`'digest'` → 摘要流程(`buildDigest → 逐段 notifyDigest → markDigested`),`'poll'` 或 `undefined` → 现有 poll 流程,**其余未知 name → throw**(拼错/漏配触发器时响亮失败,不静默走 poll)。digest 触发器的时刻由 `app.yaml` 的 cron 数组给出(默认 `["0 6 * * *","30 12 * * *","0 19 * * *"]`,Asia/Shanghai)。摘要审计 SHALL 经 `ctx.emit`(`digest.sent`/`digest.empty`/`digest.failed`)。

#### 场景:digest 触发发摘要
- **WHEN** digest 触发器到点 fire,当日有未摘要的 P1/P2/P3
- **THEN** `run(ctx)`(`ctx.trigger==='digest'`)构建摘要、逐段推送、发成功即 `markDigested`,已 mark 的下轮不重发

#### 场景:未知 trigger 响亮失败
- **WHEN** `ctx.trigger` 是既非 `undefined` 又非 `poll`/`digest` 的值(配置拼错)
- **THEN** `run(ctx)` throw(不静默走 poll),run 记 failed 供 trace 发现

#### 场景:摘要为空不推
- **WHEN** digest 触发 fire 但无 P1/P2 且 P3 计数为 0
- **THEN** `buildDigest` 返回 null,记 digest-empty、不推送

#### 场景:poll 触发不受影响
- **WHEN** poll 触发器 fire(`ctx.trigger==='poll'`)
- **THEN** 走现有 fetch→classify→executeActions→markProcessed,不触发摘要

### 需求:DIGEST_TIMES 环境变量退役
摘要调度 MUST 由 `app.yaml` 的 digest 触发器 cron 提供,`DIGEST_TIMES` 环境变量与 `digestScheduler` 的 node-cron/时刻解析逻辑 SHALL 退役、不再驱动调度。`configSchema` 的 `DIGEST_TIMES` 字段 SHOULD **保留但标记退役(不再读)**,而非删除,以免既有 `.env` 触发 config 严格校验报错。摘要**内容组装**域码(`buildDigest`/`notifyDigest`/`markDigested`/一轮编排)SHALL 复用、不删。

#### 场景:忽略 DIGEST_TIMES
- **WHEN** `.env` 仍设 `DIGEST_TIMES`
- **THEN** 不影响调度(以 app.yaml digest 触发器 cron 为准)、不报错
