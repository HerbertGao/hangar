# 提案 — 控制面通道:入站指令与出站通知

> ⚠️ **本文是_讨论与决策记录_,不是 OpenSpec 提案,也不是 SOT。** 架构 SOT 仍是 `DESIGN.md`;任何决策要落地,以后各自开 OpenSpec change。本文记录 2026-07 一次长讨论(含一轮多-agent 对抗评审)的来龙去脉与抉择,供实现时回溯"为什么这样定"。
>
> **状态:** 讨论对齐完成,seed 待开工;OpenSpec 提案暂缓(用户指示不着急)。
>
> **一句话:** 给 hangar 长出**双向控制面通道**——入站(人→pilot 下指令)与出站(pilot→人发通知)——但**两者都留在脊柱之外**,脊柱一行不改。入站 = 审计过的 `hangar run --input`;出站 = 各 pilot 自己投递,去重靠共享投递层(近期 apprise-api,长期可能自研 apprise.js)。

---

## 背景速览(冷读者 / 新 session 必读)

本文默认读者「在场」过原始讨论。若你是第一次看(或是一个新会话),先读这一节——本文用到的术语、机制事实、不变量编号,这里给读懂全文所需的最小集;完整定义在仓根 `DESIGN.md`(架构 SOT)与 `CLAUDE.md`(护栏)。

**这是什么项目。** hangar 是一根**无头的「AgentOS 脊柱」**:停放 / 调度 / 审计一队 `*-pilot` agent,自己不做业务。单用户、自托管、刻意极简。「脊柱」= `@hangar/core`,域无关;「pilot」= 一个具体 agent 应用(如邮件助手 inbox)。

**核心对象(整个系统一个 SQLite,仅 4 表):**
- `Run` / `RunEvent`(append-only,状态之源)/ `Approval` / `App`。
- **pilot = 一个 app,由单一 `app.yaml` 定义、被 host 进程内 `import` 跑**;不是常驻 server。
- pilot 的 `run(ctx)` 拿到:`ctx.input`(来自 CLI `hangar run --input`)、`ctx.trigger`(哪个具名触发器点的火,如 `poll`/`digest`)、`ctx.emit(kind, payload)`(追加一条 RunEvent)、`ctx.propose({tool, args})`(**唯一**动作入口)。
- 控制面 = CLI(`hangar run/status/trace/approve/reject/doctor/daemon`)+ 一个**只读** web 前端 `hangar-view`。**无 HTTP/IPC/MQ、无 MCP**;CLI 与常驻 `daemon` 是同一份 core 的两个入口、共享 SQLite、互不通信。

**审批 / PARK 流(#5 / #8):** 高危动作走 `ctx.propose` → 写 `Approval(pending)`、**不执行、不中断** `run()`;`run()` 返回后若有 pending → 该 run **park** 成 `waiting_human`;`hangar approve <run>` 执行**存在 Approval 行里的** `{tool, args}`(经 pilot 的 `tools.ts` handler),**不重入 `run()`**。全系统只此一个切点:`propose → approve → execute`。

**两个反复被引用的机制事实(本文多条决策的根据):**
- **park 占锁 → 会饿死调度。** 每 app 至多一个活跃 run;park 成 `waiting_human` 的 run **仍持 app 锁**,daemon 后续 cron 触发全部 `skip`(`DESIGN §3.4`)。→ **D1** 不 park 的根据。
- **`hangar run` 不排队、忙则硬失败。** `createRun` 在 DB 层强制「每 app 一个活跃 run」,pilot 正忙时再 `hangar run` 会**抛 `already_running`、退出码 1**(不排队、不静默丢)。→ **§7**「忙就回复重发」的根据。

**本文倚重的不变量(完整定义见 `DESIGN.md §1`,此处各一句话):**
- **#1 脊柱零域概念** —— core 里出现 `email`/`notify` 等具体业务名词 = bug;域细节只经 `RunEvent.payload_json` 流过。
- **#3 一 host / 一 SQLite / 4 表** —— 加第 5 张表要先在 DESIGN 论证。
- **#5 审批只在 OS 层** —— executor / app 代码不得自行处理审批。
- **#6 v0 脊柱内无 HTTP / IPC / 消息队列** —— 注意:pilot **对外**调第三方 API(Telegram/Lark)是普通 egress,不算破 #6;#6 管的是脊柱**内部**不搞 C/S 或消息总线。
- **#8 只有 `propose→approve→execute` 一个切点** —— 不做通用 durable replay / 中途 checkpoint。

**登场角色:**
- **inbox** —— 邮件分类 pilot,**已在 hangar 上**跑(cron `poll` 每 3 分钟 + 每日 `digest`)。它每天把「最近高频发件人 TOP5(可加入 `noise_senders` 降噪)」推到 Telegram;`noise_senders` 是它**自己 repo 里 `rules.yaml`** 的降噪名单。**本文的入站 seed = 让你不 SSH 上生产机也能处理这条建议。**
- **ai-radar / auto-developer / hostlens** —— 另外 3 个**独立 repo 的项目,目前尚未迁上 hangar**;都往**同一个群**推送、各写各的 Telegram 通知逻辑。它们是 **D8「集中通知」** 的多例证据(不是从一个例子猜出来的)。
- **hangar-view** —— 脊柱外一个**只读**的 web 监控前端(Phase 1.5,设计见 `docs/proposals/hangar-view.md`),经 Cloudflare Access 鉴权。**本文的入站 seed = 给它加第一条窄写路径**(它此前只读)。

**术语:**
- **seed-then-generalize** —— 只为眼前**一个真实用例**建具体实现,通用注册表 / 抽象等第 2、第 3 个真用例出现再抽。反「从一个例子造抽象」。
- **lane(车道)** —— 通知的抽象去向(`broadcast` / `private`);agent 只报 lane,真实目的地(哪个群 / DM / 平台)在配置里,agent 不知道。
- **intent** —— pilot 声明的、可被 web 触发的一个 typed 动作;**本质 = 既有的 `(--trigger, 不透明 --input)` 对**,不是新脊柱概念。
- **R1 / R2** —— 两条「接缝规则」候选;**R1(入站 = 审计过的 run)保留;R2(出站通知走审计日志给外部消费者)被毙**,见 §5。
- **apprise** —— 一个成熟的开源通知库,一处调用可发往 100+ 平台(Telegram、Lark/Feishu、Slack、邮件…);**它是 Python 项目**,故 TS 侧只能经 ① 它的 CLI 子进程 或 ② 它的 HTTP API 服务(`apprise-api` 容器)去接,或 ③ 自己移植。
- **apprise 集成的 A / B / C 三选项(D9/D10 反复引用):**
  - **A** = 直接用官方 apprise(经上面的 CLI 或 HTTP API)。
  - **B** = 只做你**实际在用的 2–3 个服务**的小 TS 库(~40 行,纯原生、零依赖)。
  - **C** = 把 apprise 的 100+ 服务 **1:1 移植**成 TS(即将来的独立产品 `apprise.js`)。
  - **抉择:近期走 A;长期认可 C 有价值,但 C 要从 B 增量长出、非大爆炸移植。**

---

## 0. 起点:两个真实痛点

1. **没有统一入口去指挥 agent。** 尤其:pilot 给出一个**推荐**(如 inbox digest 报「最近高频发件人 TOP5,可加入 `noise_senders` 降噪」),而要在推荐之上做处理(把某几个发件人加进降噪),今天必须 SSH 上生产机改 `rules.yaml`。外出时够不着。
2. **每个 agent 各写各的通知逻辑。** 现跑 4 个项目:inbox 私聊 DM 推送;ai-radar / auto-developer / hostlens 三个投同一个群,各自重复造 Telegram 逻辑。想抽出来集中管,让 agent「只说要广播,不关心落到哪」。

这两件事看似无关,讨论到后面发现它们是**同一个「渠道」子系统的两个方向**(见 §7)。

---

## 1. 决策总表

| # | 决策 | 一句话 | 守哪条不变量 |
|---|---|---|---|
| D1 | 入站推荐处理 = **run-with-input,不 park** | park 会占 app 锁、饿死 poll | §3.4 锁语义 |
| D2 | **seed-then-generalize** | 先落一个具体 intent,注册表/分析器推迟 | YAGNI |
| D3 | 统一入口在**脊柱之外**;typed 声明式 intent 推迟到第 2 个 | intent = 既有 `(--trigger, --input)` | #1 |
| D4 | 两条红线:**不放强制 `approval:` flag** / **控制面是 view 不是 framework** | 高危仍走 `ctx.propose` | #5 |
| D5 | 入站接缝 **R1 保留**;**R2 毙掉** | R2 把审计日志当队列,seq-per-run 建不出来 | #3 / #1 |
| D6 | **NL 翻译由 pilot 自己做**,view 是域无关透传 | 写前必须约束+确认 | #1 / #2 |
| D7 | Telegram 双向可做但**受约束、推迟**;**web textbox 是更懒的第一张脸** | 关联态住适配器、不碰脊柱 | #1 / #6 |
| D8 | 通知集中 = **共享投递层,不是脊柱 service**;agent 只说 lane | lane→目的地在配置里 | #1 / #6 |
| D9 | 后端选 **apprise**;lane = apprise **tag**;近期跑 **apprise-api** 容器 | 瘦适配器 `@hangar/notify` 是稳定接缝 | 脊柱外 |
| D10 | 长期 **apprise.js**(原生 TS)是**独立产品赌注**,从热路径服务**增量长**、非大爆炸移植 | 换后端不改 pilot | hangar scope 之外 |

---

## 2. D1 — 入站推荐:run-with-input,不 park

**问题形态被搞错过一次。** 一度设想:把 digest 的「TOP5 候选」做成 parked 提案,你在手机上 approve 子集。**这是错的切点。**

- `DESIGN §3.4`:一个 run 一旦 park 成 `waiting_human`,**仍持 app 的 active-lock**,daemon 后续 poll 触发全 `hasActiveRun → skip`。
- 「加降噪」是**低紧急度**决定,你可能搁几天。用它 park = 用一个你会拖延的决定**锁死 inbox 的 `*/3` 轮询**。

**正确形状:** digest 照旧 emit 候选、**completes**(释放锁);你有空时另起一个快 run 去应用:

```
digest run: emit 候选 → completed（不 park）
  ↓（你有空时）
入口 → hangar run inbox --trigger apply-feedback --input <决定>
  ↓
inbox 的 apply-feedback 分支:改自己的 noise_senders → completed
```

**无二次审批**——你的选择即授权;审计 = 该 run 的 trace(input + 一条配置变更事件)。`ctx.input` / `ctx.trigger` 已在 RunContext,脊柱零改。

**写侧域契约(round-1,仍有效):** `noise_senders` 现住 `apps/inbox/rules/rules.yaml`(人工维护、注释重、热重载只读)。apply-feedback 写一个**独立机器文件 `noise_senders.overlay`**(无注释),loader 加载时 set-union;写用 **tmp + 原子 rename**;set-union 保证幂等,emit `already_present[]`;人工文件保持人工。

---

## 3. D2/D3 — seed-then-generalize;统一入口在脊柱外

**只建一颗种子:** hangar-view 一个窄写函数 + inbox 一条 `apply-feedback` 分支。**不建**通用 intent 注册表、`intents:` 声明块、中央意图分析器。

**统一入口的形状(愿景,非今日实现):** 脊柱外一个「能 POST intent 的控制面」;每个 pilot **声明**自己可被 web 触发的 typed intent;入口只接受声明过的 `(app, intent, typed-args)`,无 freeform firehose。**关键认知:一个「intent」就是既有的 `(--trigger, 不透明 --input)` 对**,脊柱早就表达了它,不需要新脊柱概念。

**`intents:` 放哪(争议已判,推迟到第 2 个 intent):**
- 事实:`packages/core/src/registry.ts` 顶层 `SpecSchema` 是普通 `z.object`(**无 `.strict()` 无 `.passthrough()`**,只有 trigger 子 schema strict)。Zod 默认 **strip 模式**:未知键 `intents:` **既不 `spec_invalid`、又被剥出 typed `Spec`**——脊柱可证明地看不到它,只有 plugin 裸读 app.yaml 才看得到。
- 结论:`intents:` 放 app.yaml 安全(strip 证明脊柱无视)、**第 2 个 intent 才落**。
- **护栏(第 2 个 intent 时补):** strip 是**默认、非承诺契约**。有人将来加 `.strict()`(为抓 `enabld:` 这类拼写错)会**静默反转**——`intents:` 翻成 `spec_invalid`、pilot 加载即坏。故在 `SpecSchema` 上写一条注释「`intents:` 是 plugin 拥有的保留键,本 object 有意 strip 它,不先把 intents 挪走别加 `.strict()`」+ `DESIGN.md` 一行 + 一行自检。
- 别用现成的 `config:` 装 intents——它在 typed `Spec` 里、流进 `run()`,脊柱看得见,是 intents 不能待的地方。

---

## 4. D4 — 两条红线

1. **声明里绝不放强制 `approval:` flag。** 那会在 OS 之外造第二条审批路径 = 破 #5。高危动作的真正闸永远是 pilot 的 `run()` 里 `ctx.propose → OS Approval 表`。声明可带 `web: true`(plugin 自己的接受门,脊柱不知道 web 存在),但 `approval` 顶多惰性文档。
2. **控制面是「能 POST 的 view」,不是插件系统。** 没有 loader / 发现 / manifest / 生命周期 / 注册服务;「注册表」就是 app.yaml 文件集合、请求时扫。**绊线:一旦出现 `registerPlugin()` 或动态加载,就是在造平台——停。**

---

## 5. D5 — 入站接缝 R1 保留,出站 R2 毙掉

对抗评审的核心产出。

- **R1(保留,一句话):** 入站命令**只经审计过的 `hangar run --input`** 进入,永不做成 pilot 内部旁路。这几乎是复述既有不变量(CLI 是前门、RunEvent 审计),但有真牙口:新写路径不许变成直捅 inbox 的 webhook。
- **R2(毙掉):** 曾设想「出站通知 = 一条 `notify` RunEvent,由脊柱外适配器消费投递」。**机制本身就错**:
  - `store.ts:40` 证实 `seq` 是**每个 run 从 1 计**(`COALESCE(MAX(seq),0)+1 WHERE run_id=?`),**跨 run 没有全局单调序**。外部消费者无法持久记「已投递到哪」——没有全局游标。
  - ack 无处可去:改审计行=破 append-only;追加 `notify.delivered`=把投递态注入域无关日志 + 每次轮询 O(全部事件)。
  - 崩溃后从 0 重读 = 把历史通知全重推的**轰炸**;宕机重启把积压当实时发(过期警报)。
  - 投递从 run() 解耦 = 发失败不再是 run 失败、不 PARK,渠道挂了变**静默黑洞**(可观测性倒退)。
  - **审计日志 ≠ 投递队列**,两者需求相反。

**正解:** 出站通知**留在 pilot 内联**;去重靠共享投递(见 D8/D9)。若想让 hangar「看见」通知发生过,pilot 另 emit 一条 `notified` 审计事件——**审计与投递解耦**,别让审计事件_当_投递机制。

---

## 6. D6 — NL 翻译由 pilot 自己做

用户定:**要自然语言输入**(不只勾选),且**让 inbox 自己翻译**。这让 hangar-view 变成**纯域无关的哑 textbox**(原始 NL 当 `--input` 透传),比结构化勾选更守 #1(勾选还得让 view 渲染发件人),并**整体绕过 §3 的 intents 注册表**——没有中央解析器,pilot 自己解释自己的 NL,那套声明式机器现在一条都用不上。

**搬进 inbox 的硬要求(NL 一旦能触发写):**
- 解析产出**受约束的已知动作 + 参数**,不是任意执行;**LLM 输出当不可信输入**。
- **写前回显再执行**(emit `interpretation.proposed` → view 显示「理解为:…,确认?」→ 第二个 run 带结构化结果执行);或对**可逆**操作走「乐观执行 + undo」。**绝不盲执行模糊解析。**
- 两个快 run、别 park 跨人类思考时间;若 park 等确认也行——当场触发、park 窗口短。
- 解析出的动作若本质高危,仍走 `ctx.propose → OS Approval`(红线 1)。

---

## 7. D7 — Telegram 双向:受约束、推迟;web 是更懒的第一张脸

入站与出站其实是**同一个渠道适配器的两个方向**:

```
出站:  pilot --emit/调用--> [渠道适配器] --投递--> Telegram / Lark（private / broadcast）
入站:  Telegram（DM/回复）--> [渠道适配器] --hangar run --input--> pilot
```

对抗评审结论:**双向可做,但只在硬约束下,且比「对 bot 说句话」小得多:**
- 关联用 Telegram 原生 `reply_to_message.message_id`;适配器自持 `tg_msg_id → {pilot, run, context}` 映射——**关联态住适配器、不碰 RunEvent/脊柱**。
- 裸 DM「add github」路由不了(哪个 pilot?纯猜=陷阱)→ 必须「回复某条通知」命中映射,**或**显式 pilot 前缀(`/inbox add github`);无锚 → 响亮拒绝。
- **广播群只出站只读**;入站只收 owner DM + 白名单 `from.id`,其余静默丢。**「群里 @bot 去噪」被砍掉**——命令走私聊。
- `already_running` → 回「忙,一分钟后重发」,**别建适配器队列**;不承诺顺序,靠 set-union 幂等兜底;映射持久化 + TTL,miss 就 fail-loud 绝不猜。
- **诚实定性:** 真建这个适配器,它是**一个新的有状态常驻进程**(自持水位线 + 关联态),**不是**「hangar-view 的兄弟(按需只读)」——别用「就是个 CLI 消费者」把第三个守护进程蒙混过审。

**因此第一张脸选 web textbox 更懒:** web 表单在 POST 里免费带着 pilot+意图;Telegram 入站却把关联映射、路由、适配器状态全拖进来。Telegram 双向是个**有真实成本的后续功能**(值那个就地回复的 UX,但不是免费复用现有推送)。

---

## 8. D8/D9 — 通知集中 = 共享投递(apprise),lane = tag,近期 apprise-api

**「集中通知」的真需求 = 去重 + 目的地抽象**(agent 只说 broadcast/private,不知落哪)。这**不需要自建 service**,一个共享投递层就够;而 **apprise** 现成给了全部:

- **100+ 服务**,含 Telegram(`tgram://bot/chatid`)、**Lark/Feishu(`lark://<token>`=群机器人 webhook)**、Slack、Discord、邮件。库 BSD-2-Clause。
- **目的地 = URL,lane = apprise TAG。** broadcast/private 两模式 = 两个 tag;加平台/加群 = 改一处配置、零 agent 改动;TG+Lark 同 tag 自动 fan-out。
- 这比手写共享库更彻底:投递引擎 + 重试 + 格式化全包。

**近期(选定):走 A = Apprise API server**(`caronc/apprise` 容器,MIT)。存一次配置(URL 打 broadcast/private tag)进一个 KEY;`@hangar/notify` = 一句原生 fetch `POST /notify/{KEY}` `{tag, title, body}`。**TS 原生、无 Python、无 subprocess、语言无关、单一出口(顺带解决跨 pilot 限流)**。它整个在脊柱之外(就是个 HTTP 端点,跟 Telegram API 一样),脊柱不动。

**注:** 用户旧 fork `apprise-herbertgao` 是短期定制,**已弃用,只看官方**。

**与 D5 的关系:** apprise-api 恰好**替换**了 R2 里那个「走审计日志的自建消费者」,而 pilot 是**直接 HTTP 调它、不经 RunEvent**——seq-per-run 地雷根本不出现。

**时机:** apprise 跟 hangar 无关,那 3 个广播项目**今天就能全指到一个 apprise 实例、立刻消重复**,不必等迁移。

---

## 9. D10 — 长期 apprise.js:独立产品赌注,增量长

用户判断长期自研 **apprise.js**(1:1 原生 TS)有价值。约束(避免变成终身 treadmill):

- **不做大爆炸移植。** apprise 的价值是 100+ 集成沉淀的**正确性**(鉴权怪癖/转义/限流/错误映射/多年 issue),1:1 移植只复制**表面**、继承不到正确性,还要永远追上游。而你只用 2–3 个服务。
- **B 是 apprise.js 的种子。** 从你**真在用**的热路径服务开始写小 TS 库(~40 行/含 lane 的 `notify()`),**每加一个真实需求多覆盖一个服务**;攒够覆盖面 + 决定给别人用,才**毕业**成 apprise.js。需求驱动,非预建。
- **它是 portfolio 里的独立项目**,按自身价值(生态/维护胃口)评估,**不占 hangar 的 scope**;hangar 只消费适配器指向的后端。
- **演进接缝:** `@hangar/notify` 瘦适配器接口不变,后端从 `fetch(apprise-api)` 换成 `apprise.js` 进程内——**pilot 一行不改**。

---

## 10. 待推迟项 + 触发条件

| 推迟项 | 触发条件 |
|---|---|
| intent 注册表 + `intents:` 声明块 + `.strict()` 保留护栏 | **第 2 个** web 可触发 intent 出现 |
| 中央意图分析器 | 出现表单表达不了的 intent(注:已定 pilot 自己做 NL,中央分析器可能永远不需要) |
| Telegram 双向入站(受 §7 约束) | 想要「就地回复即命令」的 UX 时 |
| 共享投递(apprise)跨项目抽出 | **可现在就做**,与迁移解绑;近期 apprise-api |
| apprise.js 毕业 | 覆盖面够 + 决定发布给别人用 |
| 跨 pilot 通知限流(真队列) | 广播 burst 撞同一 bot/群限流(apprise-api 单出口已先缓解) |
| `DESIGN §0` 措辞修订 | 第 2 个 pilot 迁入时——§0 把「通知」列为脊柱吸收,应改成「通知去重靠共享投递(apprise/将来 apprise.js),投递不进 core」 |

---

## 11. 开放问题(部分已定,2026-07)

- **seed 第一张脸:** ✅ **定 web textbox 先行**。Telegram 回复 UX 更好但 plumbing 更多(§7 关联/路由/适配器态),作后续功能。
- **inbox 的 NL 应用策略:** ✅ **定 confirm-before-apply**——解析结果回显、人确认后才写;不走「可逆操作乐观+undo」那条(宁可多一次确认,不冒盲写风险)。
- **apprise 配置落点:** ✅ **定 3b = git 版本化的声明式 yaml**(URL+tag 提交进仓、部署喂给 apprise-api),不走 **3a = web-UI/API 运行时改的可变态**。理由同「`enabled` 落 `app.yaml` 而非 App 表列」——FS/声明式权威、随仓版本可控、可复现、无隐藏运行时态。具体挂载 vs 部署时 `POST /add` 是实现细节,但 SOT = git 文件。

---

## 12. 不变量账本(这轮所有决策都守住)

| 不变量 | 这轮如何守 |
|---|---|
| #1 脊柱零域概念 | intent = 既有 `(--trigger, --input)`;通知/渠道全在脊柱外;NL 解析在 pilot;`lane` 在 payload/适配器,core 永不 switch 它 |
| #3 一库 4 表 | 无第 5 表;适配器/apprise 的状态住自己的存储,不进 hangar.sqlite;R2(要后门游标表)被毙 |
| #5 审批只在 OS 层 | 声明不放强制 `approval:`;高危走 `ctx.propose` |
| #6 无 HTTP/IPC/MQ(脊柱内) | 适配器/apprise-api 是脊柱外端点;R2(DB 当消息总线)被毙 |
| #8 单一切点 | 入站是快 run、不新增 resume 切点;不做通用 durable replay |

---

## 附:方法论备注

本轮多数结论出自一次**多-agent 对抗评审**(软件架构 / 后端架构 / 工作流架构 / 最小化改动四个视角)。几个关键戳穿点由对抗轮独立发现——如「seq-per-run 让通知总线建不出来」「适配器不是 hangar-view 兄弟而是第三个有状态守护进程」「统一入口的 firehose 是最大安全隐患」。友好评审大概率放过这些,记此以志方法有效。
