## ADDED Requirements

### Requirement: 版本化核心对象契约

**Requirement ID:** `v2c.core-objects` SHALL 是本需求的稳定标识。

M0 SHALL 为 AgentSpec、AgentRelease、Activation、Run、RunAttempt、HarnessRequest、HarnessEvent、ActionEvent、CheckpointRef、RunEvent、Approval、Effect、健康事实、principal/authority 证据和类型化错误定义版本化、领域中立的 schema。一个 Run SHALL 绑定不可变的 `agentId`、`releaseId`、`activationEpoch`、trigger 和 authority 身份。

本需求拥有 AgentRelease schema 成员资格。AgentRelease SHALL 只包含静态执行声明：规范化的 spec、目标/指令和 Harness entry/ExecutionClosure；每个 prompt、policy、approved skill、fixture、executable 和 resource 的内容 digest；Harness/runtime/model/entitlement 约束；checkpoint schema 和允许的 durable boundary kind；Effect 与健康声明；knowledge descriptor；所需 capability 和 operation；逐项列出的 direct-Effect 例外；`v2c.host-attestation` 定义的静态 host 声明；以及不含已解析值的 SecretRef id/purpose/audience。Activation 状态、Agent-owned mutable state、preference/inference 记录、checkpoint 内容、launch/probe 结果、发布时间、authority 撤销状态和其他 observation MUST NOT 进入 release identity。skill、policy、tool、permission 或所需 capability/operation 的变化 MUST 产生不同的 release candidate。对外 capability registration/visibility 与完整 Workspace schema/write protocol 不属于 M0 schema membership，未知相关字段按默认拒绝处理，等待具名后续 change。已解析的敏感值 MUST NOT 出现在 release、source fact、HarnessEvent、trace 或 client payload 中。

核心字段和 enum 标识符 SHALL 使用 ASCII 字母、数字、`_` 或 `-`。为进行拒绝匹配，validator SHALL 在分隔符以及小写到大写边界处分割原始标识符，将所得有序 token 转为小写，并同时比较移除分隔符后的小写紧凑视图。一个版本化的 known-domain-term manifest SHALL 列出精确的禁止 token 列表和紧凑形式，包括每个已知 alias 或 compound；任一视图中的精确匹配都无条件拒绝该标识符。匹配 SHALL NOT 使用 stemming、fuzzy 或推断的 prefix 规则：新发现的 alias 需要修订 manifest。

每个未被该 manifest 拒绝的新核心标识符 SHALL 有一条领域中立性证明记录，绑定 schema path、精确标识符、manifest version/digest、accountable owner、decision 和 rationale。证据缺失、过期或不匹配会使验证失败；证明绝不能覆盖拒绝匹配，并且 MUST NOT 被表述为对未来领域概念的自动检测。

#### Scenario: 源 spec 不能直接运行

- **WHEN** 在没有已编译不可变 release identity 的情况下尝试 activation
- **THEN** 契约返回稳定的类型化拒绝，且不创建 Activation 或 Run 事实

#### Scenario: 将可变证明加入 release

- **WHEN** compiler 尝试在 release 内容中包含 Agent-owned mutable state、launch probe 结果、当前 authority 状态或 recovery observation
- **THEN** 验证将该字段作为可变证据拒绝，而不是为其分配新的 release identity

#### Scenario: 运行中的 Agent 扩展已发布 capability

- **WHEN** active Harness 尝试在不编译新 release 的情况下添加 tool、permission 或所需 capability/operation
- **THEN** 边界拒绝该变更，仅允许创建新的 release candidate

#### Scenario: 已知租户术语进入核心 schema

- **WHEN** 核心字段或 enum 标识符的 token 或紧凑比较视图匹配 known-domain-term manifest
- **THEN** 验证失败，且核心 schema 内不存在例外机制

#### Scenario: 新核心标识符缺少 owner 证据

- **WHEN** 新标识符未被拒绝，但缺少绑定其精确 schema path 和 manifest digest 的当前证明
- **THEN** 验证失败，而不是把 scanner 漏检视为领域中立性证明

#### Scenario: 敏感值进入 durable boundary

- **WHEN** 验证在 release、event、trace、HarnessEvent 或 client data 中检测到已解析的敏感值
- **THEN** 它拒绝该 artifact，且不发出该值

### Requirement: 类型化持久化与运行时数据边界

**Requirement ID:** `v2c.durable-data` SHALL 是本需求的稳定标识。

每个封闭 payload schema SHALL 将各字段分类为 `control-metadata`、`safe-text`、`artifact-ref`、`secret-ref` 或 `runtime-only`。Release、source fact、trace、command result 和 client projection MAY 只包含针对该精确 union arm 明确列入 allowlist 的类别；未知字段按默认拒绝处理。每个 `safe-text` 声明 SHALL 包含一个正数 `maxUtf8Bytes`，以及来自版本化封闭 registry 的精确 `sanitizerId + sanitizerVersion`。净化 SHALL 是确定性的；其输出 MUST 按 byte bound 和字段 allowlist 重新检查。缺失/未知的 sanitizer、非当前版本或通用默认值会使 schema/value 被拒绝。Agent 拥有或业务敏感的正文 SHALL 只能以受访问控制的 `artifact-ref` 加 digest 和 classification 跨越持久化/client 边界，绝不内联。`secret-ref` 只包含 id、purpose 和 audience；已解析值直接由 broker 提供给获授权的 child，MUST NOT 被持久化、跟踪或回显。

HarnessRequest MAY 携带该 RunAttempt 所需且由 release 声明的 `runtime-only` goal/input/context 字段，但 serializer 和 error/reporting path MUST 默认丢弃它们。持久化 CheckpointRef MAY 只包含 control metadata，加一个受访问控制的 artifact ref、schema/version、digest 和 producer identity；checkpoint 正文保留在 Control storage 之外。pattern detector 和 canary fixture 是针对已知泄漏的纵深防御证据，并不能证明任意敏感材料都可被识别。

#### Scenario: 提供未知持久化字段

- **WHEN** source fact、trace 或 client projection 包含其封闭 allowlist 中不存在的字段
- **THEN** 边界序列化在持久化或披露前拒绝它

#### Scenario: 仅运行时内容进入 trace

- **WHEN** 标记为 `runtime-only` 的 runtime input 或 context 被复制到 event、trace、command result 或 client response
- **THEN** 序列化失败，或在不发出内容的情况下将其替换为获授权的 artifact reference

#### Scenario: detector 漏掉未知值模式

- **WHEN** 某个值不匹配已知 leak detector
- **THEN** schema class 和 allowlist enforcement 仍决定可接受性；detector 结果不能证明安全

#### Scenario: 安全文本没有精确 sanitizer

- **WHEN** `safe-text` 字段省略其 byte bound，或指定缺失、过期或通用的 sanitizer
- **THEN** schema 验证在任何值到达持久化或 client 边界前拒绝它

### Requirement: 规范化 release 内容寻址

**Requirement ID:** `v2c.release-identity` SHALL 是本需求的稳定标识。

规范化版本 1 SHALL 在 hash 前对严格 JSON 数据模型进行操作。source parser MUST 在 object 物化前拒绝重复 object member name、格式错误的 UTF-8、孤立 Unicode surrogate 和非有限数字。Object member name SHALL 按其 UTF-16 code unit 的字典序排列；array SHALL 保持顺序；Unicode SHALL NOT 被规范化。String SHALL 仅对 quotation mark、reverse solidus 和 control character 使用 JSON escaping，在 JSON 定义短转义时使用短转义，否则使用小写四位十六进制转义。Number SHALL 使用有限 IEEE-754 binary64 语义和 ECMAScript 最短 round-trip 十进制拼写；negative zero SHALL 序列化为 `0`。SHALL 不发出无意义空白或结尾换行。

每个 JSON-number 字段 SHALL 声明 bounded safe-integer 或 binary64 语义。Safe-integer identity、count、limit 和 time 字段 MUST 在 hash 前拒绝非整数值以及超出 JSON safe-integer 范围的值。需要精确十进制语义的 quantity MUST 使用 schema 定义的规范字符串，而不是 JSON number。解析为相同已声明 binary64 值的不同源拼写被有意视为等价。

规范文档 SHALL 包含 `schemaVersion`、`canonicalizationVersion`、`hashAlgorithm`、`compilerVersion` 和由 `v2c.core-objects` 拥有的完整 AgentRelease schema，但不包含 `releaseId`。版本 1 SHALL 使用 SHA-256 对所得 UTF-8 bytes 做 hash。

发布前，compiler SHALL 将每个 runtime/code/legacy entry 解析为封闭的 `ExecutionClosure`：entry id；execution mode；loader/runtime executable；每个可传递加载的 module/package/native artifact；允许的 child executable；以及每个成员的精确 byte digest。解析 SHALL 仅使用 pinned input，并拒绝 unresolved、optional-at-runtime、path/tag-based 或 host-global dependency。Dynamic import/require、plugin discovery、package resolution、loader 和 subprocess execution SHALL 在 launch 时被拒绝，除非解析目标是具有匹配 mode 和 digest 的 closure member。Runtime filesystem/broker enforcement SHALL 使未声明的 executable load 不可达。Publication、activation 以及每次 child/subprocess launch SHALL 重新计算 release digest 并验证完整 closure bytes。

契约 SHALL 提供固定 vector，覆盖 nested key order、array preservation、control/string escaping、non-ASCII 和 astral key order、无 Unicode normalization、binary64 edge value、negative zero、duplicate-key rejection、lone-surrogate rejection、transitive dependency drift、undeclared dynamic load 和 undeclared subprocess。

#### Scenario: 等价的源格式

- **WHEN** 两个 input 仅在无意义空白、object-key order 或等价的 binary64 number spelling 上不同
- **THEN** 它们的 canonical bytes 和 release identity 相等

#### Scenario: 不安全整数进入 release 内容

- **WHEN** 声明为 safe integer 的 identity、count、limit 或 time 字段为非整数或超出 JSON safe-integer 范围
- **THEN** schema 验证在产生 canonical bytes 或 release identity 前拒绝它

#### Scenario: 边缘表示在语义上不同

- **WHEN** 两个 input 在 array order、Unicode scalar sequence、normalized 与 non-normalized text，或 referenced artifact bytes 上不同
- **THEN** 它们的 canonical bytes 或 resource digest 不同，因此 release identity 也不同

#### Scenario: 提供重复的源 key

- **WHEN** source object 在 normalization 前重复 member name
- **THEN** parsing 失败，而不是选择一个值并生成 identity

#### Scenario: 执行 bytes 在 launch 前漂移

- **WHEN** closure member 或 resource 不再匹配其 release digest
- **THEN** activation 或 child launch 以类型化 integrity error 按默认拒绝失败

#### Scenario: Runtime 解析未声明的 dependency

- **WHEN** entry 尝试在其冻结 ExecutionClosure 外进行 dynamic import、package/plugin resolution、loader access 或 subprocess execution
- **THEN** launch enforcement 在这些 bytes 执行前拒绝它

#### Scenario: 传递 dependency 发生变化

- **WHEN** 任一可传递加载的 module、runtime、loader 或允许的 child executable 的 bytes 发生变化
- **THEN** release identity 发生变化，而不是复用先前 closure

### Requirement: 显式 release 兼容性

**Requirement ID:** `v2c.release-compatibility` SHALL 是本需求的稳定标识。

reader compatibility manifest SHALL 列出精确支持的 `(schemaVersion, canonicalizationVersion, hashAlgorithm)` tuple。未知 version、未知 field 和不支持的 tuple MUST 按默认拒绝失败；M0 SHALL NOT 定义隐式 minor-version forward compatibility。历史 release MAY 仅在其精确 tuple 仍受支持且冻结的 canonical/resource vector 通过时 activation。

#### Scenario: 遇到未知 release 字段

- **WHEN** reader 遇到精确受支持 release schema 之外的字段
- **THEN** 它拒绝该 release，而不是忽略可能影响执行的声明

#### Scenario: 规范化版本已退役

- **WHEN** release 使用从 compatibility manifest 中移除的 tuple
- **THEN** activation 按默认拒绝失败，并要求显式 migration decision

### Requirement: Harness 会话、动作与 checkpoint 契约

**Requirement ID:** `v2c.harness-session` SHALL 是本需求的稳定标识。

每个 RunAttempt SHALL 恰有一个 attempt-bound HarnessSession。Harness MAY 在 release grant 和 budget 内动态选择 plan、context operation、tool、provider session 和 subagent；M0 SHALL 不定义 workflow graph、node kind、branch/foreach expansion 或 ProcessSpec authority。所得 action graph SHALL 仅为 projection，MUST NOT 调度工作或成为 Run truth。

每个外部可观察的 tool、subagent、provider 或产生 Effect 的 action SHALL 首先通过普通幂等 command boundary 注册稳定且不透明的 `actionId`。`(runId, actionId)` SHALL 唯一。注册 SHALL 绑定 `originRunAttempt`、action kind、同一 Run 中可选的更早 `parentActionId`、input artifact digest 和 command identity。精确 replay 返回相同 action；以不同 kind、parent 或 digest 复用则返回 `idempotency_conflict`。ActionEvent SHALL 另行绑定产生它的 RunAttempt、存在时的 inner retry ordinal、实际 runtime/tool identity、effective grant digest、artifact ref 和一个封闭 event kind。Parent reference MUST 向后指向现有 action，因此 projection 不能包含 cycle。

checkpoint MAY 仅在 release 声明的 `human`、`effect` 或 named-external-input boundary 发出，并且每个已开始 action 均已 terminal，或由精确的 durable external obligation 表示。CheckpointRef SHALL 绑定 checkpoint id、release、Run、producer RunAttempt/action、schema/version、artifact ref/digest，以及按规范 key 排序的 `OutstandingObligationRef` 集合。该 ref 是封闭的可辨识联合：`kind` 仅为 `effect | human | external-input`，并绑定同一 Run 中不可变的 `subjectId`/`subjectGeneration`，以及 checkpoint 时的 `ownerKind = control | effect-gateway | reconciliation`/`ownerGeneration`；`effect` ref 还 MUST 绑定准确 `effectId` 与 `intentGeneration`。不同 kind/subject/generation 不能碰撞或互相满足。

checkpoint 追加事务 SHALL 验证每个 ref 已持久存在，且记录的 owner/generation 是当时当前 owner。合法 owner handoff MUST 为同一 subject/generation 追加由 CAS fence 保护的 `ObligationOwnerTransferred` fact，绑定准确 from-owner/generation、to-owner/generation 与 transfer authority；每个 from generation 至多一个 successor，禁止 gap、branch、cycle 或改变 subject generation。后续 RunAttempt 分配事务 SHALL 验证原 owner 仍当前，或验证从 checkpoint ref 到当前 owner 的完整不可变 successor chain，并要求最终 obligation state 允许 resume；未解决的 ref 只能维持 durable wait，不能启动 Harness。它不授予 authority。Resume SHALL 创建新的 RunAttempt，其 initial fact 绑定该精确 checkpoint 和验证过的 owner-chain head；同一 Attempt 不能恢复自身。缺失、不兼容、不可访问、已修改、owner chain 无效或 obligation-incomplete 的 checkpoint 按默认拒绝失败。不支持 arbitrary continuation/program-counter replay 字段或边界。

#### Scenario: Harness 选择未声明的动作序列

- **WHEN** Harness 选择未预先声明为 graph 的 runtime action sequence，但每个 action 都通过 release、grant、budget 和 event validation
- **THEN** Control 接受这些 event，且不编译 node 或 ProcessSpec identity

#### Scenario: 以不同内容复用动作身份

- **WHEN** action registration 使用另一 kind、parent 或 input digest 复用 `(runId, actionId)`
- **THEN** 它返回 `idempotency_conflict`，且不追加 action source fact

#### Scenario: Checkpoint 包含内联会话状态

- **WHEN** Harness 尝试内联持久化 model context、secret、business body 或 continuation，而不是通过已声明的 artifact schema
- **THEN** checkpoint serialization 拒绝它，且不发出内容

#### Scenario: Attempt 恢复自身

- **WHEN** live 或 terminal RunAttempt 将 checkpoint 作为原地 continuation 提交
- **THEN** Control 拒绝它；只有新的 RunAttempt 才可绑定并消费该 checkpoint 作为 input

#### Scenario: Checkpoint obligation 使用错误 owner generation

- **WHEN** checkpoint 引用的 owner/generation 不是当时当前 owner，或 resume 与当前 owner 不同且没有唯一完整的 ObligationOwnerTransferred successor chain
- **THEN** 对应事务拒绝它，且不创建 checkpoint、RunAttempt 或 HarnessSession

#### Scenario: Dispatch 崩溃后从 checkpoint 恢复

- **WHEN** checkpoint 绑定的 Effect obligation 在 `dispatch-started` 后崩溃，并由同一 `effectId`/generation 的 reconciliation 最终解决
- **THEN** 只有在该 ref 被验证为已解决后，新 RunAttempt 才能绑定 checkpoint，且不会创建第二个 Effect identity

#### Scenario: Checkpoint obligation 跨 owner handoff

- **WHEN** checkpoint 后，同一 subject/generation 的 reconciliation owner 经受 fence 保护的 CAS 转移到新 generation 并最终解决 obligation
- **THEN** resume 验证从 checkpoint owner 到当前 owner 的唯一完整 successor chain 后可继续，且不会把合法 handoff 误判为 stale checkpoint

#### Scenario: 将动作图用作 scheduler 输入

- **WHEN** candidate 从重建的 action projection 推导下一个权威 action
- **THEN** conformance 失败，因为内部推进由 Harness 而非 projection 拥有

### Requirement: 封闭命令与事件分类

**Requirement ID:** `v2c.control-taxonomy` SHALL 是本需求的稳定标识。

M0 SHALL 冻结 control command、RunEvent、HarnessEvent 和 ActionEvent 的版本化封闭 discriminated union。state-table column 和 source-fact consumer MUST 从这些 union 生成，或与其逐一比较。未知 version/type、malformed payload、Harness stream 在没有 terminal technical result 时终止、deadline race 和 abort race MUST 各自映射为一个类型化拒绝或转换；被拒绝的 protocol input MUST NOT 作为 source fact 追加。

#### Scenario: 未知 Harness 事件到达

- **WHEN** adapter 发出冻结 HarnessEvent/ActionEvent union 之外的 event type 或 version
- **THEN** 该 payload 被拒绝，当前 RunAttempt 遵循表中的唯一 protocol-failure transition

#### Scenario: 状态表遗漏已声明事件

- **WHEN** taxonomy member 在其目标 aggregate 的任一 state 中缺少 cell
- **THEN** exhaustiveness validation 失败

### Requirement: 权威 actor、委派与策略解析

**Requirement ID:** `v2c.authority-policy` SHALL 是本需求的稳定标识。

可信 Control authentication boundary SHALL 是 principal authentication 和 delegation resolution 的唯一 owner。它 SHALL 注入不可变的 `AuthorityContext` 证据，其中包含全局唯一且稳定的 `issuerNamespaceId`；principal id；represented-subject id（不存在 representation 时等于 principal id）；audience；issuer version；authenticated method；ordered delegation-chain digest；effective scope/operation；issue/expiry；以及 revocation-version reference。`issuerNamespaceId` SHALL 在 key/version rotation 间保持稳定，但 subject-namespace semantics 的变化 MUST 创建新值。`actorSubjectId` SHALL 是对 `v2c.release-identity` canonical bytes 计算 SHA-256 的结果，该 bytes 对应 `['actor-subject-v1', issuerNamespaceId, principalId, representedSubjectId, audience]`。Transient login handle、authentication method、issuer version/rotation、issue/expiry 和 revocation version MUST NOT 进入该稳定 subject。改变 issuer namespace、represented subject 或 audience MUST 改变该值。client 提供的等价信息不可信。未知 namespace/version、已过期或撤销的 delegation、broken chain、wrong audience 或不可用 resolver MUST 按默认拒绝失败。

Effect Policy Registry SHALL 是当前 host risk floor 和 policy version 的唯一 owner。Release policy 只能进一步限制它。Composition SHALL 是确定性的：任何 deny 都占优；effective risk 是最大封闭 risk rank；allowed audience/operation 取交集；required approval constraint 取并集；expiry 取最早边界；未知、不可比较或不支持的 constraint 均拒绝。固定 vector SHALL 覆盖每个 operator 以及 deny-on-incomparable 行为。

Approval decision 和紧邻 dispatch 前的 authorization SHALL 分别独立解析当前 authority 与 policy。Durable fact SHALL 绑定所用 authority-context digest 和 policy version。command replay MAY 仅在当前 authentication 和 result-disclosure authorization 成功后返回其已存储 mutation result；replay MUST NOT 重新运行 mutation 或替换为新近拓宽的 authority context。

#### Scenario: 一个 principal 代表两个 subject

- **WHEN** 同一已认证 principal 针对不同 represented subject 或 audience 发出其他方面相同的 command
- **THEN** authority resolution 产生不同的 `actorSubjectId` 值，且任一 command 都不能 replay 另一个的 result

#### Scenario: 两个 issuer 复用本地 subject 字符串

- **WHEN** 两个可信 issuer namespace 对相同的 principal、represented-subject 和 audience 字符串进行认证
- **THEN** 它们的 `actorSubjectId` 值不同，且任一方都不能 replay 或披露另一方的 command result

#### Scenario: Delegation 在 dispatch 前被撤销

- **WHEN** Approval 在某项 delegation 下完成 decision，但该 delegation 在 dispatch 前被撤销
- **THEN** 紧邻 dispatch 前的 authorization 拒绝 mutation，且不记录 `dispatch-started` fact

#### Scenario: 策略约束不可比较

- **WHEN** release 与 registry policy constraint 没有已定义的 composition rule
- **THEN** evaluation 拒绝，而不是选择任一 policy

#### Scenario: 丧失披露权限后请求先前结果

- **WHEN** caller 重复已存储的 command identity，但当前 authentication 无法授权披露该 result
- **THEN** 不披露 safe result，且不重新执行原始 mutation

### Requirement: 可信时间与规范时刻

**Requirement ID:** `v2c.time` SHALL 是本需求的稳定标识。

单一 TimeAuthority SHALL 拥有 command/Approval/grant expiry、deadline、schedule occurrence、health window、startup-cycle freshness 和 recovery-artifact validity 所使用的时间。Durable instant SHALL 是带符号整数 UTC epoch millisecond；恰好等于 deadline 或 expiry 时视为已过期。同一 startup cycle 内的 elapsed budget SHALL 使用该 cycle 的 monotonic clock，且 SHALL NOT 从 wall time 重建。

host profile SHALL 声明 `maxBackwardSkewMs`。TimeAuthority SHALL 持久化 last-trusted UTC watermark 和 clock generation。比 watermark 落后但不超过声明 skew 的 wall-clock sample SHALL 将 effective UTC 限制为 watermark；更大的回拨、clock 不可用或 generation 歧义 SHALL 使新 admission、Approval、grant issue 和 dispatch 按默认拒绝失败，直至新的已验证 host/recovery attestation 确立时间。

每个由 recovery-authority 协调的 command SHALL 使用 current-cycle preflight time evidence；数据库级 restore-init 还使用更晚的 RecoverySession evidence，每个 Agent qualification 则使用各自更晚的 Agent-attempt evidence。command registration 首先在与 pending command row 相同的事务中追加 preflight evidence，绑定 TimeAuthority id/version、当前 boot/startup-cycle、clock generation、command identity/digest、observed/effective UTC、prior watermark 和 status。RecoveryAuthority 发出 session 或 Agent attempt/challenge 后，同一时刻或更晚的 observation SHALL 在对应 initialization、grant 或 recovery transition 前追加 stage evidence，绑定上述字段以及该 session/attempt/challenge。恢复的 wall/monotonic value、snapshot timestamp 或旧 time-status fact 不能满足任一阶段。证据缺失、过期、回退或有歧义会阻止相应 registration、attempt、permit 和 final activation。固定 vector SHALL 覆盖 equality、forward jump、tolerated skew、excessive rollback、restart 和 snapshot-stale time。

#### Scenario: 到期时间等于当前时间

- **WHEN** 可信当前 UTC 等于 command、Approval 或 grant expiry
- **THEN** authorization 将其视为已过期，且不写入 mutation fact

#### Scenario: 时钟回拨超出容差

- **WHEN** 观测到的 wall time 比持久化 watermark 落后超过 `maxBackwardSkewMs`
- **THEN** time-dependent admission 和 dispatch 按默认拒绝失败，直至重新 attestation

#### Scenario: 经过时间的 deadline 跨越 wall-clock 调整

- **WHEN** live attempt 期间 wall time 发生变化
- **THEN** 其 elapsed deadline 继续使用 startup-cycle monotonic clock

#### Scenario: Restore 根据 snapshot 时间评估到期

- **WHEN** recovery 只提供恢复的 clock state、省略 command preflight evidence，或用 preflight 替代更晚的 attempt-bound evidence
- **THEN** 相应 command/attempt/permit 或 host-proof check 失败，直至要求的 current-cycle stage 提交

### Requirement: 穷尽的 Activation 转换与准入权限表

**Requirement ID:** `v2c.activation` SHALL 是本需求的稳定标识。

契约 SHALL 枚举每个 Activation state/event 组合。最小 state 为 `inactive`、`shadow`、`active`、`draining` 和 `quarantined`；每个 cell MUST 指定 transition、durable idempotent replay 或 typed rejection。

对于一个 Agent，只有 `active` 可拥有 production manual/intent admission。Scheduled/cron admission 在 M0/M1 中仅有 identity：未定义 scheduler 或 misfire/catch-up policy，任何启用或提交 scheduled admission 的 command MUST 返回类型化 `unsupported_schedule`，且不创建 Run 或 cursor。启用 schedule execution 需要 M3 前另立 SOT/OpenSpec change，具有 named consumer 和封闭 occurrence policy；`v2s.ddl` 只拥有预留的 series/occurrence identity。

`shadow` 只能接受明确归因的 evaluator input，且 MUST 在没有 gateway grant、direct-Effect mutation authority 或任何 mutation-capable runtime grant 的情况下 launch。`draining` 和 `quarantined` 不接受新的 production admission 或 dispatch，但 MAY 执行 CAS-fenced receipt/reconciliation work；`inactive` 两者均不接受。每次转为 `active`（包括 `recover-activate`）MUST 在改变 production owner 的同一事务中，根据 `v2c.host-attestation` 验证并绑定最新且未过期的 `production-control` LaunchAttestation generation；证据缺失、过期、被取代、不受支持或未验证时，先前 state 和 owner 保持不变。普通 promotion 到 `active` MUST 还满足 `v2s.handoff` 并使用更高 epoch。对于被未 qualified 的 `v2s.restore` RecoveryQualification 覆盖的 Agent，每个 Activation（包括 replacement identity）MUST 拒绝普通 production promotion；其唯一 production transition 是由 `v2s.restore` 拥有并通过 target-bound、单次消费 final transaction 完成的普通 `recover-activate` command；`ActivationPermit` 是不可导出的内部证据，不是 client command argument。

#### Scenario: Active 转换缺少当前 host 证据

- **WHEN** ordinary 或 recovery command 在没有匹配 current-cycle production-mode `verified` LaunchAttestation 的情况下请求 `active`
- **THEN** transition 被拒绝，且不改变 Activation state、epoch 或 production owner

#### Scenario: 请求两个 production owner

- **WHEN** command 会使同一 Agent 的第二个 Activation 可进行 production write
- **THEN** 它被拒绝，现有 owner 保持不变

#### Scenario: Shadow 收到 production input

- **WHEN** shadow Activation 收到普通 manual 或 intent admission
- **THEN** admission 被拒绝，且不创建 Run

#### Scenario: M0 或 M1 启用 scheduled admission

- **WHEN** release 或 command 尝试在 M0/M1 contract profile 下启用 cron、missed-run 或 catch-up execution
- **THEN** 它收到 `unsupported_schedule`，且不创建 Run、schedule cursor 或 owner

#### Scenario: Cutover 在 promotion 前崩溃

- **WHEN** old owner 已被 fenced，但 new epoch 在崩溃前尚未提交
- **THEN** recovery 观测到零 production owner，并要求显式 qualification 加更高 epoch activation

#### Scenario: 恢复的 activation 使用普通 promotion

- **WHEN** restored Agent 的任一 Activation 在 RecoveryQualification 不是 `qualified` 时，且位于精确存储的 `recover-activate` 加 internal-permit path 之外请求 `active`
- **THEN** transition 被拒绝，且不提交 production owner 或 artifact-consumption fact

### Requirement: 持久化写命令幂等性

**Requirement ID:** `v2c.command-idempotency` SHALL 是本需求的稳定标识。

每个已认证且格式正确的 write command SHALL 使用稳定 identity `(actorSubjectId, commandKind, targetAggregateId, idempotencyKey)`、canonical payload digest，以及其所需 release/epoch precondition 的 canonical digest。封闭 command manifest SHALL 拥有每个 command kind，包括由 `v2s.restore` 使用的 `restore-init`、`abort-recovery` 和 `recover-activate`，并为每个精确支持的 `commandDigestTuple = (commandSchemaVersion, canonicalizationVersion, hashAlgorithm)` 分配值。Payload 和 precondition input MUST 使用该 tuple 的 strict parser、声明的 numeric domain 和 `v2c.release-identity` canonical bytes；duplicate key、unsafe integer、negative-zero alias 和 unsupported tuple 在 lookup 或 registration 前遵循相同 fixed vector。第一条 command record SHALL 绑定所选 tuple、AuthorityContext evidence digest、payload digest 和 precondition digest。Replay SHALL 先定位 stored identity，并在该 stored tuple 下规范化重复的 payload/precondition；不支持的 stored tuple 按默认拒绝失败，且不注册或重新执行。新 command 使用当前支持的 tuple。

manifest SHALL 将三个 recovery command 标记为 `coordination` mode `recovery-authority`。`restore-init.targetAggregateId` SHALL 从 `(databaseIdentity, sourceControlInstanceId, backupDigest)` 确定性推导并拥有数据库级 RecoverySession；`abort-recovery.targetAggregateId` SHALL 是封闭 union：初始化前可绑定 `recoverySessionId`，初始化后可绑定 `(recoverySessionId, agentId, qualificationGeneration)`；`recover-activate` 只绑定后者。任一路径都不能把 controlInstanceId 变成 per-Agent identity。在任何 external authority CAS 前，它们 SHALL 在 `v2s.command-results` 下的 `pending-coordination` row 中提交相同 command identity/digest/first-authorizing evidence；该 row 既不是 success，也不是 aggregate mutation。只有该精确 row 才可协调并完成，而已授权 client replay 返回不含 internal permit/evidence 的安全 pending status。非协调 command MUST NOT 使用 pending state。

manifest SHALL 还为每个 command kind 定义 mutation 前确定性的 `targetAggregateId` derivation；create/admission command MUST 以现有 parent aggregate 或 canonical preallocated aggregate id 为目标，且 MUST NOT 依赖 post-commit generated id。`actorSubjectId` SHALL 是由 `v2c.authority-policy` 推导的 stable subject，绝不是 authentication-session id 或 client claim。刷新或收窄 credential MUST NOT 创建另一个 command identity。Authentication 和当前 result-disclosure authorization 位于 replayed mutation 之外；只有不存在 stored identity 时，才执行 new-command state、mutation authorization 和 epoch check。

Success 以及格式正确的 authorization/state/epoch/terminal rejection result SHALL 在 response 前存储，并保留至 database archival。Lookup SHALL 在 payload-conflict disclosure 前发生：same-digest replay 与 different-digest `idempotency_conflict` MAY 仅在当前 authorization 允许访问该 command identity/target 后披露；拒绝不会泄露先前 command 或其 result。任何 replay path 都不重新执行 mutation。Malformed、unauthenticated、expired-authority 或 invalid-idempotency request SHALL NOT 注册。Replay result MUST 遵守 `v2c.durable-data`，并排除 claim capability 或 reusable submission grant。

#### Scenario: 成功响应丢失

- **WHEN** 已认证 caller 在首次 commit 后以相同 live authority context 重复同一 command
- **THEN** 返回原始 safe result，且不发生另一次 transition

#### Scenario: Authority context 发生变化

- **WHEN** 在 refreshed、narrowed 或 revoked delegation evidence 下提供相同 principal、represented subject、audience 和 key
- **THEN** lookup 仍找到原始 command；当前 disclosure authorization 要么返回其 safe result，要么拒绝披露，并且 mutation 永不再次执行

#### Scenario: Command digest parser 意见不一致

- **WHEN** payload 或 precondition 包含 duplicate key、unsafe integer、unsupported canonicalization version，或同一已声明 binary64 value 的 alternate spelling
- **THEN** shared canonicalizer 在 command lookup 可分裂 identity 前给出唯一 owner 定义的 rejection 或 digest

#### Scenario: Recovery command 绕过 command manifest

- **WHEN** restore initialization、abort 或 activation 使用 side command id/result path，或在没有其 pending command row 的情况下到达 external CAS
- **THEN** validation 在 RecoveryAuthority binding 或 storage mutation 前拒绝它

#### Scenario: 协调命令在 pending 时被 replay

- **WHEN** 精确 recovery command 在其 pending row 提交后、final completion 前重复
- **THEN** 当前 disclosure authorization 返回安全 pending status，且不产生第二条 row、CAS 或 client-visible capability

#### Scenario: 已存储命令使用较旧的规范化 tuple

- **WHEN** 当前 tuple 变化后，replay 到达使用受支持 historical tuple 写入的 command row
- **THEN** 其 request 在 stored tuple 下比较，并返回 original result 或 conflict，且不创建第二个 identity

#### Scenario: Create command 缺少确定性目标

- **WHEN** create 或 admission command 无法在 mutation 前推导其 target aggregate
- **THEN** command validation 拒绝它，且不注册 idempotency record 或 aggregate fact

#### Scenario: Key 被不同 payload 或 precondition 复用

- **WHEN** 使用不同 payload digest 或 release/epoch precondition digest 复用现有 command identity
- **THEN** 它返回 `idempotency_conflict`，且不写入 aggregate fact

### Requirement: 穷尽的 Run 转换表与终态收口点

**Requirement ID:** `v2c.run` SHALL 是本需求的稳定标识。

契约 SHALL 枚举每个 Run state/event 组合，包括 admission、RunAttempt allocation/settlement、durable wait、resume、cancel、Harness failure、Effect result、outcome proposal、retry decision、recovery 和 terminalization。Run 和 RunAttempt projection MUST 仅从有序 append-only source fact 推导。`completed`、`failed` 和 `cancelled` SHALL 是 terminal，并且只能通过一个 terminal choke point 进入；首个已提交 terminal fact 获胜。Harness technical success 和 outcome proposal 是证据，而不是 terminal command；release 声明的 domain outcome gate 决定 Control 是否可 terminalize completion。

本需求拥有 Run-admission evidence 成员资格。每次成功的 production manual/intent admission SHALL 将最新且未过期的 `production-control` LaunchAttestation id/digest/generation、release 和 Activation epoch 绑定到 Run 的 initial admission fact。`v2s.transactions` SHALL 将该证据与 Run、initial RunEvent、command result 和 projection 一起提交。如果 generation 在 commit 前缺失、过期或被取代，则 admission 不写入其中任何一项；后续 invalidation 仍可审计，且不重写已 admitted 的 Run。

same-command replay SHALL 返回其 stored result。输掉竞争的不同 terminal command SHALL 仅在 read authorization 允许该 snapshot 时返回 `terminal_conflict` 加 winning snapshot。Terminal Run MUST 拒绝新的 RunAttempt、ActionEvent、EffectIntent 和 dispatch。只有满足 `v2s.source-facts` 的 pre-terminal dispatch 的 receipt/reconciliation observation 可延迟到达；它们 MUST NOT 改变 Run terminal summary 或调度工作。

#### Scenario: Host 证明在 admission 期间被取代

- **WHEN** admission 验证一个 host generation，但较新的 invalidating generation 在其 transaction commit 前获胜
- **THEN** 不会在 stale generation 下提交 Run、admission fact、command result 或 projection row

#### Scenario: Completion 与 cancellation 竞争

- **WHEN** completion 和 cancellation 使用不同 command identity 并发指向同一个 non-terminal Run
- **THEN** 恰有一个 terminal fact 提交，loser 收到 `terminal_conflict`

#### Scenario: Harness 在没有 outcome 证据时提议 completion

- **WHEN** Harness 成功退出或提议 completion，但 release 声明的 domain outcome gate 缺少所需 artifact/evidence
- **THEN** Control 记录 technical settlement，但不追加 completed terminal fact

#### Scenario: Terminal 后有新工作到达

- **WHEN** terminal Run 收到新的 RunAttempt、ActionEvent、EffectIntent 或 dispatch command
- **THEN** 它被拒绝，source fact 保持不变

#### Scenario: Projection 重建

- **WHEN** disposable Run/RunAttempt/action projection 被删除
- **THEN** replay storage 拥有的有序 source fact 会重建相同 terminal summary 和 observed action graph

### Requirement: 穷尽的 RunAttempt 与分层重试所有权

**Requirement ID:** `v2c.run-attempt` SHALL 是本需求的稳定标识。

契约 SHALL 枚举最小 state `created`、`starting`、`running`、`quiescing`、`checkpointed`、`succeeded`、`failed` 和 `cancelled` 上的每个 RunAttempt state/event 组合。最后四个是 terminal Attempt state；每个 table cell MUST 指定 transition、durable idempotent replay 或 typed rejection。Control Core SHALL 独自分配单调递增的 Hangar attempt number，并拥有 outer retry/restart。HarnessAdapter MUST NOT 创建 Hangar Run/RunAttempt 或声明 Run terminality。

Harness MAY 在一个 RunAttempt 内拥有 named model、transport、provider-session 和 release 声明的 reversible action retry。每次 inner retry SHALL 可通过 ActionEvent 观察，且 MUST NOT 分配 Hangar attempt 或 terminal fact。当前一 Attempt/session/containment 仍 live 或 identity-ambiguous 时，Control MUST NOT 分配下一个 RunAttempt。Restart 要求先前 Attempt 已 terminal、whole-tree quiescence 已验证、不存在可 dispatch 的 stale grant，并且每个先前 Effect 要么 final，要么由精确 durable wait/reconciliation owner 持有。为关闭 check-then-act 竞态，Control SHALL 先 seal 先前 containment、撤销其 grant generation，并追加一个绑定先前 Attempt/HarnessSession、containment id/generation、grant-revocation generation 和当前 durable obligation-set digest 的 `AttemptQuiesced` fact。`v2s.transactions` 所拥有的新 Attempt 分配 CAS SHALL 原子消费该 fact，并重新验证先前 Attempt terminal、当前 Attempt number、sealed containment、grant generation 与 obligation digest；任一变化都返回 typed stale/invalid-state，而不是分配。`AttemptQuiesced` 是旧 Attempt 所有派生写入与 launch 的统一 generation fence。提交后，旧 Attempt 的 action 注册、HarnessEvent/ActionEvent、EffectIntent、checkpoint、outcome proposal、grant 使用、child/containment 注册或 launch 以及其他 Harness-originated command 均按 stale Attempt 拒绝。白名单只允许 Control-owned cleanup/reap fact，以及精确绑定 quiescence 前 `dispatch-started`/obligation 的 authenticated late receipt/reconciliation；这些 late fact MUST NOT 创建 action、grant、child、Attempt 或调度工作。checkpoint resume 还要通过 `v2c.harness-session` 的 producer/schema/obligation validation。

#### Scenario: Harness 发出 outer retry

- **WHEN** HarnessAdapter 报告或启动未请求的第二个 Hangar RunAttempt
- **THEN** event/launch 被拒绝，Control ownership 保持不变

#### Scenario: Control 在旧 session 有歧义时重试

- **WHEN** Control 在先前 HarnessSession 或 containment 仍 live 或无法证明 quiescent 时考虑另一个 RunAttempt
- **THEN** retry 被拒绝，且不分配新的 attempt identity

#### Scenario: Harness 在没有业务 gate 时以零退出

- **WHEN** Harness 以零退出，但缺少所需 artifact/outcome evidence
- **THEN** 只记录 technical Attempt success，Run 不标记为 business-completed

#### Scenario: 旧 session 在 quiescence 后迟到派生写入

- **WHEN** `AttemptQuiesced` 已提交后，旧 HarnessSession 重放 action/event、EffectIntent、checkpoint、outcome proposal、grant 使用或 child registration/launch
- **THEN** Control 返回 typed stale-Attempt rejection，不追加派生 fact、不启动进程，也不改变新 Attempt 的分配资格

#### Scenario: Quiescence 后到达既有 dispatch 的 receipt

- **WHEN** authenticated receipt 或 reconciliation 绑定 quiescence 前已持久化的准确 dispatch/obligation
- **THEN** Control 可追加该不可调度 late fact 并使 obligation digest 变化；任何尚未提交的新 Attempt 分配 CAS 因 digest 不匹配而失败

#### Scenario: Attempt 分配前 obligation 发生变化

- **WHEN** quiescence fact 记录后、分配 CAS 前，Effect/reconciliation obligation set 或 owner generation 发生变化
- **THEN** CAS 不消费 quiescence fact且不分配 RunAttempt，Control 必须基于新状态重新判定

#### Scenario: Checkpoint resume 分配新 attempt

- **WHEN** 有效的 checkpointed Attempt 在其 durable boundary 解决后恢复
- **THEN** Control 原子消费匹配的 quiescence fact，分配下一个单调递增 RunAttempt，并在其 initial fact 中绑定精确 CheckpointRef

### Requirement: 受限进程生命周期所有权

**Requirement ID:** `v2c.process-lifecycle` SHALL 是本需求的稳定标识。

对于 Hangar 启动的每个 Harness child，Control Core SHALL 独自拥有 top-level process identity、dedicated OS containment identity/generation、cancel escalation、terminal convergence 和 whole-tree hard reap。可信 launcher MUST 在释放 Harness entrypoint 前创建 containment，并强制每个 descendant 保持为其成员，或以其他方式无法逃脱其 kill boundary。record SHALL 绑定 host boot/startup-cycle id、containment id/generation、root PID 和 start-time fingerprint；仅有 PID 永远不充分。无法正向证明完整 descendant containment/reap 的 target host 不支持 production 或 mutation-capable launch。

launcher SHALL 将 child 保持在 bootstrap gate 后，直至一个 transaction 验证最新且未过期的 `production-child` LaunchAttestation generation，并根据 `v2s.transactions` 和 `v2s.source-facts` 将其 id/digest/generation 绑定到 process-ownership record 和 launch SourceFact。被取代的 generation 或 persistence failure SHALL 在 Harness entrypoint 执行前终止并 reap 完整 containment。由 `v2s.restore` 使用且单独命名的 `restricted-child-authority` registry member 是外部 recovery-fencing evidence，MUST NOT 替代普通 registration、signal、whole-tree reap 或 terminal state。Launch、containment membership/probe、signal request/result、exit observation 和 reap result SHALL 成为 source fact。TERM-to-KILL timing 使用 `v2c.time`；每个 act 都重新验证当前 identity/generation，并且 recovery/repetition 通过 Run terminal choke point 保持幂等。

external orchestrator MAY 在一个 RunAttempt 内拥有 logical phase/session/descendant scheduling，并执行 graceful cleanup。该 ownership 不会削弱 Control 在 cancellation、parent death 或 timeout 后 hard-reap 整个 containment 的能力或职责，也绝不会让 Control 获得 tenant 内部 retry/state machine 的 ownership。

#### Scenario: PID 在 recovery 前被复用

- **WHEN** 已记录 root PID 仍 live，但 boot/start-time 或 containment identity 不同
- **THEN** Hangar 不向该 process 发送 PID-targeted signal，只收敛 stale ownership record/containment

#### Scenario: Owner 死亡但 descendant 仍存活

- **WHEN** Control owner 或 Harness root 死亡，而匹配的 descendant 仍留在已记录 containment 内
- **THEN** elected Control owner 恢复 escalation、hard-reap 每个 member，并最多提交一个 terminal outcome

#### Scenario: Launch identity 无法提交

- **WHEN** 已分配 containment/root process，但其完整 identity registration 或 launch source fact 无法提交
- **THEN** launcher 不释放 Harness entrypoint，并终止/reap 完整 containment

#### Scenario: Child host 证明在释放前被取代

- **WHEN** 较新的 `production-child` generation 在 process registration commit 前使证明失效
- **THEN** 不提交 ownership/launch fact，entrypoint 保持 gated，完整 containment 被 reap

#### Scenario: External orchestrator 拥有逻辑 descendant

- **WHEN** Harness 在一个 RunAttempt 内管理 named phase、session 或 descendant
- **THEN** Hangar 将其 logical scheduling 留给 Harness，同时保留可独立测试的 whole-tree containment/reap authority

#### Scenario: Host 只能 reap direct child

- **WHEN** target profile 证明 direct-child termination，但无法阻止或枚举 escaped descendant
- **THEN** production/mutation-capable host qualification 失败，且不作 structural whole-tree claim

### Requirement: 穷尽的 Approval 转换

**Requirement ID:** `v2c.approval` SHALL 是本需求的稳定标识。

契约 SHALL 枚举 request、decision claim、approve、reject、expiry、supersede、duplicate decision、crash recovery 和 terminal cleanup 的 Approval state/event。Approval subject SHALL 绑定 `effectId`、intent digest、operation/audience、policy version、release id、activation epoch 和 expiry。Decision evidence SHALL 绑定当前 AuthorityContext。Authorization SHALL 默认拒绝，强制 subject-scoped operation 和 approver constraint，并在 decision 时以及紧邻 dispatch 前以原子方式重新解析。只能提交一个 decision；policy 或 authority invalidation 需要新的 decision path，且 MUST NOT 扩大旧 subject。

#### Scenario: 未授权 actor 作出决定

- **WHEN** 已认证 principal 缺少针对精确 Approval subject 的当前 authority
- **THEN** decision 被拒绝，并记录持久化 safe result

#### Scenario: Approval 在 dispatch 前过期

- **WHEN** policy、authority、release、epoch、intent、operation 或 expiry 不再匹配
- **THEN** dispatch 在 `dispatch-started` 前被拒绝

#### Scenario: 重复 decision 竞争

- **WHEN** 两个 decision 指向同一个 pending Approval
- **THEN** 恰有一个提交，另一个返回已存储的 decided state

### Requirement: 穷尽的 Effect 生命周期与端到端身份

**Requirement ID:** `v2c.effect` SHALL 是本需求的稳定标识。

EffectIntent SHALL 恰好包含一个 external operation、当前已注册的 `actionId`、在其 Run 内稳定且唯一的 `intentKey`，以及从零开始的整数 `intentGeneration`。首次接受 SHALL 要求该 action 属于 Run，并且 SHALL 创建全局唯一的 `effectId`，绑定 `(runId, intentKey, intentGeneration)`、operation、canonical intent digest 和不可变 first-origin Action/RunAttempt。multi-operation request MUST 拆分为独立授权的 Effect；Effect、claim、dispatch、receipt 和 reconciliation MUST NOT 扩大或合并 operation。在 idempotent replay 或 checkpoint recovery 时，相同 Run/key/generation/operation/digest MUST 返回现有 Effect，即使稍后的 ActionEvent 报告该 replay；first origin 保持不可变。相同 Run/key/generation 使用另一 operation 或 digest MUST 返回 `idempotency_conflict`。identity SHALL 在 policy、Approval、claim、dispatch、receipt 和 reconciliation 全程保持不变。

Gateway SHALL 是 gateway-governed external commit 的唯一 owner。每条 Effect path（包括 automatic allowance）SHALL 使用 `v2c.authority-policy`、持久化 AuthorityContext evidence digest 加 policy version，并在紧邻 dispatch 前以原子方式重新解析两者。claim SHALL 是 internal、single-use，并绑定 Effect、release、activation epoch、sink、精确 operation、audience、claim generation 和 expiry。紧邻 external invocation 前，gateway SHALL 重新授权并验证 `v2c.host-attestation` 下最新且未过期的 `effect-dispatch` LaunchAttestation generation，然后通过 CAS 转为持久化 `dispatch-started`，并绑定其 id/digest/generation。未开始的 claim MAY 被 epoch 撤销；stale worker 或被取代的 attestation 无法 dispatch。在 `dispatch-started` 后发生 crash 或 timeout，且没有 authoritative receipt 时，会产生 `unknown`，绝不自动 retry。

只有已认证 connector MAY 提交 `ExternalReceipt(status=committed|rejected|failed-not-committed)`，receipt admission MUST 满足 `v2s.source-facts`，包括持久化 connector-authority id/version/generation、authentication-evidence digest 和 sink discovery-proof reference；`committed` 映射到 ExternalOutcome `committed`，而 authenticated sink rejection 和 `failed-not-committed` 仅在其声明的 sink semantics 证明未 commit 时映射到 `not-committed`。否则不接受 authoritative receipt，local outcome 保持 `unknown`。Pre-invocation `LocalDispatchResult(status=denied|claim-expired|claim-revoked|transport-not-started)` 与之互斥，且绝不是 external receipt。

每个 `dispatch-started` SHALL 有 `ExternalOutcome(status=unknown|committed|not-committed|conflicted)`。Committed/not-committed 对 ordinary lifecycle 和 promotion 而言是 final；只有下述显式 `PostFinalConflict` safety transition 可以重新打开它们。`unknown` 创建 reconciliation obligation。Reconciliation producer 和 conflict-resolution authority SHALL 同样通过 `v2s.source-facts` 绑定其当前 authority id/version/generation、authentication-evidence digest 和 discovery/conflict-proof reference。Reconciliation SHALL 使用 CAS ownership 和封闭 lifecycle state `pending`、`claimed`、`resolved-committed`、`resolved-not-committed` 与 `unresolved`；reconciliation fact 可在没有 receipt 的情况下确立 committed 或 not-committed。矛盾证据保持 append-only，将 ExternalOutcome 设为 `conflicted`、reconciliation 设为 `unresolved`，并且 MUST NOT 替换 receipt 或 redispatch。conflicted dispatch MAY 仅通过 sink capability manifest 声明的 authenticated conflict-resolution method 变为 final：一个由 CAS 拥有的 fact MUST 绑定完整不可变 conflict-evidence set，并证明恰好一个 committed 或 not-committed outcome。

如果已认证矛盾证据在 final outcome 后到达，一个 `PostFinalConflict` fact SHALL 以原子方式保留先前证据、将 Effect 重新打开为 `conflicted/unresolved`、把其 production Activation 移至 `quarantined`，并在任何后续 admission、claim 或 dispatch 前撤销适用的 connector/gateway mutation-authority generation。Conflict resolution MAY 使 Effect 回到 final outcome，但 MUST NOT 重新激活 Agent；稍后的 production transition 必须独立满足 `v2c.activation` 或 `v2s.restore`。缺失、不确定或不匹配的 conflict authority 会使其保持 unresolved。`resolved-not-committed` 后的新 attempt 要求 `intentGeneration = prior + 1`，并通过完整 policy/Approval 获得新的 Effect identity；replay prior generation 返回其旧 Effect。

Sink capability manifest SHALL 声明 one-operation credential limit、external idempotency、reconciliation completeness 和封闭 authority-role set，其中包含 connector receipt producer、reconciler 和 conflict resolver，并为每个 role 提供 identity/generation verification method。支持 idempotency 的 sink SHALL 接收 `effectId`。不支持的 sink MUST 禁用 transport retry；缺少 complete reconciliation 的 high-risk sink MUST 被拒绝。

#### Scenario: 等价 intent 在 retry 后返回

- **WHEN** retried attempt 发出相同 origin、intent key、generation 和 digest
- **THEN** 它收到现有 `effectId`，且不发生另一次 dispatch

#### Scenario: Host 证明在 claim 后变化

- **WHEN** claim 有效，但其 `effect-dispatch` attestation 在 dispatch CAS 前过期或被取代
- **THEN** 不发生 `dispatch-started` fact 或 external invocation，并由 typed local dispatch result 记录拒绝

#### Scenario: 一个 Effect 请求多个 operation

- **WHEN** intent 或 claim 包含超过一个 external operation
- **THEN** validation 在 policy 或 dispatch 前拒绝它，并要求独立的 Effect identity

#### Scenario: Receipt authority 过期

- **WHEN** receipt 或 reconciliation observation 提供过期、撤销或不匹配的 authority generation，或省略其 proof reference
- **THEN** fact admission 拒绝它，且不改变 ExternalOutcome 或 reconciliation

#### Scenario: Receipt 在没有持久化 dispatch 时到达

- **WHEN** connector 为从未提交 `dispatch-started` 的 claim 提交 receipt
- **THEN** receipt admission 拒绝它；pre-dispatch denial 被记录为 local dispatch result，而不是 external receipt

#### Scenario: Owner handoff 遇到 unresolved Effect

- **WHEN** Effect 为 `unknown` 或 reconciliation 为 `unresolved`
- **THEN** reconciliation ownership 只能在 storage CAS fence 下移动，production promotion 仍被阻止

#### Scenario: 冲突 receipt 到达

- **WHEN** 后到达的 authenticated receipt 与 authoritative receipt 冲突
- **THEN** 它成为 append-only conflict observation，reconciliation 变为 `unresolved`，且不发生 redispatch

#### Scenario: 已声明 conflict authority 解析全部证据

- **WHEN** sink 声明的 conflict-resolution authority 在 reconciliation CAS 下绑定完整不可变 conflict set，并证明一个 final outcome
- **THEN** 一个 reconciliation fact 在不删除任一 receipt 的情况下记录 committed 或 not-committed；否则 Effect 保持 unresolved

#### Scenario: 矛盾在 final outcome 后到达

- **WHEN** authenticated contradictory evidence 在 committed 或 not-committed 成为 final 后到达
- **THEN** 一个 atomic safety transition 追加 `PostFinalConflict`、重新打开 Effect、quarantine 其 Activation、撤销 mutation authority，且不允许 redispatch

#### Scenario: Committed Effect 后发生 domain failure

- **WHEN** external receipt 已 committed，但 domain reconciliation 失败
- **THEN** receipt 保持不可变，retry Run 不能 redispatch Effect

#### Scenario: Unknown 在没有 receipt 时被证明未 committed

- **WHEN** authenticated reconciliation 证明先前 unknown dispatch 未 commit，且不存在 connector receipt
- **THEN** final `resolved-not-committed` fact 将 ExternalOutcome 设为 not-committed，并在不伪造 receipt 的情况下满足旧 generation

#### Scenario: 再次尝试已解析为 not-committed 的 Effect

- **WHEN** Harness 在 generation N 解析为 not committed 后，针对相同 Run/intent key 显式提交 generation N+1
- **THEN** generation N+1 获得新的 Effect identity，并重复 authority、policy 和 Approval check

### Requirement: 可信直接 Effect 默认拒绝

**Requirement ID:** `v2c.direct-effect` SHALL 是本需求的稳定标识。

gateway 外的每项 direct mutation authority SHALL 是逐项列出的 `trusted-direct-effects` 例外，将 inventory reference、sink、精确 operation、authorization capability 和 justification 绑定进 release identity。Enforcement MUST 在 operation level 运作。authorization 可以执行 mutation 的 read path SHALL 被视为 mutation-capable，除非 broker 或 read-only authorization 证明并非如此。未列出的 mutation operation MUST 不可达。无法由 broker 或 authorization boundary 强制精确 operation boundary 的 sink MUST 被拒绝；enumeration 或 exception itemization 不能替代 enforcement。

M0/M1 production eligibility 要求 `trusted-direct-effects` list 为空。非空 entry 只能存在于 pinned read-only v0 inventory 或明确 mutation-disabled fixture 中；它们不能使 Activation 转为 `active`、接收 mutation grant 或满足 production restore。后续阶段只有通过先前具有 named consumer、per-operation durable request identity、outcome/reconciliation 和 recovery semantics 的 SOT/OpenSpec change，才可允许 production direct mutation；tenant integration change MUST NOT 放宽此 gate。每个 onboarding gate SHALL 仍固定 before/after inventory revision 和 count，且 after count MUST NOT 超过 before。Shadow/evaluator launch SHALL 移除 gateway grant、direct exception、mutation-capable credential 和仍存活的 mutation-capable child access。

#### Scenario: 共享 endpoint 暴露未列出的 mutation

- **WHEN** 允许的 read destination 使用也可调用未列出 mutation 的 credential
- **THEN** launch 或 mediation 拒绝它，除非该 mutation capability 已逐项列出，且 enforceable boundary 将 credential 限制在精确列出的 operation

#### Scenario: Direct exception 缺少 operation 证据

- **WHEN** exception 指定 sink，但没有精确 operation set 或 enforceable authorization boundary
- **THEN** release validation 拒绝它；列出每个表面 operation 也无法让不可强制的 sink 具备 production eligibility

#### Scenario: M0 或 M1 release 声明 direct exception

- **WHEN** Activation 在 M0/M1 profile 下以非空 `trusted-direct-effects` list 请求 production
- **THEN** promotion 被拒绝，该 entry 保持仅供 inventory 使用且没有 mutation authority

### Requirement: 类型化错误代数

**Requirement ID:** `v2c.errors` SHALL 是本需求的稳定标识。

契约 SHALL 为每个 invalid command 或 boundary failure 分配 stable domain-neutral error kind、封闭 retryability 和版本化 safe-message template。其他 owner 使用的每个 typed literal——包括 schedule unsupported、idempotency/terminal conflict、stale state/epoch/generation 和 `recovery_in_progress`——MUST 是该 manifest 的 member，而不是 storage-local invention。每个 error kind SHALL 要么不拥有 detail，要么拥有一个封闭 `detailSchemaId + detailSchemaVersion`；允许时，message-template parameter SHALL 是同一 schema 的 field。每个 detail field MUST 使用 `v2c.durable-data` class，并且对于 `safe-text` 使用精确 sanitizer/version 和正数 byte bound。未知 kind/schema/field、raw provider text、internal stack、host path 或 sensitive material SHALL 在 client serialization 前被拒绝。Usage error SHALL 与 operational failure 和 success 保持可区分。

#### Scenario: Adapter failure 包含内部 detail

- **WHEN** adapter error 包含 sensitive material、stack 或 host path
- **THEN** client 只看到 stable kind、versioned safe message 和 declared sanitized detail

#### Scenario: Error 发出未声明 detail

- **WHEN** error producer 添加该 kind 封闭 schema 中不存在的 detail field 或 message parameter
- **THEN** serialization 拒绝它，而不是转发该值或静默将其字符串化

### Requirement: 完整 HarnessRequest 与受限执行边界

**Requirement ID:** `v2c.runtime-boundary` SHALL 是本需求的稳定标识。

HarnessRequest SHALL 携带 Release、Activation epoch、Run、RunAttempt 和 HarnessSession identity；release 声明的 goal/trigger input、context artifact ref 和可选 CheckpointRef；budget；deadline；AbortSignal；以及显式 RuntimeGrant。Boundary validation SHALL 拒绝 release 封闭 Harness input/context schema 之外的字段，并在任何 observation 前应用 `v2c.durable-data`。每个 capability、SecretRef handle 和 ToolDescriptor SHALL 由 context-bound grant 表示，绑定 release、epoch、Run、RunAttempt、HarnessSession、purpose、精确 operation、audience、issue/expiry、revocation generation 和 operation/request/byte budget。每次使用 SHALL 指定当前已注册的 `actionId` 并追加 effective grant digest；提供来自另一 context 的 grant 属于 replay，且 MUST 失败。只有 Effect dispatch claim 本质上是 single-use。SecretRef handle 不包含已解析值；ToolDescriptor 还绑定 provider id/revision 和 resource ref。

Model-driven Harness、deterministic Harness、provider/subagent child 和 legacy process adapter SHALL 在 `hangar-server` 外执行。Child launch SHALL 从空 environment 开始，只添加 release/profile allowlist 中的 non-sensitive key；使用 absolute verified executable 和 fixed work directory；关闭除明确列出的 stdio/broker handle 外每个 inherited file descriptor/OS handle；并在 Harness entrypoint 执行前进入 `v2c.process-lifecycle` containment。任何已解析 secret 都不通过 environment variable 传递。launch profile SHALL 使 control database file/path、control/admin socket、gateway connector authority、host store 和未声明 executable path 不可达。Runtime access SHALL 只能通过显式 broker/grant 发生。Positive probe MUST 验证 environment allowlisting、close-all descriptor behavior、control-plane isolation、grant/egress/ExecutionClosure rule 和 whole-tree containment。此边界不声称是完整的 untrusted-code sandbox。

child 执行前，RunAttempt source fact SHALL 记录实际解析的 Harness/runtime executable digest、adapter/runtime/model identity 和 version、host/containment profile、ExecutionClosure id 和 launch attestation id。Tool-use ActionEvent SHALL 记录实际 descriptor/provider/revision/operation 和所用 effective grant。仅有 declared identity 并非 observation。

#### Scenario: Grant 被另一个 attempt replay

- **WHEN** child 提交来自另一 epoch、Run、RunAttempt 或 HarnessSession 的 grant
- **THEN** broker 拒绝它并记录 typed capability failure

#### Scenario: Context 包含未声明字段

- **WHEN** HarnessRequest goal/input/context 包含 release 声明 Harness schema 之外的字段
- **THEN** boundary validation 在 child 可观察该字段前拒绝 launch

#### Scenario: Tool 使用省略 action 归因

- **WHEN** Harness 在没有当前已注册 actionId 或 effective grant digest 的情况下调用 brokered tool
- **THEN** broker 拒绝使用，且不追加 successful tool observation

#### Scenario: Child 继承 host environment 或 descriptor

- **WHEN** launch inspection 发现 non-allowlisted environment key 或未列出的 inherited descriptor/handle
- **THEN** launch 在 child 执行前失败

#### Scenario: 实际 runtime 与声明不同

- **WHEN** 解析的 Harness、runtime、model、adapter、closure 或 tool provider 不同于 declared/pinned identity
- **THEN** invocation 按默认拒绝失败，且不把虚假的 declared identity 记录为 actual

#### Scenario: Child 可以访问 control storage

- **WHEN** launch probe 可以打开 control database path、inherited descriptor 或 control socket
- **THEN** 所请求 launch mode 在 child 执行前无法通过 host qualification

#### Scenario: 缺少必需 HarnessRequest 字段

- **WHEN** invocation 缺少 identity、context ref、budget、deadline、AbortSignal 或 complete grant
- **THEN** boundary validation 在 child 执行前拒绝它

### Requirement: 目标宿主证明与激活语义

**Requirement ID:** `v2c.host-attestation` SHALL 是本需求的稳定标识。

`v2c.core-objects` 引用的 static host declaration SHALL 只包含 required host-profile id/digest、DESIGN §6.1 的四个 control id、每个 control 的 mechanism 与 positive-probe definition，以及封闭 attestation mode `production-control`、`production-child`、`effect-dispatch`、`recovery-control` 和 `mutation-disabled-evaluator` 的一个子集。未知 mode 被拒绝。当前 result SHALL 单独存储为 append-only `LaunchAttestation` source fact。

Control boundary 内的可信 launcher/verifier SHALL 是唯一允许追加 `verified` 的 producer。Storage SHALL 发出一次性的 `launchAttemptId` 和不可预测的 challenge，绑定 host identity measurement、OS/architecture/version、boot/startup-cycle id、enforcement-profile digest、精确 attestation mode，以及对于 child 的 release/epoch/run/RunAttempt/containment identity。每个 `(host, profile, mode, startupCycle)` SHALL 有单调递增的 attestation generation。verified fact SHALL 根据 `v2c.time` 绑定 generation、issue time 和 expiry；任何后续 probe failure、profile/control/containment drift 或 unsupported observation SHALL 推进 generation 并追加 invalidating status。verifier SHALL 运行每个 mode-applicable control probe，包括适用时的 whole-tree containment/reap，绑定各个 outcome，并使用 host-verifier key 对 canonical evidence 签名或计算 MAC，该 key 的 public identity/version 固定在 child 外。Storage SHALL 以原子方式验证 producer、challenge、signature、精确 host/profile/mode/generation binding 和 one-time challenge consumption。child 和 HarnessAdapter 不能追加或提升 status。Status SHALL 为 `verified`、`unverified-claim` 或 `unsupported`；它 MUST NOT 修改 release content。

每个 production-active transaction、admission 或 clean-restart continuation SHALL 比较并绑定最新的 `production-control` generation 和 expiry。每次 production child launch SHALL 创建新的 `production-child` attempt 并重新运行 probe。每次 Effect dispatch CAS SHALL 比较并绑定最新且未过期的 `effect-dispatch` generation。Recovery MAY 使用 `recovery-control`；明确 mutation-disabled 的 M0/shadow/fixture execution MAY 使用记录了 `unverified-claim` 且结构性缺失每个 mutation grant 的 `mutation-disabled-evaluator`。Replay、duplicate challenge、stale cycle、expired/superseded generation、partial probe set 或未列出/非精确 host 对其 requested mode 按默认拒绝失败。

#### Scenario: Production 尝试复用过期证明

- **WHEN** release 在较早 startup cycle 中已 verified，但当前 probe 缺失或失败
- **THEN** production activation 和 mutation-capable launch 被拒绝，且不改变 release identity

#### Scenario: Mutation-disabled evaluator 使用未验证 host

- **WHEN** 明确归因于 evaluator 的 launch 具有当前 `unverified-claim`
- **THEN** 它只能在记录该 marker 且缺失所有 mutation authority 时运行

#### Scenario: Target host 未列出

- **WHEN** host 没有精确 target-manifest entry
- **THEN** 它为 `unsupported`，且不能继承另一 host 的证据

#### Scenario: Child replay 先前 attestation

- **WHEN** attestation challenge 已被消费，或属于另一 boot、profile、mode 或 launch attempt
- **THEN** storage 拒绝它，production qualification 保持不变

#### Scenario: Probe set 不完整

- **WHEN** 可信 verifier 省略任何适用的 DESIGN §6.1 control outcome
- **THEN** 它无法为该 launch mode 追加 `verified`

#### Scenario: 同一 cycle 的 failure 取代 verification

- **WHEN** 较新的 probe failure 或 profile drift 在 critical commit 前推进相同 host/profile/mode generation
- **THEN** 较旧的 verified attestation 不能授权 activation、admission、child launch 或 Effect dispatch

### Requirement: 有序 RunAttempt 与动作健康事实

**Requirement ID:** `v2c.health-facts` SHALL 是本需求的稳定标识。

每个 RunAttempt SHALL 恰有一个 terminal health outcome。invocation 前，声明的 empty-input、dedup 或 policy decision MAY 发出不含 `invoked` 的 terminal `skipped(reason)`；invocation 前的 cancellation、deadline、spawn 或 boundary failure SHALL 发出不含 `invoked` 的 terminal `failed(error)`。如果 Harness execution 开始，`invoked` SHALL 恰好发生一次且最先发生，随后是 terminal `produced(count >= 1)`、successful zero-result path 的 `skipped(reason)`，或 `failed(error)`。`degraded(reason)` MAY 仅在 invocation 后、terminal outcome 前发生一次。Release MAY 声明 named action/tool health subject；每个 subject 使用相同有序 fact vocabulary，并绑定其 actionId。Release assertion SHALL 区分 liveness、readiness 和 outcome。

#### Scenario: Empty input 在 Harness launch 前跳过

- **WHEN** 声明的 precondition 证明没有需要 Harness execution 的 input
- **THEN** RunAttempt 记录一个 pre-invocation `skipped(reason)`，且没有 `invoked`

#### Scenario: Spawn 在 invocation 前失败

- **WHEN** child spawn、containment 或 boundary setup 失败
- **THEN** RunAttempt 记录一个 pre-invocation `failed(error)`，且没有 `invoked`

#### Scenario: 已调用 source 返回零项

- **WHEN** Harness source 成功运行但未返回 domain item
- **THEN** 它先记录 `invoked`，再记录 terminal `skipped(reason)`

#### Scenario: 多个 terminal health outcome 到达

- **WHEN** RunAttempt 或已声明 action health subject 已有 terminal health outcome
- **THEN** 另一个 produced、skipped 或 failed outcome 作为 protocol failure 被拒绝

### Requirement: 类型化控制边界所有权

**Requirement ID:** `v2c.control-boundary` SHALL 是本需求的稳定标识。

M0 SHALL 定义由未来 client 共享的 AuthorityContext、canonical command identity、payload digest、release/epoch precondition 和 error envelope，而不定义 HTTP route 或第二个 write API。可信 Control boundary SHALL 还拥有 read authorization。projection-family manifest SHALL 恰好包含 `agent`、`release`、`activation`、`run`、`attempt`、`event`、`approval`、`effect`、`health`、`recovery` 和 `command-result`；未知 family 在 M0 中要求 versioned requirement change，并按默认拒绝失败。每个 family SHALL 有封闭 required-scope set，应用 `v2c.durable-data` field minimization，对未知 view/scope 默认拒绝，并记录所用 policy version。Client MUST 最终使用该 boundary，且 MUST NOT 拥有 storage、outer retry、Effect 或 terminal state machine。

#### Scenario: Candidate client 直接写入 storage

- **WHEN** candidate client 通过修改 SQLite 或 Agent file 执行 command
- **THEN** 它不符合 control-boundary contract

#### Scenario: 请求未知 projection family

- **WHEN** manifest 或 client 请求封闭 M0 set 之外的 projection family
- **THEN** read authorization 拒绝它，而不是动态推导 scope rule
