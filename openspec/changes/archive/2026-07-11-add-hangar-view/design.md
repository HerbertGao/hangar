# 设计 — add-hangar-view

设计 SOT 与完整背景见 `docs/proposals/hangar-view.md`(含 grilling 对齐纪要 8 条)。本文件只记 openspec 层要锁的技术决策与验证。

## 架构边界:为何只读 HTTP 不破不变量 #6

不变量 #6 =「v0 无 HTTP/IPC/MQ;**CLI 与 daemon 是 `@hangar/core` 的两个入口**,共享 SQLite、互不通信」。`hangar-view` 守住它的方式:

- `hangar-view` **不在 `@hangar/core` 内**、**不 import core**、**不经 IPC 与 daemon 通信**。它是**又一个 CLI 消费者**——像你/Claude Code 一样 subprocess 调 `hangar … --json`。
- 它引入的 HTTP **只存在于 view↔浏览器**,完全在脊柱之外。脊柱本身仍无 HTTP。
- 因此 core **零改**。这是本变更「不破 #6」的机制,不是口头承诺——核对项写进规格(`### 需求:只读呈现层…` 的「core 零改」场景)。
- 一旦 view 想**写**(点角色 approve)或想**低延迟推送**(WebSocket 直连 core),就不再零改 core——故 v1 坚决只读、坚决 poll,写路径留后续变更单独过闸。

## 数据源:subprocess CLI + 只读 app.yaml,不直读 sqlite

- 取数只经 `hangar status/runs/trace --json`(守 SKILL「一切经 CLI」)+ 只读 `app.yaml`(算 next-run 与 poll 周期;config 非状态,读它不碰事件时序)。
- **不直读 sqlite**:守脊柱 run 锁/事件时序不被绕过。**并发正确性说明(勿说反)**:core 用 **DELETE journal(非 WAL)**,读写**不并发**——DELETE 模式下 reader 与 writer 互斥、靠 `busy_timeout=5000` 硬等(db.ts 注明「WAL 读写并发 deferred、真需要再 re-add」)。view 每 poll 起只读 CLI 恰好制造 reader-vs-writer;写事务通常亚毫秒,实践风险低,但**这不是「安全兜底」而是「被序列化」**——偶发 `SQLITE_BUSY`/超时须由 view fail-soft 降级(见 spec `### 需求:CLI 取数失败即降级`),不是被 journal 模式消除。
- **不 in-process import core**:换取「view 与 core 无耦合、core 可独立演进」。代价:每次 poll 起一个 node 进程——单用户低频足够。
  `// ponytail: shell 每 poll 一进程;真嫌吵再改 in-process 只读函数(那时才引 core 依赖)。`

## 活跃度:近期活动 + 衰减情绪

cron 稀疏(poll `*/3`)+ 每 run 只几秒 ⇒ 前端 poll 几乎抓不到「正在跑」那一瞬,只照瞬时 `state` 会永远呈打盹、既无在场感也无分诊价值。故情绪由**最近一次 run** 的 `state`+时间戳派生。**映射覆盖 core `State` 全 7 枚举 + 无 run + 注册失败,有中性兜底**(round-2 review 抓出:原表把非终态一刀切当「工作中」会漏报 wedge)。**非终态按年龄分**(关键):`started_at`(`status.since` 暴露)在**卡死窗**(2× 周期 / 无 cron 时绝对上限)内→「工作中」;**超窗的任何非终态(`running`/`executing`/`queued`,`waiting_human` 除外)→「疑似卡住」⚠️**——否则 hung run(core `makeFireGate` 永久占 inFlight)会永显工作中。终态:`completed` 新鲜窗内→「刚搞定」、之后→「打盹」;`failed`→「翻车」⚠️;`cancelled`(仅 `hangar reject` 产生)→「收工·已驳回」中性;`waiting_human`→「举手」⚠️;无 run→「还没上过班」;`spec_invalid`/`app_unresolved`(经 doctor **`checks.apps[].spec`**)→「配置坏了」⚠️。花名册权威源=`doctor.checks.apps[]`(全 id 超集)左连 status,去重键 app id(round-3:防两源并集重复/静默省略)。卡死窗倍率 `staleWindowMultiplier`(默认 2)可 per-app override(round-3:防慢/低频 pilot 稳态误报)。(`action.failed`→`executing` 非 `failed`;`queued` 经 `createRun` 原子转 `running` 几乎不作持久 latest,保留兜底不编场景。见 core `events.ts`/`store.ts`。)

## 本体存活:两层(顶层停摆 + 员工级卡住),按 endedAt/年龄分,盲区显式

round-2 review 抓出:靠「无新 poll run」硬判死会双向说谎,且「非终态一刀切抑制 AWOL」把 wedge/崩溃 orphan 修成了「真死漏报」。故拆两层:
- **顶层「hangar 疑似停摆」**:仅当最频繁 cron 触发器最近一次 run **已达终态**且 `now - endedAt > 2× 周期`——**用 `endedAt` 非 `startedAt`**(G6:合法长 run 耗时 >2 周期,刚完成时 `now-startedAt` 会立即误报)。最近 run 非终态→抑制顶层停摆(否则崩溃 daemon 场景误报),但由下一层兜底。无 run→`unknown`。
- **员工级「疑似卡住」**(补顶层抑制的洞):最近一次非终态 run 的 `started_at` 超卡死窗(2× 周期/绝对上限)→ 该员工 ⚠️ 疑似卡住。这样 `executing`/`running` 的 hung run(`makeFireGate` 永久占 inFlight)、以及**崩溃 daemon 遗留的非终态 orphan**(view 只读永不 reap)都被年龄兜住,不被读成「一切正常」。
- **已披露盲区(UI 呈「疑似」不断言)**:(a) 手动 `run --trigger` replay 与 daemon 存活在读模型不可区分(精确区分需改 core→Phase C);(b) cron 改后未重启 daemon→存活是 daemon-config 相关;(c) `status/runs --json` 不暴露 `lock_owner`,view 无法像 reaper 判「崩溃 orphan」——只能靠员工级年龄卡住兜底,不能区分「daemon 崩了」vs「某 pilot 动作卡了」(都呈该员工「疑似卡住」,这正是可操作信号);(d) 触发器匹配容忍无名(`Run.trigger='cron'` 类别,勿硬编码 `poll`)。
- **配置对齐(G1)**:`hangar doctor --json` 的 `DoctorReport` **不回显** `HANGAR_APPS`/`HANGAR_DB` 路径(仅状态串),让它回显=改 core 破「零改」。故 view 由**显式 env** 启动(与 daemon launchd 同绝对路径)、**页面回显所用路径供人工核**、未显式设置(落 cwd 相对)则告警;盲区:view 只读无法自动探 daemon 侧 cwd 漂移。

## 远程 + 安全:CF Tunnel + Access + 数据最小化

- 传输 = Cloudflare Tunnel(出站、无需开端口);前置 Cloudflare Access(边缘鉴权,用户 Google 账号一道门)。**页面显示 inbox 运行活动,只读 ≠ 可公开**——Access 让它不裸奔,且是**零 app 代码**的网络门,不违背「写操作再做 app 级鉴权」。需一个用户控制的域名 + CF Zero Trust(用户已确认就绪)。
- 纵深防御 = 数据最小化,**域无关 default-drop 白名单(勿用 denylist)**:`/api/state`/trace 抽屉只回 `{seq,kind,at}` + run `{state,trigger,起止时间}` + 计数,**丢弃全部 `payload_json` 值**,approval 只回 `{id,tool}`(丢 `args`)。**为何不按敏感字段裁剪**:denylist 要 view 知道 `notify.sent.subject` 是主题=引域知识破 #1,且对非-email pilot 默认泄露;`trace --json` 原样返回完整 `payload` **和** `pendingApprovals.args`(core `cli.ts`),裁剪发生在 **view 进程**、core 不改。
- **round-2 review 抓出的两点诚实标注**:(1) `kind` 被保留是基于约定「kind=固定标签、数据在 payload」,但 `kind` 是 **app 自产、脊柱不约束取值**(域 kind 自由),故「零泄露」非绝对、是工程约定;(2) default-drop 连脊柱自产的 `run.failed.payload.error` 一并丢,故 ⚠️「翻车」抽屉看得清**哪步/何时**、看不到**为什么**——原因须回 CLI `hangar trace`,抽屉不伪装成完整分诊器(v1 接受降级)。要脱敏错误摘要须域侧给契约,留后续过闸。

## 美术解耦

CSS/DOM + emoji/简单 SVG 小人 + CSS 动画,先懒后精。美术层与数据/办公室模型解耦——占位角色先跑通,之后可无痛换精灵图/等距,不返工。

## 验证(dev 上已跑,支撑上述断言)

在 dev(`hangar.sqlite`,node v22.23.1)实测:
- `status --json` / `runs --json` / `trace --json` 形状与 SKILL 契约一致,真实数据可用。
- `trace` 含 pilot emit 的**域事件**(completed run 见 `run.started | notify.sent | run.completed`),抽屉内容有料。
- 一段 stdlib 派生脚本从真实 `status+runs` 产出「办公室模型」:heartbeat→`never_worked`、inbox→`napping`(上次搞定 4403 分前,durationSec 17)、alerts `[]`——**证明零改 core、shell CLI 即可派生员工态**。
- cron next-run/周期:**算法思路**可复用 hangar 已用的 `node-cron.getNextRuns`(`cli.ts` `cronPeriodMs`),但 view 承诺零 import core→**不能复用该函数**,须自带 `node-cron`+`yaml` 依赖、自实现约 15 行周期计算(含 `schedule: string|string[]` union),并加 view 侧自测(见 tasks)。
- 派生脚本对无 poll run 的 dev 库报 `pollLive:"unknown"`,验证了 unknown 边界。

**验证的诚实边界(review 抓出)**:dev 库**无 daemon、无 poll run**,只跑到 happy-path + `unknown` 分支。**两条最吃重的断言当时未验、靠本轮 review 修正**:①「非终态停摆下的判活」(dev 从未碰到「有 run 但停摆」,只碰到「从没跑过」)——已改为非终态抑制 AWOL;②「trace 裁剪 payload/args 且不引域知识」(当时只说「抽屉有料」、无断言证明邮件内容不上屏)——已改为 default-drop 白名单。「验证过」≠「覆盖高危分支」;实现后须对这两条 + CLI 失败降级补 view 侧 self-check。

## 备选方案(已否)

- **Tailscale**(主机已在 tailnet):私有、零公网、零鉴权,但手机要装客户端。用户倾向 CF Tunnel(任意浏览器可达),故取 CF Tunnel + Access 补上「不裸奔」。
- **员工 = 触发器粒度**(poll 员/digest 员):能让办公室现在更热闹,但用户定为 **1 pilot = 1 员工**(trigger 是他的不同任务),更对齐脊柱 app 模型;办公室随 fleet 增长。
- **in-process 读 core**:更省进程,但引入 core 耦合;单用户低频不值,留作性能兜底升级路径。
