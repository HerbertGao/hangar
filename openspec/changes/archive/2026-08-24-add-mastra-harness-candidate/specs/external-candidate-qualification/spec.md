## ADDED Requirements

### Requirement: 外部候选名录记录口径

**Requirement ID:** `xcq.candidate-registry` SHALL 是本需求的稳定标识。

外部完整平台与 Harness 候选 SHALL 记录在 `docs/proposals/personal-agent-builder.md` §4/§6 的候选名录中，
每个候选 SHALL 绑定取证日期、可复核来源链接，以及每条能力判定的 `已实证 | 未查实` 标注。
「文档未提及」MUST NOT 被记为「不存在」；无法复核来源的判定 MUST 降级为 `未查实`。
`未查实` 项在 §6.3 排名中 SHALL 计 0；功能数量、社区规模、下载量或构筑速度 MUST NOT 用于补分。
名录 SHALL 在候选形态发生实质变化时重新取证，旧取证 SHALL 保留日期而不被静默覆盖。

#### Scenario: 候选形态已变但名录未更新

- **WHEN** 某候选已具备与 Hangar 目标形态重叠的 owner 级能力，而名录仍按旧形态记录
- **THEN** 名录被判定为存在覆盖缺口，必须重新取证并补入候选，不得以「名单已冻结」为由排除

#### Scenario: 以文档缺失推断能力不存在

- **WHEN** 某能力在候选官方文档中查不到
- **THEN** 该条记为 `未查实` 并进入待查清单，MUST NOT 记为该候选不具备该能力

#### Scenario: 用功能列表补硬门

- **WHEN** 候选在某项硬门缺证据，但在其它维度功能显著更多
- **THEN** 该硬门仍判定为缺证据计 0，加权排名不因功能数量改变淘汰结论

### Requirement: 外部候选接入时的 owner 边界

**Requirement ID:** `xcq.owner-boundary` SHALL 是本需求的稳定标识。

外部候选若进入实现，SHALL 只能是受边界约束的 Harness adapter 与可选 client/telemetry 依赖，
或**替代**对应 Control owner；MUST NOT 在 Hangar 之外并存第二套 session/schedule/effect 状态机。

对 Mastra，以下四项 SHALL 在接入时被拒绝：候选侧的自动恢复（`recovery.durableAgents: 'auto'` 一类
跨副本自恢复）；候选 schedules 作为 Hangar Agent 的 trigger owner；候选 tool approval 治理受控 mutation；
候选进程持有高风险业务提交凭据。外层恢复 SHALL 由 Control 的 RunAttempt 与 AttemptQuiesced 拥有；
trigger/admission SHALL 归 Control；受控 mutation 的审批与提交 SHALL 走 Approval 与 Effect Gateway；
高风险提交凭据 SHALL 只存在于 gateway。

候选 tool approval SHALL 只能治理 Harness 内部声明为可逆且未提交的 action。

#### Scenario: 候选自带跨副本自动恢复

- **WHEN** 接入配置启用候选侧的自动恢复，且候选不提供跨副本 lease/fencing
- **THEN** 接入被拒绝为双 owner，外层恢复必须由 Control 的 RunAttempt/AttemptQuiesced 拥有

#### Scenario: 候选调度器作为 trigger owner

- **WHEN** 候选的 cron/schedules 被配置为直接触发 Hangar Agent
- **THEN** 接入被拒绝，trigger 与 admission 必须由 Control 拥有

#### Scenario: 候选侧持有业务提交凭据

- **WHEN** 候选进程被授予推送、发信或代码发布一类高风险提交凭据
- **THEN** 接入被拒绝；该凭据只能存在于 Effect Gateway

#### Scenario: 采用候选的完整 Service

- **WHEN** 决定采用候选的完整 Service 承担 session、schedule 或 effect 语义
- **THEN** 对应 Hangar owner 必须被归档替代，MUST NOT 与候选并存

### Requirement: 候选资格赛前置与反向止损

**Requirement ID:** `xcq.qualification-gate` SHALL 是本需求的稳定标识。

候选进入任何实现前，SHALL 先通过 `docs/proposals/personal-agent-builder.md` §6.3 的七项透明控制硬门；
任一项不通过即淘汰，不进入加权排名。通过后，候选 adapter SHALL 与 `harness-pi` 执行同一组 fixture：
release identity、grant、effect-unknown、cancel/checkpoint、retry-owner、whole-tree reap。

候选评估 SHALL 记录 glue LOC、部署形态、退出成本、许可证边界、self-host 与托管形态的能力差，以及
12 个月 TCO；缺证据项计 0。候选评估 MUST NOT 向 `define-v2-control-contracts` 的冻结定义分母增删成员，
也 MUST NOT 新增 M0 aggregate gate。M1 期间 MUST NOT 引入自带恢复或调度 owner 的候选运行时。

若某候选同时具备跨副本 fencing 与单调 epoch 的外层恢复、带 claim/unknown/reconciliation 且不自动重提的
受控提交层、以及默认凭据剥离且可 hard-reap 完整进程树的子进程边界，则 SHALL 触发归档判定：
归档 Hangar 对应 runtime，并把 oracle 与契约迁入该候选的正式扩展边界。候选仅在功能面扩张
MUST NOT 触发该判定。

#### Scenario: 硬门缺证据但 fixture 表现良好

- **WHEN** 候选在 §6.3 某项硬门缺证据，却在 fixture 与构筑速度上领先
- **THEN** 候选在硬门阶段即淘汰，不进入加权排名

#### Scenario: 候选运行时在 M1 期间被引入

- **WHEN** 有人在 M1 heartbeat 闭环期间引入自带恢复或调度 owner 的候选运行时
- **THEN** 该引入被拒绝，理由是污染 M1 的 owner 边界判定

#### Scenario: 候选评估试图扩大 M0 分母

- **WHEN** 候选评估提出向 M0 冻结 bundle 增加 requirement、scenario、closed dimension 或 race cell
- **THEN** 该提议被拒绝，M0 成员数保持不变，新语义只能由具名后续 change 拥有

#### Scenario: 候选补齐三项能力

- **WHEN** 候选被实证同时具备跨副本 fencing、受控提交层与凭据剥离的子进程边界
- **THEN** 触发归档判定，Hangar 对应 runtime 归档并迁移 oracle 与契约，而不是继续并行自建
