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

- [x] 3.1 `packages/core/src` 全文搜索 `notify` / `lane` / `channels` **零命中**(不变量 #1;当前已零命中,回归守卫)
- [x] 3.2 `packages/notify` 对 `@hangar/core` 无 import 依赖、不 import 任何传输/HTTP 库;不读写 `hangar.sqlite`、不新增表(#3);无常驻进程/容器(实测:运行时依赖只有 `yaml` + `zod`;import 只有 `node:fs`/`node:os`/`node:path` + CLI 的 `node:child_process`(读 plist))

## 4. 分发:npm 发布(@herbertgao/hangar-notify)

- [x] 4.1 ~~inbox 经 `file:../hangar/packages/notify` 兄弟依赖~~ → **改走 npm 发布**(原计划推迟到 ai-radar,被 CI 现实推翻):`@herbertgao/hangar-notify@0.1.0` 已发布;inbox 依赖 `@herbertgao/hangar-notify@^0.1.0`(registry)。file: 兄弟依赖会炸 inbox **每个** install 的 workflow(ci.yml + eval.yml)、unpinned-main lockstep、pnpm 快照 stale、跨仓 rename 破坏——故提前发版

## 5. inbox 接入(改动在 inbox-pilot 独立 repo;传输不动)

- [x] 5.1 `telegramChannelFromConfig()`(`src/notify/telegram.ts:143`)改读 `resolve('inbox','private')` 拿 `{botToken, chatId}`,替换现在的 `config.TELEGRAM_*`。**「任一缺失 → undefined → 降级」逻辑保留**
- [x] 5.2 确认传输侧**零改动**:`createTelegramChannel` / `fetch` / `AbortSignal.timeout(10_000)` / `telegram-http-NNN` / `errorKind` / `renderTelegramText` / `sanitizeField` / 不设 `parse_mode` / `SEGMENT_MAX` —— 全部不动;**测试 fixture 不动**
- [x] 5.3 **wire-level 对拍(现在可通过)**:因传输不变,新旧发出的 `sendMessage` payload 应**逐字节一致**;构造一封含 `<`、`&`、换行的邮件断言之(这条验收在换传输方案里不可能通过,在本方案里成立)

## 6. 部署与切换(ts.mac-mini)

> **⚠️ 本节原先整体假设「daemon 的 env 在 plist 的 `EnvironmentVariables` 里」—— 生产上不是这样。**
> 2026-07-29 实测 ts.mac-mini:`com.herbertgao.hangar-inbox.plist` **根本没有 `EnvironmentVariables` 这个 dict**;
> 它 `ProgramArguments` 跑的是 `~/hangar-inbox-daemon.sh`,env 由该脚本 `set -a; . ~/inbox-pilot-hangar/.env; set +a`
> 灌进来。下面各条已按真实形态改写。

- [x] 6.1 **`TELEGRAM_*` 在生产上的真实来源** = `~/inbox-pilot-hangar/.env`(被 `~/hangar-inbox-daemon.sh` source),**不是 plist**。且实测该 `.env` 里 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` **已不存在**、`TG_BOT_INBOX` **已在** —— 切换事实上已经发生(见 6.5)
- [x] 6.2 env 落点是那份 `.env` 而非 plist。`TG_BOT_INBOX` 已在其中。**`HANGAR_NOTIFY_CONFIG` 目前未显式设置**,靠 `configPath()` 的约定默认 `$HOME/.config/hangar/channels.yaml`(`packages/notify/src/index.ts:81`)解析 —— 当前 daemon 与手动入口都落在同一文件上,故可用;但「显式声明」那层保险没有(见 6.4 的残留)
- [x] 6.3 `channels.yaml` 已在 `~/.config/hangar/channels.yaml`(**0600**),`check` 报 `ok inbox/private`。**未做**:把部署模板 check 进 `deploy/`(仿 `packages/hangar-view/deploy/`)—— 且模板该照 wrapper-script 形态写,不是 plist 形态
- [x] 6.4 **`--from-plist` 原先在本部署形态下用不了**:实测退 1、`plist has no EnvironmentVariables dict`。**它是响亮失败、不是假绿**(D6 守卫成立),但 preflight 得能用。**已改代码而非改写 runbook**:`--from-plist` 现在**跟读 plist 声明的 `DOTENV_CONFIG_PATH`**,按 plist 覆盖文件的次序合并(见 `shared-notify` spec 的 preflight 需求)。于是 6.7 切完 plist 后,preflight 就是一条命令、无需手抄 wrapper。
  - 临时替代(6.7 之前可用):`env -i HOME=... bash -c '…source .env…; hangar-notify check'` 复刻 wrapper。实测 `ok inbox/private` 退 0。**不要在交互 shell 里直接 source** —— 会混进 shell profile 的 env,正是 D6 要防的 shell-green/daemon-blind
- [x] 6.5 已切:`.env` 只剩 `TG_BOT_INBOX`,inbox-pilot `src/logger.ts:43` 注明「`TG_BOT_INBOX` 是当前生效的 bot token 来源(resolver 从 env 读取)」。生产 inbox-pilot HEAD `6ceea50`
- [ ] 6.6 生产观察一个发布周期:P0 即时通知 + 每日 digest **各真发过一轮**,wire-level 对拍确认与旧版逐字节一致。
  - **现有证据只到「没坏」,不到「发过」**:notifier 的成功路径(`outcome: 'sent'`)**不打日志**,只有 skipped/failed 打(`src/notify/notifier.ts:119/136/151/163`)。生产日志里 `telegram|notify|digest` 命中 **0 行** —— 这证明**没有降级也没有失败**(真无凭据会打 `notify-digest-skipped-no-channel`),但**不证明真发出去过**
  - 正面证据得从别处取:Telegram 那头真收到,或查 RunEvent 里的 notify 动作。run 本身健康(poll 每 3 分钟、近 5 次全 `completed`)

- [x] 6.7 **生产 env 形态归一:plist 只声明非密钥变量,wrapper 脚本退出链路** —— **2026-07-29 12:00 UTC 已切换**,切换后两轮 poll 均 `completed`,`tasks 4 / apps 2` 与切换前一致,日志无新错误
  - 实操中发现三件 runbook 原文没写对的(已回填 `deploy/README.md`):
    - ① **切换当时生产装的是 npm 上的 0.1.0,不支持 `DOTENV_CONFIG_PATH`** —— 拿它跑 `--from-plist` 会报 `TG_BOT_INBOX` 缺失,那是**假红**。切换当时用等价检查(`node --import dotenv/config` + pilot 自己的 dotenv + 新 plist 的 env 跑真正的 `check`)→ `ok inbox/private` 退 0。**已于同日发 0.2.0 并升到生产,`--from-plist` 现可直接用**(见 6.8)
    - ② **wrapper 脚本不该 `mv`** —— 换完 plist 它自然就不在链路里了,留着能让回滚只需换回一个文件;`mv` 反而在「plist 已改、launchd 还持旧 job」的窗口里制造崩溃拉起失败
    - ③ **不该顺手 `git pull`** —— 生产落后 5 个提交(含 better-sqlite3 12→13 的 lockfile),一起拉进来就无法确定问题出自哪一步。只 scp 那一个 plist,把改动隔离成单一变量
  - `TZ` 进 plist 的依据(生产实测):迟设会生效,但设之前那段用的是**系统时区**;现在看不出问题只因系统时区碰巧也是 `Asia/Shanghai`
  - `.env` 已从 0644 收到 0600(此前只有 `channels.yaml` 是 0600,而真 token 在那个 0644 的文件里)

- [x] 6.8 **`@herbertgao/hangar-notify` 0.2.0 已发布并升到生产**(2026-07-29)。生产 `check --from-plist` 现在直接可用,输出确认读了两个来源:`validating against plist EnvironmentVariables + …/.env` → `ok inbox/private` 退 0
  - **`pnpm update` 拿不到它**:`^0.1.0` 对 0.x 是 `>=0.1.0 <0.2.0`,匹配不到 0.2.0。得改 inbox-pilot `package.json` 的范围(已改,inbox-pilot `80222f6`),不是 update
  - inbox-pilot 侧验证:build 干净、**482/482 测试全过**;提交只带 `package.json` + `pnpm-lock.yaml`(该 repo 有 `reconcile-spec-drift` 的暂存 WIP,不能 `git add -A`)
  - 生产 install 打了 `Ignored build scripts: esbuild, prisma` —— **这正是「install 退 0 但产物没出来」的形态**,单看退出码会误判。逐条查实:prisma 生成的 client 与 `libquery_engine-*.node` 都在 pnpm 隔离布局下(`node_modules/.pnpm/@prisma+client@…/node_modules/.prisma/client/`,不是顶层 `node_modules/.prisma`);`new PrismaClient()` 真实例化成功。判据是**产物真在 + 真能实例化**,不是 install 退 0
  - daemon 未重启(它跑的是已加载进内存的模块,不受 node_modules 变动影响),poll 持续 `completed`
  - 目标形态:`plist(PATH / HANGAR_APPS / DOTENV_CONFIG_PATH / HANGAR_NOTIFY_CONFIG)` + `.env`(全部密钥,唯一落点) + `channels.yaml`。文件 4→3,少掉的是手写 shell —— runbook 里最容易与实际漂移的那类
  - 依据:pilot 自己 `import 'dotenv/config'`,而 dotenv 认 `DOTENV_CONFIG_PATH`(2026-07-29 在生产上 `env -i` 实测认)。wrapper 唯一职责(补 daemon cwd≠pilot 目录导致 dotenv 找不到 `.env`)因此被消掉
  - **不要把密钥搬进 plist**:`.env` 还服务 pilot 自己的入口(`prisma migrate deploy` / `account` / `eval:*`),搬进去 = 两个落点要人工同步
  - 顺手 `chmod 600 ~/inbox-pilot-hangar/.env`(现为 0644,而只含引用的 `channels.yaml` 反倒是 0600)
  - 验收:`hangar-notify check --from-plist <plist>` 直接退 0(不再需要 `env -i` 手抄);重启后 daemon 正常起、poll 照跑
  - 回滚:plist 换回 `ProgramArguments = [bash, hangar-inbox-daemon.sh]`(脚本先 `mv` 保留、别删)
  - **模板与 runbook 已 check 进 `deploy/`**(兑现 6.3 的未做项):`deploy/com.herbertgao.hangar-inbox.plist` + `deploy/README.md`。此前这份 plist 在仓里**一份副本都没有**,只活在那台机器上
  - ⚠️ **runbook 的第 0 步是一道必须先过的闸**:本次切换把 env 的注入时机从「进程启动前」挪到「pilot 模块求值时」,若 pilot 模块图里有谁在 `config.ts` 之前于顶层读 `process.env`,会拿到空值且**静默半坏**。第 0 步只做模块求值(无外部副作用)去证伪它;任一变量 `<MISSING>` 或抛错就**放弃切换**、继续用 wrapper(它在进程启动前灌 env,对顺序免疫)。**该探针尚未在生产上跑过**(1Password agent 掉线,SSH 与 git 签名同时不可用)

## 7. 收尾:删旧路径 + 清文档债(观察期通过后才做)

- [ ] 7.1 `configSchema.ts` 下线 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`(含 `:106` 注释)
- [ ] 7.2 **`logger.ts` redact:删旧条目的同一次提交里加 `TG_BOT_INBOX` + `*.TG_BOT_INBOX` + `botToken` + `*.botToken`**(core pino 无 redact,只删不补 = 覆盖 1→0;`botToken` 是 resolver 返回密钥的对象键,须一并 redact——CodeRabbit review 发现。注:`TG_BOT_INBOX`/`botToken` 的**增**已在 group B 做,本 7.2 只做 `TELEGRAM_*` 的**删**);验证 `redactError.ts:24` 的形状正则仍捕获 bot token,且与 resolver 的接受形状对齐。**对齐的具体修法(review-loop round-1 Security 发现)**:`redactError.ts:24` 现为 `/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/`,leading `\b` 使嵌入式 token(如 `bot<token>/` 这类 URL 形态)漏刷;去掉 `\b` → `/\d{6,}:[A-Za-z0-9_-]{20,}/g` 使其与 resolver 无锚形状一致。(注:group B 不可达此路径——`errorKind` 只取 `err.name`;此为防御纵深预存弱点,随 7.2 一并修。)
- [ ] 7.3 `notifier.test.ts:84` 的 no-channel 触发从「子进程清空 `TELEGRAM_*`」改为「resolver 无 inbox 条目 / 指向空配置」(否则退役后清的是不存在的变量,**测试仍绿但断言已空**)
- [ ] 7.4 `.env.example` / `PROJECT_INIT.md` 同步为 `TG_BOT_INBOX=`
- [ ] 7.5 **inbox-pilot 自己的 OpenSpec 出 delta**:`notifications/spec.md:61`(触发条件措辞;「必须降级 skipped、禁抛未捕获异常」保持有效)、`:68`(chat id 改从 channels.yaml 读)、`service-bootstrap/spec.md:9`(`TELEGRAM_*` → `TG_BOT_INBOX`,仍可选)
- [ ] 7.6 **docker-compose 部署路径出 delta**:挂载 `channels.yaml` + 注入两个 env,或显式声明该路径退役(`openspec/specs/deployment/`);**不留静默无通知的已规范部署**
- [ ] 7.7 全仓零命中断言:限定 `src/` + `openspec/specs/` + `.env.example` + 部署文件(**不含 `openspec/changes/archive/**`** 不可变历史)
- [ ] 7.8 清 hangar 文档债:`control-plane-channels.md` D9/D10/§10 与 `followups-command-write-path.md` A 表——记**分叉后的**修订,两半都要写清:① **inbox**:传输不换、只共享配置(附「为什么不换 apprise」的探针证据指针);② **广播组**(ai-radar / auto-developer / hostlens,多平台):apprise.js 仍是预期后端,按真实需求逐插件从上游长(Lark/企微/钉钉,D10 flywheel)——**apprise 价值与平台数正相关,inbox 与广播组分处曲线两端、结论相反**。`DESIGN.md §0` 的「通知」措辞改为「通知目的地去重靠脊柱外共享配置(`@hangar/notify` resolver),**传输与投递留 pilot 侧、不进 core**(广度型广播组可经 apprise.js 在 pilot 侧 fan-out)」
