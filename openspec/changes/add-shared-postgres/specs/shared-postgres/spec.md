## 新增需求

### 需求:app → 连接目标的解析契约;不含驱动、不含连接
`@hangar/pgconfig` 对外 SHALL 只暴露一个**配置解析器**:`resolve(app) → { host, port, database, user, password } | undefined`。它 SHALL 返回连接的**原料**;**如何连接、如何池化、如何迁移由调用方自己决定**。

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

`${ENV}` 插值 SHALL 从 `process.env` 取值,且 MUST 把**空串单独判定为缺失**(`.trim().length === 0`)——否则会产出一个「用户名对、密码空」的连接目标,那种失败比缺配置更难诊断。

#### 场景:明文密码被 schema 拒
- **当** `databases.yaml` 里某 app 的 `password` 写成了明文
- **那么** 解析失败(fail-closed),MUST NOT 用该明文去连接;错误文本 MUST NOT 包含密码值

#### 场景:占位变量缺失或为空串
- **当** `password: "${PG_PW_INBOX}"` 而该变量未设置、或设为空串
- **那么** `resolve` 返回 `undefined`(视作缺配置),MUST NOT 返回一个密码为空的连接目标

### 需求:解析不出即 undefined,绝不抛
`resolve` MUST NOT 抛异常。文件缺失 / 不可读 / YAML 语法错 / schema 不合法 / 无该 app 条目 / env 缺失 / 空串 —— 一律返回 `undefined`。值**存在但非法**时 MAY 附带 `{ reason, varName }` 供调用方记录,但**该结构与任何错误文本 MUST NOT 含密码值**。

本包 MUST NOT 自带 logger、MUST NOT 打日志——记不记、怎么记由调用方定(与 `@hangar/notify` 同款纪律)。

配置 SHALL 惰性读取一次并在进程内 memoize,MUST NOT 在模块加载期同步读文件。

#### 场景:配置不可用时不崩
- **当** `databases.yaml` 不存在或语法错
- **那么** `resolve` 返回 `undefined`、不抛;调用方据此决定是降级还是 fail loud(**那是调用方的决定,不是本包的**)

#### 场景:同进程重复解析结果一致
- **当** 同一进程内第二次调 `resolve`
- **那么** 结果与首次相同(memoize 无破坏性副作用;MUST NOT `delete process.env`)

### 需求:部署期 preflight 必须在 daemon 的 env 里校验
SHALL 提供 `hangar-pgconfig check`:读 `databases.yaml` → 插值 → 校验每个 `(app)` 的占位变量已解析、`database`/`user` 非空。失败非零退出,指明 app 与变量名,**且不打印值**。

SHALL 提供 `check --from-plist <path>`:解析 launchd plist 的 `EnvironmentVariables` 并**只**用它校验,同时断言 plist 里的 `HANGAR_PG_CONFIG` 与自己读的文件一致。**这是本需求的要点** —— 在运维的交互 shell 里校验会绿,而 daemon 的 env 里可能根本没有那些变量;「shell 里绿、daemon 里缺变量」是这类配置最常见的假绿(`add-shared-notify` 的同一条经验)。

`check` 的输出 MUST NOT 声称验过连通性 —— 它只做离线的存在性与形状校验。**要证明能连,得真连一次,那不在本包职责内。**

#### 场景:daemon env 缺变量被 preflight 抓到
- **当** 运维 shell 里有 `PG_PW_INBOX`、但 daemon plist 的 `EnvironmentVariables` 里没有
- **那么** `check --from-plist` 非零退出并指名该变量;直接跑 `check`(用当前 shell)则会绿——**故部署步骤 MUST 用 `--from-plist` 那条**

#### 场景:不谎称验过连通性
- **当** `check` 全绿
- **那么** 其输出只声称「配置存在且形状合法」,MUST NOT 表述为「数据库可连接」或「凭据有效」

### 需求:隔离由 pg 的权限系统执行,hangar 不声称提供
共享实例上 SHALL 每 app 一个 role + 一个 database,跨库可见性由 `REVOKE` 收掉。**这是部署模板给出的约定,由 postgres 自己执行** —— `@hangar/pgconfig` MUST NOT 声称提供、校验或保证任何隔离。

文档 MUST 写明本变更**不提供**「pilot A 读不到 B 的表」这一保证;若将来真需要该保证,它是一个独立赌注(触及非目标里的多租户),不是本变更的自然延伸。

#### 场景:不声称隔离
- **当** 读者想知道共享一个实例是否安全
- **那么** 文档明确回答:隔离来自 pg 的 role/database 权限(部署模板配置),hangar 不提供额外保证;**同 host、同 uid 的进程仍可读到 `databases.yaml` 指向的一切**(与 `CLAUDE.md` 的「不声称防同 uid」一致)
