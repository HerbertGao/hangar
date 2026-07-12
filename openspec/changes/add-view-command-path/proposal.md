## Why

inbox 每天 digest 推荐处置(如「最近高频发件人 TOP5,可加入 `noise_senders` 降噪」),但要真正处置必须 SSH 上生产机改 `rules.yaml`——外出时够不着。本变更给 `hangar-view` 加**第一条写路径**:在网页上用自然语言把决定传达给 pilot,inbox 解析、你确认后应用。

这是「入站控制面」的**种子(seed)**:hangar-view 已只读上线,写路径是 ROADMAP Phase 1.5 早预留的「Phase C」;第一个真实处置需求(降噪)到位即触发。契约稳定后,未来第二张脸(Telegram 就地回复)复用同一条路径。完整讨论与抉择见 `docs/proposals/control-plane-channels.md`。

## What Changes

- `hangar-view` 从**纯只读** → 增加一条**向 pilot 下达命令**的写路径:一个自然语言输入框 → 经 subprocess 调既有 `hangar run <pilot> --trigger <name> --input <json>`。
- **confirm-before-apply(两阶段、两次快 run,不 park)**:
  1. **interpret(干跑、无写)**:hangar-view 把原始 NL 交给 pilot 解析,pilot emit `interpretation.proposed`(结构化解析结果)后 run 结束、释放锁。
  2. **确认**:hangar-view 显示解析结果,人确认。
  3. **apply(写)**:hangar-view 用**确认后的结构化结果**再起一次 run,pilot 应用并 emit `feedback.applied`。
- **`already_running` 处理**:pilot 正忙(cron run 持 app 锁)时 `hangar run` 抛 `already_running`/退出码 1(不排队);hangar-view 呈现「忙,稍后重发」,**不建适配器侧队列**。
- **数据最小化受控放宽(仅确认视图)**:确认视图需显示候选发件人等域数据(来自 `interpretation.proposed` 事件);在**此单一命令确认路径**上放宽现有 default-drop 白名单,**不影响监控墙的最小化**。
- **写仅限白名单 `(pilot, trigger)`**:v1 硬编码 `inbox` 的 `interpret-feedback` / `apply-feedback`;**不做**通用「run 任意 app + 任意 input」的 firehose。
- **无 BREAKING**;**hangar core 一行不改**(`--trigger`/`--input`/`ctx.input`/`ctx.trigger` 已存在,写进 DoD 硬核对)。

## Capabilities

### New Capabilities
<!-- 无:复用现有 hangar-view capability,不为一个 seed 新建能力 -->

### Modified Capabilities
- `hangar-view`: 从「v1 只读、页面不提供处置动作」**放宽**为「可向 pilot **下达命令**(经 CLI `hangar run`,confirm-before-apply);从页面 **approve/reject 审批** 的写路径**仍不在本变更**」。新增:命令输入框、两阶段确认流、`already_running` 呈现、确认视图的受控数据最小化放宽,以及 hangar-view 依赖的 **命令/事件契约**(白名单 `(pilot,trigger)`、`interpret-feedback` 干跑、`apply-feedback` 写、`interpretation.proposed`/`feedback.applied` 事件、未知 trigger 响亮失败)。

## Impact

- **代码:** `packages/hangar-view`(后端加写端点 + subprocess 调 `hangar run`;前端加输入框 + 确认弹层 + busy 提示)。
- **hangar core / cli / 4 表:零改动**(硬 DoD;`hangar run --trigger --input` 已存在,hangar-view 只是新增了调用「写」命令的能力)。
- **契约(跨 repo,本变更只定契约、不含实现):** inbox 外部 repo 实现两个 trigger——`interpret-feedback`(input 原始 NL → emit `interpretation.proposed {add:string[]}`,**无写**)与 `apply-feedback`(input `{add:string[]}` → 对 `noise_senders.overlay` **tmp+rename 原子写 + set-union 幂等、不碰人工 `rules.yaml`** → emit `feedback.applied {added, already_present}`);未知 trigger 响亮失败。inbox 的 NL 解析与 overlay 写实现**不在本变更**(在 inbox 自己 repo 对着本契约做)。
- **安全:** hangar-view 首次具备**写**能力;仍在 Cloudflare Access 后、单用户;写受白名单 `(pilot,trigger)` 约束(非通用 firehose)。**不新增脊柱能力**(core 零改),故 hangar-view 命令路径的首个也是唯一用户 = inbox 的降噪处置(对不变量 #2 的回答)。

## 非目标(不在本变更)

- **typed intent 注册表 / `app.yaml` 的 `intents:` 声明块**——第 2 个 web 可触发 intent 出现再抽(v1 白名单硬编码 `(inbox, *-feedback)`)。
- **从页面 approve/reject 审批的写路径**——接第一个带高危动作的 pilot 时才做(引 app 级身份 + 防误触);本变更的写仅限「下达命令」,不含审批处置。
- **Telegram 双向入站**——同一契约的第二张脸,受 `control-plane-channels.md §7` 约束,后续。
- **通知集中(apprise-api / `@hangar/notify`)/ apprise.js**——独立提案(P2),与本变更无依赖。
- **inbox 侧实现**(NL 解析、overlay 原子写)——在 inbox 外部 repo,对着本契约做。
