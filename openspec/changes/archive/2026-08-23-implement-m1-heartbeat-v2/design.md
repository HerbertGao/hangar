## Context

M0 已完成 Harness-first contracts、SQLite DDL 与 41/244/233/88 definitions，但其 validator 连续 review 后仍不能获得一般性授权；它现在只输出 `NON-AUTHORIZING ADVISORY`。本 change 同时承担两层职责：先在 ≤1 active developer-day 的 M1 entry 阶段完成 bounded D1–D3 删除并通过 review，随后按用户已给出的显式授权实现 ROADMAP M1 Heartbeat。Entry 通过前不得创建 `packages/*`、`tests/m1/*` 或任何产品数据库。

Entry 采用的保守预算账本：1 active developer-day = 8 person-hours，parallel work 按 person-hours 累加；当前 M0 wall-clock upper bound 为 148,290,920ms，按8 person-hours/day向上取整记为 6 active developer-days；entry 最多再用 1 日，因此 M1 在累计 day-15 hard trigger 前最多剩余 8 日。该上界不得因换 session、agent 或分支重置。

### Known-gap ledger

| ID | 当前事实 | disposition | disposition owner | approvalRef |
| --- | --- | --- | --- | --- |
| `M0-ADV-001` | M0 output/test/planning paths 未达到 hermetic review approval | 保持 advisory；M1 不读取其 token/path authority | M0 Advisory Maintainer | `USER-ADVISORY-ENTRY-2026-08-22` |
| `M0-ADV-002` | M0 measurement typing/reference closure 未获 approval | 仅作历史成本参考，不成为 M1 gate | M0 Advisory Maintainer | `USER-ADVISORY-ENTRY-2026-08-22` |
| `M0-ADV-003` | M0 formatter intrinsic binding 未获 approval | 所有历史 PASS/READY token均不授权 M1 | M0 Advisory Maintainer | `USER-ADVISORY-ENTRY-2026-08-22` |
| `M0-ADV-004` | M0 `local.contracts` 仍有 dynamic discovery 风险 | M1 tests 使用自己的固定文件清单，不由 M0 discovery 补票 | M0 Advisory Maintainer | `USER-ADVISORY-ENTRY-2026-08-22` |
| `M1-ENTRY-001` | M1 product packages 尚未建立 | 仅在 entry review 通过后按既有实施授权由 implementation tasks 解决 | M1 Change Owner | `USER-M1-AUTH-2026-08-22` |
| `HOST-001` | 当前 Darwin/arm64 未有独立 production whole-tree qualification | M1 只做 mutation-disabled/disposable local slice，不声明 production readiness | Host Qualification Owner | `SOT-HOST-LOCAL-ONLY` |
| `M1-DENOM-001` | 旧规则把M0 534项跨阶段义务默认施加给Heartbeat | 由`define-m1-spec-based-acceptance`修订为M0显式opt-in；M1 stage只按自己的runtime requirements/scenarios验收 | M1 Change Owner | `USER-M1-SPEC-SOT-2026-08-23` |

Approval register：

- `USER-ADVISORY-ENTRY-2026-08-22`：产品决策 owner 选择 advisory→M1，并授权 ≤1日 entry artifacts。
- `USER-M1-AUTH-2026-08-22`：产品决策 owner 明确确认 D1–D3 bounded cleanup，并授权 entry review 通过后直接实施 M1 Heartbeat；不得提前创建产品文件。
- `SOT-HOST-LOCAL-ONLY`：`DESIGN.md` §6.1/§14 与本 ledger共同要求缺少 whole-tree 正向证明时 fail closed；只允许 disposable local evidence。
- `USER-M1-OBSERVATION-CLOSE-2026-08-22`：历史决策保留真实Heartbeat observation，并要求在独立change中解决applicability。
- `USER-M1-SPEC-SOT-2026-08-23`：产品决策owner选择M1 runtime OpenSpec requirements/scenarios作为Heartbeat stage acceptance唯一语义SOT；M0 bundle仅由candidate spec显式opt-in。

这里的 disposition owner只负责 gap ledger及后续revision，不获得对应runtime/control authority。Known gap 只能通过 append-only revision 更新；每次 revision必须保留stable ID、owner与approvalRef，不得删除、改写为 waiver 或由 M0 green token关闭。

## Goals / Non-Goals

**Goals:**

- 先把 entry 的 known gaps、single-owner matrix、禁止写边、预算和 M1 observation/failure obligations冻结为可审查 artifact。
- 后续实施一个无 UI/HTTP/Pi 的 in-process Heartbeat vertical slice，证明真实 package、fresh SQLite 与 process boundary能闭环。
- 对 normal、crash、unknown、resume、rebuild、stale restore 产生原始、可反驳 observation。
- 保持 M0 advisory 与 M1 conformance 完全分账。

**Non-Goals:**

- Entry 本身不写产品代码、不创建数据库、不授权 M1 conformance。
- M1 不实现 scheduler、Pi、API/client、tenant、Knowledge、Suggestion、AgentIntent、ProcessSpec、通用 workflow、daemon 或 production migration。
- 不证明 power-loss/fsync、PITR、跨主机 HA、完整不可信 sandbox 或全部 244 场景。
- 不以恢复 M0 authority 为目标修补 hermetic compiler；只做 D1–D3 bounded deletion，且不启动 D4 validator重写或复用 D5 test helpers。

## Decisions

### 1. Entry 是实施前置，不是 compiler 或 conformance

本 proposal/design/spec/tasks、bounded D1–D3 cleanup 加 fresh CR+RC review 构成 entry artifact。实施授权已由用户给出，但只有 Entry PASS 才激活 implementation tasks；它不输出 production/candidate PASS。Entry 超过 1 active developer-day、出现重复/遗漏 owner、silent exemption、冻结分母缩减或无法映射的 Critical gap 时保持 `implementation-blocked` 并重开路线。

替代方案“无 entry 直接写 M1”被拒绝，因为 owner/写边/预算仍可能含糊；“继续 blocking M0 compiler”被拒绝，因为当前没有获批的 fixed scope/trusted root/completion proof，且不能替代真实 M1 observation。

### 2. Bounded D1–D3 cleanup

- D1：M0 code/tests删除对 `openspec-cn` version、OpenSpec Markdown/config和活动 change proposal/design/tasks路径/digest的读取或断言；`openspec-cn validate --specs --strict --json`只作为独立external process gate，未来产品 packages不得import/parse `openspec/`。冻结机器分母由oracle manifest拥有。
- D2：删除 abandoned assertion-level SHA/path明细，只保留 reviewed count、unresolved count、stop-loss disposition与原审查引用的紧凑历史摘要。
- D3：删除重复 path/count字面量；41/244/233/88/565 只由一个冻结 denominator owner提供，其他检查引用它。不得改为无独立冻结基准的动态发现。

清理本身不构成 hermetic approval，也不恢复 M0 authority；D4/D5不在entry清理范围，M1不得 import M0 helpers。

### 3. 每项职责恰有一个 owner

| Responsibility | 唯一 owner | 非 owner 明确禁止 |
| --- | --- | --- |
| admission / Run identity | Control Core | Harness、client、M0 advisory、projection |
| outer RunAttempt allocation/restart | Control Core | Harness/provider session |
| terminal choke point | Control Core | Harness exit、projection、client |
| Effect external commit | Effect Gateway | Harness、Control retry loop、store |
| durable wait/resume decision | Control Core | Harness continuation、projection |
| whole-tree containment/reap | Control Core trusted launcher | Harness graceful cleanup、tenant supervisor |
| restore linearization/fencing | Independent RecoveryAuthority | restored DB、Harness、client |

同一 Control actor 可拥有多项职责，但任何一项不得有第二 owner。Domain outcome proposal 仍属于 Heartbeat domain fixture，只能向 Control 提交证据，不能提交 Run terminal。

### 4. 禁止写边

- M0 advisory、client、Harness、projection 与 test reporter不得写 Control SQLite 或产生授权事实。
- Harness 只能经 `packages/contracts` 的 attempt-bound request/event/EffectIntent/checkpoint接口；不得分配 RunAttempt、terminalize、dispatch Effect 或恢复 unknown。
- `control-store-sqlite` 只实现 Control Core 传入的原子 command，不独立决定 lifecycle。
- projection 只从 committed SourceFacts 重建，不反向调度。
- M1 不写 v0 DB/gateway，不共享 v0 Run identity，不 dual-write。
- 高风险 external operation只经 Effect Gateway；M1 fixture 使用本地、可丢弃 connector，不持生产凭据。

### 5. 模块化单体依赖方向

以下箭头表示 compile-time import 依赖：

```text
packages/control-store-sqlite ──implements──▶ packages/control-core ──▶ packages/contracts
composition/trusted-launcher ───────────────▶ packages/control-core
fake/legacy Harness fixtures ────────────────────────────────────────▶ packages/contracts
```

`contracts` 只包含 TypeScript 数据类型、闭合 unions 和 pure canonical helpers；`control-core` 不 import SQLite；`control-store-sqlite` 实现并 import core port；composition root 注入 store/launcher；Harness 只依赖 contracts。M1 使用 Node 已有能力与 SQLite，不新增 npm dependency、服务或 plugin registry。

### 6. 最小真实 lifecycle

1. 编译 immutable Heartbeat AgentRelease。
2. 创建 shadow/active-for-fixture Activation，manual admission产生 Run 与 attempt 0。
3. fake child Harness 注册 action，调用只读 heartbeat tool并追加 ActionEvent。
4. legacy-process HarnessAdapter 运行 deterministic legacy CLI fixture，把 stdout/exit 映射到同一 contracts/events；它不读取 M0 token、不写 v0/Control SQLite，也不改变 lifecycle owner。
5. Harness 提交一个 local disposable EffectIntent；Control/Effect Gateway 将其置于 durable wait。
6. Harness 发出带 obligation owner/generation 的 checkpoint；Control terminalize attempt、seal containment、撤销 grants并提交 AttemptQuiesced。
7. 在外部 outcome/reconciliation final 后，Control 原子消费 quiescence并分配 attempt 1；Harness 从 checkpoint resume，提交 outcome proposal。
8. domain outcome gate接受证据后，Control 经唯一 choke point terminalize Run；projection 从 facts 重建一致状态。

Harness technical exit 0 不代表 business completion。Unknown/committed Effect 不自动重提。

### 7. SQLite 和 projection 必须来自真实路径

每个 M1 test 使用 fresh disposable v2 SQLite，启用 foreign keys。Command result、aggregate facts和 projection在同一事务提交；fenced CAS zero-row必须是 typed non-success。测试直接读取 rows/facts并删除 projection后重建，不能消费 M0 fixture observation或产品自报 digest。

M1 不声称完整 schema migration；数据库可随测试删除。任何 schema/API 修改都仍受 M0 definitions和本 change specs约束。

### 8. 真实 process 与故障义务

首个 Heartbeat evidence必须至少覆盖：

- fake child 与 legacy-process HarnessAdapter 都经同一 contracts、owner与terminal choke point完成 happy path；
- nonzero/parent-death 后完整 containment reap，无 orphan；
- Effect dispatch 已开始但本地 final outcome 未提交时崩溃，恢复为 `unknown` 且零自动 redispatch；
- 原子 facts+projection transaction在commit前crash时只能观察none或完整bundle；commit后 acknowledgement 丢失时reopen必须观察完整bundle，且同命令重放不重复；另删除 disposable projection 后按 facts 重建等价视图；
- checkpoint 后 resume 创建新 attempt，旧 session 的 action/event/EffectIntent/checkpoint/child launch按 stale拒绝；
- stale/competing restore 或 epoch evidence 被 fence，旧 writer零成功写入。

这些 observation 只证明 disposable M1 Heartbeat，不外推为 production host qualification。

### 9. Budget 与 checkpoints

- Entry：≤1 active developer-day；超过即 implementation blocked。
- Entry 通过后的第 3 个新增 active developer-day：必须有一份独立 fresh-DB crash/restart observation；没有则标记 off-plan，冻结扩 scope、可选 diagnostics 与新 abstraction，提交 blocker/owner/P80复盘。
- M0+M1 累计 day 15：仍无 Heartbeat则删减 abstraction；不得增加第16日的 compiler/runtime范围。
- 指标继续记录 `T_ready`、`C_platform`、`C_enable`、glue LOC、cold/idle/peak RSS、disk/process count和12月TCO。

### 10. Entry completion proof

Entry review必须确认：design当前known-gap ledger的每个条目都有disposition/owner/approvalRef（数量从ledger实时推导，不固定为`6/6`）；owner 7/7恰一且无重复；禁止写边全部显式；M0 token消费者为0；预算有起点/单位/余额；每个M1 observation/failure obligation有future test/task；没有product files。只有strict OpenSpec与同轮CR+RC无blocker/major时，entry可标记完成。

## Risks / Trade-offs

- [Entry ledger 与真实代码漂移] → implementation review逐项引用 requirement/scenario ID，entry失败即重开。
- [窄 Heartbeat false-green] → raw rows/facts/process observations和负向 crash windows，禁止最终 projection单独证明成功。
- [错误 API/schema 早期固化] → disposable DB、未发布 API、按小步 task实施，可整体删除回滚。
- [M0 补票回流] → dependency/import扫描及独立 M1 result namespace；M0 token消费者必须为0。
- [真实 process test flake] → 等待状态/barrier而非 sleep，记录 seed/failpoint与raw exit。
- [预算被 session/并行规避] → 8 person-hours为1 active day，并行累计；append-only burn ledger。

## Migration Plan

1. 更新 M0 token/scope为 advisory并记录 known gaps。
2. 执行 bounded D1–D3 cleanup；不写产品文件，不缩减冻结分母或历史摘要。
3. 完成 strict validation与fresh CR+RC；Entry 通过前保持 implementation blocked。
4. Entry 通过后按已确认授权实施 packages、fresh SQLite lifecycle、Harness/Effect/resume和fault observations，不再请求重复授权。
5. M1 exit通过前不开始 M2/Pi/API/client。

回滚：entry阶段删除本 change即可；实施阶段删除新 packages/tests/disposable DB，M0 advisory与v0保持不变。

## Open Questions

`M1-DENOM-001`已由`define-m1-spec-based-acceptance`解决：M1 Heartbeat stage未显式采用M0 evaluator universe，只按`m1-heartbeat-runtime`全部requirements/scenarios验收。6.1/6.2仍必须完成逐项证据与固定checks/review；M0 token不得补票，candidate/production qualification保持false。
