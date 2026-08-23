# Define v2 Control Contracts

## Why

Hangar v2 的 SOT 已接受 Harness-first，但当前 M0 planning artifacts 仍把静态 workflow、node-kind 与 NodeAttempt 固化为执行和存储主轴。M1 尚未实现，当前是用 `RunAttempt + HarnessSession + ActionEvent/checkpoint` 重写契约、避免把错误抽象铸进 SQLite 与 fault oracle 的最低成本窗口。

初版 M0 实现虽然能让测试与 aggregate 输出通过，但 fresh review 已复现三类 E1 false-green：scenario operation 只运行共享 requirement test file 后回显 scenario ID；closed-dimension consumer 只证明 token 在全局某处存在而未绑定 intended locus；evaluator 可接受调用方伪造的 observation 摘要。第一轮 bounded-witness 修订关闭了这些直接伪造路径，随后 R3 又证明 scenario evidence 仍可由 `async () => undefined`、`() => assert.ok(true)` 或未声明但命名为 `scenario-callback:<scenarioId>` 的普通 `node:test` 产生；攻击者即使重算 callback/test/input/consumer/plan/output digests，parent 仍会把 TAP reporter 的成功文本提升为 PASS。I1 authority-root admission audit 随后逐项检查 244 mappings/147 bodies，发现 53 个 unresolved semantic gaps；fresh Code Reviewer、Reality Checker 与 Test Automation 复核中，即使最宽松 lane 仍要求 39 个新 semantic gates，超过预设的 25 项止损门槛。Q3 verifier-owned direct gates 与后续 bounded-seam composite 仍连续暴露 claimed-literal false-green：每次修复一个 test-side observation producer，fresh review 都能在另一个 family 找到未经真实 public state 支持的 PASS。根因是 M0 尚无产品 runtime，却要求自身的测试模型证明 244 个场景语义，等于维护第二套 Control/SQLite 实现。最终裁决撤销该 authority 与阻断地位：M0 只冻结 41 Requirements、244 Scenarios、233 closed dimensions 与 88 recovery-race cells 的 565-member definition denominator，并以 `NON-AUTHORIZING ADVISORY` 记录 diagnostics/known gaps；它不授权 M1。首行 M1 产品代码前必须有一个 ≤1 active developer-day entry artifact，闭合 known gaps、单 owner、禁止写边、累计预算与真实 observation/failure obligations，并在通过后激活已记录的 `USER-M1-AUTH-2026-08-22` 条件授权，无需再次请求。任何候选语义证据只能由 M1+ 在真实 `packages/contracts → control-core → control-store-sqlite → Harness/process` 路径产生。旧 I1/Q3/composite/bundle artifacts 保留为历史反证，不构成 qualification。

## What Changes

- **BREAKING**：从 M0 contracts 删除通用 workflow、node-kind、branch/foreach expansion、`subflow`、`nodeInstanceId` 与 NodeAttempt；不提供兼容别名。
- 冻结 AgentSpec、AgentRelease、Activation、Run、RunAttempt、HarnessRequest/Event、ActionEvent、checkpoint ref、RunEvent、Approval、Effect、健康事实与 typed error algebra。
- 固定分层 owner：Control 拥有 admission、Run、外层 RunAttempt/restart、durable wait、terminal、grant、Effect 边界与 whole-tree containment/reap；Harness 拥有同一 RunAttempt 内的 plan、context、tool/subagent、provider session 及声明过的模型、传输和可逆 action retry；domain package 拥有领域状态与 outcome gate。
- 固定 action attribution：重要 action、有效 grant、checkpoint、Effect 与 outcome proposal 均进入 append-only source facts；action graph 只作可重建投影，不是执行 authority。
- 固定 checkpoint/resume：checkpoint 仅为带 schema/version/digest 的 access-controlled artifact ref，并使用封闭的 obligation kind/owner/generation；合法 owner handoff 只认不可分支的 CAS successor chain；Control 只在前一 Attempt terminal、AttemptQuiesced/完整进程树/grant fence/obligation digest 经同一分配 CAS 验证后创建新 RunAttempt；quiescence 后旧 Attempt 的派生写入/launch 全拒绝，仅放行既有 obligation late outcome 与 Control cleanup；禁止任意 continuation replay。
- 扩展 AgentRelease 静态成员：Harness entry/ExecutionClosure、approved skills、required capability/operation 与 checkpoint schema；Agent-owned mutable state、事实、偏好、产物和运行期证据不进入 release identity，权限/skill/policy/tool 变化只能形成新 Release candidate。对外 capability registration/visibility 与完整 Workspace protocol 明确延后。
- 保留并适配既有 authority/time/idempotency、host attestation、restricted launch、Effect unknown/reconciliation、restore、source-fact chain 与 aggregate-gate 语义；将所有 node/attempt 绑定改为 RunAttempt/action 绑定，恢复先建立数据库级 RecoverySession/共享 target 与 per-Agent qualification，以同一外部 CAS 仲裁 session init/abort，永久关闭旧实例 authority registration，并用稳定 discovery-key + authenticated ownerAgentId 且具封闭 lifecycle/非授权的 RecoveryDiscoveredOperation 记录快照后操作；归属冲突 fence 所有 consumer，跨 target 由本地 ack 或不可逆 TargetAuthorityClosed proof 收敛；以 BindingCertificate + 短期 permit/binding-invalidated 闭合 bind 后崩溃或证据冲突，并要求 Control 可 hard-reap 完整进程树。
- 从新状态语义反推独立 v2 SQLite DDL、database/source/RecoverySession/target identity、clean-restart continuation、zero-row CAS、唯一约束、projection rebuild 与 per-session/Agent single-coordination recovery 契约。
- 更新 adapter-neutral oracle：覆盖 outer/inner retry、checkpoint resume、ActionEvent/grant/Effect attribution、whole-tree reap 与 external Harness qualification；适用分母必须由 owner-frozen universe/predicate 推导，required case 不可排除、完整 recoveryRacePoint × disposition 笛卡尔积逐格映射且不允许 N/A/skip 排除、分母非零且不可漏跑，不可归因 fault cases 必须 ≤5%，owner/effect boundary violation 必须为 0。
- 冻结 definition-only evaluation bundle：保留 41 Requirements、244 Scenarios、233 closed-dimension members、88 recovery-race cells、aggregate DAG、typed result precedence 与唯一 aggregate owner。M0 对565个规范成员只验证稳定ID、owner、coverage/applicability、typed expected public observation、closed value/locus与race笛卡尔积定义的缺失/重复/歧义/非法排除；OpenSpec WHEN/THEN只由外部工具检查；不得运行 test-side candidate、铸造 execution receipt，或把 fixture/TAP/claimed observation 提升为语义 PASS。成功 token 改为精确 `M0 advisory: READY`，只表示本地 diagnostics 已运行并生成 advisory，绝不表示 v0、M1 或外部候选 conformance，也不能作为 M1 prerequisite。
- 将 candidate execution obligation 移交给显式 opt-in 的后续 candidate spec：只有 candidate spec 明确采用 M0 bundle profile/applicability 时，才从冻结 bundle 推导适用 scenario/dimension/race 分母并经真实公开路径形成 observation；未采用的阶段只按自身 OpenSpec requirements/scenarios 验收，M0 fixture/test/receipt/token 均不能自动补票。
- 本 change 只服务 ROADMAP M0：不创建产品 package，不实现状态机/SQLite/Harness/API/UI/tenant，也不修改 v0。M0/M1 不实现 scheduler、Suggestion Center、AgentIntent/capability directory 服务或 ProcessSpec；这些能力必须由具名后续 change 冻结。

不变量检查：

- **单一 owner**：Requirement-ID validation 分别验证 Control outer lifecycle、Harness inner progress、Effect commit、domain outcome 与 process containment，无重叠 retry/terminal authority。
- **event truth**：Run/RunAttempt/action projection 只由 append-only source facts 推导；终态只经唯一 choke point。
- **Effect Gateway**：受控 mutation 必须经过 intent、policy/Approval、claim、dispatch 与 ExternalOutcome/reconciliation；receipt 仅在存在时作为证据，`unknown` 不自动重提，Harness 不能重试 unknown/committed Effect。
- **typed API**：M0 只冻结未来 Control/Harness 共用类型与错误，不建立第二控制入口或 Agent-to-Agent API。
- **no dual write**：oracle 与 inventory 均为只读；v2 identity、DDL 与 fixture 不写 v0 DB，也不共享 v0 Run identity。

## Capabilities

### New Capabilities

- `v2-control-contracts`: 核心对象、authority、Run/RunAttempt 状态、Harness/action/checkpoint 边界、错误、health、process 与 Effect 契约。
- `v2-storage-contract`: v2 SQLite DDL、RunAttempt/action/Effect identity、source-fact ordering、唯一约束、事务、projection rebuild、authority-fenced recovery 与 epoch fencing。
- `m0-evaluation-oracles`: adapter-neutral 行为定义 bundle、Inbox/Auto Developer Harness fixture definitions、cutover crash points、inventories、attribution 与成本测量口径；只有显式采用该 bundle 的 candidate spec 才拥有对应 execution obligation。

### Modified Capabilities

无产品 capability 语义变更。三份 v2 主 specs 已同步到 `openspec/specs/` 并只由外部 `openspec-cn` 管理；M0 code/tests不解析其内容。`main` 上的 v0 specs只作为冻结历史来源生成的oracle metadata。

## Impact

- 应用本 change 只产出 `contracts/v2/`、`oracles/m0/`、`measurements/`、只读 validator 与 M0 tests；不创建产品 package、Harness、store、API 或 daemon 实现。
- I1 gap ledger、Q3 policy roots、direct gates、receipts、fixture-plan 与 composite measurements 保留为 superseded/historical evidence，证明 test-side semantic authority 不可闭合；它们不再参与 runtime 或 aggregate PASS。M0 验收要求 41/244/233/88 集合与 565 definition denominator 零漂移、618 个 aggregate gates 全部以 `local | external | definition | aggregate` basis 闭合、删除/重复/悬空任一规范成员均 non-pass，且 validator 不 import Q3/fixture runner。`M0 advisory: READY` 不授权 handoff 或 implementation；独立 entry artifact 通过后才激活已记录的 `USER-M1-AUTH-2026-08-22` 条件授权，M1+ 候选随后可在真实产品路径执行，无需第二次授权。
- 冻结 artifacts保留 `main` v0与相邻 Inbox/Auto Developer 的 revision/source metadata；M0 tests不再运行时解析这些仓库的OpenSpec Markdown，也不复制其领域模型进control-core。
- 使用证据来自真实 Inbox 加中立 Heartbeat/Auto Developer process fixture；M0 不接入租户。AgentScope/LangGraph 等外部候选只作为同 fixture 下的 Harness adapter/完整平台 benchmark。
- 回滚方式是删除本 change 将来产生的 M0 artifacts 并保留 SOT；没有数据或运行时迁移。
- 五个主动开发日内若无法为 RunAttempt、checkpoint、Effect、process/cutover 给出唯一预期，停止扩展并缩回 `Release → Activation → Run → RunAttempt → Event → Effect`。
