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

**目标:** `inbox-pilot` → `apps/inbox/`。脊柱上收其 `actions/`(execute+retry+redact);域逻辑(classifier/normalizer/digest/providers)留在 app;postgres+邮件表原封不动;主流程收敛成 `pipeline.ts` 的 `run(ctx)`,`gmail.send` 走 `ctx.propose`。(迁移映射见 DESIGN §5。)

**DoD:**
- inbox 作为 `apps/inbox/` 在 hangar host 上按 cron 每天自动跑。
- 发送邮件走 `hangar approve`,审批链完整、可 trace。
- 旧 inbox-pilot 的能力无退化(分类质量、重试、脱敏都在)。

**出口闸(= 整个项目的验证判据):** **连续 7 天你每天真在用它,且不想切回旧 inbox-pilot。**

**⛔ 止损:** 若 7 天后你**没有**每天用它 —— 停。别在一个自己都不用的地基上盖 Phase 2。回头质疑 thesis:是脊柱抽象错了,还是「每天用」本就不成立?这是 solo 项目最重要的一次诚实。

**显式不做:** 把 inbox 的 eval 通用化(留在 app 内);为 inbox 特化脊柱(违反不变量 #2)。

---

## Phase 2 — pilot #2 + executor 泛化

**目标:** 迁第二个 pilot(候选:`ppt-pilot` / `ai-radar`)。**第二个 pilot 才能逼出真正通用的脊柱**——也才在此时决定是否需要:`llm-direct` executor(若 #2 是声明式 agent)、通用 eval(若 #2 也要)、更多事件类型。

**DoD:**
- 两个 pilot 共享同一脊柱,`@hangar/core` 里**没有一行为 #2 特化的域代码**。
- 若 #2 是声明式:`llm-direct` executor 落地,`app.yaml` 无 `pipeline.ts` 也能跑。

**出口闸:** 脊柱同时托两个不同域的 pilot 而不变形(不变量 #1/#2 复查通过)。这是「邮件形状过拟合」的真正体检。

**显式不做:** 为「以后可能的 pilot」预留能力。只解决眼前这两个真的用到的。

---

## Phase 3 — 按需长出

**目标:** 只在真实痛点出现时,才从 DESIGN §5 的 OUT 清单里取用。每一项加回前过闸:**「inbox 或某个真实 pilot 现在真的需要它吗?」** 答不出 = 不做。

候选(按痛点触发,非计划):配置 UI(手改 config 手疼)· 成本 enforce(某 run 烧出意外账单)· `claude-code`/`codex` executor(某 pilot 要开放式推理)· 更多触发器类型(webhook/event)。

---

## 明确不在路线图上

除非**「给别人用」升级成一个明确的、独立立项的赌注**,否则以下永不做:多租户 · RBAC · 计费 · marketplace · A2A · web workbench · MCP 控制面 · 通用 durable replay。届时它是**新项目 / 新阶段**,重新评估,不是 hangar 的自然延伸。
