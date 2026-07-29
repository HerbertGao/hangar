## 新增需求

### 需求:app → 连接目标的解析契约;不含驱动、不含连接
`@hangar/pgconfig` 对外 SHALL 只暴露一个**配置解析器**。它 SHALL 返回连接的**原料**;**如何连接、如何池化、如何迁移由调用方自己决定**。

**返回形状 SHALL 只有一种,诊断走另一个函数**(与 `@hangar/notify` 同款):

- `resolve(app) → PgTarget | undefined` —— 热路径。**任何**问题都回 `undefined`,不带诊断。
- `resolveWithReason(app) → { target } | { target: undefined, failure: { reason, varName?, severity } }` —— 判别联合,供调用方决定记不记日志。

**MUST NOT** 让 `resolve` 有时回目标、有时回诊断对象:那是两种形状挤在一个返回位上,调用方必须先做类型判别才敢用,而它最常见的用法恰恰是 `const t = resolve(app); if (!t) …`。

本包 MUST NOT 依赖 `pg` 或任何数据库驱动,MUST NOT 建立网络连接,MUST NOT 执行 SQL,MUST NOT 建角色/建库/改密码/跑迁移。其运行时依赖 SHALL 限于 `yaml` + `zod`。**这条不是洁癖:一旦它能连、能建号,「hangar 管数据库」就成立了,而那撞不变量 #1 与非目标里的多租户。**

`@hangar/core` MUST 零改动:不加 `ctx.db`,core MUST NOT 认识 `databases.yaml`,MUST NOT 经手任何密码。

#### 场景:解析器只回原料
- **当** pilot 需要连它自己的库
- **那么** 它调 `resolve('inbox')` 拿到 `{host, port, database, user, password}`,用**自己的**驱动连接;`@hangar/pgconfig` 不出现在连接路径上

#### 场景:不含驱动
- **当** 核查本包的运行时依赖
- **那么** 其中没有 `pg`/`postgres`/任何驱动或 ORM,也没有任何发起网络连接的代码

### 需求:databases.yaml 是唯一 SOT,密钥只以 ${ENV} 占位
`(app) → 连接目标` SHALL 由一份 host 级 `databases.yaml` 定义(路径经 `HANGAR_PG_CONFIG`,带约定默认路径),git 版本化。

`password` 字段 MUST 匹配 `${ENV_NAME}` 占位形式;**明文密码 MUST 使 schema 校验失败**(fail-closed)——不是警告,是拒绝。这条与 `channels.yaml` 的 `bot: "${TG_BOT_INBOX}"` 同法:配置文件进 git,密钥永不进 git。

**连接目标的每个字段都 SHALL 在 schema 层校验完整,不把不合法值传给驱动**:`host`、`database`、`user` MUST 去空白后非空;`port` MUST 是 `1..65535` 的**整数**(缺省 5432)。理由是**失败要发生在部署期的 preflight,不是 pilot 的热路径**——一个 `port: 70000` 或 `port: 5432.5` 若放过,报错会来自驱动内部、在一次真实 run 中间,且文案与配置无关。schema SHALL 为 strict:未知键(如把 `database` 写成 `db`)MUST 校验失败,而不是当成缺字段静默跳过。

`${ENV}` 插值 SHALL 从 `process.env` 取值,且 MUST 把**空串单独判定为缺失**(`.trim().length === 0`)——否则会产出一个「用户名对、密码空」的连接目标,那种失败比缺配置更难诊断。

#### 场景:明文密码被 schema 拒
- **当** `databases.yaml` 里某 app 的 `password` 写成了明文
- **那么** 解析失败(fail-closed),MUST NOT 用该明文去连接;错误文本 MUST NOT 包含密码值

#### 场景:占位变量缺失或为空串
- **当** `password: "${PG_PW_INBOX}"` 而该变量未设置、或设为空串
- **那么** `resolve` 返回 `undefined`(视作缺配置),MUST NOT 返回一个密码为空的连接目标

#### 场景:不合法的 port / 空字段 / 拼错的键在部署期就被拒
- **当** `port` 写成 `70000`、`5432.5` 或 `0`,或 `host`/`database`/`user` 为空白,或把 `database` 拼成 `db`
- **那么** schema 校验失败、`resolve` 返回 `undefined`,`check` 非零退出;MUST NOT 把这些值交给驱动去在一次真实 run 中间报错

### 需求:解析不出即 undefined,绝不抛
`resolve` MUST NOT 抛异常。文件缺失 / 不可读 / YAML 语法错 / schema 不合法 / 无该 app 条目 / env 缺失 / 空串 —— 一律返回 `undefined`。诊断经 `resolveWithReason` 的 `failure` 取得(见上),**该结构与任何错误文本 MUST NOT 含密码值** —— 特别是 schema 校验失败时 MUST NOT 回显校验库给出的原始消息,那种消息会把被拒的明文密码原样带出来。

本包 MUST NOT 自带 logger、MUST NOT 打日志——记不记、怎么记由调用方定(与 `@hangar/notify` 同款纪律)。

**memoize 的对象 SHALL 是「按路径缓存的**已解析文件**状态」,MUST NOT 缓存插值后的结果或插值失败。** 这条不是实现细节:`check(env)` 必须按**传入的** env(某个 launchd plist 的)插值,而 `resolve()` 用 `process.env`;若缓存了插值产物,**先跑的那个 env 就替后跑的那个决定了答案**,`check --from-plist` 随即失去意义。插值 SHALL 每次调用重新执行。

配置 SHALL 惰性读取,MUST NOT 在模块加载期同步读文件。**只有解析成功的状态 SHALL 被缓存**:缓存失败会让它在整个进程生命周期里变成终局,而消费者是跑几天的 launchd daemon —— 运维在它启动之后才写好配置或修好文件权限,它会一直静默返回 `undefined`,且没有任何地方说需要重启。失败路径每次多一次失败的 `open()`,可以接受。

**解析器 MUST NOT 让配置内容经由警告/日志渠道外泄。** YAML 解析器在默认级别会用 `process.emitWarning` 报告可恢复问题,而警告文本会**引用出错的那一行源码** —— 于是一个写坏的 `password:` 行即便让本函数返回固定 reason 码,明文仍会打到 stderr,在 launchd 下就是落进 daemon 的日志文件。故解析时 SHALL 把日志级别降到只报错误。**验证这条必须捕获子进程的 stderr**:只检查返回值(或序列化 `check()` 的结果)看不见它;且警告是**异步**发出的,一个以 `process.exit()` 结尾的进程会在它 flush 之前退出,所以用 CLI 去验会得到一个即使去掉修法也照样通过的测试。

#### 场景:配置不可用时不崩
- **当** `databases.yaml` 不存在或语法错
- **那么** `resolve` 返回 `undefined`、不抛;调用方据此决定是降级还是 fail loud(**那是调用方的决定,不是本包的**)

#### 场景:同进程重复解析结果一致
- **当** 同一进程内第二次调 `resolve`
- **那么** 结果与首次相同(memoize 无破坏性副作用;MUST NOT `delete process.env`)

#### 场景:环境变了,答案必须跟着变
- **当** 同一份 `databases.yaml`,第一次解析时占位变量缺失(得 `undefined`),随后该变量被设上再解析
- **那么** 第二次 MUST 解析成功 —— 被缓存的只有已解析的文件,插值失败 MUST NOT 被缓存

#### 场景:配置在进程启动之后才就位
- **当** daemon 启动时 `databases.yaml` 还不存在(或不可读),运维随后把它放好
- **那么** 同一进程内的下一次 `resolve` MUST 解析成功,不要求重启

#### 场景:写坏的密码行不得经由警告泄漏
- **当** `password` 那行含无法解析的 YAML(如未知 tag),而解析器在默认级别会把出错源码行打进警告
- **那么** 进程的 stderr 与 stdout MUST NOT 出现该行的内容;返回值仍是固定 reason 码

#### 场景:无法表示的 app 名必须整份拒绝
- **当** `apps` 下出现 `__proto__` / `constructor` / `prototype` 这类会被校验库静默丢弃的键
- **那么** 整份配置 MUST 校验失败 —— 半载入比拒绝更危险:那条被丢弃的 app 的密码从未被校验,而 `check` 会报绿

### 需求:部署期 preflight 必须在 daemon 的 env 里校验
SHALL 提供 `hangar-pgconfig check`:读 `databases.yaml` → 插值 → 校验每个 `(app)` 的占位变量已解析、字段合法。失败非零退出,指明 app 与变量名,**且不打印值**。

**CLI 契约 SHALL 与本仓其余命令一致**(`CLAUDE.md` 的 CLI 规范):日志 → stderr,报告 → stdout,`--json` 给结构化输出;退出码 `0` 成功 / `1` 配置有问题 / `2` 参数错误。无参或未知子命令 SHALL 打印帮助并退 `2`,不默默成功。`databases.yaml` 存在但 `apps` 为空 SHALL 判为**失败**而非通过——文件在、却什么都没配,在部署期与「文件被截断/指错了」不可区分。

SHALL 提供 `check --from-plist <path>`:解析 launchd plist 的 `EnvironmentVariables` 并**只**用它校验。**要点是那个性质——校验 daemon 将要看到的那份环境,而不是运维交互 shell 的**;「shell 里绿、daemon 里缺变量」是这类配置最常见的假绿(`add-shared-notify` 的同一条经验)。`--from-plist` 是「env 住在 plist 里」时的实现,不是要求本身。

**若 plist 声明了 `DOTENV_CONFIG_PATH`,MUST 同时读取它指向的 env 文件,按 plist 覆盖文件的优先级合并**,并用 **pilot 实际使用的同一个 dotenv 实现**(`dotenv.parse`)解析、MUST NOT 手写。理由与合并次序同 `add-shared-notify` 的 preflight 需求(launchd 先灌 plist,dotenv 随后加载且默认不覆盖已有 `process.env`)——那条是本条的权威表述,两处 MUST 保持一致。**生产实测(2026-07-29):`com.herbertgao.hangar-inbox.plist` 根本没有 `EnvironmentVariables`,密钥住在 `.env` 里** ——「密钥必须在 plist」从来不成立,故本条 MUST NOT 要求 `PG_PW_INBOX` 落在 plist。

合并后的环境 MUST **显式含** `HANGAR_PG_CONFIG`(来自 plist 或那个 env 文件皆可),缺失即非零退出。注意这是一条**存在性要求,不是一致性比对**:配置路径本就是从这个值推出来的,再拿读到的路径与它比较是**自证同一性、恒真**。真正要防的是「哪儿都没声明 → 退回约定默认路径 → 校验的不是 daemon 会读的那个文件」。

`check` 的输出 MUST NOT 声称验过连通性 —— 它只做离线的存在性与形状校验。**要证明能连,得真连一次,那不在本包职责内。**

#### 场景:daemon env 缺变量被 preflight 抓到
- **当** 运维 shell 里有 `PG_PW_INBOX`、但 daemon 将要看到的环境(plist + 其声明的 env 文件合并后)里没有
- **那么** `check --from-plist` 非零退出并指名该变量;直接跑 `check`(用当前 shell)则会绿——**故部署步骤 MUST 用 `--from-plist` 那条**

#### 场景:密钥住在 plist 指向的 env 文件里
- **当** plist 只声明 `DOTENV_CONFIG_PATH` 等非密钥变量,`PG_PW_INBOX` 住在它指向的 env 文件里
- **那么** `check --from-plist` 读到该变量并通过,而不是因「plist 里没有」误报缺失

#### 场景:不谎称验过连通性
- **当** `check` 全绿
- **那么** 其输出只声称「配置存在且形状合法」,MUST NOT 表述为「数据库可连接」或「凭据有效」

#### 场景:CLI 契约与本仓其余命令一致
- **当** 自动化(CI / Agent / 部署脚本)调用 `hangar-pgconfig`
- **那么** `--json` 给结构化 stdout、日志走 stderr、退出码 `0`/`1`/`2` 各有语义;未知子命令或缺 `--from-plist` 的路径参数退 `2`;`apps` 为空的配置退 `1` 而非 `0`

### 需求:隔离由 pg 的权限系统执行,hangar 不声称提供
共享实例上 SHALL 每 app 一个 role + 一个 database。**边界要写具体,否则「隔离」只是命名习惯**:postgres 默认给 `PUBLIC` 授了 `CONNECT`,即**任何 role 都能连任何库**,故部署模板 SHALL 对每个库 `REVOKE CONNECT ... FROM PUBLIC` 再 `GRANT` 给它自己的 role,并收掉库内 `public` schema 的建表权。app 的 role SHALL 是 `NOSUPERUSER NOCREATEDB NOCREATEROLE`。

**这是部署模板给出的约定,由 postgres 自己执行** —— `@hangar/pgconfig` MUST NOT 声称提供、校验或保证任何隔离。

文档 MUST 写明本变更**不提供**「pilot A 读不到 B 的表」这一保证;若将来真需要该保证,它是一个独立赌注(触及非目标里的多租户),不是本变更的自然延伸。

#### 场景:不声称隔离
- **当** 读者想知道共享一个实例是否安全
- **那么** 文档明确回答:隔离来自 pg 的 role/database 权限(部署模板配置),hangar 不提供额外保证;**同 host、同 uid 的进程仍可读到 `databases.yaml` 指向的一切**(与 `CLAUDE.md` 的「不声称防同 uid」一致)
