## Context

参见 `proposal.md`。当前v2只有可执行TypeScript、M1 in-process Control API、fresh SQLite store和Heartbeat process fixture；没有根package manifest、网络server、wire schema、tracked hangar-view源码或client。`v2c.control-boundary`已冻结AuthorityContext、idempotency、error与projection family，但明确把HTTP route留给后续change。现有active `add-mastra-harness-candidate`拥有候选资格规则，仍为0/10，必须先完成，M2不得复制或绕过它。

Pi官方文档确认SDK的`session.prompt()`只在accepted run（含retry）完全结束后resolve，并允许显式ResourceLoader/customTools/in-memory session/settings；进程隔离不要求使用CLI RPC。Pi 0.84.2 package root同时public-export AgentSession SDK与typed RpcClient，`./client`另提供RemoteSession，直接RPC无需deep-import。但bounded smoke证明CLI RPC带`--no-*`仍暴露内建`llama`command，且RpcClient默认合并parent`process.env`、转发raw stderr并只signal direct child。因此M2选择专用SDK wrapper child：不是因为RPC不可用，而是为了显式空resource/custom tool、窄Hangar IPC、credential/fd/whole-tree owner与未来tool mediation。

## Goals / Non-Goals

**Goals:**

- 用一个route registry闭合HTTP/SSE、SDK与OpenAPI，不复制wire schema。
- 在现有Control/Store authority之上补齐intent admission、cancel、approval decision与授权read/event cursor seam。
- 让fake/Pi遵守相同HarnessSession contract，并用受限Mastra spike检验外部候选边界。
- 用新建的最小hangar-view与Telegram验证两个真实界面共享同一命令、审批、事件与审计路径。
- 保持M1全部故障/恢复证据可复跑，且M2新增依赖与成本可退出。

**Non-Goals:**

- 不实现通用Agent capability directory、Agent-to-Agent、scheduler、Suggestion、Knowledge、M3 Inbox或生产tenant迁移。
- 不给Pi/Mastra提供mutation credential、outer retry、terminal、restore或Control数据库访问。
- 不把M2 local slice描述为production containment、HA、power-loss或candidate qualification。
- 不迁移当前忽略的`dist/node_modules`，不复用v0 CLI subprocess或Inbox whitelist作为v2 client实现。

## Decisions

### 1. 先完成外部候选治理，再启动Mastra spike

`add-mastra-harness-candidate`必须在Mastra spike前apply、sync、strict review并archive；Pi/API/client主线不依赖它。M2 spike只读取其主`external-candidate-qualification` spec，不复制candidate registry、硬门或反向止损。Mastra spike最多1个active developer-day，使用与Pi相同fixture。硬门或任一required fixture失败即记录`retain-harness-pi`，删除spike依赖并继续Pi主线；不得为了完成M2降低门槛。

替代方案“边实现边补Mastra规则”被拒绝：会让被测候选参与定义自己的资格与owner边界。

### 2. 建立单根最小workspace，不拆服务仓库

新增private root`package.json`、`pnpm-workspace.yaml`与lockfile，只为可复现依赖和脚本；现有模块仍组成一个`hangar-server`进程。Runtime依赖限于固定版本Zod 4与`@earendil-works/pi-coding-agent`；浏览器验收允许固定版本Playwright作为dev-only prerequisite，并设置跳过browser download/install scripts；每次browser验收在仓外结果中记录实际executable realpath/family/version；不可用时hard fail而非skip，但不创建仓内browser版本manifest或把开发工具版本当产品行为断言。Pi官方安装支持`--ignore-scripts`，implementation不得自动批准任何npm lifecycle script；安装输出若要求额外脚本审批，暂停并报告。

HTTP/SSE与Telegram Bot API使用Node`http`和native`fetch`。Zod 4 JSON Schema加本地小型确定性generator生成OpenAPI与SDK；引入额外OpenAPI/client runtime framework前必须证明单一registry无法满足具体规范或测试。所有依赖先在隔离临时workspace执行`--ignore-scripts`安装、license/audit与最小smoke，失败不改变交付manifest/lock。Mastra包只允许进入隔离spike workspace，资格失败后不留在交付lock/runtime依赖。

替代方案“每个package单独manifest”和“先引入Web/Telegram framework”被拒绝：当前没有独立发布/伸缩需求，会扩大依赖和部署面。

### 3. Route registry是唯一wire owner

`packages/control-api`拥有封闭route registry。每项记录固定method、path template、auth mode、scope、request Zod schema、response Zod schema、typed error set、idempotency/precondition要求与projection policy。Generator从同一对象产生：

1. versioned OpenAPI JSON；
2. TypeScript wire types；
3. `packages/control-sdk`的typed methods与SSE decoder；
4. server router的method/path匹配表。

生成命令在干净树上运行两次必须字节相同；CI/测试生成到临时目录并与仓内artifact比较。Server和client不得手写第二份schema。Node HTTP listener先流式强制64 headers/单header8KiB/总32KiB/body64KiB及5s headers deadline及从headers-complete起算的10s first-byte/body-complete deadline，拒绝CL+TE、invalid/mismatch length和oversize chunked；通过后raw bytes再经duplicate-aware strict JSON parser（escape-equivalent key、UTF-8/surrogate/number/trailing-byte向量）并用`rawHeaders`拒绝case-insensitive重复安全header；之后才认证、Zod parse和command lookup/mutation。Response/event同样按schema重新解析和最小化。

### 4. Hangar server只组合owners，不成为第二状态机

`apps/hangar-server`是composition root：注入SQLite store、Control、Effect Gateway、trusted launcher、Authenticator和Control API。Handler只把已验证request转换为现有/新增Control command/query port；不得直接读取表或reduce raw facts决定transition。

M2对core/store的最小扩展：

- immutable release intent descriptors与active-release intent resolution；M2 input仅为可durable保存的control metadata，正文/runtime-only input在artifact-ref协议出现前拒绝；
- 闭合现有M1与主`v2c.effect`的偏差：从Harness EffectIntent移除`effectId`，由Control创建identity；并把同一Gateway lifecycle扩为`run-action | control-command` subject union，使Telegram delivery绑定Control interaction而不阻塞目标Agent Run；
- `control-store-sqlite`按subject kind强制互斥origin/fence字段、logical uniqueness、facts/transactions/effect projection、PostFinalConflict与handoff；control-command按connector/delegation/mapping generations fence而不伪造Activation epoch；M2用新schema version且只创建fresh/versioned副本，write-open M1 DB在sidecar/DDL前`migration_required`；restore遇到non-final control-command Effect整库fail closed，全部final时Agent restore可继续但Telegram connector仍disabled；Telegram adapter只看到Gateway port的sanitized DeliveryView；
- 由完整command identity在mutation前确定性派生runId；intent body显式选择shadow-evaluator或production。M2 stage只用shadow Activation/evaluator scope，零mutation-capable grant；production继续要求active+production-control attestation。Admission将control-metadata input、Run/Attempt facts、projection与command result原子提交；每个Attempt prompt再只由immutable release goal/instructions、该persisted input与versioned checkpoint/resource refs确定性生成并把digest绑定launch fact；
- list agents/releases、read run（含最小pending Approval projection）、read sanitized events since cursor、read health的授权query；
- 补齐主`v2s.command-results`已要求但M1尚未实现的持久safe rejection：符合资格的authorization/state/epoch/terminal rejection在response前完成，malformed/unauthenticated不注册；
- Control-owned cancel先原子提交`cancel-requested`、统一decision/claim/dispatch/launch/resume fence、全部open pre-dispatch Approval supersede/claim revoke/唯一`claim-revoked` local results与accepted result（既有denied/expired/revoked/transport-not-started保持no-op），使obligations在response前final；同一fence还阻止后到completion/outcome acceptance/非cancel terminal；再由restart-safe cleanup执行attempt abort、grant revoke与whole-tree reap；cancel前已dispatch的Effect若unknown/conflicted则cancel事务durably wake既有reconciliation obligation，gateway-owned restart scan/claim推进且不得test/client注入final；Run保持`cancel-pending-reconciliation`，全部真实reconciler final后才terminalize cancelled；
- pending Approval授权read/approved-or-denied decision使用TimeAuthority和Approval CAS；approved fact后的gateway wake/scan是durable owner obligation，client不负责续跑；
- commit后event notification仅用于唤醒SSE，durable replay始终从committed facts/projection读取。

Notification丢失只能增加到下一次heartbeat head reread的延迟，不能造成事实缺口。API不读取`evidence/`、OpenSpec或M0 token。

### 5. 单用户认证仍需可信边界

M2实现最小credential resolver，而不是RBAC：

- CLI：独立opaque bearer credential映射到principal/scope；
- Web：operator在登录/renewal表单手动粘贴bootstrap，JS仅在一次same-origin exchange的内存变量持有并立即清空DOM/引用，禁止URL/browser storage/history/service worker/log。`POST /auth/session`以establish以bootstrap generation标识；renew另绑定`X-Hangar-Session-Predecessor`中的signed sessionId/generation hint，并与same-origin绑定恰好一个active session；ACK loss/page restart后重贴同bootstrap返回stored exchange，不依赖browser保存key。成功header block同时设置HttpOnly`hangar_session`与可读`hangar_csrf`/signed`hangar_session_hint` cookies（均SameSite=Strict，非loopback强制Secure）及expiry/no-store，无body；refresh从CSRF cookie恢复`X-Hangar-CSRF`，不保存bootstrap。每bootstrap generation只允许一个active session：establish忽略ambient cookie generation；active replay返回existing，过期返回410+stored predecessor hint；只有显式renew+predecessor hint创建单调successor，同predecessor重放永远返回same successor；下一代必须用successor hint并失效旧cookie；revoked generation不可renew；每个write校验Origin与CSRF；
- Telegram：adapter持audience受限的Hangar Control service credential，但不持Bot token。Gateway-owned TelegramTransportConnector通过secret broker独占mutation-capable Bot token，向adapter只暴露typed port；pollUpdates为每项update返回raw update（仅channel-private store）和≤2KiB signed ref；稳定UpdateOccurrenceKey只由connector instance+service authority+updateId派生，raw/claims digest首次绑定、后到mismatch quarantine；adapter按signed claims选SDK route，Control独立验证claims/route/key；outbound send/edit/callback全走control-command Effect，unknown不自动retry；每个Control request的`X-Hangar-Channel-Context`只传该opaque ref，不传actor/scope/delegation。Server验证connector/service/update/chat/mapping/digest/expiry后，以service principal+allowlist/delegation解析represented subject并把ref digest绑定AuthorityContext/command；其他principal或旧mapping拒绝。

Authenticator使用与Control DB物理分离的最小SQLite auth store，事务保存bootstrap hash/ref+generation、session successor generation、sessionId、scope/expiry、HMAC key id/generation和safe exchange result，不存raw token。Cookie/CSRF从该versioned外部server-secret ref、sessionId、generation与purpose-separated HMAC确定性派生；旧key保留到所引用session/replay horizon结束，使restart/rotation后的exact replay仍返回相同headers，key缺失则fail closed。Credential只保存hash/ref与scope，不进入Release、fact、event、error或log。Auth session只拥有认证状态，不拥有Run/Approval/Effect。M2默认绑定loopback；非loopback启动要求显式TLS/secure-cookie配置，否则fail closed。

替代方案“localhost即认证”和“浏览器保存长期bearer token”被拒绝：两者都无法满足可信actor与泄漏边界。

### 6. SSE使用durable fact cursor而非内存序号

每个公开event投影绑定`runId + 全库唯一factSeq + eventKind + sanitized payload + policyVersion`，SSE`id`使用`1..9007199254740991`canonical safe-integer decimal factSeq；server/SDK拒绝sign/leading-zero/decimal/exponent/unsafe/overflow，store达到上限时新fact fail closed。连接流程先授权Run/cursor并subscribe commit notification，再读取durable head；所有初始reread与live notification进入单一serialized send cursor，按factSeq去重，从而关闭read/subscribe race。每个batch和不超过5,000ms的heartbeat timer先重验session/delegation/policy并重读durable head；notification永久丢失最多延迟到该timer。每batch最多128 events；慢client queue达到256 events或1MiB任一上限即关闭并要求用最后确认cursor重连，不丢弃durable fact。

提供cursor时先在全局fact index解析并验证aggregateId等于目标Run，再应用read authorization；另一Run/future/unknown/invisible统一`404 cursor_unavailable` envelope，只有malformed syntax为400。SSE断线不触发cancel。Heartbeat comment只维持transport，不成为event或liveness fact。未知/跨Run/不可见/未来cursor返回封闭typed error，不能通过从头回放泄漏存在性；authorization失效立即关闭stream。

### 7. Pi使用公开SDK专用child与Hangar窄IPC

`packages/harness-pi`由trusted launcher启动固定package版本的Hangar wrapper child；child通过Pi公开SDK创建AgentSession。它使用in-memory SessionManager/SettingsManager、显式空ResourceLoader、固定ModelRuntime和Hangar customTools，不运行CLI/RPC mode、不deep-import`dist/*`、不发现全局/项目skills/extensions/prompts/themes/context或内建slash command。

Child fd固定为ignored stdin、单一typed IPC与各64KiB上限的diagnostic stdout/stderr；只有IPC可改变adapter状态，raw pipes经safe-text/canary处理且secret/invalid/oversize触发reap，cleanup等待全部channel close。Child只接收release/attempt/prompt/abort与release-pinned virtual corpus的窄IPC，并只发送`ready`、`prompt-accepted`、sanitized action/tool lifecycle、bounded`fixture-effect-intent`/`outcome-artifact`、`settled`和typed fault。Release声明的deterministic outcome tool产生canonical safe bytes；parent复算digest/验证schema与tool lifecycle后才提交ToolObservation→OutcomeProposal。每个fixture/domain gate还必须从release-pinned input/corpus独立推导expected canonical artifact（不调用child tool实现）并逐字节/digest比较；通过后才accept outcome。Required artifact缺失/冲突/rejected在cleanup-complete后原子settle Attempt failed，并复用restart-safe Run-failure choke point。Assistant text/settled不构成business success。IPC union由Zod封闭、设字节上限；未知SDK event/message默认拒绝。`session.prompt()`resolve只使adapter进入draining；parent等待IPC/output close、完整process-group reap与grant revoke组成`cleanup-complete`后才报告技术终局。Prompt acceptance/settlement含糊时同一Attempt绝不重发。无valid checkpoint时M2在cleanup-complete事务先持久`attempt-settled(failed)`，再由restart-safe Control scan terminalize Run failed；cancel先线性化则cancelled、completion先terminal则completed、否则failed先赢，不调用要求checkpoint的quiesce/resume；仅已有valid checkpoint并满足AttemptQuiesced时允许显式Control resume。

M2不给模型任何host-filesystem operation。Heartbeat无文件tool；repo-inspector的read/list/search只查询release固定、规范排序、总字节/单文件受限的`{relativePath, bytes, digest}`regular-file Map。Corpus在release编译时拒绝absolute、`..`、重复、symlink/device/socket或digest漂移；child tool不import`node:fs`、不接收host path。Model/provider与单一audience credential由release policy/secret broker注入，其他environment/fd/HOME/Control DB/path剥离。Provider egress在当前Darwin host没有enforced sandbox时只记录目的地probe与`unverified-claim`；Pi资格标`fixture-readonly-reference`、`liveWorkspaceEligible=false`、`productionEligible=false`。

M2 Pi只运行adapter-specific Heartbeat与虚拟repo-inspector releases。Effect-unknown fixture使用release声明的mutation-disabled child tool发送bounded fixture-effect-intent IPC；parent经真实HarnessSession提交，Effect Gateway/local disposable connector独立claim/dispatch。这样Pi/Mastra真实child/adapter路径参与资格，又不获得connector或业务credential。真实live workspace provider、OS/native capability broker，以及任何非固定fixture operation或真实gateway mutation tool bridge延后到有M3 consumer的独立change。

替代方案：同进程SDK消除故障/credential边界；CLI RPC即使`--no-*`仍包含内建command，public RpcClient虽可用，但CLI内建command、默认env/stderr/direct-child行为和完整RPC surface仍会扩大隔离补丁与M3工具桥成本。因此二者均拒绝；固定Pi CLI RPC只保留install/upgrade smoke，不是runtime fallback。

### 8. Web、Telegram与CLI只做presentation/correlation

v2没有tracked hangar-view源码，因此`apps/hangar-view`从最小页面开始：agents/releases、intent form、Run详情、SSE timeline、cancel和Approval decision。不移植v0 CLI subprocess、`app.yaml`读取或Inbox command whitelist。

Telegram使用Gateway connector的long-poll read port而非公网webhook，减少TLS/ingress前置；只实现agents/intents、Run status、cancel和Approval inline decision。Telegram拥有与Control DB物理分离的最小durable transport store；只含poll offset、八态`control-pending|control-unknown|delivery-pending|delivery-unknown|delivery-recorded|delivery-denied|abandoned-before-send|quarantined-unknown`、完整signed update ref/channel-private raw update/correlation seed、Control/delivery exact tuples与effectId，不含Run/Approval/Effect state/outcome或authorization truth。Control与delivery两阶段都先落pending+完整tuple、调用前CAS到对应unknown；pending在调用前失效可abandoned，unknown按may-have-executed exact replay/quarantine。Write ref随command持久化；read在delivery tuple前可重查snapshot；delivery tuple后只replay Gateway。Mapping撤销/expiry/不可披露时unknown转quarantined，避免无限重投。另一user/chat、group、旧callback默认拒绝；Run与Approval真相仍在Control。

CLI/Web只import生成SDK；Telegram的Control操作也只用SDK，另强制注入由Gateway实现的typed`TelegramGatewayPort(pollUpdates, requestDelivery, readDelivery)`，不import connector/store/launcher或接收token。Adapter从UpdateOccurrenceKey派生唯一Control idempotency key，raw/ref/operation不参与identity；Write response返回与stored command原子绑定的interaction ref；read ref绑定当前projection digest/fact head且仅在delivery tuple前允许重查最新snapshot；delivery key只从ref digest+deliveryOperation+responseKind派生。Port对update/interaction refs与≤16KiB sanitized payload exact replay返回同一Effect；Gateway在Effect创建事务持久target/payload bytes+digest，restart不依赖transport store。冲突零dispatch。跨client acceptance使用同一represented subject与release intent，比较最终Run/Approval/audit facts而非UI文本；Telegram使用本地真实Bot API protocol double覆盖poll/send/edit/callback、malformed/timeout和response-loss，不以mock GatewayPort替代。

### 9. 验收分层与成本记录

M2 stage acceptance由本change specs拥有。Required evidence包括：

- M1全部15项回归；
- Heartbeat与repo-inspector在fake/Pi的同fixture结果；
- HTTP auth/idempotency/precondition/error、cancel/approval、SSE断线/游标/backpressure；
- Web与Telegram以shadow-evaluator intent产生的公共facts一致性；production mode在Pi host未合格时typed拒绝；
- client/adapter依赖边界和secret/error redaction；
- Mastra hard-gate/spike disposition；
- Pi/Mastra与三个client的glue、T_ready、RSS/disk/process、退出成本和TCO。

M2 active developer-day按8 person-hours并累计parallel work，硬上限10日。Apply第一步建立hash-chained/CAS burn ledger，并保守backfill从用户启动本M2 planning change起的全部planning/review工时，不能从apply重置。Ledger分`productRemaining=72h`和`closureRemaining=8h`：产品/group/spike只扣product；不可逆enter-closure后放弃未用product，删减/回滚/复验/final review只扣closure。任一reservation到点立即停；product=0强制enter-closure，closure=0无条件停止。Mastra reservation=min(8h, productRemaining)。Day10未过required出口时冻结扩scope，依次删除Mastra spike与非必要UI/CLI便利；DESIGN列出的成本/资源metrics仍required；不得缩认证、幂等、cancel/Effect fence、Pi隔离/reap或Web+Telegram共用路径，仍失败则停止M2。M2 stage通过不改变Darwin containment、candidate或production qualification。M0 advisory和M1 TAP不能代替M2实际API/process/client观察。

## Risks / Trade-offs

- [首次引入package workspace扩大供应链] → 只pin Zod/Pi，`--ignore-scripts`安装，lockfile与license/依赖审计；额外依赖需单独理由。
- [Pi SDK升级漂移] → pin Pi版本、只用public exports、窄IPC/SDK-event fixtures与unknown-event fail closed；升级必须重跑child capability/path/credential/containment矩阵。
- [Pi需要provider credential且Darwin egress不可强制] → 每Attempt audience-scoped注入、无全局resource/HOME、无model-visible host filesystem/mutation credential，记录目的地probe并保持live-workspace/production false；虚拟资源/credential剥离无法证明则阻断Pi M2 qualification。
- [SSE read/subscribe race] → durable cursor + subscribe后重读head；notification不承担事实真相。
- [Web auth/CSRF超出单用户预期] → 最小短期session/strict same-origin；不扩展为用户目录/RBAC。
- [Telegram redelivery/身份混淆] → server-sideallowlist/delegation与完整correlation tuple，callback CAS/idempotency。
- [Mastra spike吞噬主线] → 一日上限、前置硬门、隔离dependency；失败删除而非补兼容层。
- [无旧hangar-view源码可迁移] → 只建M2必要页面；main历史只作行为oracle，不复制实现。

## Migration Plan

1. 冻结M2 dependency/install-script清单；在隔离workspace验证Zod/Pi/Playwright后才写交付manifest/lock。
2. 建立route registry、intent descriptor/control-metadata输入、deterministic SDK/OpenAPI generation；此时仍不开放network listener。
3. 补齐eligible rejection command-result持久化，再扩展Control query、durable cancel、Approval decision/gateway wake与event cursor port，以in-process integration证明M1不回归。
4. 实现Pi SDK wrapper child、path/credential capability probe和两Agent adapter-specific fixtures；Pi未通过前不创建client。
5. 启动loopback hangar-server，完成`POST /auth/session`、HTTP/SSE与SDK integration。
6. 依次实现CLI、hangar-view、Telegram durable polling/correlation；运行跨client fixture。
7. 在Mastra spike前完成、同步并归档`add-mastra-harness-candidate`；随后执行隔离spike并记录disposition/TCO。它不阻塞Pi主线，除非发现Hangar应归档的三项替代证据。
8. 完成strict OpenSpec、dependency/no-direct-write、M1+M2 tests、fresh CR+RC后关闭M2 tasks；不自动进入M3。

实现开始前在仓外pin HEAD的完整`git ls-tree`、clean/untracked baseline及封闭planning/evidence保留allowlist。回滚只在仓外临时副本从该Git tree恢复；除allowlist外完整路径/bytes必须相同且`git status --porcelain -uall`无额外M2文件，再删除disposable DB/process并重跑M1固定suite。Declared子集、ad-hoc reverse edit或仅测试PASS不能证明恢复。所有M2数据库使用disposable或versioned migration副本；未通过独立production change前不升级任何生产/v0数据库。
