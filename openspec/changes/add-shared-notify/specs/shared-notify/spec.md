## 新增需求

### 需求:lane → 目的地的解析契约;不含传输
`@hangar/notify` 对外 SHALL 只暴露一个**配置解析器**:`resolve(app, lane) → { botToken, chatId } | undefined`(经 `createResolver(app)` 绑定 app id)。`lane` 取自封闭集合(v1 = `private` | `broadcast`)。

- 它 SHALL 返回目的地的**原料**(bot token + chat id);**如何投递由调用方自己的传输决定**。`@hangar/notify` MUST NOT 含任何 HTTP/投递代码,MUST NOT 依赖 apprise 或任何传输库。
- 调用方 SHALL 显式传入自己的 app id(`createResolver('inbox')`)。系统 MUST NOT 为此给 `RunContext` 增加 app id 字段。

#### 场景:pilot 拿到原料、用自己的传输发
- **当** inbox 要推一封 P0 邮件
- **那么** 它调 `resolve('inbox', 'private')` 得到 `{ botToken, chatId }`,交给**它自己既有的** Telegram 传输;`@hangar/notify` 不参与投递

### 需求:配置 = 两个字段,密钥不落 git
`channels.yaml` SHALL 是 `(app, lane) → { bot, chat }` 的唯一 SOT,**git 版本化**。配置项是**两个字段,不是 URL**。

- 每个 app SHALL 持有**自己的 bot token**;被共享的**只有 chat**。
- `bot` 字段 MUST 是 `${ENV_NAME}` 占位符;schema MUST 拒绝任何不匹配 `/^\$\{[A-Z0-9_]+\}$/` 的 `bot` 值(把「别提交明文 token」变成 parse error)。`chat` MUST 非空。
- 环境变量名 SHALL 按 app 命名空间化(`TG_BOT_INBOX`)。**这是硬要求**(N 个 pilot 共享 `process.env`),但**不是安全边界**(见下条需求)。
- `channels.yaml` 的路径 SHALL 由 `HANGAR_NOTIFY_CONFIG` 指定,且 SHALL 有一个约定默认路径,使未设该变量的入口也能解析到同一份。`hangar doctor` MUST NOT 回显或校验它(那会让脊柱认识通知,破不变量 #1)。

#### 场景:换群只改一处
- **当** 某个 app 换了群号
- **那么** 只改 `channels.yaml` 中那一行的 `chat`、提交一次;该 app 的代码与 bot token 均不动

#### 场景:明文 token 被 fail-closed 拒绝
- **当** `channels.yaml` 里某个 `bot` 写成了明文 token 而非 `${ENV}` 占位符
- **那么** schema 校验 MUST 失败(既在部署 preflight,也在运行期读取时)

### 需求:运行期绝不抛;解析不出即降级
`resolve()` MUST NOT 抛出异常。遇到**任何**问题——文件缺失 / 不可读 / YAML 语法错 / schema 不合法 / app 或 lane 无条目 / `${ENV}` 未设 / 空串 / token 形状非法——MUST 返回 `undefined`。

**为何绝不抛(三条硬约束)**:① 调用方的渠道构造发生在**模块级 const**(inbox `notifier.ts:173`),在 hangar 的 `await import()`(`executor.ts:57`)期求值 —— 抛错被 **ESM loader 永久缓存**,一个配置写错让整个 pilot 到 daemon 重启前跑不了;② 撞 `inbox-app spec:95-97`「pilot 模块顶层禁 throw」;③ 撞 inbox `notifications/spec:61`「未配置必须降级为记日志并跳过、禁止抛出未捕获异常、记为 `skipped` 并含原因」。

**空串必须单独判定**:`process.env.X === ''` 是「已设置」,朴素的 `undefined` 检查会放行。判定 MUST 为 `.trim().length === 0`。

**日志分层但不打日志到未脱敏 sink**:`resolve()` 遇到值缺失(无条目/env 未设)时对应「本 app 不在这条 lane 上」——静默或 INFO;遇到值**存在但非法**(token 形状错、YAML 解析错)时须让调用方能记 **ERROR**。`@hangar/notify` **自己不打日志、不引入 logger 依赖**,而是把 `{ reason, varName }` 之类返回给调用方,由调用方用它**已在脱敏的** logger 记 —— 避免 token 落到未脱敏的 `console.error`。

#### 场景:环境变量为空串
- **当** `channels.yaml` 配了某 app 的 lane,而对应 `${TG_BOT_X}=`(空串)
- **那么** `resolve()` 返回 `undefined`(不抛),调用方走降级;MUST NOT 产出 token 为空的目的地

#### 场景:配置文件缺失或畸形时不崩
- **当** `HANGAR_NOTIFY_CONFIG` 指向的文件不存在,或 YAML 有语法错
- **那么** `resolve()` 返回 `undefined`,MUST NOT 抛、MUST NOT 让 import 该模块的进程崩溃(含单测进程)

### 需求:配置惰性读取一次并缓存
`channels.yaml` SHALL 在**首次 `resolve()` 时惰性读取一次并进程内缓存**。MUST NOT 在模块加载期同步读(避免 ESM-cache 抛错地雷),MUST NOT 每次调用重读。改配置需重启进程生效——这与调用方现状一致,不是新约束。

系统 MUST NOT 在插值后 `delete` 环境变量:import 顺序不受控使其无法成为安全边界,而它会让任何第二次 `resolve()` 读到已删的 env → 把正确配置误报为失败。

#### 场景:同进程内第二次解析仍成功
- **当** 同一进程内对同一 app 的第二条 lane、或重建渠道、或测试里第二次构造,再次 `resolve()`
- **那么** 返回与首次一致的结果(不因首次读取产生任何破坏性副作用)

### 需求:部署期 preflight 必须在 daemon 的环境里校验
`@hangar/notify` SHALL 提供 `hangar-notify check`:读 `channels.yaml`、插值 `${ENV}`、校验 `bot` 是 `${ENV}` 且已解析、校验 `chat` 非空。配置有问题 MUST 以非零退出码失败,指明 app/lane/变量名(**不带值**)。

- 它 MUST 能校验 **daemon 将要看到的那份环境**,而非运维 shell 的:接受 `--from-plist <path>`,解析 plist 的 `EnvironmentVariables` 并**只**用它,同时断言 plist 里的 `HANGAR_NOTIFY_CONFIG` 与自己读的文件一致。一个在 shell 里跑绿、daemon 里缺变量的 preflight 是假绿。
- 部署流程 MUST 调用它,配置错则中止部署。
- **诚实边界**:它做离线校验(形状 + 存在性),**不验 token 有效性**——合法形状但已吊销/属于别的 bot 的 token 会通过。文案 MUST NOT 声称 token 被验过。

#### 场景:plist 漏配即中止
- **当** plist 的 `EnvironmentVariables` 漏设 `TG_BOT_INBOX` 或 `HANGAR_NOTIFY_CONFIG`
- **那么** `hangar-notify check --from-plist` 非零退出,部署不继续

### 需求:所有加载 pilot 的入口都能解析到同一配置
系统 SHALL 保证加载 pilot 的**每一个**入口都能拿到 notify 配置:launchd daemon,以及运维 shell 的 `hangar run <app>`。

`HANGAR_NOTIFY_CONFIG` 的约定默认路径使未显式设该变量的入口也解析到同一份;`TG_BOT_<APP>` 须在每个入口的环境里存在。仅给 daemon plist 配 env 而 `hangar run` 拿不到,MUST 视为部署缺陷(手跑会静默无通知)。

#### 场景:手动 run 也能发通知
- **当** 运维在与 daemon 同环境下手跑 `hangar run inbox`
- **那么** resolver 解析到与 daemon 相同的 `channels.yaml` 与 `TG_BOT_INBOX`,通知照常

### 需求:脊柱零改动——core 不认识通知
- `@hangar/core` MUST NOT `import` `@hangar/notify`。
- `RunContext` MUST NOT 长出 `notify`;`SpecSchema` / `app.yaml` MUST NOT 出现 `notify` / `lane` / `channels` 等键。
- core MUST NOT 经手任何 bot token —— `${ENV}` 插值只发生在 `@hangar/notify` 内。
- `@hangar/notify` MUST NOT 读写 `hangar.sqlite`,MUST NOT 新增第 5 张表(守 #3);它无需任何持久状态。
- 投递 SHALL 内联发生在 pilot 的 `run()` 内;系统 MUST NOT 把 `RunEvent` 当作投递队列(承 D5/R2)。

#### 场景:不变量 #1 可被机械检查
- **当** 在 `packages/core/src` 全文搜索 `notify` / `lane` / `channels`
- **那么** 零命中

### 需求:密钥不入日志
- 插值后的 bot token MUST NOT 被 `@hangar/notify` 记入任何日志,MUST NOT 出现在任何返回给调用方的诊断字段里(只返回 `varName`,不返回值)。
- 调用方 SHALL 在自己的 logger redact 名单里逐个枚举自己用到的 `TG_BOT_<APP>`(pino 不支持 key 后缀通配),**并 SHALL 一并 redact `botToken` 键(及 `*.botToken`)**——`resolve()` 把密钥以 `{ botToken, chatId }` 返回,`botToken` 是密钥的**另一表示**;仅 redact env 变量名挡不住「调用方日志记录了返回的 `Destination` 对象」这条路(CodeRabbit review 发现)。`@hangar/notify` **不导出**共享 redact 清单——只有单个 app 在场时,共享清单是死条目 + 反向发布耦合。

#### 场景:诊断不泄密
- **当** token 形状非法被 resolver 拒绝
- **那么** 返回给调用方的是 `{ reason, varName }`,不含 token 值;调用方据此记 ERROR
