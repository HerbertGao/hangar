# Tasks — add-view-command-path

> 端到端 DoD 跨两个 repo:hangar-view(本仓)+ inbox(外部 repo)。§5 的 inbox 任务**不进 hangar openspec 的实现范围**,但列出以界定端到端可用;它们在 inbox 自己 repo 对着本 spec 的契约做。

## 1. 契约对齐(前置)

- [x] 1.1 与 inbox 敲定 `interpret-feedback` 的 input 字段名(如 `{text: string}`)与 `interpretation.proposed` 的 payload 形状(至少 `{add: string[]}`,是否携带候选上下文/计数供渲染)
- [x] 1.2 确认 `apply-feedback` input `{add: string[]}`、emit `feedback.applied {added, already_present}`、未知 trigger 走 `run.failed`(pilot loud default)——写进契约备忘/本 spec 已固定

## 2. hangar-view 后端:命令写端点

- [x] 2.1 加写端点(如 `POST /api/command`),入参 `{pilot, trigger, input}`;**白名单**校验 `(pilot,trigger)` ∈ `{(inbox, interpret-feedback), (inbox, apply-feedback)}`,非白名单直接拒绝、不发起 run
- [x] 2.2 经 subprocess 调 `hangar run <pilot> --trigger <trigger> --input <json>`(复用既有 CLI 消费方式;**不**直连 pilot、**不**直写 sqlite)
- [x] 2.3 映射退出码:`already_running`/退出码 1 → 结构化 `{busy:true}`(供前端「稍后重发」);`run.failed` → 失败(不伪装成功);成功 → 读该 run trace 取 `interpretation.proposed` / `feedback.applied`
- [x] 2.4 **不新增**表/库/进程/队列/游标(命令即时经 CLI 触发)

## 3. hangar-view 前端:两阶段确认流

- [x] 3.1 自然语言输入框(对 `inbox` 下达指令)
- [x] 3.2 提交 → 调 interpret 阶段(`interpret-feedback`,原始 NL);loading 态
- [x] 3.3 确认弹层:渲染 `interpretation.proposed`(解析结果,如候选发件人)供人核对;「确认」/「取消」
- [x] 3.4 确认 → 调 apply 阶段(`apply-feedback`,**结构化** `{add}`,非原始 NL);渲染 `feedback.applied` 结果(`added`/`already_present`)
- [x] 3.5 busy 提示:`{busy:true}` → 「inbox 忙,稍后重发」;失败 → 呈现失败(回 CLI trace 看原因)

## 4. 数据最小化放宽(仅确认视图)

- [x] 4.1 确认视图渲染 `interpretation.proposed` 结构化 payload(域数据);**确保** `/api/state` 与 trace 抽屉的 default-drop 白名单**不受影响、未被放宽**

## 5. inbox 侧(外部 repo,不在 hangar openspec 实现范围,端到端 DoD 需要)

- [x] 5.1 (inbox repo)`interpret-feedback`:input 原始 NL → LLM 解析为受约束的 `{add: string[]}`(LLM 输出当不可信、约束到已知动作)→ emit `interpretation.proposed`,**无写**
- [x] 5.2 (inbox repo)`apply-feedback`:input `{add}` → 对 `noise_senders.overlay` **tmp+rename 原子写 + set-union 幂等**、**不碰**人工 `rules.yaml` → emit `feedback.applied {added, already_present}`
- [x] 5.3 (inbox repo)loader 加载时把 overlay set-union 进降噪名单;未知 trigger 走既有 loud default(`run.failed`)

## 6. 不变量核对(合并前)

- [x] 6.1 **core 零改**:`git diff` 确认 `packages/core` 一行未改(`--trigger`/`--input`/`ctx.input`/`ctx.trigger` 均既有)
- [x] 6.2 无新表/库/进程/队列;view 仍只经 CLI + 只读 `app.yaml`,不直写 sqlite(#3/#6)
- [x] 6.3 写仅限白名单 `(pilot,trigger)`;无「run 任意 app + 任意 input」firehose
- [x] 6.4 apply 是可逆域副作用、不经 propose/approve/PARK(§3.5 carve-out);页面**仍不提供** approve/reject 审批处置(#5)
- [x] 6.5 数据放宽只在命令确认视图;`/api/state` 未泄露域 payload(#1)

## 7. 端到端验证 + self-check

- [x] 7.1 self-check(hangar-view):白名单 gate(白名单外被拒)+ 退出码映射(`already_running`→busy、`run.failed`→失败、成功→取事件)的可跑断言(小 `*.test.ts`,无框架)
- [x] 7.2 端到端:读 digest 通知 → web 输入「把 github 和 cloudflare 加进降噪」→ 确认视图显示解析 → 确认 → `feedback.applied`,inbox `noise_senders.overlay` 真被 set-union;全程不 SSH
- [x] 7.3 忙路径:inbox 正跑 poll 时下达命令 → 页面「稍后重发」,重发成功(幂等无重复)

## 不在本变更(留后续,各自过闸)

- typed intent 注册表 / `app.yaml` `intents:` 声明块 —— 第 2 个 web 可触发 intent 出现再抽
- 从页面 approve/reject 审批写路径 —— 接第一个带高危动作的 pilot 时才做(app 级身份 + 防误触)
- Telegram 双向入站(同契约第二张脸,见 `docs/proposals/control-plane-channels.md §7`)
- 通知集中(apprise-api / `@hangar/notify`)/ apprise.js —— 独立提案 P2,无依赖
