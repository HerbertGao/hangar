## Why

M0 已明确降为 `NON-AUTHORIZING ADVISORY`，不能再以 validator、fixture、receipt 或 token 阻断/授权 M1。现在需要一个独立、可审查的 M1 entry change，把真实 `packages/contracts → control-core → control-store-sqlite → Harness/process` 纵向切片及其安全失败义务冻结。用户已授权 bounded D1–D3 清理，并授权 entry review 通过后实施该切片；该授权不绕过 entry gate。

## What Changes

- 服务 ROADMAP M1：建立不可变 Heartbeat AgentRelease、单一 Control lifecycle、SQLite durable facts/projections、fake/legacy Harness 与最小 Effect wait/resume/terminal 闭环。
- **BREAKING**：M0 输出、fixture、receipt、`M0 contracts: PASS`、`M0 bundle: PASS` 与 `M0 advisory: READY` 均不构成 M1 conformance 或 implementation authorization；actual evidence 只能来自真实公开 package API、fresh SQLite 与真实 process observation。
- Entry 在首行 M1 code 前必须通过：
  - known-gap ledger 完整、无静默豁免；
  - admission、outer retry、terminal、Effect commit、durable wait、whole-tree reap、restore authority 每项恰有一个 owner；
  - 禁止 client/Harness/M0 advisory/projection/v0 直接写 Control state；
  - M0+M1 累计预算与 day-3 observation checkpoint/day-15 abstraction-cut trigger 明确；
  - happy path、nonzero exit/reap、ambiguous Effect、checkpoint resume、projection rebuild、stale/competing restore 的真实 observation/failure obligations 可执行。
- Fake child 与 legacy-process HarnessAdapter 必须经相同 contracts/events 和 lifecycle owners；legacy adapter仅映射 deterministic CLI stdout/exit，不读取 M0 token、不写 v0/Control SQLite。
- Facts/projection authoritative bundle原子提交：commit前crash只能留下none或完整bundle；commit后ack-loss必须reopen完整bundle且同命令重放不重复。Projection rebuild通过提交后删除disposable projection单独证明。
- Entry review 前执行 bounded D1–D3 清理：删除 M0 code/tests 对 OpenSpec版本、文件内容和活动 change布局的解析/断言，OpenSpec只保留为独立strict external gate；把 abandoned I1/Q3 明细压缩为稳定摘要；路径/计数只保留一个冻结 owner。不得用动态遍历缩减 41/244/233/88/565 分母，也不得删除 known-gap/stop-loss 历史。
- 用户已明确授权 entry 通过后实施 M1；Entry PASS 只激活既有实施授权，不等于 M1、candidate 或 production qualification。
- 保留 unknown outcome、restore fencing、AttemptQuiesced、no-dual-write 和单一 terminal choke point；任何失败均不能由 M0 补票。
- 不实现 scheduler、Pi、HTTP/SSE、Web/client、Knowledge、Suggestion/AgentIntent、租户迁移、通用 ProcessSpec、public evidence protocol 或 daemon。
- 回滚：M1 尚未接触生产/v0 数据；删除新 packages/tests 和 disposable v2 DB 即可回退，M0 advisory/known gaps 保留。
- 止损：entry 超过 1 active developer-day、重复/遗漏 owner、silent exemption、M0 补票或必须新增禁止构件时保持 implementation blocked；entry 后新增第 3 个主动开发日仍无独立 crash/restart observation则冻结扩 scope并复盘；累计第 15 日仍无 Heartbeat则删减 abstraction，不延长。

不变量检查：

- **单一 owner**：Control 拥有 admission、Run、outer RunAttempt/restart、durable wait、terminal；Effect Gateway 拥有 external commit；trusted launcher/Control process boundary 拥有 whole-tree reap；独立 RecoveryAuthority 拥有 restore fence。
- **event truth**：状态与 projection 只从 append-only facts 重建；projection 不授权下一动作。
- **Effect Gateway**：Harness 只提交 EffectIntent，不重试 unknown/committed Effect；高风险提交凭据不进入 Harness。
- **typed API**：M1 只建立 in-process TypeScript package contract；HTTP/SDK/OpenAPI 延后至 M2。
- **no dual write**：只写 disposable v2 SQLite；不写 v0 DB/gateway，不共享 v0 Run identity。

## Capabilities

### New Capabilities

- `m1-heartbeat-runtime`: Heartbeat v2 的 immutable release、Control/Harness package boundary、SQLite durable lifecycle、Effect wait/resume、process containment、restore/fault observations 与 entry/exit gates。

### Modified Capabilities

无。M0 Control/Storage/oracle definitions 作为引用输入，不由本 change 重写；任何契约缺口必须回到独立 change。

## Impact

- Entry 阶段先对 M0 advisory 做 bounded D1–D3 删除；随后实施范围为 `packages/contracts/`、`packages/control-core/`、`packages/control-store-sqlite/`、最小 Harness fixture 与 `tests/m1/`。Entry review 通过前不创建这些产品文件。
- 不新增 npm dependency、daemon、network service 或 production migration。
- 入口证据引用 `DESIGN.md`、`ROADMAP.md`、`define-v2-control-contracts` specs 和 M0 review known gaps；M0 advisory 零授权消费者。
- 成本：entry ≤1 active developer-day；entry后首份crash/restart observation已在M1第1日内完成；M0+entry+M1累计上界8日。
- Heartbeat stage acceptance的唯一语义SOT是本change的`m1-heartbeat-runtime`全部requirements/scenarios；M0 evaluator universe未被本stage采用。6.1/6.2只在逐项证据、固定checks与fresh CR+RC全部通过后关闭；stage closure不改变candidate/production qualification（均为false）。
