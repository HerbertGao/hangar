# CLAUDE.md — hangar

**hangar 是一根无头的 AgentOS 脊柱:停放、调度、审计一队 `*-pilot` agent,自己不抢戏;控制面 BYO,首选 Claude Code 驱动。**

`DESIGN.md` 是架构 SOT。`ROADMAP.md` 是次序与闸门。`SKILL.md` 是控制面契约。**本文件是每次在这干活前必读的护栏。**

---

## 架构不变量(fitness functions · 违反即 bug)

写任何代码前先自检这 9 条。任何一条要破,先改 `DESIGN.md` 并写明理由,否则不许破。

1. **脊柱零域概念。** `@hangar/core` 代码里出现 `email` / `mail` / 任何具体业务名词 = bug。OS 只认 `Run` / `RunEvent` / `Approval` / `App`。域细节只经 `RunEvent.payload_json` 流过。
2. **inbox 用不到 = 不许进脊柱。** 给脊柱加任何能力前,先答:「inbox-pilot 哪一行用它?」答不出 = 过拟合,砍掉。这是本项目唯一的硬约束。
3. **一个 host、一个 SQLite、4 张表。** 加表 / 加库 / 加第二个进程前,先在 `DESIGN.md` 论证「为何 4 表不够」。
4. **app 定义唯一入口 `app.yaml`,方向由 `executor` 定。** `pipeline` → 约定加载 `dist/pipeline.js`(编译外部 pilot)、回退 `pipeline.ts`(仓内 dev);app.yaml 仍是唯一定义入口。不引入第二种 app 定义方式(不加 `defineApp`、不加 JSON manifest、不加字符串入口)。**apps 根可配、pilot 可为外部 checkout;这不新增任何 app 定义方式——`app.yaml` 仍是唯一入口。**
5. **审批只在 OS 层**(`Approval` 表 + CLI)。executor / harness / app 代码不得自行处理审批。高危动作走 `ctx.propose`,命中 `permissions.approval` 即 PARK。
6. **v0 无 HTTP / 无 IPC / 无消息队列。** CLI 与 daemon 是同一份 core 的两个入口,共享 SQLite,互不通信。要加网络层 = 先改 DESIGN.md。
7. **不上 MCP。** 控制面 = CLI + `SKILL.md`。(长连接/进度流真出现前,CLI+JSON 已够。)
8. **不做通用 durable replay / 中途 checkpoint。** PARK 只支持 `propose → approve → execute` 一种切点。
9. **改架构 = 先改 `DESIGN.md`,再改代码。** 代码与 DESIGN.md 冲突,以 DESIGN.md 为准(或先更新它)。

## 非目标(别顺手做)

对话助手 · 工作流画布 · prompt 管理平台 · 面向外部市场的产品 · 多租户/RBAC/计费 · marketplace/A2A · **多用户** web workbench(单用户只读私人 view = `hangar-view`,ROADMAP Phase 1.5 已立项例外)· 模型/向量库 · 通用 durable 引擎。这些**除非「给别人用」升级成真赌注,否则不在本项目范围**(见 `ROADMAP.md` 出口闸)。

## CLI 规范(每条命令都遵守)

- 日志 → stderr,数据 → stdout,`--json` 给结构化输出。
- 退出码:`0` 成功 / `1` 业务失败 / `2` 参数错误。
- 写操作(`run` / `approve` / `reject` / `daemon`)**拒绝 root(EUID==0)**;`doctor` / 只读命令不拒绝。
- `doctor` 必须存在,把环境前置检查显式化(见 SKILL.md)。
- 无参运行 = 打印帮助,不默默执行。

## 技术约定

- TypeScript + Node + pnpm。SQLite 用 `better-sqlite3`(4 表不需要 ORM)。校验 `zod`,日志 `pino`,调度 `node-cron`。全部沿用 inbox-pilot 已在用的依赖。
- **非平凡逻辑(分支/循环/解析/审批/钱路)留一个可跑 self-check**(assert 版 `demo()` 或一个小 `*.test.ts`)。不铺测试框架、不写 per-function 套件,除非被要求。
- 目录:`packages/core`(脊柱)、`apps/<id>/`(pilot,**repo 内目录或指向外部 checkout 的 apps 根下条目**)、`hangar.sqlite`(状态)。

## 给驱动 hangar 的 Claude Code

- 通过 CLI 操作(契约见 `SKILL.md`),**别直接改 `hangar.sqlite`**。
- **别调 `hangar daemon`**(长驻进程,会挂住会话)。
- 环境不确定时先 `hangar doctor --json` ping 一次。
- apps 根经 `HANGAR_APPS`;pilot 可能是 hangar repo 之外的独立 checkout(须已 `pnpm install` + 编译出 `dist/`)。
- daemon 与 CLI 须共享同一 `HANGAR_APPS`;`hangar doctor` 应回显解析到的 `HANGAR_APPS`/`HANGAR_DB`。
- GitHub CLI 用 `\gh`(反斜杠前缀,见全局 CLAUDE.md)。
