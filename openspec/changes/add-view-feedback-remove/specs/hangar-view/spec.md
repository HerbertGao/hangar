## 修改需求

### 需求:confirm-before-apply 两阶段(干跑解析 → 人确认 → 应用),不 park
NL 命令 SHALL 分两阶段、两次快 run,MUST NOT 用 park 跨人类思考时间(park 会占 app 锁、饿死调度,见 DESIGN §3.4):① **interpret 干跑**——view 调 `hangar run <pilot> --trigger interpret-feedback --input {text}`,pilot 解析后 emit `interpretation.proposed`(结构化)并**无写**结束;② view 从该 run 的 trace 读 `interpretation.proposed`、显示给人确认;③ **apply 写**——人确认后 view 调 `hangar run <pilot> --trigger apply-feedback --input {add, remove}`(**确认后的结构化结果**,非原始 NL),pilot 应用并 emit `feedback.applied`。未确认则**无任何写**。

**加入与移出共用同一条流**:「加入降噪」与「移出降噪」MUST 走**同一对** `interpret-feedback`/`apply-feedback`,MUST NOT 为撤销新增 trigger 或新增白名单条目(撤销是同一意图的反向,不是第 2 个 intent;typed intent 注册表仍等第 2 个**真实** intent)。确认层 SHALL 分两段呈现(将加入 / 将移出),两段皆空时确认动作 SHALL 不可用。

**确认页展示的是将实际写入的 canonical diff**:`interpretation.proposed` 的 `add`/`remove` SHALL 已是 pilot 即将写入的归一化形态,view 只渲染、不再做归一化;MUST NOT 只复述用户原话(否则人确认的与实际写入的可能不同)。canonical 的具体归一与合法性规则是**域细节**,住本变更的 `design.md`「canonical 归一与合法性」一节(view 只校验 `string[]`,无法也不该判断一个字符串是否 canonical —— 该性质由 pilot 侧 self-check 兑现,归档前须人工核对一次「确认页显示的字符串 == overlay 实际增删的 bytes」)。

**授权与切点:** apply-feedback 应用的是**本质无害、可逆的域副作用**(改降噪名单,§3.5 carve-out),**不经 propose/approve/PARK**;人在确认视图的确认**即授权**。remove 与 add 同属此类(remove 只从机器 overlay 删条目,不碰人工 `rules.yaml`、不追溯改历史邮件)。若未来某命令解析出**高危**动作,该 pilot MUST 改走 `ctx.propose`(命中 approval → PARK,守 #5),不在本变更。

#### 场景:干跑解析不写
- **WHEN** interpret 阶段完成
- **THEN** run 只 emit `interpretation.proposed`、无任何域写;用户未确认时系统状态不变

#### 场景:确认后才应用结构化结果
- **WHEN** 用户在确认视图点「确认」
- **THEN** view 用 `interpretation.proposed` 的**结构化**结果(非原始 NL)调 `apply-feedback`,pilot 应用并 emit `feedback.applied`

#### 场景:误解析被人挡下、无写
- **WHEN** `interpretation.proposed` 的解析与用户意图不符
- **THEN** 用户不确认,无任何写发生(解析阶段本就无副作用)

#### 场景:撤销走同一条两阶段流
- **WHEN** 调用方(Pi / Claude Code / CLI)以结构化 `{remove:[…]}` 下达撤销
- **THEN** 走的是同一对 `interpret-feedback`/`apply-feedback`(无新 trigger、无新白名单条目),确认层在「将移出降噪」段列出 canonical 地址,确认后才写

#### 场景:v1 的浏览器命令框只产 add
- **WHEN** 用户在浏览器命令框里键入一句表达「移出」意图的自然语言
- **THEN** 该输入仍走 `{text}` 腿(既有 digest TOP-N 匹配,add-only),`remove` 恒为 `[]`;确认层第二段因此不渲染。**本变更不给 remove 加浏览器入口**——NL→结构化的翻译归调用方,浏览器侧待接入结构化调用方后自然获得该能力,届时无需再改 view

#### 场景:两段皆空不给确认
- **WHEN** `interpretation.proposed` 的 `add` 与 `remove` 都是空数组
- **THEN** 确认层提示未解析出任何变更、确认动作不可用,不发起 apply run

### 需求:命令/事件契约,未知 trigger 响亮失败
hangar-view 依赖的命令契约 SHALL 为:pilot 的 `interpret-feedback`(input `{text}` 或 `{add?, remove?}`,见下「input 有两种形态」→ emit `interpretation.proposed {add:string[], remove:string[]}`,**无写**)与 `apply-feedback`(input `{add?, remove?}` → 应用 → emit `feedback.applied {added, already_present, removed, not_present}`);pilot 收到**未知 trigger** MUST **响亮失败**(`run.failed`),view MUST 据此报错、MUST NOT 静默成功。

**字段恒在(emit 侧)**:上述事件的**每个**声明字段 MUST 恒出现(无变更即空数组),MUST NOT 省略——view 逐字段校验 `string[]`,缺字段即 `contract_mismatch`。语义:`added`/`removed` = 本次真改了 overlay 的、`already_present`/`not_present` = 请求但本就已在/本就不在的(set-union 与 set-difference 各自的幂等回执)。重发同一 apply MUST 安全(`added`/`removed` 退化为空)。

**恰好一次**:每个命令 run MUST **恰好 emit 一次**它的命令事件,且**一次性携带全部声明字段**。分两次 emit(如 add 一个、remove 一个)会让确认页/回执只显示一半;**view MUST 机械校验此基数**(trace 中同 kind 事件数 ≠ 1 → 失败,MUST NOT 静默取第一个),因为「取第一个」会把违约呈现为成功。

**input 侧缺 key MUST 视作空数组、MUST NOT 失败**。跨仓部署序(见下)保证存在一个「新 pilot + 旧 view」的窗口,旧 view 发的正是 `{add}` 而无 `remove` key;把它当非法会让整个窗口的加入操作全部失败,即部署序自己拆掉自己。

**`interpret-feedback` 的 input 有两种形态**:`{text}`(自然语言)与 `{add?, remove?}`(结构化),由「带 `add`/`remove` 任一键」分派。**NL→结构化的翻译不在 pilot 侧**(归调用方:Pi / Claude Code / CLI)。`{text}` 形态 SHALL 由 pilot **既有的**确定性候选匹配(digest TOP-N 子串)处理——本变更不新增、不改动那条匹配逻辑;只要求它的输出**与结构化腿受同一套合法性规则准入**——不合规的候选 MUST NOT 进入提案(否则人确认后必在写腿 `throw`,而人只看到「命令失败」)。细节见本变更 `design.md`。

**同一 input 同时含 add 与 remove 时** MUST 各自独立求解、不得互相抵消成静默无操作。**同一地址同时出现在两侧的处置按腿分开——见下面两条按腿拆分的需求**;此处不给统一裁决,因为两条腿的失败语义是相反的(干跑腿不得 `throw`,写腿必须 `throw`),用一句话同时约束两者必然在其中一条上是错的。

**inbox 侧实现不在本变更**(在 inbox 外部 repo 对着本契约做:canonical 归一、`noise_senders.overlay` 的 tmp+rename 原子写 + set-union/set-difference 幂等、四态回执、不碰人工 `rules.yaml`)。

**跨仓部署序** SHALL 为 pilot 先、view 后:pilot 多 emit 字段对旧 view 无害(旧 view 只投影自己声明的字段)。反序(view 先)时 **interpret 阶段即 `contract_mismatch`,此时无任何写**,人到不了确认层;但若 `apply-feedback` 被直接调用(绕过 UI),旧 pilot 会**照旧应用 `add` 半边**、静默忽略 `remove`,而 view 仍判 `contract_mismatch` 报失败——即「报失败但写已发生」。故反序 MUST NOT 部署,且 `contract_mismatch` 等 **apply 腿的失败 kind 不蕴含「未写」**;该路径的安全性靠 pilot 侧幂等(重发安全),不靠 view 的失败呈现。

#### 场景:未知 trigger 响亮失败
- **WHEN** 命令用了 pilot 不认识的 trigger 名
- **THEN** run 以 `run.failed` 结束(pilot 的 loud default),view 呈现失败、不伪装成功

#### 场景:成功以 feedback.applied 收束
- **WHEN** apply 阶段成功
- **THEN** run 的 trace 出现 `feedback.applied`,view 据此呈现「已应用」(含 `added`/`already_present`/`removed`/`not_present` 四态)

#### 场景:重发同一 apply 幂等
- **WHEN** 用户对同一结构化结果重发 apply(如忙后重试)
- **THEN** 第二次的 `added`/`removed` 为空、对应地址落 `already_present`/`not_present`,overlay 内容与第一次后一致

### 需求:命令确认视图的受控数据最小化放宽(仅此路径)
既有「数据最小化 = 域无关 default-drop」需求继续 governs `/api/state` 与 trace 抽屉(**不变**)。**唯独命令路径**为让人确认/查看命令结果(候选发件人),MAY 渲染其**两个命令事件**的结构化 payload——`interpretation.proposed` 的 `{add, remove}` 与 `feedback.applied` 的 `{added, already_present, removed, not_present}`;但 view MUST **只投影这些声明字段**(逐字段校验为 `string[]`),**MUST NOT 透传整个事件 payload**——否则 pilot 日后往 payload 加字段(原文摘录 / LLM reasoning / 其它收件人)会经放宽路径直达浏览器。此放宽 MUST **仅限命令路径**、MUST NOT 泄露到 `/api/state` 或监控墙。因数据是**用户自己刚输入指令的解析/应用回执**、单用户、Cloudflare Access 门后,受控放宽可接受。声明字段缺失或非 `string[]` → 视为契约不符(`contract_mismatch`)、不当成功。

#### 场景:命令路径只投影声明字段、不透传整个 payload
- **WHEN** view 渲染 `interpretation.proposed`(`{add, remove}`)或 `feedback.applied`(`{added, already_present, removed, not_present}`)
- **THEN** 仅在命令路径显示**这些声明字段**供人确认/查看;事件 payload 里的其它字段被丢弃;`/api/state` 与 trace 抽屉仍 default-drop、不受影响

#### 场景:payload 声明字段缺失/类型不符 → 契约不符、不当成功
- **WHEN** pilot 的事件 payload 缺声明字段或字段非 `string[]`(契约漂移,含 pilot 只 emit 旧的 `add` 一字段 / 旧的 `added`+`already_present` 两字段)
- **THEN** view 归为 `contract_mismatch` 失败,MUST NOT 把畸形 payload 当成功回给前端

### 需求:pilot 忙(already_running)时呈现「稍后重发」、不建队列
pilot 正忙(有活跃 run 持 app 锁)时 `hangar run` MUST 以 `already_running`/退出码 1 失败(既有 core 行为,不排队、不静默丢)。view MUST 把它呈现为**可重试提示**(「忙,稍后重发」),MUST NOT 自建适配器侧队列(隐藏状态会与脊柱「无队列」立场分叉;命令幂等由 pilot 侧 **set-union(add 半边)与 set-difference(remove 半边)**共同保证,用户重发安全)。

#### 场景:忙则提示重发
- **WHEN** 对正忙的 pilot 下达命令,`hangar run` 返回 `already_running`(退出码 1)
- **THEN** view 呈现「忙,稍后重发」,不排队、不静默丢弃

#### 场景:忙后重发 add 与 remove 都幂等
- **WHEN** 用户在忙提示后点确认重发同一 `{add, remove}`
- **THEN** add 半边靠 set-union、remove 半边靠 set-difference 幂等,overlay 内容与只发一次相同

### 需求:只读呈现层、零改 core、不直读 sqlite
`hangar-view` SHALL 是脊柱之外的一个独立进程(仓内 `packages/hangar-view`),**与 `@hangar/core` 无 import 依赖**。它取运行数据 MUST 只经 `hangar … --json`(subprocess)+ 只读 `app.yaml`(config,非状态),MUST NOT 直接打开或读写 `hangar.sqlite`(守 SKILL「一切经 CLI」、守脊柱事件时序)。它对脊柱状态的写入 MUST **只经既有 `hangar run` CLI**,且 MUST 限于白名单 `(pilot, trigger)` 对(见「向 pilot 下达命令的写路径」诸需求)——`hangar run` 会写 `Run`/`RunEvent` 行,故「v1 纯只读」自 `add-view-command-path` 起已不成立;**呈现面**(`/api/state`、trace 抽屉)仍 MUST 严格只读。view MUST NOT 自己写 `hangar.sqlite`、MUST NOT 执行审批处置(approve/reject/重跑)。其 HTTP 面 MUST 只存在于 view↔浏览器之间(不给 `@hangar/core` 加任何 HTTP/IPC,守不变量 #6/#7)。**注意:core 的 `hangar trace/status/runs --json` 本身不改**——一切派生与裁剪都发生在 **view 进程**(这正是「零改 core」的机制)。

#### 场景:经 CLI 取数
- **WHEN** view 需要当前各 app 状态与 run 历史
- **THEN** 它 subprocess 调 `hangar status --json` / `hangar runs --json` / `hangar trace <run> --json`,不直接读 sqlite 文件

#### 场景:core 零改
- **WHEN** 核对本变更对 `@hangar/core` 的改动
- **THEN** core 一行未改(无新 HTTP/IPC),`hangar-view` 只作 CLI 消费者存在

#### 场景:写只经白名单命令、呈现面仍只读
- **WHEN** view 对脊柱状态产生任何写入
- **THEN** 该写入只可能来自白名单 `(pilot, trigger)` 的 `hangar run` 子进程(它写 `Run`/`RunEvent`);`/api/state` 与 trace 抽屉的任何请求 MUST NOT 产生写,view MUST NOT 直接打开 `hangar.sqlite`,MUST NOT 调 `hangar approve`/`reject`

## 新增需求

### 需求:回执自洽性由 view 机械校验(形状校验挡不住说谎的回执)
`string[]` 形状校验只证明「字段类型对」,挡不住**内容在说谎**的回执:四桶全空、只报一半、报了请求里没有的地址、同一地址既 `added` 又 `removed`。这些都过形状校验,前端于是呈「已应用」。**因此 view MUST 对 `apply-feedback` 的回执做配分校验**:每个 input key 的集合 == 它那两个回执桶的并(`add` ↔ `added`+`already_present`,`remove` ↔ `removed`+`not_present`),**四桶全局互不重叠且桶内不得重复**(按重数比较,不是纯集合语义——`added:[a,a]` 不合规),不含请求外的地址;不符 → `receipt_mismatch`,MUST NOT 当成功。

**边界必须写明,否则这条校验会被误读成它证明不了的东西。** view 按**原串**比较,不做归一化(它不知道、也不该知道域的 canonical 规则,守不变量 #1);因此契约要求 `apply` 的 input 已是 canonical、pilot 对非 canonical 项响亮失败(见上「契约」需求)。这条校验证明的是**回执与请求自洽**,**不是**「回执与磁盘一致」——一个配分正确但什么都没写的 pilot 仍会返回 `ok:true`。后者只能由 pilot 侧 self-check 与人工 canonical 闸兑现。

**`receipt_mismatch` 与 `contract_mismatch` 一样,是 apply 腿的失败 kind,故 MUST NOT 被呈现为「未写」**(见「跨仓部署序」)。

#### 场景:配分不符 → receipt_mismatch,不当成功
- **WHEN** 回执四桶全空、只覆盖 `add` 半边、含请求外地址,或同一地址跨桶出现
- **THEN** view 归为 `receipt_mismatch`,MUST NOT 回 `ok:true`;呈现文案 MUST 指出命令可能已生效

#### 场景:缺 key 与畸形 key 分开处置
- **WHEN** input 缺 `remove` key(部署窗口)/ input 的 `add` 存在但不是 `string[]`
- **THEN** 前者视作空集、照常执行并校验;后者以 `usage` 拒绝、不发起 run

#### 场景:同 kind 事件数 ≠ 1 → 失败
- **WHEN** 一个命令 run 的 trace 里出现 0 个或 2 个以上同 kind 命令事件
- **THEN** view 失败并给出对应 kind,MUST NOT 静默取第一个当成功

### 需求:两条腿的失败语义相反,各自成条
`interpret-feedback` 是**干跑腿**,`apply-feedback` 是**写腿**。它们对同一种坏输入的正确反应是相反的,故 MUST 分别规定,MUST NOT 用一条覆盖两者的规则约束——那样必然在其中一条腿上是错的(本变更前两轮各写错过一次,都是因为规则骑在两条腿上)。

**干跑腿(`interpret-feedback`)MUST NOT `throw`。** 非法项、非串项、畸形 `add`/`remove`(非数组)、同一地址两侧冲突——一律**静默不出现在 emit 结果里**,run 以 `completed` 收束、零域写。理由:`hangar-view` 的员工态由该 app **最近一次 run** 派生,一次打错字的 `run.failed` 会把健康的 pilot 画成监控墙上的「翻车 ⚠️」,而抽屉按数据最小化看不到原因;用户输入错误不该污染 liveness 信号。一项都没解析出时两侧皆 `[]`,确认层的空态文案即回执。

**写腿(`apply-feedback`)MUST `throw`**(→ `run.failed`)于:非法项、非 canonical 项、`add ∩ remove ≠ ∅`。到写腿的项是 view 刚回显给人确认过的结构化结果,任何异常即契约漂移,该响亮。特别地,同项冲突不得静默任选一边:`(existing ∪ add) \ remove` 会让 remove 悄悄胜出,而回执 `{added:[X], removed:[X]}` 既过 `string[]` 校验、又在读者眼里像是两个动作都成功了,文件里却只有一种结果。

**view 侧的 input 形状门覆盖两条腿**:`add`/`remove` 任一 key 存在但不是 `string[]` → `usage`/400,**不发起 run**。这与干跑腿的「不 throw」不冲突——前者是 view 在 run 之前拒绝畸形请求(早失败、零副作用),后者是 pilot 万一被绕过 view 直调时的兜底姿态。

#### 场景:干跑腿对坏输入静默丢弃、run 仍 completed
- **WHEN** `interpret-feedback` 收到非法项 / 同一地址两侧冲突
- **THEN** 相应项不出现在 `interpretation.proposed` 里、无任何域写、run 以 `completed` 收束(MUST NOT `run.failed`)

#### 场景:写腿对同项冲突响亮失败
- **WHEN** `apply-feedback` 收到同一地址同时出现在 `add` 与 `remove`
- **THEN** pilot `throw` → `run.failed`,overlay 未被写入,view 呈现失败

#### 场景:畸形 input 在 run 之前被 view 拒绝(两条腿同等)
- **WHEN** 任一 trigger 收到 `add` 或 `remove` 存在但非 `string[]`(如 `{add:"x"}`)
- **THEN** view 返回 `usage`/400 且**一次 run 都不发起**;MUST NOT 当作空集放行
