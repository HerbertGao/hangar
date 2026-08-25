# v2-storage-contract Specification

## Purpose

定义 Hangar v2 独立 SQLite 的事实链、事务、投影、切换与恢复契约，确保命令幂等、崩溃原子性、未知外部结果和恢复 fencing 可验证。

## Requirements

### Requirement: 独立的 v2 SQLite schema

**Requirement ID:** `v2s.sqlite` SHALL 为此 Requirement 的稳定标识。

存储契约 SHALL 定义一个独立的 v2 SQLite 数据库，其中包含逻辑实体 AgentRelease、Activation、Run、RunAttempt、RunEvent/SourceFact、Approval 和 Effect。它 MAY 为命令结果、ActionEvent、CheckpointRef、健康状态、进程遏制、启动证明和恢复元数据添加关系型支持记录/投影，但这些记录 MUST NOT 拥有 Harness 进度或创建第二个控制状态机。该 schema MUST NOT 依赖或修改 v0 四表数据库，并且 v2 Run 标识 MUST NOT 与 v0 Run 标识互为别名。

此 Requirement 仅负责存储实例标识。受信任的新数据库引导过程 SHALL 生成抗冲突的不透明 `databaseIdentity` 和初始 `controlInstanceId` 值，并将二者与创世 SourceFact 原子持久化。`databaseIdentity` 标识不可变事实链的谱系，参与每个事实 hash，并在备份/恢复过程中保持不变。`controlInstanceId` 标识整个 v2 数据库的一个可写化身，恢复的副本或克隆 MUST NOT 复用它。仅当 `v2s.restore` 所负责的外部注册表签发一份排他续用证明，绑定数据库/实例、当前 boot/启动周期、当前周期时间证据以及最新的 `production-control` 主机 generation 时，干净重启 MAY 复用它。在进行任何其他写入之前，一个事务 SHALL 验证该证明为当前有效且仅可使用一次，追加 `control-instance-resumed`，并持久化续用结果。完全相同的重放具有幂等性；证明缺失、过期、冲突或已绑定到另一启动过程时，将强制进入禁用写入的恢复模式。恢复 SHALL 保留历史源实例 id，并使用一个数据库级 `RecoverySession`，而不是为每个 Agent 创建 control instance。普通 `restore-init` 的首个 pending-coordination 事务 SHALL 绑定备份中完整 `agentSetDigest`，生成并保留一个全局唯一、抗冲突且永不复用的 `proposedTargetControlInstanceId`，并据此推导稳定 `recoverySessionId`；这些值此时只是不可变协调 metadata，不是可写 control instance，也不产生 control-instance aggregate fact。RecoveryAuthority 只能绑定该 session/proposed target。后续恢复初始化事务 SHALL 验证准确 authority binding，并原子把同一值持久化为该数据库唯一目标实例、创建 RecoverySession/control-instance SourceFact，并为 agent set 中每个 Agent 创建绑定同一 session/target 的 generation-0 `RecoveryQualification` 与被隔离 Activation。每个 Agent 后续独立 qualification/activation，但 MUST NOT 创建另一 targetControlInstanceId。所有 proposed/active/historical control-instance id 共享唯一域；失败或中止的 proposed id 永不复用。只读打开/验证 MUST NOT 生成任一 id 或任何 sidecar。

#### Scenario: M0 验证在 v0 数据库旁运行

- **WHEN** 存在 v0 数据库时执行存储验证
- **THEN** 该文件、sidecar、schema 和内容均保持不变

#### Scenario: 复制的数据库复用可写实例标识

- **WHEN** 复制的数据库无法证明其记录的 `controlInstanceId` 获得了排他续用权
- **THEN** 常规可写打开失败，并保持只读，或使用新的目标实例 id 进入隔离恢复

#### Scenario: 干净重启在续用提交前崩溃

- **WHEN** 已授予排他续用权，但存储在续用事务提交前崩溃
- **THEN** 不启用任何常规写入，且仅同一启动过程/证明可进行幂等重试

#### Scenario: 干净重启证明指向另一启动过程

- **WHEN** 续用证据指向另一 boot、启动周期、实例、主机 generation 或时间 generation
- **THEN** 续用操作不提交任何事实，且可写打开仍被禁用

#### Scenario: 恢复创建新的可写化身

- **WHEN** 有效备份进入恢复流程
- **THEN** 其 `databaseIdentity` 和历史事实 hash 保持不变，同时在资格认定前生成不同的目标 `controlInstanceId`

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

### Requirement: 持久命令结果存储

**Requirement ID:** `v2s.command-results` SHALL 为此 Requirement 的稳定标识。

对于 `v2c.command-idempotency` 下符合条件的每个命令，存储 SHALL 持久化稳定的 actor subject id、首次授权的 AuthorityContext 证据 digest、命令种类、目标 aggregate id、幂等键、所选 `commandDigestTuple` 的每个成员、规范 payload digest、规范 release/epoch 前置条件 digest，并且对于协调恢复命令，还要持久化预检时间证据 id/digest/generation。Digest SHALL 严格使用所存 tuple 及其共享的 `v2c.release-identity` 规范字节。Tuple `(actorSubjectId, commandKind, targetAggregateId, idempotencyKey)` SHALL 唯一；认证 session 和 delegation 刷新 MUST NOT 创建第二个 key。

命令记录状态 SHALL 封闭为 `pending-coordination` 和 `completed`。仅 manifest 声明的恢复命令 MAY 首先提交 `pending-coordination`，在其外部 authority CAS 之前原子绑定当前预检时间证据及安全 pending 状态，但不包含最终结果或 aggregate fact。数据库级 `restore-init` pending 行 SHALL 另外绑定 `v2s.sqlite` 预分配的 recoverySession/proposed-target id、backup digest 与完整 agent-set digest；这些字段是 immutable coordination metadata，不是客户端结果、authority 或 control-instance fact，完全相同命令重放必须返回同一内部值，其他命令不得复用它。最终 SQLite 事务 SHALL 将同一行更新为 `completed`，持久化其原始安全结果，并一并提交所有 aggregate SourceFact/投影。若一个外部协调 CAS 取代了同 aggregate 上另一条 pending coordination command，winner 的本地终态事务 SHALL 同时把 loser 行完成为 owner 定义的 typed `invalid_state | recovery_aborted | recovery_evidence_conflict`；任何被取代行都不得无限保持 pending。普通命令 SHALL 直接提交为 `completed`；不产生 aggregate fact 的持久拒绝也 SHALL 在响应前完成。恢复 MUST 将以下情况视为损坏：目标 aggregate mutation fact 缺少其必需的 completed 命令行、completed success 行缺少其 facts，或外部协调缺少匹配的 pending 行。pending 行所允许的唯一 command-bound SourceFact 是其预检 TimeAuthority 支持 fact，且该 fact MUST NOT 修改目标 aggregate。恢复 MUST NOT 创建第二个命令标识或重新运行已完成的 mutation。

在披露存储结果或 `idempotency_conflict` 之前，SHALL 先进行查找和当前读取授权；拒绝访问时既不泄露先前标识，也不泄露 digest。记录 SHALL 保留至数据库归档。存储结果 MUST 遵守 `v2c.durable-data` 并排除可复用 grant。

#### Scenario: Aggregate 状态变化后发生重放

- **WHEN** 已存储的命令在后续 aggregate transition 之后重复执行
- **THEN** 当前披露授权对原始安全结果实施 gate，但不会重新执行 mutation

#### Scenario: 冲突的 key 复用发生竞态

- **WHEN** 两个事务使用相同命令标识，但 payload 或 release/epoch 前置条件 digest 不同
- **THEN** 至多一个结果提交，另一个确定性返回 `idempotency_conflict`

#### Scenario: 重放跨越命令规范化器变更

- **WHEN** 已存储的命令在当前命令 tuple 变化后被重放
- **THEN** 查找使用该行存储的 tuple 比较 digest，绝不会按当前 tuple 静默解释它

#### Scenario: 协调命令在外部 CAS 前崩溃

- **WHEN** 恢复命令的 pending 行已提交，但其 authority CAS 未提交
- **THEN** 同一行及其不可变 RecoverySession/proposed target/agent-set digest 保持 pending，以供受信任的协调重试，且客户端重放仅显示不含 session/target id 的安全 pending 状态

#### Scenario: 外部 CAS 缺少 pending 命令行

- **WHEN** 恢复证据指向一个没有匹配 pending 行的命令标识/digest
- **THEN** 最终化将其作为损坏拒绝，既不创建命令行，也不创建 aggregate fact

#### Scenario: 崩溃拆分命令结果与 mutation

- **WHEN** 成功命令在完成其结果和 aggregate facts 时发生崩溃
- **THEN** 恢复只能观察到先前的 pending/缺失状态，或完整的结果/fact/投影集合；任何部分集合都会关闭失败，且不重新执行

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

### Requirement: 绑定快照的备份与受 authority fence 保护的恢复

**Requirement ID:** `v2s.restore` SHALL 为此 Requirement 的稳定标识。

备份 SHALL 使用 SQLite 一致性机制，而不是复制实时主文件。在一个冻结边界上，它 SHALL 生成不可变元数据，绑定 `databaseIdentity`、捕获的 `sourceControlInstanceId`、从保留的 SourceFact 推导出的完整谱系控制实例集合、schema/规范化版本、最大 `factSeq` 及 source-fact chain head、每个 Run 的最高 `runSeq`、terminal/Effect 标识、每个引用的 ExecutionClosure digest、完整 Agent/Activation set 及其 digest、每个谱系实例的 MutationAuthority 注册表 watermark、每个 gateway sink/谱系实例的 discovery watermark、备份文件 digest，以及快照前观察到的最新 RecoveryAuthority epoch。备份加元数据仅证明内部完整性。在资格认定开始前，根据 `v2c.direct-effect`，非空 direct-exception list 不符合 M0/M1 生产恢复条件。

每次数据库恢复 SHALL 首先原子提交普通 `restore-init` 命令的 pending 行、`v2c.time` 预检 fact、完整 agent-set digest，以及 `v2s.sqlite` 的 `recoverySessionId + proposedTargetControlInstanceId`，并以 `(databaseIdentity, sourceControlInstanceId, backupDigest)` 为命令目标；然后 RecoveryAuthority 才能登记该准确 command/session/target/agent-set digest 与数据库级 session challenge。受信任 executor 必须取得下述 `SessionInitCertificate` 后，初始化事务 SHALL 保留备份的 `databaseIdentity` 和历史 `sourceControlInstanceId`，验证 certificate 准确绑定同一 proposed target，将其提升为该数据库唯一且不同的 `targetControlInstanceId`，完成同一命令行，创建 RecoverySession/control-instance fact，并为冻结 agent set 中每个 Agent 创建 `(recoverySessionId, agentId, qualificationGeneration=0)` RecoveryQualification 及目标 `quarantined` Activation。恢复初始化遗漏/新增 Agent、为任一 Agent 生成另一 target，或同一数据库并发提交第二个 session target 时，整个事务失败。RecoverySession lifecycle SHALL 封闭为 `pending-target | initialized | retired`；pending metadata 不授予写 authority，初始化事务才追加 session/control-instance facts，`retired` 为不可重开的终态。Session state 不替代 per-Agent Qualification，也不因单个 Agent active/invalidated 而创建新的 target。

每个 Agent 的 qualification、denominator、artifact、epoch、abort 和 recover-activate 独立，但都绑定同一 RecoverySession/target；一个 Agent 的失败不能为另一个 Agent 创建 control instance 或 authority。在某个 qualification 未达到 `qualified` 时，该 Agent 的每个 production activation/admission/dispatch——包括替代 Activation——SHALL 拒绝；仅允许 recovery reconciliation。RecoveryQualification SHALL 遵循 `quarantined → fencing → enumerating → reconciling → ready`，并具有 `invalidating` safety state 以及 `aborted` 与 `invalidated` 终态；`qualified` 对普通 lifecycle 为 final，但只允许 RecoveryPostFinalConflict safety transition 进入 `invalidated`。`ready` 不授予 admission、dispatch 或可复用 activation authority。`qualified` MAY 仅在把准确 Agent Activation 从 `quarantined` 转为 `active` 的同一最终 SQLite 事务中提交。`qualified → invalidated` SHALL 与该 Agent 的 Activation quarantine/mutation-authority revocation 原子提交。`aborted`、`invalidating` 或 `invalidated` 不授予任何权限；旧 target 上 `aborted` 或 `invalidated` 的 Agent 永远不能再次 active。

本 Requirement 独自拥有 RecoveryPostFinalConflict/RecoveryAgentBindingConflict 对 consumer Qualifications 的转换。对每个受影响 Agent SHALL 穷尽：未绑定 certificate 的 `ready → reconciling`；已有 bound certificate 且本地 activation 未提交的 `ready → invalidating` 并执行 binding-invalidation；`reconciling | invalidating` 保持；`quarantined | fencing | enumerating` 保持各自非授权状态且在 conflict 解决前不得前进；`qualified → invalidated`；`aborted | invalidated` 保持终态。任何 Qualification 使用 recovery operation final 前，RecoveryAuthority SHALL 在恢复数据库外的 operation-membership registry 中登记 `(recoveryOperationId, ownerAgentId, recoverySessionId, targetControlInstanceId, qualificationGeneration)` 并把 sequence/proof 绑定进本地 fact/artifact。Agent-binding conflict 的外部 CAS SHALL 将该 operation 转为全局 `conflicted`、冻结由全部历史/当前 registry memberships 与归属证据 Agent 合并出的 consumer set，并在任何本地收敛前撤销每个 consumer 的 activation/mutation authority。对于同一 target 的 consumers，一个 SQLite 事务全有或全无地转换 Qualification/Activation；跨 target/session 时，外部 conflict generation 是线性化 fence，各 target 必须提交本地 invalidation/ack，或由 RecoveryAuthority 提供下述不可逆 `TargetAuthorityClosed` proof。在每个 target 获得其一前，所有 consumer 的 promotion/permit/dispatch 都保持拒绝。不能只失效报告冲突的 Agent；后续 conflict resolution 不自动重新激活任何 consumer。

`TargetAuthorityClosed` 只能由独立外部 CAS 针对准确 `(databaseIdentity, targetControlInstanceId)` 签发，并 SHALL 永久关闭该 target 的 authority registration/clean-restart continuation，撤销/fence 全部 admission、gateway、connector、runtime/control-submission/restricted-child authority 与 host attestation generation，并使用当前 TimeAuthority 证据等待所有已签发 authority/grant 的最大 expiry 边界。Proof SHALL 绑定 closure watermarks、被撤销 member set/attestation digest、时间证据和所有已知 dispatch/discovery obligations；它不声称本地 DB state，也不解析外部 outcome。签发后该 target 及其全部 Agent 永远不能 production-active，即使文件重新出现。经过认证且完整的该 proof MAY 替代失联 target 的本地 invalidation ack；缺 member、未知 expiry、未关闭 registration/continuation 或未纳入 discoverable obligation 时不得替代。后续 RecoverySession/artifact 必须绑定该 proof，并继续 reconcile 其 obligations。

独立于恢复数据库、备份和 child runtime 的 RecoveryAuthority SHALL 具有固定的 authority id/version/verifier 和外部持久状态。它 SHALL 先为数据库级 RecoverySession 记录准确的 restore-init command/digest、backup/agent-set digest、数据库谱系、源实例、proposed target 和 session challenge。外部 session state SHALL 封闭为 `pending | initializing-awaiting-local | initialized | retiring-awaiting-local | retired`。受信任 executor 的 init 与已授权 session-abort 必须比较同一 `pending` state/generation：init CAS 获胜时进入 `initializing-awaiting-local` 并签发精确 `SessionInitCertificate`；abort CAS 获胜时进入 `retiring-awaiting-local` 并撤销 challenge。两者至多一个线性化，loser 不得执行本地 mutation。

Init 获胜后的本地事务 SHALL 验证 certificate，原子初始化 session/target/all-Agent qualifications、完成原 restore-init command，并把已注册的竞争 abort command（存在时）完成为 typed `invalid_state`；RecoveryAuthority 验证本地 initialized fact 后进入 `initialized`。Abort 获胜后的本地事务 SHALL 将 session 标为 `retired`、使 proposed target 永不复用、完成 abort command，并把原 restore-init command 完成为 typed `recovery_aborted`；RecoveryAuthority 验证本地 retired fact 后进入 `retired`。任一外部 CAS 与本地事务之间崩溃时，只允许同一胜者幂等补完，所有被取代 command 都必须得到冻结结果，绝不能保持 pending 或再次调用 authority。同一 session 的完全重放返回既有 target/result，不同 target/session 不能初始化该文件。

在每次 Agent production activation 之前，RecoveryAuthority SHALL 原子预留一个高于其每个 `(databaseIdentity, agentId)` high-watermark 的单调递增 epoch，并绑定 recoverySession/qualification generation/target；已预留但未使用的 epoch 永不复用。

对于每个 `(recoverySessionId, agentId, qualificationGeneration)`，RecoveryAuthority SHALL 最多允许一个未完成本地协调的 Agent attempt，并签发独立 attempt id/challenge，绑定 session、target、Agent、qualification generation、release/Activation 和准确 command/evidence digest。Agent-attempt 状态 SHALL 封闭为 `pending`、`executing`、`aborted-awaiting-local`、`aborted`、`bound`、`binding-invalidated-awaiting-local`、`consumed` 和 `invalidated`；`aborted`、`consumed` 与 `invalidated` 为终态。即使已 `bound`，在匹配的 recover-activate 本地 success 或 binding-invalidated fact 被验证前，另一 Agent attempt 仍 SHALL 返回 `recovery_in_progress`。Agent abort CAS 与 recover-activate binding CAS SHALL 比较同一 Agent-attempt state/generation，至多一个获胜。仅在 binding 前提交了 pending 行的已授权 Agent `abort-recovery` 命令可以进入 `aborted-awaiting-local`。随后本地事务 SHALL 原子把 Qualification 设为 `aborted`、撤销 artifact/grant、完成 abort command，并把同一 Qualification 上已 pending 但未 bound 的 recover-activate command（存在时）完成为 typed `recovery_aborted`；匹配 SQLite `aborted` fact 后外部 attempt 才进入 `aborted`。如果外部 CAS 提交而 SQLite 未提交，只允许同一协调补完，任何被取代 command 均不得永久 pending。普通 rotation/revocation 在 binding 后不能重写决定；唯一安全例外是下述 authenticated denominator conflict 的 binding-invalidation CAS。未知 authority version、被重放/过期的 challenge、过期 epoch、无法验证的 signature，或因 authority rotation 而失效的未绑定 artifact 均会关闭失败。

对于干净重启而非恢复，同一外部服务 SHALL 针对 `(databaseIdentity, controlInstanceId)` 和一个准确 boot/启动周期，通过 CAS 最多签发一份未过期的排他续用证明。它 SHALL 绑定 authority generation、当前 time/host evidence 和先前 writable-incarnation status，并拒绝另一 live startup、clone 或 recovery claim。证明在 SQLite 外部仅可使用一次；如果其本地续用事务失败，只有相同启动过程可取回/重试该已记录证明，同时所有普通写入保持禁用。

在签发数据库级 session challenge 后、恢复初始化提交前，`v2c.time` SHALL 追加绑定该 session/challenge 的同一或更晚当前周期 evidence，初始化事务 SHALL 绑定它。每个 Agent attempt/challenge 签发后还 SHALL 在其 grant、fencing/enumeration transition、expiry decision 或 qualification step 前追加独立的当前周期 attempt evidence。任一阶段都不得使用恢复的 time state；证据缺失或被取代时，对应 session/qualification 保持 quarantine。

同一外部 authority 服务 SHALL 拥有单调递增的 MutationAuthority Registry。在任何 `admission-owner`、`gateway-claim`、`connector-authority`、`direct-mutation-authority`、`runtime-grant`、`control-submission-grant` 或 `restricted-child-authority` 可用之前，其 issuer MUST 注册稳定 id、封闭 type、generation、准确 `controlInstanceId`、release/epoch、issue evidence 和 revocation/probe method，并获得 registry sequence。备份元数据 SHALL 记录每个保留谱系实例观察到的最新 registry sequence。未注册 authority 在其 broker/launcher 边界无效；目标实例的生产 authority 在最终资格认定前保持不可用。Registry SHALL 还提供按 `(databaseIdentity, controlInstanceId)` 线性化的 registration-closure CAS：一旦为旧实例提交 closure sequence/generation，该实例永久拒绝任何新的或更高 generation 的 mutation-capable member；后续只允许为已枚举 member 追加 revoke/fence 证据。注册与 closure 并发时，注册要么先线性化并进入 closure denominator，要么在 closure 后被 typed 拒绝，不能落在两者之外。

在 RecoverySession 的首次 `fencing` 期间，RecoveryAuthority SHALL 为每个 lineage/authority-set 中的旧数据库实例只提交一次 registration-closure CAS，再冻结由所有 Agent qualification 共享、且包含各 closure sequence/generation 的 registry fence view，并推导 authority-instance set；目标 `targetControlInstanceId` 不作为旧实例关闭，但其生产注册仍按 Agent 保持禁用。该 set 包含在其备份 watermark 处或之后拥有任一 mutation-capable registry member 的每个谱系实例，以及每个仍开放的更早 member，无论是否存在本地 dispatch fact。它 SHALL 枚举并 fence 每个这样的 member，覆盖至对应 closure sequence。每个 Agent 资格认定 SHALL 引用同一 session fence proof，并要求其分母内每个已枚举 member 均处于静止状态，并依据新于 recovery attempt 的证据被 revoked/rotated/fenced；bind 与最终 activation SHALL 重新验证每个 registration-closure proof 仍匹配相同不可变 sequence/generation，且不存在未关闭的旧实例。registry gap、未知 type、denominator 中缺少 member，或缺少 revocation/probe/closure method，都会阻止资格认定。

在 `enumerating` 期间，每个 gateway sink SHALL 使用其 release 声明的完整 discovery method，枚举 authority-instance set 与拥有保留 dispatch 或 non-final/discoverable obligation 的实例之并集中的每个实例，范围从该 sink/instance backup watermark 到经过 sink/connector 认证的单调 fence watermark。不得仅因恢复的存储缺少 dispatch fact，或该实例早于捕获的源实例而排除它。RecoveryAuthority 绑定该证据到 attempt，但 MUST NOT 生成或自行证明 sink watermark。authoritative dispatch denominator 是这些外部结果与所有已恢复的/快照后的 dispatch-started facts 的准确集合并集。每个 member 绑定数据库谱系、sink、单一 operation、discovery key 和 control instance；每个没有匹配本地 `dispatch-started` 的外部 member MUST 在 denominator 冻结前按 `v2s.source-facts` 追加 RecoveryDiscoveredOperation，并以 recovery-only outcome 收敛，不能只把它藏在 artifact digest 中。任何缺少 authenticated finite completeness watermark 或 recovery method 的 sink，都会使该 release 不符合生产恢复条件。M0/M1 仍不允许 direct exception；允许它们的后续契约 MUST 扩展此 denominator，而不是静默复用 gateway set。

在 `reconciling` 期间，每个 denominator member SHALL 达到 final ExternalOutcome `committed` 或 `not-committed`，并具有匹配的 final reconciliation。仅当 receipt 是确立该 outcome 的证据时才需要 receipt；authoritative reconciliation 可在没有 receipt 时确立 not-committed。任何 `unknown`、`pending`、`claimed`、conflicting 或 `unresolved` member 都会阻止资格认定。

签名的 recovery artifact SHALL 绑定不可变的 `artifactId`、authority id/version/generation/rotation、recoverySession/Agent attempt/challenge、`agentId`、qualification generation、目标 `releaseId` 和 `activationId`、`databaseIdentity`、源和目标 control-instance id、agent-set digest、完整 lineage-instance-set 和 authority-instance-set digest、backup digest、source-fact/ExecutionClosure heads、来自 `v2c.time` 的新鲜当前周期 time-evidence id/digest/generation、目标 host-profile/ExecutionClosure digest、ready 阶段最新未过期的 `production-control` LaunchAttestation id/digest/generation、MutationAuthority backup/registration-closure/fence watermarks 和 denominator digest、每个 sink 的 fence watermark 和 dispatch-denominator digest、final-outcome digest、最大先前 epoch、准确预留的 recovery epoch 及有效期。ready 阶段主机证明是历史资格证据；最终使用的当前主机 generation SHALL 由后续 ActivationPermit 独立绑定，因此同一已绑定决策在 executor 重启后无需伪装旧 generation。仅在绑定的新鲜 time evidence 提交后，recovery-only reconciliation MAY 在隔离状态下使用 attempt-bound grant；这些 grant MUST 注册，且 MUST NOT 准入 Run 或创建 dispatch。

RecoveryQualification 达到 `ready` 后，最终生产 activation SHALL 首先根据 `v2c.command-idempotency` 和 `v2s.command-results`，以 `pending-coordination` 状态持久化普通 `recover-activate` 写命令，使用其完整 actor/command/target/idempotency identity 以及 payload 和 release/epoch 前置条件 digest。在 BindingCertificate 提交前，`v2s.restore` 是该 pending command 的唯一完成 owner：artifact 确定过期时原子标记其 expired 并完成为 `recovery_artifact_expired`；authority generation/rotation 确定失效时标记 artifact stale 并完成为 `stale_authority`；未绑定的 RecoveryPostFinalConflict/RecoveryAgentBindingConflict 获胜时按本 Requirement 的状态表转换 consumers 并完成为 `recovery_evidence_conflict`；其他确定性 precondition failure 完成为对应 typed invalid-state。超时、无响应或 authority 结果含糊时 MUST 保持同一行 pending 并只重试同一外部 CAS，不能猜测失败、创建新 command 或泄露 capability。随后 RecoveryAuthority SHALL 原子重新验证当前命令授权、artifact 在 bind 时有效、authority generation/rotation/revocation 状态、每个旧实例的 registration-closure proof、证据 digest、准确 session/Agent/qualification/target binding 和预留 epoch，再通过 CAS 将 `artifactId` 绑定到该完整命令 identity/digest，并签发不可变的 `BindingCertificate(bindingState=bound)`。Certificate 证明已线性化的准确决策，不是 admission/dispatch grant；它 SHALL 绑定 recoverySession、Agent、qualification generation、command/artifact/target/epoch/证据 digest 和 bind-time authority state，并可由受信任 executor 幂等查询。客户端重放只返回 pending/已存储的安全命令状态。

Binding CAS 是普通 authority 变化的 point-of-no-return，但本身不启用生产：bind 前的 rotation/emergency revocation 会阻止它，bind 后的普通 authority 变化不能重写决定。RecoveryAuthority SHALL 针对该 certificate 向受信任 executor 签发已签名、短期有效且单调递增 generation 的 `ActivationPermit`。Permit SHALL 绑定当前 boot/启动周期、`v2c.time` evidence 和最新 `production-control` LaunchAttestation；它不可导出，不进入客户端/安全结果，也不能授权另一 session/Agent/qualification/command/target/epoch/evidence digest。Permit lifecycle SHALL 封闭为 `issued | superseded | expired | consumed | revoked`，每个 binding 同时至多一个 `issued` generation。Permit 过期、executor 重启或主机 generation 被取代时，authority MAY 在重验当前 host/time evidence 后为同一 certificate/command 签发更高 generation；旧 permit 原子进入 `superseded` 或 `expired`。该重签不是新 attempt/epoch。

Authenticated RecoveryPostFinalConflict，或外部 operation-membership registry 中覆盖该 consumer 的 RecoveryAgentBindingConflict，是 bind 后、SQLite success 前仅有的两类 safety exception。若它先于 success transaction 线性化，RecoveryQualification SHALL 进入 `invalidating`；RecoveryAuthority 只可在验证准确 certificate、pending command、完整 conflict fact/global-conflict-generation/evidence digest 和尚无本地 success fact 后，以 CAS 将 Agent attempt 与 certificate binding state 从 `bound` 转为 `binding-invalidated-awaiting-local`，并把所有 permit generation 转为 `revoked`。随后一个 SQLite 事务 SHALL 保留全部 conflict 证据，将 artifact 标记为 invalidated、Qualification 转为 `invalidated`、Activation 保持 `quarantined`、推进该 Agent mutation-authority revocation、追加 `RecoveryBindingInvalidated`，并把同一 recover-activate command 完成为 typed `recovery_evidence_conflict`，同时把该 AgentAttempt 上已 pending 的 abort command（存在时）完成为 `invalid_state`。RecoveryAuthority 验证匹配的本地 fact 后，将 attempt/certificate 进入外部终态 `invalidated`。在 external/local 两步均完成前不得创建另一个 Agent attempt；完成后该 Agent 只能在新的数据库级 RecoverySession/target、完整 denominator 和更高 epoch 上恢复，旧 target 对该 Agent 永久禁止 active；未进入 conflict consumer set 的其他 Agent 不因此获得或丧失 authority；进入该 set 的每个 Agent 都必须完成相同 invalidation/ack。

正常 success SQLite 事务 SHALL 验证 certificate 仍为 `bound`、最新 permit 为 `issued` 且未过期、没有 RecoveryPostFinalConflict、覆盖该 consumer 的 RecoveryAgentBindingConflict 或 invalidating fact、准确 artifact/session/Agent/qualification/release/activation/database/source/target/evidence/epoch binding、每个旧实例 registration-closure proof、最新 verified host attestation、投影重建以及当前 `ready + quarantined`。随后它 SHALL 原子消费 artifact/permit，提交 Qualification `qualified`，将该 Agent Activation 以准确 epoch 转为 `active`，追加不含原始 permit 的 evidence facts，并完成同一 command；同一 AgentAttempt 上已 pending 的 abort command（存在时）同时完成为 `invalid_state`。Success 与任一 recovery/agent-binding conflict-invalidation CAS 比较相同 qualification generation/evidence head，恰有一方获胜：success 先提交时，后到 conflict 走 `qualified → invalidated` safety transition；conflict 先提交时，success 零行失败并只能完成 binding-invalidation。Binding 后普通崩溃仍保持生产禁用，executor 可查询 certificate 并使用当前 permit 重试；最终 commit 响应丢失时命令重放返回存储结果。RecoveryAuthority 仅在验证 success 本地 fact 后把 attempt/certificate/permit 置为 `consumed`，或在验证 binding-invalidated 本地 fact 后置为 `invalidated`，再关闭协调。任何崩溃点都不得暴露无 active Activation 的 qualified，或无已消费 artifact 的 active。

#### Scenario: 同一数据库文件初始化第二个 RecoverySession

- **WHEN** 一个数据库级 RecoverySession 已 pending 或 initialized，另一 restore-init 命令试图为同一恢复文件创建不同 session/target
- **THEN** 它返回 `recovery_in_progress`，不创建第二个 target/control instance/Agent qualification set

#### Scenario: 同库两个 Agent 并发恢复

- **WHEN** 冻结 agent set 中两个 Agent 并发推进 qualification 或 recover-activate
- **THEN** 两者绑定同一 RecoverySession/target，各自使用独立 qualification generation/epoch/command；任何路径都不能创建第二个 controlInstanceId 或借用对方 authority

#### Scenario: RecoverySession init 与 abort 竞争

- **WHEN** trusted init 与 session-abort 针对同一 external `pending` generation 并发 CAS
- **THEN** 恰有一个进入 awaiting-local；init winner 只能产生一个 initialized target/agent set，abort winner 只能产生 retired session，loser command 得到冻结 typed result

#### Scenario: Pending RecoverySession 中止时崩溃

- **WHEN** session-abort 外部 CAS 已进入 `retiring-awaiting-local`，但本地事务尚未完成时崩溃
- **THEN** 只允许同一 abort 命令把 session 完成为 `retired`，同时把原 restore-init 完成为 `recovery_aborted`；初始化、新 target、Agent qualification 或 pending loser 均不得出现

#### Scenario: RecoverySession init CAS 后崩溃

- **WHEN** external state 已为 `initializing-awaiting-local`，但本地 initialization 尚未提交时崩溃
- **THEN** 只有同一 SessionInitCertificate 可补完准确 session/target/all-Agent set；abort 和另一 init 均不能线性化，竞争 abort command 最终为 `invalid_state`

#### Scenario: Abort CAS 在本地中止前提交

- **WHEN** RecoveryAuthority 记录外部 `aborted-awaiting-local`，但 SQLite 在 RecoveryQualification 变为 `aborted` 前崩溃
- **THEN** 该 Agent/Qualification 保持非生产状态，新的 Agent attempt 返回 `recovery_in_progress`，且仅同一 abort 命令可完成本地终态、撤销 artifact/grant 并把未 bound recover-activate 完成为 `recovery_aborted`；RecoverySession 与其他 Agent 不变

#### Scenario: Agent abort 与 binding 竞争

- **WHEN** abort-recovery CAS 与 recover-activate binding CAS 针对同一 Agent-attempt generation 并发
- **THEN** 恰有一个获胜；abort winner 完成 recover-activate 为 `recovery_aborted`，binding winner 的最终 success/invalidation 完成 abort 为 `invalid_state`，没有 pending loser

#### Scenario: Permit 绑定后请求普通中止

- **WHEN** abort-recovery 以 binding CAS 已线性化的 Agent attempt 为目标
- **THEN** 普通中止被拒绝；仅准确 recover-activate success，或经过认证且覆盖该 consumer 的 RecoveryPostFinalConflict/RecoveryAgentBindingConflict binding-invalidation 可关闭该协调

#### Scenario: Binding 后冲突先于 SQLite success

- **WHEN** BindingCertificate 已为 `bound`，但 RecoveryPostFinalConflict 或覆盖该 consumer 的 RecoveryAgentBindingConflict 在 activation success transaction 前提交
- **THEN** permit 全部 revoked，外部与本地 binding-invalidation 只为同一 conflict/command 幂等补完；Activation 从未 active，旧 target 上该 Agent 永久不能 active

#### Scenario: Binding success 与冲突竞争

- **WHEN** 正常 activation transaction 与 authenticated conflict/invalidation 并发
- **THEN** 两者比较同一 qualification/evidence generation，恰有一个先线性化；最终 Agent 要么 active 后立即被安全 invalidated/quarantined，要么从未 active，不存在可继续使用的旧 permit

#### Scenario: Recovery conflict 到达终态 qualification

- **WHEN** RecoveryPostFinalConflict 指向已 `aborted` 或 `invalidated` 的 RecoveryQualification
- **THEN** 冲突证据仍由 source-fact owner 追加且目标保持隔离，但本 Requirement 保持 qualification 终态，不恢复 attempt、permit 或生产 authority

#### Scenario: Recovery operation 归属发生跨 Agent 冲突

- **WHEN** RecoveryAgentBindingConflict 涉及同 session 或不同 session 的多个 consumer Agent
- **THEN** 外部 conflict CAS 先 fence 全部 registry consumers；同 target 在一个事务中失效，跨 target 分别提交并回执或提供完整 TargetAuthorityClosed proof，在每个 target 收敛前任一 consumer 都不能继续用旧 final outcome、permit、promotion 或 dispatch

#### Scenario: 冲突 consumer target 永久失联

- **WHEN** 某个 consumer target 无法提交本地 invalidation ack，但 RecoveryAuthority 可完整关闭其 registration/continuation、撤销全部 authority/attestation 并越过最大 grant expiry
- **THEN** 不可逆 TargetAuthorityClosed proof 可替代该 target 的 ack；该 target 全部 Agent 永久失去生产资格，其 discoverable obligations 仍进入后续 denominator

#### Scenario: Target retirement proof 缺少 authority member

- **WHEN** proof 遗漏任一注册 member、continuation、host generation、未过期 grant 或 discoverable obligation
- **THEN** 它不能替代本地 ack，跨 target conflict 继续保持全体 consumer fenced

#### Scenario: Bound permit 过期或主机 generation 被取代

- **WHEN** binding 已线性化但 SQLite 尚未提交，且短期 permit 过期、executor 重启或主机 generation 被取代
- **THEN** 生产保持禁用；authority 只可为相同 BindingCertificate/command/target/epoch 签发绑定当前 host/time 证据的更高 permit generation，且不得创建新 recovery attempt

#### Scenario: Restore-init 完全相同的重放

- **WHEN** 相同的已授权数据库级 restore-init 命令在初始化提交后重复执行
- **THEN** 它返回已存储的 RecoverySession/target/result，不生成另一 control instance、agent set 或 qualification generation

#### Scenario: 恢复演练检查内部完整性

- **WHEN** 匹配的备份和元数据被恢复到干净路径
- **THEN** 文件 digest、完整性、watermark、标识和投影重建均可通过，同时系统保持隔离

#### Scenario: 旧的有效备份遗漏后续外部提交

- **WHEN** 一致的旧快照在后续 dispatch 可能已提交后被恢复
- **THEN** 生产资格认定保持受阻，直至绑定的每 sink 枚举发现并最终 reconcile 该 dispatch

#### Scenario: 无法 fence 直接 mutation authority

- **WHEN** 恢复的 release 使用了无法证明静止且已 revoked/rotated 的 direct-Effect credential 或 child process
- **THEN** 任何生产 recovery artifact 都不得使该恢复达到 qualified

#### Scenario: Direct exception 缺少 discovery method

- **WHEN** direct-Effect exception 无法完整枚举快照后的 external mutation
- **THEN** 恢复验证可在内部通过，但该 release 的生产 activation 和 dispatch 仍被永久拒绝

#### Scenario: Recovery artifact 由恢复的存储自行签发

- **WHEN** 唯一的 barrier、epoch 或 reconciliation evidence 来自恢复的数据库或其备份
- **THEN** 资格认定将其作为非独立证据拒绝

#### Scenario: Unknown 在没有 receipt 时解析为未提交

- **WHEN** denominator member 没有 connector receipt，但经过认证的完整 reconciliation 确立了 not-committed
- **THEN** 它可在不伪造 receipt 的情况下满足 final outcome/reconciliation

#### Scenario: Recovery challenge 被重放

- **WHEN** recovery artifact 复用已消耗的 challenge、过期 authority version 或非递增的预留 epoch
- **THEN** 资格认定拒绝它，且不改变 RecoveryAuthority high-watermark 或 Activation

#### Scenario: Ready artifact 过期或 authority 轮换

- **WHEN** RecoveryQualification 为 `ready`，但 artifact 有效期过期，或 authority generation/rotation 在 activation CAS 前变化
- **THEN** RecoveryAuthority 不签发 permit，Activation 保持 `quarantined`，且过期 artifact 无法被消耗

#### Scenario: Activation 目标与 artifact 不同

- **WHEN** permit 或 activation 命令指向另一 Agent、release、Activation、source instance、target instance、evidence digest 或 epoch
- **THEN** authority CAS 或 SQLite 事务拒绝它，且不消耗 artifact

#### Scenario: Recovery 使用恢复的时间证据

- **WHEN** pending 命令注册缺少当前预检时间，或 initialization/grant/fencing/permit/final activation 使用 snapshot 或 preflight evidence，而不是所需的 attempt-bound stage
- **THEN** 该步骤失败，grant 保持缺失，且目标保持隔离

#### Scenario: Recovery activation 缺少当前主机证明

- **WHEN** 最终 SQLite 事务运行时，绑定的 `production-control` LaunchAttestation 缺失、过期、不匹配、被取代或不为 `verified`
- **THEN** 事务使 artifact 保持未消耗，并使 Activation 保持 `quarantined`

#### Scenario: 替代 Activation 尝试绕过限制

- **WHEN** 恢复后的 Agent 在其 RecoveryQualification 尚未达到 `qualified` 时创建或提升另一 Activation
- **THEN** 生产 activation、admission 和 dispatch 仍被拒绝，且不消耗 artifact

#### Scenario: Client 在 authority 绑定后重放

- **WHEN** client 在最终 SQLite 提交前重复已绑定的 recover-activate 命令
- **THEN** 当前披露授权仅返回安全 pending 状态；ActivationPermit 或可复用 authority 均不会到达 client

#### Scenario: Authority 绑定后发生崩溃

- **WHEN** RecoveryAuthority 将 artifact 绑定到已存储的 recover-activate 命令，但 SQLite 在其最终事务提交前崩溃
- **THEN** 不存在生产 Activation，且仅受信任 executor 可查询同一 BindingCertificate，并使用当前有效 permit 重试该相同命令

#### Scenario: Authority 在绑定后变化

- **WHEN** 普通 rotation 或 emergency revocation 在 permit 的成功 CAS 之后、其仍有效的 SQLite 事务之前线性化
- **THEN** 仅准确的已绑定命令可依据已记录决策完成；后续 authority generation 管理所有新命令及任何随后的安全隔离

#### Scenario: 仅存在于 authority 的谱系实例被遗漏

- **WHEN** 某个谱系实例拥有 mutation-capable registry member，但没有保留的 dispatch，因而被 sink enumeration 遗漏
- **THEN** authority/dispatch denominator 验证失败，且恢复保持隔离

#### Scenario: 快照后的 authority 被遗漏

- **WHEN** 某个 mutation authority 在其谱系实例 registry watermark 之后、registration closure 之前注册，但 artifact 中缺少它或未对其进行 fence
- **THEN** denominator 验证失败，且恢复保持隔离

#### Scenario: 旧实例在 registration closure 后注册 authority

- **WHEN** 已关闭的旧 controlInstanceId 尝试注册新的或更高 generation 的 mutation-capable member
- **THEN** Registry 类型化拒绝该注册；若注册先于 closure 线性化，则它必须进入冻结 denominator 并被 fence

#### Scenario: 外部枚举遗漏谱系实例

- **WHEN** sink evidence 遗漏源实例，或遗漏任何具有 discoverable obligation 和已声明 fence watermark 的更早保留实例
- **THEN** dispatch-denominator 完整性检查失败，且恢复保持隔离

#### Scenario: Recovery authority 自行断言 sink 完整性

- **WHEN** recovery artifact 提供 fence watermark，却没有经过 sink/connector 认证的完整性证据
- **THEN** 即使 RecoveryAuthority 签署了 artifact，dispatch-denominator 验证仍拒绝它

#### Scenario: 完整恢复 activation 成功

- **WHEN** 某 Agent 的当前 artifact、bound certificate 和 issued permit 匹配共享 RecoverySession/target、该 Agent 的完整 denominator、source/lineage、qualification generation 和预留 epoch
- **THEN** 一个 SQLite 事务只消费该 Agent 的 artifact/permit，并提交其 Qualification `qualified` 及 Activation `active`，不改变同 session 其他 Agent 的 qualification

#### Scenario: Recovery activation 响应丢失

- **WHEN** 最终 recovery activation 已提交，但其响应丢失
- **THEN** 相同 activation 命令返回已存储结果，而任何不同命令都无法复用 artifact

### Requirement: 只读检查不产生隐式写入

**Requirement ID:** `v2s.read-only` SHALL 为此 Requirement 的稳定标识。

所有 M0 schema/oracle 检查 SHALL 在不创建 database、WAL、SHM、journal 或 sidecar，且不改变文件大小或修改时间的情况下运行。

#### Scenario: 检查现有数据库

- **WHEN** validator 以只读模式运行
- **THEN** 前后的目录条目、文件大小和修改时间完全相同

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
