# m0-evaluation-oracles Specification

## Purpose

定义 Hangar v2 的非授权评估清单、冻结分母、来源追溯与故障矩阵，使后续候选只能用真实公开执行证据接受检验，而不能由 M0 fixture 或 token 自行授权。

## Requirements

### Requirement: 适配器中立的 oracle 格式与权威可追溯性

**Requirement ID:** `m0o.format` SHALL 作为本需求的稳定身份。

每个规范性场景 SHALL 拥有由其需求所有者显式分配的稳定机器清单 slug；`scenarioId = requirementId + '.' + slug`。Slug 在该需求内 MUST 唯一，MUST NOT 根据可变的 Markdown 标题或序号生成，且一旦冻结就 MUST NOT 被复用。Markdown 场景标题是与这些清单 ID 一一映射的展示文本。

每个 oracle 用例 SHALL 拥有稳定的用例 id；恰好一个可解析的 `requirementId + scenarioId`；冻结的机器 definition version；输入；公共观察 schema；恰好一个预期结果；以及由 oracle owner 冻结的 `applicabilityPredicate`、适用 qualification profiles 和封闭 exclusion-code 集。完整 case universe SHALL 在候选执行前冻结。Evaluator 根据已签名调用中预先选择的 profile、目标 host/tenant 与公开 capability claim 自行推导 `applicable | excluded-with-owner-reason`；候选不能提交或修改 disposition。所有 `neutral-control-storage`、`evaluator-self-test` 以及所选 profile 标记为 required 的 case 均不可排除。其他排除必须使用 manifest 允许的 owner reason code 和可验证 evidence ref；任意自由文本、执行后排除、缺少证据或谓词不匹配均使 invocation 无效。改变 predicate/profile/reason 会改变 oracle source hash，不能与旧分母混算。需求标题/路径是展示元数据，而非身份。可追溯性清单 SHALL 将每个 Markdown 场景映射到恰好一个清单 scenarioId，并将每个 scenarioId 映射到一个或多个适用的证据用例，同时拒绝重复/悬空 ID、未映射标题、拥有多个语义所有者的用例，或复述/违背其所有者的用例。

每个场景 SHALL 从 `neutral-control-storage`、`evaluator-self-test`、`named-tenant` 和 `named-process-host` 中声明恰好一个必需覆盖类别。公共观察仅涉及纯 schema、状态、身份或存储语义的 `v2c.*`/`v2s.*` 场景 SHALL 使用符合 schema 的领域中立 fixture。需要真实 OS 进程、launcher 或主机控制的场景 SHALL 使用具名进程/主机 fixture，即使其所有者 id 是 `v2c.*` 或 `v2s.*`。Evaluator/validator 行为 SHALL 使用 self-test；租户行为 SHALL 使用其具名租户 fixture。额外候选和排除项 MAY 被记录，但不能满足或取代那个必需类别。Oracle 代码/数据 MUST NOT import 候选内部常量、数据库模块、状态分类器或 gateway helper。

#### Scenario: 同一用例评估两个候选

- **WHEN** 两个候选适配器执行一个适用的生命周期用例
- **THEN** evaluator 将它们的公共观察与同一个共享预期进行比较

#### Scenario: Oracle 发明第二套状态定义

- **WHEN** 一个用例嵌入的生命周期语义无法归属于恰好一个规范性需求场景
- **THEN** 可追溯性验证失败，而不是把 oracle 当作另一个权威

#### Scenario: 场景标题被重命名

- **WHEN** 展示文本发生变化，而其显式清单 slug 和语义保持不变
- **THEN** scenarioId 和所有 oracle 引用保持稳定

#### Scenario: 候选排除困难用例

- **WHEN** 候选自行标记 case 不适用，或 evaluator 在执行后使用未由 owner manifest 允许的理由排除它
- **THEN** invocation 以 typed applicability error 失败，case 仍留在完整 universe，且不会产生资格 PASS

### Requirement: 经筛选的 v0 行为与 reaper oracle

**Requirement ID:** `m0o.v0-reaper` SHALL 作为本需求的稳定身份。

v0 oracle SHALL 仅保留由固定 `main` 证据支持且具有外部价值的语义：事件派生状态；唯一终态 choke point；取消竞态中的首个终态；Approval CAS/幂等性；安全错误；只读且无写入；stdout 输出数据/stderr 输出日志；JSON 模式；退出码 `0/1/2`；以及基于 PID 加启动时间身份的进程回收。每项源行为 SHALL 被分类为 `preserve`、`known-false-green-to-fix` 或 `excluded`，并附理由。四表布局、不透明的 PipelineExecutor、内存 pending queue 和具体 parked-state wrapper SHALL 不得在缺少独立公共不变量时成为 v2 需求。

reaper 用例 SHALL 观察身份与收敛，而不是实现调用：匹配的活动身份仍归其所有者；所有者死亡导致恰好一次终态化和清理序列；启动时间不匹配的复用 PID 永远不会被发送信号，也不会被视为旧进程；重复恢复具有幂等性；终态清理后不存在受管的活动子进程或活动所有权记录。候选适配器 MAY 暴露不同的进程内部细节，但 SHALL 将它们映射到此观察 schema。

#### Scenario: 所有者进程已死亡

- **WHEN** 恢复过程观察不到与所记录 PID/启动时间身份匹配的活动进程
- **THEN** oracle 预期恰好一次终态收敛和所有权清理

#### Scenario: PID 已被复用

- **WHEN** 所记录的 PID 仍活动但启动时间不同
- **THEN** oracle 预期不向该进程发送信号、不产生错误存活判断，并使过期所有权记录收敛

#### Scenario: Reaper 恢复重复执行

- **WHEN** 同一个死亡所有者恢复在终态清理后再次运行
- **THEN** oracle 预期沿用现有终态结果，且不产生第二次清理副作用

#### Scenario: v0 实现细节被提议为需求

- **WHEN** 一个用例仅依赖可替换的 v0 存储或 pipeline 细节
- **THEN** 该用例被排除并附理由

### Requirement: 完整的权威与故障矩阵

**Requirement ID:** `m0o.fault-matrix` SHALL 作为本需求的稳定身份。

oracle 集合 SHALL 覆盖由 `v2c.*` 和 `v2s.*` 所有、并通过其 `m0o.format` 必需覆盖类别落实的每个场景，包括规范 release/ExecutionClosure 向量、稳定 ID、权威/policy/time、命令重放/读取披露、每个状态表单元格、RunAttempt/action/checkpoint 与保留的 schedule 身份、source-fact union/hash chain、进程 containment 生命周期、Harness projection/grants、受限 launch/attestation、直接操作、Effect 生成/receipt/outcome/reconciliation、事务崩溃、handoff 以及受权威 fencing 的 restore。每个用例 SHALL 指明唯一一个预期终态、错误、身份、事实序列、资格判定或重新派发结果。

完整性验证 SHALL 枚举每个所有者清单的封闭维度中的每个值——包括 command/event/fact kinds、Activation/Run/RunAttempt/Approval/Effect/reconciliation 状态、RecoverySession/AgentAttempt/RecoveryQualification/RecoveryDiscoveredOperation/BindingCertificate/ActivationPermit lifecycle、权威类型、主机 statuses/modes 和 projection families——并要求每个已声明消费者处理或显式拒绝每个值。若某个所有者清单值在状态表、事务、projection、恢复分母或适用 oracle 中缺失，则 fan-out 验证失败；evaluator 清单消费这些维度，并且 MUST NOT 重新定义它们。一个具名 safe-error gate SHALL 枚举每一种 `v2c.errors` kind，并证明 message-template/detail-schema 版本、字段类别、sanitizer/字节边界、未知字段拒绝、可重试性以及不披露 stack/path/敏感信息；宽泛的测试套件成功不能替代此 gate。

M0 SHALL 将完整规范集合冻结为 definition denominator，而不是 execution bindings。该集合恰好由 244 个 scenario definitions、233 个 closed-dimension definitions 与 88 个 recovery-race definitions 组成，总数 565；另有 41 个 Requirement definitions。Validator MUST 从规范 owner 与 machine-readable manifests 独立枚举这些集合，并拒绝缺失、重复、未知、悬空引用、标题/ID 不一一映射、非法 exclusion 或由另一份手写清单自证的成员。

每个 scenario definition SHALL 绑定稳定 `scenarioId`、唯一 `requirementId`/owner、展示标题、required coverage class、case、owner-frozen applicability 与 expected public observation。OpenSpec Markdown的结构和WHEN/THEN只由独立external validator检查，不复制为M0 code/test中的path或digest。M0 只验证这些定义相互一致且没有含糊结果；它 MUST NOT 启动 test-side candidate、direct gate、owner callback 或 fixture runner，也 MUST NOT 把 TAP、共享测试文件、回显 ID、digest 格式、claimed observation、receipt 或 definition validity 提升为 candidate execution。

每个 closed-dimension definition SHALL 绑定 owner manifest 的 exact JSON pointer，或 exact SQLite table/column/constraint/trigger/transition locus，并定义未来 candidate consumer 必须处理或显式拒绝的值；同名 token 只出现在错误 locus 不满足定义。M0 验证 233 个成员及其 locus/owner 闭合，但不声称已运行候选 consumer。

每个 recovery-race definition SHALL 绑定 exact recoveryRacePoint、disposition、唯一 caseId、唯一 typed expected source-fact/command/external-state 结果，以及未来 candidate execution obligation。结构性不适用 cell 仍留在 88-member definition denominator，expected 为 `not_applicable_by_construction` 并要求未来执行证明零 mutation/authority call；它不是 exclusion 或 skip。M0 验证完整 22×4 笛卡尔积和唯一映射，不在 disposable SQLite 中运行 test-side race model。

后续 candidate spec MAY 显式采用本 bundle 的 profile/applicability 作为其 qualification universe；只有这种显式采用才能要求候选逐项执行 scenario/dimension/race obligations。未显式采用本 bundle 的阶段 SHALL 只按该阶段自己的 OpenSpec requirements/scenarios 验收，M0 definitions、token、fixture、receipt、TAP、digest 或测试文件 PASS MUST NOT 自动成为其分母或补票证据。任何采用本 bundle 的候选仍 SHALL 通过真实公开 package API、fresh durable rows/facts、process exit/containment 或重建 projection 形成 actual observation；Missing、extra、duplicate、unknown、未运行或候选自报不能满足 obligation，且 actual 与 expected MUST NOT 由同一产品函数生成。候选测试 MAY 使用静态 `{scenarioId, productCall}` 数据表，但不得创建通用 WHEN/THEN interpreter、public evidence registry 或第二状态机。

完整性验证 SHALL 包含以下固定回归类别：领域术语比较与 attestation；safe-text registry 失败；可变 proof 被排除在 release 之外；非安全整数与 command canonicalizer 拒绝/版本重放；issuer-namespace subject 冲突；未声明的动态执行；跨 release schedule 身份以及 M0/M1 scheduled-admission 拒绝；command target/precondition 冲突、command-result 崩溃原子性与 zero-row CAS 拒绝；represented-subject 分离；封闭 projection/host-mode fan-out；使用已过期/被取代 host generation 的 active transition、Run admission 与 Effect dispatch；RunAttempt/checkpoint 分配崩溃；checkpoint obligation kind/owner/generation 与唯一 successor handoff chain 验证；AttemptQuiesced 消费与旧 session 的 action/event/EffectIntent/checkpoint/grant/child launch 迟到竞态；action registration 重放/parent 验证；outer/inner retry 重叠；无 dispatch 的 receipt；单操作 Effect 强制执行；无 receipt 的 not-committed 解决；final 前冲突、final 后冲突隔离以及权威冲突解决；拒绝提升 unknown/unresolved；拒绝非空 M0/M1 direct-exception；拒绝 SourceFact 前缀截断；containment registration 崩溃、后代逃逸以及被取代 production-child proof；database clone/open 拒绝、clean-restart continuation 崩溃、identity-initialization 崩溃、数据库级 RecoverySession/proposed-target 预分配/authority binding、同库多 Agent 共享 target 与独立 qualification/epoch，以及 lineage/source/target restore 身份；所有恢复阶段前的 fresh time；仅权威 lineage instance、snapshot 后 dispatch 发现、RecoveryDiscoveredOperation 稳定 discovery-key/ownerAgent identity、外部 membership registry、跨 Agent/target 冲突 fence、失联 target 的 TargetAuthorityClosed proof、持久化/封闭 lifecycle/post-final conflict 及 terminal Qualification 不重开；receipt/reconciliation 上的 producer-authority 证据；有限 mutation-authority 分母与旧实例 registration-closure 并发；每个 RecoverySession/Agent/qualification 至多一个进行中的 Agent attempt、数据库 init/Agent abort 重放与 abort 崩溃；BindingCertificate 与不可导出 permit 的正常 recover-activate 路径；bound 后 permit 过期/主机 generation 变化的同决策重签，以及 bound×RecoveryPostFinalConflict/RecoveryAgentBindingConflict 的 permit revoke/binding-invalidated 收口；RecoveryAuthority epoch；ready-artifact 过期/轮换/未绑定 conflict 与 pending recover-activate 终结；恢复目标不匹配；authority-CAS/SQLite 崩溃；绑定后的权威变化；activation 响应丢失；子进程 environment/descriptor 泄漏；whole-tree reap 与 attestation 重放；v0 reaper PID 复用；Inbox split/merge normalization；Harness attribution 完整 universe、owner-owned exclusions、零/漏跑拒绝；coverage-class 分离；aggregate-gate 完整性；未运行 blockedBy 因果关系/循环拒绝；嘈杂 external-validator 捕获；封闭 safe-error details/scrubbing；以及规范 JSON/action/checkpoint 身份。

恢复竞态 SHALL 另有封闭 `recoveryRacePoint` union：`session-recorded`、`session-init-cas`、`session-abort-cas`、`session-local-init`、`session-local-retire`、`agent-abort-cas`、`agent-local-abort`、`prebind-finalization`、`binding-cas`、`recovery-conflict-fact`、`binding-invalidation-cas`、`binding-invalidation-local`、`activation-success-cas`、`session-init-local-ack`、`session-retire-local-ack`、`agent-abort-local-ack`、`activation-success-local-ack`、`binding-invalidation-local-ack`、`agent-binding-conflict-target-ack`、`target-authority-close-cas`、`target-authority-closed-proof` 和 `agent-binding-conflict`。Evaluator SHALL 冻结完整 `recoveryRacePoint × (crash-before | crash-after | response-loss | competing-command)` definition 笛卡尔积；owner/candidate 不得把任何格移出分母。每个格必须映射到唯一 caseId、唯一 typed expected source-fact/command/external-state 结果和一个 future candidate execution obligation。若某种 fault 对某 point 在结构上不可发生，该格仍以 `not_applicable_by_construction` 留在 definition denominator，并要求未来 candidate execution 证明零 mutation/authority call；它不是 exclusion 或 skip。M0 Validator SHALL 独立枚举完整笛卡尔积并与 case/definition-gate 集合计数相等；伞形测试文件名、散文声称覆盖、共享 case 或 N/A 排除均不能满足任一 cell。

#### Scenario: 恢复竞态矩阵漏格

- **WHEN** 完整 recoveryRacePoint × disposition definitions 中任一格没有唯一用例、唯一 typed expected 与 future execution obligation，以 N/A/skip 移出分母，或复用其他格的 definition
- **THEN** M0 fault-matrix/aggregate definition validation 失败；显式采用该 matrix 的 candidate 还必须在真实执行上逐格满足适用 obligations，不能用 M0 PASS 补票

#### Scenario: 需求场景缺少其必需覆盖类别

- **WHEN** 一个场景缺少其唯一 required coverage class、case、applicability 或 expected public observation，纯中立定义与进程/主机定义被相互替代，或 closed-dimension definition 只在错误 locus 找到同名 token
- **THEN** M0 definition validation 失败，且不根据 owner-id 前缀、共享测试文件 PASS、reporter callback-name/PASS、可重算 digest、回显 ID、全局 token 命中或排除项推断覆盖；显式采用本 bundle 的 candidate execution 仍须单独完成

#### Scenario: 范围内用例被临时跳过

- **WHEN** 一个范围内 scenario definition、fan-out member 或 owner conflict 被标记为临时、已跳过或未决定
- **THEN** M0 bundle validation 在获得唯一完整定义前不能输出 PASS；候选执行阶段的未运行成员同样不能取得 qualification

#### Scenario: Oracle 预期含糊不清

- **WHEN** 一个故障用例允许多个可观察结果
- **THEN** 该清单无法冻结
### Requirement: Inbox 对等清单与冲突权威

**Requirement ID:** `m0o.inbox` SHALL 作为本需求的稳定身份。

Inbox 清单 SHALL 枚举规范化租户需求，包含稳定 id、源 revision/hash、类别、权重、hard-gate 标志、预期行为和 supersedes chain。默认情况下，一项源需求 SHALL 映射到一条规范化记录。任何 split 或 merge MUST 拥有显式所有者决策，将所有源 id 绑定到所有产生的规范化 id，并保留 hard-gate 值，除非该决策指定更严格的替代项；自动推断不能创建、丢弃或弱化 hard gate。Inbox 项目所有者 SHALL 是唯一冲突保管者。每项冲突决策 SHALL 指明源 id、规范化 id、所有者身份、结果和理由；未决定的映射/冲突会阻塞分母冻结。

Inbox 概念 SHALL 仅保留在此租户 fixture 中。核心 oracle SHALL 消费公共 Control 观察，并且 MUST NOT 向任何规范性核心 spec 添加 Inbox 字段。

#### Scenario: 缺少硬性安全行为

- **WHEN** 清单遗漏任何由所有者声明的 Inbox 安全 hard gate
- **THEN** 对等分母冻结失败

#### Scenario: 源需求在无保管决策时被拆分

- **WHEN** normalization 在没有保留每个源 id 和 hard gate 的所有者决策时 split 或 merge 源需求
- **THEN** 分母冻结失败，而不是推断该映射

#### Scenario: 领域概念泄漏到核心

- **WHEN** 仅属于 Inbox 的标识符出现在核心 schema 中
- **THEN** 领域中立性验证失败

### Requirement: Auto Developer Harness fixture 与分层所有权

**Requirement ID:** `m0o.process-fixture` SHALL 作为本需求的稳定身份。

进程清单 SHALL 为父进程死亡、迟到/逃逸后代、部分 JSONL、spawn 期间取消、TERM-to-KILL 升级、含糊 Effect、checkpoint/resume、双 scheduler 和重叠 retry 固定可复用且领域中立的场景。每个场景 SHALL 指明 Control Run/RunAttempt/retry/terminal/containment 所有者、Harness 内部 session/retry 所有者、公共 ActionEvent/grant/checkpoint/Effect 证据以及唯一收敛结果。

在 M5 期间，Auto Developer 在一个 RunAttempt 内保留内部 phase/session/watchdog、model/transport retry、resume 和逻辑后代调度。这些 retry MUST NOT 创建 Hangar attempt 或 terminal fact，并且当 HarnessSession/containment 仍活动或身份含糊时，Control MUST NOT retry。独立于此，Hangar Control MUST 证明其专用 containment 能在父进程死亡、超时或取消时 hard-reap 完整后代树；租户的优雅清理不能替代该证明。完整外部平台候选 MAY 仅在作为替代所有者接受评估时拥有完整外层生命周期，绝不能与 Hangar 同时拥有同一个 Run。

#### Scenario: 候选借用租户 supervisor

- **WHEN** 候选的内部 retry/resume 仅因租户 supervisor 对其拥有所有权而成功
- **THEN** 这被计为 Harness 兼容性，而不是将该内部所有者迁入 control-core 的证据

#### Scenario: 顶层 retry 与活动 session 重叠

- **WHEN** Control 在先前外部 session 或 containment 仍活动或含糊时启动另一个 RunAttempt
- **THEN** fixture 因 retry 所有权重叠而失败

#### Scenario: 租户清理掩盖 containment 缺失

- **WHEN** 后代仅因租户 supervisor 回收它们而消失，且 Hangar 无法独立 hard-reap 完整进程树
- **THEN** 即使 happy-path Run 收敛，生产进程资格判定仍失败

### Requirement: Harness 归因与 ProcessSpec 证据

**Requirement ID:** `m0o.harness-attribution` SHALL 作为本需求的稳定身份。

当且仅当 candidate spec 显式采用本 bundle 的某个 profile/applicability 作为 qualification universe 时，evaluator SHALL 从 `m0o.format` 的完整 case universe 和 owner-owned applicability predicate，在执行前为该 candidate 冻结 `manifestApplicableCases` 封闭分母。未显式采用时，evaluator MUST NOT 为阶段验收创建或推导分母；M1 Heartbeat stage acceptance 只服从其自身 OpenSpec requirements/scenarios。每个 universe member SHALL 有且只有一个 evaluator 推导的 `applicable | excluded-with-owner-reason` disposition；required case 不可排除，适用分母 MUST 非零，且每个适用 member 都必须产生 executed observation 或显式 evidence failure。候选自报排除、未获 owner 允许的 reason/evidence、未运行、丢失或只有候选私有证据的适用项不能从分母移除。对于每个用例，公共 source fact SHALL 唯一标识负责的 RunAttempt，以及适用时的 action 和 parent action；有效 grant 和实际 runtime/tool 身份；input/output checkpoint 及其 producer；每个 Effect 身份/outcome/reconciliation obligation；恢复点；outer/inner retry 所有者；terminal 所有者；以及 process-containment 所有者。任何必需维度缺失、含糊、矛盾或仅可从候选私有存储获得，都会使该用例成为 `opaque`；不得仅因候选证据缺失而排除。

`opaqueRate = opaqueApplicableCases / manifestApplicableCases` SHALL 根据执行前冻结的清单成员计算且不做舍入，并且 MUST 不大于 `0.05`。`manifestApplicableCases = 0`、executed disposition 数与分母不相等、或任一适用 member 没有 observation/evidence-failure result 都 SHALL 返回 typed evaluator failure，绝不能把 `0/0`、漏跑或缩水分母解释为 PASS。任何 capability/grant 绕过、outer/inner retry 重叠、terminal 所有者重复、Effect redispatch 违规或 whole-tree reap 不完整都是边界违规，并且 MUST 导致资格判定失败，无论 opaqueRate 为何。

三个具名租户 pilot 各自 SHALL 另行记录一项与故障用例关联且由所有者签署的决策 `platformDependencyState = required | not-required | undecided`。仅当 pilot 证明某个正确恢复失败无法通过 versioned checkpoint、ActionEvents 或租户自有状态修复，除非赋予 Control 由平台解释的内部依赖时，`required` 才有效。两个或更多 `required` 决策允许提出单独的可选 ProcessSpec change；它们不会创建该权威，也不满足 M0。少于两个时，禁止将 ProcessSpec 用作共享核心 workaround。

#### Scenario: 归因分母超过不透明度闸门

- **WHEN** 已执行的适用故障用例中，超过 5% 缺少任何必需 action/grant/checkpoint/Effect/recovery 归因
- **THEN** 即使每个 Run 都达到终态，聚合资格判定也会失败

#### Scenario: 适用分母为零或有用例漏跑

- **WHEN** 候选的 manifest 适用分母为零，任一 required case 被排除，或任一适用用例没有 executed observation/evidence-failure disposition
- **THEN** evaluator 返回 typed failure，不计算可通过的 opaqueRate，也不输出资格 PASS

#### Scenario: 边界违规很少见

- **WHEN** 一个用例绕过 grant、重叠 retry 所有者、重新派发 unknown/committed Effect 或留下未被 containment 的后代
- **THEN** 无论用例总数或 opaqueRate 为何，资格判定都失败

#### Scenario: 候选私有 trace 提供唯一解释

- **WHEN** 只能通过读取外部 Harness 的私有 session store 来归因某项失败
- **THEN** 在必需证据映射进 Hangar source fact 之前，该公共用例是不透明的

#### Scenario: 两个租户需要平台依赖状态

- **WHEN** Inbox、Auto Developer 和 AI Radar 中至少两个拥有来自匹配故障 pilot 的有效 `required` 决策
- **THEN** 该证据可以开启一个单独的可选 ProcessSpec change，但不会改变当前契约

#### Scenario: 一个租户偏好宏观阶段

- **WHEN** 需要平台解释依赖的有效租户决策少于两个
- **THEN** evaluator 拒绝将 ProcessSpec 作为当前共享核心需求
### Requirement: Cutover 单一生产所有者 oracle

**Requirement ID:** `m0o.cutover` SHALL 作为本需求的稳定身份。

Cutover 用例 SHALL 引用 `v2c.activation` 和 `v2s.handoff`。它们 SHALL 覆盖 mutation-disabled evaluator shadow、旧 cron/manual/intent barrier、drain、Approval、最终 ExternalOutcomes/reconciliation、最终旧 epoch、更高 epoch promotion、stale mutation 拒绝、canary 和更高 epoch rollback。Dual-read MAY 被观察到；production dual-write 或 dual admission MUST 失败。

#### Scenario: Enabled false 仍允许手动准入

- **WHEN** 候选仅使用 `enabled:false`，而手动准入仍然可能
- **THEN** cutover 验证失败

#### Scenario: 旧所有者关闭后发生崩溃

- **WHEN** cutover 在合格的新所有者 activation 之前崩溃
- **THEN** oracle 预期生产可写所有者数量为零

#### Scenario: 未解决的 reconciliation 跨 handoff 携带

- **WHEN** reconciliation 所有权发生转移，但某项 obligation 仍为 unknown、pending、claimed 或 unresolved
- **THEN** oracle 预期不进行 production promotion 或新 dispatch

### Requirement: 完整的直接 Effect 与业务敏感材料持有者清单

**Requirement ID:** `m0o.effect-inventory` SHALL 作为本需求的稳定身份。

M0 SHALL 将完整的 v0 app registry、entrypoints 和 source tree 固定为分母。每个成员 SHALL 拥有自动扫描证据或显式人工处置。清单 SHALL 按稳定 location、owner、sink、operations、authorization capability、risk、gateway status、migration disposition，以及每个直接例外的外部 discovery/recovery method，记录发现的外部 mutation 和业务敏感材料持有者。它们 MUST 仅包含引用，绝不包含解析后的值。

每个 release-hashed direct-Effect 例外 SHALL 链接到恰好一条清单记录。用例 SHALL 证明 operation-level denial、mutation-capable authorization treatment、shadow grant removal、exception-count monotonicity，以及任何非空例外列表在 M0/M1 中无条件不具备 production/restore 资格。恢复发现仍是可能用于后续 SOT change 的清单证据，而不是绕过当前 gate 的许可。

#### Scenario: 清单成员没有处置结论

- **WHEN** 固定分母中的某个成员缺少扫描证据和人工处置
- **THEN** 清单完整性验证失败

#### Scenario: 直接例外缺少恢复方法

- **WHEN** 一项直接 mutation 既无法从外部枚举，也无法在 snapshot 后证明不存在
- **THEN** 清单与生产恢复资格判定失败

#### Scenario: 清单中出现解析后的值

- **WHEN** 验证检测到的是值而非引用
- **THEN** 验证拒绝该清单，且不输出该值

### Requirement: 受限主机 oracle 映射

**Requirement ID:** `m0o.host-mapping` SHALL 作为本需求的稳定身份。

主机 oracle SHALL 枚举目标主机集合，并将证据映射到 `v2c.runtime-boundary`、`v2c.host-attestation`、`v2c.process-lifecycle`、`v2c.release-identity` 和 `v2c.time` 中每种封闭的 attestation mode 与 control。它 MUST 消费这些规范中的 statuses、generations、issue/expiry 证据、permissions 和 grant model，而不重新定义它们。用例 SHALL 覆盖 profile/closure drift、stale cycle/challenge、同一 cycle 内 generation 失效、expiry、不受支持主机、environment/descriptor/control-plane reachability、context-bound grant replay、实际 runtime identity 以及 mutation-disabled evaluator execution。

#### Scenario: 主机映射不完整

- **WHEN** 某个目标主机、必需 control 或请求的 launch mode 没有证据映射
- **THEN** 验证失败，而不是报告空洞的覆盖

#### Scenario: Probe 失败以不同方式影响各模式

- **WHEN** 当前 probe 失败
- **THEN** oracle 预期拒绝 production 和 mutation-capable launch，而仅有显式 mutation-disabled evaluator 路径可以携带所有者定义的 marker 继续执行

### Requirement: 仅追加的度量账本

**Requirement ID:** `m0o.measurements` SHALL 作为本需求的稳定身份。

M0 SHALL 冻结 `T_attempt`、`T_ready`、`C_platform`、`C_enable`、glue LOC、cold start、idle/peak RSS、disk、process count 和 12-month TCO 的定义与证据字段。记录 MUST 包含 environment、start/end boundary、collection command/source 和原始证据；更正 SHALL 追加记录，而不是覆盖。

#### Scenario: Agent 专属设置被隐藏为平台成本

- **WHEN** 一项度量从 `C_enable` 中遗漏候选专属 adapter、prompt 或 configuration 工作
- **THEN** 验证因记录不完整而拒绝它

### Requirement: 只读且可复现的评估

**Requirement ID:** `m0o.reproducibility` SHALL 作为本需求的稳定身份。

所有 M0 提取和验证 SHALL 固定 revisions/content hashes，避免生产敏感值与外部 mutation，并使本仓库、相邻仓库和 SQLite 文件保持不变，但已声明的 M0 输出除外。干净 checkout SHALL 能从固定源和已声明 prerequisite 复现验证，或在接受部分 artifact 之前返回 typed missing-source/prerequisite error。

M0 validator SHALL 只执行 non-authorizing advisory checks：冻结 JSON source/prerequisite pins、Requirement/Scenario ID 与 owner 一致性、case/expectation/applicability/coverage 完整性、closed-dimension locus、recovery-race 笛卡尔积、schema/manifest 结构、aggregate DAG/precedence、external adapter、output manifest、measurement supersession 与 no-write。它 MUST NOT import、解析或 hash `openspec/` 的 Markdown/config/change layout，也 MUST NOT 启动 M0 scenario gates、fixture runner、candidate adapter、test-side transition/SQLite/process model 或 mint/consume execution receipt。OpenSpec 只可由独立 external process gate `openspec-cn validate --specs --strict --json` 验证；其版本与文件布局不进入 M0 code/test constitution。`fixture-plan.json` 不属于 M0 output。

Verifier-owned constitution SHALL 固定且独立于 manifest hash：允许执行的非 OpenSpec prerequisite commands；coverage class 到 fixture/schema/applicability/profile/exclusion 的 exact mapping；21 个 dimension id/owner/locus resolvers；22 个 recoveryRacePoint 与四个 dispositions；aggregate manifest 唯一冻结的 11 local、1 external、41 Requirement、244 Scenario、233 dimension、88 race denominator；result kinds/bases/field sets/token；以及同一 metric/environment 内不可分支的 measurement supersession chain。Manifest MAY 提供 revision、content digest、raw evidence 与 typed definition data，但 MUST NOT 选择 owner、command、coverage policy、race union、gate topology 或成功 authority。重算所有 manifest hash 不能改变上述 constitution。

当前 compiler/validator 的任何未闭合 path confinement、measurement typing、intrinsic binding 或 dynamic test-discovery finding SHALL 进入 append-only known-gap ledger，并使其不能获得 M1 阻断/授权地位；本 change 不再把 hermetic closure 作为完成条件。`all` 结果只汇总 diagnostics，MAY 用于定位本仓库问题，但不得被 client、Control、M1 entry 或 candidate qualification消费。

每个 Requirement/scenario/dimension/race aggregate member SHALL 由 validator 对其冻结 definition 直接产生 result，basis 恰为 `definition`。`executed=true` 仅表示该 definition validation check 实际运行；它不表示 candidate operation、fault、process 或 transition 执行。`fixture`、`fixture+definition`、receipt、TAP、callback、shared test PASS、claimed observation、64-hex digest 或 caller supplied result MUST 被 result schema/aggregate 拒绝，而不是降级为诊断性成功。

M0 aggregate 或 evaluator MUST NOT 接受 candidate execution report 作为本 change 的 PASS 输入。Candidate semantic evidence 由 M1+ 独立 change 按冻结 applicability 产生和验收；M0 `all` 只输出 bundle status。旧 Q3/I1/composite transcript、policy root、fixture result 或 receipt 只能保留为 historical measurement/review evidence，MUST NOT 被重新解释为 definition 或 candidate execution。

validator 结果清单 SHALL 将结果 kind 封闭为 `pass`、`contract_failure`、`evidence_failure`、`prerequisite_missing`、`missing_source` 和 `invalid_invocation`，并将 basis 封闭为 `local | external | definition | aggregate`。每个本地 subcommand SHALL 返回 typed result envelope，并且 MUST NOT 输出 PASS token。版本化 aggregate-gate 清单 SHALL 将每个稳定 Requirement、Scenario、closed-dimension、recovery-race definition、已声明本地 subcommand和 external validator 映射到恰好一个必需 gate，总数为 618；其中 41 个 Requirement definition gates 加 565 个 scenario/dimension/race definition gates，合计 606 个 definition gates。每个 gate SHALL 声明有序 `dependsOn` 列表；清单顺序 MUST 是拓扑顺序。Meta-validation SHALL 拒绝缺失、重复、未知或不可达的成员，未知/前向/循环依赖，及任何 `fixture`/receipt basis，并从该清单派生固定 gate 顺序。

每个 external validator SHALL 通过已声明 adapter 运行，该 adapter 捕获 exit status/stdout/stderr、从 aggregate stdout 中抑制原始成功文本、应用 `v2c.errors`，并输出恰好一个 typed gate result。Spawn 失败、timeout、signal、malformed output 或 closed map 之外的 exit 都不能变成 pass。

每个 gate result SHALL 包含 `executed`。`pass` 要求 `executed=true`；对 definition gate，这只表示 definition check 已运行。未运行 gate SHALL 使用 `executed=false`，并仅从其已声明且失败的依赖中选择 `blockedBy`：选择优先级最高的 non-pass kind，并以清单顺序打破平局，然后继承该 kind。它绝不能报告 pass。缺失/未声明/前向/循环的 `blockedBy`、在所有依赖均已通过时故意跳过，或与所选依赖不一致的继承 kind，都会产生 `invalid_invocation`。唯一 aggregate 所有者是 `all`，它 SHALL 返回 `aggregateResult = { primaryKind, findings[] }`；`findings[]` 按顺序列出每个清单 gate 及其 typed result，包括未运行 gate。`primaryKind` SHALL 使用总优先级 `invalid_invocation > prerequisite_missing > missing_source > contract_failure > evidence_failure > pass`。`all` 仅在当前 advisory checks 运行完成且无其自身已建模失败时以 `0` 退出，contract/evidence primary kind 时以 `1` 退出，invalid/prerequisite/source primary kind 时以 `2` 退出；仅 aggregate exit `0` 输出精确的 `M0 advisory: READY`。该 token只说明 advisory 可读取，不能描述为 bundle hermeticity、handoff、implementation authorization 或 candidate conformance；known-gap ledger 仍可非空。

版本化 output 清单 SHALL 枚举每个已声明 M0 output path 及其预期类别。Aggregate 验证 SHALL 直接检查这些文件与非 OpenSpec source manifest，拒绝未声明 output，并忽略活动 change layout和无关 working-tree 变化。Whitespace/content 检查 MUST 读取清单成员本身；整个仓库的 `git diff` 状态 MUST NOT 决定 M0 advisory结果。

#### Scenario: 固定源不可用

- **WHEN** 无法读取必需 repository 或 revision
- **THEN** 验证报告该问题，且不以浮动 working tree 代替

#### Scenario: 必需可执行文件不可用

- **WHEN** 已声明 prerequisite 缺失或不受支持
- **THEN** prerequisite 验证在接受部分 output 前返回 `prerequisite_missing`，退出码为 `2`

#### Scenario: 聚合同时包含不可用 gate 和失败 gate

- **WHEN** 一个已完成 gate 发生 contract failure，另一个必需 gate 因 source 或 prerequisite 不可用而无法运行
- **THEN** aggregate 验证使用完整 primary-kind 顺序，报告两种 typed disposition，不输出 PASS token，且绝不把未运行 gate 计为成功

#### Scenario: Prerequisite 失败后 gate 未执行

- **WHEN** 较早的 prerequisite gate 失败，且依赖 gate 未运行
- **THEN** 依赖结果为 `executed=false`，向后指向该 gate，继承其 non-pass kind，且不能满足 aggregate PASS

#### Scenario: 多个依赖失败

- **WHEN** 未运行 gate 有多个已声明且失败的依赖
- **THEN** `blockedBy` 确定性地先选择最高 result-kind 优先级，再选择最早清单顺序

#### Scenario: 未运行 gate 没有有效阻塞项

- **WHEN** 未运行 gate 省略 `blockedBy`、指向前方/循环依赖、声称 pass，或 Requirement/scenario/dimension/race gate 提供 `fixture`/receipt/candidate observation basis 而不是运行其 definition check
- **THEN** aggregate 验证返回 `invalid_invocation` 或对应的 typed evidence failure，且不输出 PASS token

#### Scenario: 清单中不存在 aggregate gate

- **WHEN** 新 Requirement、Scenario、closed-dimension、recovery-race definition、subcommand 或 external validator 没有唯一 aggregate-gate 映射
- **THEN** meta-validation 失败，且 `all` 无法输出 `M0 advisory: READY`

#### Scenario: External validator 在失败前输出成功

- **WHEN** 外部工具写出类似成功的文本，但随后以非零状态退出、timeout 或输出无效 result
- **THEN** 其 adapter 记录 typed failure，不转发原始 PASS token，且 aggregate 优先级保持确定性

#### Scenario: 无关 working tree 不干净

- **WHEN** 已声明 M0 output 清单之外的文件包含无关编辑或 whitespace error
- **THEN** aggregate 验证忽略它们，同时仍验证每个清单成员和固定 source digest
