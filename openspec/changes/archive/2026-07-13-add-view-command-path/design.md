## Context

hangar-view 现为**只读**监控前端(经 CLI `--json` 取数 + 只读 `app.yaml`,Cloudflare Access 门后,单用户)。inbox 每天 digest 推荐处置(降噪),但处置要 SSH 改 `rules.yaml`。本变更给 view 加**第一条写路径**,让用户用自然语言下达命令、确认后由 pilot 应用。

完整讨论、被否方案与不变量核对见 `docs/proposals/control-plane-channels.md`(决策记录)。本设计只讲本 seed 的「怎么做」。约束:hangar core 零改动;守不变量 #1(脊柱零域)、#5(审批只在 OS 层)、#6(脊柱内无 HTTP/IPC/MQ)、#8(单一切点)。

## Goals / Non-Goals

**Goals:**
- 不 SSH,在网页上用 NL 把降噪决定传达给 inbox,**确认后**应用。
- hangar-view 长出一条**通用形状**的命令写路径(白名单 `(pilot,trigger)` + 两阶段 confirm),契约稳定,未来第二张脸(Telegram)复用。
- core 零改;view 仍只作 CLI 消费者。

**Non-Goals:**
- typed intent 注册表 / `app.yaml` `intents:` 声明块(v1 白名单硬编码)。
- 从页面 approve/reject 审批处置(仍走 CLI)。
- Telegram 双向入站、通知集中(apprise)、apprise.js——各自独立、无依赖。
- inbox 侧 NL 解析与 overlay 写实现(在 inbox 外部 repo)。

## Decisions

### D-a:两阶段、两个 trigger(interpret 干跑 → 确认 → apply 写),而非单 trigger
- **选择:** `interpret-feedback`(input 原始 NL → emit `interpretation.proposed`,**无写**)与 `apply-feedback`(input 确认后的 `{add}` → 写 + emit `feedback.applied`)两个 trigger。
- **为什么:** confirm-before-apply(用户决定②)要求「先看解析、再落地」。拆成两个单一职责 trigger 后,**interpret 天然无副作用**——你不确认,系统零变化,误解析不可能写坏;apply 只吃**结构化**结果(非原始 NL),不重复解析、不漂移。
- **替代(否):** 单 trigger + `dry_run` 标志/双输入形状——把「读」和「写」揉进一个入口,更易出「解析即写」的错。

### D-b:两次快 run,不 park 跨确认
- **选择:** interpret 与 apply 各是一次**快进快出**的 run,中间的人类确认发生在**两次 run 之间**,不 park。
- **为什么:** park 成 `waiting_human` 的 run **仍持 app 锁**,daemon 后续 poll 全 skip(DESIGN §3.4)。若 park 等确认,你思考几分钟就锁死 inbox 轮询几分钟。两次快 run 让锁只在秒级持有。
- **代价:** 两次 pipeline 拉起(interpret 也要跑 inbox)。对按需、低频的命令可接受;interpret 只读、无副作用。

### D-c:NL 解析在 pilot,view 只透传 + 渲染
- **选择:** view 把**原始 NL** 当 `--input` 透传;解析(NL→`{add}`)在 inbox 的 `interpret-feedback` 里做;view 只渲染 `interpretation.proposed`。
- **为什么:** view 保持**域无关**(不认识 noise_senders/发件人)——比「view 渲染结构化候选勾选」更守 #1;也**整体绕过** intent 注册表/中央分析器(pilot 自己解释自己的 NL)。
- **权威在 pilot:** view 的渲染/校验是**建议性**;pilot 的 `run()` 是权威解析。不一致 = 一次干净失败的 run(`run.failed`),不数据损坏。

### D-d:apply 不经 OS 审批(确认即授权);高危才走 propose
- **选择:** apply-feedback 改降噪名单 = **本质无害、可逆的域副作用**(§3.5 carve-out),**不经 propose/approve/PARK**;人在确认视图的确认**即授权**。
- **为什么:** 它不是高危动作,且 park 会占锁(D-b)。审计 = run 的 trace(input + `feedback.applied`)。
- **护栏:** 若未来某命令解析出**高危**动作,该 pilot MUST 改走 `ctx.propose`(命中 approval→PARK,守 #5),那是另一个变更。

### D-e:白名单 `(pilot,trigger)`,非通用 firehose,非注册表
- **选择:** v1 硬编码 `inbox` 的 `interpret-feedback`/`apply-feedback`;拒绝白名单外请求;不做「run 任意 app + 任意 input」。
- **为什么:** 通用 firehose 会让 Access 成为「任意 pilot + 任意输入」的唯一边界(对抗评审头号安全隐患)。注册表/`intents:` 是 seed-then-generalize 的第 2 个 intent 才抽。

### D-f:busy 呈现重发,不建队列
- **选择:** `hangar run` 遇活跃 run 抛 `already_running`/退出码 1(既有 DB 层「每 app 一活跃 run」);view 呈现「忙,稍后重发」。
- **为什么:** 适配器侧队列 = 隐藏状态、会与脊柱「无队列」立场分叉、会乱序。命令幂等由 pilot 侧 set-union 保证,用户重发安全、诚实。

### D-g:数据最小化放宽**仅限**确认视图
- `/api/state` 与 trace 抽屉的 default-drop **不变**;唯确认视图渲染 `interpretation.proposed`(解析回显)。数据是用户自己刚输入指令的回显、单用户、Access 门后。

## Risks / Trade-offs

- **NL 误解析写坏东西** → confirm-before-apply:interpret 干跑无副作用,人确认解析结果后才 apply(D-a)。
- **prompt 注入(NL 或粘贴内容)** → pilot 侧把 LLM 输出约束为**已知动作 + 参数**、当不可信输入,并回显确认;单用户 + Access 低威胁(实现约束在 inbox repo)。
- **web 表单无「重试按钮」下的 busy 碰撞** → view 呈现「稍后重发」;set-union 幂等使重发安全(D-f)。
- **跨 repo 契约漂移**(inbox 实现事件) → 未知 trigger **响亮失败**;inbox 不 emit 约定事件 → view 呈失败而非假成功;契约由本 spec 固定。
- **数据放宽泄露** → 严格限命令确认路径,`/api/state`/监控墙不受影响(D-g)。
- **两次 run 开销** → 低频按需可接受;interpret 只读(D-b)。

## Migration Plan

- **部署:** 重新部署 `packages/hangar-view`(前端 + 后端)。inbox 侧的 `interpret-feedback`/`apply-feedback` 在 inbox 外部 repo 独立部署,对着本契约。
- **回滚:** 还原 view 即回到只读(**core 一行未改,零 core 回滚风险**);命令路径可 feature-off。
- **上线顺序:** inbox 侧先具备两个 trigger(否则 view 命令会 `run.failed`);view 的写端点后上。两侧都在,端到端可用。

## Open Questions

- **已定(决策记录 §11):** 第一张脸 = web(非 Telegram);NL 应用 = confirm-before-apply(非乐观+undo)。
- **待与 inbox 敲定(实现期):** `interpretation.proposed` 的确切 payload 形状(除 `add` 外是否携带候选上下文/计数供渲染);`interpret-feedback` 的 input 字段名(如 `{text}`)。属实现细节,不阻塞本 spec。
