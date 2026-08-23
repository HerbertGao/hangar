## Purpose

定义M2可替换Harness adapter的公共行为，使fake、Pi与受限Mastra候选在不取得Control、Effect、process或restore权威的前提下接受同一组真实故障与成本检验。

## ADDED Requirements

### Requirement: Attempt-bound Harness adapter 边界

**Requirement ID:** `m2ha.boundary` SHALL 是本需求的稳定标识。

每个Harness adapter SHALL只接收不可变AgentRelease、RunAttempt token、由persisted control metadata/checkpoint/release resources确定性派生的input digest/refs、deadline、abort signal与不参与prompt语义的opaque capability handles/最小RuntimeGrant，并只通过HarnessSession提交action/event/tool observation/EffectIntent/checkpoint/outcome proposal。Adapter MUST NOT创建Run或外层RunAttempt、决定terminal、直接dispatch/reconcile Effect、签发grant、写Control SQLite/Agent文件或拥有restore。

Harness identity与ExecutionClosure属于release identity，因此fake、Pi和候选adapter SHALL分别编译adapter-specific release；它们可共享同一Agent contract/intent fixtures，但MUST NOT在运行期把一个release切换到另一adapter。比较adapter时，Control、store、API、client、Effect Gateway和公共fact schema保持不变，releaseId按各自closure正确不同。

Adapter输出 SHALL绑定当前run/attempt/session/grant generation与实际runtime identity。每个Attempt的prompt/runtime input SHALL只由immutable release goal/instructions、admission已持久化的control metadata、versioned checkpoint和release-pinned resource refs确定性生成，canonical input digest绑定Attempt launch fact；API commit后、launch前restart必须重新生成相同bytes。Credential只按SecretRef/audience在launch时重新解析，不进入input digest。旧Attempt、已撤销grant、过期deadline、未注册action或未知union arm SHALL在追加事实前typed拒绝。Provider/session内部retry只可处理同一Attempt内尚未提交且声明为可逆的操作；unknown/committed Effect、Control cancel或外层attempt allocation不属于adapter retry。

#### Scenario: Fake 被 Pi 替换

- **WHEN**共享同一Agent intent contract的fake release与Pi release分别执行同一fixture
- **THEN**二者releaseId因ExecutionClosure不同而不同，但产生相同公共owner/fact/terminal契约，client、Control、store与Effect实现无需分支

#### Scenario: 运行期切换 release adapter

- **WHEN**caller尝试在不编译新release的情况下把active fake release改为Pi或Mastra
- **THEN**release验证拒绝该变更，既有Run继续绑定原release/adapter identity

#### Scenario: 旧 Pi session 迟到提交

- **WHEN**Pi child在AttemptQuiesced被消费或grant撤销后提交action、checkpoint、EffectIntent或child launch
- **THEN**Control返回`stale_attempt`或等价typed failure，且不追加派生事实

#### Scenario: Admission 后、Pi launch 前重启

- **WHEN**intent/Run/Attempt已提交但server在构造或发送Pi prompt前重启
- **THEN**Control从release、persisted metadata与refs重建相同input digest/bytes，不依赖丢失的HTTP正文或旧credential值

#### Scenario: Harness 尝试提交 terminal

- **WHEN**adapter把provider技术成功、agent text或内部session结束解释为Run terminal
- **THEN**边界拒绝该输入；只有Control choke point可依据domain outcome与cleanup事实terminalize

### Requirement: Pi SDK 隔离子进程映射

**Requirement ID:** `m2ha.pi-rpc` SHALL 是本需求的稳定标识。

Pi reference adapter SHALL由Control-owned launcher启动固定版本的Hangar wrapper child；wrapper只使用Pi公开SDK创建AgentSession，不运行Pi CLI/TUI/RPC mode，也不得deep-import`dist/*`内部模块。SDK配置 SHALL使用in-memory SessionManager/SettingsManager、显式空ResourceLoader、固定model/runtime和Hangar自有custom tool set；不得发现`~/.pi/agent`、项目skills/extensions/prompts/themes/context、内建slash command或持久session。

Child MUST NOT向模型暴露host-filesystem operation。Heartbeat不注册文件tool；repo-inspector的read/list/search只查询release-pinned、规范排序、总字节/单文件受限的virtual regular-file entries`{relativePath, bytes, digest}`。Corpus在release编译时拒绝absolute、`..`、重复、symlink/device/socket、未知kind或digest漂移；tool不import`node:fs`、不接收host path，也不开放Pi built-in bash/edit/write。Provider credential按release audience只注入一个需要的值；mutation/gateway credential、Control DB/path、用户HOME与无关environment/fd不可见。Provider egress在M2 Darwin local host上只做目的地观察/probe，不声称网络sandbox；缺少enforced egress时Pi只能获得`fixture-readonly-reference/unverified-claim`，`liveWorkspaceEligible`与production/mutation-capable qualification均为false。

Launcher fd topology SHALL固定stdin=`ignore`、一个专用IPC channel、stdout/stderr两个diagnostic pipes及仅release声明的resource descriptors。只有IPC可产生adapter state/tool/outcome；stdout/stderr不得作为protocol。每个diagnostic pipe累计最多64KiB，按UTF-8 safe-text sanitizer净化后只可形成bounded diagnostic digest/summary，不持久化raw provider内容；invalid UTF-8、secret canary或超限立即protocol-fault/reap。`cleanup-complete`等待IPC、stdout和stderr全部close/drain。

Parent与child只使用版本化、Zod解码的窄Hangar IPC union。Parent→child arm为`prompt-request | abort | shutdown`；child→parent arm为`ready | prompt-accepted | sanitized-action-or-tool-event | fixture-effect-intent | outcome-artifact | settled | protocol-fault`。`prompt-request`固定`schemaVersion + requestId + runId + attempt + sessionId + grantGeneration + releaseId + canonicalPrompt/inputDigest + promptText + virtualCorpus + opaqueGrant/BrokerHandle`，MUST NOT携带resolved credential。Prompt UTF-8最多64KiB；virtual corpus最多256个entry、单entry 64KiB、总计1MiB。`fixture-effect-intent`只能由release声明的mutation-disabled测试tool产生，固定disposable operation、request/action identity、intent key/generation和payload digest；它不含connector/gateway credential或dispatch authority。Parent验证release/attempt/action binding后经HarnessSession提交EffectIntent，真实Effect Gateway/local disposable connector拥有claim/dispatch/outcome。该arm用于每adapter的effect-unknown/零redispatch资格fixture，不能由adapter外test driver代替。

`outcome-artifact`只能由release声明的deterministic outcome tool产生，绑定request/action/tool/schema id+version、最多64KiB canonical safe artifact bytes与child digest。Parent SHALL独立复算digest、验证release outcome schema和matching tool lifecycle，再依次提交ToolObservation与OutcomeProposal；release-owned domain gate还 SHALL从pinned intent/corpus用独立expected implementation推导canonical artifact并比较bytes/digest，MUST NOT调用child tool实现或信任schema-valid自报；exact duplicate幂等，digest/bytes/schema冲突为protocol fault。Assistant text、`settled`或child自报digest不能直接满足business outcome。Pi SDK event在child内归一化；未知arm/event/field、oversize message或raw provider/error/path按默认拒绝。`session.prompt()` resolve代表Pi内部accepted run（含其retry/compaction）已settled，但只触发drain；它不是Hangar Attempt/Run terminal。同一child只执行一个prompt request；exact duplicate返回原`prompt-accepted`而不再次调用SDK，不同identity/digest为protocol fault。Parent正常路径只发送一次；若acceptance/settlement含糊，不在同一Attempt重发。M2不新增checkpointless outer retry：在没有已提交valid checkpoint时，`cleanup-complete(failed)`事务 SHALL原子追加唯一`attempt-settled(failed)`与safe result；Control-owned restart scan随后经唯一choke point terminalize Run failed。Crash在两事务之间由该durable Attempt fact恢复。若completion terminal先提交则保持completed；若cancel-requested先于Run failure terminal则最终cancelled；否则failed terminal先提交并使后到cancel/completion获得stored terminal conflict。只有已存在valid checkpoint且满足既有AttemptQuiesced contract时，后续显式resume才可创建新Attempt。

Adapter lifecycle SHALL使用封闭状态`starting | ready | active | draining | stopping | terminal`和事件`child-ready | prompt-request | prompt-accepted | sdk-settled | cancel | process-exit-or-fault | cleanup-complete`。进入`active`时必须保存唯一in-flight request identity/digests；`prompt-accepted`与`sdk-settled`必须按序匹配它。`cleanup-complete`只有在IPC/output已drain、完整process group已reap且grant已revoked时成立，并携带完整frame集合导出的`succeeded | cancelled | failed` cause：

| state | child-ready | prompt-request | prompt-accepted | sdk-settled | cancel | process-exit-or-fault | cleanup-complete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `starting` | →`ready` | reject | reject | reject | →`stopping(cancelled)` | →`stopping(failed-pending-drain)` | →`terminal(failed)` |
| `ready` | reject | 保存request并调用SDK→`active(requested)` | reject | reject | →`stopping(cancelled)` | →`stopping(failed-pending-drain)` | reject |
| `active` | reject | exact duplicate返回当前acceptance状态；不同digest fault | 仅matching requested→`active(accepted)`；duplicate idempotent | 仅matching accepted→`draining(settled-pending-cleanup)`；否则fault | →`stopping(cancelled)` | →`stopping(exit-pending-drain)` | reject |
| `draining` | reject | exact duplicate返回stored acceptance；其他reject | idempotent | idempotent | →`stopping(cancelled)` | →`stopping(exit-pending-drain)` | →`terminal(recorded-cause)` |
| `stopping` | reject | exact duplicate返回stored acceptance；其他reject | 仅channel-close前matching requested frame可记录accepted | 仅matching accepted后的buffered frame可记录settled observation；succeeded/failed cause仍只在cleanup-complete经independent outcome gate决定 | idempotent并记录cancel | 记录exit/fault并继续cleanup | →`terminal(recorded-cause)` |
| `terminal` | reject | exact duplicate返回stored acceptance；其他reject | ignore并审计 | ignore并审计 | 返回stored terminal | ignore并审计 | idempotent |

Process exit MUST等IPC/output close与decoder flush后才分类，且永远不能单独满足terminal。Cause precedence固定为：存在durable`cancel-requested`则`cancelled`；否则存在protocol/tool/provider fault、缺matching prompt-request→accepted→settled chain、required outcome artifact缺失/冲突/被独立domain gate拒绝，或没有完整valid settled frame则`failed`；只有required outcome gate accepted时才为`succeeded`。Buffered frame只在channel close前按原顺序解码，不能在cleanup-complete后改写cause。Child自然退出不是协议保证：settled后进入bounded drain deadline，超时由Control TERM→KILL/hard-reap。父死、timeout、cancel、protocol fault或unexpected exit都由Control launcher收敛；SDK abort/graceful dispose不能替代whole-tree证明。

#### Scenario: SDK child 启动时仍发现全局资源

- **WHEN**capability probe发现任一全局/project skill、extension、prompt、slash command、context、session或未声明tool
- **THEN**adapter资格失败并reap child，不发送Agent prompt

#### Scenario: Pi fixture EffectIntent 经过真实 adapter

- **WHEN**Pi或Mastra资格fixture请求disposable Effect unknown路径
- **THEN**child通过bounded fixture-effect-intent arm和HarnessSession创建intent，Effect Gateway独立claim/dispatch；crash后unknown且adapter不能redispatch

#### Scenario: Fixture EffectIntent 携带 credential 或未知 operation

- **WHEN**child intent包含connector credential、dispatch claim、非release operation或错误action/attempt binding
- **THEN**parent在HarnessSession/Gateway前拒绝并protocol-fault，不external invoke

#### Scenario: Pi settle 但没有 outcome artifact

- **WHEN**SDK prompt正常settle但未执行release声明的outcome tool，或只返回assistant text
- **THEN**cleanup-complete后原子提交`attempt-settled(failed)`，不伪造ToolObservation/OutcomeProposal；restart-safe Control scan按failure precedence terminalize Run failed

#### Scenario: Plausible 但错误的 outcome artifact

- **WHEN**child提供schema-valid、digest自洽但与release-pinned corpus独立expected不一致的repo inventory/Heartbeat artifact
- **THEN**domain gate拒绝OutcomeProposal，cleanup-complete提交durable Attempt failed并由restart-safe choke point收敛Run failed，不能以tool invocation或assistant text补票

#### Scenario: Outcome artifact digest 被伪造

- **WHEN**child发送的artifact bytes/schema/tool binding与digest不匹配或与既有artifact冲突
- **THEN**parent在Control outcome gate前拒绝并protocol-fault，零accepted outcome

#### Scenario: SDK prompt settle 后 child 仍存活

- **WHEN**`session.prompt()`已resolve但wrapper child仍运行
- **THEN**adapter进入draining并在deadline内dispose/exit或由Control hard-reap；process/grant未收敛前不提交技术成功

#### Scenario: Child 自发或乱序 settle

- **WHEN**child在matching prompt-request/prompt-accepted之前发送accepted或settled，或identity/digest不匹配
- **THEN**adapter记录protocol fault并cleanup，不能产生succeeded technical observation

#### Scenario: Prompt request 重复投递

- **WHEN**parent或transport重复发送相同requestId/attempt/prompt/input digest
- **THEN**child返回原`prompt-accepted`且SDK prompt只执行一次；任一字段不同则protocol fault并reap

#### Scenario: Prompt request oversize 或携带 credential

- **WHEN**prompt/corpus超过固定上限、entry数量超限或message含resolved credential/未知字段
- **THEN**child在调用SDK前typed拒绝并进入protocol-fault cleanup

#### Scenario: Prompt acceptance acknowledgement 含糊

- **WHEN**parent发送prompt后IPC断开，无法判断SDK是否已接受或执行，且没有valid checkpoint
- **THEN**同一Attempt不重发prompt；Control收敛child/grant、settle Attempt failed并terminalize Run failed，不调用要求checkpoint的quiesce/resume

#### Scenario: Attempt failed 提交后、Run terminal 前崩溃

- **WHEN**checkpointless Pi cleanup已提交`attempt-settled(failed)`但server在Run failure terminal前崩溃
- **THEN**restart scan从durable Attempt fact提交恰好一个Run failed terminal；若此前cancel/completion已线性化则按既定precedence返回stored conflict而不改winner

#### Scenario: 已有 checkpoint 的 Pi failure

- **WHEN**Pi failure前已提交valid checkpoint且cleanup/obligation满足AttemptQuiesced contract
- **THEN**只有显式Control resume可原子消费quiescence并创建新Attempt；SDK child自身不能retry outer Attempt

#### Scenario: 宿主路径不可表达

- **WHEN**Pi尝试读取absolute、`..`、symlink名、未知virtual entry或宿主随机sentinel
- **THEN**tool只接受release-pinned relative entry，其他请求typed拒绝；host path/bytes不进入Pi、IPC或durable fact

#### Scenario: Raw stdout/stderr 携带 secret 或超限

- **WHEN**wrapper/SDK/provider向非IPC stdout/stderr写入secret canary、invalid UTF-8、partial/concatenated protocol-like JSON或超过64KiB
- **THEN**parent不解析为event/outcome，记录typed diagnostic fault并reap；raw bytes不进入fact/error/client

#### Scenario: SDK/IPC message malformed

- **WHEN**child产生oversize、malformed、unknown或schema不符的IPC message/SDK event
- **THEN**adapter记录typed protocol failure、停止派生输入并hard-reap完整process group，不持久化raw provider内容

#### Scenario: Control 取消 Pi Attempt

- **WHEN**已认证cancel在Pi active/draining期间提交
- **THEN**Control发送attempt-bound abort、撤销grant并收敛whole tree；SDK settle/late event不能赢过已线性化的cancel-requested fact

#### Scenario: Child exit 早于最后 IPC frame

- **WHEN**process exit先被观察，而IPC/output仍有buffered `settled`或tool frame
- **THEN**adapter先进入stopping并等待channel close/flush；只有cleanup-complete按完整frame/cause集合提交terminal observation

### Requirement: M2 append-only budget ledger

**Requirement ID:** `m2ha.budget` SHALL 是本需求的稳定标识。

M2 SHALL由单一`M2 Budget Coordinator`拥有append-only burn ledger。每条`M2BurnRecord`固定`recordId、previousRecordHash、kind(planning-backfill|reserve|actual|settle-crashed-reservation|enter-closure|stop)、bucket(product|closure)、reservationId、taskGroup、actor、start/end、reserved/actualPersonHours、productRemaining、closureRemaining、evidenceRef、recordHash`。Genesis`previousRecordHash`固定64个ASCII`0`。每条record使用`v2c.release-identity`canonical bytes计算`recordHash=sha256(['m2-burn-record-v1',previousRecordHash,{全部固定字段但排除recordHash}])`；数字为finite non-negative person-hour decimal的唯一canonical表示，optional字段显式`null`而非省略。Append使用expected head hash单行CAS；parallel worker不能直接写ledger或在无成功reservation时工作。Validator从创世记录重算hash chain、每个bucket余额、reservation唯一性与时间/actual边界，不把普通measurement PASS当预算证据。

本spec采纳后、进入apply/implementation阶段，创建ledger前唯一允许的implementation mutation是Budget Coordinator用version-pinned stdlib one-shot原子写入genesis+planning-backfill；该bootstrap本身工时计入backfill，不能创建产品文件、调用外部系统或派发实现worker；此前proposal/review不是违规，但必须全部backfill计费。创世`planning-backfill` SHALL在任何其他apply/product任务前，保守计入从用户启动本M2 planning change起的全部planning/review/person-hours；缺证据取可辩护上界并绑定stable owner decision，不得记0或从apply时重置。初始总预算80h。若backfilledPersonHours为B，genesis必须令`productRemaining=max(0,72-B)`、`closureRemaining=max(0,80-max(B,72))`；B>=72立即enter-closure，B>=80同时stop。所有余额保持非负。

Product工作只可在`state=product`下先CAS追加product reservation且`reserved<=productRemaining`；parallel reservations累加。Closure工作只可在不可逆`enter-closure`记录后预留closure bucket。Product完成较早 MAY主动enter-closure，未用product余额立即放弃、不得转入closure；product=0 MUST enter-closure。Record余额公式固定：`reserve`在append时先令bucketRemaining减reserved；`actual`只令remaining加回`reserved-actual`，不得二次扣费；`settle-crashed-reservation`令actual=reserved且remaining保持reserve后的值；`enter-closure`令productRemaining=0且不增加closure；`stop`不改余额。若worker/Coordinator crash留下open reservation，恢复必须CAS追加`settle-crashed-reservation`后才能继续；不得使用union外的recovery kind或改写reserve。Closure=0或`stop`后禁止任何M2 mutation/dispatch，只可读取ledger/报告未完成。

#### Scenario: Ledger genesis bootstrap 尝试实现产品

- **WHEN**本spec采纳后的apply阶段，在genesis/backfill创建前或同一one-shot中出现产品文件、外部调用或implementation worker
- **THEN**该工作无合法reservation且M2阻断；唯一bootstrap只可写canonical genesis/backfill并把自身工时计入

#### Scenario: Record hash 排除规则漂移

- **WHEN**writer把recordHash自身纳入preimage、省略null字段、改变domain tag/genesis hash或使用非canonical数字
- **THEN**validator拒绝该record/head，余额不能用于reservation

#### Scenario: Planning 工时未 backfill

- **WHEN**apply尝试创建产品文件但创世记录未覆盖proposal/review期间person-hours
- **THEN**budget validation失败且不允许product reservation

#### Scenario: 两个并行 worker 竞争 reservation

- **WHEN**两个worker基于同一head尝试预留可能超出product余额的hours
- **THEN**至多一个CAS提交；loser重读余额，任何无reservation工作计违规并阻断M2

#### Scenario: Reservation 被重复扣费

- **WHEN**actual或settle-crashed-reservation再次从already-debited remaining扣reserved/actual
- **THEN**validator按record-kind公式拒绝hash-chain余额，不能产生下一reservation

#### Scenario: Planning backfill 超过 product bucket

- **WHEN**B大于72或80 person-hours
- **THEN**genesis按max公式clamp non-negative，B>=72进入closure，B>=80 stop；不得产生negative number

#### Scenario: Worker 在 actual 前崩溃

- **WHEN**reservation已提交但worker未追加actual即崩溃
- **THEN**恢复以expected head CAS追加`settle-crashed-reservation`，actual=reserved且保持reserve后bucket余额，不能静默释放或使用未知record kind

#### Scenario: Product 提前完成并进入 closure

- **WHEN**required product工作在productRemaining仍大于0时完成
- **THEN**Coordinator可原子enter-closure，放弃未用product hours并仅使用原8h closure；转换不可逆

#### Scenario: Closure budget 耗尽

- **WHEN**closureRemaining达到0或stop已记录
- **THEN**不再执行删减、修复、复验或review mutation，M2以未完成停止而非超预算继续

### Requirement: Adapter 共用资格赛与成本止损

**Requirement ID:** `m2ha.qualification` SHALL 是本需求的稳定标识。

M2 SHALL使用相同Agent contract、input和public observation fixture评价adapter-specific fake/Pi releases及通过前置硬门后的Mastra spike。固定fixture至少覆盖release identity、grant replay、Effect dispatch后unknown且零redispatch、cancel/checkpoint、outer/inner retry owner、whole-tree reap，以及中立Heartbeat和只读repo-inspector。Expected来自Hangar spec，actual来自公开Control API、fresh SQLite facts与真实process，不由adapter自报。

Pi必须通过全部required fixture才能成为M2`fixture-readonly-reference` adapter；它不提供live workspace。若virtual-resource/credential/process隔离通过但host没有enforced provider egress/setsid/PID-reuse证明，qualification必须同时保留`liveWorkspaceEligible=false`与`productionEligible=false`。Mastra spike开始前 MUST已完成并归档`add-mastra-harness-candidate`，并拒绝candidate auto recovery、schedule owner、tool approval治理受控mutation、业务提交credential和完整Service双owner。Mastra任一透明控制硬门或required fixture失败 SHALL得到`retain-harness-pi`，不得把Mastra runtime dependency带入交付构建；spike最多1个active developer-day。

M2 active developer-day按8 person-hours，整个stage硬上限10日并完全服从`m2ha.budget`。Mastra product reservation取8h与当前productRemaining较小值；没有成功ledger reservation不得开始spike。达到day10仍未满足Pi/API/Web/Telegram required出口时 SHALL冻结扩scope，先删除Mastra spike与非必要UI/CLI便利；所有DESIGN要求的成本/资源metrics仍为required。不得删除认证、幂等、cancel/Effect fencing、Pi隔离/reap、两client共用路径或审计硬门。删减后仍不闭合则M2失败且不进入M3，不自动延长。

每个候选 SHALL记录glue LOC、T_ready、cold start、idle/peak RSS、disk/process count、部署形态、退出成本、许可证边界、self-host/managed差异与12个月TCO。缺失证据计0且不能由功能数量、社区规模或M0 advisory补票。若候选被实证同时替代跨副本fencing、受控提交层与凭据剥离/whole-tree边界，则触发独立归档裁决，不在本change内静默切换owner。

#### Scenario: M2 达到十日预算

- **WHEN**M2累计达到10 active developer-days且required exit仍未通过
- **THEN**冻结扩scope并按固定顺序删Mastra/便利功能；核心安全与两个client出口不缩减，仍失败则停止在M2

#### Scenario: Mastra 启用自动恢复

- **WHEN**spike配置candidate侧auto recovery或schedule直接触发Hangar Agent
- **THEN**资格赛在运行fixture前拒绝该配置为双owner

#### Scenario: Candidate 进程获得业务提交凭据

- **WHEN**Pi或Mastra child环境、descriptor或tool包含推送、发信、发布等gateway credential
- **THEN**launch失败且不启动child，credential值不进入fact/log/error/client

#### Scenario: Mastra 硬门失败但 happy path 成功

- **WHEN**Mastra在Heartbeat happy path表现正常但任一透明控制硬门或required failure fixture失败
- **THEN**结果为`retain-harness-pi`且Mastra dependency不进入交付runtime

#### Scenario: 两个 Agent 仅在一个 adapter 上通过

- **WHEN**Heartbeat或repo-inspector仅在fake/Pi之一满足相同public observation
- **THEN**adapter替换出口闸失败，不能用另一Agent或M0 token补票
