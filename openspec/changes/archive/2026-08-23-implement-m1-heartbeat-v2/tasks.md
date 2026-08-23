## 0. Entry artifact（产品代码前）

- [x] 0.1 将根 SOT 与 `define-v2-control-contracts` 的 M0 scope/token 更新为 `NON-AUTHORIZING ADVISORY` / `M0 advisory: READY`，保留 post-root-cause R3 四项 known gaps，且零 Control/client/M1 consumer；验证：用户确认的 `openspec-cn 1.10.0` 位于验证 PATH首项、repo 搜索无历史 PASS token 的授权用途、M0 tests 与 advisory CLI 全绿；止损：任何 consumer 仍以 M0补票则 entry失败。
- [x] 0.2 冻结本 change 的 known-gap ledger（每个现行条目含stable disposition owner与approvalRef，数量从design当前ledger推导，不固定为`6/6`）、7项single-owner matrix、禁止写边、6+1+8日预算、day-3/day-15 checkpoints和真实M1 observation/failure obligations；验证：proposal/design/spec/tasks互相一致、零silent exemption、零产品文件；止损：重复/遗漏owner或未映射Critical gap即保持blocked。
- [x] 0.3 执行 bounded D1–D3 cleanup：删除M0 code/tests中的OpenSpec version/content/config/活动change layout读取与断言（仅保留strict external process gate），并删除abandoned assertion-level SHA/path明细，保留compact stop-loss audit；将41/244/233/88/565收敛到唯一冻结denominator owner；验证：删除量、零悬空ref、分母不变、无产品文件；止损：需D4重写、丢历史、动态缩分母或修改产品语义则停止。
- [x] 0.4 使用用户确认的 `openspec-cn 1.10.0` 执行 `openspec-cn validate implement-m1-heartbeat-v2 --type change --strict --json`、SOT一致性/LSP/diff checks、逐项验证6个gap的stable owner/approvalRef，并完成同轮 fresh Code Reviewer + Reality Checker；预期：strict `valid:true`、entry review零 blocker/major；止损：超过1 active developer-day或review未通过则不得勾选、不得开始1.x。
- [x] 0.5 记录用户显式授权：D1–D3 bounded cleanup可立即执行，M1 Heartbeat implementation仅在0.4通过后启动且无需重复询问；预期：当前仍无 `packages/contracts`、`packages/control-core`、`packages/control-store-sqlite`、`tests/m1`。

## 1. Package contracts 与依赖边界

- [x] 1.1 建立 stdlib-only `packages/contracts`，定义 Release/Activation/Run/RunAttempt/Harness request-event/ActionEvent/checkpoint/Effect/result unions和pure canonical helpers；验证：TypeScript/LSP与fixed vectors；预期：零SQLite/process/import M0；止损：需要新dependency或领域字段时暂停。
- [x] 1.2 建立 `packages/control-core` ports 与single-owner guards，静态禁止 client/Harness/projection/store直接拥有lifecycle；验证：dependency tests与negative imports；预期：owner matrix 7/7、duplicate/unassigned 0；止损：第二owner不可构造前不继续。

## 2. Fresh SQLite store 与事实重建

- [x] 2.1 建立 `packages/control-store-sqlite`，只使用独立disposable v2 DB，启用foreign keys并实现command/result/SourceFact/projection原子事务；验证：fresh DB bootstrap、zero-row CAS、crash rollback tests；预期：不写v0、无partial bundle；止损：store需解释lifecycle则退回core port。
- [x] 2.2 实现连续factSeq/hash chain与projection rebuild；验证：删除projection后重放得到相同Run/Attempt/action/Effect/terminal；预期：unknown fact/gap/parent mismatch fail closed。

## 3. Heartbeat Harness 与 lifecycle

- [x] 3.1 编译immutable Heartbeat AgentRelease，创建manual fixture Activation/Run/attempt 0；验证：source spec不可直接activation、release/epoch drift拒绝。
- [x] 3.2 建立真实child fake Harness：注册action、调用只读heartbeat tool、发出实际events/outcome proposal；验证：technical exit不直接terminal、环境/descriptor/grant边界、nonzero exit observation。
- [x] 3.3 实现最小legacy-process HarnessAdapter并运行deterministic legacy CLI fixture；验证：stdout/exit只映射到相同contracts/events，零M0 token读取、零v0/Control SQLite直写、owner/terminal choke point与fake Harness一致。
- [x] 3.4 实现trusted launcher的dedicated containment、cancel escalation与whole-tree reap；验证：parent death/late descendant/TERM→KILL/PID reuse；预期：零orphan、单terminal；止损：当前host只能direct-child时保持non-production gap。

## 4. Effect、checkpoint 与 resume

- [x] 4.1 实现disposable local EffectIntent→claim→dispatch→ExternalOutcome/reconciliation；验证：single operation/idempotency、response loss→unknown、零自动redispatch、重复approve/stale epoch。
- [x] 4.2 实现checkpoint obligation/owner generation、AttemptQuiesced与new-attempt resume；验证：旧session迟到action/event/EffectIntent/checkpoint/child launch全stale，新attempt原子消费quiescence且从exact checkpoint恢复。
- [x] 4.3 经domain outcome gate与唯一Control choke point完成Run；验证：无artifact不complete、completion/cancel竞争仅一terminal、projection重建一致。

## 5. Restore 与真实 failure observations

- [x] 5.1 使用独立RecoveryAuthority fixture和fresh target演练stale/competing restore；验证：旧writer零成功写、另一target/session loser typed fail、不得自签authority。
- [x] 5.2 在entry后第3个新增active developer-day前产出首份独立fresh-DB crash/restart observation，覆盖dispatch-started crash→unknown、原子facts+projection pre-commit crash→none-or-complete、post-commit ack-loss→完整bundle且幂等重放，并另以projection删除→按facts rebuild证明可重建；预期：raw rows/facts/exit/containment/projection齐全；止损：缺失则标记off-plan并冻结扩scope。

## 6. M1 aggregate acceptance

> Heartbeat stage acceptance只由本change的`m1-heartbeat-runtime`全部requirements/scenarios拥有；M0 evaluator universe未被本stage采用，M0 token/fixture/TAP/digest/receipt均不得补票。

- [x] 6.1 逐条确认当前M1 spec的每个Requirement与Scenario均为`satisfied`：运行时场景只接受公开API、fresh SQLite rows/facts或真实process证据；历史治理场景优先引用原始review return，原文不可得时同时引用冻结entry review summary、stable approvalRef、`measurements/evidence.json`、`measurements/ledger.json`与对应制品；反事实失败分支引用负向测试或可审查fail-closed guard及公共路径。每项必须有精确引用，任一遗漏或证据不足保持`observation-not-conformance`；不生成mapping registry/validator/runner/receipt。
- [x] 6.2 使用用户确认的`openspec-cn 1.10.0`运行既有完整M1 tests、M0 advisory、strict OpenSpec、TypeScript/LSP、fresh SQLite/no-v0-write、boundary/residue/diff checks与fresh CR+RC；记录既有T_ready/C_platform/C_enable/glue LOC/RSS/disk/process/TCO measurement或明确`not-measured`理由。预期：stage acceptance关闭但candidate/production qualification保持false；止损：累计day15仍无Heartbeat则删减abstraction，不进入M2。
