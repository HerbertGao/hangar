## Why

inbox 自己起一个 `postgres:16` 容器(`docker-compose.yml`,绑 `127.0.0.1`,数据在 `./data/postgres`),连接串写在它自己的 `.env`。第二个需要关系库的 pilot 迁进来时会重复这一整套:第二个容器、第二个端口、第二份备份路径、第二次「线上端口撞了改成 5433」。真痛点是**运维面重复**,不是缺能力 —— 与 `add-shared-notify` 面对的完全同形(4 个 pilot 各自配 4 份通知目的地)。

**这条提议原本的形状没有照做,记一笔为什么。** 原话是「hangar 管一个 pgsql,各 pilot 建账号密码来管理」—— 那让脊柱变成基础设施供应者 + 多租户数据库管理员,同时撞不变量 #1、#3 与 `CLAUDE.md` 非目标里明写的「多租户」。

**所以本变更只做那一半:配置归一化,不碰所有权。** 照 `add-shared-notify` 已验证过的模子 —— 一个住 `packages/` 的**解析器**,`@hangar/core` 零改动;「容器由谁起、数据在哪、谁做备份」留在部署层,不进 hangar 的代码职责。**「hangar 提供共享配置」与「hangar 管理数据库」是两件事,只做前者就不破任何不变量。**

## What Changes

- **新增 `packages/pgconfig`** —— 仓内、脊柱之外的姊妹包(与 `packages/notify`、`packages/hangar-view` 同性质)。它是个**连接目标解析器**,不是连接池、不是迁移器、不是 ORM。**返回形状只有一种**:`resolve(app) → PgTarget | undefined`(热路径),诊断走单独的 `resolveWithReason(app)` 判别联合 —— 不让一个返回位有时是目标、有时是诊断对象。**不含任何 `pg` 驱动依赖**(运行时恰好 `yaml` + `zod`);连接、池化、迁移全留 pilot 侧。schema 是 strict 的,`host`/`database`/`user` 非空、`port` 为 `1..65535` 的整数:**不合法的值必须死在部署期的 preflight,而不是 pilot 热路径上驱动内部那句与配置无关的报错。**
- **新增 host 级 `databases.yaml`**(经 `HANGAR_PG_CONFIG` 定位)—— `(app) → 连接目标` 的唯一 SOT,git 版本化,**不含密钥**:密码以 `${ENV}` 占位,与 `channels.yaml` 的 `bot: "${TG_BOT_INBOX}"` 同法、同 fail-closed 姿态(明文密码 → schema 拒)。
- **一个共享容器由部署层提供**,`deploy/` 下给一份 compose + 一份建号 SQL 模板。模板把边界写具体:每 app 一个 `NOSUPERUSER NOCREATEDB NOCREATEROLE` 的 role + 一个 database,并**必须** `REVOKE CONNECT ... FROM PUBLIC` —— postgres 默认给 `PUBLIC` 授了 CONNECT,不收掉的话「每 app 一个库」只是命名习惯,不是隔离。**这是部署物,不是 hangar 的运行时职责** —— hangar 不 `docker compose up`、不建号、不发密码,也不校验上面这些真被执行了。
- **`packages/notify` 的 preflight 模式照搬**:`hangar-pgconfig check --from-plist <path>` —— 在 **daemon 的 env 里**校验每个 `(app)` 的占位变量都已解析,而不是在运维的交互 shell 里。那条经验来自 `add-shared-notify`:「shell 里绿、daemon 里缺变量」是这类配置最常见的假绿。该模式还要求 plist **显式声明** `HANGAR_PG_CONFIG`(缺失即非零退出;理由见 `src/cli.ts` 那段注释)。CLI 契约按仓内规范:`--json`、日志→stderr、退出码 `0`/`1`/`2`。
- **`@hangar/core` 零改动。** 不加 `ctx.db`、不注入连接、core 不认识 `databases.yaml`、不经手任何密码。

## 非目标

- **hangar 不管理数据库。** 不建号、不改密、不跑迁移、不做备份、不监控、不 `docker compose up`。它只回答「(app) 的连接目标是什么」。
- **不做多租户隔离机制。** 每 app 一个 role + 一个 database 是**部署模板给出的约定**,由 pg 自己的权限系统执行;hangar 不提供、不校验、不声称隔离。**若将来真需要「hangar 保证 pilot A 读不到 B 的表」,那是一个独立赌注,不是本变更的延伸。**
- **不进脊柱。** 不加 `ctx.db` / `app.yaml` 的 `database:` 块。理由同 `add-shared-notify` 的 D3:pilot 报 app id、不知目的地就够了。
- **不含 `pg` 驱动、不含连接池、不含迁移工具。** 解析器返回原料,连接归调用方 —— 与 `@hangar/notify` 「返回目的地原料、投递归调用方」逐条对应。
- **不强制既有 pilot 迁移。** inbox 可以继续用自己的容器;迁移是一次独立的部署动作,由 §生产迁移 runbook 覆盖,失败可停在原状。
- **不发布到 npm**(至少 v1)。`@hangar/notify` 是因为跨仓消费才发版的;本包在真出现第二个消费者之前,`file:` 兄弟依赖足够 —— **等第二个真实消费者出现再发版**。

## Impact

- 受影响规范:新增 `shared-postgres` capability(解析契约、`databases.yaml` schema 与 `${ENV}` 插值、fail-closed 规则、部署期 preflight)。
- 受影响代码:新增 `packages/pgconfig/**`。**`@hangar/core` 零改动**;`packages/notify`、`packages/hangar-view` 不受影响。
- 受影响部署物:新增 `packages/pgconfig/deploy/`(compose 模板 + 建号 SQL 模板 + README)。
- 跨仓:inbox 侧改一处连接串来源(从 `.env` 的 `DATABASE_URL` 改成 resolver),**由 inbox 自己出 OpenSpec delta**。它的 `docker-compose.yml`/`data/postgres` 是否退役,由那边决定。
- **需要协调的生产迁移(不是仓内编辑)**:在 ts.mac-mini 上起共享容器 → `pg_dump` inbox 现有库 → 在共享实例里建 role/database → restore → 切 inbox 的连接来源 → 观察一个 digest 周期 → 再退役旧容器。**旧容器与数据目录在确认新链路跑过一个完整周期之前不得删除**;`./data/postgres` 是唯一副本。
- 出口闸:**第二个真实需要关系库的 pilot 接进来、且它没有重复任何运维面**。在那之前本变更只服务于 inbox 一家 —— 这一点必须诚实记账,因为「为一个消费者抽共享层」正是本仓反复警惕的过早抽象。
