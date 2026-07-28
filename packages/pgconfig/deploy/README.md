# 共享 postgres —— 部署模板与边界

**hangar 不管理这个容器。** 不起、不停、不建号、不备份、不监控、不升级。这个目录里的
东西是**模板**,让每个用 pg 的 pilot 不必各自发明一份 compose,仅此而已。

`@hangar/pgconfig` 做的事只有一件:把 `(app) → 连接目标` 从一份 `databases.yaml` 里解析
出来交给调用方。它不依赖任何驱动、不建连接、不执行 SQL、不建角色/建库/改口令/跑迁移
(这条有 `src/invariants.test.ts` 机械守着)。**怎么连、怎么池化、怎么迁移是 pilot 自己的事。**

## 一次性搭建

1. 起实例:`PG_SUPERUSER_PASSWORD=… docker compose up -d`(见 `docker-compose.yml`;
   它绑 `127.0.0.1`,不对外)
2. 每个 pilot 建 role + database:见 `roles.sql`,**第 3 步的 `REVOKE CONNECT` 不能省** ——
   postgres 默认给 `PUBLIC` 授了 CONNECT,不收掉的话「每 app 一个库」只是命名习惯
3. 写 `databases.yaml`(默认路径 `~/.config/hangar/databases.yaml`,或用 `HANGAR_PG_CONFIG`
   指定):

   ```yaml
   apps:
     inbox:
       host: 127.0.0.1
       port: 5434
       database: inbox
       user: inbox
       password: "${PG_PW_INBOX}"    # 必须是 ${ENV} 占位;写明文会被 schema 拒
   ```

   这个文件**进 git**,口令**永不进 git** —— 与 `channels.yaml` 同法。
   注意:**只有 `password` 走 `${ENV}` 插值**。`host: "${PG_HOST}"` 会通过 schema、然后把
   字面量 `${PG_HOST}` 交给驱动。其余字段直接写值。

4. 把 `PG_PW_INBOX` 加进 **daemon 的 launchd plist** 的 `EnvironmentVariables`,并**在
   daemon 的 env 里**校验:

   ```sh
   hangar-pgconfig check --from-plist ~/Library/LaunchAgents/com.herbertgao.hangar-inbox.plist
   ```

   **必须用 `--from-plist` 那条,不能用裸 `check`。** 裸 `check` 用的是你当前交互 shell 的
   环境,而那里通常什么都齐 —— daemon 的 env 里可能一个变量都没有。「shell 里绿、daemon
   里缺变量」是这类配置最常见的假绿(`add-shared-notify` 上就踩过)。
   `--from-plist` 要求 plist 里**显式声明** `HANGAR_PG_CONFIG`,缺了就非零退出:否则它会退回
   约定默认路径,又变成一次「读的不是 daemon 会读的那个文件」的假绿。

`check` 的输出**只**声称「配置存在且形状合法」。它不连库,所以证明不了可达性、也证明不了
postgres 会接受这些凭据。**要证明能连,得真连一次,那不在本包职责内。**

## 备份归谁

**部署层。** 不在任何 pilot 的 DoD 里,也不在 hangar 里。共享一个实例最容易出的事就是
「谁都以为对方在备份」—— 所以这里写死:**起这个容器的人负责备份**,包括迁移前后各留一份
`pg_dump`。

## 不提供的保证

本变更**不**提供「pilot A 读不到 B 的表」。隔离来自 postgres 的 role/database 权限,由上面
第 2 步配置、由 postgres 执行;`@hangar/pgconfig` 不声称、不校验、不保证任何隔离。具体地:

- `pg_database` / `pg_roles` 等 catalog 对所有已登录 role 可读 —— **库名与角色名藏不住**。
  机制是 `roles.sql` 没有收掉 app role 对 `postgres` / `template1` 两个维护库的 `CONNECT`
  (见那份文件的第 5 条:那是刻意的,收掉它就越过「共享实例」进多租户了)
- 同 host、同 uid 的进程能读到 `databases.yaml` 指向的一切(与 `CLAUDE.md` 的「不声称防同
  uid」一致)
- 拿到 superuser 口令即绕过以上全部

真需要更强的保证,它是一个独立赌注(触及非目标里的多租户),不是本变更的自然延伸。

## 为什么共享一个实例(以及什么时候该回退)

此刻真实消费者只有一家。共享层的价值要等**第二个**需要关系库的 pilot 接进来、且没有重复
任何运维面(不新起容器、不新加端口、不新加备份路径)才兑现。**若第二个迟迟不来,正确动作
是把本变更回退成「那家自己那份 compose」,不是给它加能力。**
