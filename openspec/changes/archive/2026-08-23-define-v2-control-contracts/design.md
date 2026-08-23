## Context

v2 分支已有 M0 contracts/oracles/tests 实现基线，但仍没有产品 runtime 或主规格。M0 必须把 Harness-first SOT 变成可由 M1、v0 adapter 和外部候选共同消费的契约，同时避免把 v0 四表、`PipelineExecutor`、静态 DAG、NodeAttempt、daemon 调度细节或领域模型固化为 v2 架构。

现有 Auto Developer 证明了一条可工作的边界：外层系统持有 trigger、权限、故障收敛与 gate，内部 orchestrator 持有 phase/session/watchdog、模型/传输 retry 和上下文推进。AgentScope 类框架也把推理循环放进 Harness，同时保留 permission、events、recovery 与 deterministic middleware；但完整 Agent Service 会与 Hangar 的 session/schedule/effect owner 重叠。因此 M0 冻结 provider-neutral Harness contract，不选择外部完整平台，也不建设通用 graph engine。

此前 artifacts 对 workflow/node identity 的详细设计尚未实现，且与现行 `DESIGN.md` 冲突。本修订保留已经加固的 authority/time/idempotency、Effect、host attestation、source-fact、restore 与 aggregate-gate 语义，只替换它们所绑定的执行身份。

初版 fixture execution 随后暴露出独立于这些 Control/Storage 契约的 E1 根因：runner 把共享测试文件 PASS、全局字符串存在和调用方自报 observation 当成 operation execution。bounded-witness、I1 authority root、Q3 verifier-owned gates 与 bounded-seam composite 依次关闭局部伪造路径，但 fresh review 仍连续在不同 scenario family 复现 claimed-literal false-green。完整性、授权与语义真值无法由尚无产品 runtime 的 M0 测试模型同时自证；继续补 gate 会把第二套 Control/SQLite/runtime 铸成 authority。最终裁决保留 41/244/233/88 definitions 与 diagnostics，删除 test-side semantic execution，并把 M0 明确降为 `NON-AUTHORIZING ADVISORY`；当前 verifier 的未闭合路径/measurement/formatting/test-discovery findings 进入 known-gap ledger，不再继续阻断 M1。只有≤1日entry artifact strict/review PASS才激活已记录的条件授权并开启M1，真实产品路径才拥有candidate conformance。

## Goals / Non-Goals

**Goals:**

- 产出版本化、机器可读且可审查的核心对象、闭合 taxonomy、状态转移、错误、存储和 oracle manifests。
- 固定 Control outer lifecycle、Harness inner progress、domain outcome 与 Effect/process owner 的无重叠边界。
- 使同一 evaluator 在不 import 候选内部常量的情况下评价 v0、M1 v2、Pi/外部 Harness 和完整外部平台。
- 为每个 terminal、illegal transition、checkpoint resume、overlapping retry、Effect unknown、whole-tree reap、命令重放和 cutover crash point给出唯一预期。
- 让 AgentRelease schema/canonicalization、authority 子边界、RunAttempt/action/checkpoint、Effect control/fact admission/handoff、host attestation、storage lineage/instance identity、recovery 与 aggregate validation 分别由稳定 Requirement ID 唯一拥有。
- 冻结每个scenario的稳定ID、owner、coverage/applicability与typed expected public observation；OpenSpec WHEN/THEN只由外部工具检查，真实candidate execution obligation仅在后续 candidate spec 显式采用本 bundle 时生效；M0 自身不声称语义 conformance。
- 在 M0 五日预算内给 M1 留下足够窄的 Harness Heartbeat 实现输入。

**Non-Goals:**

- 不创建 `packages/contracts` 或任何产品、Harness、store、API 实现。
- 不实现 compiler、SQLite、Pi、Control API、client、UI、Knowledge 或租户迁移。
- 不定义 workflow/node-kind/NodeAttempt、ProcessSpec、scheduler/misfire/catch-up、Suggestion Center、AgentIntent 或 capability directory 服务。
- 不复制 v0 四表、daemon、opaque pipeline 或领域状态。
- 不运行生产 Effect，不读取生产敏感值，不向 v0 DB 或相邻仓库写入。
- 不承诺完整不可信代码 sandbox；只冻结 DESIGN §6.1 的控制面隔离、whole-tree containment 及其勘验。
- 不为 direct mutation 建第二条状态机；M0/M1 production release 的 exception list 必须为空。
- 不为 candidate conformance 建通用 WHEN/THEN 解释器、counterexample engine、parent-reader DSL、public registry、签名 transcript 或第二套测试状态机。
- 不在 M0 运行或维护 244 个 test-side semantic gates；普通 M0 tests 只验证 bundle/validator 自身，不得冒充未来产品执行。

## Decisions

### 1. 每项语义只有一个稳定规范 owner

每个 normative requirement 自带不可复用的 `Requirement ID`；owner 是该 ID 所在的 spec 文件，标题只作显示文本。三个 namespace 固定职责：`v2c.*` 拥有 Control/Harness/Effect 语义，`v2s.*` 拥有持久化/恢复语义，`m0o.*` 只拥有 evaluator、fixture、inventory 与 measurement。跨 requirement、task、oracle 和 SOT 的引用必须使用 ID，不能复制正文建立第二 authority。

Authority validator 直接枚举三份 spec 的完整 ID 集合，要求每个 requirement 恰有一个全局唯一 ID、每个引用可解析、每个 machine-readable scenario 有稳定 ID 与唯一 outcome owner，并拒绝未入集合的手写 ledger 行。

### 2. RunAttempt 是外层执行与 retry 单位

Control Core 拥有 Run 与单调 RunAttempt identity、外层 restart、cancel、durable wait、terminal 和 top-level process containment。每个 RunAttempt 恰对应一个 attempt-bound HarnessSession。Harness 可以内部创建 provider session、phase、subagent 或逻辑 child，但这些不是 Hangar aggregate，也不能创建外层 Attempt 或 terminal。

Harness 只在同一 RunAttempt 内拥有声明过的模型、传输与可逆且未提交 action retry。Control 只有在旧 Attempt 已静默、完整进程树收敛、全部 Effect obligation 满足 owner contract 后才能开始下一 Attempt。Unknown 或 committed Effect 在两个 retry 域中都不可自动重提。

替代方案是保留 NodeAttempt 或粗粒度 ProcessSpec。拒绝原因：它们会让平台预先解释租户内部推进，并把 tenant phase identity 铸进存储；当前三个参考租户尚未证明正确恢复需要该 authority。

### 3. ActionEvent 与 checkpoint 负责透明度和恢复

HarnessRequest 绑定 Release、Activation epoch、Run、RunAttempt、目标/trigger、context artifact/checkpoint refs、预算、deadline、AbortSignal 与 context-bound RuntimeGrants。HarnessEvent 使用闭合 union；重要 action 至少有稳定 `actionId`、可选 `parentActionId`、kind、实际 runtime/tool identity、有效 grant digest、输入/输出 artifact refs 与 outcome。Action graph 仅由 source facts 投影，不能决定下一步。

Checkpoint 只保存 access-controlled artifact ref、schema/version、digest、producer RunAttempt/action 和所需恢复边界；任意会话正文、secret 或 continuation 不内联。Resume 总是由 Control 创建新 RunAttempt，并把 exact checkpoint ref 作为输入。Schema 不兼容、缺失 artifact、producer 不匹配或 unresolved Effect 都 fail closed。

Effect identity 改为稳定绑定 `(runId, intentKey, intentGeneration)`，并保存不可变 first-origin RunAttempt/action。这样 checkpoint/retry 后的等价 replay 仍返回既有 Effect；新的外部尝试仍须显式提高 generation 并重复完整 policy/Approval。

### 4. immutable Release 与 Agent-owned mutable state 分离

AgentRelease 在 M0 只固定 Harness entry/ExecutionClosure、目标/指令、prompt/policy/approved skills、runtime/model constraints、required capability/operation、checkpoint schema、Effect/health/eval、knowledge descriptors 与 host profile。当前 activation、probe、Agent-owned mutable state、偏好/推断、checkpoint body 和 recovery evidence 不进入 release identity。

M0 只冻结“运行期不能静默改变 active Release”和 checkpoint artifact 边界。事实/观察/偏好如何写入长期 Workspace，以及对外 capability registration/schema/visibility，均等待具名消费者和后续 change；本 change 不预建字段、store 或 promotion service。

### 5. Process ownership 分成逻辑调度与 OS containment

Harness 拥有内部逻辑 session/phase/child 调度和优雅清理；Control 拥有顶层启动身份、cancel escalation、terminal convergence，以及在父死、超时或 cancel 时 hard-reap 完整进程树的 OS containment。只能回收 direct child 的候选不合格。

Restricted launch 继续要求空环境 allowlist、close-all descriptors、control/gateway path 不可达、ExecutionClosure enforcement 和 RunAttempt-bound grants。Host attestation 的 `production-child` 绑定改为 release/epoch/run/RunAttempt；provider session 不能自证 host status。

### 6. immutable declaration 与 mutable evidence 分离

AgentRelease 只固定执行声明和验证要求；启动周期、probe 结果、授权撤销与 recovery 证明是 append-only source facts，不进入 release identity。该分离避免重跑 probe 时修改已发布 release，也避免旧 release 复用旧验证结论。

### 7. Effect 与 recovery 保持独立事实 owner

`v2c.effect`/`v2c.direct-effect` 继续唯一决定 Effect 与 direct gate 控制语义；`v2s.sqlite` 唯一决定 database lineage 与 writable incarnation identity，`v2s.source-facts` 决定事实准入/顺序，`v2s.handoff` 决定 handoff/reconciliation transfer，`v2s.restore` 决定 source/target-bound production qualification。Restore init/abort/activate 使用普通 command/result path；RecoveryAuthority permit-binding CAS 仍是外部线性化点。

本修订只把 Effect origin、terminal 后拒绝新工作、runtime grant 与 process facts 从 node identity 改绑 RunAttempt/action identity，不放宽 policy、claim、receipt、unknown、conflict 或 restore gate。

### 8. 契约采用规范文档加机器可读 manifest

M0 在 `contracts/v2/` 产出 Markdown 状态表、SQL 与 JSON/YAML manifests，并用 Node.js 标准库编写只读 validator/tests。Markdown 解释理由，manifest 固定 schema revision、对象、taxonomy、转换、错误、来源摘要与预期。状态表从同一闭合 taxonomy 生成或逐项比对，不能由另一份手写清单自证穷尽。

直接建立 Zod package 会提前选择 M1 布局；只写 prose 又无法独立评价。两者均不采用。

### 9. Oracle 是 adapter-neutral 数据

每个 case 固定稳定 id、唯一 normative requirement、来源 revision/content hash、输入、公共 observation、唯一预期、适用候选和排除理由。覆盖类仍为 neutral-control-storage、evaluator-self-test、named-tenant、named-process-host，不能互相冒充。

新增固定 regression classes：outer/inner retry overlap、checkpoint producer/schema/resume、parent-linked ActionEvent、effective grant、Effect origin、whole-tree hard reap、external Harness state-store/owner duplication，以及 fault attribution denominator。每个注入 case 必须能定位 action、有效 grant、checkpoint、Effect 状态与恢复点；不可归因率大于 5% 或任何 owner/effect boundary violation 都阻断 M1。

### 10. 通用 ProcessSpec 以租户证据准入

M0 不保留 workflow escape hatch 或隐藏 node identity。M3 Inbox、M5 Auto Developer、M7 AI Radar 使用同一 fault/recovery 口径记录“是否需要平台解释内部依赖”。至少 2/3 证明没有平台级依赖状态就不能正确恢复时，才另开可选粗粒度 ProcessSpec change；该结果不自动恢复 universal graph primacy。

### 11. M0 输出边界固定

允许的实现输出只有 `contracts/v2/`、`oracles/m0/`、`measurements/`、`scripts/validate-m0.mjs` 和 `tests/m0/`。Versioned aggregate-gate manifest 必须闭合所有 Requirement/scenario、closed dimensions、subcommands 与 external validators；外部工具只经 typed adapter 聚合且 raw success text 不能成为第二 PASS。Validator 固定 prerequisites/source pins；缺失 typed fail fast，不下载替代品、不新增 package。

### 12. M0 只提供 non-authorizing advisory，M1+ 才拥有 candidate semantic evidence

M0 保留 41 个 Requirements、244 个 Scenarios、233 个 closed-dimension members、88 个 recovery-race cells、aggregate DAG、typed result precedence 与唯一 aggregate owner。原 565 个 execution bindings 改为 **definition denominator**：

- 244 scenario definitions 冻结稳定ID、唯一Requirement owner、标题、required coverage class、case、applicability与typed expected public observation；OpenSpec WHEN/THEN不复制进M0 code/data；
- 233 closed-dimension definitions 冻结 owner、封闭值集合、精确 JSON/SQLite/transition locus 与未来 consumer obligation；
- 88 recovery-race definitions 冻结 22×4 笛卡尔积、唯一 case、唯一 typed expected，结构性不适用仍是定义成员而非 skip；
- 合计 565，只证明定义缺失/重复/歧义/悬空引用/非法排除会 fail closed，不声称任一候选已经执行。

Aggregate-gate manifest 继续保留 11 个 local gates、1 个 external validator、41 个 Requirement gates 与上述 565 个规范成员，共 618 个 gates。Requirement/scenario/dimension/race 结果 basis 只能是 `definition`；`fixture`、`fixture+definition`、receipt、TAP、callback、claimed observation 或 test-file PASS 均不能进入 M0 成功判定。`executed=true` 只表示相应 bundle validation check 实际运行，不表示候选 operation 执行。

M0 删除 `fixture-plan.json`、Q3 policy digest/dispatcher、scenario gate groups、fixture runner、跨进程/parent receipt 与 test-side semantic execution。Validator 只从冻结 machine manifests、cases/expectations、closed contract loci 与 recovery-race typed contracts枚举41/244/233/88并聚合definition results；它不读取或解析OpenSpec Markdown/config/change layout。OpenSpec只由独立 `openspec-cn validate --specs --strict --json` external process检查。Manifest hash只作字节完整性元数据，不能定义合法policy；verifier constitution固定非OpenSpec prerequisite commands、coverage→fixture/schema/applicability/profile/exclusion tuple、21个dimension owner/locus、22×4 race unions、aggregate manifest唯一denominator、result fields/bases/token与measurement supersession rules。

现有 validator checks 可继续作为 diagnostics，但其 post-root-cause review 仍有 producer-selected output/test/planning paths、measurement type/ref closure、intrinsic poisoning 与 dynamic test discovery known gaps；本 change 不再以完成 hermetic compiler 为目标。CLI 只可输出精确 `M0 advisory: READY`，旧 `M0 contracts: PASS`/`M0 bundle: PASS` 均无效。该 token 不授权 handoff、implementation、production、candidate qualification 或“244 场景已成立”的声明。

普通 `tests/m0/*.test.mjs` 仍可执行 schema、canonicalization、DDL、SQLite constraint、process fixture、validator mutation 与 no-write checks，但它们只证明本仓库 artifact/validator 的内部一致性。测试 helper 不得成为 future candidate 的 transition、storage 或 business-outcome authority。

M1 Heartbeat change 才建立 `packages/contracts`、`control-core`、`control-store-sqlite` 与 fake/legacy Harness。其 stage acceptance 只服从自己的 OpenSpec requirements/scenarios；只有后续 candidate spec 显式采用本 M0 bundle 时，才需按 profile/applicability 执行 scenario/dimension/race obligations。任何 actual observation 仍只能来自公开 package API、fresh SQLite rows/facts、真实 process exit/containment 或重建 projection；M0 fixture/receipt/token不能补票。

显式采用本 bundle 的 candidate 测试可以用普通静态数据表关联 `scenarioId` 与产品调用，但不得引入 WHEN/THEN interpreter、generic evidence registry、公共 receipt protocol 或第二状态机。实际/expected 不能由同一产品函数生成；expected只来自冻结machine oracle definition，OpenSpec仅由外部工具检查，actual只来自真实产品公共边界。

I1 authority ledger、Q3 direct gates、policy roots、receipts、fixture-plan 与 bounded-seam composite measurements 保留为 superseded/historical evidence，说明为什么 test-side semantic authority 被撤销；它们不参与 runtime，也不能恢复为 M0/M1 PASS 输入。

非协商权衡：M0 PASS 不再证明任何实现满足 244 个场景。进入 M1 时仍存在尚未获得产品语义证据的定义，这是诚实且可见的缺口；若要求 M0 同时证明 candidate conformance，就只能继续维护第二套 test-side Control/SQLite/runtime，并重现已确认的 false-green。

## Risks / Trade-offs

- [没有预执行路径图] → 用 parent-linked action events、actual identity、grant/checkpoint/Effect refs 和 ≤5% opaque-attribution gate；需要平台内部依赖的租户证据触发 ProcessSpec change。
- [Checkpoint 质量不足导致重复内部工作] → schema/version/digest、producer binding、封闭 obligation kind/owner/generation 与不可分支 successor chain、explicit boundary 与 crash-after-every-boundary fixture；Effect identity 独立防重复外部提交。
- [两层 retry 重叠或 check-then-act] → closed owner manifest、AttemptQuiesced/containment/grant/obligation digest 的单事务消费；统一 fence 旧 Attempt 的全部派生写入/launch，只放行不可调度 late outcome/cleanup。
- [Harness 隐藏第二状态机] → adapter qualification 必须证明没有第二 Run/terminal/effect owner；完整外部 Service 只能替代 Hangar owner，不能叠加。
- [Whole-tree containment 在目标宿主不可证] → 每个宿主正向 probe；失败只允许运行 mutation-disabled evaluator/shadow。
- [ID 与未来实现漂移] → validator 枚举稳定 Requirement/Scenario IDs 与引用；缺失、重复或悬空引用直接失败。
- [穷尽表在五日内失控] → 只保留 Activation/Run/RunAttempt/Approval/Effect 与最小 Heartbeat；超预算即缩回最小链。
- [相邻仓库继续变化] → manifest 固定 revision/content hash，不读取浮动工作树替代。
- [只读检查产生 SQLite sidecar] → 使用副本或 immutable URI，并比较目录、mtime、size 与 sidecar。
- [恢复克隆复用可写身份] → 保留既有 databaseIdentity/controlInstanceId、exclusive continuation 与 independent RecoveryAuthority 契约。
- [恢复 binding 后 permit 过期或证据冲突卡死] → 不可变 BindingCertificate 固定普通决定，短期 permit 只为同一 command/current host generation 重签；authenticated outcome/Agent-binding conflict 只走 permit revoke + binding-invalidated 双阶段收口。
- [数据库级 controlInstance 被错误按 Agent 复制] → restore-init 只建一个 RecoverySession/target，并为完整 agent set 建独立 qualification/epoch；同库多 Agent fault fixture 验证。
- [Session init 与 abort 双赢或遗留 pending command] → 二者比较同一外部 generation，winner 本地事务终结自己与所有 loser command。
- [Recovery operation 跨 Agent 复用] → 认证 ownerAgentId + 外部 membership registry；归属冲突 fence 所有 consumer，跨 target 用本地 ack 或不可逆 TargetAuthorityClosed proof 收敛。
- [快照后外部操作缺少本地 dispatch] → 以不含冲突成员字段的稳定 discovery key 追加具封闭 outcome/reconciliation lifecycle 且不可 dispatch 的 RecoveryDiscoveredOperation，不伪造 Effect/receipt。
- [旧实例在恢复 fence 后注册新 authority] → 外部 registry 线性化 registration closure；先发生的注册进入 denominator，后发生的注册类型化拒绝。
- [候选排除困难用例] → owner 冻结完整 case universe/applicability predicate；required case 不可排除，执行后排除无效。
- [伞形恢复测试假绿] → 完整 recoveryRacePoint × disposition 笛卡尔积逐格绑定唯一 case/typed expected/required gate；结构性不适用也执行，不可 N/A/skip。
- [M0 diagnostics 被误读为产品资格] → token 固定为 `M0 advisory: READY` 且 scope 为 advisory-only；所有历史 PASS token无效，任何 M1 work 必须先通过独立 entry；PASS后才激活已记录的条件授权，candidate qualification 必须引用 M1+ execution report。
- [删除 test-side gates 后掩盖分母缩水] → aggregate 仍独立枚举 41/244/233/88 与 618 gates；565 个规范成员只能以 `definition` basis 通过，删除/重复/悬空任一成员均 non-pass。
- [阶段或candidate借用 M0 fixture 补票] → 未显式采用本 bundle 的阶段不消费其分母；显式采用的candidate tests也不import `tests/m0/scenario-gates*`、fixture runner或receipt，actual只来自公开 package、fresh SQLite、process与projection。
- [candidate一次承担过多尚未证明场景] → 只有candidate spec显式采用本 bundle时才冻结其适用分母；未采用阶段只按自身spec验收，不预生成execution registry。
- [旧 Q3 evidence 被重新启用] → I1/Q3/composite files 和 measurements 标为 superseded/historical-only；output manifest、validator imports 与 result schema 均不得引用其 authority/receipt 字段。

## Migration Plan

1. 固定 prerequisite executables、SOT、`main` 上 v0 denominator、Inbox、Auto Developer 与目标宿主来源。
2. 按 Requirement-ID owners 写 Release、Control/Harness、RunAttempt/action/checkpoint、process 与 Effect manifests。
3. 从这些 requirements 反推 DDL、事实顺序、事务、handoff 与 recovery 契约。
4. 写只引用稳定 Requirement/Scenario ID 的 adapter-neutral oracle、fixture、inventory、attribution 与 measurement manifests。
5. 保留 41/244/233/88 稳定 ID、cases、expectations、coverage/applicability、closed loci 与 race typed contracts；把 565 从 execution bindings 改为 definition denominator。
6. 删除 `fixture-plan.json`、Q3 policy/dispatcher/gate groups、fixture runner、receipt mint/consume 与 test-side semantic execution；I1/Q3/composite artifacts 只保留历史反证所需记录。
7. 保留 definition diagnostics 与 618-gate统计作为 advisory input，但不再把 verifier hermeticity设为 M1 前置；成功 token改为 `M0 advisory: READY`，scope固定 advisory-only，所有未闭合 review findings进入 known-gap ledger。
8. 删除或收窄依赖 Q3 的 tests，新增 definition-denominator mutation：41/244/233/88、coverage 分布与 565 total 独立计数，删除/重复任一成员 fail closed，aggregate 拒绝 `fixture`/receipt basis。
9. 刷新 result schema、evaluator registry、fault/aggregate/source/output manifests 与 append-only measurements；运行 M0 bundle、OpenSpec strict、no-write、SQLite bootstrap、LSP 和 fresh CR+RC review。
10. 创建独立 M1 entry change；其 ≤1 日 artifact 必须列出 known gaps、每项职责单 owner、禁止写边、累计预算与真实 obligations。Entry strict/review通过后激活已记录的 `USER-M1-AUTH-2026-08-22` 条件授权，不再等待第二次授权；M0 advisory不作为前置gate。

回滚只删除本 change 将来产生的 M0 artifacts；不涉及数据库迁移或运行 owner 切换。

## Open Questions

没有阻塞 M0 bundle migration 的开放产品决策。后续candidate的exact applicable execution denominator只在其spec显式采用本bundle时冻结；M1 Heartbeat stage按自身runtime spec验收。本 change 不实现产品或预生成execution registry。Schedule、Suggestion Center、Agent capability directory/AgentIntent分别由ROADMAP指定的具名后续change冻结；本change不预留其状态机或表。
