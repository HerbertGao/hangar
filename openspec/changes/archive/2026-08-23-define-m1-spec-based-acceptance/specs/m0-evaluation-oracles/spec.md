## MODIFIED Requirements

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
