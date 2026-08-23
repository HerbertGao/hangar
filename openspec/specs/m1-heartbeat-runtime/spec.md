# m1-heartbeat-runtime Specification

## Purpose

TBD — 本能力定义 M1 Heartbeat 纵向切片的 entry、安全写边、生命周期、Effect、SQLite、进程 containment、restore 与阶段验收；归档后应由维护者将本占位替换为稳定的能力目的说明。

## Requirements

### Requirement: M1 entry 必须先于产品实施

**Requirement ID:** `m1h.entry` SHALL 是本需求的稳定标识。

本 change SHALL 在任何 M1 产品文件创建前冻结 known-gap ledger、single-owner matrix、禁止写边、累计 active-developer-day 预算和每个真实 observation/failure obligation，并完成 bounded D1–D3 cleanup。Cleanup SHALL 删除M0 code/tests对OpenSpec version/content/config/活动change布局的读取或断言，使OpenSpec只作为独立strict external process gate；同时删除abandoned assertion-level digest明细，并保留紧凑stop-loss历史和唯一冻结的41/244/233/88/565 denominator owner。Entry SHALL 在不超过 1 active developer-day 内完成 strict OpenSpec 与同轮 fresh Code Reviewer/Reality Checker review；用户实施授权已存在，但只在entry PASS后生效，且 MUST NOT 表示 M1、candidate 或 production conformance。

#### Scenario: Entry 尚未通过

- **WHEN** entry artifact/cleanup缺失、review 含 blocker/major、超过 1 active developer-day，存在未处置 gap/owner/write edge/obligation，或冻结分母被动态缩减
- **THEN** M1 implementation 保持 blocked，且不得创建 `packages/*`、`tests/m1/*` 或产品 SQLite

#### Scenario: Entry 通过且已有用户授权

- **WHEN** cleanup、entry artifacts、strict validation与fresh review全部通过，且stable approvalRef记录既有实施授权
- **THEN** implementation tasks可开始，但entry evidence本身仍不满足任何M1 conformance obligation

### Requirement: M0 advisory 与 M1 conformance 分离

**Requirement ID:** `m1h.evidence-boundary` SHALL 是本需求的稳定标识。

M0 output SHALL 是 non-authorizing advisory。`M0 contracts: PASS`、`M0 bundle: PASS`、`M0 advisory: READY`、fixture、receipt、TAP、claimed observation、digest或 M0 test-file PASS MUST NOT 满足 M1 obligation。M1 actual evidence SHALL 仅来自公开 package API、fresh SQLite rows/facts、真实 process exit/containment 和从 committed facts 重建的 projection。

#### Scenario: M0 token 被用于补票

- **WHEN** M1 result 尝试用任一 M0 token、fixture 或 receipt 替代实际 package/store/process observation
- **THEN** M1 conformance 失败，相关 obligation 保持未运行

#### Scenario: Known gap 被改写为豁免

- **WHEN** entry 或 M1 report 删除 known gap、把失败改为 not-applicable，或任一 disposition缺少stable owner/approvalRef
- **THEN** entry/M1 validation 失败，不得静默归档；gap owner只拥有ledger revision，不获得runtime/control authority

### Requirement: Control/Harness/Effect/process/restore 单一 owner

**Requirement ID:** `m1h.owners` SHALL 是本需求的稳定标识。

Admission/Run identity、outer RunAttempt allocation/restart、terminal choke point、durable wait/resume SHALL 由 Control Core唯一拥有；Effect external commit SHALL 由 Effect Gateway唯一拥有；whole-tree containment/reap SHALL 由 Control Core trusted launcher唯一拥有；restore linearization/fencing SHALL 由独立 RecoveryAuthority唯一拥有。同一 actor MAY 拥有多项职责，但每项职责 MUST NOT 有第二 owner。

#### Scenario: Harness 尝试 outer retry 或 terminal

- **WHEN** Harness 创建第二个 RunAttempt、声明 Run terminal或在 Control 未分配时 resume
- **THEN** boundary 类型化拒绝该输入，不追加控制事实

#### Scenario: 两个 owner 写同一职责

- **WHEN** owner matrix、代码依赖或运行 observation显示同一职责有两个 writer/decision owner
- **THEN** entry/M1 exit失败，且不得以 coordination wrapper掩盖冲突

### Requirement: 禁止越过公共写边

**Requirement ID:** `m1h.write-boundaries` SHALL 是本需求的稳定标识。

Client、Harness、M0 advisory、projection和test reporter MUST NOT 直接写 Control SQLite。Harness SHALL 仅经 attempt-bound contracts提交 events、EffectIntent、checkpoint和 outcome proposal。Store SHALL 只原子实现 Control command，不独立决定 lifecycle。Projection SHALL 只从 committed SourceFacts重建。M1 MUST NOT 写 v0 DB/gateway或共享 v0 Run identity。

#### Scenario: Harness 直接写 SQLite

- **WHEN** Harness、tool或fixture绕过 Control command修改 Run/Attempt/Effect/projection row
- **THEN** test与entry dependency validation失败，且该写入不能成为有效事实

#### Scenario: Projection 被用作调度 authority

- **WHEN** caller从 projection推导并提交下一权威 transition
- **THEN** Control拒绝该路径；只有 command加当前 facts可决定 transition

### Requirement: Immutable Release 与真实 Heartbeat lifecycle

**Requirement ID:** `m1h.lifecycle` SHALL 是本需求的稳定标识。

Heartbeat AgentSpec SHALL 先编译为 immutable AgentRelease再 activation。Manual fixture admission SHALL 创建绑定 release/epoch 的 Run与 attempt 0；fake Harness SHALL 注册 action、调用只读 tool并追加实际 ActionEvent。Harness technical exit MUST NOT 直接完成 Run；只有 domain outcome proposal满足 release gate后，Control SHALL 经唯一 terminal choke point完成。

#### Scenario: 未编译 spec 被 activation

- **WHEN** caller使用可变 AgentSpec或漂移 ExecutionClosure请求 activation
- **THEN** Control在创建 Activation/Run前拒绝它

#### Scenario: Harness 零退出但无 outcome

- **WHEN** Harness技术执行成功但没有所需 Heartbeat artifact/facts
- **THEN** Attempt可记 technical success，Run保持非 completed

#### Scenario: Legacy-process Harness 保持同一 owner

- **WHEN** deterministic legacy CLI fixture 经 legacy-process HarnessAdapter 运行
- **THEN** adapter只把 stdout/exit映射为相同 contracts/events，不读取 M0 token、不写 v0/Control SQLite，且 admission、outer retry与terminal owner不变

### Requirement: Effect wait、checkpoint 与新 Attempt resume

**Requirement ID:** `m1h.effect-resume` SHALL 是本需求的稳定标识。

Harness SHALL 通过已注册 action提交单一 disposable EffectIntent。Effect Gateway SHALL 先持久 intent/claim/dispatch state；dispatch已开始但无 authoritative final outcome时 SHALL 进入 `unknown` 与 reconciliation obligation，MUST NOT 自动 redispatch。Checkpoint SHALL 绑定 producer attempt/action、schema/digest与 obligation owner/generation。Control SHALL 在旧 Attempt terminal、containment/grant fence和 AttemptQuiesced被原子消费后创建新 Attempt resume。

#### Scenario: Dispatch 后响应丢失

- **WHEN** disposable connector可能已提交但 final outcome未持久化
- **THEN** Effect保持单一 identity并进入 unknown；任何 Harness/Control自动重试均失败

#### Scenario: Checkpoint resume

- **WHEN** obligation已 final且 checkpoint/owner chain有效
- **THEN** Control原子消费匹配 quiescence并创建 attempt 1；旧 session后续 action/event/EffectIntent/checkpoint/child launch全部 stale拒绝

### Requirement: Fresh SQLite facts 与 projection 可重建

**Requirement ID:** `m1h.storage` SHALL 是本需求的稳定标识。

每个 M1 test SHALL 使用 fresh disposable v2 SQLite并启用 foreign keys。Command result、aggregate SourceFacts与必要 projection SHALL 在同一 transaction提交；fenced CAS zero-row MUST 是 typed non-success。SourceFacts SHALL 具有连续 factSeq/hash chain。删除可丢弃 projection后，按 committed facts重放 MUST 生成等价 Run/Attempt/action/Effect/terminal视图。

#### Scenario: Transaction commit 前崩溃

- **WHEN** process在原子 facts+projection transaction durable commit point前崩溃
- **THEN** reopen只可观察无transaction或完整transaction，不得存在partial bundle

#### Scenario: Transaction commit 后 acknowledgement 丢失

- **WHEN** process在原子 facts+projection transaction durable commit 后、返回 acknowledgement 前崩溃
- **THEN** reopen必须观察完整transaction；同command重放返回原结果，且不创建重复fact、command或Effect

#### Scenario: Projection 删除后重建

- **WHEN** 已提交 transaction保持不变但disposable projection被删除
- **THEN** restart只从 committed SourceFacts重建等价 projection，不创建新的 authoritative fact

#### Scenario: Fenced CAS 影响零行

- **WHEN** state/epoch/generation已变化导致 mutation影响零行
- **THEN** operation返回 typed stale/conflict/invalid-state，且不执行下游 action

### Requirement: 真实 process containment 与取消

**Requirement ID:** `m1h.process` SHALL 是本需求的稳定标识。

M1 Harness SHALL 在真实 child process中运行并绑定 dedicated containment identity、PID/start fingerprint与 RunAttempt。Control trusted launcher SHALL 拥有 cancel escalation和whole-tree reap。Harness graceful cleanup MAY 运行，但 MUST NOT 替代Control对父死、timeout、cancel和nonzero exit后的完整回收证明。

#### Scenario: Parent 死亡留有 descendant

- **WHEN** Harness root退出且匹配 descendant仍在 containment
- **THEN** Control恢复 escalation并回收全部成员，零 orphan，且最多一个terminal outcome

#### Scenario: 只能终止 direct child

- **WHEN**目标机制无法证明或回收完整 descendant tree
- **THEN** M1记录 host qualification gap，不声明 production readiness

### Requirement: Restore 与 stale writer fencing

**Requirement ID:** `m1h.restore` SHALL 是本需求的稳定标识。

Restore SHALL 使用独立 RecoveryAuthority和fresh target identity。Restored DB/Harness/client MUST NOT 自签 authority。Stale/competing session、target、epoch或permit SHALL 被 fence；旧 writer在restore后 MUST 有零成功写入。M1 MAY 使用disposable backup/target演练，但 MUST NOT外推为production restore qualification。

#### Scenario: Competing restore target

- **WHEN** 两个 target/session尝试绑定同一恢复 authority generation
- **THEN** 恰有一个可继续，loser类型化失败且无可写 owner

#### Scenario: 旧 writer 在 restore 后写入

- **WHEN** source或stale target在authority closure后提交 mutation
- **THEN** write被拒绝，new target facts不变，且违规阻断M1 exit

### Requirement: M1 observations、预算与止损

**Requirement ID:** `m1h.acceptance` SHALL 是本需求的稳定标识。

Entry SHALL 定义 active developer-day为8 person-hours并累加parallel work；当前 M0 wall-clock upper bound为148,290,920ms，按8 person-hours/day向上取整记为6日；entry最多1日，M1在累计day15前最多剩余8日。Entry通过后的第3个新增active developer-day SHALL 产生至少一份独立fresh-DB crash/restart observation；否则冻结扩scope、可选diagnostics与新abstraction并提交blocker/owner/P80复盘。累计day15仍无Heartbeat SHALL 删除abstraction，不扩大compiler/runtime范围。

M1 exit SHALL 至少包含：fake与legacy-process Harness同边界happy path；nonzero/parent-death + whole-tree reap；dispatch-started crash→unknown且零redispatch；原子transaction pre-commit crash→none-or-complete；post-commit ack-loss→完整bundle且幂等重放；projection删除→按facts rebuild；checkpoint→new attempt且旧session stale；stale/competing restore fence。每项 SHALL 有raw rows/facts/exit/containment/projection evidence和唯一typed outcome。

Heartbeat stage acceptance SHALL 只以本spec全部requirements/scenarios为语义SOT；本stage未显式采用M0 evaluator universe。每个成员都必须在fresh CR+RC原始return中标为`satisfied`并给出允许类别的精确引用：运行时场景使用公开API/fresh SQLite/真实process，历史治理场景使用原始review return或冻结entry summary+stable approvalRef+两份burn ledger+对应制品，反事实失败分支使用负向测试或可审查fail-closed guard及公共路径。任一遗漏或证据不足保持`observation-not-conformance`。不得生成scenario-to-test registry、第二runner/validator或receipt protocol；stage acceptance不使candidate/production qualification变为true。

#### Scenario: Heartbeat 分母尚未由 owner 冻结

- **WHEN** Heartbeat stage未显式采用M0 evaluator universe并执行阶段验收
- **THEN** 验收分母只包含本spec全部requirements/scenarios；任一成员证据不足保持`observation-not-conformance`，不得用M0 definition/token/fixture/TAP/digest/receipt补票

#### Scenario: Day-3 observation 缺失

- **WHEN** entry后新增第3个active developer-day结束仍无独立crash/restart observation
- **THEN** change标记off-plan并冻结扩scope，不能通过增加M0/compiler工作隐藏

#### Scenario: Day-15 仍无 Heartbeat

- **WHEN** M0+entry+M1累计达到15active developer-days但M1 exit未通过
- **THEN** 删除非必要abstraction并重开范围，不进入M2或增加第16日功能范围
