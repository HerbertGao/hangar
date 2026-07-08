## 为什么

Phase 1 是 hangar 的验证里程碑:让脊柱托起一个**真·每天用**的 pilot,出口闸是「连续 7 天每天用且不想切回旧 inbox-pilot」。`inbox-pilot`(22K 行)当年把「配置/持久化/调度/运行管线/动作执行/通知/日志/CLI」自己重造了一遍——这次把那层还给脊柱,让 inbox 只剩域逻辑。

探索阶段澄清了一件关键事实:**inbox 的真实用法是「自动分类推送」——现有动作 reflect_priority / mark_read / notify 全自动、无一需人批。** propose→approve→PARK(脊柱的招牌机制)在 inbox 现状里一次都不触发。所以本变更迁的是**「脊柱 减去 approval」**这一层(cron + pipeline + config + Run/RunEvent 状态 + trace),approval 的真正 forcing function 留给 Phase 2 的第二个 pilot。

## 变更内容

- **外部 pilot、就地改(拓扑 B)**:inbox-pilot **留在自己仓**,仓根加 `app.yaml`(executor: pipeline + cron,**无 `permissions.approval`**、无 tools);entry `src/pipeline.ts`→编译 `dist/pipeline.js`(`run(ctx)`:拉批 → 逐封 dedup→classify→rules→save→**直接调 executeActions**→markProcessed,`ctx.emit` 写域事件);hangar 经 `HANGAR_APPS`/symlink **in-process 加载其编译产物** `<appDir>/dist/pipeline.js`。**不拷贝域码进 hangar**。(`tools.ts` 仅将来 Phase 2 approval 动作才需要。)
- **域逻辑就地改,不搬**:`executeActions`(剥 durable、返回 `{…,notifyExhausted}`)+ `mailRepo`(trim durable、加 `getClassification`+repoll 计数)在 **inbox-pilot 仓内就地改**;`classifier/normalizer/rules/accounts/notify/provider 原语` 原地不动、被 `pipeline.ts` 直接 import。inbox 自管的 prisma + PostgreSQL **独占**(除 seam B 加一列 `repollCount` 外不动),hangar 从不碰它 —— **无双 schema 共库问题**;两库在**同一进程**并存(唯一残留检查)。
- **取信接缝切清(不能「搬 providers 原样」)**:pollers `import` 并调 `drainAccountRetries`、IMAP poller 拥有游标状态机——整包搬会拖入 durable queue(与「不搬 retryQueue」矛盾)。故只搬薄原语,**poller 编排**在 `run(ctx)` 重组、**不调** `drainAccountRetries`,且必须复刻**两级读错误模型**(429/配额→结束本轮;fetch 侧 401/scope-403/invalid_grant→结束本轮+suspend;良性→逐封 skip)与**成本上界**(`processFrom` 水位 + get-budget ≤200);IMAP 游标 skeleton 不搬(先只 Gmail)。**每 run 加墙钟超时**(reaper 只回收崩溃、不回收 live-hung,否则 hung 调用永占 active-lock)。见 design D5/D7。
- **脊柱替换、inbox 侧删除**:`config / db / jobs / logger / cli / pipeline` 由 hangar 提供。
- **自动动作在 run() 内直接编排,不走 gateway**(两轮 review 结论,已授权):reflect_priority / mark_read / notify 由 `run(ctx)` 调用搬入的 `executeActions`(剥掉 durable,保留内存重试+退避+三值+reauth 致命),审计经 `ctx.emit`。**不经 `ctx.propose`**——gateway 的 propose→PARK→approve 是 approval 门控,inbox 无高危动作;硬塞进去会撞阻抗(handler 无 emit→假绿审计、gateway 3× 重试→猛打撤销 token、无 attempt#→无法辨耗尽)。`ctx.propose` 保留给 Phase 2 的 gmail.send(approval)。见 design D2。
- **接缝 B(durable 重试)—— 不搬,补死信终态**:inbox 的 durable `retryQueue` 破 #3/#8,**不迁**;其职能由 email 级 re-poll + 一个死信终态承接。**仅 notify** 耗尽 → run() 跳 `processedAt` → 下轮 cron 重跑该封(经新增 `getClassification` **复用分类不重 LLM**;reflect/mark_read 耗尽则 emit failed、不阻 notify)。「不丢推送」**依赖**不变量 `shouldNotifyNow ⊥ shouldMarkRead`(P0/P4 vs P2/P3 不相交),故动作顺序 reflect→**notify→mark_read** + self-check 断言。**死信终态**(修无界重发,覆盖所有**已落库**成因;落库前失败每 tick 重取-skip、记降级):每封 re-poll 计数达 K 或超 staleness → markProcessed + `email.dead_letter`、停(等价旧 drain 的 dead_letter)。见 design D3。
- **Phase 1 不引入任何 approval 动作**:`gmail.send`(DESIGN 里"规划中"的发信动作)不做;approval 相关技术债(多进程 approve 仲裁 / gmail.send exactly-once / 审批后域回写落点)整体挪 Phase 2。
- **BREAKING(文档)**:两处「发送邮件走 `hangar approve`」判据(`ROADMAP.md:31`、`DESIGN §5` 完成判据行)改写为「**若存在高危动作则走 approve**」;`ROADMAP.md:32`「能力无退化」改为枚举已接受降级;`ROADMAP.md:40-42`「补齐多进程仲裁」中 approval 仲裁项路由 Phase 2(本变更移除 approval 路径而 moot)、reap-vs-run 项标记已接受降级;`DESIGN.md §5` 的「executeActions 泛化进 gateway」精修为「gateway 供 propose'd/审批动作用,inbox 自动动作在 run() 编排」。

## 功能 (Capabilities)

### 新增功能
- `inbox-app`: inbox pilot 作为 **hangar repo 之外的独立 repo checkout**、由 host in-process 加载编译产物运行的 app 级契约——cron 触发、`run(ctx)` 编排(逐封处理、per-email 隔离、`ctx.emit` 域事件)、自动动作在 run() 内直接编排(不经 gateway)、durable retryQueue 不迁而走 coarse re-poll + 死信终态、两级读错误 + 成本上界 + 每 run 超时、无 approval 动作。这是 app 能力(可含 email/邮件等域名词),非脊柱能力。

### 修改功能
<!-- 无脊柱**能力/行为**修改(复用 run(ctx)+ctx.emit / app.yaml 注册 / cron / Run·RunEvent·trace;一处小脊柱代码改动见 0.3);
     但 DESIGN §3.5/§3.6/§4 契约文本按 #9 修订加 carve-out(见 tasks 0.1)。故非「零 spine 规范修改」。 -->
（无脊柱**能力/行为**修改——run-engine/tool-gateway/app-registry 复用现有实现。但需**修订 DESIGN 契约文本**:pivot 与现 DESIGN §3.5/§3.6「propose 唯一动作入口」冲突,#9 要求先给它加 carve-out〔可审批动作走 propose;本质无害域副作用可在 run() 直接做〕。故是「一处小脊柱改动(0.3:入口认 `dist/pipeline.js` + symlink 跟随)+ DESIGN 契约修订」,非「零 spine 规范修改」。见 tasks 0.1。）

## 影响

- **inbox-pilot 仓(就地改)**:仓根加 `app.yaml`+ entry `src/pipeline.ts`(→`dist/pipeline.js`);`executeActions`/`mailRepo` 就地改;`main.ts`/`scheduler.ts`/`retryQueue.ts`/`processEmail.ts`/`gmailPoller.ts`/`imapPoller.ts` 及其 `*.test.ts` **删除**(非退役——引用被 trim 的 durable/旧签名,`tsc` 整树编译会失败);抽 `gmailMap.ts`;prisma 加 `repollCount` 列。
- **`@hangar/core`(一处小改)**:入口解析认 `dist/pipeline.js`(编译产物)优先、回退 `pipeline.ts`;registry/doctor 同理;symlink 目录跟随(必需)。这是 B 唯一的脊柱代码改动(编译-外部-pilot 加载),通用、inbox-driven,非域特化。("零改动"不再成立,改为"一处小改"。)
- **数据面**:inbox **独占**自己的 PostgreSQL(hangar 从不碰),与 hangar 的 `hangar.sqlite` 在**同一进程**并存(无共享 schema)。
- **文档**:`DESIGN §3.1/§3.2/§4/§5/§6` + `CLAUDE` + `ROADMAP`(外部-pilot 治理,0.2 已做)+ Phase 1 DoD 修订(approve 判据、pivot 对账)。
- **依赖**:inbox 现用 zod/pino/node-cron/yaml 与 hangar 一致;prisma 留在 app 侧。
- **不在本变更**:approval 债(→ Phase 2)、一键降级/一键已读(需 v0 没有的入站回程 telegram→approve,破不变量 #6,→ Phase 3 webhook trigger)。
