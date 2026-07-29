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

- [ ] 5.1 inbox 的连接串来源从 `.env` 的 `DATABASE_URL` 改成 `resolve('inbox')`;**由 inbox 自己出 OpenSpec delta**
- [ ] 5.2 `file:../hangar/packages/pgconfig` 兄弟依赖(**不发 npm**,见 0.2)。注:`@hangar/notify` 当初因跨仓 CI 现实被迫提前发版,若本包也撞上同样的 CI 问题,再评估发版——**但不预先发**
- [ ] 5.2b **⚠️ 先解决这个,否则 5.1/5.2 在生产机上落不了地:`pnpm install` 在 ts.mac-mini 上装不动。** `upgrade-node-24` 的切换实测:`--frozen-lockfile` 报「specifiers in the lockfile don't match」,缺的十几个依赖全是 inbox-pilot 的。原因是 `apps/inbox` 是 symlink 出去的**外部 checkout** 而 `apps/*` 在 workspace 里 —— 提交的 lockfile 照开发机上那个 checkout 生成,生产机上内容不同,**永远对不上**;CI 反而能过,因为 runner 上 symlink 目标不存在。
  - 那次靠**跳过 install** 绕过去了(daemon/view 的依赖早已装好、没人用新包)。但 inbox 一旦以 `file:` 依赖 pgconfig,生产机就**必须**成功 install 一次,绕不过去
  - 可能的出路(未定,需要先想清楚):把 `apps/*` 移出 workspace、生产机改用 `--no-frozen-lockfile` 并接受 lockfile 漂移、或让 inbox 不经 workspace 而直接 `file:` 引用。**这是本变更上线的前置,不是收尾**
- [ ] 5.3 inbox 侧 `docker-compose.yml` / `data/postgres` 是否退役,由 inbox 决定;hangar 不代为删除

## 6. 生产迁移 runbook(ts.mac-mini)

- [ ] 6.1 起共享容器(4.1 的 compose),**与 inbox 现有容器并存**、端口不撞(inbox 线上用 5433,新实例另取)
- [ ] 6.2 `pg_dump` inbox 现有库,校验 dump 大小与表数
- [ ] 6.3 在共享实例里按 4.2 建 role + database
- [ ] 6.4 restore 进新库,**逐表核对行数**与 dump 一致
- [ ] 6.5 放 `databases.yaml` + 把 `PG_PW_INBOX` 加进 daemon plist 的 `EnvironmentVariables`;**在 daemon 的 env 里**跑 `check --from-plist`,通过才继续
- [ ] 6.6 切 inbox 到 resolver,重启 daemon,**观察一个完整 digest 周期**(P0 即时通知 + 每日摘要各真发过一轮)
- [ ] 6.7 **旧容器与 `./data/postgres` 在 6.6 通过之前不得删除** —— 那是唯一副本。确认后再退役,且退役前再留一份 dump
- [ ] 6.8 回滚路径:切回 `DATABASE_URL` → 重启 daemon → 旧容器仍在原状。**这条要在 6.6 之前先演练一遍**,别等真出事才第一次走

## 7. 出口闸

- [ ] 7.1 **第二个真实需要关系库的 pilot 接进来,且没有重复任何运维面**(不新起容器、不新加端口、不新加备份路径)。在那之前本变更只服务 inbox 一家,共享层的价值**尚未兑现**
- [ ] 7.2 连续 7 天共享实例无事故:无连接耗尽、无跨库越权、备份真的在跑
