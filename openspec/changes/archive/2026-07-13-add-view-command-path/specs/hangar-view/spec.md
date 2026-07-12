## MODIFIED Requirements
### Requirement: v1 只读、写路径不在本变更
本变更引入**向 pilot 下达命令**的写路径(见下「新增需求」:白名单 `(pilot,trigger)` + confirm-before-apply)。除此之外,页面 MUST NOT 执行**审批处置**类写操作(approve/reject/重跑):从页面 approve/reject SHALL 留待后续变更,届时 MUST 走 `hangar approve`(拒绝 root、原子认领),并引入 app 级身份与防误触二次确认。**命令下达写路径**与**审批处置写路径**是两回事——前者本变更引入、后者仍不在。

#### Scenario: 页面不提供审批处置动作
- **WHEN** 某员工头顶 ⚠️(如 `waiting_human`)
- **THEN** 页面只呈现该状态、可点开看详情,但不提供 approve/reject 按钮(审批处置回 CLI)

#### Scenario: 命令下达是本变更允许的写路径
- **WHEN** 用户在命令输入框对某白名单 pilot 下达指令
- **THEN** 页面经 `hangar run` 触发命令(见新增需求),这是本变更允许的写路径,与 approve/reject 审批处置无关

## ADDED Requirements
### Requirement: 向 pilot 下达命令的写路径(白名单、经既有 CLI、不新增存储/进程)
hangar-view SHALL 提供一个自然语言输入框,把用户指令**经 subprocess 调既有 `hangar run <pilot> --trigger <name> --input <json>`** 下达给 pilot;view MUST NOT 直连 pilot、MUST NOT 直写 sqlite(守既有「只经 CLI」)。可触发的 `(pilot, trigger)` MUST 受**白名单**约束(v1 硬编码 `inbox` 的 `interpret-feedback` / `apply-feedback`);MUST NOT 暴露「run 任意 app + 任意 input」的通用 firehose。命令**即时经 CLI 触发**,view MUST NOT 新增表/库/进程/队列/游标。hangar core MUST 零改动(`--trigger`/`--input`/`ctx.input`/`ctx.trigger` 已存在)。

#### Scenario: 命令经既有 CLI 写命令下达
- **WHEN** 用户提交一条对 `inbox` 的指令
- **THEN** view 经 subprocess 调 `hangar run inbox --trigger <白名单trigger> --input <json>`,不直连 pilot、不直写 sqlite

#### Scenario: 非白名单 (pilot,trigger) 被拒
- **WHEN** 请求指向白名单外的 app 或 trigger
- **THEN** view 拒绝该请求、不发起 run(不做通用 firehose)

### Requirement: confirm-before-apply 两阶段(干跑解析 → 人确认 → 应用),不 park
NL 命令 SHALL 分两阶段、两次快 run,MUST NOT 用 park 跨人类思考时间(park 会占 app 锁、饿死调度,见 DESIGN §3.4):① **interpret 干跑**——view 调 `hangar run <pilot> --trigger interpret-feedback --input {text}`,pilot 解析后 emit `interpretation.proposed`(结构化)并**无写**结束;② view 从该 run 的 trace 读 `interpretation.proposed`、显示给人确认;③ **apply 写**——人确认后 view 调 `hangar run <pilot> --trigger apply-feedback --input {add}`(**确认后的结构化结果**,非原始 NL),pilot 应用并 emit `feedback.applied`。未确认则**无任何写**。

**授权与切点:** apply-feedback 应用的是**本质无害、可逆的域副作用**(改降噪名单,§3.5 carve-out),**不经 propose/approve/PARK**;人在确认视图的确认**即授权**。若未来某命令解析出**高危**动作,该 pilot MUST 改走 `ctx.propose`(命中 approval → PARK,守 #5),不在本变更。

#### Scenario: 干跑解析不写
- **WHEN** interpret 阶段完成
- **THEN** run 只 emit `interpretation.proposed`、无任何域写;用户未确认时系统状态不变

#### Scenario: 确认后才应用结构化结果
- **WHEN** 用户在确认视图点「确认」
- **THEN** view 用 `interpretation.proposed` 的**结构化**结果(非原始 NL)调 `apply-feedback`,pilot 应用并 emit `feedback.applied`

#### Scenario: 误解析被人挡下、无写
- **WHEN** `interpretation.proposed` 的解析与用户意图不符
- **THEN** 用户不确认,无任何写发生(解析阶段本就无副作用)

### Requirement: 命令/事件契约,未知 trigger 响亮失败
hangar-view 依赖的命令契约 SHALL 为:pilot 的 `interpret-feedback`(input 原始 NL → emit `interpretation.proposed {add:string[]}`,**无写**)与 `apply-feedback`(input `{add:string[]}` → 应用 → emit `feedback.applied {added, already_present}`);pilot 收到**未知 trigger** MUST **响亮失败**(`run.failed`),view MUST 据此报错、MUST NOT 静默成功。**inbox 侧实现不在本变更**(在 inbox 外部 repo 对着本契约做:NL 解析、`noise_senders.overlay` 的 tmp+rename 原子写 + set-union 幂等、不碰人工 `rules.yaml`)。

#### Scenario: 未知 trigger 响亮失败
- **WHEN** 命令用了 pilot 不认识的 trigger 名
- **THEN** run 以 `run.failed` 结束(pilot 的 loud default),view 呈现失败、不伪装成功

#### Scenario: 成功以 feedback.applied 收束
- **WHEN** apply 阶段成功
- **THEN** run 的 trace 出现 `feedback.applied`,view 据此呈现「已应用」(含 `added`/`already_present`)

### Requirement: pilot 忙(already_running)时呈现「稍后重发」、不建队列
pilot 正忙(有活跃 run 持 app 锁)时 `hangar run` MUST 以 `already_running`/退出码 1 失败(既有 core 行为,不排队、不静默丢)。view MUST 把它呈现为**可重试提示**(「忙,稍后重发」),MUST NOT 自建适配器侧队列(隐藏状态会与脊柱「无队列」立场分叉;命令幂等由 pilot 侧 set-union 保证,用户重发安全)。

#### Scenario: 忙则提示重发
- **WHEN** 对正忙的 pilot 下达命令,`hangar run` 返回 `already_running`(退出码 1)
- **THEN** view 呈现「忙,稍后重发」,不排队、不静默丢弃

### Requirement: 命令确认视图的受控数据最小化放宽(仅此路径)
既有「数据最小化 = 域无关 default-drop」需求继续 governs `/api/state` 与 trace 抽屉(**不变**)。**唯独命令路径**为让人确认/查看命令结果(候选发件人),MAY 渲染其**两个命令事件**的结构化 payload——`interpretation.proposed` 的 `{add}` 与 `feedback.applied` 的 `{added, already_present}`;但 view MUST **只投影这些声明字段**(逐字段校验为 `string[]`),**MUST NOT 透传整个事件 payload**——否则 pilot 日后往 payload 加字段(原文摘录 / LLM reasoning / 其它收件人)会经放宽路径直达浏览器。此放宽 MUST **仅限命令路径**、MUST NOT 泄露到 `/api/state` 或监控墙。因数据是**用户自己刚输入指令的解析/应用回执**、单用户、Cloudflare Access 门后,受控放宽可接受。声明字段缺失或非 `string[]` → 视为契约不符(`contract_mismatch`)、不当成功。

#### Scenario: 命令路径只投影声明字段、不透传整个 payload
- **WHEN** view 渲染 `interpretation.proposed`(`{add}`)或 `feedback.applied`(`{added, already_present}`)
- **THEN** 仅在命令路径显示**这些声明字段**供人确认/查看;事件 payload 里的其它字段被丢弃;`/api/state` 与 trace 抽屉仍 default-drop、不受影响

#### Scenario: payload 声明字段缺失/类型不符 → 契约不符、不当成功
- **WHEN** pilot 的事件 payload 缺声明字段或字段非 `string[]`(契约漂移)
- **THEN** view 归为 `contract_mismatch` 失败,MUST NOT 把畸形 payload 当成功回给前端
