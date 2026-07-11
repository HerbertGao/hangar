## Why

出口闸(Phase 1)= 「连续 7 天每天真在用 inbox pilot」。但今天要看 hangar 在生产(`ts.mac-mini`)上跑得怎样,只能 SSH + 手写 better-sqlite3 脚本;那台机的 ssh-agent key 还常被 evict——**外出时几乎查不了**。一个不碰 SSH/CLI 的呈现层能让你**更愿意天天开 hangar**,直接服务于这道闸本身。

参照腾讯 **Marvis Office**(虚拟办公室:每个 agent 化成角色坐工位,忙时干活、闲时摸鱼,状态实时可视)。我们取其**「在场感 + 诊断嵌进场景」**——每个 pilot 一名虚拟员工,翻车/等你拍板时该员工头顶冒 ⚠️(像游戏里的任务标记),而不是另开一块冷冰冰的仪表盘。

这是**独立赌注、零改 core**(不是脊柱能力):view 像你/Claude Code 一样**以 subprocess 调 `hangar … --json`** + 只读 `app.yaml`,HTTP 只存在于 view↔浏览器、**完全在脊柱之外**,故不破不变量 #6/#7。DESIGN/ROADMAP/CLAUDE 已 ratify 收窄「web workbench 永不做」为「**多用户** workbench 永不做;单用户只读私人 view 是显式接受的例外(Phase 1.5)」。设计 SOT:`docs/proposals/hangar-view.md`。

**可行性已在 dev 上验证**(见 `design.md` §验证):`status/runs/trace --json` 形状与契约一致、真实数据可派生「办公室模型」(情绪/⚠️/时长)、trace 含 pilot emit 的域事件(`notify.sent`)、cron next-run/周期 hangar 自己已用 `getNextRuns` 做。验证还抓出一个约束:**无 poll run 的库要报 `unknown` 而非误警 AWOL**——已纳入规格。

## What Changes

**新增 `hangar-view` 独立 package(仓内 `packages/hangar-view`,零 import `@hangar/core`):**
- **只读呈现层**:一个 Node 标准库 `http` 服务(~两路由:`/` 静态页、`/api/state` JSON),跑在 `ts.mac-mini`。**不碰 sqlite 文件**,只 subprocess 调 `hangar status/runs/trace --json` + 只读 `app.yaml`(config,非状态)。
- **办公室模型**(`/api/state` 派生):**每个 pilot(app)= 一名员工**;情绪照**最近一次 run** 推出并随时间衰减(cron 稀疏 + run 只几秒,瞬时态会永远只看到打盹),**映射覆盖 core `State` 全 7 枚举 + 无 run、含中性兜底**(`queued`/`executing`→工作中、`cancelled`→收工);当前在忙哪份活 = 最近一条 run 的 `trigger`;下次上班 = `app.yaml` cron 算(**复用算法思路、非 import core 函数**,view 自带 `node-cron`+`yaml`)。
- **诊断嵌进场景(按年龄分)**:员工头顶 ⚠️ = `failed` / `waiting_human` / **超卡死窗的任何非终态(`running`/`executing`/`queued`)→ 疑似卡住** / `blocked` / **注册失败(`spec_invalid`)**。非终态在卡死窗内=「工作中」非 ⚠️,超窗才报卡住(否则 hung `executing` run 永显工作中、`makeFireGate` 永久占 inFlight 却静默)。`blocked ⊂ waiting_human` 合一为「举手·已逾期」。游戏画面感(CSS/emoji,美术解耦)。
- **本体存活 = 两层启发式**:①顶层「hangar 疑似停摆」仅当最频繁 cron 最近一次 run **已达终态**且 `now - **endedAt** > 2× 周期`(用 `endedAt` 非 `startedAt`——合法长 run 刚完成会被 startedAt 误报);非终态抑制顶层。②非终态由**员工级「疑似卡住」**(上一条,按 `started_at` 年龄)兜底,故 hung run / **崩溃 daemon 遗留 orphan**(view 只读永不 reap)不被读成「一切正常」。无 run→`unknown`。盲区(UI 呈「疑似」):手动 replay 与 daemon 存活不可区分、cron 改后未重启、`status/runs` 不暴露 `lock_owner` 故不能区分「daemon 崩」vs「pilot 卡」——精确区分需改 core、留 Phase C。
- **CLI 取数失败即降级(粒度分明)**:单 app `runs <app>` 失败→**只**降该员工「取数失败·重试」;顶层 `status`/`doctor` 失败(含 `ok:false`/不可解析)→降页框;**不因一个 app 偶发 `SQLITE_BUSY` 清空全屋**;「取数失败 unknown」与「从没跑过 unknown」UI 可区分。
- **配置对齐(改法修正)**:`hangar doctor --json` **不回显** `HANGAR_APPS`/`HANGAR_DB` 路径(让它回显=改 core),故 view 由**显式 env** 启动(与 daemon launchd 同绝对路径)+ 页面回显所用路径供人工核 + 未显式设置则告警;盲区:view 只读无法自动探 daemon 侧 cwd 漂移。
- **远程 + 安全**:Cloudflare Tunnel(出站)+ **Cloudflare Access**(边缘鉴权,零 app 级登录);数据最小化用**域无关 default-drop 白名单**——`/api/state`/trace 抽屉只回 `{seq,kind,at}` + run 生命周期 + 计数,**丢弃全部 payload 值**、approval 只回 `{id,tool}`(丢 `args`),**不按敏感字段名裁剪**(那要域知识、破 #1、对非-email pilot 默认泄露)。
- **写路径的缝(不在本变更)**:v1 只读。架构预留「点角色 → approve/reject」,留待接入第一个带审批 pilot 时做(届时引 app 级身份 + 防误触)。

## Capabilities

### New Capabilities
- `hangar-view`: 脊柱外、单用户、**只读**的运行呈现层——把每个 pilot 呈现为一名虚拟员工(情绪照最近一次 run 衰减)、诊断(⚠️)嵌在员工上、本体存活派生报警;经 `hangar … --json` + 只读 `app.yaml` 取数(不直读 sqlite),经 Cloudflare Tunnel+Access 远程 + 数据最小化。**零改 `@hangar/core`**(HTTP 在脊柱外、view 只作 CLI 消费者,守 #6/#7)。

### Modified Capabilities
- (无。本变更**不改任何现有 core 能力**——这是「零改 core」的直接体现,也是它不破不变量 #6 的方式。)

## Impact

- **新增 `packages/hangar-view`**:独立进程、独立 `http`、**与 `@hangar/core` 无 import 依赖**,只 subprocess 调 CLI + 只读 `app.yaml`。self-check(必须覆盖 review 抓出的高危分支):①mood 映射对 `State` 全 7 枚举 + 无 run 皆有非-undefined 结果;②**非终态最近 run 抑制 AWOL**(喂 `waiting_human`/`running` 样例断言不报挂);③数据最小化 default-drop(喂含 payload/args 的 trace 样例断言输出无 payload 值/无 args);④CLI 失败降级(喂非零退出/超时断言降 unknown+不沿用旧值)。
- **`@hangar/core`**:**一行不改**(核对项:无新 HTTP/IPC in core;`hangar-view` 不在 core 内、不经 IPC 与 daemon 通信,只读同一 SQLite 经 CLI)。
- **治理(已 ratify,#9)**:`DESIGN.md` OUT 段 + `ROADMAP.md`(新增 Phase 1.5)+ `CLAUDE.md` 非目标——已收窄「web workbench 永不做」为「多用户版永不做,单用户只读 view 立项例外」。设计 SOT `docs/proposals/hangar-view.md`。
- **部署(`ts.mac-mini`)**:build `hangar-view` + 起一个只读进程 + `cloudflared` tunnel + CF Access(需一个用户控制的域名 + CF Zero Trust,用户已确认就绪)。与现有 launchd daemon **并列、互不影响**;view 挂了不影响脊柱。
- **不在本变更**:从页面 approve/reject 写路径(Phase C,接第一个带审批 pilot 时,届时才引 app 级身份)· 多用户/RBAC · 原始进程日志聚合(launchd 文件、脊柱外)· WebSocket 实时推送 · 3D/精灵图美术升级。
- **相关**:Telegram `/status` bot 命令(复用现成通道、零前端)作 Phase B 之前的零成本过渡——**不在本变更**(inbox pilot 外部 repo,单列)。
