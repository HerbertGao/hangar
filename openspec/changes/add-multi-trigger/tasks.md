## 1. DESIGN 先行(#9,先于任何代码)

- [x] 1.1 `DESIGN.md`:加「多触发」契约——app 可多个具名触发器(`{type,name?,schedule:string|string[],timezone?}`,name 在 >1 触发器时必填)、`ctx.trigger` 传不透明 name 路由(脊柱零域、app 内 switch)、daemon 单活跃-run 下 per-app 序列化+去重(替换 skip)、`type` 判别字为未来非-cron 形式留位不建机制(#6);`RunContext` 加可选 `trigger`。放在 executor/daemon/RunContext 相关段;点明 #1/#2/#3/#6 如何守。

## 2. 脊柱多触发(`@hangar/core`)

- [x] 2.1 `registry.ts` schema:`CronTrigger` 加 `name: z.string().min(1).optional()`、`schedule` 改 `z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])`,每条 schedule 字符串加 `.refine(s => cron.validate(s))`(非法 cron/空串 → spec_invalid、doctor 报错、app 不注册,避免非法 cron 在 daemon `cron.schedule` 同步抛崩进程);`SpecSchema` **superRefine**:`triggers.length > 1` 时每个 trigger 必须有非空 name **且各 name 互不重复**,否则 issue → `spec_invalid`(loadOne 已把 zod 失败映射 spec_invalid)。self-check:①2 触发缺 name → spec_invalid;②2 触发重名 → spec_invalid;③单触发省 name → 合法;④数组 schedule 解析通过;⑤非法 cron(`"30 12 * *"`/空串)→ spec_invalid。
- [x] 2.2 `cli.ts` `daemonTasks`:改为 `triggers.flatMap(t => [...new Set(toArray(t.schedule))].map(s => ({appId, name: t.name, schedule: s, timezone: t.timezone})))`(数组展开、去重同串、每任务带 name)。`cronPeriodMs`/`appPeriodMs`/**`deriveBlocked`** 的 `schedule` 参数类型随之放宽为 `string | string[]`,两处调用点(`cmdStatus`、`doctorReport` 传 `app.spec.triggers`)对数组展开后再取每条周期**最小值**(= 最快 trigger 一周期没跑即 overdue;最激进而非保守的判定、语义正确)。self-check:数组 schedule → N 个任务各带同 name(重复串去重);overdue period = min。
- [x] 2.3 `executor.ts`:`RunRequest` 加 `triggerName?: string`;`runApp` 构造的 `RunContext` 加 `trigger: req.triggerName`(可选);`RunContext` 接口加 `trigger?: string`(注释里点明它是可选的触发身份、脊柱零域)。`Run.trigger` 列存 `triggerName ?? req.trigger ?? 'manual'`(name 优先、供 trace;注意该列自此**混载 name 与类别** `cron`/`manual`——未来消费者不得假设 `trigger∈{cron,manual}`)。self-check:run(ctx) 收到 ctx.trigger === 传入 name;缺 name → undefined。
- [x] 2.4 `cli.ts` daemon 序列化(替换 `hasActiveRun→skip`):模块级 per-daemon `inFlight: Set<appId>` + `pending: Map<appId, triggerName[]>`(按 name 去重、每 name 至多 1、插入序 drain;**易失调度提示、非 run-state 真相**,RunEvent 仍是 SOT、pending 不进 4 表)。`fire(app, name)` 回调:`inFlight.has(appId)` → `pending` 加(去重)、return;否则 `hasActiveRun(db, appId)`(别进程持锁 **或本 daemon run 已 park 成 waiting_human 仍持锁**)→ skip+log、return;否则 `runOne(app, name)`。`runOne`:`inFlight.add`;`runApp(...).catch(log).finally(()=>{ inFlight.delete; 取一个 pending → 走回 `fire(app,name)` 而非直接 runOne })`——**drain 复用 fire 守卫按 DB 活跃态判定**:若 park 未终态,drain 落 skip+log 不撞 `already_running`。加 **liveness 假设**注释:`inFlight` 只在 runApp settle 时清,pilot `run()` 须自限时(否则挂死永占;脊柱 watchdog 属未来)。self-check(非空断言、假时钟/假 runApp seam):①app 正跑时第二触发 fire → 记 pending 不 skip;②前一个 run 达终态 → pending 按插入序 drain 执行;③同触发多次 fire → 至多 1 pending;④跨进程/park(hasActiveRun 真、inFlight 无或 run 非终态)→ skip+log 不撞 already_running;⑤同刻两 fire(check-then-`inFlight.add` 无 await、依赖 node-cron 同 tick 顺序 flush 的原子性)→ 一个跑、一个入 pending。
- [x] 2.5 `cli.ts` `cmdRun`:`run <app>` 加可选 `--trigger <name>`,把 name 经 `RunRequest.triggerName` → `ctx.trigger`(省略则 `undefined`、向后兼容),使任一具名触发行为可手动触发/重放(4.3 手动验 digest 靠它)。self-check:`run inbox --trigger digest` → ctx.trigger==='digest';无 flag → undefined。
- [x] 2.6 `packages/core` build + test 绿(含既有 58 + 新 self-check);heartbeat(单无名触发)零回归。

## 3. inbox pilot digest 恢复(`inbox-pilot`)

- [x] 3.1 本地 `RunContext` type(`pipeline.ts`)加 `trigger?: string`;`run(ctx)` 顶端按 `ctx.trigger` 分派:`'digest'` → `runDigest(ctx, deps)`;`'poll'` 或 `undefined` → `runPoll`(现有 poll 主体,抽成 `runPoll` 或原地 if);**其余未知 name → throw**(拼错/漏配触发器时响亮失败,不静默走 poll)。fail-loud 断言**不**加 trigger(可选)。
- [x] 3.2 `runDigest`:复用 `digestScheduler.ts` 的一轮编排语义(`buildDigest(repo, now) → 逐段 if((await notifier.notifyDigest(seg.text)).outcome!=='sent') return; 再 repo.markDigested(seg.messageRowIds, DIGEST_TYPE_DAILY, now)`;build null → emit `digest.empty`、不推)。经 `ctx.emit` 审计(`digest.sent`/`digest.empty`/`digest.failed`,非 PII)。复用 defaultNotifier / PrismaMailRepo(与 poll 同)。
- [x] 3.3 退役 `DIGEST_TIMES` 调度:删 `digestScheduler.ts` 的 `startDigestSchedulers`/`DIGEST_TIMES` 解析/node-cron 部分(保留 `buildDigest`/`notifyDigest`/`markDigested`/一轮编排 runner 供 runDigest 用);`configSchema` 的 `DIGEST_TIMES` **保留但标记退役(不再读)**,而非删——既有 `.env` 仍设它时不触发 config 严格校验报错。删/改引用它的 `*.test.ts`(digestScheduler.test.ts 的 cron 部分)。`tsc include:src/**` 整树须绿。
- [x] 3.4 `app.yaml`:两触发器——`{type:cron, name:poll, schedule:"*/3 * * * *", timezone:Asia/Shanghai}` + `{type:cron, name:digest, schedule:["0 6 * * *","30 12 * * *","0 19 * * *"], timezone:Asia/Shanghai}`。
- [x] 3.5 self-check(非空断言,驱动真实 run(ctx)、不 stub buildDigest/notifyDigest/emit seam):①`ctx.trigger==='digest'` → 调 buildDigest+逐段 notifyDigest+markDigested、poll 路径不走;②`ctx.trigger==='poll'`/undefined → 走现有 poll、不发摘要;③digest 空 → emit digest.empty 不推;④digest 段发失败 → 停、不 markDigested 后续段。
- [x] 3.6 `inbox-pilot` build + test 绿。

## 4. 部署 + 验证

- [ ] 4.1 commit/PR:hangar(core + DESIGN)+ inbox-pilot(pipeline + app.yaml + 退役);CI 绿后合并。
- [ ] 4.2 ts.mac-mini:`~/hangar` git pull + rebuild core;`~/inbox-pilot-hangar` git pull + build;`hangar doctor` 验两触发器加载(inbox spec ok)。
- [ ] 4.3 重启 launchd daemon(`launchctl kickstart -k`);验证:hangar.sqlite 见 `trigger=digest` 与 `trigger=poll` 两类 cron run;下一个 digest 时刻(06:00/12:30/19:00)真收到 Telegram 摘要,或 `hangar run inbox --trigger digest` 手动触发一次验证(靠 2.5 的 `--trigger`)。
- [ ] 4.4 观测:摘要恢复后并入 Phase 1 §6 出口闸的日常使用。
