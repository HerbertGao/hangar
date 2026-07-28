-- 每个 pilot 一个 role + 一个 database。**这是约定,由 postgres 自己执行** ——
-- @hangar/pgconfig 不跑它、不校验它、不保证它。把 :app 换成 pilot 的 id 后逐段执行。
--
-- 用法(在跑 compose 的那台机器上):
--   psql -X -h 127.0.0.1 -p 5434 -U postgres -v app=inbox -v pw="$PG_PW_INBOX" -f roles.sql
--
-- `-X` 跳过 ~/.psqlrc(别让本机配置改变脚本行为);下面第一行的 ON_ERROR_STOP 是**必需**的:
-- 不设它,psql 跑 `-f` 脚本时**单条语句失败仍会整体退 0**,于是第 3 步那条 load-bearing 的
-- REVOKE 失败了,自动化看起来还是成功的 —— 而那正好是「隔离只剩命名习惯」的那种失败。
\set ON_ERROR_STOP on
--
-- 注意 :pw 会进 psql 的历史与进程参数。若在意,改用 \password 交互设口令,
-- 或先 CREATE ROLE 不带口令再 ALTER ROLE ... PASSWORD 交互输入。

-- 1) role:只能登录,不能建库、不能建角色。
CREATE ROLE :"app" LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- 2) database:owner 就是它自己。
CREATE DATABASE :"app" OWNER :"app";

-- 3) **关键一步**:postgres 默认给 PUBLIC 授了 CONNECT,也就是**任何 role 都能连任何库**。
--    不收掉这条,「每 app 一个库」只是命名习惯,不是隔离。
REVOKE CONNECT ON DATABASE :"app" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"app" TO :"app";

-- 4) 库内 public schema 的建表权。postgres 15+ 的**新建**集群已默认收掉 PUBLIC 的 CREATE,
--    但**升级上来或复用的旧数据目录会保留那条旧授权** —— 所以这里显式执行,不靠默认值。
--    幂等:已经收掉时 REVOKE 也是成功的。
\connect :"app"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO :"app";
--
-- 5) **没有做、也不打算做的一步**:收掉 app role 对 `postgres` / `template1` 这两个
--    维护库的 CONNECT。它们是 pg_database / pg_roles 的读取入口 —— 换句话说,
--    README 里那条「库名与角色名藏不住」的披露,机制就在这里。要真藏住得连维护库
--    一起锁,那超出「共享实例 + 每 app 一个库」这个形状,属于多租户,是另一个赌注。

-- ⚠️ 这套做法**不提供**「pilot A 读不到 B 的表」这一保证的全部:
--   · pg_database / pg_roles 等 catalog 对所有已登录 role 可读 —— **库名与角色名藏不住**
--   · 同 host、同 uid 的进程能读到 databases.yaml 指向的一切(与 CLAUDE.md 的
--     「不声称防同 uid」一致)
--   · 谁拿到 superuser 口令就绕过全部以上
-- 真需要更强的保证,那是一个独立赌注(触及非目标里的多租户),不是本变更的自然延伸。
