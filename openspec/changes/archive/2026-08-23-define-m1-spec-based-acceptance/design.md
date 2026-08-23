## Context

参见 `proposal.md`。当前同时存在四层声明：M0 主 spec和已完成但未归档的`define-v2-control-contracts` delta都要求M1+默认消费冻结 evaluator universe，M1 runtime spec又定义了自己的窄Heartbeat obligations，而`M1-DENOM-001`将它们拼成跨阶段分母。M0已明确non-authorizing，因此默认扩张M1出口与该边界矛盾；若只修改主spec，旧change未来archive仍会把冲突写回；并行的`add-mastra-harness-candidate`还把`define-v2-control-contracts`零字节改动作为硬门，必须同步改为“成员/ID不变，仅允许本次opt-in语义修订”。

`M0-SOURCE-TIMEOUT-001`已由归档change`2026-08-23-fix-m0-source-timeout-fail-fast`以typed fail-fast闭合；focused/full M0与fresh CR/RC通过，既有10秒阈值保持不变。Apply前置已满足。

## Goals / Non-Goals

**Goals:**

- 让每个阶段的 OpenSpec requirements/scenarios 成为该阶段唯一语义验收 SOT。
- 让 M0 evaluator universe 变成 candidate spec 显式 opt-in，而不是默认继承。
- 在不新增 machine mapping 或 runner 的前提下关闭 M1 的 applicability blocker。
- 保持 stage acceptance、candidate qualification 与 production qualification 三者分离。

**Non-Goals:**

- 不修改 M1 runtime、SQLite schema、测试实现或 package API。
- 不证明 Darwin production containment、power-loss/fsync、PITR 或 534 项 aggregate conformance。
- 不恢复 M0 token/fixture/receipt 的授权力，不创建 M2 代码。

## Decisions

### 1. M0 evaluator universe 改为显式 opt-in

主 `m0-evaluation-oracles` spec 的完整 definition universe继续保留；只有后续 candidate spec 明确声明采用某个 M0 profile/applicability 时，该 universe 才成为该 candidate 的 qualification denominator。阶段 spec 未采用时，M0 不能自动扩大其出口。

替代方案“为 Heartbeat 新增一个有限 profile”被拒绝：它仍需第二份 case membership 与 mapping registry，并重新制造漂移。

### 2. M1 runtime spec 是 Heartbeat stage acceptance 的唯一语义来源

`implement-m1-heartbeat-v2/specs/m1-heartbeat-runtime/spec.md`中每条requirement/scenario均为required；不再建立scenario-to-test表。既有固定M1测试命令、public facts/rows/process observations、strict validation与fresh CR+RC只证明实现是否满足这些需求，不定义需求本身。最终CR+RC原始return必须逐条列出当前requirement/scenario的`satisfied | evidence-insufficient`及证据类别：运行时场景只能使用公开API/fresh SQLite/真实process；历史与治理场景优先使用原始review return；原文不可得时必须组合冻结review summary、stable approvalRef、burn ledger与对应制品，不能只靠agent ID或计数；反事实失败分支使用负向测试或可审查的fail-closed guard及其公共路径。每项还必须给出至少一个精确引用（test名、公开API/fact/process结果、guard路径或历史制品+approvalRef）。这是一次性review记录，不进入仓库成为维护型映射。任一遗漏或`evidence-insufficient`都阻止关闭6.1。

替代方案“把测试名或 evidence JSON提升为清单”被拒绝：测试和 evidence 都可变，不能成为第二真相源。

### 3. 直接重写6.1/6.2，而不是增加第三个验收阶段

- 6.1 验证 M1 spec 没有采用 M0 universe、M0 token消费者为零，并逐条确认每个 M1 requirement/scenario 已由现有公开 API、fresh SQLite 或真实 process 证据满足；任一证据不足即保持 `observation-not-conformance`。该确认不生成分母或scenario-to-test文件。
- 6.2 运行固定M1 suite、M0 advisory、strict OpenSpec、TypeScript/LSP、boundary/no-residue checks与fresh CR+RC，并记录轻量指标或明确的 `not-measured` 理由。
- 所有语义编辑、旧active change修订、主spec同步和检查完成后，先生成只包含checkbox变化的精确terminal patch。生成patch时同时冻结全部受影响SOT/config/changes、M1实现测试、evidence与burn ledger、`output-manifest.json.outputs`列出的全部M0验证输入、Mastra证据文档及patch本身的路径集合/SHA-256；最终review审查这些最终语义字节和该patch。APPROVE后必须先重验完整路径集合与每个SHA，再只按字节应用patch并复跑strict/diff-check，不再做语义编辑。此后才允许开始M2 planning；`candidateQualification`与`productionQualification`仍为false。

替代方案“保留6.1 blocked再新增6.3”被拒绝：会保留重复状态和无用流程。

### 4. Evidence 只保存指针与限制

`evidence/m1-heartbeat.json`只保留可执行命令、固定测试文件、限制与informational measurement状态，不保存stage acceptance状态；阶段状态仅由M1 tasks拥有。它不复制断言值、stdout hash、LOC、review agent ID或case coverage表，也不被产品代码消费。

## Risks / Trade-offs

- [失去通用M0矩阵对窄阶段的自动压力] → 只有candidate spec显式采用时才运行；M1 stage仍必须覆盖其自身所有requirements/scenarios。
- [人工review遗漏或误用证据类别] → final CR/RC原始return逐条列出当前requirement/scenario，并按运行时/历史治理/反事实三类使用上述允许证据；任何遗漏、类别不匹配或`evidence-insufficient`都不关闭任务；strict OpenSpec只负责结构，不冒充覆盖证明，也不以仓内registry解决review问题。
- [stage accepted被误写成production ready] → SOT、tasks与evidence同时保留candidate/production false和host/fsync限制。
- [主spec与active changes短暂不一致] → apply先在仓外保存tasks精确路径的原始字节/absent标记，再按“新delta+旧active change+SOT/M1/config编辑→sync主spec→checks→生成terminal checkbox patch→final review→按字节应用patch→strict/diff-check”的顺序执行；任一步失败即逐文件恢复并保留原blocked状态。

## Migration Plan

1. 按tasks精确路径在仓外保存原始字节与absent标记；修订`define-v2-control-contracts`旧delta及其相关制品，确保未来archive不会恢复旧默认分母；同步修订Mastra change的零改动约束但保持Requirement/scenario/member identity与数量不变。
2. 更新M1 active change的proposal/design/spec/tasks，删除`M1-DENOM-001`的默认分母语义并保留历史理由；同步更新DESIGN/ROADMAP/CLAUDE、`openspec/config.yaml`和无stage状态的evidence。
3. 将本change delta同步到主spec，使最终SOT字节先落地；仅更新既有M0 source/output manifest owner数据以反映SOT字节，并在此时重跑主M0/旧define/M1/Mastra的before/after身份比较，然后运行tasks中的固定检查命令。
4. 生成只含两个changes任务checkbox的精确terminal patch；final CR/RC逐条审查全部M1 requirements/scenarios、最终语义字节和该patch。
5. 最新review无blocker/major、无`evidence-insufficient`且该轮无修复后，按字节应用terminal patch并仅复跑strict/diff-check；失败则逐文件恢复并维持observation-not-conformance。
