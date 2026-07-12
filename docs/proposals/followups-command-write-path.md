# Followup — 命令写路径 / noise-feedback 上线后待办

> 记于 2026-07-13,`add-view-command-path`(hangar #10)+ inbox #42/#43 合并、部署 ts.mac-mini、生产 live 验通后。功能已上线。以下是**刻意不在本次范围、后续按触发再做**的项。
> 设计层的推迟项见决策记录 [`control-plane-channels.md`](./control-plane-channels.md) §10;本文含其实现/验证/运维层的补充,有重叠。**原则同旧:触发驱动,不投机建。**

---

## A. 推迟的能力(触发驱动)

| 项 | 触发条件 |
|---|---|
| **typed intent 注册表 + `app.yaml` `intents:` 声明块 + `.strict()` 保留护栏** | 第 2 个 web 可触发 intent 出现。现 v1 在 hangar-view 里**硬编码白名单** `(inbox, interpret-feedback\|apply-feedback)`;第 2 个 intent 才值得抽注册表。`intents:` 放 app.yaml 靠 strip-mode 无视(见决策记录),那时补"别加 `.strict()`"的保留注释。 |
| **从页面 approve/reject 审批写路径** | 接第一个带**高危动作**(走 `ctx.propose → PARK`)的 pilot。届时引 **app 级身份 + 防误触二次确认**,走 `hangar approve`。本次的命令写路径只是"下达命令",不含审批处置。 |
| **Telegram 双向入站**(命令的第二张脸) | 想要"就地回复通知即下命令"。照 `control-plane-channels §7`:reply-correlation 用 Telegram 原生 `reply_to_message.message_id`、映射住**适配器本地**(不碰脊柱)、**owner-DM-only + 白名单 from.id**、裸 NL 需 pilot 前缀、`already_running`→"忙重发"不建队列;适配器是**新的有状态常驻进程**(非 hangar-view 那种只读视图)。 |
| **通知集中:apprise-api / `@hangar/notify`;长期 apprise.js** | 独立提案 P2。跨 4 项目去重可**先做**(与 hangar 迁移解绑);后端走 **apprise**(lane=tag,broadcast/private),近期 apprise-api 容器、TS 原生 fetch。`DESIGN §0` 措辞("脊柱吸收通知")与"通知留 pilot"矛盾,待 **pilot #2** 迁入时改成"共享库去重、投递留 pilot 侧"。 |
| **非 TOP-5 / 任意发件人加降噪** | 撞到"想加一个 digest **TOP-5 之外**的发件人"。现 interpret **只匹配 digest 展示的 TOP-5**(#43),confirm 里看不到其它;这正是将来 **freetext / LLM 意图解析**的真实触发点(现有确定性子串匹配是零幻觉的最小形态)。 |

## B. 验证缺口

- **§7.3 busy 路径 live 编排**:并发命令撞 inbox poll → 页面「稍后重发」→ 重发幂等成功。现**机制已单测**(`classifyRunExit` busy + core `already_running`)+ 生产 gate 验(403/415),但**未真并发跑一遍**。补一个:趁 inbox mid-poll 打命令,断言页面 busy + 重发成功、overlay 无重复。
- **interpret happy-path 自动化 e2e(防 fixture-drift)**:现靠单测(**手写 fixture**)+ 手动 prod 验。Review 里 Reality Checker 提过风险——`classifyRunExit`/`pickEventPayload` 用手写 fixture,若 core `hangar run --json` 输出形状**漂移**(如 busy 的 `{ok:false,kind}` 落 stdout、run.failed 的 `{run,state}` 无 kind),测试**仍绿而生产静默坏**。加一条对 stub pilot 的**真实 `hangar run`** 断言,锁 CLI 输出形状。

## C. 技术债 / 小改(咨询级)

- **trace 读仍同步**:命令成功后读 trace 用同步 `callCliJson`(10s 上限);async 化只改了 60s 的 `hangar run` 段。残留 ≤10s 事件循环冻结(与既有 `/api/state` 轮询同量级)。若在意监控在命令期完全不冻,把 trace 读也异步。
- **§1e 微清理**:`safeParse`(单调用者)可内联;`readJsonBody` 的 `limit` 形参从不被改(可硬编码进函数体)。net 减几行,不急。

## D. 运维 / 流程

- **openspec 归档的头风格标准化**:本次 `add-view-command-path` 走了**手动归档**——delta 用英文结构标题(为过 openspec-cn **1.5.0** validate),主规范用中文标题,1.5.0 的 `archive` 按头文本匹配 MODIFIED(`Requirement:` ≠ `需求:`)→ 无法 auto-sync。定个标准:① 升 **1.6.0**(用户已在)测其 `archive` 是否 CN/EN-insensitive 到能自动 sync,能则以后不用手动;② 否则固定"手动归档"流程(git mv + 把 delta 需求转中文头合进主规范)。
- **部署的 fnm PATH**:ts.mac-mini 的**非交互登录 shell 没激活 fnm**,`node`/`pnpm`/`build` 要用绝对路径 `~/.local/share/fnm/node-versions/v22.23.1/installation/bin`。deploy README 已提"plist 加 `NODE` 绝对路径";部署脚本(`hangar-view.sh` / 手动 build 命令)也应固化,免每次踩。
- **overlay ↔ rules.yaml 关系**:`noise_senders.overlay`(机器文件,apply 原子写)与 `rules.yaml`(人工维护)是并集加载。将来若 overlay 长期积累,可加"overlay→rules.yaml 固化 / overlay 清理"路径(现**无工具**,只增不减)。
- **prod 测试 run 记录**:上线验证时做的几次 interpret dry-run 在 prod `hangar.sqlite` 留了 run 记录(干跑无副作用,虚拟办公室墙会短暂显示 inbox 干过活)。可忽略、随新 run 自然衰减;**别手改 sqlite**(CLAUDE.md 禁,经 CLI)。
