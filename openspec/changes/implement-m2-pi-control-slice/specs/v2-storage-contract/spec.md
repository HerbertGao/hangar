## MODIFIED Requirements

### Requirement: 由状态推导的 DDL 与逻辑发生项唯一性

**Requirement ID:** `v2s.ddl` SHALL 为此 Requirement 的稳定标识。

DDL SHALL 从 `v2c.*` Requirements 推导，并强制执行不可变 release 标识、单调递增的 activation epoch、每个 Agent 单一生产 owner、`(runId, runSeq)` RunEvent 唯一性、`(runId, attempt)` RunAttempt 唯一性、`(runId, attempt, quiescenceGeneration)` AttemptQuiesced 唯一性、`(runId, actionId)` action 唯一性、`(runId, actionId, actionEventSeq)` ActionEvent 唯一性、`(runId, checkpointId)` CheckpointRef 唯一性、`(runId, obligationKind, subjectId, subjectGeneration, fromOwnerKind, fromOwnerGeneration)` ObligationOwnerTransferred 唯一性、`(runId, intentKey, intentGeneration)` 逻辑 Effect 唯一性、全局 `effectId` 唯一性、全局 `recoveryOperationId` 及其 immutable authenticated `ownerAgentId` 唯一性、`(recoveryAttemptId, agentId, recoveryOperationId)` recovery-denominator membership 唯一性、全局 proposed/active/historical `controlInstanceId` 唯一性、每个恢复数据库文件恰一个 current RecoverySession/targetControlInstanceId、`(recoverySessionId, agentId, qualificationGeneration)` RecoveryQualification 唯一性，以及每个 `(recoverySessionId, agentId)` 至多一个开放 Qualification/协调 binding 的约束和必需的外键。每个 action SHALL 绑定其不可变的来源 RunAttempt；每个 checkpoint SHALL 绑定其生产者 RunAttempt/action 及规范排序的 obligation refs；每个 AttemptQuiesced fact SHALL 绑定其 session/containment/grant generation 和 obligation-set digest；每个run-action Effect SHALL绑定其不可变首次来源action，Run范围intent唯一性不受重放action影响；每个control-command Effect SHALL绑定不可变control interaction/delivery origin且不得伪造action。每个 SQLite 连接 SHALL 在任何读/写事务之前启用并验证 `PRAGMA foreign_keys=ON`；无法启用时 SHALL 拒绝连接引导。

M2 Effect存储 SHALL增加封闭`subject_kind = run-action | control-command`和CHECK constraints。Run-action行要求runId/actionId/firstOriginAttempt/releaseId/activationEpoch并禁止control字段；control-command行要求controlInteractionIdentity、verified update-ref digest+normalized interaction/derived delivery target、deliveryKey/generation、bounded canonical payload bytes+digest、AuthorityContext/delegation/mapping digest、connector profile/policy/credential generation并禁止run/action/release/epoch字段。全局effectId继续唯一；run-action逻辑键`(runId,intentKey,intentGeneration)`唯一；control-command逻辑键`(controlInteractionIdentity,deliveryKey,deliveryGeneration)`唯一。Approval表只允许run-action Effect；claim表使用subject_kind CHECK并强制各自subject fields。Control-command同delivery key在任何unknown/committed/conflicted/final状态后禁止successor generation。Auth与Telegram transport stores物理独立于Control DB，不可通过这些表保存Control truth。M2 Effect subject schema使用新的database schema version，只可创建fresh disposable DB或从只读M1 source生成versioned副本；本change MUST NOT原地升级或写入M1数据库字节。M2 binary以write mode打开M1 schema时在创建sidecar/transaction前返回typed`migration_required`。

计划触发器定义 SHALL 根据领域无关的稳定 schedule key 及其在 `v2c.release-identity` 下的规范触发语义声明 `scheduleSeriesId`。该 id 受 release 标识覆盖，但 MUST NOT 包含 `releaseId`、release digest、Activation 标识或 epoch。同一 Agent 在不同 release 中语义未变化的 schedule 定义 MUST 保持相同 id；触发器语义变化时 MUST 使用不同 id。`scheduledFor` SHALL 使用来自 `v2c.time` 的规范有符号 UTC epoch-millisecond 时刻。每个未来的计划准入 SHALL 将复合键 `(agentId, scheduleSeriesId, scheduledFor)` 直接存为逻辑发生项标识，而仅将接收该准入的 release/Activation/epoch 作为受 fence 保护的执行上下文；字符串/时区写法绝不参与唯一性。该复合键 SHALL 跨 release、activation 和 owner epoch 全局唯一。这些仅是标识/DDL 向量：在 M0/M1 profile 下，schema MUST NOT 创建 schedule cursor 或接收计划 Run，这由 `v2c.activation` 负责。手动/intent 准入 SHALL 使用持久命令标识，而不是可空的 schedule 字段。

#### Scenario: M2 binary 原地打开 M1 database

- **WHEN**M2 runtime以write mode打开缺少subject-kind schema version的M1数据库
- **THEN**bootstrap在sidecar/transaction/DDL前返回`migration_required`，源文件字节不变；测试只使用fresh或versioned副本

#### Scenario: Effect subject 字段混合

- **WHEN**run-action行携带control interaction字段，或control-command行携带run/action/release/epoch字段
- **THEN**DDL CHECK在fact/projection提交前拒绝整笔事务

#### Scenario: Control-command delivery key 重复generation

- **WHEN**同一interaction/delivery key在已有任一结果后创建相同或更高generation
- **THEN**logical unique/state constraint返回既有Effect或typed rejection，不创建第二个可dispatch identity

#### Scenario: 存储第二个生产 owner

- **WHEN** 一个事务尝试让同一 Agent 的两个 Activation 均可写入生产环境
- **THEN** 约束或受 fence 保护的事务拒绝第二个 owner

#### Scenario: Schedule 发生项跨越 release 或 owner 切换

- **WHEN** 在 M0/M1 下，新旧 release 或 owner 描述同一 Agent、语义未变化的 schedule series 和计划时间
- **THEN** 它们推导出相同的预留 series/发生项标识，但计划准入仍为 `unsupported_schedule`，且不会创建 Run 或 cursor

#### Scenario: 手动准入缺少命令标识

- **WHEN** 手动或 intent 准入缺少持久命令标识
- **THEN** 存储拒绝它，而不是依赖可空的 schedule 字段

#### Scenario: Effect 重放跨越 RunAttempt

- **WHEN** 后续 RunAttempt 在响应或 checkpoint 边界后重放相同的 Run/intent key/generation/operation/digest
- **THEN** 存储返回现有 Effect 标识，同时保留其首次来源 action，并且只能追加重放归因

#### Scenario: Checkpoint 指向另一生产者

- **WHEN** CheckpointRef 指向其 Run 之外的 action，或指向并未追加它的生产者 RunAttempt
- **THEN** 外键/事务验证在它能成为恢复输入前拒绝它

#### Scenario: 外键强制执行被禁用

- **WHEN** 连接启动时关闭了 SQLite 外键强制执行，或尝试执行违反外键的插入
- **THEN** 引导过程或插入在孤立的源记录/投影行能够提交前失败

### Requirement: 显式事务与崩溃边界

**Requirement ID:** `v2s.transactions` SHALL 为此 Requirement 的稳定标识。

契约 SHALL 为以下操作规定原子事务：数据库创世标识加首个 SourceFact；干净重启续用加续用 fact/result；数据库级 restore-init pending 注册加 RecoverySession/proposed target/agent-set digest/预检时间 fact；数据库目标实例初始化加准确 authority-session-target binding/尝试时间 fact、全部 generation-0 Agent qualifications 并完成其 pending 行；release 发布；常规 activation/epoch 变更；Run 准入加初始 event 及 `v2c.run` 主机证据绑定；AttemptQuiesced 追加；RunAttempt 分配加可选输入 CheckpointRef 绑定；幂等 action 注册；ActionEvent/checkpoint 追加及受影响投影；ObligationOwnerTransferred CAS；每个成功写命令结果加 aggregate SourceFact/投影；进程遏制所有权注册加最新 `production-child` generation 及启动 fact；终态 choke point 与清理；Approval 决策；Effect subject/identity加run-action首次来源或control-command interaction绑定；claim 签发；claim 到 `dispatch-started` 的 CAS；receipt 准入；reconciliation claim/outcome；RecoveryDiscoveredOperation 准入及其 recovery-only claim/outcome；subject-specific`PostFinalConflict`（run-action加Activation隔离，control-command加connector/mapping revoke）与`RecoveryPostFinalConflict`安全转换；RecoveryBindingInvalidated 加 artifact invalidation/Qualification terminal/command result；TargetAuthorityClosed proof admission/target retirement；恢复中止终态化/撤销；启动证明 generation/失效；以及当前周期 TimeAuthority 证据。每个 Attempt-derived write 或 launch-registration 事务 SHALL 比较当前 Attempt/quiescence generation；AttemptQuiesced 提交后的旧 EffectIntent、checkpoint、action/event、outcome proposal、grant/child/containment registration 均以 typed stale-Attempt 零写入失败，只有 `v2c.run-attempt` 白名单中的 Control cleanup 与既有 obligation late outcome 可追加。RunAttempt 分配事务 SHALL 以单行 CAS 消费准确且未消费的 AttemptQuiesced fact，同时比较先前 Attempt terminal/current-attempt number、sealed containment generation、grant-revocation generation、当前 obligation-set digest，以及 CheckpointRef 中每个 obligation 的 immutable subject generation、完整 owner-successor chain head 与最终 state；任一不匹配或零行结果均不得分配 Attempt 或启动 Harness。由 `v2s.restore` 负责的最终恢复事务 SHALL 一并提交 artifact 消耗、RecoveryQualification `qualified`、目标 Activation `active`、准确 epoch、source facts 和命令结果。每个提交前与提交后崩溃点 SHALL 恰有一个可观察的恢复结果。

M2 SHALL把以下subject-specific写入纳入相同原子边界：Gateway delivery-request identity/result加safe pre-Effect auto-allow/deny outcome（deny零Effect行）；auto-allow时control-command Effect identity+verified update-ref digest/normalized target+bounded payload bytes/digest加source fact/effect projection；claim/dispatch/LocalDispatchResult/receipt/outcome/reconciliation；connector credential/mapping generation revoke；以及control-command PostFinalConflict加delivery unresolved/connector authority revoke。Run cancel批量finalize只枚举同Run的open run-action Effects，MUST NOT触及control-command deliveries。Control-command delivery事务不得写Run/Attempt/Activation projection或改变Agent terminal；run-action transaction不得缺少其run/action/release/epoch fence。

每个受 state、epoch 或 generation fence 保护的 CAS SHALL 要求一次新提交恰好影响一行。零行受影响 MUST NOT 被解释为成功或静默缺失：owner 状态表 SHALL 将其解析为已授权的存储命令重放，或唯一的 typed stale-generation、stale-epoch、terminal、conflict 或 invalid-state 结果。如果当前 facts 无法区分这些结果，操作将作为损坏/契约失败而失败，且不执行外部 action。此规则适用于 activation、admission、child release、claim/dispatch、handoff、restore initialization 和 final recovery；外部 authority CAS 的 no-match 结果遵循相同的 typed no-success 规则。

外部调用被刻意置于 SQLite 事务之外。一旦 `dispatch-started` 提交，在没有 authoritative receipt 的情况下发生崩溃或超时 SHALL 收敛到 `unknown` 和一项 reconciliation obligation；它 MUST NOT 恢复未使用的 claim 或自动再次调用。

#### Scenario: Gateway restart 不依赖 Telegram transport store

- **WHEN**control-command Effect已提交后所有server/client进程重启
- **THEN**Gateway从Control DB中的target/payload/ref/policy恢复claim/dispatch；transport store缺失不使Effect parked或改变identity

#### Scenario: Gateway delivery denial 事务崩溃

- **WHEN**pre-Effect policy denial command-result事务崩溃
- **THEN**恢复看不到request result，或看到完整stored denial；两者都无Effect/fact/dispatch，exact replay不受后续policy变化影响

#### Scenario: Control-command Effect 创建期间崩溃

- **WHEN**Gateway在提交control-command Effect identity、source fact和effect projection时崩溃
- **THEN**恢复观察不到三者，或观察到绑定同一interaction/delivery key的完整集合；external invocation只能发生在后续dispatch-started后

#### Scenario: Delivery PostFinalConflict 事务崩溃

- **WHEN**control-command final后矛盾证据触发安全事务并崩溃
- **THEN**恢复保持旧final且无conflict，或同时看到PostFinalConflict、delivery unresolved和connector generation revoke；无Agent Activation被误隔离

#### Scenario: 受 fence 保护的 CAS 影响零行

- **WHEN** 受 fence 保护的 mutation 因预期 state、epoch 或 generation 不再匹配而未更新任何行
- **THEN** 它返回 owner 定义的重放结果或 typed rejection，绝不返回成功，且不执行下游或外部 action

#### Scenario: 数据库标识引导期间崩溃

- **WHEN** 存储在创建新谱系和初始可写实例时崩溃
- **THEN** 恢复要么观察不到已初始化数据库，要么同时观察到两个标识和有效创世 fact

#### Scenario: Restore-init proposed target 预分配期间崩溃

- **WHEN** 存储在提交数据库级 pending command、RecoverySession/proposed target、agent-set digest 与预检时间 fact 的事务中崩溃
- **THEN** 恢复要么看不到该集合，要么看到绑定同一 command 的完整集合；同一命令重放绝不生成第二个 session/target

#### Scenario: 恢复目标初始化期间崩溃

- **WHEN** 存储在把 authority-bound session target 提升为数据库实例并为完整 agent set 开启恢复隔离时崩溃
- **THEN** 它要么只看到仍 pending 的 session/target，要么同时看到已完成命令、唯一目标、全部 generation-0 qualifications、被隔离 Activations 和生命周期 facts

#### Scenario: RecoveryAuthority 绑定另一 target

- **WHEN** session challenge 指向与 pending restore-init 行不同的 session、proposed target 或 agent-set digest
- **THEN** 初始化事务以 typed target-mismatch 拒绝，pending 行与两个 id 均不获得可写 authority

#### Scenario: Run 准入期间崩溃

- **WHEN** 在分配 Run 与追加其初始 fact 之间发生崩溃
- **THEN** 恢复要么观察不到准入集合的任何部分，要么同时观察到 Run、初始 event、已绑定主机证据、命令结果和投影

#### Scenario: 准入主机 generation 在提交前变化

- **WHEN** Run 准入事务观察到的主机 generation 在提交前被取代
- **THEN** 完整准入集合保持缺失

#### Scenario: RunAttempt 分配携带 checkpoint 输入时崩溃

- **WHEN** 存储在分配恢复某个 CheckpointRef 的 RunAttempt 时崩溃
- **THEN** 恢复要么观察不到消费/分配集合，要么同时观察到已消费 AttemptQuiesced、Attempt、准确 checkpoint 输入、命令结果和投影

#### Scenario: RunAttempt 分配与旧 session 迟到事件竞争

- **WHEN** 新 Attempt 分配 CAS 与旧 HarnessSession 的 action/event/EffectIntent/checkpoint/child registration 或 obligation-owner/outcome 变化并发
- **THEN** 恰有一个 generation/digest 视图获胜；分配失败时不消费 quiescence fact，分配成功时旧 Attempt 输入按 stale 拒绝

#### Scenario: Recovery discovery 准入期间崩溃

- **WHEN** 存储在追加 RecoveryDiscoveredOperation 及其 obligation projection 时崩溃
- **THEN** 恢复要么看不到两者，要么同时看到唯一的非授权 operation fact 和不可 dispatch obligation

#### Scenario: Action 注册响应丢失

- **WHEN** 幂等 action 注册已提交，但其响应丢失
- **THEN** 重放返回相同的 actionId/来源绑定，且无法创建另一个可产生 Effect 的 action 标识

#### Scenario: 受限 child 注册期间崩溃

- **WHEN** 持久化在遏制/root 标识注册与其启动 fact 之间失败
- **THEN** 两者均不提交，且 bootstrap gate 会在其 entrypoint 前终止/回收完整遏制单元

#### Scenario: Dispatch 开始后崩溃

- **WHEN** `dispatch-started` 已持久化，外部调用可能已提交，但没有持久 receipt
- **THEN** 恢复保留一个 Effect 标识，记录 `unknown` 和 reconciliation obligation，且不执行自动重新 dispatch

#### Scenario: 绑定 Effect 标识期间崩溃

- **WHEN** 在接收 intent 并分配 `effectId` 时发生崩溃
- **THEN** 恢复要么观察不到 Effect，要么观察到一个绑定来源的 Effect，绝不会观察到两个可 dispatch 的标识

#### Scenario: 最终结果后隔离期间崩溃

- **WHEN** Effect 或 RecoveryDiscoveredOperation 的最终 outcome 之后到达矛盾证据，且安全事务崩溃
- **THEN**恢复要么观察到先前final且无conflict，或完整subject-specific集合：run-action含Activation quarantine/mutation revoke，control-command只含delivery unresolved/connector-mapping revoke，Recovery operation按其独立qualification规则

### Requirement: 全局有序的仅追加源事实与 receipt 准入

**Requirement ID:** `v2s.source-facts` SHALL 为此 Requirement 的稳定标识。

M0 SHALL 固化一个带版本且封闭的 `SourceFact` 可辨识联合。其 kind SHALL 覆盖 release 发布；数据库/控制实例生命周期；TimeAuthority 观察/状态；Activation/epoch/隔离；带主机证据的 Run 准入；RunAttempt 分配/生命周期/健康/终态及 AttemptQuiesced；HarnessSession/action 注册/ActionEvent/checkpoint/ObligationOwnerTransferred/outcome proposal；绑定 `production-child` 证明的进程遏制生命周期；Approval；Effect intent/policy/claim/dispatch；LocalDispatchResult；ExternalReceipt；receipt conflict 和 `PostFinalConflict`；reconciliation claim/observation/final outcome；LaunchAttestation generation/失效；命令结果支持；mutation authority 撤销/registration closure/TargetAuthorityClosed proof admission；以及 RecoverySession/SessionInitCertificate evidence digest/qualification、RecoveryDiscoveredOperation、recovery-only reconciliation/final outcome/RecoveryPostFinalConflict/RecoveryAgentBindingConflict、RecoveryBindingInvalidated 与 BindingCertificate/ActivationPermit evidence digest。原始 ActivationPermit 不是 SourceFact，也不得持久化。每个 kind SHALL 具有一个 schema/version 和稳定的 fact-kind id，并且每个状态表、事务、投影和 oracle SHALL 使用同一联合。未知 kind/version 或该联合中缺失的规范性持久 event 会导致完备性检查失败。

M2 Effect/Approval/claim/dispatch/LocalDispatchResult/receipt/outcome/reconciliation/PostFinalConflict fact SHALL携带subject_kind。Run-action payload绑定run/action/attempt/release/epoch；control-command payload绑定controlInteractionIdentity、verified update-ref digest+normalized control metadata/derived target、delivery key/generation、bounded canonical payload bytes+digest、AuthorityContext/delegation/mapping与connector profile/policy/credential generation，且不伪造run/action/release/epoch。两种subject的schema version分别封闭但共享fact kinds/lifecycle consumer。

每个已提交 SourceFact SHALL 在同一事务中获得不可变的数据库范围 `factSeq = previous committed factSeq + 1`；回滚不消耗序号。`factHash` SHALL 是以下内容的 SHA-256：`v2c.release-identity` 对 `[source-fact-v1, databaseIdentity, factSeq, previousFactHash, factKindId, schemaVersion, payload]` 生成的规范字节；创世 `previousFactHash` SHALL 为固定的全零值。M0 和 M1 SHALL NOT 截断或归档 SourceFact 前缀；重建从固定创世事实开始，任何缺失的前缀都会关闭失败。未来的归档协议需要单独变更，并拥有自身的 authority 和验证契约。RunEvent SHALL 另外具有每个 Run 内无间隙的 `runSeq`。重建 SHALL 从创世事实开始验证连续性/hash chain，并按 `factSeq` 升序重放；任何 wall-clock 或 arrival-order tie breaker 都不具 authority。

每个`dispatch-started`fact SHALL绑定不可变database/control instance、Effect/id/generation、subject_kind、sink、恰好一个operation、connector、external request id、discovery key与最新未过期effect-dispatch attestation。Run-action另绑定release/epoch/run/action；control-command另绑定interaction/delegation/mapping/connector profile/policy/credential generation。connector ExternalReceipt SHALL 绑定 connector-authority id/version/generation、authentication-evidence digest 和 sink discovery-proof reference，并且仅当当前 authenticated provenance 与所有 dispatch binding 均匹配、且其 status 属于 `v2c.effect` 时才 SHALL 被接收。每个 dispatch generation SHALL 至多绑定一个 authoritative receipt。完全相同的重复项具有幂等性。在最终 outcome 之前出现不同的 authenticated receipt 时，将追加 conflict evidence，并把 ExternalOutcome 设为 `conflicted`、reconciliation 设为 `unresolved`，而不替换第一份证据。

每个 reconciliation claim、observation、final outcome 和 conflict-resolution fact 同样 SHALL 绑定 producer/authority id、version、generation、authentication-evidence digest 以及适用的 discovery/conflict-proof reference；恢复和 conflict 验证 SHALL 使用这些字段，而不是从当前配置推断 authority。最终outcome之后的authenticated矛盾证据 SHALL使用`v2c.effect`subject-specific post-final transition：两者都追加PostFinalConflict并重开conflicted/unresolved；run-action隔离所属Activation并撤销mutation authority，control-command只撤销connector credential/mapping generation且不改变Agent Activation。LocalDispatchResult 是不同的联合分支，且只能存在于外部调用之前。reconciliation fact MAY 最终化 unknown dispatch，或仅通过声明的 conflict-resolution method 最终化 conflicted dispatch，而不伪造或替换 ExternalReceipt。

当 `v2s.restore` 的 authenticated sink enumeration 发现一个本地没有匹配 `dispatch-started` 的快照后操作时，存储 SHALL 先追加 `RecoveryDiscoveredOperation`，再允许该成员进入 recovery-only reconciliation。Sink manifest SHALL 声明在 `(databaseIdentity, actualControlInstanceId, sink)` 范围内稳定且唯一的 discovery key；缺少该保证的 sink 不具备生产恢复资格。`recoveryOperationId` SHALL 从 `['recovery-operation-v1', databaseIdentity, actualControlInstanceId, sink, discoveryKey]` 的规范 digest 推导，MUST NOT 包含可能发生冲突的 operation、external request id、outcome、evidence 或 recovery-attempt id。Operation、external request identity（存在时）及其他发现成员形成独立的 canonical `memberDigest`。每次发现还 SHALL 绑定当前 recovery attempt、该 attempt 的 `agentId`、由 issuing MutationAuthority/connector 认证的 `ownerAgentId` 与 agent-binding proof、RecoveryAuthority operation-membership registry sequence/proof，以及 connector/sink authority id/version/generation、authentication-evidence digest、discovery proof 和 fence watermark。M0/M1 production recovery 要求 ownerAgentId 唯一且等于 attempt agentId；缺失、含糊或不匹配归属会阻止该 qualification，且不创建该 attempt membership。通过相等性验证的首次发现才可原子创建全局 operation 记录、不可变 ownerAgentId 和当前 Agent attempt membership；后续 membership 必须绑定相同 Agent。相同 id/memberDigest/ownerAgentId 返回既有记录；相同 id 的不同 memberDigest 在同一 lifecycle 上进入 conflict。若 authenticated evidence 把同一 id 绑定到另一 Agent，存储 SHALL 追加 `RecoveryAgentBindingConflict`，将 operation 设为 `conflicted + unresolved`，并把所有历史/当前 consumer Agent 交给 `v2s.restore` 的安全失效转换；绝不能创建第二个 id、跨 Agent 复用 final outcome 或让任一 consumer qualification 继续。

每个 RecoveryDiscoveredOperation SHALL 使用封闭 `ExternalOutcome = unknown | committed | not-committed | conflicted` 和 recovery-only reconciliation lifecycle `pending | claimed | resolved-committed | resolved-not-committed | unresolved`。创建时为 `unknown + pending`。Claim、observation、finalization 和 conflict resolution 均使用当前 recovery owner generation 的单行 CAS，并绑定 producer/authority/proof；零行不是成功。完全相同的 fact replay 返回既有结果且不追加事实。Final 前的矛盾 authenticated evidence 将 outcome/lifecycle 原子转为 `conflicted + unresolved`；只有 sink manifest 声明的 conflict-resolution method 绑定完整不可变 evidence set 后，才能转为恰好一个 resolved final。Final 后的矛盾证据 SHALL 原子追加 `RecoveryPostFinalConflict`，保留先前证据并重新打开 operation 为 `conflicted + unresolved`。本 Requirement 只拥有 operation/fact admission 与幂等/conflict CAS；它 MUST NOT 定义 RecoveryQualification 的 next state。所有受影响 consumer Agent 的 Qualification/Activation/binding 转换由 `v2s.restore` 唯一拥有并在同一安全事务中引用这些 conflict facts。任何 unknown/pending/claimed/conflicted/unresolved operation 都不能作为 qualification-ready 证据。

该 lifecycle 在所有 state 下都只创建不可 dispatch 的恢复 obligation：它 MUST NOT 创建 EffectIntent/Effect/dispatch claim、授予 grant、伪造 ExternalReceipt 或允许 redispatch。后续 recovery-only observation/final outcome SHALL 绑定同一 recoveryOperationId 和 authority proof；只有存在匹配的本地 `dispatch-started` 时，普通 ExternalReceipt admission 才适用。

终态Run SHALL拒绝新的RunAttempt、ActionEvent、run-action EffectIntent和dispatch；独立control-command delivery不属于该Run，但仍受自身interaction/connector fences。针对终态前 dispatch 的有效迟到 receipt/reconciliation fact MAY 在终态后追加并触发安全 transition，但 MUST NOT 改变 Run 终态摘要或调度工作。

#### Scenario: Raw Telegram update 进入 Control fact

- **WHEN**control-command Effect/fact尝试持久raw update bytes/text而非verified ref digest与normalized metadata
- **THEN**durable-data/schema拒绝整笔事务；raw bytes只可存在于物理独立channel-private transport store

#### Scenario: Control-command fact 伪造 Run binding

- **WHEN**control-command Effect fact携带run/action/release/epoch或试图改变Agent terminal projection
- **THEN**SourceFact schema/consumer拒绝它且不发布部分effect/delivery view

#### Scenario: Delivery conflict 隔离错误 Agent

- **WHEN**control-command PostFinalConflict到达
- **THEN**fact只重开delivery并撤销connector generation，不产生Activation quarantine或Run terminal变化

#### Scenario: Receipt 或 reconciliation 缺少 authority 证据

- **WHEN** producer 省略其 authority generation/evidence digest/proof reference，或指向过期 generation
- **THEN** SourceFact 准入拒绝它，并保留先前的 Effect/reconciliation 状态

#### Scenario: Receipt 先于 dispatch

- **WHEN** connector 为 issued/revoked claim 提交 receipt，却没有匹配的持久 `dispatch-started`
- **THEN** 存储拒绝它，且不追加 external-result fact

#### Scenario: 相同 receipt 被重放

- **WHEN** authenticated connector 完全重复 authoritative receipt
- **THEN** 存储返回其现有标识，不产生第二个 source fact

#### Scenario: 冲突 receipt 出现在最终 outcome 之后

- **WHEN** authenticated connector 在同一 dispatch generation 成为 final 后提交矛盾证据
- **THEN**存储原子追加`PostFinalConflict`并重开reconciliation；run-action隔离其Activation并撤销mutation authority，control-command只撤销connector/mapping generation且不写Activation

#### Scenario: 迟到 receipt 到达终态 Run

- **WHEN** 匹配的终态前 `dispatch-started` 随后产生有效 receipt
- **THEN** 存储按全局 fact 顺序追加它，且不改变终态摘要或推导新工作

#### Scenario: 追加未知 fact kind

- **WHEN** writer 提交一个位于已固化 SourceFact 联合之外的持久 fact kind/version
- **THEN** 存储拒绝它，且完备性验证会识别缺失或无效的 owner

#### Scenario: Source-fact hash chain 断裂

- **WHEN** 某个 fact 被删除、插入或更改，却没有匹配下一个保留的 `previousFactHash`
- **THEN** 重建在发布投影前关闭失败

#### Scenario: Reconciliation 在没有 receipt 时证明未提交

- **WHEN** unknown dispatch 收到 authoritative final not-committed 证据，但没有 connector receipt
- **THEN** 存储追加 final reconciliation/ExternalOutcome fact，并使 ExternalReceipt 保持缺失

#### Scenario: 恢复发现本地不存在的快照后操作

- **WHEN** authenticated sink enumeration 返回一个目标数据库没有 `dispatch-started` 的谱系内操作
- **THEN** 存储按稳定 discovery key 幂等追加不可 dispatch 的 RecoveryDiscoveredOperation/attempt membership，并只允许其经 recovery-only reconciliation 收敛

#### Scenario: 同一 discovery key 携带不同成员

- **WHEN** 同一数据库谱系、实例和 sink 的 discovery key 被另一 operation、external request identity 或 member digest 复用
- **THEN** 唯一约束与单一 CAS 把现有 recovery operation 转为 conflicted/unresolved，不创建第二个 id，也不能作为 qualification-ready 证据或允许 redispatch

#### Scenario: 恢复发现被当作普通 receipt

- **WHEN** connector 尝试用 RecoveryDiscoveredOperation 绕过普通 receipt 的 `dispatch-started` 前置条件或创建可 dispatch Effect
- **THEN** 存储拒绝该路径，恢复 obligation 与所有外部证据保持可审计且非授权性

#### Scenario: Recovery operation final 前出现矛盾证据

- **WHEN** 同一 recoveryOperationId 在 final 前收到两个经过认证但结论不同的 observation
- **THEN** 单一 CAS 将其转为 `conflicted + unresolved`，保留全部证据，使其不能作为 qualification-ready 证据，也不允许任何 redispatch

#### Scenario: Recovery operation final 后出现矛盾证据

- **WHEN** 已 resolved 的 RecoveryDiscoveredOperation 收到经过认证的矛盾证据
- **THEN** SourceFact admission 原子追加 RecoveryPostFinalConflict、保留旧 final 并重新打开 operation；Qualification/Activation 转换只由 `v2s.restore` 决定

#### Scenario: Recovery operation 跨 Agent 归属冲突

- **WHEN** 同一 recoveryOperationId 收到经过认证但不同的 ownerAgentId，或另一 Agent attempt 试图复用其 final outcome
- **THEN** 存储追加 RecoveryAgentBindingConflict、保留全部归属证据并拒绝跨 Agent membership/final 复用；所有 consumer 转换委托 `v2s.restore`

#### Scenario: Recovery operation 事实完全重放

- **WHEN** producer 重放同一 operation 的完全相同 claim、observation 或 final fact
- **THEN** 存储返回既有结果，不追加第二个 source fact，也不改变 owner generation

### Requirement: 确定性投影重建

**Requirement ID:** `v2s.projection-rebuild` SHALL 为此 Requirement 的稳定标识。

契约 SHALL 标识 source-fact 表和可丢弃投影、按 `factSeq` 升序重放的顺序、SourceFact schema/version 检查、hash-chain/归档边界验证以及不匹配时的行为。重建 MUST 生成等价的 Run/RunAttempt、带父链接的 action graph、checkpoint 元数据、obligation owner successor chain、health、Effect、RecoverySession/qualification/binding 与 recovery-operation 投影，并在遇到未知 fact kind/version、断裂的 hash chain、重复/乱序或有间隙的已提交 `factSeq`、缺失的每 Run `runSeq`、悬空的 action parent/checkpoint producer、owner-chain gap/branch/cycle/subject mutation，或冲突的run-action首次来源/control-command interaction绑定时关闭失败。Receipt/reconciliation facts仅更新Effect/recovery投影且不得重写Run终态或调度Harness。M2 effect projection SHALL按subject_kind重建run-action view或sanitized control-command delivery view；delivery view只暴露effectId、interaction/delivery identity digest、operation、state/outcome与safe error，不暴露Bot token、payload、delegation或connector proof。Control-command replay/PostFinalConflict不得创建Run/action/Activation projection。

#### Scenario: 重建混合 Effect subjects

- **WHEN**facts包含run-action与control-command Effects及delivery PostFinalConflict
- **THEN**重建产生各自等价effect/delivery views，Run terminal保持不变，未知subject field组合fail closed

#### Scenario: 重放未知 fact version

- **WHEN** 重建遇到不受支持的 source-fact version
- **THEN** 它以 typed incompatibility 停止，且不发布部分投影

#### Scenario: Arrival timestamp 被重新排序

- **WHEN** source facts 具有相同或误导性的 wall-clock timestamp
- **THEN** 重建仍具确定性，因为只有已提交的 `factSeq` 建立顺序

### Requirement: 受 epoch fence 保护的生产切换与 reconciliation 所有权

**Requirement ID:** `v2s.handoff` SHALL 为此 Requirement 的稳定标识。

Admission与run-action claim/dispatch SHALL在提交事务比较预期activation epoch。Control-command claim/dispatch没有Activation epoch，MUST改为比较current AuthorityContext/delegation、UpdateInteractionRef mapping、connector profile/policy/credential generation与connector host attestation；不得伪造epoch字段。在 M0/M1 下，scheduler mutation 不受支持且 MUST NOT 存在。未来支持 schedule 的 profile SHALL 通过 `v2c.activation` 要求的 M3 前变更添加其 scheduler CAS/barrier。生产切换 SHALL关闭旧admission barrier，以epoch撤销每个未开始的run-action claim并阻止其过期dispatch CAS。Control-command connector rotation独立撤销其dispatch credential/mapping generation并阻止旧delivery dispatch，不参与Agent activation handoff。M2不实现control-command reconciliation owner handoff：任何已dispatch unknown/conflicted delivery的原connector reconciliation authority generation必须以read-only/no-dispatch角色保留至final；无法保留时delivery保持unresolved、connector disabled且M2 qualification失败。在转移 reconciliation 所有权之前，它 SHALL 等待每个旧 `dispatch-started` 获得 final ExternalOutcome 或持久 `unknown`。

当 Activation 保持 `draining` 或 `quarantined` 时，Run-bound reconciliation 所有权 MAY 通过 CAS 转移到候选 epoch。每次转移 SHALL 在同一事务追加带 `runId` 的 `ObligationOwnerTransferred`，保持 obligation kind/subject id/subject generation 不变，绑定准确 from/to owner kind/generation、transfer authority 和 epoch；CAS 只允许当前 owner generation 生成一个 successor，零行、gap、branch、cycle 或 subject 变化均关闭失败。该 immutable successor chain 是 `v2c.harness-session` checkpoint resume 的唯一 owner-handoff 证据。RecoveryDiscoveredOperation 不属于 Run checkpoint，并继续使用 `v2s.source-facts` 的 recovery-attempt/operation owner CAS。提升为 `active` SHALL 继续受阻，直至每个 dispatch-started ExternalOutcome 均为 final `committed` 或 `not-committed`，且其 reconciliation lifecycle 为 `resolved-committed` 或 `resolved-not-committed`；`unknown`、`pending`、`claimed` 和 `unresolved` 均阻止提升。根据 `v2c.effect` 的权责划分，final not-committed outcome MAY 由 authenticated reconciliation 在没有 receipt 时确立。转移 reconciliation 所有权 MUST NOT 创建新的 EffectIntent 或授予 dispatch authority。

#### Scenario: Control-command unknown 遇到 connector generation 轮换

- **WHEN**delivery已dispatch并unknown/unresolved后connector generation轮换
- **THEN**旧generation只保留reconciliation/final权限且不能dispatch，直至delivery final；M2不创建runId/epoch ObligationOwnerTransferred或新dispatch owner

#### Scenario: 旧 reconciliation authority 无法保留

- **WHEN**security revocation使旧control-command reconciliation authority无法继续验证final outcome
- **THEN**delivery保持unresolved、Telegram connector disabled且M2 fail closed，不把obligation转给新generation或猜测outcome

#### Scenario: Control-command claim 遇到 connector generation 轮换

- **WHEN**delivery claim有效但connector credential/mapping generation在dispatch CAS前被取代
- **THEN**dispatch零行失败并以claim-revoked local result收口；不读取或比较任何Agent Activation epoch

#### Scenario: 旧 scheduler 在切换后唤醒

- **WHEN** 存在更高的受 fence 保护 epoch 后，旧 scheduler 提交准入
- **THEN** 其事务不创建 Run

#### Scenario: 切换遇到未开始的 claim

- **WHEN** claim 存在，但 `dispatch-started` 从未提交
- **THEN** 切换可按 epoch 撤销它，且每个过期 dispatch CAS 均失败

#### Scenario: 切换遇到 unknown Effect

- **WHEN** dispatch 已持久化为 `unknown`
- **THEN** reconciliation 所有权可在 CAS 下转移并追加唯一 successor fact，同时生产提升仍受阻

#### Scenario: Obligation owner handoff 发生分支

- **WHEN** 两个候选 owner 尝试从同一 from-owner generation 接管同一 obligation
- **THEN** 至多一个 ObligationOwnerTransferred fact 提交，另一个收到 typed stale-generation rejection

#### Scenario: Reconciliation 解析为未提交

- **WHEN** 所有承接的 obligation 均达到 resolved 状态
- **THEN** 提升可继续，但任何后续重试都需要根据控制契约创建新的 EffectIntent

## ADDED Requirements

### Requirement: M2 control-command delivery restore fail-closed

**Requirement ID:** `v2s.control-delivery-restore` SHALL 为此 Requirement 的稳定标识。

M2不授予Telegram connector production/restore资格。Backup含control-command Effect时，restore preflight SHALL独立枚举其subject rows/facts。若任一delivery为pending、claimed、dispatch-started、unknown、conflicted或unresolved，整个M2 target restore以typed `unsupported_control_delivery_restore`失败并保持全部Agent/connector quarantined；不得伪造ownerAgentId、RecoveryDiscoveredOperation membership、result或redispatch。

只有全部control-command Effects已有互斥final local result或final committed/not-committed outcome，且target Telegram connector保持disabled时，既有M1 Agent restore MAY按主`v2s.restore`继续；这些final delivery facts只重建audit projection，不启用connector。M2任何restore都不发现snapshot后Telegram external operations；需要control-connector recovery/enablement必须另开具名change。

#### Scenario: Backup 含 unresolved control-command delivery

- **WHEN**restore preflight发现任一non-final control-command Effect
- **THEN**target返回`unsupported_control_delivery_restore`、不初始化可写target/Agent qualification，也不创建假的Agent recovery membership

#### Scenario: Backup 只含 final control-command deliveries

- **WHEN**所有control-command Effects均final且Agent恢复其余条件满足
- **THEN**Agent restore可继续但Telegram connector保持disabled；delivery只重建safe audit projection，不获得claim/dispatch authority

#### Scenario: Snapshot 后存在未发现 Telegram send

- **WHEN**sink可能在backup后发生delivery而M2没有control-connector discovery/reconciliation资格
- **THEN**M2拒绝启用target connector并要求后续change，不把操作归属伪装成ownerAgentId或猜测outcome
