## 新增需求

### 需求:只读呈现层、零改 core、不直读 sqlite
`hangar-view` SHALL 是脊柱之外的一个独立进程(仓内 `packages/hangar-view`),**与 `@hangar/core` 无 import 依赖**。它取运行数据 MUST 只经 `hangar … --json`(subprocess)+ 只读 `app.yaml`(config,非状态),MUST NOT 直接打开或读写 `hangar.sqlite`(守 SKILL「一切经 CLI」、守脊柱事件时序)。它 MUST NOT 修改任何脊柱状态(v1 纯只读)。其 HTTP 面 MUST 只存在于 view↔浏览器之间(不给 `@hangar/core` 加任何 HTTP/IPC,守不变量 #6/#7)。**注意:core 的 `hangar trace/status/runs --json` 本身不改**——一切派生与裁剪都发生在 **view 进程**(这正是「零改 core」的机制)。

#### 场景:经 CLI 取数
- **WHEN** view 需要当前各 app 状态与 run 历史
- **THEN** 它 subprocess 调 `hangar status --json` / `hangar runs --json` / `hangar trace <run> --json`,不直接读 sqlite 文件

#### 场景:core 零改
- **WHEN** 核对本变更对 `@hangar/core` 的改动
- **THEN** core 一行未改(无新 HTTP/IPC),`hangar-view` 只作 CLI 消费者存在

### 需求:配置显式对齐 daemon、不依赖 doctor 回显路径
因 `HANGAR_APPS`/`HANGAR_DB` 默认 cwd 相对(见 core `resolveAppsDir`/`resolveDbPath`),若 view 与 daemon 解析到不同库/apps 根,会画出「全员没上过班 / hangar 挂了」的假象而 hangar 实则健康。但 core `hangar doctor --json` 的 `DoctorReport` **不回显**已解析的 `HANGAR_APPS`/`HANGAR_DB` 路径(仅 `apps_dir` 状态串),故 view MUST NOT 依赖 doctor 取路径真值(那需改 core、破「零改 core」)。改为:view MUST 由**显式** `HANGAR_APPS`/`HANGAR_DB` 环境变量启动(部署时与 daemon 的 launchd plist 设**同一绝对路径**),MUST NOT 依赖 cwd 相对默认;view SHOULD 在页面上**回显自己所用的** `HANGAR_APPS`/`HANGAR_DB` 供人工核对是否与 daemon 一致;二者任一未显式设置(落到 cwd 相对)时 MUST 启动告警。**已披露盲区**:view 只读、无法自动探测 daemon 侧的 cwd 漂移,只能靠显式 env + 上屏回显人工核对。

#### 场景:未显式设置 env 时告警
- **WHEN** view 启动时 `HANGAR_APPS` 或 `HANGAR_DB` 未显式设置(将落 cwd 相对)
- **THEN** view 启动告警「配置未显式对齐,可能与 daemon 不一致」,并在页面回显所用路径,MUST NOT 静默把不对齐渲染成「全员没上过班」

### 需求:每个 pilot 呈现为一名虚拟员工、覆盖完整状态与注册错误
`/api/state` SHALL 为每个 app 产出一名「员工」条目。**花名册权威源 MUST 是 `hangar doctor --json` 的 `checks.apps[]`**(全 id 超集,含注册失败者),**左连** `status --json` 按 **app id** 取 run-state,**去重键 = app id**——MUST NOT 用「`status` ∪ `doctor.errors`」这类并集(否则 `status`/`doctor` 两次独立 subprocess 快照间 `app.yaml` 变更时会重复计 valid app,或把刚修好的健康 app 静默省略,违下「MUST NOT 静默省略」)。员工态 MUST 由该 app **最近一次 run** 的 `state` 与时间戳派生。映射 MUST 覆盖 core `State` 枚举的**全部 7 取值** `{queued, running, waiting_human, executing, completed, failed, cancelled}` **加「无 run」加「注册失败」**,且 MUST 有中性兜底(不得对某情形无映射而渲染 undefined)。**注册失败**:core `cmdStatus` 只遍历成功注册的 app,`app.yaml` 坏掉(`spec_invalid`/`app_unresolved`)的 pilot 不出现在 `status --json`——view MUST 经 `doctor --json` 的 `checks.apps[].spec != 'ok'` **或 `pipeline != 'ok'`**(`pipeline_missing` = 编译产物缺失、pilot 跑不了)消费注册错误(注意路径是 **`checks.apps`** 非顶层 `apps`),把这类 pilot 呈为员工级「配置坏了」⚠️,MUST NOT 静默省略(否则「pilot 连注册都失败/编译缺失」时监控失声,或把跑不了的 pilot 冒充成健康员工)。`checks.apps` 有而 `status` 无(且 `spec=='ok'`)的 app → run-state 视作 never-ran/`unknown`。**已披露盲区**:`status`/`doctor` 是两次独立 subprocess 快照,其间 `app.yaml` 增改会致一个 valid app **短暂遗漏一轮**(或带陈旧 `spec!=ok` 标签一轮)——单 poll 周期自愈、且遗漏的是健康 app(非假绿灯)。消除需合并成单次 CLI 调用=改 core、破「零改 core」,故 v1 接受此一轮 skew。终态映射:`completed` 新鲜窗内→刚搞定、之后→打盹;`failed`→翻车 ⚠️;`cancelled`(仅由 `hangar reject` 产生,是「你驳回过一件事」的终态)→收工(中性、非 ⚠️,但文案须区别于「打盹」)。非终态映射见「诊断」与「本体存活」两需求(按年龄分工作中 vs 疑似卡住)。(注:`queued` 经 core `createRun` 原子写 `running`+`run.started`,几乎不作为持久 latest state 出现;mood 表仍保留其兜底以防御,但不为其编造「可观测」场景。`action.failed` 事件推导为 `executing` 非 `failed`,见 core `events.ts`。)

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
- **WHEN** 某 app 无任何 run(如 heartbeat 玩具)
- **THEN** 呈「还没上过班」态、非 ⚠️

### 需求:诊断嵌在员工上(⚠️)、按年龄区分工作中 vs 疑似卡住
需要你关注的情形 SHALL 表现为**对应员工头顶的 ⚠️**,而非独立告警面板。**非终态 run 按年龄分**(`started_at` 由 `status.since` 暴露,可算,零改 core):最近一次 run 非终态且 `started_at` 在**卡死窗**内→「工作中」非 ⚠️(健康 mid-run);**超卡死窗的任何非终态 run(`running`/`executing`/`queued`,`waiting_human` 除外)→「疑似卡住」⚠️**。这是关键——core `makeFireGate` 会让 hung run 永久占 `inFlight` 且不再调度,一个卡在 `executing`(如 propose'd 动作网络挂死)/`running`(如 IMAP 卡)的 run 必须触员工级 ⚠️,不能永久显「工作中」。`waiting_human` 单独处理(它是刻意 park、等你拍板):→「举手」⚠️;`blocked ⊂ waiting_human`(见 core `deriveBlocked`,仅 waiting_human 且逾期为真)时以**单一**「举手·已逾期」⚠️ 呈现,不同时画「卡门口」冲突态。**卡死窗定义(域无关、两路统一可配)**:默认 = 该 app 最频繁 cron 周期 × `staleWindowMultiplier`(默认 2),MUST 支持 **per-app / view 侧 override**,并 clamp 到绝对 `floor`/`ceiling`(配置卫生:MUST `floor ≤ ceiling` 且 `multiplier > 0`,否则回落默认);无 cron 触发器的 app 用可配绝对上限。**已披露盲区(MUST 文案点明)**:合法慢 run、或稳态长-run pilot(每次 run 都合法 > 自身 2× 周期)会**稳态误报**「疑似卡住」——读模型无法从 `started_at` 年龄区分「慢但健康」vs「卡死」,倍率是**校准 knob**,须为这类 pilot 放宽窗。⚠️ 触发集 = `{failed, waiting_human, 超卡死窗的非终态(疑似卡住), 注册失败}`。

#### 场景:executing/running wedge 触员工级 ⚠️
- **WHEN** 某 run 卡在 `executing` 或 `running`,`started_at` 已超卡死窗(2× 周期 / 绝对上限)
- **THEN** 该员工呈「疑似卡住」⚠️(不得因是非终态就永久显「工作中」)

#### 场景:健康 mid-run 不误报
- **WHEN** 某 run 处于 `running`/`executing`,`started_at` 在卡死窗内
- **THEN** 呈「工作中」非 ⚠️(不误报卡住)

#### 场景:翻车报警
- **WHEN** 某 app 最近一次 run `failed`
- **THEN** 该员工呈「翻车」+ ⚠️,持续到你处理或有更近一次成功 run 取代

#### 场景:逾期 waiting_human 单一呈现
- **WHEN** 某 run 同时 `state:waiting_human` 且 `blocked:true`
- **THEN** 呈单一「🙋 举手 · 已逾期」+ ⚠️,不同时渲染「卡门口」冲突态

### 需求:本体存活 = 新鲜度启发式、终态按 endedAt、非终态由员工级卡住兜底
view MUST 提供一个 hangar 本体是否仍在运转的**新鲜度启发式**指示(非精确判死),不额外探进程、不改 core。**顶层「hangar 疑似停摆」仅当**最频繁 cron 触发器的**最近一次 run**(取 `started_at` 最新那条、**不论是否终态**;非「最近一次终态 run」)**已达终态**且 `now - 该 run.endedAt > 2× 其 cron 周期`时才提示——**用 `endedAt`(由 `runs --json` 暴露)而非 `startedAt`**,否则一个合法长 run(耗时 > 2 周期)刚完成时会被 `now - startedAt` 立即误报停摆。(逻辑自洽:若存在更晚的非终态 run,它的 `started_at` 本身证明 daemon 那刻 fire 过,故更早终态 run 的逾期与否 moot;更晚非终态若超窗由员工级「疑似卡住」兜底。)最近一次 run 为**非终态**时 MUST **抑制**顶层「停摆」——但该非终态若超卡死窗,已由上一需求的**员工级「疑似卡住」⚠️** 兜底(故 hung/崩溃遗留的 orphan 不会被读成「一切正常」)。该触发器**从未产出 run**(dev 手动测/无 daemon)MUST 报 `unknown`,不误报。**liveness MUST 从最频繁触发器所属 app 自己的 `runs <app> --json` 派生(带 `appId`,复用 office 已取的 per-app runs),MUST NOT 用无过滤的全表 `runs --json`**——否则 (i) 跨 app 同名/无名(`'cron'` 类别)trigger 会把别 app 的 run 混进来 = 假绿灯;(ii) 全表查询随历史无界增长,终将撑爆子进程 `maxBuffer` 致**每轮 poll 永久降级、不自愈**。**`unknown` MUST 严格限于「该 app 的 runs 成功返回、且无匹配该触发器的 run」**:若该 app 的 runs 调用失败,liveness MUST 呈「取数失败」(该 app 员工亦降 fetch_failed),MUST NOT 渲染成 `unknown`(否则取数失败伪装成「从没跑过」= 陈旧绿灯近亲)。触发器匹配 MUST 容忍**无名触发器**(`Run.trigger='cron'` 类别,见 core `executor.ts`,不得硬编码 `poll`);**具名时**(生产 inbox 的 poll/digest)按从 `app.yaml` 推出的最频繁触发器 `name` 匹配 `Run.trigger`。**已披露盲区(v1 接受、UI 呈「疑似」不断言):**(a) 手动 `hangar run --trigger <同名>` 写出与 daemon 同 `trigger` 的 Run,读模型无法区分「刚被人 replay」与「daemon 存活」——精确区分需 core 暴露 run source/心跳(改 core、越界、留 Phase C 过 #9);(b) `app.yaml` cron 改后未重启 daemon(core `startDaemon` 只 loadApps 一次)→ 存活是 daemon-config 相关启发式;(c) view 只读、`status/runs --json` 不暴露 `lock_owner`,故无法像 reaper 那样判「崩溃 daemon 的 orphan」——只能靠员工级年龄卡住兜底,不能区分「daemon 崩了」vs「某 pilot 动作卡了」(二者都呈该员工「疑似卡住」,这正是可操作信号)。

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

### 需求:CLI 取数失败即降级、粒度分明、绝不沿用陈旧绿灯
view 每 poll 多次 subprocess 调 CLI,失败 MUST **按调用粒度**降级、绝不崩溃或沿用上一轮陈旧数据冒充健康(陈旧绿灯 = 监控说谎):**顶层调用** `hangar status --json` / `doctor --json` **真失败**(非零退出 / 超时 / stdout 不可解析)→ 降级**页框**为「取数失败·重试中」。**关键:`doctor` 退出码恒 0,其 `{ok:false, checks}` 不是失败**——`doctor.ok` 含 `apps.every(spec==ok && pipeline==ok)`,故任一 app 坏就 `ok:false`,这是**正常态**。view MUST 用 `checks`,**仅当环境级 check 坏**(`checks.node`/`sqlite_writable`/`apps_dir != 'ok'`)才降页框;若**只是 per-app `spec`/`pipeline` 坏**,MUST 照常渲染 office、由「注册失败」呈员工级「配置坏了」⚠️(**MUST NOT** 因一个坏 pilot 清空整屋,也 MUST NOT 把永久配置错误冒充成暂时「取数失败·会自愈」)。**单 app** 的 `hangar runs <app> --json` 失败→**只**把该员工降为「取数失败·重试」,MUST NOT 因一个 app 偶发 `SQLITE_BUSY` 清空整屋。「取数失败」与「从没跑过 unknown」MUST 在 UI 上**可区分**(前者暂时故障、后者从未运行)。(core 用 DELETE journal + `busy_timeout=5000`,读写被序列化非真并发——写事务通常亚毫秒,但 view MUST 对偶发失败 fail-soft。)

#### 场景:单 app 取数失败只降该员工
- **WHEN** `hangar runs inbox --json` 抛 `SQLITE_BUSY`,而 `status --json` 成功
- **THEN** 只有 inbox 员工显「取数失败·重试」,其余员工与页框正常,下轮 poll 重试

#### 场景:doctor ok:false 区分环境级 vs app 级
- **WHEN** `doctor --json` 退 0 但 `ok:false`,且因**环境级** check(node/sqlite_writable/apps_dir)坏,或 stdout 不可解析
- **THEN** 降页框「取数失败」

#### 场景:某 app spec/pipeline 坏不清整屋
- **WHEN** `doctor --json` `ok:false` 仅因**某 app** `spec`/`pipeline != 'ok'`(环境级 check 均 ok)
- **THEN** view 照常渲染 office,坏 app 呈员工级「配置坏了」⚠️,健康 app 正常显示(MUST NOT 整屏降级、MUST NOT 冒充暂时故障)

### 需求:数据最小化 = 域无关 default-drop 白名单
为守脊柱零域(#1)+ 防泄露,`/api/state` 与 trace 抽屉 MUST 采用**域无关的 default-drop 白名单**:**只**返回 `events[].{seq, kind, at}`、run 的 `{state, trigger, startedAt, endedAt}`、派生态与计数;**丢弃全部 `RunEvent.payload_json` 的值**,`pendingApprovals` **只**呈 `{id, tool}`(**丢弃 `args`**)。MUST NOT 用「按敏感字段名裁剪(denylist)」——那要 view 知道哪些字段敏感(如 `notify.sent.subject` 是主题)=引域知识破 #1,且对任何非-email pilot 默认泄露。**关于 `kind`**:它被保留是基于约定「`kind` 是固定标签、数据在 `payload`」——但 `kind` 是 **app 自产、脊柱不约束其取值**(域事件 kind 自由,见 core `events.ts`),故「零泄露」非绝对保证,而是「保留固定标签、丢弃自由数据」的工程约定。**已披露 v1 降级**:default-drop 连脊柱自产的 `run.failed.payload.{error, reason}`(见 core `executor.ts`/`reaper.ts`)一并丢弃,故 ⚠️「翻车」抽屉能看清**在哪步/何时**失败(kind 时间线)但**看不到为什么**——失败原因须回 CLI `hangar trace <run>`;抽屉 MUST NOT 伪装成完整分诊器。**特例:daemon 崩溃重启**时 core `reap` 把在飞 run 一律推 `run.failed`(`reason:'reaped'`),会造成重启后**多员工同时「翻车」⚠️** 的瞬态浪潮——这是**预期的、下个 poll 周期自愈**(有更近成功 run 取代),且 v1 下 `reaped` 与真失败**不可区分**(reason 已被 default-drop 丢弃,须回 CLI trace);文案 SHOULD 点明,勿当成一队 pilot 同时真崩。要在抽屉呈脱敏错误摘要须由**域侧(pilot)**给明确脱敏契约,留后续变更单独过闸。

#### 场景:trace 抽屉只回生命周期、不回 payload/args
- **WHEN** 用户点开某员工,view 取该 run 的 `trace --json`(其 `events[].payload` 与 `pendingApprovals[].args` 是 core 原样返回的完整值)
- **THEN** view 只上屏 `{seq, kind, at}` 与 approval 的 `{id, tool}`,丢弃全部 payload 值与 args

#### 场景:非-email pilot 不默认泄露
- **WHEN** 未来接入非-email pilot(其 `payload_json` 含该域敏感数据)
- **THEN** 因 default-drop,view 无需改动即不泄露其 payload

### 需求:远程接入经 Cloudflare Tunnel + Access、v1 无 app 级登录
远程访问 SHALL 经 Cloudflare Tunnel(出站、无需在主机开入站端口),并 MUST 前置 **Cloudflare Access** 作边缘鉴权(用户身份,如 Google 账号),使只读页面**不裸露公网**。v1 MUST NOT 引入 app 级登录代码——鉴权是网络边缘的门,不是 app 内身份。app 级身份留待 Phase C 写路径落地时。**实现前 MUST 实测一次**「未通过 Access 的请求确被边缘 403」(此断言属部署期外部基建,仓内无从验证)。

#### 场景:未授权访问被边缘拦截
- **WHEN** 一个未通过 Cloudflare Access 的请求访问该页面
- **THEN** 在到达 view 进程之前即被 Cloudflare 边缘拦截(view 自身不实现登录)

### 需求:v1 只读、写路径不在本变更
本变更 MUST NOT 让页面执行任何写操作(approve/reject/重跑)。从页面处置 ⚠️(如点角色 approve)SHALL 留待后续变更,且届时 MUST 走 `hangar approve`(拒绝 root、原子认领)、并引入 app 级身份与防误触二次确认。

#### 场景:v1 不提供处置动作
- **WHEN** 某员工头顶 ⚠️(如 `waiting_human`)
- **THEN** v1 只呈现该状态、可点开看详情,但不提供 approve/reject 按钮(处置回 CLI)
