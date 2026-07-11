# 提案 — hangar-view(「虚拟办公室」监控前端)

> ⚠️ **本文为历史设计提案。权威规范以 `openspec/specs/hangar-view/spec.md` 为准**(含 `endedAt` 判活、disable 排除等已实现的修正)。下文若与该 spec 冲突(如旧 liveness 用 `startedAt`、把 heartbeat 当可见/可配置的玩具工位),以 spec 为准。本提案保留作设计源流,不逐段回填。

> **状态:** 已与用户 grilling 对齐设计意图(见 §10 对齐纪要)。预研 + 设计完成,待开工。
> **定位一句话:** 脊柱之外的一个**独立、只读**呈现层——把每个 `*-pilot` 当成一名虚拟员工,让你**不碰 SSH / CLI**、外出时也能一眼看到「谁在忙、谁翻车、谁在等你拍板,以及 hangar 本体活没活」。
> **参照:** 腾讯 **Marvis Office**(3D 虚拟办公室,agent 化成角色坐工位、忙时干活闲时摸鱼)。我们取其**在场感 + 诊断嵌进场景**的思路,但用**最懒的 CSS/emoji** 实现,且服务于 hangar 的**远程 cron 监控**场景(非本地即时派活)。
> **第一个也是唯一用户:你自己**(外出远程监控)。**不是**"给别人用"的产品版。

本文档既是提案,也是未来 `hangar-view` 独立项目 `DESIGN.md` 的种子。

---

## 0. 核心设计(grilling 对齐结论)

| # | 决策 | 结论 |
|---|---|---|
| 核心作用 | 分诊 vs 在场感 | **两者同等、可在场感优先**;告警**诊断嵌进场景**——对应员工头上冒 ⚠️(像游戏角色的任务感叹号),不另开仪表盘。整体**游戏画面感**。 |
| 员工粒度 | 谁是"员工" | **1 个 pilot = 1 名员工**。inbox 就一名员工;poll/digest 只是他**不同时段的不同任务**。以后接 ai-radar / ppt-pilot,每个**不同职责(不同 prompt)的 agent 各算一名**。办公室随 fleet 增长。 |
| 读写边界 | 只读 vs 可操作 | **v1 只读**(零改 core、CF Access 边缘鉴权就够、零写风险)。**架构预留写路径的缝**:接入第一个带审批 pilot 时,首个升级 = 「点角色 → approve/reject」。 |
| 渲染保真 | 美术档位 | **CSS/DOM + emoji/简单 SVG 小人 + CSS 动画**。美术层与数据/架构**解耦**,先懒后精、可无痛换精灵图/等距。 |
| 活跃度 | 瞬时 vs 情绪 | **近期活动 + 衰减情绪**:角色情绪由**最近一次 run** 推出并随时间衰减(cron 稀疏 + run 只几秒,瞬时态会永远只看到打盹)。 |
| 本体存活 | 要不要报警 | **要,派生式检测**:poll(*/3)逾期 2× 周期没新 run → 判 hangar 疑似挂,**顶层报警**(灯灭/全员 AWOL)。监控工具必须 fail loud。 |
| 远程接入 | 怎么够到 | **Cloudflare Tunnel + Cloudflare Access**(边缘鉴权,零 app 登录)。数据**最小化**:不渲染邮件正文/主题原文。 |
| 实现时机 | 路线图排期 | **Phase 1.5,与出口闸并行、现在就做**。它服务于"7 天每天用"这道闸(好玩→你更愿意天天开)。唯一警惕:别抢了真正用 inbox 的注意力。 |

---

## 1. 与 hangar 治理的关系(先立规矩)

文档现状把这类东西叫 **web workbench**,列为**非目标 / 永不做(除非独立立项)**(`CLAUDE.md` 非目标 · `ROADMAP.md`「明确不在路线图上」· `DESIGN.md:243`)。本提案**不推翻**、只**收窄**:要的不是"给别人用的 workbench",而是**单用户、只读、外出巡检**的私人视图。它仍是**独立赌注**(ROADMAP:75),所以**必须零改 hangar core**。三条不变量的兑现:

| 不变量 | 风险 | 如何不破 |
|---|---|---|
| **#6 v0 无 HTTP / IPC / MQ** | 监控页要数据,想给脊柱加 HTTP | core **一行不改**。view 是**另一个进程**,像你/CC 一样 **subprocess 调 `hangar … --json`** + 只读 `app.yaml`。HTTP 只在 view↔浏览器,**完全在脊柱之外**。 |
| **#7 不上 MCP** | — | 不涉及。 |
| **SKILL「一切经 CLI、别直读 sqlite」** | view 想直连 sqlite | v1 **只经 CLI `--json`** + 只读 `app.yaml`(config,非状态),不碰 sqlite 文件。 |
| **#9 改架构先改 DESIGN.md** | 悄悄加了个 web 面 | ratify 时同步 §9 的 DESIGN/ROADMAP 记账。 |

> **红线:** 一旦要**写**(点角色 approve)或要**低延迟推送**(WebSocket 直连 core),就不再零改 core。**v1 坚决只读、坚决 poll**,写路径留 Phase C 单独过闸。

---

## 2. 动机 / 为什么现在做(Phase 1.5)

- **痛点真实:** 生产在 `ts.mac-mini`,人不在机器旁时查 run 只能 SSH + 手写脚本;那台 **ssh-agent key 会被 evict**,外出更麻烦。
- **它服务于出口闸,不与之竞争:** 出口闸 = "7 天每天真在用"。一个好玩的办公室让你**更愿意天天开 hangar** → 直接推动这道闸。且**零改 core、只读**,不可能危及闸;换谁当 pilot 都复用。
- **游戏化 fleet 扩张:** 每加一个 pilot 多一名员工——"招人"的成就感正好驱动 Phase 2。

---

## 3. 范围

**v1 in-scope:**
- 一页「虚拟办公室」:每个 pilot 一名**员工角色**,情绪照**最近一次 run** 衰减呈现;头顶 **⚠️** 表分诊。
- **顶层本体存活**指示:poll 逾期 → 全员 AWOL 大报警。
- 点一名员工 → 抽屉展开该 pilot **最近一次 run 的事件时间线** + 最近几次 run 成败(= `trace` / `runs`)。
- **远程可达**(CF Tunnel + Access),手机友好,无需 SSH/CLI。
- 自动刷新(poll ~10s)。

**明确非目标:**
- ❌ 从页面 approve/reject(写路径)→ Phase C。
- ❌ 多用户 / app 级登录 / RBAC / 计费(CF Access 边缘鉴权就够)。
- ❌ 原始进程日志聚合(launchd `~/hangar-inbox.{out,err}.log`,脊柱外)——只呈现结构化 RunEvent。
- ❌ 邮件正文/主题原文上屏(数据最小化)。
- ❌ 实时逐步进度流 / WebSocket、编辑 config、公网裸奔、原生 App、3D 引擎。

---

## 4. 架构(最懒可行版)

```
浏览器(手机, 经 Cloudflare Tunnel + Access 边缘鉴权)
        │  HTTP GET / , /api/state   ← 唯一网络面, 在脊柱之外
        ▼
  hangar-view  (独立进程 / 独立 package, 跑在 ts.mac-mini)
        │  ① child_process: `hangar status/runs/trace --json`   (状态 + 历史 + 时间线)
        │  ② 只读 app.yaml (cron 表)                            (下次上班 + poll 逾期判活)
        ▼
  hangar CLI (@hangar/core 只读入口, 零改)  →  只读打开 hangar.sqlite
                                                (busy_timeout, DELETE journal; daemon 照常写)
```

**三个实现选择,全取最懒档:**

1. **数据源 = 现成 CLI `--json` + 只读 `app.yaml`,不直读 DB。**
   `status/runs/trace --json` 已是完整 read-model;`app.yaml` 给 cron 表(算下次上班 + 判 poll 逾期)。view 不 import core、不碰 schema。
   `// ponytail: 每次 poll 起一个 node 进程;单用户低频足够。真嫌吵再改 in-process import @hangar/core 只读函数。`

2. **本体存活 = 纯派生,不额外探进程。**
   `now - 最近 poll run.startedAt > 2×(poll 周期)` → hangar 疑似挂。数据全在 runs + app.yaml。
   `// ponytail: 派生判活够狠且零耦合;真要精确再 ping launchctl。`

3. **前端 = 单个静态页 + 原生 JS poll,无构建步骤。**
   `fetch('/api/state')` 每 ~10s;情绪衰减在**客户端**按时间戳算(服务端只给原始时间/状态)。角色/工位/动画全 CSS。
   服务端本体:Node 标准库 `http`,两路由(`/` 静态页、`/api/state` JSON),~60 行,不引 Express。

---

## 5. 数据映射(办公室元素 ← 现成来源)

| 办公室元素 | 数据来源 | 现成? |
|---|---|---|
| 员工角色(每个 pilot) | `status --json` 每行 = 一个 app | ✅ |
| 情绪(照最近一次 run 衰减) | `runs <app> --json` 最近一条的 `state` + `endedAt` | ✅ |
| 当前在忙哪份活 | 最近一条 run 的 `trigger`(poll/digest) | ✅ |
| 头顶 ⚠️(见 §6 条件) | `state` + `blocked` + 逾期派生 | ✅ |
| 下次上班时间 / 打盹倒计时 | 只读 `app.yaml` 的 cron | ✅(view 侧算) |
| **本体存活(全员 AWOL)** | 最近 poll run 时间 vs poll 周期 | ✅(派生) |
| 抽屉:单次工作时间线 | `trace <run> --json` 的 `events` | ✅ |
| 抽屉:最近出勤/翻车 | `runs <app> --json` 历史 | ✅ |
| 待办审批摘要(未来) | `trace.pendingApprovals` | ✅(v1 只显不执行) |
| 原始控制台日志 | 无(launchd 文件,脊柱外) | ❌ 不做 |

**结论:办公室要的一切都被现成 `--json` + `app.yaml` 覆盖,v1 真能零改 core。**

---

## 6. 状态 → 角色映射(草案,先懒后精)

| hangar 情形 | 角色表现(CSS/emoji) | ⚠️ |
|---|---|---|
| 距下次 cron 还早(闲) | 打盹 💤 / 喝咖啡,台灯暗 | — |
| 刚 `run.started`(偶尔实时抓到) | 起身敲键盘 ⌨️ | — |
| 最近一次成功(衰减窗口内) | 打勾 ✅ / 伸懒腰,满足脸,渐归打盹 | — |
| `failed` / 翻车 | 瘫坐 💥,持续到你处理或下次成功 | ⚠️ |
| `blocked`(被过期 parked run 阻塞) | 卡门口/僵住 | ⚠️ |
| `waiting_human` 举手(未来带审批 pilot) | 🙋 跑到你桌前站着 | ⚠️ |
| `running` 超时(卡死过久) | 冒汗/风扇狂转 | ⚠️ |
| **hangar 本体疑似挂(poll 逾期)** | **全办公室灯灭 · 全员 AWOL · 顶部横幅** | ⚠️⚠️ 顶层 |

> heartbeat 玩具默认渲染成一个**明显标注的"玩具工位"**(它是当前唯一能触发 `waiting_human` 举手态的东西,开发期用来肉眼验 🙋);可配置隐藏。

---

## 7. 远程接入与安全

- **传输:** Cloudflare Tunnel(cloudflared 从 ts.mac-mini 出站,无需开端口),前置 **Cloudflare Access**(Zero Trust,用你 Google 账号一道边缘门)。**需要:一个你控制的域名 + CF Zero Trust 配置。**
- **为什么加 Access:** 页面显示 inbox 运行活动,**只读 ≠ 可公开**。Access 是**零 app 代码**的边缘鉴权,不违背"写操作再做 app 级鉴权"的意愿——它是网络门,不是 app 登录。
- **数据最小化(纵深防御):** 即便有 Access,`/api/state` 也**只回派生态**(状态、时间、成败计数、trigger 名),**不回**邮件主题/发件人/正文。trace 抽屉只显生命周期事件 kind,domain payload 里的敏感字段**服务端裁剪**后再上屏。
- **认证升级点:** v1 只读靠 Access 网络门;**Phase C 加写操作时**再引入 app 级身份(谁点的 approve、防误触二次确认)。

---

## 8. 分期

- **Phase A — 预研 + 设计(已完成):** 本文档 + grilling 对齐(§10)。**待你验证:** CF Tunnel/Access 的域名与 Zero Trust 是否就绪(`ts.mac-mini` 已在 Tailscale,但你选 CF Tunnel)。
- **Phase B — v1 只读办公室(Phase 1.5,现在做):** §4 全量。CSS 角色 + 情绪衰减 + ⚠️ + 顶层本体存活 + 点开抽屉(trace)。CF Tunnel+Access。**验收:外出用手机打开,3 秒看清 inbox 员工近况 + hangar 活没活,全程不碰 SSH/CLI。**
- **Phase C — 后续(各自单独过闸):**
  - 「点角色 → approve/reject」**写路径**(接入第一个带审批 pilot 时)→ 引 app 级身份 + 防误触。
  - 更多 pilot = 更多员工(接 ai-radar / ppt-pilot 自动出现)。
  - 若 poll 延迟难忍 → SSE 推送;美术升级精灵图/等距。

---

## 9. ratify 时需要的治理改动(现在不改,列清单)

按不变量 #9:

- **`DESIGN.md`**(非目标/OUT 或新增一节):把「web workbench 永不做」**收窄**为「**单用户、只读、经 CLI、零改 core** 的私人巡检 view = 显式接受的独立赌注;给别人用的多租户 workbench 仍永不做」。记录**为何不破 #6**(HTTP 在脊柱外、view 是 CLI 消费者)。
- **`ROADMAP.md`**:新增 **Phase 1.5 · hangar-view**(与出口闸并行);注明 Phase C 写路径需重新过闸。
- **仓库归属:** 文档立场是"新 repo"。**建议:预研 + v1 dogfood 先作为 hangar 仓内独立 package**(独立进程、独立 HTTP、与 core **无 import 依赖**,只 subprocess 调 CLI),等真要"给别人用"再 graduate 成独立 repo。既守住"独立进程不破 #6",又不为单用户预研先搭空 repo。

---

## 10. 对齐纪要(grilling 结论,逐条落地依据)

1. 核心作用 = **在场感 + 分诊并重**,⚠️ 冒在对应员工头上(游戏感),不另开仪表盘。
2. 员工 = **pilot 粒度**(inbox 1 名;trigger 是他的不同任务;fleet 增长加人)。
3. **v1 只读**,预留写路径的缝(approve = 首个 Phase-C 升级)。
4. 美术 = **CSS/emoji**,解耦可换。
5. 活跃度 = **近期活动 + 衰减情绪**(`runs --json` 最近一条)。
6. 本体存活 = **派生式报警**(poll 逾期 2× → 全员 AWOL)。
7. 远程 = **CF Tunnel + CF Access**;数据最小化。
8. 时机 = **Phase 1.5,现在做**,服务出口闸。

---

## 11. 尚未拍板 / 我先默认的小项(可否决)

- **仓库:** 先作 hangar 仓内独立 package(默认)/ 立刻开新 repo?
- **poll 间隔:** 默认 ~10s。
- **heartbeat:** 默认渲染成标注的"玩具工位"、可隐藏。
- **Telegram `/status` interim:** 你们已在用 Telegram 推 digest/P0;一个 `/status` bot 命令(~20 行、复用现成通道、零前端)可作 Phase B 之前的**零成本过渡**,让"外出查状态"立刻有着落。要不要先上?(推荐要,与办公室不冲突、共用同一 `--json`。)
