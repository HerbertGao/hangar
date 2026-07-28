## 0. 先答两个门(答不出就停,别写代码)

- [ ] 0.1 **不变量 #3 的门**:本变更是否加库/加表/加进程?答:**不加**——`@hangar/core` 与那 4 张表零改动;pg 是**域存储**,由 pilot 自己连,与脊柱的 SQLite 无关。若实现漂移到「core 认识 pg」,本门即失守,须回头改 `DESIGN.md`
- [ ] 0.2 **过早抽象的门**:此刻真实消费者只有 inbox 一家。**据此本变更不发 npm、不做插件化、不预留第二个数据库类型**;共享层的价值要等第二个 pilot 才兑现,这一点已在 proposal 的出口闸里诚实记账。**若第二个 pilot 迟迟不来,正确动作是把本变更回退成「inbox 自己那份 compose」,不是给它加能力**

## 1. `@hangar/pgconfig`:纯解析器(零驱动、零 IO 副作用于加载期)

- [ ] 1.1 新建 `packages/pgconfig` 骨架:**不 import `@hangar/core`、不 import `pg`/任何驱动**;运行时依赖只有 `yaml` + `zod`(复用仓里已有版本)
- [ ] 1.2 `databases.yaml` 的 zod schema:`apps: { <appId>: { host, port, database, user, password } }`。`password` MUST 匹配 `/^\$\{[A-Z0-9_]+\}$/`(fail-closed 拒明文);`database`/`user` MUST 非空;`port` 默认 5432
- [ ] 1.3 `resolve(app) → { host, port, database, user, password } | undefined`
- [ ] 1.4 `${ENV}` 插值:**空串单独判定**(`.trim().length === 0` → 视作缺失),否则会产出「用户名对、密码空」的目标,比缺配置更难诊断
- [ ] 1.5 惰性读一次 + 进程内 memoize;**不在模块加载期同步读**;**不 `delete process.env`**
- [ ] 1.6 **绝不抛**:文件缺失/不可读/YAML 错/schema 不合法/无条目/env 缺失/空串 → 全部 `undefined`;值存在但非法时回 `{ reason, varName }`。**resolver 自己不打日志、不引 logger**
- [ ] 1.7 self-check(`resolve.test.ts`):无条目 → undefined · env 缺失 → undefined · **空串 → undefined** · 明文密码 → schema 拒 · YAML 语法错 → undefined 不抛 · 文件缺失 → undefined 不抛 · 第二次 resolve 结果一致 · **返回值与任何错误文本都不含密码值**

## 2. preflight:响亮在部署期,且在 daemon 的 env 里

- [ ] 2.1 `hangar-pgconfig check` bin:读 → 插值 → 校验占位已解析、`database`/`user` 非空。失败非零退出,指明 app 与变量名,**不带值**
- [ ] 2.2 `check --from-plist <path>`:解析 plist 的 `EnvironmentVariables` 并**只**用它校验,同时断言 plist 的 `HANGAR_PG_CONFIG` 与自己读的文件一致。**这是防「shell 里绿、daemon 里缺变量」的关键**,部署步骤必须用这条而不是裸 `check`
- [ ] 2.3 `check` 文案 MUST NOT 声称验过连通性或凭据有效性(它只做离线形状校验)

## 3. 不变量守门(机械可查)

- [ ] 3.1 `packages/core/src` 全文搜 `postgres` / `pg` / `databases.yaml` **零命中**(不变量 #1 的回归守卫)
- [ ] 3.2 `packages/pgconfig` 对 `@hangar/core` 无 import、不 import 任何驱动、不发起网络连接、不读写 `hangar.sqlite`、不新增表、无常驻进程
- [ ] 3.3 `git diff --numstat -- packages/core` 为零

## 4. 部署物(是模板,不是运行时职责)

- [ ] 4.1 `packages/pgconfig/deploy/docker-compose.yml`:一个 `postgres:16`,**绑 `127.0.0.1`**(不对外、Tailscale/LAN 不可达——沿用 inbox 现有那份的安全姿态),数据卷路径显式
- [ ] 4.2 建号 SQL 模板:每 app 一个 role + 一个 database,`REVOKE` 掉跨库可见性。**注明这是约定,由 pg 执行;hangar 不校验、不保证**
- [ ] 4.3 `deploy/README.md`:写明 hangar **不**管理这个容器(不起、不建号、不备份、不监控),以及「不声称 pilot 间隔离」那条边界
- [ ] 4.4 备份责任归属写清:共享实例的备份是**部署层**的事,不在任何 pilot 的 DoD 里 —— 否则会出现「谁都以为对方在备份」

## 5. inbox 接入(改动在 inbox 独立 repo)

- [ ] 5.1 inbox 的连接串来源从 `.env` 的 `DATABASE_URL` 改成 `resolve('inbox')`;**由 inbox 自己出 OpenSpec delta**
- [ ] 5.2 `file:../hangar/packages/pgconfig` 兄弟依赖(**不发 npm**,见 0.2)。注:`@hangar/notify` 当初因跨仓 CI 现实被迫提前发版,若本包也撞上同样的 CI 问题,再评估发版——**但不预先发**
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
