## Why

`M1-DENOM-001` 把通用 M0 definition universe 误当成 Heartbeat 阶段出口，导致一个已通过真实 package、fresh SQLite 与 process review 的窄切片被 534 项跨阶段义务阻塞。现在需要恢复单一真相源：M1 的语义验收只由 `m1-heartbeat-runtime` requirements 决定，M0 继续是 non-authorizing advisory。

## What Changes

- `M0-SOURCE-TIMEOUT-001`前置已由归档change`2026-08-23-fix-m0-source-timeout-fail-fast`闭合：focused source-pins 3/3、完整M0 226/226且fresh CR/RC均APPROVE；10秒阈值未修改，本change可以开始apply。
- **BREAKING**：移除“M1 阶段验收必须从整个 M0 bundle 推导 scenario/dimension/race aggregate denominator”的要求；M0 definitions 不再自动成为任何阶段的验收分母。
- M1 Heartbeat 的唯一语义 SOT 是其 OpenSpec requirements/scenarios；既有公开 API、fresh SQLite 与真实 process 测试只提供可执行证据，不另建 profile、mapping registry、receipt protocol、validator 或第二状态机。
- M1 stage acceptance 与 candidate/production qualification 分离：前者可在 scoped requirements、strict validation、fresh CR+RC 和真实 observation 全部通过后关闭 6.1/6.2；后两者仍保持 false，Darwin whole-tree 与 fsync 等限制不变。
- M0 仍保留冻结 definitions、known gaps 与 `M0 advisory: READY` diagnostics，但 token、fixture、TAP、digest 或 receipt 仍不得给 M1 补票。
- 同步 DESIGN、ROADMAP、CLAUDE、`openspec/config.yaml`、`define-v2-control-contracts`、`implement-m1-heartbeat-v2`与`add-mastra-harness-candidate`的相关planning artifacts/tasks/specs，以及精简evidence；不修改产品代码、测试实现或 SQLite schema。已完成但未归档的旧change必须先消除旧语义，避免后续archive重新写回。
- 非目标：不执行 534 项、不恢复 M0 authority、不启动 M2 实现、不新增 dependency/daemon/DSL/public evidence API。
- 回滚：实施前按tasks列出的精确路径在仓外保存每个文件的原始字节及`absent`标记（干净工作树可用专用提交，脏工作树不得整树回退）；任何终态检查失败时，对主`m0-evaluation-oracles`、DESIGN/ROADMAP/CLAUDE、`openspec/config.yaml`、三个相关changes与evidence逐文件恢复，并保持原 `M1-DENOM-001` blocked disposition。已完成 M1 observation 仍保留且不降格为 production evidence。
- 止损：若实施需要新增 machine registry、scenario-to-test 映射、通用 evaluator、第二套 acceptance runner，立即停止并保持 observation-not-conformance。

不变量检查：

- 单一 owner：不改变 Control/Harness/Effect/process/restore runtime owner。
- Event truth：阶段验收只读取真实 facts/process observations，不让 evidence 文档或 projection 成为执行 authority。
- Effect Gateway：unknown/committed Effect 规则不变。
- Typed API：不新增 client/API；M2 仍按后续 change 实现。
- No dual write：不触及 v0/v2 数据写路径。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `m0-evaluation-oracles`: M0 definitions 只在后续候选 spec 显式采用时提供 evaluator universe，不再自动成为 M1 Heartbeat 阶段验收分母。

## Impact

- 规划/SOT：`DESIGN.md`、`ROADMAP.md`、`CLAUDE.md`、`openspec/config.yaml`，以及`define-v2-control-contracts`、`implement-m1-heartbeat-v2`和`add-mastra-harness-candidate`的相关proposal/design/spec/tasks。
- OpenSpec：修改 `m0-evaluation-oracles` 的 candidate applicability requirement，并以 M1 runtime spec 作为 Heartbeat stage acceptance 的唯一语义来源。
- Evidence/M0 advisory metadata：保留 executable test command、限制和informational measurements；不手抄断言结果或review agent清单。SOT字节变化只更新既有`oracles/m0/sources.json`与`output-manifest.json` owner数据，不新增清单或consumer。
- 代码/API/依赖/部署/TCO：无运行时代码、API、dependency、daemon 或部署变化；本 change 的 glue 与 12 个月运行 TCO 均为 0。
