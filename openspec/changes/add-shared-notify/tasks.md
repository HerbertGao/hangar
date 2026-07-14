## 1. @hangar/notify:配置解析器(纯逻辑,无传输、无 IO 副作用于加载期)

- [x] 1.1 新建 `packages/notify` 包骨架(**不 import `@hangar/core`、不 import 任何传输库**);运行时依赖只有 `yaml`(复用仓里已有的 `yaml@^2.9.0`)+ `zod`(已有)
- [x] 1.2 `channels.yaml` 的 zod schema:`apps: { <appId>: { <lane>: { bot: string, chat: string } } }`,lane ∈ `private | broadcast`。`bot` MUST 匹配 `/^\$\{[A-Z0-9_]+\}$/`(fail-closed 拒明文 token);`chat` MUST 非空
- [x] 1.3 `resolve(app, lane) → { botToken, chatId } | undefined`,经 `createResolver(app)` 绑定 app id(pilot 传,core 零改动)
- [x] 1.4 `${ENV_NAME}` 插值:从 `process.env` 取 `bot` 占位对应的值。**空串单独判定**(`.trim().length === 0` → 视为缺失);token 形状校验用 `\d{6,}:[A-Za-z0-9_-]{20,}`(**对齐 inbox 的 `redactError.ts:24`,不得更宽**)
- [x] 1.5 **惰性读取一次并缓存**:首次 `resolve()` 读 `channels.yaml`(路径来自 `HANGAR_NOTIFY_CONFIG`,带约定默认路径),进程内 memoize。**不在模块加载期同步读**
- [x] 1.6 **绝不抛**:文件缺失/不可读/YAML 语法错/schema 不合法/无条目/env 缺失/空串/token 形状非法 → 全部返回 `undefined`。值**存在但非法**时,返回 `{ reason, varName }` 供调用方记 ERROR(**resolver 自己不打日志、不引入 logger**)
- [x] 1.7 **不 `delete process.env`**(负收益 + 破坏第二次 resolve,见 design D11)
- [x] 1.8 self-check(`resolve.test.ts`):断言 ① 无条目 → undefined ② env 缺失 → undefined ③ env **空串** → undefined(不产出空 token 目的地)④ token 形状非法 → undefined + `{reason,varName}` ⑤ **YAML 语法错 → undefined 不抛** ⑥ **文件缺失 → undefined 不抛** ⑦ 明文 token(非 `${ENV}`)→ schema 拒 ⑧ 同进程第二次 resolve 结果与首次一致(无破坏性副作用)⑨ 返回的 `{reason,varName}` 及任何错误文本里**不含 token 值**

## 2. preflight:「响亮」在部署期,且在 daemon 的 env 里

- [x] 2.1 `hangar-notify check` bin:读 `channels.yaml` → 插值 → 校验 `bot` 是已解析的 `${ENV}` → 校验 `chat` 非空。失败非零退出,指明 app/lane/变量名(**不带值**)
- [x] 2.2 `check --from-plist <path>`:解析 plist 的 `EnvironmentVariables` 并**只**用它校验(而非运维 shell 的 env),同时断言 plist 的 `HANGAR_NOTIFY_CONFIG` 与自己读的文件一致。**这是防「shell 里绿、daemon 里缺变量」假绿的关键**
- [x] 2.3 `check` 打印它解析到的 `channels.yaml` 路径 + 每个 `(app,lane)` 的解析结果(成功/失败原因)。**文案不得声称验过 token 有效性**(它只做形状+存在性离线校验)

## 3. 不变量守门(机械可查)

- [ ] 3.1 `packages/core/src` 全文搜索 `notify` / `lane` / `channels` **零命中**(不变量 #1;当前已零命中,回归守卫)
- [ ] 3.2 `packages/notify` 对 `@hangar/core` 无 import 依赖、不 import 任何传输/HTTP 库;不读写 `hangar.sqlite`、不新增表(#3);无常驻进程/容器

## 4. 分发:同机兄弟 checkout 用 file: 依赖

- [x] 4.1 inbox 经 `file:../hangar/packages/notify` 依赖它(hangar 与 inbox-pilot 是同机兄弟 checkout,已确认)——**不需 npm 发版**。发布 `hangar-notify` 到 npm **推迟**到第 2 个非兄弟仓(ai-radar 等)采用时

## 5. inbox 接入(改动在 inbox-pilot 独立 repo;传输不动)

- [x] 5.1 `telegramChannelFromConfig()`(`src/notify/telegram.ts:143`)改读 `resolve('inbox','private')` 拿 `{botToken, chatId}`,替换现在的 `config.TELEGRAM_*`。**「任一缺失 → undefined → 降级」逻辑保留**
- [x] 5.2 确认传输侧**零改动**:`createTelegramChannel` / `fetch` / `AbortSignal.timeout(10_000)` / `telegram-http-NNN` / `errorKind` / `renderTelegramText` / `sanitizeField` / 不设 `parse_mode` / `SEGMENT_MAX` —— 全部不动;**测试 fixture 不动**
- [x] 5.3 **wire-level 对拍(现在可通过)**:因传输不变,新旧发出的 `sendMessage` payload 应**逐字节一致**;构造一封含 `<`、`&`、换行的邮件断言之(这条验收在换传输方案里不可能通过,在本方案里成立)

## 6. 部署与切换(ts.mac-mini)

- [ ] 6.1 **先确认 `TELEGRAM_*` 当前在生产上的真实来源**(hangar root 无 `.env` → 大概率已在 daemon plist;查清楚再写 BREAKING 步骤)
- [ ] 6.2 daemon plist `EnvironmentVariables` 加 `TG_BOT_INBOX` + `HANGAR_NOTIFY_CONFIG`(plist 须**显式**设后者——`hangar-notify check --from-plist` 强制它存在;约定默认路径仅兜底 `hangar run` shell 入口,不覆盖 plist);保证 `hangar run inbox` 手动入口在同环境下也拿得到
- [ ] 6.3 放置 `channels.yaml`(inbox 的 `private` = `{ bot: "${TG_BOT_INBOX}", chat: "886699001" }`);考虑把 plist 模板 check 进 `deploy/`(仿 `packages/hangar-view/deploy/`)
- [ ] 6.4 **在 daemon 的 env 里**跑 `hangar-notify check --from-plist`,通过才继续
- [ ] 6.5 切 inbox 到新来源,发布
- [ ] 6.6 生产观察一个发布周期:P0 即时通知 + 每日 digest **各真发过一轮**,wire-level 对拍确认与旧版逐字节一致

## 7. 收尾:删旧路径 + 清文档债(观察期通过后才做)

- [ ] 7.1 `configSchema.ts` 下线 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`(含 `:106` 注释)
- [ ] 7.2 **`logger.ts` redact:删旧条目的同一次提交里加 `TG_BOT_INBOX` + `*.TG_BOT_INBOX` + `botToken` + `*.botToken`**(core pino 无 redact,只删不补 = 覆盖 1→0;`botToken` 是 resolver 返回密钥的对象键,须一并 redact——CodeRabbit review 发现。注:`TG_BOT_INBOX`/`botToken` 的**增**已在 group B 做,本 7.2 只做 `TELEGRAM_*` 的**删**);验证 `redactError.ts:24` 的形状正则仍捕获 bot token,且与 resolver 的接受形状对齐。**对齐的具体修法(review-loop round-1 Security 发现)**:`redactError.ts:24` 现为 `/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/`,leading `\b` 使嵌入式 token(如 `bot<token>/` 这类 URL 形态)漏刷;去掉 `\b` → `/\d{6,}:[A-Za-z0-9_-]{20,}/g` 使其与 resolver 无锚形状一致。(注:group B 不可达此路径——`errorKind` 只取 `err.name`;此为防御纵深预存弱点,随 7.2 一并修。)
- [ ] 7.3 `notifier.test.ts:84` 的 no-channel 触发从「子进程清空 `TELEGRAM_*`」改为「resolver 无 inbox 条目 / 指向空配置」(否则退役后清的是不存在的变量,**测试仍绿但断言已空**)
- [ ] 7.4 `.env.example` / `PROJECT_INIT.md` 同步为 `TG_BOT_INBOX=`
- [ ] 7.5 **inbox-pilot 自己的 OpenSpec 出 delta**:`notifications/spec.md:61`(触发条件措辞;「必须降级 skipped、禁抛未捕获异常」保持有效)、`:68`(chat id 改从 channels.yaml 读)、`service-bootstrap/spec.md:9`(`TELEGRAM_*` → `TG_BOT_INBOX`,仍可选)
- [ ] 7.6 **docker-compose 部署路径出 delta**:挂载 `channels.yaml` + 注入两个 env,或显式声明该路径退役(`openspec/specs/deployment/`);**不留静默无通知的已规范部署**
- [ ] 7.7 全仓零命中断言:限定 `src/` + `openspec/specs/` + `.env.example` + 部署文件(**不含 `openspec/changes/archive/**`** 不可变历史)
- [ ] 7.8 清 hangar 文档债:`control-plane-channels.md` D9/D10/§10 与 `followups-command-write-path.md` A 表——记**分叉后的**修订,两半都要写清:① **inbox**:传输不换、只共享配置(附「为什么不换 apprise」的探针证据指针);② **广播组**(ai-radar / auto-developer / hostlens,多平台):apprise.js 仍是预期后端,按真实需求逐插件从上游长(Lark/企微/钉钉,D10 flywheel)——**apprise 价值与平台数正相关,inbox 与广播组分处曲线两端、结论相反**。`DESIGN.md §0` 的「通知」措辞改为「通知目的地去重靠脊柱外共享配置(`@hangar/notify` resolver),**传输与投递留 pilot 侧、不进 core**(广度型广播组可经 apprise.js 在 pilot 侧 fan-out)」
