## 0. 先答两个门(答不出就停,别写代码)

- [x] 0.1 **不变量 #3 的门**:本变更是否加库/加表/加进程?答:**不加**——`@hangar/core` 与那 4 张表零改动;pg 是**域存储**,由 pilot 自己连,与脊柱的 SQLite 无关。
  - **「不加进程」指的是不加常驻进程。** 本变更确实新增一个可执行文件 `hangar-pgconfig`,但它是**部署期跑一次、跑完就退**的 preflight,与 `hangar doctor` 同类,不是第 2 个 daemon、不监听端口、不与任何东西通信。不变量 #3 防的是「一个 host 上冒出第二个长驻进程 + 第二份状态」,一次性 CLI 不触发它。**若哪天它长出 `--watch` 或常驻模式,本门即失守。**
  - 机械守卫见 3.1–3.2:`packages/core/src` 零 pg 概念、本包零驱动/零 core 依赖,都是会红的测试而不是承诺
- [x] 0.2 **过早抽象的门**:此刻真实消费者只有 inbox 一家。**据此本变更不发 npm、不做插件化、不预留第二个数据库类型**(包 `private: true`,由消费方以 `file:` 兄弟依赖接入);共享层的价值要等第二个 pilot 才兑现,这一点已在 proposal 的出口闸里诚实记账。**若第二个 pilot 迟迟不来,正确动作是把本变更回退成「inbox 自己那份 compose」,不是给它加能力**

## 1. `@hangar/pgconfig`:纯解析器(零驱动、零 IO 副作用于加载期)

- [x] 1.1 新建 `packages/pgconfig` 骨架:**不 import `@hangar/core`、不 import `pg`/任何驱动**;运行时依赖只有 `yaml` + `zod`(与 `@hangar/notify` 同版本)
- [x] 1.2 `databases.yaml` 的 zod schema(**strict**,拼错的键要响亮失败而非当缺字段):`password` 必须匹配 `/^\$\{[A-Z0-9_]+\}$/`(fail-closed 拒明文);`host`/`database`/`user` 去空白后非空;`port` 为 `1..65535` 的**整数**,缺省 5432 —— 非法值必须死在部署期的 preflight,不是 pilot 热路径上驱动内部那句无关的报错
- [x] 1.3 **返回形状只有一种**:`resolve(app) → PgTarget | undefined`(热路径),诊断走单独的 `resolveWithReason(app)` 判别联合。别让一个返回位有时是目标、有时是诊断对象
- [x] 1.4 `${ENV}` 插值:**空串/纯空白单独判定**(视作缺失),否则会产出「用户名对、密码空」的目标,比缺配置更难诊断。**密码本身不做 trim** —— 首尾空白可能就是口令的一部分
- [x] 1.5 惰性读一次;**memoize 的是按路径缓存的「已解析文件」,不是插值结果**(否则先跑的 env 会替后跑的定答案,`check --from-plist` 随即失效);**不在模块加载期同步读**;**不 `delete process.env`**
- [x] 1.6 **绝不抛**:文件缺失/不可读/YAML 错/schema 不合法/无条目/env 缺失/空串 → 全部 `undefined`。schema 失败**只回固定 reason 码**,MUST NOT 回显校验库原文——那会把被拒的明文密码原样带出来。**resolver 自己不打日志、不引 logger**
- [x] 1.7 self-check(`resolve.test.ts` + `invariants.test.ts` + `cli.test.ts`):上述每条 + `check()` 按**传入** env 校验 + 环境变了答案要跟着变 + `apps` 为空要响亮失败 + 原型链上的 key(`constructor`/`__proto__`/…)也算「无条目」而不是抛 + 失败的读**不**进缓存(否则 daemon 跑几天,运维修好配置也回不来)+ 密码值不出现在任何诊断/报告的序列化结果里。**不在此写用例个数——加一条就过期**
- [x] 1.8 **`cli.ts` 必须自己有测试。** 一开始没有,于是六个变异全活:CLI 把密码打到 stdout、`--from-plist` 合并 `process.env`(正好恢复了这条需求要防的「shell 里绿、daemon 里瞎」)、删掉 `HANGAR_PG_CONFIG` 存在性检查、未知子命令退 0、`check` 永远退 0、删掉「未验连通性」那句 —— 每一条都对应一句已经写进 spec 的 normative。`--from-plist` 靠 macOS 独有的 `plutil`,故测试**造一个假 `plutil` 挂到 PATH**,让 spawn→解析→过滤→选 env 这条真路径在 Linux CI 上也真跑
- [x] 1.9 **三条只有跑起来才看得见的洞**(静态读代码看不出来,序列化返回值也看不出来):
  - **YAML 警告会把出错源码行打到 stderr** —— 返回值仍是干净的固定 reason 码,所以「密码永不外泄」这条在只检查返回值的验证下是**假成立**的。解析时降日志级别到只报错误。验证它必须捕获**子进程的 stderr**,而且那个子进程**不能是 CLI** —— 警告是异步的,`process.exit()` 会在它 flush 之前退出,用 CLI 去验会得到一个即使撤掉修法也照样通过的测试
  - **`apps.__proto__` 被校验库静默丢弃** —— 那条 app 的明文密码从未被校验,而 `check` 报绿。改成整份拒绝:半载入比拒绝危险
  - **`--from-plsit`(拼错一个字母)原本被忽略** —— 于是用运维自己的 shell 环境跑完并退 0,正是这个 flag 存在的全部理由被绕过。参数解析改严:未知参数一律退 2
- [x] 1.10 **变异验证的判据要能区分「真红」与「文件根本没加载」** —— 本轮有两次假红:一次是我写的正则括号不配对让整个测试文件加载失败,一次是变异 `import 'better-sqlite3'` 触发的是模块解析失败而不是守卫。判据改成「**总测试数不变** 且 fail>0」,并在每轮变异前先确认基线是满分

## 2. preflight:响亮在部署期,且在 daemon 的 env 里

- [x] 2.1 `hangar-pgconfig check` bin:读 → 插值 → 校验。失败非零退出,指明 app 与变量名,**不带值**。CLI 契约按 `CLAUDE.md`:日志→stderr、报告→stdout、`--json` 结构化、退出码 `0`/`1`/`2`;未知子命令打帮助退 2;`apps` 为空判失败(文件在却什么都没配,与「指错文件」不可区分)
- [x] 2.2 `check --from-plist <path>`:解析 plist 的 `EnvironmentVariables` 并**只**用它校验。**这是防「shell 里绿、daemon 里缺变量」的关键**,部署步骤必须用这条而不是裸 `check`。
  - plist 必须**显式声明** `HANGAR_PG_CONFIG`,缺失即退 1。注意这是**存在性要求,不是一致性比对** —— 配置路径本就由这个值推出,再拿读到的路径与它比是自证同一性、恒真。要防的是「没声明 → 退回约定默认路径 → 校验的不是 daemon 会读的那个文件」
- [x] 2.3 `check` 文案 MUST NOT 声称验过连通性或凭据有效性(它只做离线形状校验)

## 3. 不变量守门(机械可查)

- [x] 3.1 `packages/core/src` 零 `postgres` / `databases.yaml` / `pgconfig` 命中,由 `invariants.test.ts` 常驻守着(不变量 #1 的回归守卫)。**刻意不搜裸 `pg`**:它会命中 `pgconfig` 以及任何含这两个字母的词,那种检查要么永远红、要么被训练成忽略
- [x] 3.2 `packages/pgconfig` 对 `@hangar/core` 无 import、不 import 任何驱动、不 import socket/HTTP 模块、不用 `fetch`、不碰 `better-sqlite3`、源码内无 DDL;运行时依赖恰好是 `yaml` + `zod`。同上,是测试不是承诺
- [x] 3.3 pgconfig 的实现**没有触碰 `packages/core`**(本 PR 里 core 的改动全部来自 `upgrade-node-24`;唯一例外是 `cli.test.ts` 的 pin 门改成发现式,好让新包自动被纳入 node 下限校验——那是版本变更的收尾,不是 pg 的需要)

## 4. 部署物(是模板,不是运行时职责)

- [x] 4.1 `packages/pgconfig/deploy/docker-compose.yml`:一个 `postgres:16`,**绑 `127.0.0.1`**(不对外、Tailscale/LAN 不可达——沿用 inbox 现有那份的安全姿态),数据卷路径显式(不用匿名卷:它会在某次 `down -v` 里静默消失),superuser 口令从环境读、不写进这个进 git 的文件
- [x] 4.2 建号 SQL 模板(`roles.sql`):每 app 一个 role(`NOSUPERUSER NOCREATEDB NOCREATEROLE`)+ 一个 database。**`REVOKE CONNECT ... FROM PUBLIC` 那步不能省** —— postgres 默认给 `PUBLIC` 授了 CONNECT,不收掉的话「每 app 一个库」只是命名习惯而非隔离。**注明这是约定,由 pg 执行;hangar 不跑它、不校验、不保证**
- [x] 4.3 `deploy/README.md`:写明 hangar **不**管理这个容器(不起、不建号、不备份、不监控),以及「不声称 pilot 间隔离」那条边界——具体到 catalog 里库名/角色名藏不住、同 uid 进程能读到 `databases.yaml` 指向的一切、拿到 superuser 口令即绕过全部
- [x] 4.4 备份责任归属写清:共享实例的备份是**部署层**的事(起容器的人负责),不在任何 pilot 的 DoD 里 —— 否则会出现「谁都以为对方在备份」

## 5. inbox 接入(改动在 inbox 独立 repo)

> **⚠️ 2026-07-29 owner 决定:不做。pilot 允许自己配连接方式,inbox 继续用 `.env` 的 `DATABASE_URL`。**
> `service-bootstrap/spec.md:9`(P0 必需变量仅为 `DATABASE_URL`、缺失即 fail-fast)因此**不改**。
>
> **后果要认:`@hangar/pgconfig` 自此没有任何消费者。** 没有 pilot 调 `resolve()`,`databases.yaml`
> 不需要放(§6.5 也随之作废),`check` 校验的是一个没人读的文件。**这个包成了建好但无人用的代码。**
>
> **但本变更并非白做** —— 真正兑现价值的是**共享实例本身**,而那与 resolver 无关:容器 3→1、
> 主机端口 3→1、备份路径归一(§6.1–6.4 + §7.1)。**该被重新评估的是 pgconfig 这个包,不是共享库这件事。**
>
> 待定(不在本变更内):pgconfig 留着等第一个真想用它的 pilot、还是删掉。按不变量 #2 的精神
> (「inbox 用不到 = 不许进脊柱」——它不在脊柱内,故不直接适用,但同一条判据成立),**倾向:
> 若到下一个 pilot 接入时仍无人调用,就删。** 现在不删,是因为它的 `check --from-plist` 今晚
> 刚随 notify 一起改过、且那套 preflight 思路对后来者有参考价值

- [x] 5.1 ~~inbox 连接串改用 `resolve('inbox')`~~ —— **hangar 侧决定不做**(见上),但**已作为提案交给 inbox 自行决定**:[inbox-pilot#56](https://github.com/HerbertGao/inbox-pilot/issues/56)。若 inbox 采纳,由它自己出 OpenSpec 变更;若关闭,pgconfig 的去留按上面那条判据处理。附带发现:即便要做也有一处任务表没提的现实约束——`prisma migrate deploy` / `generate` 走 schema 的 `env("DATABASE_URL")`,是 CLI、不经应用代码,resolver 够不着;届时要么留 `DATABASE_URL` 给 CLI(两个来源会漂移),要么另给一个从 resolver 导出连接串的入口
- [x] 5.2 ~~`file:../hangar/packages/pgconfig` 兄弟依赖~~ —— 随 5.1 作废,inbox 不依赖本包
- [x] 5.2b **`pnpm install --frozen-lockfile` 装不动 —— 已解决**(`pnpm-workspace.yaml` 加 `- '!apps/inbox'`)。
  - **原诊断错了,连带写错了修法方向。** 原文说「lockfile 照开发机上那个 checkout 生成、生产机上内容不同」,由此推出「这是生产机特有的问题」。实测:**开发机上跑 `--frozen-lockfile` 报的是一模一样的 16 个依赖**。真实成因是提交的 lockfile 里**根本没有 inbox 的任何条目**(`grep -c inbox pnpm-lock.yaml` = 0,importers 只有 `.` / `apps/heartbeat` / `packages/*`)—— 因为 lockfile 由 **CI/dependabot 生成**,而那里 symlink 目标不存在、inbox 压根不可见。于是 lockfile 永远记录「无 inbox」拓扑,**任何能解析到 symlink 的机器都对不上**,与开发机/生产机之别无关
  - 修法因此也不同:不需要「把 `apps/*` 移出 workspace」,也不需要在生产机上接受 `--no-frozen-lockfile` 的 lockfile 漂移。inbox-pilot **自带 `pnpm-lock.yaml` 与 `node_modules/.pnpm`**,是完全独立的 pnpm 项目,它进本仓 workspace 是 `apps/*` glob 的意外,不提供任何东西。排除掉即可
  - 验证:开发机 `--frozen-lockfile` 通过且 lockfile 零改动;`typecheck`/`test`/`build` 全绿;`hangar doctor` 仍报 `inbox: spec ok / pipeline ok / enabled true`(app 加载走 `HANGAR_APPS` + `app.yaml` + `dist/pipeline.js`,与 workspace 成员身份无关);inbox checkout 的 `node_modules` 与 `dist` 未被触碰
  - 防回归:`scripts/check-workspace-members.mjs`(接进 `pnpm test`)钉住「被 git 忽略的目录不得是 workspace 成员」。**这条在 CI 上恒过**(那里没有 symlink)——它保护的是本地与生产机,这是不变量的形状不是缺陷。Phase 2 接第二个 pilot 时会原样再踩一次,故钉成可跑的检查而不是注释
  - 注:5.2 的 `file:../hangar/packages/pgconfig` **不受影响** —— `file:` 按路径解析,本就不需要 workspace
- [ ] 5.3 inbox 侧 `docker-compose.yml` / `data/postgres` 是否退役,由 inbox 决定;hangar 不代为删除

- [x] 5.4 ~~**⚠️ ai-radar 仓库与生产已不一致 —— 本次合并造成的,必须由 ai-radar 自己收口**~~ —— **已收口**(ai-radar#104,merge `d4a9e62`,2026-07-31)
  - 现状:生产 `~/ai-radar/docker-compose.yml` 已移除 postgres 服务、接入 `pgnet` 外部网;**但 ai-radar 仓库那份仍定义着 postgres 服务**。任何人从仓库全新部署都会起一个 postgres 去抢 5432 —— 抢不到则起不来,抢到则两份数据分裂
  - 好消息:ai-radar 的 CI 只 build 镜像(`docker-image.yml`),没有会覆盖 compose 的部署流水线,故生产不会被自动打回
  - **不能顺手提交**:改动撞到 ai-radar 自己的规范正文 —— `openspec/specs/platform-foundation/spec.md:13` 有一条场景「**当** 检视 `docker-compose.yml` 的 postgres 服务镜像 …**那么** 镜像为 `pgvector/pgvector`」。移除该服务后这条场景无法被检视,规范与实现即刻矛盾。按 ai-radar 自己的流程要走变更提案(改规范再改代码),不是一次 drive-by commit
  - 补丁脚本已留存(带断言:仓库比生产多一个 `mr-browser-worker`,depends_on 是 3 处不是 2 处 —— 直接套用生产那份会漏改它)
  - 另注:生产那份 compose 本就比仓库旧(缺 `mr-browser-worker`、cloudflared digest 未钉)。收口时**只搬「移除 postgres」这一条**,别顺势把生产拉齐到仓库版——那会引入没打算做的变更
  - **ai-radar 侧已收口(ai-radar#104,merge `d4a9e62`,2026-07-31)**:变更 `allow-shared-postgres-instance` 把规范从「compose 必须自带 postgres」改成「两种 DB 拓扑,默认不起 postgres」,compose 拆成拓扑中立基座 + `localdb`/`shared-db` 两个 overlay(在 `.env` 用 `COMPOSE_FILE` 选)。**本条关心的那个风险已消失**:核过合并后的基座里无 postgres 服务、无 `postgres_data` 卷,不设 `COMPOSE_FILE` 时不起 DB、应用连不上响亮失败 —— 从仓库全新部署不再会去抢 5432
  - **剩下的是 ai-radar 自己的生产收口**(其 tasks §4.2–4.6:推三份 compose 到 `~/ai-radar/`、`.env` 追加 `COMPOSE_FILE=…shared-db`、`--profile app up -d`、旧容器暂不删)。**归属在 ai-radar,不挡本变更归档** —— 生产现跑的手改版已在共享实例上,拓扑正确,只是尚未换成仓库那份表达。注:owner 拍板生产收口时**一并上 `mr-browser-worker`**(生产 `MR_SCRAPE_ENABLED=true` 却没有该服务),故上面「别拉齐」那句在该服务上被有意豁免,cloudflared digest 仍不动
  - 顺带印证了 7.2 的承重:ai-radar `DEPLOY.md` 现明写「接入拓扑下本仓不起、不建号、**不备份**、不监控外部实例,备份归起该容器的人」

## 6. 生产迁移 runbook(ts.mac-mini)

> **§6.1–6.4 于 2026-07-29 完成,全程零中断** —— 新实例与现役 5433 并存,inbox 仍在用旧库。
> 落点:`~/hangar-pg/`(compose + roles.sql + `.env` 0600 + `data/postgres` + `backups/`)。

- [x] 6.1 共享容器已起:`hangar-pg`(postgres 16.14),`127.0.0.1:5434`。核对过**只绑 loopback**(`lsof` 无 `0.0.0.0`)、数据卷落在显式路径 `~/hangar-pg/data/postgres`(非匿名卷)、healthcheck 报 healthy。superuser 与 `PG_PW_INBOX` 在生产机上 `openssl rand` 生成、直接写进 0600 的 `~/hangar-pg/.env`,未经任何中转
- [x] 6.2 `pg_dump -Fc` 完成:3.1M,`pg_restore -l` 数出 **6 条 `TABLE DATA`** 与源库 6 张表对上(只看文件大小不够——空壳 dump 也有大小)。源库基准行数已留档:`_prisma_migrations` 6 / `digest_items` 2022 / `mail_accounts` 3 / `mail_actions` 2098 / `mail_classifications` 2098 / `mail_messages` 2098
- [x] 6.3 role + database 按 `roles.sql` 建好(`inbox`/`inbox`)。**没有只看命令返回码就算过** —— 逐条查实:role 三项属性全 `f`;`PUBLIC` 对 `inbox` 库的 `CONNECT` 已为 `f`;`inbox` 自己为 `t`;并做**反证**——临时造一个 role,确认它对 `inbox` 库 `CONNECT` 为 `f`(这条才真正证明 REVOKE 生效,而不是「命令没报错」)
- [x] 6.4 restore 完成,**六张表行数逐表一致**。另外查了三件行数看不出来的:① `pg_sequences` 为空(Prisma 用字符串主键,不存在序列没跟过来导致主键冲突的那类坑);② 对象 owner 全是 `inbox`(restore 用 superuser 走容器内 socket + `--role=inbox`,**口令因此完全不必出现在任何进程参数里**);③ 端到端——用 `inbox` 自己的口令从 `127.0.0.1` 连上并 `select count(*)` 得到 2098
  - ⚠️ **源库是活的,这份数据到切换时一定已经过期。** 本次核对时恰好零漂移(那一段时间没有新邮件),不代表切换时也是。见 6.6 新增的那条
- [x] 6.5 ~~放 `databases.yaml` + preflight~~ —— **随 §5.1「不做」一并作废**:没有消费者读 `databases.yaml`,放了也只是一个没人读的文件。`check --from-plist` 的改进本身仍在(今晚随 notify 一起做的),只是暂时无处可用
  - 改自原文「加进 daemon plist 的 `EnvironmentVariables`」:生产实测该 plist **根本没有 `EnvironmentVariables`**,密钥一直住在 `.env` 里,且那份 `.env` 还服务 pilot 自己的入口 —— 搬进 plist 会制造第二个密钥落点
  - `check --from-plist` 已改为**跟读 plist 声明的 `DOTENV_CONFIG_PATH`** 并按 plist 覆盖文件的次序合并,故密钥住 `.env` 也校验得到。前置:`add-shared-notify` 的 6.7(plist 里声明 `DOTENV_CONFIG_PATH`)先落
> **2026-07-29 夜:三个实例已合并到一个 `127.0.0.1:5432`。** 停机窗口约 12 分钟(21:42–21:54 本地),
> 两个租户的数据都已迁入并逐表核过。**但这次走的是「先把连接串指过去」,不是 6.6 说的「切到 resolver」**
> —— §5.1 还没做,resolver 那条路还没接。合并与 resolver 是两件事,别把 6.6 当作已完成。

- [x] 6.6 ~~切 inbox 到 resolver~~ —— **resolver 那半随 §5.1 作废**。**但库的搬迁真发生了且已生效**:inbox 的 `DATABASE_URL` 现指向共享实例(`postgresql://inbox:…@localhost:5432/inbox`),daemon 重启后 12:48 那轮 poll `completed`,`pg_stat_activity` 里确认有 `inbox` role 的连接。**观察一个完整 digest 周期仍未完成**——与 `add-shared-notify` §6.6 是同一个观察窗口(P0 即时通知 + 每日摘要各真发过一轮),那条仍开着
  - **合并已完成的部分**:inbox 的 `DATABASE_URL` 现在指向共享实例的 `inbox` 库(`postgresql://inbox:…@localhost:5432/inbox`),daemon 重启后 12:48 那轮 poll `completed`,并确认 `pg_stat_activity` 里有 `inbox` role 的连接。**仍是 `.env` 里的 `DATABASE_URL`,不是 `resolve('inbox')`**
  - **还剩的部分**:§5.1 落地后,再把来源换成 resolver,那次才是本条真正要观察的切换
  - ⚠️ **切换前必须先停 daemon、再重做一次 dump/restore。原 runbook 漏了这条。** 从**活库**取的 dump 到切换之间收到的邮件**会静默丢失**——库里没有、而 Gmail 那边已标记处理过,不会再被拉一次。本次合并已按此执行:停 daemon → 停 ai-radar 应用服务 → 取最终 dump → 再动
  - 正确次序:停 daemon → 确认无活跃 run → `pg_dump` 重取 → 重建 + restore → 逐表核行数 → 切连接串 → 起 daemon
- [ ] 6.7 **旧容器与其数据卷不得删除** —— 现状:`inbox-pilot-postgres-1` 与 `ai-radar-postgres-1` 均为 `Exited (0)`,**容器与卷都在原地**(ai-radar 的 `postgres_data` 卷未删,其 compose 里那段服务定义改成了注释、恢复只需还原)。观察期通过后再退役,且退役前再留一份 dump
- [x] 6.8 回滚演练 —— **决定不做**(2026-07-29,owner 拍板)。准备是齐的:两份 dump、两份 compose `.bak-precutover`、两份 `.env` 备份、旧容器与卷全部原地保留。跳过的是「真跑一遍」。
  - **代价(要认)**:真需要回滚时是第一次走这条路,而且多半是在出事的当口。未经证实的环节有三个——① `docker start` 一个被中途停掉的旧 postgres 是否真能起回 healthy;② 还原 compose 备份后 `up -d` 是否真能重建出原样(ai-radar 那份里 postgres 服务被改成了注释,靠人还原);③ inbox 的 `.env` 换回旧 URL + 重启 daemon 是否一次成
  - **但这条的价值窗口本来就在快速缩小,这是决定不做的实际理由**:旧库的数据冻结在切换那一刻。切换一天后回滚 = 丢一天的邮件与 ai-radar 抓取;一周后就是丢一周。**「回滚到旧容器」在头几个小时之后就不再是回滚,而是一次有数据损失的事故处置**
  - **真正该保证的那条路已经被证实过**:出事时的实际恢复动作是「从 dump 恢复进共享实例」,而今晚的迁移本身就是这条路走了两遍(两个库各一次 restore + 逐表核行数)。所以**被跳过的是短保质期的那条,被验证的是长期有效的那条** —— 记在这里,免得日后把「没演练回滚」读成「恢复能力未经验证」
  - 后续:§6.7 清理旧容器时,本条的准备物随之失效;届时唯一的恢复依据就是 `~/hangar-pg/backups/` 里的 dump 与**尚不存在的**定期备份(见 §4.4 备份归属:起容器的人负责)。**清理前先把定期备份真跑起来**

## 7. 出口闸

- [x] 7.1 **第二个租户已接入:`ai-radar`**(2026-07-29)。运维面**净减少**而非重复:容器 3→1(退役 `inbox-pilot-postgres-1` 与 `ai-radar-postgres-1`)、主机端口 3→1(5433/5434/5432 → 只剩 5432)、备份路径归一到 `~/hangar-pg/backups/`
  - ⚠️ **它不是 hangar pilot,是一个独立的 docker-compose 应用。** 本条原文写的是「第二个真实需要关系库的 **pilot**」;ai-radar 是 ROADMAP Phase 2 的 pilot 候选,但今天它只是共享实例的第二个**租户**。共享层被第二个真实负载压过了、且运维面真的收敛了 —— 这是本闸要问的东西;但「第二个 pilot 逼出通用脊柱」那件事**没有**因此发生,别把两者当成一回事
  - 共享实例的镜像因此从 `postgres:16` 换成 **`pgvector/pgvector:pg16`**:ai-radar 用到 `vector` 扩展(已确认装着、2 个 `vector` 列在用)。**共享实例的镜像由所有租户需求的并集决定**,pgvector 是官方镜像的超集,inbox 那种普通用法照跑。这条要写进模板,否则下一个带扩展的租户会重新发现一遍
- [ ] 7.2 连续 7 天共享实例无事故:无连接耗尽、无跨库越权、备份真的在跑
  - ⚠️ **「备份真的在跑」实测为否(2026-07-31)**:`~/hangar-pg/backups/` 里只有 07-29 切换时的一次性 dump,`crontab` 与 `~/Library/LaunchAgents/` 里**没有任何备份任务**。切换后写入的数据目前**没有任何备份覆盖**
  - 这条现在比切换前更承重:ai-radar 侧已走完自己的变更(`allow-shared-postgres-instance`),其仓库 compose 不再自带 postgres、规范里明写「本编排不备份外部实例、归起该容器的人」⇒ **两边都不再有第二个人在看它**。owner 已拍板它不阻塞 ai-radar 的生产收口,但归属留在本条
