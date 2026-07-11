## 1. registry:enabled 字段(FS 权威)

- [x] 1.1 `packages/core/src/registry.ts`:`SpecSchema` 加 `enabled: z.boolean().optional().default(true)`;经 `Spec`(`z.infer<typeof SpecSchema>`)→ `LoadedApp.spec.enabled` 自然透传(无需单独类型)
- [x] 1.2 确认 disabled app **仍进** `loadApps().apps`(仅标记,MUST NOT 在 loadApps 层过滤——否则 run/approve/doctor 全失其踪);`id===目录名` 等约束不变

## 2. daemon 跳过 + blocked 派生 + doctor 上报(cli)

- [x] 2.1 `cli.ts` `daemonTasks`(~588):`load.apps` 馈入前 `filter(a => a.spec.enabled !== false)`,disabled 不排期
- [x] 2.2 blocked 派生跳过 disabled —— **两处 `deriveBlocked` 调用点**(不在 daemon):doctor 循环(`cli.ts` ~257)+ `cmdStatus`(`cli.ts` ~318);对 `enabled:false` **显式**令 `blocked=false`(按 D5:`deriveBlocked` 不读 enabled、disabled 仍有非空 triggers,**不依赖任何自动等价**)。二者**仍列出**该 app,只是 blocked 恒 false
- [x] 2.3 `doctor`(`cli.ts` ~231):`checks.apps[]` 每项增 `enabled`(未写→`true`;注册失败分支 ~236 无 spec → 省略该键);`DoctorReport` 接口类型(`cli.ts` ~207)加 `enabled?: boolean`
- [x] 2.4 确认 `cmdRun`(~444)/审批入口 `openForDecision`(~501,`cmdApprove` 从 ~517 共用)**不**校验 enabled —— disabled app 仍可手动 run + approve/reject

## 3. hangar-view:disabled 不上墙 + 不当 liveness beacon

- [x] 3.1 `derive.js` `deriveOffice`(~123):**broken 检查在先**——`spec/pipeline != ok` 仍呈「配置坏了」⚠️;**仅对 `spec=ok ∧ pipeline=ok`** 的 app 施加 `enabled === false` 排除(broken 优先于 disabled:一个坏 app 不能靠禁用藏起来,与「CLI 取数失败」需求一致;缺 `enabled` 视作 `true`)
- [x] 3.2 `server.js` `loadAppSpecs`(~68)读出 `enabled`;`mostFreqTrigger`(~103)/beacon 选择跳过 disabled(F1:否则禁用最频繁 cron app 毒化顶层 liveness → 误报「疑似停摆」);全 enabled app 无 run 时 beacon 落 `unknown`
- [x] 3.3 `server.js` `buildState`(~155):per-app runs 取数循环跳过 disabled(省无谓子进程)

## 4. heartbeat 禁用 + 契约同步(DESIGN + SKILL)

- [x] 4.1 `apps/heartbeat/app.yaml`:加 `enabled: false`
- [x] 4.2 `DESIGN.md`:更新 App 表段(§135「`enabled` 列」→ app.yaml 声明式字段)+ app.yaml 段(§3.2),记 disable 决策、#2 首用例(退役 heartbeat)、手动-run-放行语义、D5 **显式-guard 决策(自动等价被证伪)**
- [x] 4.3 `SKILL.md`(控制面契约 SOT):`doctor` 返回示例的 `checks.apps[]` 项加 `enabled`(`{ "id":"inbox","spec":"ok","pipeline":"ok","enabled":true }`)+ 一行说明(注册失败分支省略该键、消费方缺字段视作 `true`);并在 `checks.blocked` 说明处补「(`enabled:false` 的 app 除外——不派生阻塞)」——否则契约卡与实现漂移(hangar-view 花名册排除正依赖此字段)

## 5. 测试(**含必改的既有断言,非「确认仍绿」**)

- [x] 5.1 **改断言**:`dod.test.ts §8.1`(~81-84,heartbeat 项)+ `cli.test.ts`(~93-96,`good` 项)的 `deepEqual` 加 `enabled`(heartbeat→`false`、`good`→`true`)——不改则 CI 红(与 heartbeat 值无关)
- [x] 5.2 `registry.test`:`enabled` 缺省→`true`、显式 `false` 解析、非布尔→`spec_invalid`;并 assert `loadApps()` **仍含** disabled app(守 1.2)
- [x] 5.3 daemon/blocked 跳过自检:`enabled:false` app cron 到点 MUST 不触发;其旧 `waiting_human` run 在 status/doctor MUST NOT 报 blocked(仍列出)
- [x] 5.4 `derive.test`(office 层):`enabled:false` 的 doctorApp 不产出员工;`enabled` 缺失(含 `spec_invalid`)照常上墙/照常呈「配置坏了」⚠️
- [x] 5.5 `server.test`(beacon 层,**不在 derive.test**——beacon 选择在 `server.js` `mostFreqTrigger`/`loadAppSpecs`,derive.test 无法 import):`loadAppSpecs` 读出 `enabled` → `mostFreqTrigger` 跳过 disabled → **禁用最频繁 cron 的 app** 时 beacon 落下一 enabled app(或全 enabled 无 run 时 `unknown`),顶层 liveness MUST NOT 报「疑似停摆」
- [x] 5.6 确认 `dod.test.ts §8.1`(heartbeat `enabled:false` + 改后断言)仍**真跑** run→approve→marker→trace

## 6. 校验 + 部署

- [x] 6.1 `openspec-cn validate add-app-disable --strict` 通过;`pnpm --filter @hangar/core build` + 全测试绿(core 73 · view 19 · inbox 441,0 fail)
- [ ] 6.2 ts.mac-mini:pull + `pnpm --filter @hangar/core build` 重建 dist;确认办公室不再显示 heartbeat、daemon 不再每日 park、顶层 liveness 仍由 inbox beacon 正常判活;view 无需改依赖
