# m2-control-clients Specification

## Purpose

定义由同一typed Control API驱动的SDK、CLI、Web与Telegram行为，使两个真实界面共享认证、命令、事件、审批与审计路径，而不复制业务或生命周期状态机。

## Requirements

### Requirement: 单一 route registry 生成 SDK 与 OpenAPI

**Requirement ID:** `m2cc.contract-generation` SHALL 是本需求的稳定标识。

M2 SHALL 维护一个版本化route registry作为HTTP method/path、request、response、typed error、authentication、idempotency和projection schema的唯一owner。TypeScript SDK的类型/调用面与OpenAPI文档 SHALL 从该registry确定性产生；相同输入字节必须产生相同输出字节。手写第二份wire schema、route在SDK/OpenAPI任一侧缺失、生成物脏漂移或client私有error mapping均使验证失败。

SDK SHALL默认拒绝unknown response/error/event字段并暴露stable typed result。Control command write方法 MUST要求caller提供idempotency key和适用precondition；非Control`POST /auth/session`以bootstrap generation+establish action，或bootstrap generation+renew action+signed predecessor作为exchange identity，SDK不得要求client key；SDK不得用新key自动重试write。只有能够证明request尚未被server接受的连接前失败可分类为transport prerequisite failure；发送后无response一律返回稳定`unknown-to-client`operation result，caller只能以原command identity replay。Read/SSE可按明确策略重连，但必须把cursor作为`1..9007199254740991`canonical safe-integer decimal复用，不得接受会被JS Number舍入的值或规范化非法别名，也不能触发command。SDK不得读取SQLite、Agent文件、secret store或Pi/Mastra session。

#### Scenario: Route 只存在于 server

- **WHEN**server registry新增或修改route，但SDK或OpenAPI生成物未同步
- **THEN**deterministic generation check失败，M2 artifact不可发布

#### Scenario: SDK 自动重试 write

- **WHEN**transport在write response前断开且SDK准备以新idempotency key重发
- **THEN**SDK拒绝自动重试并把结果保持为unknown-to-client；只有caller以原identity查询/replay

#### Scenario: SSE 只读重连

- **WHEN**event stream断开且client持有最后已确认cursor
- **THEN**SDK以同一`Last-Event-ID`重连，只接收后续event且不发出write

### Requirement: v2 CLI 兼容 facade

**Requirement ID:** `m2cc.cli` SHALL 是本需求的稳定标识。

v2 CLI SHALL只使用生成SDK调用Control API，并保留迁移期输出习惯：stdout承载命令数据，stderr承载诊断；`--json`输出单一可解析JSON；退出码`0`表示成功，`1`表示已执行的operation non-success或发送后结果`unknown-to-client`，`2`只表示usage/config/auth或能证明request尚未被接受的transport前置失败。CLI MUST NOT启动内部Control实现、读取/写入SQLite或Agent配置文件，也不得通过subprocess调用legacy CLI完成v2 command。

Legacy CLI SHALL 作为单独版本化oracle保留迁移期名称、兼容范围与删除条件；v2 CLI不得与其共享可写Run identity或同时成为production admission owner。

#### Scenario: CLI JSON operation 失败

- **WHEN**Control返回typed command non-success且用户请求`--json`
- **THEN**stdout只含稳定JSON error envelope、stderr可含净化诊断，进程退出`1`

#### Scenario: CLI 配置缺失

- **WHEN**endpoint或credential缺失/无效且request尚未被接受
- **THEN**CLI不注册command，stderr给安全提示并退出`2`

#### Scenario: CLI 尝试读取本地 SQLite

- **WHEN**v2 CLI为显示Run或重试command而打开Control SQLite
- **THEN**依赖边界测试失败；唯一允许路径是生成SDK

### Requirement: Web 与 Telegram 共用 Control 语义

**Requirement ID:** `m2cc.web-telegram` SHALL 是本需求的稳定标识。

M2 SHALL 提供最小hangar-view Web client与Telegram Bot作为两个真实界面。Web SHALL 可列出Agent/release、提交release-owned intent、查看Run与event stream、cancel Run并决定pending Approval；Telegram SHALL 至少提供等价的agent/intent启动、Run状态、cancel与approval decision入口。Web的全部操作与Telegram的Control API操作只能调用生成SDK。Telegram SHALL接收composition root注入的唯一domain-neutral`TelegramGatewayPort`；没有该port时adapter拒绝启动。Port由Effect Gateway-owned connector实现且只含：`pollUpdates({serviceAuthorityRef,cursor,limit<=100}) -> {updates:[{rawUpdate,updateInteractionRef}],nextCursor}`；`requestDelivery({serviceAuthorityRef,updateInteractionRef,controlInteractionRef,responseKind,deliveryKey,deliveryOperation,payloadBytes,payloadDigest}) -> ({status:"effect",effectId,state,outcome}|{status:"denied",error})`；`readDelivery({serviceAuthorityRef,effectId}) -> DeliveryView`。每个input/output使用封闭schema/byte bound，delivery payload仅允许≤16KiB声明sanitizer的canonical safe text；port验证authority、interaction ref、delivery key与payload digest，不暴露Bot token、raw connector或mutation method。除此之外不得有直连。两client对同一represented subject、intent、payload和policy必须经过相同release resolution、command idempotency、Run、Approval/Effect与audit facts。

Web身份 SHALL由同源、HttpOnly、SameSite会话映射；`POST /auth/session`是bootstrap-only认证特例，browser ambient session cookies不作为第二credential：establish忽略旧generation cookies并覆盖，renew只认显式predecessor hint；初次headers全丢失且过期时，establish 410 response返回stored predecessor header供下一次renew；establish以bootstrap generation标识；renew发送`X-Hangar-Session-Predecessor`：优先读取signed hint cookie；cookie缺失时使用authenticated establish-410 response返回的signed predecessor header，identity绑定predecessor session generation；同bootstrap可在ACK loss/page restart后恢复相同exchange result，无需client idempotency key。成功header block同时设置HttpOnly`hangar_session`与same-origin可读`hangar_csrf`/signed`hangar_session_hint` cookies，无body；write从CSRF cookie恢复`X-Hangar-CSRF`header，refresh不需要bootstrap；二者绑定expiry/credential generation。establish active期重贴返回existing；establish跨expiry返回410+stored predecessor hint，Web再以renew建立单调successor；同predecessor renew ACK/延迟重放只返回same successor，下一代必须使用successor hint并丢弃旧cookie/CSRF；revoked generation失败。首次登录/renewal由operator在Web表单手动提供bootstrap；脚本只在一个same-origin`POST /auth/session`调用的内存变量中读取，发送后立即清空DOM与引用，MUST NOT写入URL、cookie、local/session storage、IndexedDB、service worker、history或log。除此之外浏览器脚本不得读取长期API credential。Telegram adapter MUST NOT接收Bot token。Bot token作为mutation-capable secret只注入Gateway-owned TelegramTransportConnector；connector向adapter暴露封闭`pollUpdates` read port，但`sendMessage | editMessage | answerCallback`等outbound operation只能由Effect Gateway以`control-command` Effect调用。Adapter SHALL使用audience受限的独立Hangar Control service principal，并在每个Control request携带registry-owned`X-Hangar-Channel-Context`，值为Gateway签发的完整opaque signed`UpdateInteractionRef={claims,mac}`；claims含规范限定的occurrence/channel/normalized interaction/raw digest/expiry但不含actor/scope/delegation。Server以该service principal加当前allowlist/delegation把明确允许的private`(userId,chatId)`映射为represented subject并绑定context digest；其他principal不能使用该header。Chat/user/message/callback字段本身不可信，group/unknown/旧mapping默认拒绝。

Telegram验证`UpdateInteractionRef`claims/MAC形状并只使用signed registry-owned`controlOperation`/target；`CorrelationSeed=['telegram-control-v1',UpdateOccurrenceKey]`且`idempotencyKey=sha256(seed)`；raw/ref/operation/target digest不参与identity，而由Control首次绑定并检查冲突。Control authentication boundary独立验证MAC/claims/key derivation，再解析represented subject/delegation并按主spec推导command identity；adapter不能自选claims、controlOperation、target、key或authority state。Raw update/ref digest仅用于channel presentation/evidence binding，不参与Control identity；同occurrence mismatch必须quarantine。Web/Telegram authentication principals不同会产生不同actorSubjectId，只有各自key相同时才在各自identity内exact replay。Control boundary对每个Telegram query/write response签发opaque`ControlInteractionRef`：write ref/digest/key generation与stored command result原子持久化并exact replay；read ref绑定当前projection digest/global fact head且不持久化。两者都绑定UpdateInteractionRef digest与封闭`responseKind`，client不能自造。`deliveryKey = sha256(canonical(['telegram-delivery-v1', interactionRefDigest, deliveryOperation, responseKind]))`；port input显式携带同一responseKind/deliveryOperation供Gateway验证。Gateway exact replay返回同一Effect，payload/digest冲突typed拒绝。Telegram SHALL拥有与Control DB物理分离的最小durable transport store，保存poll cursor、signed refs/correlation/disposition、exact replay tuples及最多64KiB分类为channel-private的raw update bytes；raw bytes只保留到update进入terminal transport disposition后删除，MUST NOT进入Control fact/Effect。Store不保存Run/Approval/Effect authority truth。Control tuple固定完整原始UpdateInteractionRef、CorrelationSeed、派生idempotency key、method/path、原始`If-Match`与canonical body bytes/digest。Disposition封闭为`control-pending | control-unknown | delivery-pending | delivery-unknown | delivery-recorded | delivery-denied | abandoned-before-send | quarantined-unknown`。SDK send前先从control-pending CAS到control-unknown；收到Control result/InteractionRef后，必须在调用Gateway前原子持久化delivery-pending tuple`{updateInteractionRef,interactionRef,responseKind,deliveryKey,deliveryOperation,payloadBytes,payloadDigest}`。Gateway调用前CAS到delivery-unknown；response loss后restart以该tuple exact requestDelivery，不能重跑Control。若crash发生在delivery-pending提交前：write用原tuple exact replay恢复相同stored result/ref；read可重新授权查询最新projection并替换read ref/delivery key，因尚无delivery tuple/Effect而不会重复发送。Gateway返回effect arm后只持久化effectId为delivery-recorded；返回durable denied arm则持久化safe denial ref为delivery-denied且零Effect。DeliveryView每次展示都经`readDelivery`读取Gateway当前projection，不在transport store复制state/outcome；只有delivery-recorded、delivery-denied、abandoned-before-send或quarantined-unknown才推进long-poll offset。任何`*-pending`只证明其下一调用尚未开始。Control-pending在失效时转abandoned-before-send并证明零Control/Gateway mutation；delivery-pending失效时保留/audit已完成Control result/ref，转abandoned-before-send并只证明零Gateway delivery Effect。两者均可推进offset。任何`*-unknown`按may-have-executed exact replay/quarantine，绝不换identity。Redelivery时，原mapping仍有效则按当前phase使用持久化Control或delivery tuple exact replay，即使目标当前ETag已变化；若represented subject/delegation mapping已撤销/轮换、correlation已过期或当前授权不能披露原result，则任一control-unknown/delivery-unknown不得用新actor重发，记录不含subject/target detail的quarantined-unknown/operator diagnostic并推进offset，避免无限重投。该transport ledger不成为Run/Approval真相。Approval interaction使用封闭状态`pending | decided | expired`和事件`approve | deny | replay-or-foreign`：

| state | approve | deny | replay-or-foreign |
| --- | --- | --- | --- |
| `pending` | CAS→`decided(approved)` | CAS→`decided(denied)` | reject，无mutation |
| `decided` | 当前披露授权允许时返回stored decided state | 当前披露授权允许时返回stored decided state | reject，无mutation |
| `expired` | typed expired | typed expired | reject，无mutation |

Telegram outbound delivery Effect不改变目标Agent Run terminal eligibility。Connector无external idempotency时禁transport auto-retry；response loss保持unknown并只在transport/audit view披露，adapter不得为回复用户而重复发送。Channel disconnect、Telegram redelivery、Web刷新或SSE重连 MUST NOT cancel Run、创建第二Run或重复decision。Client可以缓存presentation，但不得用缓存决定authorization、terminal、Effect retry或下一个event cursor。所有log/error SHALL 净化Telegram token、API credential、raw provider content和内部path。

#### Scenario: Web 与 Telegram 启动同一 intent

- **WHEN**同一represented subject从Web和Telegram以不同idempotency key提交同一有效intent
- **THEN**两条请求都走相同policy/admission/audit规则并创建各自独立Run，不进入channel私有状态机

#### Scenario: Public shadow intent 产生 Approval

- **WHEN**跨client验收启动release声明的shadow-evaluator fixture intent
- **THEN**真实Harness通过mutation-disabled disposable EffectIntent产生pending Approval，并经公开Run view/event被Web/Telegram发现；测试不得内部预置Approval row/fact

#### Scenario: 两个 channel 并发决定同一 Approval

- **WHEN**Web principal与Telegram service principal代表同一subject并发提交相反decision
- **THEN**二者拥有不同actor/command identity，但共享同一Approval CAS；恰有一个terminal decision，另一方在当前披露授权允许时取得stored decided state

#### Scenario: Telegram interaction/delivery identity exact replay

- **WHEN**同一update/correlation seed和Control response需要再次请求delivery
- **THEN**adapter派生相同idempotency/command/delivery key，Control/Gateway返回同一interaction ref/Effect；seed相同但payload不同typed conflict且零second dispatch

#### Scenario: Telegram delivery policy denied

- **WHEN**requestDelivery policy在Effect创建前deny
- **THEN**Gateway持久化同delivery request identity的safe denied result并返回denied arm；adapter进入delivery-denied并推进offset，零Effect/Approval/LocalDispatchResult/dispatch；exact replay返回同一denial

#### Scenario: Denied response 前崩溃

- **WHEN**Gateway denied result已commit但port response丢失
- **THEN**adapter从delivery-unknown exact replay取得同一denied arm并terminalize delivery-denied，不创建Effect

#### Scenario: Telegram 绕过 Gateway port

- **WHEN**adapter直接调用Bot API、connector或自建delivery state machine，而不是使用注入port
- **THEN**dependency/secret boundary失败，零outbound operation可执行

#### Scenario: Telegram connector 遇到 malformed/timeout

- **WHEN**本地Telegram-protocol double对poll/send/edit/callback返回malformed JSON、超时或headers/body间断
- **THEN**connector产生typed read failure或delivery unknown，零raw error/token泄漏，且unknown outbound不自动retry

#### Scenario: Telegram outbound response loss

- **WHEN**Gateway connector可能已发送message/edit/callback但response丢失
- **THEN**control-command Effect保持unknown且不自动retry；目标Agent Run不被该delivery阻塞，transport view显示安全unknown disposition

#### Scenario: Telegram adapter 尝试直接使用 Bot token

- **WHEN**adapter环境、config或SDK path出现Bot token或直接Bot API mutation method
- **THEN**dependency/secret boundary失败；token只能存在于Gateway connector，outbound必须有Effect identity

#### Scenario: Telegram callback 被另一用户重放

- **WHEN**尚未发送Control write的callback来自非绑定principal/chat或已过期
- **THEN**adapter与Control boundary拒绝request，不披露Approval内容且零mutation

#### Scenario: Signed controlOperation 被 adapter 改写

- **WHEN**adapter发送的route/target/key与UpdateInteractionRef signed controlOperation/target claims不一致
- **THEN**Control拒绝request且不接受adapter值，零command/Run/delivery

#### Scenario: Telegram occurrence 重签不同内容

- **WHEN**同一connector/service/updateId出现不同signed claims/raw digest
- **THEN**adapter/Control使用相同UpdateOccurrenceKey并保留首个binding，后到证据quarantine且不派生第二command/delivery

#### Scenario: Telegram update ref 被伪造

- **WHEN**adapter修改pollUpdates返回ref的user/chat/update/mapping/digest/MAC，或跨chat重放
- **THEN**Control在authority resolution前`403`，零command/interaction/delivery

#### Scenario: Read query 后、delivery tuple 前崩溃

- **WHEN**GET已返回但adapter在持久化delivery-pending前崩溃，期间projection/head变化
- **THEN**restart可重新授权读取最新snapshot/ref并派生新delivery key；因旧delivery tuple/Effect不存在，不产生重复delivery

#### Scenario: Control 成功后、delivery intent 持久化前崩溃

- **WHEN**Control已返回InteractionRef但adapter在提交delivery-pending tuple前崩溃
- **THEN**write的control-unknown exact replay恢复随command持久化的相同result/ref；read按上一场景重查最新snapshot；两者随后只创建一个delivery tuple/Effect，不推进offset

#### Scenario: Gateway restart 使用 durable delivery payload

- **WHEN**delivery Effect已创建但adapter/transport store与Gateway进程随后全部restart
- **THEN**Gateway从Control DB持久target/payload/ref恢复同一Effect；adapter只凭effectId经readDelivery观察，不成为推进owner

#### Scenario: Gateway Effect 创建后 response 丢失

- **WHEN**requestDelivery可能已创建/dispatch Effect但response丢失且adapter无effectId
- **THEN**restart从delivery-unknown完整tuple exact replay取得同一effectId并持久化delivery-recorded，不重新执行Control query或创建第二Effect

#### Scenario: Pending phase 在调用前过期或 mapping 撤销

- **WHEN**control-pending或delivery-pending尚未发起下一调用时，correlation过期或mapping撤销
- **THEN**control-pending abandonment证明零Control/Gateway mutation；delivery-pending abandonment保留既有Control result且证明零delivery Effect。两者都不调用下一边界并推进offset

#### Scenario: Telegram 在 send 前后崩溃

- **WHEN**adapter分别在control-pending→control-unknown或delivery-pending→delivery-unknown CAS前、CAS后调用前、调用后response前崩溃
- **THEN**对应pending证明下一调用未开始；任何control-unknown/delivery-unknown按may-have-executed exact replay/quarantine，所有窗口均不换identity、不重复Run或Effect

#### Scenario: Telegram redelivery 重复 intent

- **WHEN**adapter在poll offset commit前崩溃并再次收到同一已认证`update_id` intent
- **THEN**它派生相同command identity并在原mapping仍有效时取得stored Run result，不创建第二Run；cursor只在delivery-recorded或quarantined-unknown后推进

#### Scenario: Cancel ACK loss 后目标 ETag 变化

- **WHEN**cancel可能已被Control接受但response丢失，restart时Run ETag已因`cancel-requested`变化
- **THEN**Telegram从transport store使用原始`If-Match`和完整canonical request tuple exact replay，取得stored result而非用新ETag产生conflict

#### Scenario: Unknown phase 在 correlation expiry 后 redelivery

- **WHEN**Control或delivery调用已进入对应unknown disposition，随后correlation过期
- **THEN**adapter不再发送或声称零历史mutation，转`quarantined-unknown`、发安全诊断并推进offset；可能已提交的command保持唯一可审计

#### Scenario: Command ACK loss 后 mapping 轮换

- **WHEN**Control可能已接受Telegram write但response丢失，随后represented-subject/delegation mapping被撤销或轮换
- **THEN**adapter不以新actor/identity重发也不披露旧result，记录`quarantined-unknown`安全诊断并推进poll offset；可能已提交的Control command保持唯一可审计

#### Scenario: Telegram redelivery 重复 cancel

- **WHEN**Telegram重复投递同一已认证cancel callback
- **THEN**原idempotency identity返回stored result，Control不重复abort/reap/terminalize

#### Scenario: Web 或 Telegram 断线

- **WHEN**任一client在Run执行或Approval pending期间断线
- **THEN**Control状态继续durable存在；断线本身不cancel、不approve，也不影响另一client按当前authorization读取

#### Scenario: Web refresh 恢复 CSRF

- **WHEN**browser在active session期间刷新并丢失全部JS内存
- **THEN**HttpOnly session cookie继续认证，JS只从same-origin`hangar_csrf` cookie恢复header并可cancel/decision；bootstrap无需持久化

#### Scenario: Web bootstrap credential 持久化尝试

- **WHEN**client准备把operator输入的bootstrap写入browser storage、URL、history、service worker或log
- **THEN**安全/浏览器测试失败；credential只能存在于一次exchange的短期内存并在发送后清除

#### Scenario: Web session 过期后重新认证

- **WHEN**Web session过期导致SSE关闭或Control write返回`401 session_expired`
- **THEN**client重贴current bootstrap generation、显式renew并携带cookie或410 response提供的signed predecessor取得successor cookies，旧session不可继续；它不重发未知write

#### Scenario: Web session 在 SSE 期间被撤销

- **WHEN**session expiry、credential generation、delegation或policy在长连接期间失效
- **THEN**server在下一batch/heartbeat reauthorization时关闭stream，client必须重新认证且不能沿用旧cursor披露权限

#### Scenario: Client 包含 channel 业务规则

- **WHEN**Web或Telegram根据本地channel状态绕过release intent schema、policy、Approval或Effect Gateway
- **THEN**跨client fixture与依赖检查失败，该路径不能进入M2交付
