## 修改需求

### 需求:每个 pilot 呈现为一名虚拟员工、覆盖完整状态与注册错误
`/api/state` SHALL 为每个 app 产出一名「员工」条目。**花名册权威源 MUST 是 `hangar doctor --json` 的 `checks.apps[]`**(全 id 超集,含注册失败者),**但 MUST 排除 `spec === 'ok' ∧ pipeline === 'ok' ∧ enabled === false` 的 app**(**otherwise-healthy 的禁用 app 不上墙**;`enabled` 缺失——旧 core 未上报,或注册失败无解析 spec——视作 `true`,照常上墙)。**左连** `status --json` 按 **app id** 取 run-state,**去重键 = app id**——MUST NOT 用「`status` ∪ `doctor.errors`」这类并集(否则 `status`/`doctor` 两次独立 subprocess 快照间 `app.yaml` 变更时会重复计 valid app,或把刚修好的健康 app 静默省略,违下「MUST NOT 静默省略」)。**「MUST NOT 静默省略」约束仅适用于 `enabled` 的已注册 app**:`enabled === false` 的排除**非静默**——`doctor --json` 仍如实列出该 app 及其 `enabled: false`(见 cli 规范),operator 经 CLI 可查到它是被禁用而非漏检。**禁用排除的适用面(评审精修:broken 优先于 disabled)**:`spec` 或 `pipeline != 'ok'` 的 app 一律**先**呈「配置坏了」⚠️;禁用排除**仅对 `spec=ok ∧ pipeline=ok`** 的 otherwise-healthy app 生效。故 `spec_invalid`/`app_unresolved`(无解析 `enabled`,视作 `true`)**与** disabled-且-`pipeline_missing`(有 `enabled:false` 但 pipeline 坏)**都仍呈「配置坏了」⚠️**、不因「想禁用」被藏起来——与本规范下「CLI 取数失败」需求『`pipeline != ok` → 配置坏了』**一致**(否则同一坏 app 一处要藏、一处要显 ⚠️,自相矛盾),亦同 cli 规范 D2『disable 只对 valid app 生效』(此处再收窄为 valid + 可跑)。员工态 MUST 由该 app **最近一次 run** 的 `state` 与时间戳派生。映射 MUST 覆盖 core `State` 枚举的**全部 7 取值** `{queued, running, waiting_human, executing, completed, failed, cancelled}` **加「无 run」加「注册失败」**,且 MUST 有中性兜底(不得对某情形无映射而渲染 undefined)。**注册失败**:core `cmdStatus` 只遍历成功注册的 app,`app.yaml` 坏掉(`spec_invalid`/`app_unresolved`)的 pilot 不出现在 `status --json`——view MUST 经 `doctor --json` 的 `checks.apps[].spec != 'ok'` **或 `pipeline != 'ok'`**(`pipeline_missing` = 编译产物缺失、pilot 跑不了)消费注册错误(注意路径是 **`checks.apps`** 非顶层 `apps`),把这类 pilot 呈为员工级「配置坏了」⚠️,MUST NOT 静默省略(否则「pilot 连注册都失败/编译缺失」时监控失声,或把跑不了的 pilot 冒充成健康员工)。`checks.apps` 有而 `status` 无(且 `spec=='ok'`)的 app → run-state 视作 never-ran/`unknown`。**已披露盲区**:`status`/`doctor` 是两次独立 subprocess 快照,其间 `app.yaml` 增改会致一个 valid app **短暂遗漏一轮**(或带陈旧 `spec!=ok` 标签一轮)——单 poll 周期自愈、且遗漏的是健康 app(非假绿灯)。消除需合并成单次 CLI 调用=改 core、破「零改 core」,故 v1 接受此一轮 skew。终态映射:`completed` 新鲜窗内→刚搞定、之后→打盹;`failed`→翻车 ⚠️;`cancelled`(仅由 `hangar reject` 产生,是「你驳回过一件事」的终态)→收工(中性、非 ⚠️,但文案须区别于「打盹」)。非终态映射见「诊断」与「本体存活」两需求(按年龄分工作中 vs 疑似卡住)。(注:`queued` 经 core `createRun` 原子写 `running`+`run.started`,几乎不作为持久 latest state 出现;mood 表仍保留其兜底以防御,但不为其编造「可观测」场景。`action.failed` 事件推导为 `executing` 非 `failed`,见 core `events.ts`。)

#### 场景:otherwise-healthy 的禁用 app 不上墙(显式非静默)
- **WHEN** `doctor --json` 的 `checks.apps[]` 中某 `spec=ok ∧ pipeline=ok` 的 app `enabled: false`
- **THEN** 该 app MUST NOT 出现在 `/api/state` 办公室(无其员工条目),且这不违反「MUST NOT 静默省略」——doctor 仍列出它,operator 经 CLI 可见其被禁用

#### 场景:坏 app 不因禁用被藏(broken 优先)
- **WHEN** 某 app `enabled: false` 但 `pipeline != ok`(disabled-且-pipeline_missing),或某 app `spec_invalid`(无解析 `enabled`,视作 `true`)
- **THEN** view MUST 照常呈「配置坏了」⚠️(broken 优先于 disabled;坏 app 不能靠禁用藏起来,与「CLI 取数失败」需求一致)

#### 场景:旧 core 无 enabled 字段照常上墙(向后兼容)
- **WHEN** 某 `spec=ok ∧ pipeline=ok` app 的 `doctor.checks.apps[]` 项无 `enabled` 字段(旧 core 未上报 / `app.yaml` 未写)
- **THEN** view MUST 视作 `enabled: true`、照常上墙(不误藏健康 app,守 D4 向后兼容)

#### 场景:注册失败呈员工级告警
- **WHEN** 某 pilot 的 `app.yaml` 坏掉(`spec_invalid`),不出现在 `status --json`,但 `doctor --json` 的 `apps[].spec != 'ok'`
- **THEN** view 把它呈为员工级「配置坏了」⚠️,不静默省略

#### 场景:cancelled 有中性映射
- **WHEN** 某 app 最近一次 run 是 `cancelled`(你 reject 过的终态)
- **THEN** 呈「收工·已驳回」中性态、非 ⚠️,文案区别于「打盹」

#### 场景:completed 新鲜与衰减
- **WHEN** 某 app 最近一次 run `completed`,结束在新鲜窗内 / 已超窗
- **THEN** 分别呈「刚搞定」/「打盹(上次搞定 N 分前)」

#### 场景:从未运行
- **WHEN** 某 **enabled** app 无任何 run(任一新注册、尚未到首个 cron 的 pilot)
- **THEN** 呈「还没上过班」态、非 ⚠️

### 需求:本体存活 = 新鲜度启发式、终态按 endedAt、非终态由员工级卡住兜底
view MUST 提供一个 hangar 本体是否仍在运转的**新鲜度启发式**指示(非精确判死),不额外探进程、不改 core。**顶层「hangar 疑似停摆」仅当** **enabled app 中**最频繁 cron 触发器的**最近一次 run**(取 `started_at` 最新那条、**不论是否终态**;非「最近一次终态 run」)**已达终态**且 `now - 该 run.endedAt > 2× 其 cron 周期`时才提示——**用 `endedAt`(由 `runs --json` 暴露)而非 `startedAt`**,否则一个合法长 run(耗时 > 2 周期)刚完成时会被 `now - startedAt` 立即误报停摆。(逻辑自洽:若存在更晚的非终态 run,它的 `started_at` 本身证明 daemon 那刻 fire 过,故更早终态 run 的逾期与否 moot;更晚非终态若超窗由员工级「疑似卡住」兜底。)最近一次 run 为**非终态**时 MUST **抑制**顶层「停摆」——但该非终态若超卡死窗,已由上一需求的**员工级「疑似卡住」⚠️** 兜底(故 hung/崩溃遗留的 orphan 不会被读成「一切正常」)。该触发器**从未产出 run**(dev 手动测/无 daemon)MUST 报 `unknown`,不误报。**beacon 选择 MUST 排除 `enabled === false` 的 app(评审新增)**:`loadAppSpecs` MUST 读出 `enabled` 供 `mostFreqTrigger` 过滤,beacon 只在 **enabled** 的 app 间选最频繁 cron;否则一个被禁用、却恰是全场最频繁 cron 的 app 会被选为 beacon,而 daemon 已不再调度它 → 其最近 run 的 `endedAt` 迟早超 2× 周期 → 顶层误报「疑似停摆」。所有 enabled app 均无 run(或无 cron)时 beacon 落 `unknown`,MUST NOT 报停摆。**liveness MUST 从最频繁触发器所属 app 自己的 `runs <app> --json` 派生(带 `appId`,复用 office 已取的 per-app runs),MUST NOT 用无过滤的全表 `runs --json`**——否则 (i) 跨 app 同名/无名(`'cron'` 类别)trigger 会把别 app 的 run 混进来 = 假绿灯;(ii) 全表查询随历史无界增长,终将撑爆子进程 `maxBuffer` 致**每轮 poll 永久降级、不自愈**。**`unknown` MUST 严格限于「该 app 的 runs 成功返回、且无匹配该触发器的 run」**:若该 app 的 runs 调用失败,liveness MUST 呈「取数失败」(该 app 员工亦降 fetch_failed),MUST NOT 渲染成 `unknown`(否则取数失败伪装成「从没跑过」= 陈旧绿灯近亲)。触发器匹配 MUST 容忍**无名触发器**(`Run.trigger='cron'` 类别,见 core `executor.ts`,不得硬编码 `poll`);**具名时**(生产 inbox 的 poll/digest)按从 `app.yaml` 推出的最频繁触发器 `name` 匹配 `Run.trigger`。为省无谓子进程,`buildState` 的 per-app runs 取数循环 SHOULD 跳过 disabled app(它不上墙、取了也丢弃)。**已披露盲区(v1 接受、UI 呈「疑似」不断言):**(a) 手动 `hangar run --trigger <同名>` 写出与 daemon 同 `trigger` 的 Run,读模型无法区分「刚被人 replay」与「daemon 存活」——精确区分需 core 暴露 run source/心跳(改 core、越界、留 Phase C 过 #9);(b) `app.yaml` cron 改后未重启 daemon(core `startDaemon` 只 loadApps 一次)→ 存活是 daemon-config 相关启发式;(c) view 只读、`status/runs --json` 不暴露 `lock_owner`,故无法像 reaper 那样判「崩溃 daemon 的 orphan」——只能靠员工级年龄卡住兜底,不能区分「daemon 崩了」vs「某 pilot 动作卡了」(二者都呈该员工「疑似卡住」,这正是可操作信号)。

#### 场景:终态 poll 逾期(按 endedAt)才提示疑似停摆
- **WHEN** 最频繁触发器最近一次 run 已达终态,且 `now - endedAt > 2× 周期`
- **THEN** 提示「hangar 疑似停摆」(措辞「疑似」,非断言判死)

#### 场景:长 run 刚完成不误报
- **WHEN** 一个合法长 run 耗时 > 2 周期、刚 `completed`(`endedAt` 接近 now)
- **THEN** MUST NOT 提示停摆(用 `endedAt` 判,非 `startedAt`)

#### 场景:非终态由员工级卡住兜底
- **WHEN** 最频繁触发器最近一次 run 为非终态(含崩溃 daemon 遗留的 orphan)
- **THEN** MUST NOT 报顶层「停摆」;若其 `started_at` 超卡死窗则该员工呈「疑似卡住」⚠️(不被读成一切正常)

#### 场景:无 run 报 unknown
- **WHEN** 库中不存在该触发器的任何 run
- **THEN** 存活报 `unknown`,不误报停摆

#### 场景:禁用最频繁 cron 的 app 不误报停摆
- **WHEN** 某 `enabled: false` 的 app 是全场最频繁 cron(其余 enabled app 各有更慢 cron)
- **THEN** beacon MUST 落到下一个 **enabled** app(或全 enabled app 无 run 时为 `unknown`),MUST NOT 因禁用 app 的陈旧 `endedAt` 报「hangar 疑似停摆」
