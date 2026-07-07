# ROADMAP — hangar

每个阶段有:**目标 / 完成判据(DoD)/ 出口闸 / 显式不做**。**闸不过,不许进下一阶段。** 这是全职 solo 无外部压力时,唯一防 scope 爆炸的机制。

---

## Phase 0 — 骨架(v0)

**目标:** 一天内亲眼见脊柱活着。`@hangar/core`(SQLite + registry + `PipelineExecutor` + tool gateway + PARK)+ CLI + `doctor` + 一个 30 行 `apps/heartbeat/` 玩具(`executor: pipeline`,`run` 里 `emit` 一条 + `propose` 一个假高危动作)。

**DoD(全部可跑):**
- `hangar doctor --json` 全绿(node/pnpm/sqlite 可写/apps 合法)。
- `hangar run heartbeat` → run 进 `waiting_human`(玩具的假动作命中 approval)。
- `hangar status --json` 正确显示该 run 卡在等审批。
- `hangar approve <run>` → 假动作执行 → run `completed`。
- `hangar trace <run>` → 完整事件时间线(started → approval.requested → approval.granted → action.executed → completed)。
- 4 张表的读写、run 锁行防重复执行,均生效。

**出口闸:** 上面整条 `run → park → approve → trace` 端到端**真的跑通**。跑不通不碰 inbox。

**显式不做:** 第二个 executor、任何域逻辑、HTTP、配置文件热重载。

---

## Phase 1 — 迁 inbox(v0.1)【里程碑:每天用】

**目标:** inbox 作为独立 repo checkout 到 apps 根下,依赖留自己 repo(外部 pilot、in-process 加载编译产物)。脊柱泛化其 `executeActions` **内存重试** + `redactError`(**不搬 durable `retryQueue`**);域逻辑(classifier/normalizer/digest/providers)留在 app;postgres+邮件表原封不动;主流程收敛成 inbox 外部 repo `src/pipeline.ts`(编译出 `dist/pipeline.js`)的 `run(ctx)`,自动动作(reflect/mark_read/notify,本质无害)**在 `run()` 内直接编排、不经 gateway**;若日后有高危动作(如 `gmail.send`)才走 `ctx.propose`。(迁移映射见 DESIGN §5;注:inbox 现有动作均不自动发信、无高危动作。)

**DoD:**
- inbox 作为外部 repo checkout(`HANGAR_APPS/inbox`)在 hangar host 上按 cron 每天自动跑。
- 若存在高危动作则走 `hangar approve`,审批链完整、可 trace(inbox 现状无高危动作、run 永不 `waiting_human`,故此项对 inbox 空过)。
- 能力对齐旧 inbox-pilot,但**接受以下已披露降级**(非无损):不搬 durable drain(`retryQueue`)/ 无 action-level durable / 退避粒度变粗 / reflect·mark_read 为 best-effort / gateway 通用动作执行不被 inbox 用(自动动作走 `run()` 直排)/ 落库前失败每 tick 重取-skip / notify 耗尽再送共用 `is:unread` 车道 / 硬 reauth 本 run 一次 token 命中 / 一个崩溃域。分类质量、脱敏保留。

**出口闸(= 整个项目的验证判据):** **连续 7 天你每天真在用它,且不想切回旧 inbox-pilot。**

**⛔ 止损:** 若 7 天后你**没有**每天用它 —— 停。别在一个自己都不用的地基上盖 Phase 2。回头质疑 thesis:是脊柱抽象错了,还是「每天用」本就不成立?这是 solo 项目最重要的一次诚实。

**显式不做:** 把 inbox 的 eval 通用化(留在 app 内);为 inbox 特化脊柱(违反不变量 #2)。不建外部 pilot loader 子系统(用 `HANGAR_APPS` 覆盖 + 独立 checkout 即可);不改 pilot 跑成独立进程。

**从 Phase 0 review 延后到此(inbox 上线即触发;各条按 inbox 现状分级:必补 / 顺延 Phase 2 / 接受降级):**
Phase 0 是单用户单进程玩具;下列问题只在「每天 cron + 可能多入口审批 + 真实外部副作用」下才成真,故当时**显式延后**(DESIGN/spec/design/proposal 四处已声明「单进程假设」——这是记账,不是遗漏。此处是兑现清单):
- **多进程并发仲裁。** Phase 0 靠 run-state 守卫 + approve 取 run 锁 + reaper 覆盖单进程崩溃,但挡不住两个活进程真并发。分两类,按 inbox 现状分级:① **并发审批仲裁**(approve-vs-approve 时 `UNIQUE(run_id,seq)` 竞争的败者**重取 `max(seq)` 重试**而非事务崩溃、approve-vs-reject 活 race 的仲裁、`granting` 中间态的 **lease/超时回收**)——inbox 无高危动作、run 永不 `waiting_human`,**本项对 inbox 不触发,顺延 Phase 2**(`gmail.send` 落地时补);② **reap 与并发 run/claim 的行级事务仲裁**——reaper 在事务外读 `lock_owner` 判死,另一进程可能在「读后、杀前」抢到锁,需行级锁(单行事务内重读 `lock_owner` 未变再回收);solo 单终端 + cron 单 daemon 下极罕见,**接受降级**、`busy_timeout` 兜底,真出多入口并发再补。
- **真实工具的「至多执行一次」(→ Phase 2,对 Phase 1 moot)。** Phase 0 gateway 只保证「至多认领一次」(CAS)。gmail 等真实副作用的 exactly-once 取决于 propose'd 动作 handler 把 `Approval.id` 幂等键透传给外部系统并被其接受——**add-inbox-migration pivot 已移除 Phase 1 全部 approval 动作(inbox 自动动作在 `run()` 内直接编排、不发信),故此项对 Phase 1 moot,顺延 Phase 2 第二个 pilot(`gmail.send`)落地时兑现**。
- **审批后域回写的落点(→ Phase 2,对 Phase 1 moot)。** 发信后「写回已发送」的域逻辑必须住 propose'd 动作 handler(不在 `run()`、不在 core;approve 不重入 `run()`)。**inbox 现状无高危动作、Phase 1 不发信,此接缝 Phase 1 不触发;Phase 2 落 `gmail.send` 时验证它真能承接,否则单切点不够就得回头改脊柱**。
- **`openDbReadonly` 的 WAL 头 gate(review 延后,accepted-degraded)。** Phase 0 的「只读命令零写库」靠「hangar 自己从不写 WAL(openDb 强制 DELETE)」保证。但 `openDbReadonly` 不归一化一个**既有 WAL 库**的 sticky 头——若真存在一个 hangar 造不出来的 WAL 库(外部工具/假想旧版本)且读命令**先于**任何写命令跑,只读打开仍会造 root-owned sidecar。Phase 0 不可达(无前身、hangar 不造 WAL),写路径转换已覆盖正常升级,故**接受降级**。若将来真出 WAL 版本:让 `openDbReadonly` 检测 WAL 库头 → fail-loud(「先跑一次写命令迁移」)或 immutable 打开,使「读零写」对任意 journal 模式普适。

---

## Phase 2 — pilot #2 + executor 泛化

**目标:** 迁第二个 pilot(候选:`ppt-pilot` / `ai-radar`)。**第二个 pilot 才能逼出真正通用的脊柱**——也才在此时决定是否需要:`llm-direct` executor(若 #2 是声明式 agent)、通用 eval(若 #2 也要)、更多事件类型、多 repo 外部 pilot loader(pilot #2 逼出「停一队来自多个 repo 的 fleet」时落地)。

**DoD:**
- 两个 pilot 共享同一脊柱,`@hangar/core` 里**没有一行为 #2 特化的域代码**。
- 若 #2 是声明式:`llm-direct` executor 落地,`app.yaml` 无 `pipeline.ts` 也能跑。

**出口闸:** 脊柱同时托两个不同域的 pilot 而不变形(不变量 #1/#2 复查通过)。这是「邮件形状过拟合」的真正体检。

**承接 Phase 0 收窄的契约(从 review 延后):** 若 #2 用 `claude-code`/`codex` 这类**独立进程 harness**,必须遵守 Phase 0 收窄的使用契约(DESIGN Q2/§3.5)——外部 harness 只作**推理引擎**、零工具权限,副作用一律回流 `ctx.propose`;否则其工具调用绕开 OS 审批(破 #5)或要加 IPC/MCP(破 #6/#7)。这条在 Phase 0 只是文档约定,#2 真落地时要用机制兑现(如给该 harness 挂零工具、副作用翻译层)。

**显式不做:** 为「以后可能的 pilot」预留能力。只解决眼前这两个真的用到的。

---

## Phase 3 — 按需长出

**目标:** 只在真实痛点出现时,才从 DESIGN §5 的 OUT 清单里取用。每一项加回前过闸:**「inbox 或某个真实 pilot 现在真的需要它吗?」** 答不出 = 不做。

候选(按痛点触发,非计划):配置 UI(手改 config 手疼)· 成本 enforce(某 run 烧出意外账单)· `claude-code`/`codex` executor(某 pilot 要开放式推理)· 更多触发器类型(webhook/event)。

---

## 明确不在路线图上

除非**「给别人用」升级成一个明确的、独立立项的赌注**,否则以下永不做:多租户 · RBAC · 计费 · marketplace · A2A · 外部 pilot marketplace / plugin store · web workbench · MCP 控制面 · 通用 durable replay。届时它是**新项目 / 新阶段**,重新评估,不是 hangar 的自然延伸。
