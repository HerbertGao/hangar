## Why

`heartbeat` 是 phase-0 骨架的**标准参考 app + DoD §8.1 端到端夹具**(`dod.test.ts` 用真 `apps/heartbeat` 跑 doctor→run→waiting_human→approve→marker 写盘全链),还被 6 份规范引用为示例。但它带一个每天 09:00(Asia/Shanghai)的 cron:在生产 `ts.mac-mini` 上每天 park 一次 `demo.risky` → hangar-view 办公室**天天冒一个「举手·已逾期」假警报**。

删掉它会**拆掉 DoD 自检 + 孤立 6 份规范**;改生产 `HANGAR_APPS` 根或手改 git 管理的 app.yaml 都是 workaround(前者动运行中 daemon 配置、后者被 pull 冲掉)。缺的是一个一等公民的能力:**测试通过后「禁用」某个 app**——让它不自动调度、不上墙,但仍可手动 run(夹具照用)。这是**退役骨架/测试 app 的通用需求**(将来退役的 pilot 同理),属 OS 层 app 生命周期管理,不该靠删文件绕过。

## What Changes

- **`app.yaml` 加可选 `enabled: false`(默认 `true`)**。仍是唯一 app 定义入口(不变量 #4),域中立(#1),不加表/不加库(#3)。
- **`disabled` 语义(三条)**:
  - ① **daemon 跳过**其 cron 触发(不自动 park);
  - ② **hangar-view 办公室不上墙**(`doctor` 仍如实报 `enabled:false`,是**显式排除**非静默省略);
  - ③ **手动 `hangar run <app>` 仍放行** —— operator / DoD 夹具照跑。这条是关键:一个 committed flag 同时满足「CI 里可测 + 生产里隐身」。
- **`doctor.checks.apps[]` 每个 app 增报 `enabled`**(view 据此过滤)。
- **`apps/heartbeat/app.yaml` 提交 `enabled: false`**:生产办公室不再每天 park demo.risky;DoD §8.1 的 run→approve 路径不受影响(手动 run 不被 `enabled` 门挡)。**但**加 `enabled` 到 `doctor.checks.apps[]` 会改其对象形状,须同步更新 `dod.test.ts`/`cli.test.ts` 两处 `deepEqual` 断言(非零测试改动,见 design.md D2)。
- **不变量 #2 的论证**(详见 `design.md`):inbox pipeline **不直接用** disable,但它属 OS app 生命周期管理(与已有 `registry`/`doctor`/`status` 同族),动因是**退役夹具/测试 app 而不删** —— 在 DESIGN 显式论证并接受这一例外,而非默默过拟合。

## Capabilities

### New Capabilities

(无 —— 全部为对现有 capability 的需求级修改。)

### Modified Capabilities

- `app-registry`: `app.yaml` zod schema 增可选 `enabled`(默认 `true`);disabled app **仍加载**(手动可 run)但被标记。
- `cli`: **修改**「daemon 按 triggers 调度」需求——`enabled:false` 的 app 不排期、status/doctor 不派生其阻塞(但**仍列出**、不 delist);**新增**「doctor `checks.apps[]` 增报 `enabled`(与独立的 `checks.blocked` 两处)、手动 `run/approve` 不受影响」。
- `hangar-view`: **修改**花名册需求(「MUST NOT 静默省略」收窄为「仅 `spec=ok ∧ pipeline=ok ∧ enabled` 的已注册 app」;**broken 优先于 disabled**——`spec/pipeline` 坏一律呈⚠️,禁用只排除可跑的健康 app;doctor 仍列)+ **修改**「本体存活」需求(liveness beacon 只在 enabled app 间选,否则禁用最频繁 cron app 误报停摆)。

## Impact

- **代码**:`packages/core/src/registry.ts`(zod schema、类型、`enabled` 透传)、`cli.ts` 的 `daemonTasks`(过滤 disabled)、两处 `deriveBlocked` 调用点(显式 `blocked=false`)、`doctor`(回报 `enabled`)、`DoctorReport` 类型;`packages/hangar-view/src/{derive.js,server.js}`(`deriveOffice` 过滤、`loadAppSpecs`/`mostFreqTrigger` beacon 排除、`buildState` 省取数)。
- **数据/DB**:零 —— 不加表、不加列,`enabled` 只活在 `app.yaml`(FS 即权威)。
- **配置**:`apps/heartbeat/app.yaml` 加 `enabled: false`。
- **契约文档**:`DESIGN.md`(§135 App 表 + §3.2 app.yaml)、`SKILL.md`(`doctor` 示例 `checks.apps[]` 加 `enabled`)——控制面契约 SOT 须与实现同步。
- **测试**:`registry.test`(默认/显式/非布尔 + `loadApps()` 仍含 disabled)、**改** `dod.test.ts §8.1` + `cli.test.ts` 的 `checks.apps` `deepEqual`(加 `enabled`)、`derive.test`(disabled 不上墙)、**`server.test`(beacon 排除 disabled)**、新增 daemon/blocked 跳过自检。
- **不变量**:未破 #1/#3/#4/#6/#7;**#2 需 DESIGN 论证**(已纳入 `design.md`)。
