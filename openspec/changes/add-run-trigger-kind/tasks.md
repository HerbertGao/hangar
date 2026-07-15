## 1. RunContext 暴露 triggerKind(executor)

- [x] 1.1 `packages/core/src/executor.ts` `RunContext`(~21):加 `triggerKind: 'manual' | 'cron'` + `triggerName?: string`;`trigger?: string` 保留并注释 `@deprecated 用 triggerName`
- [x] 1.2 `RunRequest`(~67):`trigger?: string` 收紧为 `triggerKind: 'manual' | 'cron'`(必填联合类型)
- [x] 1.3 `runApp`(~107 构造 ctx):`triggerKind: req.triggerKind`、`triggerName: req.triggerName`、`trigger: req.triggerName`(back-compat);`createRun` 落列改用 `req.triggerName ?? req.triggerKind`(列语义不变)
- [x] 1.4 **收紧 = breaking(`RunRequest` 经 `index.ts:11` 公开 re-export,但无外部构造者——外部 pilot 用 `run(ctx)` 不调 runApp;`apps/` 零构造)**:同批修所有**仓内** `RunRequest` 构造点否则 `tsc` 红:`gateway.test.ts`:{88,141,164,192}(4 处无 trigger → 加 `triggerKind:'manual'`)、`run-engine.test.ts`:{214,231,243,259,305}(5 处无 trigger → 加 `triggerKind`;305 是 `executor:'claude-code'` unsupported 用例、同需要)、`run-engine.test.ts`:{284,293}(把已删的 free-string `trigger:'cron'` 换成 `triggerKind:'cron'`,284 保留 `triggerName:'digest'`)。**这是「必改的既有调用点」,非「新增测试」**

## 2. 调用点写死 kind + 提取 daemonRunOne(cli)

- [x] 2.1 `cli.ts` `cmdRun`(~464 runApp 调用):`trigger:'manual'` → `triggerKind:'manual'`;`--trigger` 仍只落 `triggerName`(~450 不变)
- [x] 2.2 **提取 daemon 的 RunRequest 构造为导出函数(评审 F2/Blocker-1:否则 cron 臂不可伪造性测不了、只能测 stub)**:把 `startDaemon` 内 `runOne` 闭包里建 `RunRequest`+调 `runApp` 的部分(~721-739)提为模块级导出 `daemonRunOne(db, app, name)`(建 `PipelineGateway` + 调 `runApp`,传 `triggerKind:'cron'`、`triggerName:name`——unnamed → `name` undefined 仍 `'cron'`);`startDaemon` 的 `makeFireGate({ runOne: (a,n) => daemonRunOne(db,a,n) })` 经它接线。行为不变(**保留原 `.catch` 的 `'cron run failed'` 日志行**),只为可单元断言 cron 臂。`daemonRunOne` 是 `cli.ts` 内部导出(测试从 `./cli.js` import,同 `startDaemon`/`makeFireGate`),**不新增 package 公共 API**。注:`startDaemon` **必须真经 `daemonRunOne` 接线**——否则 4.3 绿而 prod 仍走旧闭包(见 4.3 的 wiring 断言)

## 3. 契约文档同步(#9)

- [x] 3.1 `DESIGN.md` §3.5 RunContext 段:加 `triggerKind`/`triggerName`,记「host 在 run 创建入口写死、`--trigger`/app 不可伪造、唯一 provenance 是 host 入口」决策;`trigger` 标注 deprecated 保留
- [x] 3.2 `DESIGN.md` §3.3(~143):列值公式 `triggerName ?? req.trigger ?? 'manual'` → `triggerName ?? req.triggerKind`(语义不变、仅内部字段名随收紧漂移);**并订正同段「现无消费者 switch 它」**——hangar-view `deriveLiveness`(`derive.js:214`)实际 switch `r.trigger === 'cron'`,与本提案 Impact 一致(守 #9 DESIGN↔提案一致)

## 4. 契约测试

- [x] 4.1 **manual 边界不可伪造(`cli.test.ts`,非 run-engine 层)**:经 `dispatch(['run', app, '--trigger', name])`、pipeline `emit(ctx.triggerKind)`,断言 `triggerKind==='manual'`(named / unnamed 各一)。**必须走 CLI dispatch**——runApp 层只透传、证不出不可伪造性
- [x] 4.2 **manual 用 cron 同名仍 manual(`cli.test.ts`)**:`dispatch(['run', app, '--trigger', 'daily'])` 且该 app 配名为 `daily` 的 cron 触发器,断言 `triggerKind==='manual'` ∧ `triggerName==='daily'`。不能在 run-engine 层用 literal 拼 `RunRequest`(断言退化成断言传入常量 = vacuous)。**诚实说明(评审)**:cmdRun 不读 `app.spec.triggers`,故 kind 无路径可泄漏——真正的载荷断言是「host 写死 manual」,配 named `daily` cron 触发器是**忠于 spec 场景的回归守卫**、非鉴别力来源(`writeApp` 需扩一个 named `daily` cron 触发器,现有 fixture 只发单个无名触发器)
- [x] 4.3 **cron 臂不可伪造 + 真实 daemon 接线**:① 对提取的 `daemonRunOne(db, app, name)` 直测 named/unnamed cron 都得 `ctx.triggerKind==='cron'`(unnamed → `triggerName` undefined 仍 `'cron'`),使用真 `LoadedApp` + `PipelineGateway` + `runApp`,不以注入 stub 断言自身;② #17 已让 `startDaemon` 返回同一闭包状态上的 `{shutdown, fire}`,现另经真实 `startDaemon(...).fire(app, 'daily')` 断言 `ctx.triggerKind==='cron'` 且 `ctx.triggerName==='daily'`,防止直测为绿但生产接线绕开 `daemonRunOne`;测试销毁 cron task/信号监听器并等待 trace event,避免句柄泄漏和竞态。
- [x] 4.4 **旧 app 只读 `ctx.trigger` 零回归**:扩展现有 `cli.test.ts:562-586`(已驱动 `ctx.trigger`-only pipeline),加一行断言 `triggerKind`-unaware pipeline 不受影响(省一个 fixture);`run-engine.test.ts` 另留一条 runApp 层 threading 测试,注释「plumbing,非不可伪造性证明」

## 5. 校验

- [x] 5.1 `pnpm openspec:validate add-run-trigger-kind --strict` 通过；仓库包装器在校验前强制 `openspec-cn --version === 1.6.0`,缺失或版本漂移显式失败。CI 不做脆弱的全局安装；需要 OpenSpec 验收的环境先提供该固定版本,再运行此唯一命令。
- [x] 5.2 `pnpm --filter @hangar/core build` + 全测试绿(含 1.4 修好的现存构造点)
