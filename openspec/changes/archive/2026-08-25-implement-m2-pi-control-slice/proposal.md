## Why

M1 已证明 `contracts → control-core → SQLite → Harness/process` 的内部 Heartbeat 闭环，但 Hangar 仍没有可替换的 Pi Harness、可信网络控制边界或两个真实客户端。ROADMAP M2 需要把同一套 Run/Effect 状态从进程内实现提升为可由 Web 与 Telegram 安全控制、并可由 fake/Pi adapter 替换的最小纵向切片。

## What Changes

- 服务 ROADMAP M2：现有 `add-mastra-harness-candidate` change必须在`harness-mastra` spike前完成并归档；Pi/API/client主线不等待可选spike，也不授权Mastra进入runtime。
- **BREAKING**：为不可变AgentRelease增加版本化intent descriptor/schema digest，并据此开放DESIGN §8 typed Control API；既有M1 fixture release按新版本重新编译，旧release bytes不被静默重解释。M2同时闭合M1实现偏离主spec的Effect identity：Harness不再提供`effectId`，Control在首次接受logical intent时创建并持久化全局唯一identity。M2 intent input只允许可durable保存的封闭control metadata；任意正文/runtime-only input在具备受控artifact-ref协议前typed拒绝。
- 建立Hangar自有HTTP/SSE Control API。八条`/v1` Control route及一个非Control的`POST /auth/session`共用同一Zod route registry、认证后的actor/delegation、command idempotency/precondition、类型化错误和最小化projection；client自报actor、raw SourceFact、secret、runtime-only input、内部路径或stack一律拒绝。
- 从同一 route registry导出 TypeScript SDK 类型/客户端与确定性 OpenAPI；不建立第二份手写 request/response schema或客户端业务状态机。
- 实现`harness-pi` reference adapter。Control启动Hangar-owned dedicated child，child只通过Pi公开SDK创建in-memory AgentSession、显式空resource loader与release-pinned内存虚拟仓库tools，并以版本化窄IPC向parent报告；business outcome只来自release声明的deterministic outcome tool artifact，经parent复算/验证后走既有domain gate；SDK prompt完成只表示本次Pi内部推进settled，不把session/retry/abort当成Hangar外层RunAttempt、Effect retry或terminal authority。直接Pi CLI RPC仅保留为固定版本兼容smoke，不作为运行adapter。
- 在相同 adapter boundary与fixture下执行最多1个active developer-day的受限 `harness-mastra` spike。禁止Mastra auto recovery、schedule owner、受控mutation approval/credential或完整Service并存；任一资格硬门失败即记录`retain-harness-pi`并不把Mastra dependency带入交付runtime。
- 建立v2 CLI facade、最小hangar-view Web client与Telegram Bot。Bot adapter不持mutation-capable Bot token；Gateway-owned Telegram connector持token、提供封闭inbound read port，所有outbound send/edit/callback走domain-neutral`control-command` Effect。三者的Control API操作只调用生成SDK；Telegram另注入唯一typed`TelegramGatewayPort`用于pollUpdates/requestDelivery/readDelivery，port由Gateway connector实现且不暴露token/mutation method；Web与Telegram对同一typed intent必须经过相同release、policy、Run、approval和audit路径。当前v2没有可迁移的tracked hangar-view源码，因此本change创建最小API client，而不是复制v0 CLI-subprocess/Inbox whitelist路径。
- M2认证范围固定为单用户部署：可信边界把服务端credential映射为principal；Web用bootstrap调用`POST /auth/session`，bootstrap generation天然绑定单一active session，ACK loss/page restart后重贴即可exact replay在同一header block设置HttpOnly session cookie与same-origin可读CSRF cookie；refresh从CSRF cookie恢复header，无需持久bootstrap；CLI使用独立bearer credential，Telegram adapter使用独立service principal加服务端allowlist/delegation映射。任何channel字段都不能成为可信actor claim。
- 使用两个Agent contract形成核心能力证据：中立Heartbeat与只读`repo-inspector`。后者只读取release-pinned、大小受限的虚拟regular-file corpus，不表达宿主path或live workspace。Fake/Pi分别编译adapter-specific immutable release（ExecutionClosure/harness identity不同），再比较相同intent contract与公共结果；Mastra spike只在通过候选前置硬门后跑同组fixture。
- 记录Pi与Mastra的glue LOC、T_ready、cold start、idle/peak RSS、disk/process count、部署形态、退出成本、许可证边界、self-host/managed差异与12个月TCO；缺证据不得以功能数量补分。
- 非目标：不实现M3 Inbox迁移、Suggestion Center、Knowledge、scheduler、Agent-to-Agent目录、生产多租户/RBAC、远程HA、完整不可信sandbox或生产级Darwin whole-tree资格；不让Web/Telegram/Pi/Mastra直接写SQLite/Agent文件或持有gateway业务提交凭据。
- 回滚：实施前仓外pin HEAD完整Git tree、clean/untracked基线与封闭planning/evidence保留allowlist；在临时副本从该tree恢复，除allowlist外逐路径/字节比较并拒绝额外untracked M2文件，再删除disposable数据并重跑M1。不能用声明子集、ad-hoc reverse edit或测试PASS代替完整树恢复。既有M1数据库字节不原地升级；M2只在disposable/versioned副本演进Effect schema，回滚恢复pinned M1 tree/database fixture，v0不变且不做生产dual-write。
- 止损：出现第二Control/Effect/process/restore owner、client direct write、unknown/committed Effect重提、无法验证Pi虚拟资源/credential/containment、SSE漏序或跨client误领审批时立即停止。M2 Pi/Web/Telegram验收只走mutation-disabled`shadow-evaluator` intent；Darwin/provider egress记录为read-only local observation与`unverified-claim`，不得外推production资格。M2累计10 active developer-days仍未过required出口时冻结扩scope，先删除Mastra spike和展示/CLI便利功能；不能删认证、幂等、fencing、reap、两个真实client共用路径或审计硬门，仍不闭合则停止且不进入M3。

不变量检查：

- **单一 owner**：API、SDK、Web、Telegram、Pi和Mastra都只是边界/adapter；Control继续拥有admission、RunAttempt、cancel/terminal与process，Effect Gateway继续唯一提交（含Telegram control-command delivery Effect），RecoveryAuthority继续唯一restore线性化。
- **event truth**：SSE和client view只投影committed facts；断线、重连或UI缓存不能创建下一动作authority。
- **Effect Gateway**：Pi/Mastra只可经release声明的mutation-disabled fixture tool提交固定disposable EffectIntent；approval decision经Control API进入现有gateway路径；Telegram outbound也经Gateway connector，候选与client不持业务/transport mutation credential。
- **typed API**：八条route、SDK与OpenAPI来自一个Zod registry；可信actor由服务端认证边界注入。
- **no dual write**：所有写入仍经Control command到独立v2 SQLite；legacy CLI只作版本化迁移oracle，不与v2同时拥有生产写权。

## Capabilities

### New Capabilities

- `m2-harness-adapters`: adapter-specific fake/Pi releases的公共可替换边界、隔离Pi SDK child与窄IPC、受限Mastra同fixture spike及adapter资格/成本证据。
- `m2-control-clients`: 生成SDK、v2 CLI、最小hangar-view与Telegram的共用命令/查询/事件/审批行为及channel身份隔离。

### Modified Capabilities

- `v2-control-contracts`: 增加版本化intent descriptor、DESIGN §8 HTTP/SSE routes、可信actor/SSE、durable cancel/Approval，以及复用同一Gateway lifecycle的domain-neutral`control-command` Effect。
- `v2-storage-contract`: 为run-action/control-command Effect subject增加互斥DDL、SourceFact、事务、projection与subject-specific PostFinalConflict与handoff边界（run-action可handoff；control-command旧reconciler保留至final、不转移），并对non-final control-command delivery restore fail closed。

## Impact

- 预计新增最小workspace/package manifest，以及 `packages/control-api`、`packages/control-sdk`、`packages/harness-pi`、`apps/hangar-server`、`apps/hangar-view`、`apps/telegram-bot` 与 `tests/m2`；现有 `packages/contracts`、`control-core`、`control-store-sqlite` 和Heartbeat fixture只做M2所需的公共query/command/adapter扩展。
- Runtime依赖只允许显式pin并审查的Zod 4与Pi coding-agent；HTTP/SSE和Telegram Bot API优先Node stdlib/native`fetch`。浏览器验收允许固定版本Playwright作为dev-only prerequisite并禁用自动browser download/install scripts；browser executable/version只作为每次验收环境prerequisite/evidence记录，缺失不得skip，但不进入仓内产品行为断言。不得自动批准npm install scripts；任何额外OpenAPI/client runtime依赖必须先证明Zod 4 JSON Schema与单一route registry不足。
- 当前v2无根package manifest、无tracked hangar-view源码；implementation必须先建立最小可复现workspace，不能导入现有忽略的`dist/node_modules`作为源码。
- `add-mastra-harness-candidate`保持独立能力owner；`v2-storage-contract`继续唯一拥有Effect subject持久化，本change不在client层复制delivery状态机；本change只消费其资格规则与产生spike实测，不复制candidate registry。
- M2 stage acceptance不等于candidate/production qualification；Darwin setsid/PID-reuse、power-loss/fsync、PITR与远程部署限制继续fail-closed。
